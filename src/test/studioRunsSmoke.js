// The Runs view (docs/agent-studio.md, phase 3): what it measures and shows, from runs the real engine
// made and from logs written with known times (old runs, interrupted runs, retries, missing data).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const out = name => require(path.join(__dirname, '../../out/studio', name));
const { RunStore, WorkflowEngine } = out('engine.js');
const { studioSteps } = out('registry.js');
const { summarizeRuns, runTimeline, matchesFilter, formatDuration } = out('runsReport.js');
const { renderRunsPage } = out('runsPage.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-runs-'));
const never = { cancelled: false };
const flow = {
  schema: 'repository-manager/workflow@1', id: 'note', version: '1.0.0', title: 'Write a note',
  nodes: [
    { id: 'ask', type: 'gate', title: 'Go?', with: { title: 'Write the note?' } },
    { id: 'write', type: 'file.write', title: 'Write it', with: { path: 'notes/n.txt', content: 'hi' } }
  ],
  edges: [{ from: 'ask', to: 'write' }]
};
const at = seconds => new Date(Date.UTC(2026, 10, 15, 0, 0, seconds)).toISOString();
const state = (id, status, extra = {}) => ({ id, workflow: { id: 'w', version: '1', title: extra.title ?? 'Fix code', hash: 'h' }, startedAt: at(0),
  updatedAt: at(0), status, inputs: {}, nodes: {}, approvals: {}, ...extra });

async function main() {
  try {
    // Real runs: one done (approved at both gates), one stopped (rejected), one waiting.
    const store = new RunStore(path.join(base, 'runs'));
    const engine = new WorkflowEngine({ root: base, steps: studioSteps(), store });
    let done = await engine.continue(flow, await engine.start(flow, 'h', {}), never);
    done = await engine.continue(flow, await engine.answer(done, true), never);
    done = await engine.continue(flow, await engine.answer(done, true), never);
    assert.equal(done.status, 'done');
    let stopped = await engine.continue(flow, await engine.start(flow, 'h', {}), never);
    stopped = await engine.answer(stopped, false);
    const waiting = await engine.continue(flow, await engine.start(flow, 'h', {}), never);
    const real = await Promise.all((await store.list()).map(async s => ({ state: s, log: await store.readLog(s.id) })));
    let summary = summarizeRuns(real);
    // Waiting runs are not in the denominator: 1 done of 2 finished.
    assert.deepEqual([summary.total, summary.finished, summary.done, summary.stopped, summary.waiting], [3, 2, 1, 1, 1]);
    assert.equal(summary.completionRate, 0.5);
    const doneTimeline = runTimeline(real.find(r => r.state.id === done.id), flow);
    assert.deepEqual(doneTimeline.nodes.map(n => [n.node, n.title, n.outcome]), [['ask', 'Go?', 'done'], ['write', 'Write it', 'done']]);
    assert.ok(doneTimeline.executionMs >= 0 && doneTimeline.waitingMs >= 0, 'a real run lacks times');
    const waitingTimeline = runTimeline(real.find(r => r.state.id === waiting.id), flow);
    assert.equal(waitingTimeline.nodes[0].outcome, 'waiting');
    assert.equal(waitingTimeline.waitingMs, undefined, 'a wait still going on was given a length');

    // Known times: a code step ran 3 s, waited 10 s for review, was retried, ran 2 s, waited 5 s,
    // was accepted as unverified. Execution and waiting are kept apart.
    const coded = { state: state('coded', 'done', { attempts: { fix: 2 } }), log: [
      { at: at(0), type: 'start' },
      { at: at(1), type: 'node', node: 'fix' }, { at: at(4), type: 'waiting', node: 'fix', kind: 'review', verdict: 'failed' },
      { at: at(14), type: 'review', node: 'fix', decision: 'retry', verdict: 'failed' },
      { at: at(15), type: 'node', node: 'fix' }, { at: at(17), type: 'waiting', node: 'fix', kind: 'review', verdict: 'unverified' },
      { at: at(22), type: 'review', node: 'fix', decision: 'accept', verdict: 'unverified' }, { at: at(22), type: 'done', node: 'fix' },
      { at: at(22), type: 'finish', status: 'done' }
    ] };
    const timeline = runTimeline(coded);
    assert.deepEqual(timeline.nodes.map(n => [n.node, n.runs, n.executionMs, n.waitingMs, n.outcome, n.verdict]), [['fix', 2, 5000, 15000, 'accepted', 'unverified']]);
    assert.deepEqual([timeline.executionMs, timeline.waitingMs], [5000, 15000]);
    // A log line without a usable time: that node's and the run's times are "no data", not guessed.
    const gap = { state: state('gap', 'done'), log: [{ at: at(1), type: 'node', node: 'a' }, { at: 'unknown', type: 'done', node: 'a' }, { at: at(5), type: 'node', node: 'b' }, { at: at(6), type: 'done', node: 'b' }] };
    const gapTimeline = runTimeline(gap);
    assert.deepEqual(gapTimeline.nodes.map(n => n.executionMs), [undefined, 1000]);
    assert.equal(gapTimeline.executionMs, undefined);
    assert.equal(formatDuration(undefined), 'no data');
    // An old run with no log still opens: nodes from its state, no times.
    const old = { state: state('old', 'done', { nodes: { a: { status: 'done' }, b: { status: 'skipped' } } }), log: [] };
    const oldTimeline = runTimeline(old);
    assert.deepEqual([oldTimeline.hasLog, oldTimeline.executionMs, oldTimeline.nodes.map(n => n.outcome)], [false, undefined, ['done', 'skipped']]);
    // An interrupted run: its node, and what recovery did.
    const cut = { state: state('cut', 'failed', { nodes: { fix: { status: 'failed', error: 'fix: VS Code closed while this step ran' } }, interrupted: { node: 'fix', restored: ['src/a.ts'], kept: [], at: at(30) } }),
      log: [{ at: at(1), type: 'node', node: 'fix' }, { at: at(30), type: 'recovered', node: 'fix', restored: ['src/a.ts'], kept: [] }] };
    const cutTimeline = runTimeline(cut);
    assert.deepEqual([cutTimeline.nodes[0].outcome, cutTimeline.nodes[0].recovered.restored, cutTimeline.nodes[0].executionMs], ['interrupted', ['src/a.ts'], undefined]);

    // The summary over all of them: interrupted is a failed run; accepted verdicts and retries are apart.
    const all = [...real, coded, gap, old, cut, { state: state('accepted-anyway', 'done'), log: [{ at: at(1), type: 'review', node: 'x', decision: 'accept', verdict: 'failed' }] }];
    summary = summarizeRuns(all);
    assert.deepEqual([summary.finished, summary.done, summary.failed, summary.interrupted, summary.retries], [7, 5, 1, 1, 1]);
    assert.deepEqual(summary.verification, { unverified: 1, failed: 1 });
    assert.deepEqual(summary.workflows.map(w => [w.title, w.runs]), [['Fix code', 5], ['Write a note', 3]]);
    assert.equal(matchesFilter(cut.state, { status: 'interrupted' }), true);
    assert.equal(matchesFilter(cut.state, { status: 'failed', workflow: 'Fix code' }), true);
    assert.equal(matchesFilter(old.state, { workflow: 'Write a note' }), false);

    // The page: numbers with what they mean, filters, the selected run's timeline, Resume only when waiting.
    const page = renderRunsPage({ records: all, filter: {}, nonce: 'n0', cspSource: 'x', selected: { record: coded, timeline } });
    assert.match(page, /<strong>71%<\/strong><span>completed \(5 of 7 finished\)<\/span>/);
    assert.match(page, /Done means the engine finished, not that the code is right/);
    assert.match(page, /1 accepted as unverified/);
    assert.match(page, /ran 2 times \(1 retry\) · executing: 5 s · waiting for you: 15 s · verification: accepted as unverified/);
    assert.match(page, /data-action="rawLog" data-run="coded"/);
    assert.doesNotMatch(page, /data-action="resume"/, 'a finished run offers Resume');
    const waitingPage = renderRunsPage({ records: all, filter: { status: 'waiting' }, nonce: 'n0', cspSource: 'x', selected: { record: real.find(r => r.state.id === waiting.id), timeline: waitingTimeline } });
    assert.match(waitingPage, /data-action="resume" data-run="[^"]+">Resume: /);
    // At its gate the node has not run: "not run yet" and "waiting for you now", never "no data".
    assert.match(waitingPage, /not run yet · waiting for you now/);
    assert.match(waitingPage, /waiting for you now \(no total yet\)/);
    assert.doesNotMatch(waitingPage.slice(waitingPage.indexOf('class="timeline"')), /no data/);
    assert.equal((waitingPage.match(/data-action="select"/g) ?? []).length, 1, 'the status filter did not apply');
    assert.match(renderRunsPage({ records: [old], filter: {}, nonce: 'n', cspSource: 'x', selected: { record: old, timeline: oldTimeline } }), /This run has no log: times and retries are not known\./);
    const cutPage = renderRunsPage({ records: [cut], filter: {}, nonce: 'n', cspSource: 'x', selected: { record: cut, timeline: cutTimeline } });
    assert.match(cutPage, /VS Code closed while it ran\. Put back: src\/a\.ts\./);
    // It ran but never waited for a person: its execution time is unknown, and no wait is shown.
    assert.match(cutPage, /ran 1 time · executing: no data</);
    // A wait whose end the log lacks is "no data", not left out.
    const lost = runTimeline({ state: state('lost', 'done'), log: [{ at: at(1), type: 'waiting', node: 'g' }, { at: 'bad', type: 'approval', node: 'g', approved: true }] });
    assert.deepEqual([lost.nodes[0].waitingMs, lost.nodes[0].waitingUnknown, lost.waitingMs], [undefined, true, undefined]);
    // Text from runs is escaped.
    const odd = { state: state('odd', 'failed', { title: '<img src=x>', error: '<b>boom</b>' }), log: [] };
    const oddPage = renderRunsPage({ records: [odd], filter: {}, nonce: 'n', cspSource: 'x', selected: { record: odd, timeline: runTimeline(odd) } });
    assert.doesNotMatch(oddPage, /<img src=x>|<b>boom<\/b>/);
    console.log('Studio runs smoke passed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exit(1); });
