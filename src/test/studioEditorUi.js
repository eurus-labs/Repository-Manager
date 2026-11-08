// Drives the Studio's visual editor (resources/studioEditor.js, under its real Content Security
// Policy) in headless Chromium against the real WorkflowEditorProvider, through a fake `vscode`
// whose text document applies WorkspaceEdits and announces changes, as VS Code does. Checks the
// round trip page → document → page, and writes screenshots to ui-snapshots/.
// Run with `npm run test:ui`; set PLAYWRIGHT_CHROMIUM_PATH if Chromium is elsewhere.
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const path = require('path');
const Module = require('module');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const outputDir = path.join(root, 'ui-snapshots');
const samplePath = path.join(root, 'resources', 'studio', 'samples', 'analyze-requirements.workflow.json');

// --- the fake `vscode`: a text document, WorkspaceEdit, and the commands the page calls -------------
const changeListeners = [];
const executed = [];
const fileUri = fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` });
class TextDocument {
  constructor(uri, text) { this.uri = uri; this.text = text; this.isDirty = false; }
  getText() { return this.text; }
  get lineCount() { return this.text.split('\n').length; }
  async save() { if (fakeVscode.saveFails) { return false; } this.isDirty = false; return true; }
}
let documentInEditor;
const fakeVscode = {
  Uri: { file: fileUri, joinPath: (base, ...parts) => fileUri(path.join(base.fsPath, ...parts)) },
  Range: class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } },
  WorkspaceEdit: class { constructor() { this.edits = []; } replace(uri, range, text) { this.edits.push({ uri, range, text }); } },
  workspace: {
    onDidChangeTextDocument: listener => { changeListeners.push(listener); return { dispose() {} }; },
    // The editor replaces the whole text; that is all this fake needs to apply.
    applyEdit: async edit => {
      // A slow apply, as VS Code's can be: a second edit sent meanwhile must not start from the old text.
      if (fakeVscode.slowEdits) { await new Promise(resolve => setTimeout(resolve, 150)); }
      for (const change of edit.edits) {
        assert.equal(change.range.start.line, 0);
        assert.ok(change.range.end.line >= documentInEditor.lineCount - 1, 'the edit does not cover the document');
        documentInEditor.text = change.text;
        documentInEditor.isDirty = true;
      }
      changeListeners.forEach(listener => listener({ document: documentInEditor }));
      return true;
    }
  },
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

const themes = {
  dark: ':root{--vscode-foreground:#cccccc;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#cccccc;--vscode-button-background:#0e639c;--vscode-button-foreground:#ffffff;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ffffff;--vscode-focusBorder:#007fd4;--vscode-errorForeground:#f48771;--vscode-editorWarning-foreground:#cca700;--vscode-descriptionForeground:#9d9d9d;--vscode-panel-border:#80808059;--vscode-editorWidget-background:#2d2d30;--vscode-textLink-foreground:#3794ff}',
  light: ':root{--vscode-foreground:#3b3b3b;--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;--vscode-button-background:#005fb8;--vscode-button-foreground:#ffffff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-focusBorder:#005fb8;--vscode-errorForeground:#a1260d;--vscode-editorWarning-foreground:#895503;--vscode-descriptionForeground:#717171;--vscode-panel-border:#e5e5e5;--vscode-editorWidget-background:#f3f3f3;--vscode-textLink-foreground:#005fb8}'
};

async function main() {
  const pages = new Map();
  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (pages.has(url)) { res.setHeader('content-type', 'text/html'); return res.end(pages.get(url)); }
    if (url.startsWith('/theme-')) { res.setHeader('content-type', 'text/css'); return res.end(themes[url.includes('light') ? 'light' : 'dark']); }
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
  const errors = [];
  fs.mkdirSync(outputDir, { recursive: true });
  const snap = (page, name) => page.screenshot({ path: path.join(outputDir, `${name}.png`), animations: 'disabled', caret: 'hide' });

  const open = async (text, { theme = 'dark', width = 1400, height = 820 } = {}) => {
    documentInEditor = new TextDocument(fileUri(path.join(root, 'flow.workflow.json')), text);
    const page = await browser.newPage({ viewport: { width, height } });
    let listener;
    const panel = {
      onDidDispose() {},
      webview: {
        options: {}, html: '', cspSource: origin,
        asWebviewUri: uri => ({ toString: () => `${origin}/resources/${path.basename(uri.fsPath)}` }),
        postMessage: message => page.evaluate(data => window.postMessage(data, '*'), message).catch(() => undefined),
        onDidReceiveMessage: fn => { listener = fn; }
      }
    };
    page.on('pageerror', error => errors.push(`page: ${error.message}`));
    page.on('console', message => { if (/Content Security Policy|Refused/.test(message.text())) errors.push(`csp: ${message.text()}`); });
    await page.exposeFunction('__postToHost', message => listener(message));
    await page.addInitScript(() => {
      let state = null;
      window.acquireVsCodeApi = () => ({ getState: () => state, setState: value => { state = value; }, postMessage: message => window.__postToHost(message) });
    });
    await new WorkflowEditorProvider(fileUri(root)).resolveCustomTextEditor(documentInEditor, panel);
    const route = `/editor-${pages.size + 1}`;
    pages.set(route, panel.webview.html.replace('</head>', `<link rel="stylesheet" href="${origin}/theme-${theme}.css"></head>`));
    await page.goto(origin + route);
    await page.waitForFunction(() => document.getElementById('title').textContent !== 'Opening…');
    return page;
  };
  const doc = () => JSON.parse(documentInEditor.getText());
  const until = async (check, what) => {
    for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
    assert.fail(`timed out waiting for ${what}`);
  };
  const commit = async (page, selector, value) => {
    await page.fill(selector, value);
    await page.locator(selector).evaluate(input => input.dispatchEvent(new Event('change')));
  };

  try {
    const page = await open(fs.readFileSync(samplePath, 'utf8'));
    // The diagram: one box per step, the engine's gate drawn on the step that writes, and the
    // workflow's own fields, inputs, prompts and types beside it.
    assert.equal(await page.textContent('#title'), 'Analyze requirement changes');
    assert.equal(await page.textContent('#subtitle'), 'analyze-requirements · 1.0.0 · 5 steps');
    assert.deepEqual(await page.locator('#nodes .node').evaluateAll(nodes => nodes.map(node => node.dataset.node)), ['read-new', 'read-old', 'compare', 'analyze', 'write']);
    assert.equal(await page.locator('#edges .edge').count(), 4);
    assert.equal(await page.textContent('.node[data-node="write"] .lock'), '🔒 asks before it writes files');
    assert.equal(await page.locator('.node[data-node="compare"] .lock').count(), 0);
    assert.equal(await page.textContent('.node[data-node="analyze"] .model'), 'AI');
    // A condition shows as much as fits between the boxes, and all of it on hover.
    assert.equal(await page.textContent('#edges .edge title'), 'Only when ${compare.output.changes}');
    assert.match(await page.textContent('#edges .when'), /^\$\{comp.*…$/);
    assert.equal(await page.textContent('#problems'), 'None');
    assert.match(await page.textContent('.effects'), /Sends to the Copilot model: analyze/);
    assert.equal(await page.isDisabled('#run'), false);
    await snap(page, '30-studio-editor');

    // Select a step, rename it: the document's edges and references follow, and the page redraws.
    await page.click('.node[data-node="compare"]');
    await page.locator('#panel h2', { hasText: 'Match them by ID' }).waitFor();
    await commit(page, '#f-ID', 'match');
    await until(() => doc().nodes.some(node => node.id === 'match'), 'the rename');
    assert.equal(doc().edges[2].when, '${match.output.changes}');
    await page.locator('.node[data-node="match"].selected').waitFor();
    assert.equal(documentInEditor.isDirty, true, 'the edit did not go through the document');
    // A setting of the selected step, and a condition on its edge.
    await commit(page, '#f-edge-2-when', '${match.output.counts.changed} > 0');
    await until(() => doc().edges[2].when === '${match.output.counts.changed} > 0', 'the condition');
    await page.waitForFunction(() => [...document.querySelectorAll('#edges .edge title')].some(tip => tip.textContent.endsWith('> 0')));

    // Two edits sent quickly while the first is still being applied: both land.
    fakeVscode.slowEdits = true;
    await page.evaluate(() => {
      window.__postToHost({ type: 'edit', operation: { op: 'setWorkflow', field: 'title', value: 'First' } });
      window.__postToHost({ type: 'edit', operation: { op: 'setWorkflow', field: 'version', value: '1.1.0' } });
    });
    await until(() => doc().version === '1.1.0', 'the second edit');
    assert.deepEqual([doc().title, doc().version], ['First', '1.1.0'], 'an edit was lost');
    fakeVscode.slowEdits = false;

    // A change made in the JSON editor shows on the page too.
    const changed = doc();
    changed.title = 'Edited as JSON';
    documentInEditor.text = JSON.stringify(changed, null, 2);
    changeListeners.forEach(listener => listener({ document: documentInEditor }));
    await page.locator('#title', { hasText: 'Edited as JSON' }).waitFor();

    // Add a step from the palette: it is placed, its required settings are there, and the problems
    // it brings (empty settings are fine; a missing edge is not needed) are listed on it.
    await page.click('#panel button:has-text("Back to workflow")');
    await page.click('.palette .step[data-type="gate"]');
    await until(() => doc().nodes.some(node => node.id === 'gate-1'), 'the new step');
    await page.locator('.node[data-node="gate-1"]').waitFor();
    assert.deepEqual(doc().nodes.find(node => node.id === 'gate-1').with, { title: '' });
    // Connect it after "write", then show a broken reference as a problem on its node.
    await page.click('.node[data-node="write"]');
    await page.selectOption('#panel .adder select', 'gate-1');
    await page.click('#panel button:has-text("Add next step")');
    await until(() => (doc().edges || []).some(edge => edge.from === 'write' && edge.to === 'gate-1'), 'the edge');
    await page.click('.node[data-node="gate-1"]');
    await commit(page, '#f-setting-title', 'Check ${nowhere.output}');
    await page.locator('.node[data-node="gate-1"].invalid').waitFor();
    assert.match(await page.textContent('#problems'), /"\$\{nowhere\.output\}": no node "nowhere"/);
    assert.equal(await page.isDisabled('#run'), true, 'Run is offered with problems');
    await snap(page, '31-studio-editor-problem');
    await commit(page, '#f-setting-title', 'Looks right?');
    await page.locator('.node[data-node="gate-1"]:not(.invalid)').waitFor();

    // Drag a step: only its new place is written.
    const box = await page.locator('.node[data-node="gate-1"] rect').boundingBox();
    const before = doc().layout['gate-1'];
    await page.mouse.move(box.x + 20, box.y + 20);
    await page.mouse.down();
    await page.mouse.move(box.x + 80, box.y + 120, { steps: 5 });
    await page.mouse.up();
    await until(() => doc().layout['gate-1'][1] > before[1] + 50, 'the move');

    // Bad input is said, and the document is left alone.
    await page.click('#panel button:has-text("Back to workflow")');
    const kept = documentInEditor.getText();
    await commit(page, '#f-type-ChangeAnalysis', '{ not json');
    await page.locator('#notice', { hasText: 'The schema is not valid JSON.' }).waitFor();
    assert.equal(documentInEditor.getText(), kept);

    // Delete from the keyboard; Open as JSON and Run go to VS Code.
    await page.focus('.node[data-node="gate-1"]');
    await page.keyboard.press('Delete');
    await until(() => !doc().nodes.some(node => node.id === 'gate-1'), 'the delete');
    assert.equal((doc().edges || []).some(edge => edge.to === 'gate-1'), false);
    // A save that fails (or is cancelled) does not run the older file on disk.
    fakeVscode.saveFails = true;
    await page.click('#run');
    await page.locator('#notice', { hasText: 'The workflow was not saved, so it was not run.' }).waitFor();
    assert.equal(executed.length, 0);
    fakeVscode.saveFails = false;
    await page.click('#json');
    await page.click('#run');
    await until(() => executed.length >= 2, 'the commands');
    assert.deepEqual(executed.map(([command, , view]) => [command, view]), [['vscode.openWith', 'default'], ['repositoryManager.studio.runWorkflow', undefined]]);
    assert.equal(documentInEditor.isDirty, false, 'Run did not save first');
    await page.close();

    // A file that is not JSON: said, nothing to edit, Open as JSON still there.
    const brokenPage = await open('{ "schema": ', { theme: 'light', width: 900, height: 700 });
    assert.match(await brokenPage.textContent('#notice'), /^The file is not valid JSON/);
    assert.equal(await brokenPage.locator('#nodes .node').count(), 0);
    assert.equal(await brokenPage.isDisabled('#json'), false);
    await brokenPage.close();

    // Light theme, narrow: the columns stack.
    const narrow = await open(fs.readFileSync(samplePath, 'utf8'), { theme: 'light', width: 820, height: 1100 });
    await snap(narrow, '32-studio-editor-light-narrow');
    const columns = await narrow.evaluate(() => getComputedStyle(document.querySelector('.layout')).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 1);
    await narrow.close();

    assert.deepEqual(errors, []);
    console.log('Studio editor UI test passed; screenshots in ui-snapshots/30-32');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
