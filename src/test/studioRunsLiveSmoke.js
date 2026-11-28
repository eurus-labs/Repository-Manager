// The Runs view follows runs while they go on (plan 10): the real RunsViewProvider with a scripted
// `vscode` view and a real RunStore. It redraws within 300 ms of a log entry, at most once per 250 ms,
// never while hidden (and once when shown again), offers Stop on a running run, and stops listening
// with the view.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-runs-live-'));
const infos = [];
const fakeVscode = { window: { registerWebviewViewProvider: () => ({ dispose() {} }), showErrorMessage: async message => { throw new Error(message); }, showInformationMessage: async message => { infos.push(message); } } };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { RunsViewProvider } = require('../../out/studio/runsView.js');
Module._load = originalLoad;
const { RunStore } = require('../../out/studio/engine.js');

const unhandled = [];
process.on('unhandledRejection', error => unhandled.push(error));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = (id, status = 'running') => ({ id, workflow: { id: 'w', version: '1', title: 'Live', hash: 'h' }, startedAt: new Date().toISOString(), updatedAt: '',
  status, inputs: {}, nodes: { a: { status: 'pending' } }, approvals: {} });

async function main() {
  try {
    const store = new RunStore(path.join(base, 'runs'));
    await store.save(state('go'));
    await store.saveWorkflow('go', { schema: 'repository-manager/workflow@1', id: 'w', version: '1', title: 'Live', nodes: [{ id: 'a', type: 'gate', title: 'Step A', with: { title: 'ok?' } }] });
    await store.log('go', { type: 'start' });
    const stopped = [];
    const runs = { runs: async () => store, stop: id => { stopped.push(id); return id === 'go'; }, resume: async () => undefined, openLog: async () => undefined };
    const draws = [];
    let receive;
    let visibility;
    let disposed;
    const view = {
      visible: true,
      webview: { cspSource: 'x', options: {}, set html(value) { draws.push({ at: Date.now(), html: value }); }, onDidReceiveMessage: handler => { receive = handler; } },
      onDidChangeVisibility: handler => { visibility = handler; },
      onDidDispose: handler => { disposed = handler; }
    };
    new RunsViewProvider(runs).resolveWebviewView(view);
    // The provider handles a message after returning from the handler: give it a moment.
    const send = async message => { await receive(message); await sleep(80); };
    await sleep(150);
    assert.equal(draws.length, 1, 'the view was not drawn once on opening');
    assert.doesNotMatch(draws[0].html, /data-action="stop"/, 'Stop is offered before a run is selected');

    // A run that is running: select it, and it has Stop.
    await send({ type: 'select', run: 'go' });
    assert.match(draws.at(-1).html, /data-action="stop" data-run="go"/);
    // A finished or waiting run has none.
    await store.save(state('done', 'done'));
    await send({ type: 'select', run: 'done' });
    assert.doesNotMatch(draws.at(-1).html, /data-action="stop"/, 'a finished run has Stop');
    await send({ type: 'select', run: 'go' });

    // Appending entries redraws within 300 ms.
    let count = draws.length;
    const t0 = Date.now();
    await store.log('go', { type: 'node', node: 'a' });
    while (draws.length === count && Date.now() - t0 < 1000) { await sleep(5); }
    assert.ok(draws.length > count, 'the view was not redrawn after an entry');
    assert.ok(draws.at(-1).at - t0 <= 300, `redrawn ${draws.at(-1).at - t0} ms after the entry`);
    assert.match(draws.at(-1).html, /ran 1 time/);

    // A burst for about a second: no two redraws closer than 250 ms (a little slack for timers).
    await sleep(400);
    count = draws.length;
    const from = Date.now();
    while (Date.now() - from < 1000) { await store.log('go', { type: 'tool', node: 'a', name: 'read_file', ok: true }); await sleep(5); }
    await sleep(400);
    const burst = draws.slice(count);
    assert.ok(burst.length <= 1 + Math.ceil(1400 / 250), `${burst.length} redraws for a 1 s burst`);
    for (let i = 1; i < burst.length; i++) { assert.ok(burst[i].at - burst[i - 1].at >= 235, `two redraws ${burst[i].at - burst[i - 1].at} ms apart`); }

    // State written just after its log line is picked up by the confirming redraw.
    await sleep(400);
    await store.log('go', { type: 'finish', status: 'done' });
    await sleep(60);
    await store.save({ ...state('go', 'done'), nodes: { a: { status: 'done' } } });
    for (let i = 0; i < 40 && /data-action="stop"/.test(draws.at(-1).html); i++) { await sleep(25); }
    assert.doesNotMatch(draws.at(-1).html, /data-action="stop"/, 'a run that ended still has Stop');
    await store.save(state('go'));

    // Hidden: nothing is drawn; shown again: drawn once.
    await sleep(400);
    view.visible = false;
    visibility();
    count = draws.length;
    for (let i = 0; i < 5; i++) { await store.log('go', { type: 'tool', node: 'a', name: `hidden${i}`, ok: true }); await sleep(100); }
    await sleep(500);
    assert.equal(draws.length, count, 'the hidden view was drawn');
    await store.log('go', { type: 'node', node: 'a' });
    await sleep(500);
    view.visible = true;
    visibility();
    await sleep(100);
    assert.ok(draws.length > count, 'the view was not drawn when shown again');
    assert.match(draws.at(-1).html, /ran 2 times/);

    // Stop: the page's message reaches StudioRuns.stop; a refusal is said.
    await send({ type: 'stop', run: 'go' });
    assert.deepEqual(stopped, ['go']);
    await send({ type: 'stop', run: 'gone' });
    assert.deepEqual(stopped, ['go', 'gone']);
    assert.match(infos.at(-1), /not running in this window/);

    // Closed: a later entry draws nothing and throws nothing.
    disposed();
    await sleep(300);
    count = draws.length;
    await store.log('go', { type: 'tool', node: 'a', name: 'late', ok: true });
    await sleep(700);
    assert.equal(draws.length, count, 'the closed view was drawn');
    assert.deepEqual(unhandled, []);

    // A view closed before the store answered ends its subscription too.
    let release;
    const slowStore = new Promise(resolve => { release = resolve; });
    let closeEarly;
    let listeners = 0;
    const fake = { onLog: () => { listeners++; return { dispose() { listeners--; } }; }, list: async () => [], readLog: async () => [], loadWorkflow: async () => undefined };
    new RunsViewProvider({ runs: () => slowStore, stop: () => false, resume: async () => undefined, openLog: async () => undefined }).resolveWebviewView({
      visible: true, webview: { cspSource: 'x', options: {}, set html(value) { void value; }, onDidReceiveMessage() {} }, onDidChangeVisibility() {}, onDidDispose: handler => { closeEarly = handler; } });
    closeEarly();
    release(fake);
    await sleep(100);
    assert.equal(listeners, 0, 'a view closed early kept its subscription');
    console.log('Studio runs live smoke passed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exit(1); });
