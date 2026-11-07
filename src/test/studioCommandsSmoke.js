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
const answers = { quickPick: [], warning: [], info: [], input: [] };
const fakeVscode = {
  commands: { registerCommand: (id, run) => { commands.set(id, run); return { dispose() {} }; } },
  window: {
    showQuickPick: async items => { const pick = answers.quickPick.shift(); return items.find(pick); },
    showInputBox: async () => answers.input.shift(),
    showWarningMessage: async (message, options) => { asked.push(['warning', message, options.detail]); return answers.warning.shift(); },
    showInformationMessage: async (message, ...rest) => { asked.push(['info', message]); return answers.info.shift(); },
    showErrorMessage: async message => { asked.push(['error', message]); },
    withProgress: async (_options, task) => task({ report() {} }, { isCancellationRequested: false }),
    showTextDocument: async () => undefined
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
  globalState: { get: () => undefined }
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
    console.log('Studio commands smoke passed');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
