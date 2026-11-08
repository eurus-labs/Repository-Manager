const assert = require('node:assert/strict');
const Module = require('node:module');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

// Activating the extension: every command declared in package.json is registered with or without
// a folder, a command run without a folder shows an error, and a part that throws while starting
// is reported without taking the other part's commands with it.
const root = path.resolve(__dirname, '..', '..');
const manifest = require(path.join(root, 'package.json'));
const declared = manifest.contributes.commands.map(c => c.command);

// Any API the test does not care about answers with a stand-in that accepts every call.
function stub(name) {
  const fn = function () { return stub(`${name}()`); };
  return new Proxy(fn, {
    get(_target, key) {
      if (key === 'then') { return undefined; }
      if (key === 'dispose') { return () => undefined; }
      return stub(`${name}.${String(key)}`);
    },
    set() { return true; },
    construct() { return stub(`new ${name}`); },
    apply() { return stub(`${name}()`); }
  });
}
const withStubs = (name, object) => new Proxy(object, { get: (t, key) => key in t ? t[key] : stub(`${name}.${String(key)}`) });

let commands;
let errors;
let output;
let folders;
let failIn;
let customEditors;
const vscode = withStubs('vscode', {
  commands: withStubs('commands', {
    registerCommand(id, handler) {
      assert.ok(!commands.has(id), `${id} registered twice`);
      if (failIn === 'git' && id === 'repositoryManager.createBranch') { throw new Error('create branch broke'); }
      commands.set(id, handler);
      return { dispose() {} };
    },
    executeCommand: async () => undefined,
    getCommands: async () => [...commands.keys()]
  }),
  workspace: withStubs('workspace', {
    get workspaceFolders() { return folders; },
    getConfiguration: () => ({ get: (_key, value) => value, inspect: () => undefined, update: async () => undefined })
  }),
  window: withStubs('window', {
    createOutputChannel: () => withStubs('output', { appendLine: line => output.push(line), show() {}, dispose() {} }),
    showErrorMessage: async message => { errors.push(message); return undefined; },
    showWarningMessage: async () => undefined,
    showInformationMessage: async () => undefined,
    createTreeView(id) { if (failIn === 'requirements' && id.startsWith('repositoryManager.requirements')) { throw new Error('tree view broke'); } return stub('treeView'); },
    registerWebviewViewProvider: () => ({ dispose() {} }),
    registerCustomEditorProvider(viewType) { customEditors.push(viewType); return { dispose() {} }; }
  })
});
const load = Module._load;
Module._load = function (request, ...rest) { return request === 'vscode' ? vscode : load.call(this, request, ...rest); };
const extension = require(path.join(root, 'out', 'extension.js'));

async function activate(options) {
  commands = new Map(); errors = []; output = []; customEditors = [];
  folders = options.folder ? [{ uri: { fsPath: root, toString: () => `file://${root}` }, name: 'repo', index: 0 }] : undefined;
  failIn = options.failIn;
  const state = new Map([['repositoryManager.welcomeShown', true]]);
  const context = withStubs('context', {
    subscriptions: [],
    extension: { packageJSON: manifest },
    extensionUri: { fsPath: root, path: root },
    globalStorageUri: { fsPath: path.join(root, '.test-storage') },
    // The Agent keeps its tasks here (workspace storage); none exist yet.
    storageUri: { fsPath: fs.mkdtempSync(path.join(os.tmpdir(), 'activation-storage-')) },
    globalState: { get: key => state.get(key), update: async (key, value) => { state.set(key, value); }, keys: () => [...state.keys()], setKeysForSync() {} },
    workspaceState: { get: () => undefined, update: async () => undefined, keys: () => [] }
  });
  extension.activate(context);
  await new Promise(resolve => setImmediate(resolve));
}
const missing = () => declared.filter(id => !commands.has(id));

(async () => {
  await activate({ folder: true });
  assert.deepEqual(missing(), [], 'with a folder every declared command is registered');
  assert.deepEqual(errors, []);
  assert.ok(output.includes(`All ${declared.length} commands registered`), output.join('\n'));

  await activate({ folder: false });
  assert.deepEqual(missing(), [], 'without a folder every declared command is still registered');
  await commands.get('repositoryManager.openPanel')();
  assert.deepEqual(errors, [extension.NO_FOLDER_MESSAGE], 'Open Panel without a folder shows an error');
  assert.ok(output.includes('No workspace folder open'));
  // Its editors open files with or without a folder: a clarification file, a workflow file.
  assert.deepEqual(customEditors.sort(), ['repositoryManager.requirementEditor', 'repositoryManager.workflowEditor']);

  await activate({ folder: true, failIn: 'requirements' });
  assert.ok(commands.has('repositoryManager.openPanel'), 'a Requirements failure keeps the Git commands');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /Requirements failed to start/);
  assert.ok(output.some(line => line.startsWith('Requirements failed to start: Error: tree view broke')), output.join('\n'));

  await activate({ folder: true, failIn: 'git' });
  assert.ok(commands.has('repositoryManager.openPanel'), 'commands registered before the failure stay');
  assert.ok(commands.has('repositoryManager.requirements.newFile'), 'a Git failure keeps the Requirements commands');
  assert.match(errors[0], /Git commands failed to start/);
  const lost = output.find(line => line.startsWith('Commands not registered:')) || '';
  assert.match(lost, /repositoryManager\.createBranch/, 'the commands lost to the failure are logged');
  assert.doesNotMatch(lost, /openPanel/);

  console.log('activation smoke passed');
})().catch(error => { console.error(error); process.exit(1); });
