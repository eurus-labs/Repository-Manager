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
const answers = { quickPick: [], warning: [], info: [], input: [], save: [], open: [] };
const fakeVscode = {
  commands: { registerCommand: (id, run) => { commands.set(id, run); return { dispose() {} }; } },
  window: {
    showQuickPick: async items => { const pick = answers.quickPick.shift(); return items.find(pick); },
    showInputBox: async () => answers.input.shift(),
    showSaveDialog: async () => answers.save.shift(),
    showOpenDialog: async () => answers.open.shift(),
    showWarningMessage: async (message, options) => { asked.push(['warning', message, options.detail]); return answers.warning.shift(); },
    showInformationMessage: async (message, ...rest) => { asked.push(['info', message]); return answers.info.shift(); },
    showErrorMessage: async (message, options) => { asked.push(['error', message, options && options.detail]); },
    withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false }),
    showTextDocument: async () => undefined,
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
    answers.open.push([{ fsPath: exported }]);
    answers.warning.push(undefined);
    await commands.get('repositoryManager.studio.importWorkflow')();
    const question = asked.find(entry => entry[0] === 'warning');
    assert.equal(question[1], 'Import "Write a note" into your library?');
    assert.match(question[2], /When it runs, it:\n• .*\n• Asks you before write \(file\.write\) writes files\./);
    assert.match(question[2], /Importing runs nothing\./);
    assert.doesNotMatch(question[2], /did not match/, 'an exported file warned');
    assert.equal(fs.existsSync(path.join(library, 'note.workflow.json')), false, 'imported though cancelled');
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

    // A newer extension's file says what is missing; a broken file is refused.
    const newer = path.join(base, 'shared', 'newer.workflow.json');
    fs.writeFileSync(newer, JSON.stringify({ ...shared, id: 'newer', requires: { ...shared.requires, extension: '>=9.1.0' } }));
    asked.length = 0;
    answers.open.push([{ fsPath: newer }]);
    answers.warning.push(undefined);
    await commands.get('repositoryManager.studio.importWorkflow')();
    assert.match(asked.find(entry => entry[0] === 'warning')[2], /Missing here:\n• Repository Manager 9\.1\.0 or later \(this is 3\.3\.0\)\./);
    const broken = path.join(base, 'shared', 'broken.workflow.json');
    fs.writeFileSync(broken, '{"schema": "repository-manager/workflow@1"');
    asked.length = 0;
    answers.open.push([{ fsPath: broken }]);
    await commands.get('repositoryManager.studio.importWorkflow')();
    assert.deepEqual(asked.map(entry => entry.slice(0, 2)), [['error', 'broken.workflow.json cannot be imported.']]);

    // The imported workflows are offered by Run Workflow… under Library.
    let offered = [];
    answers.quickPick.push(item => { offered.push(`${item.label} ${item.description}`); return false; });
    await commands.get('repositoryManager.studio.runWorkflow')();
    assert.ok(offered.includes('note Library') && offered.includes('note-2 Library'), offered.join(', '));
    console.log('Studio commands smoke passed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
