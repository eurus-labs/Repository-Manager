// The Runs view (docs/agent-studio.md, phase 3): what it measures and shows, from runs the real engine
// made and from logs written with known times (old runs, interrupted runs, retries, missing data).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const out = name => require(path.join(__dirname, '../../out/studio', name));
const { RunStore, WorkflowEngine } = out('engine.js');
const { studioSteps } = out('registry.js');
const { summarizeRuns, runTimeline, matchesFilter, formatDuration, activityLine, RESULT_CHARS } = out('runsReport.js');
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

    // Review of the first version (Codex). Cancel logs a run-level finish with no node: it closes the
    // node that was running, which reads as stopped with its time.
    const cancelled = runTimeline({ state: state('cancelled', 'stopped'), log: [{ at: at(1), type: 'node', node: 'fix' }, { at: at(4), type: 'finish', status: 'stopped', reason: 'Cancelled' }] });
    assert.deepEqual([cancelled.nodes[0].outcome, cancelled.nodes[0].executionMs, cancelled.nodes[0].error, cancelled.executionMs], ['stopped', 3000, 'Cancelled', 3000]);
    // A done whose start line the log lost: the time is unknown, and so is the total; an empty list
    // (done with runs: 0) truly took no time.
    const lostStart = runTimeline({ state: state('lost-start', 'done'), log: [{ at: at(2), type: 'done', node: 'a' }, { at: at(3), type: 'node', node: 'b' }, { at: at(5), type: 'done', node: 'b' }] });
    assert.deepEqual([lostStart.nodes[0].executionMs, lostStart.nodes[1].executionMs, lostStart.executionMs], [undefined, 2000, undefined]);
    const empty = runTimeline({ state: state('empty', 'done'), log: [{ at: at(2), type: 'done', node: 'each', runs: 0 }] });
    assert.deepEqual([empty.nodes[0].executionMs, empty.executionMs], [0, 0]);
    // A step's saved result is in the detail, as text or JSON, cut to RESULT_CHARS.
    const withOutput = runTimeline({ state: state('out', 'done', { nodes: { ask: { status: 'done', output: 'The answer.' }, big: { status: 'done', output: { text: 'x'.repeat(RESULT_CHARS) } }, none: { status: 'done', output: [] } } }), log: [] });
    assert.deepEqual(withOutput.nodes.map(n => [n.node, n.result?.slice(0, 11), Boolean(n.truncated)]), [['ask', 'The answer.', false], ['big', '{\n  "text":', true], ['none', undefined, false]]);
    const resultPage = renderRunsPage({ records: [], filter: {}, nonce: 'n', cspSource: 'x', selected: { record: { state: state('out', 'done', { nodes: { ask: { status: 'done', output: '<script>x</script>' } } }), log: [] }, timeline: runTimeline({ state: state('out', 'done', { nodes: { ask: { status: 'done', output: '<script>x</script>' } } }), log: [] }) } });
    assert.match(resultPage, /<summary>Result<\/summary><pre>&#60;script&#62;x&#60;\/script&#62;<\/pre>/);

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
    // ---- activityLine: the short text of a log entry that tells what a step is doing; nothing for others.
    const line = entry => activityLine({ at: at(1), ...entry });
    assert.deepEqual(line({ type: 'tool', node: 'fix', name: 'read_file', ok: true, note: 'src/a.ts:1-40' }), { text: 'read_file src/a.ts:1-40' });
    assert.deepEqual(line({ type: 'tool', node: 'fix', name: 'edit_file', ok: false, note: 'no match' }), { text: '✗ edit_file failed: no match', ok: false });
    assert.deepEqual(line({ type: 'tool', node: 'fix', name: 'list_files', ok: true }), { text: 'list_files' });
    assert.deepEqual(line({ type: 'model', node: 'fix', model: 'gpt-4o', inputTokens: 1200, outputTokens: 80 }), { text: 'Model gpt-4o answered (1200 in, 80 out)' });
    assert.deepEqual(line({ type: 'model', node: 'ask', model: 'copilot:gpt-4o', attempt: 1 }), { text: 'Model copilot:gpt-4o answered' });
    assert.deepEqual(line({ type: 'check', node: 'fix', script: 'test', passed: true, exitCode: 0 }), { text: 'Check test passed (exit 0)', ok: true });
    assert.deepEqual(line({ type: 'check', node: 'fix', script: 'test', passed: false, exitCode: 1 }), { text: 'Check test failed (exit 1)', ok: false });
    assert.deepEqual(line({ type: 'branch', node: 'fix', branch: 'fix/parser', created: true }), { text: 'On branch fix/parser, created' });
    assert.deepEqual(line({ type: 'branch', node: 'fix', branch: 'main', created: false }), { text: 'On branch main' });
    assert.deepEqual(line({ type: 'read', node: 'docs', files: 12, requirements: 30 }), { text: 'Read 12 files' });
    assert.deepEqual(line({ type: 'read', node: 'docs', files: 1 }), { text: 'Read 1 file' });
    assert.deepEqual(line({ type: 'skills', node: 'ask', skills: ['github:acme/skills/plugins/testing/skills/write-tests@' + 'c'.repeat(40), 'plain'] }), { text: 'Skills: write-tests, plain' });
    for (const type of ['start', 'node', 'done', 'skip', 'waiting', 'approval', 'review', 'finish', 'recovered', 'script-changes']) { assert.equal(line({ type, node: 'x' }), undefined, `${type} made a line`); }
    // A tool's input and a file's content are never in the line; a long note is cut.
    const secret = line({ type: 'tool', name: 'edit_file', ok: true, note: 'a.ts', input: { content: 'SECRET FILE TEXT' }, output: 'SECRET' });
    assert.equal(secret.text.includes('SECRET'), false);
    assert.ok(line({ type: 'tool', name: 'search', ok: true, note: 'q'.repeat(500) }).text.length <= 200);

    // ---- runTimeline over a run still in progress (what the chat's run card reads): the running step,
    // ---- the steps not started, and entries that arrive late never turn a finished step back to running.
    const flowNodes = { nodes: [{ id: 'a', type: 'prompt', title: 'First' }, { id: 'b', type: 'code', title: 'Second' }, { id: 'c', type: 'gate', title: 'Third' }] };
    const live = (status, log, nodes = {}) => runTimeline({ state: state('live', status, { nodes }), log }, flowNodes).nodes.map(n => [n.node, n.outcome]);
    assert.deepEqual(live('running', [{ at: at(1), type: 'node', node: 'a' }, { at: at(2), type: 'tool', node: 'a', name: 'x' }]), [['a', 'running'], ['b', 'pending'], ['c', 'pending']]);
    const afterDone = [{ at: at(1), type: 'node', node: 'a' }, { at: at(2), type: 'done', node: 'a' }, { at: at(3), type: 'node', node: 'b' }];
    assert.deepEqual(live('running', afterDone, { a: { status: 'done' } }), [['a', 'done'], ['b', 'running'], ['c', 'pending']]);
    // Late: a tool and a model entry of the finished step a, appended after its done, even after b started.
    const late = [...afterDone, { at: at(3), type: 'tool', node: 'a', name: 'read_file' }, { at: at(4), type: 'model', node: 'a', model: 'm' }];
    assert.deepEqual(live('running', late, { a: { status: 'done' } }), [['a', 'done'], ['b', 'running'], ['c', 'pending']], 'a late entry changed a finished step');
    // Late after the run's finish (stopped): the stopped step stays stopped, a done step stays done.
    const finished = [...afterDone, { at: at(5), type: 'finish', status: 'stopped', reason: 'Cancelled' }, { at: at(5), type: 'tool', node: 'b', name: 'edit_file' }, { at: at(5), type: 'model', node: 'a', model: 'm' }];
    assert.deepEqual(live('stopped', finished, { a: { status: 'done' } }), [['a', 'done'], ['b', 'stopped'], ['c', 'pending']], 'a late entry after finish changed a step');
    // Waiting for a person is waiting, not running; a skipped step is skipped.
    assert.deepEqual(live('waiting', [{ at: at(1), type: 'node', node: 'a' }, { at: at(2), type: 'done', node: 'a' }, { at: at(3), type: 'skip', node: 'b' }, { at: at(4), type: 'waiting', node: 'c', kind: 'gate' }], { a: { status: 'done' }, b: { status: 'skipped' } }),
      [['a', 'done'], ['b', 'skipped'], ['c', 'waiting']]);
    console.log('Studio runs smoke passed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exit(1); });
