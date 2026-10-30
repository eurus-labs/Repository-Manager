const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// The Requirements section of the Side Bar: which Markdown files are clarification files, what each
// row says, where a click goes, and New Clarification File from the v3 template.
const root = path.resolve(__dirname, '../..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'requirements-view-'));
const fileUri = fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` });
const commands = new Map();
const executed = [];
const prompts = { quickPick: [], input: [] };
class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
const fakeVscode = {
  TreeItem,
  TreeItemCollapsibleState: { None: 0 },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor() { this.value = ''; } appendText(text) { this.value += text; return this; } },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
  Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)) },
  workspace: {
    workspaceFolders: [{ uri: fileUri(workspace) }],
    asRelativePath: uri => path.relative(workspace, typeof uri === 'string' ? uri : uri.fsPath).split(path.sep).join('/'),
    findFiles: async () => {
      const found = [];
      const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).forEach(entry => {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules') walk(full);
        else if (entry.name.endsWith('.md')) found.push(fileUri(full));
      });
      walk(workspace);
      return found;
    },
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} })
  },
  window: {
    registerTreeDataProvider: () => ({ dispose() {} }),
    registerCustomEditorProvider: () => ({ dispose() {} }),
    showQuickPick: async items => { prompts.quickPick.push(items.map(i => i.label)); return items[0]; },
    showInputBox: async options => {
      const answer = prompts.input.shift();
      if (options.validateInput) { prompts.lastValidation = await options.validateInput(answer); }
      return prompts.lastValidation ? undefined : answer;
    },
    showErrorMessage: async message => { executed.push(['error', message]); }
  },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
    executeCommand: async (...args) => { executed.push(args); }
  }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { RequirementsTreeProvider, readClarification, registerRequirements } = require('../../out/requirements/requirementsView.js');
Module._load = originalLoad;

async function main() {
  const fixtures = path.join(__dirname, 'fixtures', 'requirements');
  const docs = path.join(workspace, 'docs', 'clarifications');
  fs.mkdirSync(docs, { recursive: true });
  fs.mkdirSync(path.join(workspace, 'node_modules', 'x'), { recursive: true });
  for (const name of ['CLR-001.md', 'CLR-002.md', 'CLR-003.md']) { fs.copyFileSync(path.join(fixtures, name), path.join(docs, name)); }
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Hello\n\nschema_version: 3\n');
  fs.writeFileSync(path.join(workspace, 'notes.md'), '---\ntitle: notes\n---\n\nschema_version: 3\n');
  fs.writeFileSync(path.join(docs, 'CLR-009.md'), fs.readFileSync(path.join(fixtures, 'CLR-003.md'), 'utf8').replaceAll('CLR-003', 'CLR-009').replace('**Scope**', '**Scope note**'));

  // Only files whose front matter names a schema version are listed; a broken one says why.
  assert.equal(await readClarification(fileUri(path.join(workspace, 'README.md'))), undefined);
  assert.equal(await readClarification(fileUri(path.join(workspace, 'notes.md'))), undefined, 'schema_version in the body counted');
  const tree = new RequirementsTreeProvider();
  const files = await tree.getChildren();
  assert.deepEqual(files.map(f => f.id), ['CLR-001', 'CLR-002', 'CLR-003', 'CLR-009.md']);
  const [v1, v2, v3, broken] = files.map(f => tree.getTreeItem(f));
  assert.equal(v3.label, 'CLR-003 · API integration discussion (schema v3)');
  assert.equal(v3.description, '2 of 2 open · docs/clarifications · v3');
  assert.deepEqual(v3.command.arguments.map(String), [`file://${path.join(docs, 'CLR-003.md')}`, 'repositoryManager.requirementEditor']);
  assert.equal(v3.contextValue, 'clarificationFile');
  assert.match(v1.description, /^1 of 1 open/);
  assert.match(v2.description, /^2 of 2 open .* v2$/);
  assert.equal(broken.description, 'does not validate');
  assert.equal(broken.command.command, 'vscode.open', 'a broken file should open as text, where it can be fixed');
  assert.match(broken.tooltip.value, /CLR-009-Q01: require fields in order/);

  // New Clarification File: folder, ID (checked), title; written from the template and opened.
  registerRequirements({ extensionUri: fileUri(root), globalStorageUri: fileUri(path.join(workspace, '.storage')), globalState: { get: (_k, d) => d, update: async () => undefined }, subscriptions: [] });
  prompts.input.push('clr-4');
  await commands.get('repositoryManager.requirements.newFile')();
  assert.match(prompts.lastValidation, /capital letters/);
  assert.deepEqual(prompts.quickPick[0], ['docs/clarifications', 'Choose a folder…']);
  prompts.input.push('CLR-003');
  await commands.get('repositoryManager.requirements.newFile')();
  assert.equal(prompts.lastValidation, 'CLR-003.md already exists here.');
  prompts.input.push('CLR-004', 'Typing indicator');
  await commands.get('repositoryManager.requirements.newFile')();
  const created = path.join(docs, 'CLR-004.md');
  const { parse } = require('../../out/requirements/douDocument.js');
  const text = fs.readFileSync(created, 'utf8');
  const parsed = parse(text);
  assert.deepEqual([parsed.id, parsed.version, parsed.items[0].id], ['CLR-004', 3, 'CLR-004-Q01']);
  assert.match(text, /^title: Typing indicator$/m);
  assert.ok(!text.includes('2026-10-27T09:00:00+07:00'), 'the template dates were kept');
  assert.deepEqual(executed.at(-1).map(String), ['vscode.openWith', `file://${created}`, 'repositoryManager.requirementEditor']);
  // From a row's menu, the new file goes beside that one.
  prompts.input.push('CLR-005', '');
  await commands.get('repositoryManager.requirements.newFile')(files[0]);
  assert.match(fs.readFileSync(path.join(docs, 'CLR-005.md'), 'utf8'), /^title: CLR-005$/m);
  await commands.get('repositoryManager.requirements.openAsText')(files[0]);
  assert.deepEqual(executed.at(-1).map(String), ['vscode.openWith', `file://${path.join(docs, 'CLR-001.md')}`, 'default']);
  console.log('Requirements view smoke test passed');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
}).finally(() => fs.rmSync(workspace, { recursive: true, force: true }));
