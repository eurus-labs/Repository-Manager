// The diagram follows a run (plan 10): the real WorkflowEditorProvider with a scripted `vscode`, a real
// RunStore, and runs written the way the engine writes them (log first, state after). What the page is
// sent is checked here; how it draws it is checked by studioEditorUi.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-editor-live-'));
const changeListeners = [];
const executed = [];
const fakeVscode = {
  Uri: { file: fsPath => ({ fsPath, toString: () => `file://${fsPath}` }), joinPath: (parent, ...parts) => ({ fsPath: path.join(parent.fsPath, ...parts), toString: () => path.join(parent.fsPath, ...parts) }) },
  workspace: { onDidChangeTextDocument: listener => { changeListeners.push(listener); return { dispose() { changeListeners.splice(changeListeners.indexOf(listener), 1); } }; } },
  window: { registerCustomEditorProvider: () => ({ dispose() {} }) },
  commands: { executeCommand: async (...args) => { executed.push(args); } }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { WorkflowEditorProvider } = require('../../out/studio/workflowEditorProvider.js');
Module._load = originalLoad;
const { RunStore } = require('../../out/studio/engine.js');
const { workflowHash } = require('../../out/studio/workflow.js');

const unhandled = [];
process.on('unhandledRejection', error => unhandled.push(error));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (check, what) => {
  for (let i = 0; i < 150; i++) { if (check()) return; await sleep(20); }
  assert.fail(`timed out waiting for ${what}`);
};

const flow = {
  schema: 'repository-manager/workflow@1', id: 'live', version: '1.0.0', title: 'Live flow',
  nodes: [
    { id: 'a', type: 'file.write', title: 'Write A', with: { path: 'a.txt', content: 'a' } },
    { id: 'b', type: 'gate', title: 'Check B', with: { title: 'Fine?' } },
    { id: 'c', type: 'file.write', title: 'Write C', with: { path: 'c.txt', content: 'c' } }
  ],
  edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }]
};
const text = JSON.stringify(flow, null, 2);
const at = seconds => new Date(Date.UTC(2026, 10, 28, 10, 0, seconds)).toISOString();
const runState = (id, extra = {}) => ({ id, workflow: { id: 'live', version: '1.0.0', title: 'Live flow', hash: workflowHash(text) }, startedAt: at(0), updatedAt: at(0),
  status: 'running', inputs: {}, approvals: {}, nodes: { a: { status: 'pending' }, b: { status: 'pending' }, c: { status: 'pending' } }, ...extra });

async function main() {
  try {
    const store = new RunStore(path.join(base, 'runs'));
    const stopped = [];
    const runs = { runs: async () => store, stop: id => { stopped.push(id); return id === 'r1'; } };
    const document = { uri: { toString: () => 'file:///flow.workflow.json', fsPath: '/flow.workflow.json' }, isDirty: false, text, getText() { return this.text; }, get lineCount() { return 1; }, save: async () => true };
    const posted = [];
    let receive;
    let dispose;
    const panel = {
      onDidDispose: handler => { dispose = handler; },
      webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: uri => ({ toString: () => uri.fsPath }), postMessage: async message => { posted.push(message); return true; }, onDidReceiveMessage: handler => { receive = handler; } }
    };
    await new WorkflowEditorProvider({ fsPath: path.join(__dirname, '../..') }, runs).resolveCustomTextEditor(document, panel);
    await receive({ type: 'ready' });
    const runStates = () => posted.filter(message => message.type === 'runState');
    const last = () => runStates()[runStates().length - 1];
    const outcomes = () => Object.fromEntries(Object.entries(last().run.steps).map(([id, step]) => [id, step.outcome]));
    await sleep(100);
    assert.equal(runStates().length, 0, 'a diagram with no run was sent a run state');

    // ---- a run of another workflow posts nothing, however much it logs.
    await store.save({ ...runState('other'), workflow: { id: 'other', version: '1', title: 'Other', hash: 'x' } });
    await store.log('other', { type: 'node', node: 'a' });
    await store.log('other', { type: 'done', node: 'a' });
    await sleep(600);
    assert.equal(runStates().length, 0, 'a run of another workflow reached the diagram');

    // ---- the run of this workflow: pending, then running, then done for a, running then waiting for b.
    await store.save(runState('r1'));
    await store.saveWorkflow('r1', flow);
    await store.log('r1', { at: at(0), type: 'start' });
    await until(() => runStates().length > 0, 'the first run state');
    assert.deepEqual(outcomes(), { a: 'pending', b: 'pending', c: 'pending' });
    assert.deepEqual([last().run.id, last().run.title, last().run.status, last().run.step, last().run.total, last().run.earlier, last().run.stoppable], ['r1', 'Live flow', 'running', 1, 3, false, true]);
    const seen = [JSON.stringify(outcomes())];
    const wait = async (check, what) => { await until(() => runStates().length && check(), what); seen.push(JSON.stringify(outcomes())); };
    await store.log('r1', { at: at(1), type: 'node', node: 'a' });
    await wait(() => outcomes().a === 'running', 'a running');
    assert.equal(last().run.steps.a.since, at(1));
    await store.log('r1', { at: at(2), type: 'tool', node: 'a', name: 'read_file', ok: true, note: 'a.ts:1-9' });
    await wait(() => last().run.activity === 'read_file a.ts:1-9', 'the activity line');
    await store.log('r1', { at: at(3), type: 'done', node: 'a' });
    await store.save(runState('r1', { nodes: { a: { status: 'done' }, b: { status: 'pending' }, c: { status: 'pending' } } }));
    await wait(() => outcomes().a === 'done', 'a done');
    await store.log('r1', { at: at(4), type: 'node', node: 'b' });
    await wait(() => outcomes().b === 'running', 'b running');
    assert.deepEqual([outcomes().a, last().run.step], ['done', 2]);
    // The log says waiting before the state is saved: the confirming look still ends on waiting.
    await store.log('r1', { at: at(5), type: 'waiting', node: 'b', kind: 'gate' });
    await sleep(60);
    await store.save(runState('r1', { status: 'waiting', nodes: { a: { status: 'done' }, b: { status: 'pending' }, c: { status: 'pending' } }, waiting: { node: 'b', kind: 'gate', title: 'Fine?', effect: 'read', preview: '' } }));
    await wait(() => outcomes().b === 'waiting' && last().run.status === 'waiting', 'b waiting');
    assert.deepEqual([last().run.stoppable, last().run.activity], [false, undefined]);
    const order = seen.map(item => JSON.parse(item));
    const firstIndex = (id, outcome) => order.findIndex(item => item[id] === outcome);
    assert.ok(firstIndex('a', 'pending') === 0 && firstIndex('a', 'running') > 0 && firstIndex('a', 'done') > firstIndex('a', 'running'), `a did not go pending, running, done: ${seen.join(' ')}`);
    assert.ok(firstIndex('b', 'running') > firstIndex('a', 'done') && firstIndex('b', 'waiting') > firstIndex('b', 'running'), `b did not go running, waiting: ${seen.join(' ')}`);

    // ---- throttled: a burst of entries is not a burst of posts (at most one per 250 ms, with a confirming one).
    const before = runStates().length;
    const started = Date.now();
    for (let i = 0; i < 40; i++) { await store.log('r1', { at: at(6), type: 'tool', node: 'b', name: `t${i}`, ok: true }); }
    await sleep(700);
    const burst = runStates().length - before;
    assert.ok(burst <= 1 + Math.ceil((Date.now() - started) / 250), `${burst} posts for 40 entries`);

    // ---- earlier version: the file differs from the run's copy; a step the file no longer has is listed.
    const edited = { ...flow, title: 'Live flow, edited', nodes: flow.nodes.filter(node => node.id !== 'c'), edges: [{ from: 'a', to: 'b' }] };
    document.text = JSON.stringify(edited, null, 2);
    changeListeners.forEach(listener => listener({ document }));
    await until(() => last().run.earlier === true, 'the earlier-version flag');
    assert.deepEqual(last().run.missing, [{ id: 'c', title: 'Write C', outcome: 'pending' }]);
    assert.deepEqual(Object.keys(last().run.steps), ['a', 'b'], 'a step the file no longer has was drawn');
    document.text = text;
    changeListeners.forEach(listener => listener({ document }));
    await until(() => last().run.earlier === false && last().run.missing.length === 0, 'the same file again');

    // ---- the page opened anew is told again.
    const count = runStates().length;
    await receive({ type: 'ready' });
    await until(() => runStates().length > count, 'the run state after ready');

    // ---- Stop: the message names the run the diagram shows; another id is ignored; a refusal is said.
    await receive({ type: 'stopRun', run: 'r1' });
    assert.deepEqual(stopped, ['r1']);
    await receive({ type: 'stopRun', run: 'not-shown' });
    assert.deepEqual(stopped, ['r1'], 'a run the diagram does not show was stopped');
    await receive({ type: 'openRuns' });
    assert.deepEqual(executed.at(-1), ['repositoryManager.studio.runs.focus']);

    // ---- the run ends: its finish is logged before its state is saved, and the diagram says so at once.
    await store.log('r1', { at: at(9), type: 'finish', status: 'stopped', reason: 'Cancelled' });
    await until(() => last().run.status === 'stopped', 'the stopped run');
    assert.deepEqual([outcomes().b, last().run.stoppable], ['stopped', false]);
    await store.save(runState('r1', { status: 'stopped', error: 'Cancelled', nodes: { a: { status: 'done' }, b: { status: 'pending' }, c: { status: 'pending' } } }));
    await sleep(600);
    assert.equal(last().run.status, 'stopped', 'the final state was lost');

    // ---- a failed step keeps its error on the diagram.
    await store.save(runState('r2', { startedAt: at(20) }));
    await store.saveWorkflow('r2', flow);
    await store.log('r2', { at: at(20), type: 'start' });
    await until(() => last().run.id === 'r2', 'the newer run');
    await store.log('r2', { at: at(21), type: 'node', node: 'a' });
    await store.log('r2', { at: at(22), type: 'finish', status: 'failed', node: 'a', error: 'disk full' });
    await store.save(runState('r2', { startedAt: at(20), status: 'failed', error: 'a: disk full', nodes: { a: { status: 'failed', error: 'disk full' }, b: { status: 'pending' }, c: { status: 'pending' } } }));
    await until(() => last().run.status === 'failed', 'the failed run');
    assert.deepEqual([last().run.steps.a.outcome, last().run.steps.a.error], ['failed', 'disk full']);

    // ---- closing the panel ends the subscription: a later entry posts nothing and throws nothing.
    dispose();
    const closed = posted.length;
    await store.log('r2', { at: at(30), type: 'tool', node: 'a', name: 'late' });
    await store.save(runState('r3'));
    await store.log('r3', { at: at(30), type: 'start' });
    await sleep(700);
    assert.equal(posted.length, closed, 'a message was posted after the panel closed');
    assert.equal(changeListeners.length, 0, 'the document listener was kept');
    assert.deepEqual(unhandled, []);

    // ---- a diagram opened while a run goes on: found at open, with what the log already says.
    const again = [];
    let receiveAgain;
    const second = { onDidDispose() {}, webview: { ...panel.webview, postMessage: async message => { again.push(message); return true; }, onDidReceiveMessage: handler => { receiveAgain = handler; } } };
    await store.save(runState('r4', { startedAt: at(40) }));
    await store.saveWorkflow('r4', flow);
    await store.log('r4', { at: at(40), type: 'start' });
    await store.log('r4', { at: at(41), type: 'node', node: 'a' });
    await new WorkflowEditorProvider({ fsPath: path.join(__dirname, '../..') }, runs).resolveCustomTextEditor(document, second);
    await receiveAgain({ type: 'ready' });
    await until(() => again.some(message => message.type === 'runState'), 'the run found at open');
    const found = again.filter(message => message.type === 'runState').at(-1).run;
    assert.deepEqual([found.id, found.steps.a.outcome], ['r4', 'running']);

    // ---- no runs at all (a window with no folder): nothing is followed, nothing throws.
    const bare = [];
    let receiveBare;
    const third = { onDidDispose() {}, webview: { ...panel.webview, postMessage: async message => { bare.push(message); return true; }, onDidReceiveMessage: handler => { receiveBare = handler; } } };
    await new WorkflowEditorProvider({ fsPath: path.join(__dirname, '../..') }).resolveCustomTextEditor(document, third);
    await receiveBare({ type: 'ready' });
    await receiveBare({ type: 'stopRun', run: 'r4' });
    assert.ok(bare.every(message => message.type === 'load'));
    console.log('Studio editor live smoke passed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exit(1); });
