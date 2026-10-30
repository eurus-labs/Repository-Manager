// Drives the Requirement editor's real page (resources/requirements.js, under its real Content
// Security Policy) in headless Chromium against the real RequirementEditorProvider and a fixture
// repository, through a fake `vscode` that does what VS Code does for a custom editor: Save calls
// saveCustomDocument while the editor has unsaved edits, Revert calls revertCustomDocument, hot
// exit calls backupCustomDocument. Checks the user flows end to end and writes screenshots to
// ui-snapshots/. Run with `npm run test:ui`; set PLAYWRIGHT_CHROMIUM_PATH if Chromium is elsewhere.
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const fixtures = path.join(__dirname, 'fixtures', 'requirements');
const outputDir = path.join(root, 'ui-snapshots');

// --- the fake `vscode`: what the provider uses, with VS Code's custom-editor lifecycle ---------
class EventEmitter {
  constructor() { this.listeners = []; this.event = listener => { this.listeners.push(listener); return { dispose() {} }; }; }
  fire(value) { this.listeners.forEach(listener => listener(value)); }
  dispose() {}
}
const fileUri = fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` });
const host = {
  answers: [], // what modal questions answer, in order
  questions: [],
  saveTarget: undefined,
  opened: [],
  editors: [] // { document, dirty }
};
const editorOf = document => host.editors.find(e => e.document === document);
const active = () => host.editors.find(e => e.active);
const fakeVscode = {
  EventEmitter,
  Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)), parse: text => fileUri(decodeURIComponent(new URL(text).pathname)) },
  RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
  ViewColumn: { Beside: -2 },
  Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
  workspace: {
    // A real watcher on the file, like VS Code's.
    createFileSystemWatcher(pattern) {
      const change = new EventEmitter(), create = new EventEmitter();
      const watcher = fs.watch(pattern.base.fsPath, (_event, name) => { if (name === pattern.pattern) { change.fire(fileUri(path.join(pattern.base.fsPath, name))); } });
      return { onDidChange: change.event, onDidCreate: create.event, onDidDelete: () => ({ dispose() {} }), dispose: () => watcher.close() };
    }
  },
  window: {
    showWarningMessage: async (message, ...rest) => { host.questions.push(message); return rest.some(r => typeof r === 'string') ? host.answers.shift() : undefined; },
    showInformationMessage: async () => undefined,
    showSaveDialog: async () => host.saveTarget,
    showTextDocument: async (uri, options) => { host.opened.push({ file: uri.fsPath, line: options.selection.start.line }); },
    registerCustomEditorProvider: () => ({ dispose() {} })
  },
  commands: {
    executeCommand: async command => {
      const editor = active();
      if (command === 'workbench.action.files.save' && editor?.dirty) {
        try {
          await editor.provider.saveCustomDocument(editor.document);
          editor.dirty = false;
        } catch (error) {
          editor.lastSaveError = error.message; // VS Code shows it in a notification
        }
      } else if (command === 'workbench.action.files.revert' && editor) {
        await editor.provider.revertCustomDocument(editor.document);
        editor.dirty = false;
      }
    }
  }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') { return fakeVscode; }
  return originalLoad.call(this, request, parent, isMain);
};
const { RequirementEditorProvider } = require(path.join(root, 'out/requirements/requirementEditorProvider'));
Module._load = originalLoad;

const themes = {
  dark: `:root{--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;--vscode-editor-background:#1f1f1f;--vscode-foreground:#ccc;--vscode-editorWidget-background:#202020;--vscode-sideBar-background:#181818;--vscode-input-background:#313131;--vscode-input-border:#3c3c3c;--vscode-descriptionForeground:#9d9d9d;--vscode-button-background:#0078d4;--vscode-button-foreground:#fff;--vscode-panel-border:#2b2b2b;--vscode-focusBorder:#0078d4;--vscode-errorForeground:#f85149;--vscode-textLink-foreground:#4daafc;--vscode-editorWarning-foreground:#cca700;--vscode-testing-iconPassed:#73c991;--vscode-editor-inactiveSelectionBackground:#3a3d41}`,
  light: `:root{--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px;--vscode-editor-font-family:monospace;--vscode-editor-font-size:12px;--vscode-editor-background:#fff;--vscode-foreground:#3b3b3b;--vscode-editorWidget-background:#f8f8f8;--vscode-sideBar-background:#f8f8f8;--vscode-input-background:#fff;--vscode-input-border:#cecece;--vscode-descriptionForeground:#616161;--vscode-button-background:#005fb8;--vscode-button-foreground:#fff;--vscode-panel-border:#e5e5e5;--vscode-focusBorder:#005fb8;--vscode-errorForeground:#e51400;--vscode-textLink-foreground:#005fb8;--vscode-editorWarning-foreground:#bf8803;--vscode-testing-iconPassed:#388a34;--vscode-editor-inactiveSelectionBackground:#e5ebf1}`
};

function createRepository() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'requirement-editor-'));
  const repo = path.join(base, 'repo');
  const docs = path.join(repo, 'docs');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.mkdirSync(docs, { recursive: true });
  for (const name of ['CLR-001.md', 'CLR-003.md']) { fs.copyFileSync(path.join(fixtures, name), path.join(docs, name)); }
  fs.cpSync(path.join(fixtures, 'wireframes'), path.join(docs, 'wireframes'), { recursive: true });
  fs.cpSync(path.join(fixtures, 'requirements'), path.join(repo, 'requirements'), { recursive: true });
  return { base, repo, file: path.join(docs, 'CLR-003.md') };
}

async function main() {
  const { base, repo, file } = createRepository();
  const memory = new Map();
  const provider = new RequirementEditorProvider(fileUri(root), fileUri(path.join(base, 'storage')),
    { get: (key, fallback) => (memory.has(key) ? memory.get(key) : fallback), update: async (key, value) => { memory.set(key, value); } });
  provider.onDidChangeCustomDocument(({ document }) => { const editor = editorOf(document); if (editor) { editor.dirty = true; editor.changes = (editor.changes || 0) + 1; } });

  const pages = new Map(); // path -> html
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (pages.has(url)) { res.setHeader('content-type', 'text/html'); return res.end(pages.get(url)); }
    if (url === '/theme-dark.css' || url === '/theme-light.css') { res.setHeader('content-type', 'text/css'); return res.end(themes[url.includes('light') ? 'light' : 'dark']); }
    if (url.startsWith('/resources/')) {
      res.setHeader('content-type', url.endsWith('.css') ? 'text/css' : 'text/javascript');
      return res.end(fs.readFileSync(path.join(root, 'resources', path.basename(url))));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  const problems = [];
  fs.mkdirSync(outputDir, { recursive: true });

  /** Opens `target` the way VS Code opens a custom editor: openCustomDocument, then resolve. */
  let pageCount = 0;
  const open = async (target, { theme = 'dark', width = 1280, height = 900, backupId } = {}) => {
    const document = await provider.openCustomDocument(fileUri(target), { backupId });
    let listener;
    const page = await browser.newPage({ viewport: { width, height } });
    const panel = {
      active: true,
      reveal() {},
      onDidDispose() {},
      webview: {
        options: {}, html: '', cspSource: origin,
        asWebviewUri: uri => `${origin}/resources/${path.basename(uri.fsPath)}`,
        postMessage: message => page.evaluate(data => window.postMessage(data, '*'), message).catch(() => undefined),
        onDidReceiveMessage: fn => { listener = fn; }
      }
    };
    host.editors.forEach(e => { e.active = false; });
    const editor = { document, provider, dirty: false, active: true, page };
    host.editors.push(editor);
    page.on('pageerror', error => problems.push(`page: ${error.message}`));
    page.on('console', message => { if (/Content Security Policy|Refused/.test(message.text())) { problems.push(`csp: ${message.text()}`); } });
    await page.exposeFunction('__postToHost', message => listener(message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ getState() { return null; }, setState() {}, postMessage(message) { window.__postToHost(message); } }); });
    await provider.resolveCustomEditor(document, panel);
    const route = `/editor-${++pageCount}`;
    pages.set(route, panel.webview.html.replace('</head>', `<link rel="stylesheet" href="${origin}/theme-${theme}.css"></head>`));
    await page.goto(origin + route);
    await page.waitForFunction(() => document.getElementById('message').textContent !== ''); // loaded, or why not
    return editor;
  };
  const snap = (page, name) => page.screenshot({ path: path.join(outputDir, `${name}.png`), animations: 'disabled', caret: 'hide' });
  const read = () => fs.readFileSync(file, 'utf8');
  const until = async (check, what) => {
    for (let i = 0; i < 200; i++) { if (await check()) { return; } await new Promise(r => setTimeout(r, 25)); }
    assert.fail(`timed out waiting for ${what}`);
  };

  try {
    // Opening: the form, both items, and the wireframe previewed from the repository (blob: under the CSP).
    const editor = await open(file);
    const page = editor.page;
    assert.equal(await page.textContent('#filename'), 'CLR-003 · CLR-003.md · schema v3');
    assert.equal(await page.locator('section[data-item]').count(), 2);
    await page.locator('#CLR-003-Q01 figure.aid img').waitFor();
    assert.ok(await page.$eval('#CLR-003-Q01 figure.aid img', img => img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0), 'the wireframe did not load');
    await snap(page, '20-requirement-editor-items');

    // An edit marks the editor unsaved in VS Code; Save writes that field and Updated at, nothing else.
    const before = read();
    assert.equal(await page.locator('#CLR-003-Q01 label', { hasText: 'Approach' }).count(), 1);
    await page.locator('#CLR-003-Q01 .field', { has: page.locator('label', { hasText: /^Approach$/ }) }).locator('textarea').fill('Retry with the same idempotency key. 😀');
    await until(() => editor.dirty, 'the unsaved state');
    assert.equal(await page.textContent('#state'), '● Unsaved changes');
    // Every edit reaches VS Code, not only the first, so a hot-exit backup follows the latest text.
    const changes = editor.changes;
    await page.locator('#CLR-003-Q01 .field', { has: page.locator('label', { hasText: /^Approach$/ }) }).locator('textarea').type(' ok');
    await page.locator('#CLR-003-Q01 .field', { has: page.locator('label', { hasText: /^Approach$/ }) }).locator('textarea').fill('Retry with the same idempotency key. 😀');
    await until(() => editor.changes >= changes + 3, 'a change event for each edit');
    await page.click('#save');
    await until(() => !editor.dirty && read() !== before, 'the save');
    await page.locator('#message', { hasText: 'Saved to Markdown.' }).waitFor();
    const saved = read();
    const { parse } = require(path.join(root, 'out/requirements/douDocument'));
    const [old1, new1] = [parse(before).items, parse(saved).items];
    assert.equal(new1[0].values.Approach, 'Retry with the same idempotency key. 😀');
    assert.notEqual(new1[0].values['Updated at'], old1[0].values['Updated at']);
    assert.deepEqual(new1[1].values, old1[1].values, 'the other item changed');
    for (const label of Object.keys(old1[0].values).filter(k => k !== 'Approach' && k !== 'Updated at')) { assert.equal(new1[0].values[label], old1[0].values[label], label); }
    assert.equal(saved.slice(0, 40), before.slice(0, 40), 'front matter rewritten');

    // Typing while the file is being written: the save keeps what was captured, and the later
    // edit stays in the form as an unsaved edit instead of being lost to the reload.
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const service = editor.document.service, realSave = service.save.bind(service);
    let writing = false;
    service.save = async (...args) => { writing = true; await gate; return realSave(...args); };
    const desired = page.locator('#CLR-003-Q01 .field', { has: page.locator('label', { hasText: /^Desired outcome$/ }) }).locator('textarea');
    await desired.fill('Saved part.');
    await until(() => editor.dirty, 'the unsaved state');
    await page.click('#save');
    await until(() => writing, 'the save to start writing');
    await desired.fill('Saved part. Typed while saving.');
    release();
    await page.locator('#message', { hasText: '1 field edited while saving is kept' }).waitFor();
    service.save = realSave;
    assert.ok(read().includes('Saved part.') && !read().includes('Typed while saving.'));
    assert.equal(await desired.inputValue(), 'Saved part. Typed while saving.');
    await until(() => editor.dirty, 'the later edit to count as unsaved');
    await page.click('#save');
    await until(() => read().includes('Typed while saving.') && !editor.dirty, 'the later edit to be saved');

    // Submit: a response joins History and the file is saved at once.
    const composer = page.locator('#CLR-003-Q01 form.composer');
    await composer.locator('input[aria-label="Author"]').fill('Minh');
    await composer.locator('textarea').fill('Checked with the API owner.');
    await composer.locator('button[type=submit]').click();
    await until(() => read().includes('Checked with the API owner.'), 'the submitted response');
    assert.equal(memory.get('repositoryManager.requirementEditor.memory').author, 'Minh', 'the name is not remembered');
    await page.locator('#state', { hasText: 'All changes saved' }).waitFor();

    // Requirements: set a folder source, see Ready reasons, open a requirement's file at its line.
    await page.click('#tab-reqs');
    await page.click('#source-card button:has-text("Set source…")');
    await page.click('dialog input[value=folder]');
    await page.fill('dialog .field:has-text("Folder") input >> nth=-1', 'requirements');
    await page.click('dialog button:has-text("Save and sync")');
    await page.locator('#req-REQ-012 .req-title', { hasText: 'Send messages' }).waitFor();
    assert.equal(JSON.parse(fs.readFileSync(path.join(repo, '.dou-editor.json'), 'utf8')).requirements.folder, 'requirements');
    assert.equal(await page.textContent('#req-REQ-012 .badge.ready'), 'Not ready');
    await page.click('#req-REQ-012 .req-meta button.link');
    await until(() => host.opened.length, 'the requirement file');
    assert.deepEqual(host.opened[0], { file: path.join(repo, 'requirements', 'messaging.rst'), line: 3 }); // REQ-012 is on line 4; Range is 0-based
    await snap(page, '21-requirement-editor-requirements');

    // + Create dou item: a new item for the requirement, saved like any edit.
    await page.click('#req-REQ-013 button.create');
    await page.locator('#CLR-003-Q03').waitFor();
    await until(() => editor.dirty, 'the new item to mark the editor unsaved');
    await page.keyboard.press('Control+s'); // VS Code's keybinding, not the page's
    await fakeVscode.commands.executeCommand('workbench.action.files.save');
    await until(() => read().includes('### CLR-003-Q03'), 'the new item');
    assert.equal(parse(read()).items[2].values.Requirement, 'REQ-013');
    await page.locator('#state', { hasText: 'All changes saved' }).waitFor(); // the reload after saving

    // Markdown view: an invalid edit keeps you there with the reason.
    await page.keyboard.press('Alt+3');
    await page.locator('#raw:not([hidden])').waitFor();
    await page.fill('#source', (await page.inputValue('#source')).replace('**Status**', '**Statue**'));
    await page.keyboard.press('Alt+1');
    await page.locator('#message.error', { hasText: 'Fix the Markdown before leaving source mode' }).waitFor();
    assert.equal(await page.isVisible('#raw'), true);
    await page.fill('#source', (await page.inputValue('#source')).replace('**Statue**', '**Status**'));
    await page.keyboard.press('Alt+1');
    await page.locator('#form:not([hidden])').waitFor();

    // Someone else changes the file while there are unsaved edits: Save is refused, edits stay.
    await page.locator('#CLR-003-Q02 .field', { has: page.locator('label', { hasText: /^Approach$/ }) }).locator('textarea').fill('My local edit');
    await until(() => editor.dirty, 'the unsaved state');
    fs.writeFileSync(file, read().replace('Minh', 'Minh (edited elsewhere)'));
    await page.locator('#message.error', { hasText: 'changed on disk' }).waitFor();
    await page.click('#save');
    await page.locator('#message.error', { hasText: 'File changed externally' }).waitFor();
    assert.ok(editor.dirty && /File changed externally/.test(editor.lastSaveError), 'VS Code was not told the save failed');
    assert.ok(read().includes('edited elsewhere') && !read().includes('My local edit'));
    assert.equal(await page.locator('#CLR-003-Q02 textarea').evaluateAll(areas => areas.some(a => a.value === 'My local edit')), true, 'the draft was lost');

    // Download draft writes the page's text where the user picks; Reload asks, then reverts.
    host.saveTarget = fileUri(path.join(base, 'CLR-003.draft.md'));
    await page.click('#download');
    await until(() => fs.existsSync(host.saveTarget.fsPath), 'the draft download');
    assert.ok(fs.readFileSync(host.saveTarget.fsPath, 'utf8').includes('My local edit'));
    host.answers.push('Discard and Reload');
    await page.click('#reload');
    await page.locator('#message', { hasText: 'Reloaded from disk.' }).waitFor();
    assert.equal(host.questions.pop(), 'Discard unsaved edits and reload the Markdown file?');
    assert.equal(editor.dirty, false);
    assert.ok((await page.locator('#CLR-003-Q01 .timeline').textContent()).includes('Minh (edited elsewhere)'));

    // A change on disk while there are no unsaved edits just reloads.
    fs.writeFileSync(file, read().replace('Checked with the API owner.', 'Confirmed by the API owner.'));
    await page.locator('#CLR-003-Q01 .timeline', { hasText: 'Confirmed by the API owner.' }).waitFor();

    // Hot exit: VS Code backs up the unsaved text; a new window restores it over the file.
    await page.locator('#CLR-003-Q02 .field', { has: page.locator('label', { hasText: /^Approach$/ }) }).locator('textarea').fill('Kept across a restart');
    await until(() => editor.dirty, 'the unsaved state');
    const destination = fileUri(path.join(base, 'backups', 'clr-003'));
    const backup = await provider.backupCustomDocument(editor.document, { destination });
    await page.close();
    const restored = await open(file, { backupId: backup.id, theme: 'light' });
    await restored.page.locator('#message', { hasText: 'Restored unsaved edits' }).waitFor();
    assert.equal(await restored.page.locator('#CLR-003-Q02 textarea').evaluateAll(areas => areas.some(a => a.value === 'Kept across a restart')), true);
    await until(() => restored.dirty, 'the restored edits to count as unsaved');
    assert.ok(!read().includes('Kept across a restart'), 'restoring wrote the file');
    await snap(restored.page, '22-requirement-editor-light-restored');

    // The file changed while VS Code was closed: the restored edits belong to the old version, so
    // Save is refused instead of overwriting what was written meanwhile.
    const second = await provider.backupCustomDocument(restored.document, { destination: fileUri(path.join(base, 'backups', 'clr-003-b')) });
    await restored.page.close();
    fs.writeFileSync(file, read().replace('Confirmed by the API owner.', 'Changed while VS Code was closed.'));
    const stale = await open(file, { backupId: second.id });
    await stale.page.locator('#message.error', { hasText: 'changed on disk since' }).waitFor();
    await until(() => stale.dirty, 'the restored edits to count as unsaved');
    await stale.page.click('#save');
    await stale.page.locator('#message.error', { hasText: 'File changed externally' }).waitFor();
    assert.ok(read().includes('Changed while VS Code was closed.') && !read().includes('Kept across a restart'), 'the stale draft overwrote the file');
    await stale.page.close();

    // A v1 file at phone width: the form fits, nothing scrolls sideways.
    const narrow = await open(path.join(repo, 'docs', 'CLR-001.md'), { width: 390, height: 844 });
    assert.equal(await narrow.page.textContent('#filename'), 'CLR-001 · CLR-001.md · schema v1');
    assert.equal(await narrow.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'the page scrolls horizontally');
    await snap(narrow.page, '23-requirement-editor-narrow');
    await narrow.page.close();

    // A file that does not validate says why instead of showing a form.
    const broken = path.join(repo, 'docs', 'CLR-009.md');
    fs.writeFileSync(broken, read().replaceAll('CLR-003', 'CLR-009').replace('**Scope**', '**Scope note**'));
    const invalid = await open(broken);
    await invalid.page.locator('#message.error', { hasText: 'CLR-009-Q01: require fields in order' }).waitFor();
    await invalid.page.close();

    assert.deepEqual(problems, []);
    console.log('Requirement editor UI test passed; screenshots in ui-snapshots/20-23');
  } finally {
    await browser.close();
    server.close();
    host.editors.forEach(e => e.document.dispose());
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
