const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// The Requirements area of the Activity Bar: which Markdown files are clarification files, the
// items under each (the editor's unsaved ones for an open file), the requirements of the current
// file, the filters, the status bar, where a click goes, and New Clarification File.
const root = path.resolve(__dirname, '../..');
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'requirements-view-'));
const fileUri = fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` });
const commands = new Map();
const executed = [];
const infos = [];
const prompts = { quickPick: [], input: [], pickLabel: [] };
const views = {};
let status;
class EventEmitter {
  constructor() { this.listeners = []; this.event = listener => { this.listeners.push(listener); return { dispose() {} }; }; }
  fire(value) { this.listeners.forEach(listener => listener(value)); }
  dispose() {}
}
class TreeItem { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } }
class TabInputCustom { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType; } }
const tabs = { activeTab: undefined, listeners: [] };
const fakeVscode = {
  TreeItem, EventEmitter, TabInputCustom,
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeIcon: class { constructor(id, color) { this.id = id; this.color = color; } },
  ThemeColor: class { constructor(id) { this.id = id; } },
  MarkdownString: class { constructor() { this.value = ''; } appendText(text) { this.value += text; return this; } },
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)), parse: text => fileUri(text.replace(/^file:\/\//, '')) },
  workspace: {
    workspaceFolders: [{ uri: fileUri(workspace) }],
    asRelativePath: uri => path.relative(workspace, typeof uri === 'string' ? uri : uri.fsPath).split(path.sep).join('/'),
    findFiles: async () => {
      const found = [];
      const walk = folder => fs.readdirSync(folder, { withFileTypes: true }).forEach(entry => {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) walk(full);
        else if (entry.name.endsWith('.md')) found.push(fileUri(full));
      });
      walk(workspace);
      return found;
    },
    createFileSystemWatcher: () => ({ onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} })
  },
  window: {
    tabGroups: { get activeTabGroup() { return { activeTab: tabs.activeTab }; }, onDidChangeTabs: listener => { tabs.listeners.push(listener); return { dispose() {} }; } },
    createTreeView: (id, { treeDataProvider }) => {
      views[id] = { provider: treeDataProvider, visible: true, revealed: [], redrawn: [], reveal(node, options) { this.revealed.push([node, options]); return Promise.resolve(); }, dispose() {} };
      treeDataProvider.onDidChangeTreeData(node => views[id].redrawn.push(node));
      return views[id];
    },
    createStatusBarItem: () => (status = { shown: false, show() { this.shown = true; }, hide() { this.shown = false; }, dispose() {} }),
    registerCustomEditorProvider: () => ({ dispose() {} }),
    showQuickPick: async items => {
      prompts.quickPick.push(items.map(i => i.label));
      const label = prompts.pickLabel.shift();
      return label ? items.find(i => i.label === label) : items[0];
    },
    showInputBox: async options => {
      const answer = prompts.input.shift();
      if (options.validateInput) { prompts.lastValidation = await options.validateInput(answer); }
      return prompts.lastValidation ? undefined : answer;
    },
    showErrorMessage: async message => { executed.push(['error', message]); },
    showInformationMessage: async message => { infos.push(message); }
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
const { readClarification, registerRequirements } = require('../../out/requirements/requirementsView.js');
const { parse } = require('../../out/requirements/douDocument.js');
Module._load = originalLoad;

const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const labels = async (provider, parent) => Promise.all((await provider.getChildren(parent)).map(async node => provider.getTreeItem(node)));

async function main() {
  const fixtures = path.join(__dirname, 'fixtures', 'requirements');
  const docs = path.join(workspace, 'docs', 'clarifications');
  fs.mkdirSync(docs, { recursive: true });
  fs.mkdirSync(path.join(workspace, 'node_modules', 'x'), { recursive: true });
  for (const name of ['CLR-001.md', 'CLR-002.md', 'CLR-003.md']) { fs.copyFileSync(path.join(fixtures, name), path.join(docs, name)); }
  fs.writeFileSync(path.join(workspace, 'README.md'), '# Hello\n\nschema_version: 3\n');
  fs.writeFileSync(path.join(workspace, 'notes.md'), '---\ntitle: notes\n---\n\nschema_version: 3\n');
  fs.writeFileSync(path.join(docs, 'CLR-009.md'), fs.readFileSync(path.join(fixtures, 'CLR-003.md'), 'utf8').replaceAll('CLR-003', 'CLR-009').replace('**Scope**', '**Scope note**'));

  // Only files whose front matter names a schema version are listed; their items come along.
  assert.equal(await readClarification(fileUri(path.join(workspace, 'README.md'))), undefined);
  assert.equal(await readClarification(fileUri(path.join(workspace, 'notes.md'))), undefined, 'schema_version in the body counted');
  const v3 = await readClarification(fileUri(path.join(docs, 'CLR-003.md')));
  assert.deepEqual(v3.items.map(i => [i.id, i.status]), [['CLR-003-Q01', 'investigating'], ['CLR-003-Q02', 'open']]);
  assert.equal(v3.items[0].summary, 'A user whose message failed with a timeout can resend it once, without the recipient receiving it twice.');

  const context = { extensionUri: fileUri(root), globalStorageUri: fileUri(path.join(workspace, '.storage')), globalState: { get: (_k, d) => d, update: async () => undefined }, subscriptions: [] };
  registerRequirements(context);
  const clar = views['repositoryManager.requirements'];
  const reqs = views['repositoryManager.requirementsCatalog'];
  assert.ok(clar && reqs, 'the two views of the Requirements area are not created');

  // Clarifications: one row per file, items under it; a broken file opens as text and says why.
  const files = await labels(clar.provider);
  assert.deepEqual(files.map(f => f.label), ['CLR-001 · Message sending clarification', 'CLR-002 · API integration discussion', 'CLR-003 · API integration discussion (schema v3)', 'CLR-009.md · API integration discussion (schema v3)']);
  assert.deepEqual(files.map(f => f.description), ['1/1 open · docs/clarifications', '2/2 open · docs/clarifications', '2/2 open · docs/clarifications', 'does not validate']);
  assert.equal(files[2].collapsibleState, 1, 'a file that is not open starts collapsed');
  assert.equal(files[3].command.command, 'vscode.open', 'a broken file should open as text, where it can be fixed');
  assert.match(files[3].tooltip.value, /CLR-009-Q01: require fields in order/);
  const fileNodes = await clar.provider.getChildren();
  const items = await labels(clar.provider, fileNodes[2]);
  assert.deepEqual(items.map(i => [i.label, i.iconPath.color.id]), [['Q01', 'charts.yellow'], ['Q02', 'charts.blue']]);
  assert.deepEqual(items[0].command.arguments.map(String), [`file://${path.join(docs, 'CLR-003.md')}`, 'item', 'CLR-003-Q01']);
  assert.equal(clar.provider.getParent((await clar.provider.getChildren(fileNodes[2]))[0]), fileNodes[2]);

  // The status filter, picked from the funnel, hides other items and files without a match.
  prompts.pickLabel.push('Investigating');
  await commands.get('repositoryManager.requirements.filterClarifications')();
  assert.deepEqual((await labels(clar.provider)).map(f => f.label.split(' ')[0]), ['CLR-002', 'CLR-003']);
  assert.equal(clar.description, 'Status: investigating');
  prompts.pickLabel.push('All statuses');
  await commands.get('repositoryManager.requirements.filterClarifications')();
  assert.equal(clar.description, undefined);

  // An open file: its items as the editor has them, unsaved ones included; the requirements of
  // the current file; the status bar while its editor is the active tab.
  const editors = clar.provider.editors;
  const uri = fileUri(path.join(docs, 'CLR-003.md'));
  const document = await editors.openCustomDocument(uri, {});
  const posted = [];
  let listener;
  const panel = { active: true, reveal() {}, onDidDispose() {}, onDidChangeViewState() {},
    webview: { options: {}, html: '', cspSource: 'x', asWebviewUri: u => u.fsPath, postMessage: async m => { posted.push(m); return true; }, onDidReceiveMessage: fn => { listener = fn; } } };
  await editors.resolveCustomEditor(document, panel);
  await listener({ type: 'ready' });
  const outline = {
    id: 'CLR-003', title: 'API integration discussion (schema v3)', version: 3, dirty: true, unsavedFields: 2, sourceMode: false,
    items: [
      { id: 'CLR-003-Q01', status: 'investigating', summary: 'Resend once after a timeout', requirements: ['REQ-012'], unsaved: true, new: false },
      { id: 'CLR-003-Q02', status: 'open', summary: 'Duplicates after a day', requirements: ['REQ-012'], unsaved: false, new: false },
      { id: 'CLR-003-Q03', status: 'open', summary: 'Describe the open question.', requirements: ['REQ-013'], unsaved: true, new: true },
    ],
    requirements: [
      { id: 'REQ-012', title: 'Send messages', ready: false, empty: false, missing: false, unresolved: true, met: 2, rules: 6, next: 'Settle CLR-003-Q01.', clarifications: 2 },
      { id: 'REQ-013', title: 'Manual retry', ready: false, empty: false, missing: false, unresolved: true, met: 1, rules: 6, next: 'Settle CLR-003-Q03.', clarifications: 1 },
      { id: 'REQ_020', title: 'Read receipts', ready: true, empty: false, missing: false, unresolved: false, met: 6, rules: 6, next: '', clarifications: 1 },
    ],
    selected: { kind: 'item', id: 'CLR-003-Q03' },
    source: { configured: true, root: 'requirements', kind: 'folder', syncing: false, error: '' }, skipped: 0, truncated: false,
  };
  tabs.activeTab = { input: new TabInputCustom(uri, 'repositoryManager.requirementEditor') };
  await listener({ type: 'outline', outline });
  await tick();
  const open = await labels(clar.provider);
  assert.equal(open[2].collapsibleState, 2, 'the open file is expanded');
  assert.equal(open[2].description, '● 3/3 open · docs/clarifications');
  const live = await labels(clar.provider, (await clar.provider.getChildren())[2]);
  assert.deepEqual(live.map(i => [i.label, i.description]), [['Q01', '● Resend once after a timeout'], ['Q02', 'Duplicates after a day'], ['Q03', '● new · Describe the open question.']]);
  assert.equal(clar.revealed.at(-1)[0].item.id, 'CLR-003-Q03', 'what the editor shows is not selected in the side bar');
  assert.deepEqual(clar.revealed.at(-1)[1], { select: true, focus: false });

  const requirements = await labels(reqs.provider);
  assert.deepEqual(requirements.map(r => [r.label, r.description, r.iconPath.id]), [['REQ-012', 'Send messages · 2/6', 'circle-filled'], ['REQ-013', 'Manual retry · 1/6', 'circle-filled'], ['REQ_020', 'Read receipts · Ready', 'pass-filled']]);
  assert.deepEqual(requirements[1].command.arguments.map(String), [String(uri), 'req', 'REQ-013']);
  assert.equal(reqs.message, '3 requirements · 1 ready · 0 without a clarification · from requirements');
  assert.equal(reqs.description, 'CLR-003');
  prompts.pickLabel.push('Ready');
  await commands.get('repositoryManager.requirements.filterRequirements')();
  assert.deepEqual((await labels(reqs.provider)).map(r => r.label), ['REQ_020']);
  assert.equal(reqs.description, 'CLR-003 · Ready');
  prompts.pickLabel.push('All requirements');
  await commands.get('repositoryManager.requirements.filterRequirements')();
  assert.equal(status.shown, true);
  assert.equal(status.text, '$(checklist) 1/3 Ready · 2 unsaved');
  tabs.activeTab = undefined;
  tabs.listeners.forEach(l => l());
  assert.equal(status.shown, false, 'the status bar item stays when another tab is active');

  // A click in the side bar opens the file and shows that item or requirement.
  await commands.get('repositoryManager.requirements.reveal')(uri, 'req', 'REQ-013');
  assert.deepEqual(executed.at(-1).map(String), ['vscode.openWith', String(uri), 'repositoryManager.requirementEditor']);
  assert.deepEqual(posted.at(-1), { type: 'select', kind: 'req', id: 'REQ-013' });
  await commands.get('repositoryManager.requirements.newItem')(fileNodes[2]);
  assert.deepEqual(posted.at(-1), { type: 'command', name: 'addItem' });
  await commands.get('repositoryManager.requirements.changeSource')();
  assert.deepEqual(posted.at(-1), { type: 'command', name: 'sourceDialog' });
  // A file whose editor is not ready yet gets the selection with its first message.
  const other = fileUri(path.join(docs, 'CLR-002.md'));
  const pending = await editors.openCustomDocument(other, {});
  let pendingListener;
  const pendingPosts = [];
  await editors.resolveCustomEditor(pending, { ...panel, active: false, webview: { ...panel.webview, postMessage: async m => { pendingPosts.push(m); return true; }, onDidReceiveMessage: fn => { pendingListener = fn; } } });
  editors.select(other, { kind: 'item', id: 'CLR-002-Q02' });
  assert.equal(pendingPosts.length, 0);
  await pendingListener({ type: 'ready' });
  assert.deepEqual(pendingPosts.at(-1).select, { kind: 'item', id: 'CLR-002-Q02' });
  // Closing the open file redraws its row, back to the saved items.
  clar.redrawn.length = 0;
  document.dispose();
  pending.dispose();
  await tick();
  assert.ok(clar.redrawn.some(node => node && node.kind === 'file' && node.file.id === 'CLR-003'), 'the closed file\'s row was not redrawn');
  assert.equal((await labels(clar.provider))[2].description, '2/2 open · docs/clarifications');
  assert.deepEqual(await reqs.provider.getChildren(), []);
  await commands.get('repositoryManager.requirements.changeSource')();
  assert.match(infos.at(-1), /Open a clarification file first/);

  // New Clarification File: folder, ID (checked), title; written from the template and opened.
  prompts.input.push('clr-4');
  await commands.get('repositoryManager.requirements.newFile')();
  assert.match(prompts.lastValidation, /capital letters/);
  assert.deepEqual(prompts.quickPick.at(-1), ['docs/clarifications', 'Choose a folder…']);
  prompts.input.push('CLR-003');
  await commands.get('repositoryManager.requirements.newFile')();
  assert.equal(prompts.lastValidation, 'CLR-003.md already exists here.');
  prompts.input.push('CLR-004', 'Typing indicator');
  await commands.get('repositoryManager.requirements.newFile')();
  const created = path.join(docs, 'CLR-004.md');
  const text = fs.readFileSync(created, 'utf8');
  const parsed = parse(text);
  assert.deepEqual([parsed.id, parsed.version, parsed.items[0].id], ['CLR-004', 3, 'CLR-004-Q01']);
  assert.match(text, /^title: Typing indicator$/m);
  assert.ok(!text.includes('2026-10-27T09:00:00+07:00'), 'the template dates were kept');
  assert.deepEqual(executed.at(-1).map(String), ['vscode.openWith', `file://${created}`, 'repositoryManager.requirementEditor']);
  // From a row's menu, the new file goes beside that one.
  prompts.input.push('CLR-005', '');
  await commands.get('repositoryManager.requirements.newFile')(fileNodes[0]);
  assert.match(fs.readFileSync(path.join(docs, 'CLR-005.md'), 'utf8'), /^title: CLR-005$/m);
  await commands.get('repositoryManager.requirements.openAsText')(fileNodes[0]);
  assert.deepEqual(executed.at(-1).map(String), ['vscode.openWith', `file://${path.join(docs, 'CLR-001.md')}`, 'default']);
  console.log('Requirements view smoke test passed');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(() => fs.rmSync(workspace, { recursive: true, force: true }));
