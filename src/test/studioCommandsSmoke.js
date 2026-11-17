// The Studio's VS Code commands with a scripted vscode: Run Workflow… stops at the gate, and Show
// Workflow Runs takes a waiting run up again (after closing the dialog, or a restart).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-studio-commands-'));
const workspace = path.join(base, 'workspace');
fs.mkdirSync(path.join(workspace, '.repository-manager', 'workflows'), { recursive: true });
fs.writeFileSync(path.join(workspace, '.repository-manager', 'workflows', 'note.workflow.json'), JSON.stringify({
  schema: 'repository-manager/workflow@1', id: 'note', version: '1.0.0', title: 'Write a note',
  inputs: { text: { type: 'string', title: 'Text' } },
  nodes: [{ id: 'write', type: 'file.write', with: { path: 'notes/note.txt', content: '${inputs.text}' } }]
}));

const commands = new Map();
const asked = [];
const shown = [];
const reported = [];
let progressHook;
const answers = { quickPick: [], warning: [], info: [], input: [], save: [], open: [] };
const fakeVscode = {
  commands: { registerCommand: (id, run) => { commands.set(id, run); return { dispose() {} }; } },
  window: {
    showQuickPick: async items => { const pick = answers.quickPick.shift(); return items.find(pick); },
    showInputBox: async () => answers.input.shift(),
    showSaveDialog: async () => answers.save.shift(),
    showOpenDialog: async () => answers.open.shift(),
    showWarningMessage: async (message, options) => {
      asked.push(['warning', message, options.detail]);
      const answer = answers.warning.shift();
      return typeof answer === 'function' ? answer() : answer;
    },
    showInformationMessage: (message, ...rest) => {
      asked.push(['info', message]);
      const answer = answers.info.shift();
      return Promise.resolve(typeof answer === 'function' ? answer(rest) : answer);
    },
    showErrorMessage: async (message, options) => { asked.push(['error', message, options && options.detail]); },
    withProgress: async (_options, task) => task({ report: value => { reported.push(value.message); progressHook?.(value.message); } }, { isCancellationRequested: false }),
    showTextDocument: async document => { shown.push(document); },
    registerCustomEditorProvider: (viewType) => { commands.set(`editor:${viewType}`, true); return { dispose() {} }; }
  },
  workspace: { openTextDocument: async () => ({}) },
  ProgressLocation: { Notification: 15 },
  CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false }; } cancel() {} dispose() {} },
  Uri: { file: fsPath => ({ fsPath }) }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { registerStudio } = require('../../out/studio/studioCommands.js');
Module._load = originalLoad;

const context = () => ({
  subscriptions: [],
  globalStorageUri: { fsPath: path.join(base, 'global') },
  storageUri: { fsPath: path.join(base, 'storage') },
  extensionUri: { fsPath: path.join(__dirname, '../..') },
  globalState: { get: () => undefined },
  extension: { packageJSON: { version: '3.3.0' } }
});

async function main() {
  try {
    // A run left running when VS Code closed (#140), found at start; a run started right away waits
    // for that recovery, so it is never taken for an interrupted one.
    const { RunStore } = require('../../out/studio/engine.js');
    const runs = new RunStore(path.join(base, 'storage', 'studio', 'runs'));
    await runs.save({ id: 'left-running', workflow: { id: 'note', version: '1.0.0', title: 'Write a note', hash: 'h' }, startedAt: '2026-11-01T00:00:00Z',
      updatedAt: '', status: 'running', inputs: {}, nodes: { write: { status: 'pending' } }, approvals: {} });
    registerStudio(context(), workspace);
    const note = path.join(workspace, 'notes', 'note.txt');

    // Run Workflow…: pick, input, consent; at the gate the dialog is closed, so the run waits.
    answers.quickPick.push(item => item.label === 'note');
    answers.input.push('hello');
    answers.info.push('Run');
    answers.warning.push(undefined);
    await commands.get('repositoryManager.studio.runWorkflow')();
    const gate = asked.find(entry => entry[0] === 'warning');
    assert.deepEqual(gate.slice(0, 2), ['warning', 'Write a file: write']);
    assert.match(gate[2], /^Create notes\/note\.txt \(5 characters\):\n\nhello$/);
    assert.equal((await runs.load('left-running')).status, 'failed');
    const started = (await runs.list()).find(item => item.id !== 'left-running');
    assert.equal(started.status, 'waiting', 'the new run was taken for an interrupted one');
    assert.equal(fs.existsSync(note), false, 'written before approval');

    // A restart: the commands are registered again, and Show Workflow Runs asks again, then goes on.
    commands.clear();
    asked.length = 0;
    registerStudio(context(), workspace);
    answers.quickPick.push(item => item.run.status === 'waiting');
    answers.warning.push('Approve');
    await commands.get('repositoryManager.studio.showRuns')();
    assert.equal(asked.filter(entry => entry[0] === 'warning').length, 1, 'the waiting run did not ask again');
    assert.equal(fs.readFileSync(note, 'utf8'), 'hello');
    assert.ok(asked.some(entry => entry[0] === 'info' && entry[1] === 'Write a note: done.'));

    // Stop Run at the gate: stopped, nothing written.
    fs.rmSync(path.join(workspace, 'notes'), { recursive: true });
    asked.length = 0;
    answers.quickPick.push(item => item.label === 'note');
    answers.input.push('again');
    answers.info.push('Run');
    answers.warning.push('Stop Run');
    await commands.get('repositoryManager.studio.runWorkflow')();
    assert.equal(fs.existsSync(note), false);
    assert.ok(asked.some(entry => entry[0] === 'info' && /^Write a note stopped: Not approved at "write"\./.test(entry[1])));
    // A finished run returns while its "done." notification is still open (the chat is unlocked by run()
    // returning), and Open Result, clicked later, opens that run's file.
    fs.rmSync(path.join(workspace, 'notes'), { recursive: true, force: true });
    asked.length = 0;
    shown.length = 0;
    let clickOpen;
    answers.quickPick.push(item => item.label === 'note');
    answers.input.push('left open');
    answers.info.push('Run');
    answers.info.push(() => new Promise(resolve => { clickOpen = resolve; }));
    answers.warning.push('Approve');
    const timeout = new Promise(resolve => setTimeout(() => resolve('timeout'), 2000));
    const finished = commands.get('repositoryManager.studio.runWorkflow')().then(() => 'returned');
    assert.equal(await Promise.race([finished, timeout]), 'returned', 'the run waited for its "done." notification to be answered');
    assert.ok(asked.some(entry => entry[0] === 'info' && entry[1] === 'Write a note: done.'));
    assert.equal(shown.length, 0, 'Open Result opened before it was clicked');
    clickOpen('Open Result');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(shown.length, 1);
    assert.equal(shown[0].fsPath, note);
    assert.equal(fs.readFileSync(note, 'utf8'), 'left open');
    // The editor's Run gives the file: no pick, the same inputs, consent and gate.
    fs.rmSync(path.join(workspace, 'notes'), { recursive: true, force: true });
    asked.length = 0;
    answers.input.push('from the editor');
    answers.info.push('Run');
    answers.warning.push('Approve');
    await commands.get('repositoryManager.studio.runWorkflow')({ fsPath: path.join(workspace, '.repository-manager', 'workflows', 'note.workflow.json') });
    assert.equal(fs.readFileSync(note, 'utf8'), 'from the editor');

    // Sharing (phase 3). Export writes the workflow with the requirements read from it.
    const library = path.join(base, 'global', 'studio', 'workflows');
    const exported = path.join(base, 'shared', 'note.workflow.json');
    fs.mkdirSync(path.dirname(exported), { recursive: true });
    asked.length = 0;
    answers.quickPick.push(item => item.label === 'note');
    answers.save.push({ fsPath: exported });
    await commands.get('repositoryManager.studio.exportWorkflow')();
    const shared = JSON.parse(fs.readFileSync(exported, 'utf8'));
    assert.deepEqual(shared.requires, { extension: '>=3.3.0', steps: ['file.write'], models: [], skills: [], scripts: [] });
    assert.equal(shared.title, 'Write a note', 'export changed the workflow');
    // Cancelling the save dialog writes nothing.
    answers.quickPick.push(item => item.label === 'note');
    answers.save.push(undefined);
    await commands.get('repositoryManager.studio.exportWorkflow')();

    // Import says what it does and runs nothing; cancelling keeps the library empty.
    asked.length = 0;
    answers.quickPick.push(item => item === 'From a file…');
    answers.open.push([{ fsPath: exported }]);
    answers.warning.push(undefined);
    await commands.get('repositoryManager.studio.importWorkflow')();
    const question = asked.find(entry => entry[0] === 'warning');
    assert.equal(question[1], 'Import "Write a note" into your library?');
    assert.match(question[2], /When it runs, it:\n• .*\n• Asks you before write \(file\.write\) writes files\./);
    assert.match(question[2], /Importing runs nothing\./);
    assert.doesNotMatch(question[2], /did not match/, 'an exported file warned');
    assert.equal(fs.existsSync(path.join(library, 'note.workflow.json')), false, 'imported though cancelled');
    answers.quickPick.push(item => item === 'From a file…');
    answers.open.push([{ fsPath: exported }]);
    answers.warning.push('Import');
    await commands.get('repositoryManager.studio.importWorkflow')();
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(library, 'note.workflow.json'), 'utf8')), shared);

    // A file whose requires was edited by hand: warned, the computed one kept. Same id, other
    // content: Keep Both imports it under a free id.
    const edited = path.join(base, 'shared', 'edited.workflow.json');
    fs.writeFileSync(edited, JSON.stringify({ ...shared, title: 'Write a note (edited)', about: { authors: ['Ana'], license: 'MIT', homepage: 'https://example.com/w' },
      requires: { ...shared.requires, steps: ['prompt'], scripts: ['test'] } }));
    asked.length = 0;
    answers.quickPick.push(item => item === 'From a file…');
    answers.open.push([{ fsPath: edited }]);
    answers.warning.push('Import', 'Keep Both');
    await commands.get('repositoryManager.studio.importWorkflow')();
    const [importQuestion, conflict] = asked.filter(entry => entry[0] === 'warning');
    assert.match(importQuestion[2], /^Write a note \(edited\) 1\.0\.0 by Ana · MIT\nhttps:\/\/example\.com\/w/);
    assert.match(importQuestion[2], /"requires\.steps" does not match the workflow; it uses file\.write; it does not use prompt\./);
    assert.match(importQuestion[2], /"requires\.scripts" does not match the workflow; it does not use test\./);
    assert.equal(conflict[1], 'Your library already has a workflow "note".');
    const both = JSON.parse(fs.readFileSync(path.join(library, 'note-2.workflow.json'), 'utf8'));
    assert.equal(both.id, 'note-2');
    assert.deepEqual(both.requires, shared.requires, 'the hand-edited requires was kept');
    assert.equal(JSON.parse(fs.readFileSync(path.join(library, 'note.workflow.json'), 'utf8')).title, 'Write a note', 'Keep Both replaced the first');

    // Keep Both while another window takes the same new id: the file is created exclusively, so this
    // import moves on to the next free id instead of overwriting the other one.
    const raced = path.join(base, 'shared', 'raced.workflow.json');
    fs.writeFileSync(raced, JSON.stringify({ ...shared, title: 'Write a note (raced)' }));
    answers.quickPick.push(item => item === 'From a file…');
    answers.open.push([{ fsPath: raced }]);
    answers.warning.push('Import', () => {
      fs.writeFileSync(path.join(library, 'note-3.workflow.json'), JSON.stringify({ ...shared, id: 'note-3', title: 'Other window' }));
      return 'Keep Both';
    });
    await commands.get('repositoryManager.studio.importWorkflow')();
    assert.equal(JSON.parse(fs.readFileSync(path.join(library, 'note-3.workflow.json'), 'utf8')).title, 'Other window', 'the other window\'s import was overwritten');
    const next = JSON.parse(fs.readFileSync(path.join(library, 'note-4.workflow.json'), 'utf8'));
    assert.deepEqual([next.id, next.title], ['note-4', 'Write a note (raced)']);

    // A newer extension's file says what is missing; a broken file is refused.
    const newer = path.join(base, 'shared', 'newer.workflow.json');
    fs.writeFileSync(newer, JSON.stringify({ ...shared, id: 'newer', requires: { ...shared.requires, extension: '>=9.1.0' } }));
    asked.length = 0;
    answers.quickPick.push(item => item === 'From a file…');
    answers.open.push([{ fsPath: newer }]);
    answers.warning.push(undefined);
    await commands.get('repositoryManager.studio.importWorkflow')();
    assert.match(asked.find(entry => entry[0] === 'warning')[2], /Missing here:\n• Repository Manager 9\.1\.0 or later \(this is 3\.3\.0\)\./);
    const broken = path.join(base, 'shared', 'broken.workflow.json');
    fs.writeFileSync(broken, '{"schema": "repository-manager/workflow@1"');
    asked.length = 0;
    answers.quickPick.push(item => item === 'From a file…');
    answers.open.push([{ fsPath: broken }]);
    await commands.get('repositoryManager.studio.importWorkflow')();
    assert.deepEqual(asked.map(entry => entry.slice(0, 2)), [['error', 'broken.workflow.json cannot be imported.']]);

    // From a URL: the same checks and question, with where it came from; then it runs.
    const fetchModule = require('../../out/studio/fetchShared.js');
    const realFetch = fetchModule.fetchSharedWorkflow;
    const served = JSON.stringify({ ...shared, id: 'from-url', title: 'Write a note (from a URL)' });
    const fetched = [];
    fetchModule.fetchSharedWorkflow = async address => { fetched.push(address); return { text: served, url: 'https://example.com/final/from-url.workflow.json' }; };
    asked.length = 0;
    answers.quickPick.push(item => item === 'From a URL…');
    answers.input.push('https://example.com/from-url.workflow.json');
    answers.warning.push('Import');
    await commands.get('repositoryManager.studio.importWorkflow')();
    assert.deepEqual(fetched, ['https://example.com/from-url.workflow.json']);
    const urlQuestion = asked.find(entry => entry[0] === 'warning');
    assert.match(urlQuestion[2], /^Write a note \(from a URL\) 1\.0\.0\nFrom https:\/\/example\.com\/final\/from-url\.workflow\.json\n/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(library, 'from-url.workflow.json'), 'utf8')).title, 'Write a note (from a URL)');
    // A fetch that fails says why and imports nothing.
    fetchModule.fetchSharedWorkflow = async () => { throw new Error('The file is larger than 1024 KB.'); };
    asked.length = 0;
    answers.quickPick.push(item => item === 'From a URL…');
    answers.input.push('https://example.com/huge.workflow.json');
    await commands.get('repositoryManager.studio.importWorkflow')();
    assert.deepEqual(asked.map(entry => entry.slice(0, 2)), [['error', 'Could not import from https://example.com/huge.workflow.json: The file is larger than 1024 KB.']]);
    fetchModule.fetchSharedWorkflow = realFetch;
    // Export → Import → Run: the imported workflow runs from the library like any other.
    fs.rmSync(path.join(workspace, 'notes'), { recursive: true, force: true });
    asked.length = 0;
    answers.quickPick.push(item => item.label === 'from-url' && item.description === 'Library');
    answers.input.push('round trip');
    answers.info.push('Run');
    answers.warning.push('Approve');
    await commands.get('repositoryManager.studio.runWorkflow')();
    assert.equal(fs.readFileSync(path.join(workspace, 'notes', 'note.txt'), 'utf8'), 'round trip');

    // The imported workflows are offered by Run Workflow… under Library.
    let offered = [];
    answers.quickPick.push(item => { offered.push(`${item.label} ${item.description}`); return false; });
    await commands.get('repositoryManager.studio.runWorkflow')();
    assert.ok(['note', 'note-2', 'note-3', 'note-4', 'from-url'].every(id => offered.includes(`${id} Library`)), offered.join(', '));
    // ---- Run progress (plan 3): the notification names the step and what it does; the caller gets this
    // ---- run's log entries only, in order, and stops getting them when the run returns or throws.
    {
      commands.clear();
      const studio = registerStudio(context(), workspace);
      const store = await studio.runs();
      const flow = { schema: 'repository-manager/workflow@1', id: 'two', version: '1.0.0', title: 'Two notes',
        nodes: [{ id: 'a', type: 'file.write', title: 'Write A', with: { path: 'notes/a.txt', content: 'a' } },
          { id: 'b', type: 'file.write', title: 'Write B', with: { path: 'notes/b.txt', content: 'b' } }],
        edges: [{ from: 'a', to: 'b' }] };
      const seen = [];
      let runId;
      // While step a runs, its tool call is logged, and so is another run's entry.
      progressHook = message => {
        if (message !== 'Step 1/2: Write A') { return; }
        void store.log(runId, { type: 'tool', node: 'a', ok: true, name: 'read_file', note: 'a.ts:1-40' });
        void store.log('some-other-run', { type: 'tool', node: 'a', ok: true, name: 'intruder', note: 'other run' });
      };
      reported.length = 0;
      answers.info.push('Run');
      answers.warning.push('Approve', 'Approve');
      const final = await studio.run(flow, 'h', state => { runId = state.id; }, { onLog: entry => seen.push(entry) });
      assert.equal(final.status, 'done');
      assert.deepEqual(reported, ['Step 1/2: Write A', 'Step 1/2: Write A — read_file a.ts:1-40', 'Step 2/2: Write B'],
        'the progress notification did not name the step and its activity');
      assert.ok(!seen.some(entry => entry.name === 'intruder'), 'another run\'s entry reached this run\'s listener');
      assert.deepEqual(seen.map(entry => entry.type), ['waiting', 'approval', 'node', 'tool', 'done', 'waiting', 'approval', 'node', 'done', 'finish'],
        'the listener did not get this run\'s entries in the order written');
      assert.deepEqual(seen.filter(entry => entry.type !== 'tool').map(entry => entry.node).filter(Boolean), ['a', 'a', 'a', 'a', 'b', 'b', 'b', 'b']);
      assert.deepEqual(seen, (await store.readLog(runId)).filter(entry => entry.type !== 'start'), 'the entries are not the ones written');
      // Returned: the subscription is gone.
      await store.log(runId, { type: 'tool', node: 'b', ok: true, name: 'late', note: 'after the run' });
      assert.equal(seen.length, 10, 'an entry reached the listener after the run returned');

      // Thrown: an update that throws ends the run with the error, and the subscription is gone too.
      progressHook = undefined;
      asked.length = 0;
      const more = [];
      let thrownId;
      answers.info.push('Run');
      const result = await studio.run(flow, 'h', state => { thrownId = state.id; throw new Error('the page is gone'); }, { onLog: entry => more.push(entry) });
      assert.equal(result, undefined);
      assert.ok(asked.some(entry => entry[0] === 'error' && /the page is gone/.test(entry[1])));
      await store.log(thrownId, { type: 'tool', node: 'a', name: 'late' });
      assert.deepEqual(more, [], 'an entry reached the listener after the run threw');

      // The caller's signal stops the run where the notification's Cancel would.
      asked.length = 0;
      answers.info.push('Run', undefined);
      const stopped = await studio.run(flow, 'h', undefined, { signal: { cancelled: true } });
      assert.equal(stopped.status, 'stopped');
      assert.equal(stopped.error, 'Cancelled');
      // A resumed or editor run passes no options and still works (the notification has the step too).
      reported.length = 0;
      answers.info.push('Run', undefined);
      answers.warning.push('Approve', 'Approve');
      assert.equal((await studio.run(flow, 'h')).status, 'done');
      assert.ok(reported.includes('Step 1/2: Write A') && reported.includes('Step 2/2: Write B'));
    }

    console.log('Studio commands smoke passed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
