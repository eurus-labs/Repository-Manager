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
const os = require('os');
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
const { RunStore } = require('../../out/studio/engine.js');
const { workflowHash } = require('../../out/studio/workflow.js');

const themes = {
  dark: ':root{--vscode-foreground:#cccccc;--vscode-editor-background:#1e1e1e;--vscode-sideBar-background:#252526;--vscode-input-background:#3c3c3c;--vscode-input-foreground:#cccccc;--vscode-button-background:#0e639c;--vscode-button-foreground:#ffffff;--vscode-button-secondaryBackground:#3a3d41;--vscode-button-secondaryForeground:#ffffff;--vscode-focusBorder:#007fd4;--vscode-errorForeground:#f48771;--vscode-editorWarning-foreground:#cca700;--vscode-descriptionForeground:#9d9d9d;--vscode-panel-border:#80808059;--vscode-editorWidget-background:#2d2d30;--vscode-textLink-foreground:#3794ff;--vscode-testing-iconPassed:#73c991}',
  light: ':root{--vscode-foreground:#3b3b3b;--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-input-background:#ffffff;--vscode-input-foreground:#3b3b3b;--vscode-input-border:#cecece;--vscode-button-background:#005fb8;--vscode-button-foreground:#ffffff;--vscode-button-secondaryBackground:#e5e5e5;--vscode-button-secondaryForeground:#3b3b3b;--vscode-focusBorder:#005fb8;--vscode-errorForeground:#a1260d;--vscode-editorWarning-foreground:#895503;--vscode-descriptionForeground:#717171;--vscode-panel-border:#e5e5e5;--vscode-editorWidget-background:#f3f3f3;--vscode-textLink-foreground:#005fb8;--vscode-testing-iconPassed:#388a34}'
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

  // `runs` is what the editor follows (a real RunStore, see the live-run case); `now` fixes the page's clock
  // (and its time zone and locale) so a run's elapsed time and start time read the same on every run.
  const open = async (text, { theme = 'dark', width = 1400, height = 820, runs, now } = {}) => {
    documentInEditor = new TextDocument(fileUri(path.join(root, 'flow.workflow.json')), text);
    const page = await browser.newPage({ viewport: { width, height }, ...(now ? { timezoneId: 'UTC', locale: 'en-GB' } : {}) });
    if (now) { await page.addInitScript(fixed => { Date.now = () => fixed; }, now); }
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
    await new WorkflowEditorProvider(fileUri(root), runs).resolveCustomTextEditor(documentInEditor, panel);
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
    // Each palette step says what it does (the description the chat's planner is given too).
    assert.match(await page.getAttribute('.palette .step[data-type="file.write"]', 'title'), /asks before it writes files\nWrites with\.content to a workspace file/);
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

    // ---- A run seen live in the diagram (plan 10). Real RunStore, real provider; the run is written the way
    // ---- the engine writes it, and the page's clock is fixed so the screenshots do not change between runs.
    const sampleText = fs.readFileSync(samplePath, 'utf8');
    const sample = JSON.parse(sampleText);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-editor-run-'));
    try {
      // A store per case: a run left waiting by one would be found by the next page that opens.
      let store = new RunStore(path.join(tmp, 'runs-1'));
      const stopCalls = [];
      const runs = { runs: async () => store, stop: id => { stopCalls.push(id); return true; } };
      const at = seconds => new Date(Date.UTC(2026, 10, 28, 10, 0, seconds)).toISOString();
      const nodeStates = states => Object.fromEntries(sample.nodes.map(node => [node.id, { status: states[node.id] ?? 'pending', ...(states[node.id] === 'failed' ? { error: 'boom' } : {}) }]));
      const begin = async (id, { status = 'running', states = {}, workflow = sample, hash = workflowHash(sampleText), startedAt = at(0), extra = {} } = {}) => {
        await store.save({ id, workflow: { id: sample.id, version: '1.0.0', title: sample.title, hash }, startedAt, updatedAt: startedAt, status, inputs: {}, approvals: {}, nodes: nodeStates(states), ...extra });
        await store.saveWorkflow(id, workflow);
        await store.log(id, { at: startedAt, type: 'start' });
      };
      const NOW = Date.UTC(2026, 10, 28, 10, 0, 42);
      // Dark: three steps done, the fourth running for 42 s, the last not started.
      await begin('live-1', { states: { 'read-new': 'done', 'read-old': 'done', compare: 'done' } });
      for (const [index, id] of ['read-new', 'read-old', 'compare'].entries()) {
        await store.log('live-1', { at: at(1 + index * 2), type: 'node', node: id });
        await store.log('live-1', { at: at(2 + index * 2), type: 'done', node: id });
      }
      await store.log('live-1', { at: at(0), type: 'node', node: 'analyze' });
      await store.log('live-1', { at: at(1), type: 'tool', node: 'analyze', name: 'read_file', ok: true, note: 'docs/requirements.md:1-80' });
      const live = await open(sampleText, { runs, now: NOW, width: 1760 });
      await live.locator('#run-banner:not([hidden])').waitFor();
      assert.match(await live.textContent('#run-banner .run-line'), /^Analyze requirement changes · Step 4 of 5 · started 10:00Running$/);
      assert.equal(await live.textContent('#run-activity'), 'read_file docs/requirements.md:1-80');
      assert.equal(await live.isVisible('#run-stop'), true);
      assert.equal(await live.isVisible('#run-open'), true);
      const words = () => live.locator('#nodes .node').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.node, [[...node.classList].filter(name => name.startsWith('run-')).join(' '), (node.querySelector('.run-word') || {}).textContent]])));
      assert.deepEqual(await words(), {
        'read-new': ['run-done', '✓ Done'], 'read-old': ['run-done', '✓ Done'], compare: ['run-done', '✓ Done'],
        analyze: ['run-running', '▶ Running · 0:42'], write: ['run-pending', '○ Not started']
      });
      assert.equal(await live.textContent('#run-status'), 'Analyze requirement changes: step 4 of 5, Analyze each change: running');
      assert.match(await live.getAttribute('.node[data-node="analyze"]', 'aria-label'), /, running$/);
      assert.match(await live.getAttribute('.node[data-node="write"]', 'aria-label'), /not started$/);
      await snap(live, '33-studio-editor-run-live');

      // The status line changes only when a step starts or ends: more activity does not touch it.
      await live.evaluate(() => { window.__announced = 0; new MutationObserver(() => { window.__announced++; }).observe(document.getElementById('run-status'), { childList: true, characterData: true, subtree: true }); });
      for (let i = 0; i < 3; i++) { await store.log('live-1', { at: at(3), type: 'tool', node: 'analyze', name: 'search', ok: true, note: `query ${i}` }); await new Promise(resolve => setTimeout(resolve, 300)); }
      await live.waitForFunction(() => document.getElementById('run-activity').textContent === 'search query 2');
      assert.equal(await live.evaluate(() => window.__announced), 0, 'the status line changed for an activity line');
      // A step ending and the next starting is announced once.
      await store.log('live-1', { at: at(9), type: 'done', node: 'analyze' });
      await store.log('live-1', { at: at(9), type: 'node', node: 'write' });
      await live.waitForFunction(() => document.querySelector('.node[data-node="write"]').classList.contains('run-running'));
      assert.equal(await live.evaluate(() => window.__announced), 1, 'the status line did not change once for a step change');
      assert.equal(await live.textContent('#run-status'), 'Analyze requirement changes: step 5 of 5, Write the analysis: running');
      // Editing during a run stays possible; the run keeps the copy it started with, and the banner says so.
      assert.match(await live.textContent('#run-edit'), /keep editing/);
      await commit(live, '#f-Title', 'Retitled while running');
      await live.waitForFunction(() => !document.getElementById('run-earlier').hidden);
      assert.match(await live.textContent('#run-earlier'), /^Running an earlier version of this file\.$/);
      assert.equal(await live.locator('.node[data-node="write"].run-running').count(), 1, 'the diagram lost the run after an edit');
      // Stop goes to the host with the run's id; Open in Runs asks for the view.
      await live.click('#run-stop');
      await until(() => stopCalls.length === 1, 'Stop');
      assert.deepEqual(stopCalls, ['live-1']);
      assert.equal(await live.textContent('#run-stop'), 'Stopping…');
      assert.equal(await live.isDisabled('#run-stop'), true);
      executed.length = 0;
      await live.click('#run-open');
      await until(() => executed.length === 1, 'Open in Runs');
      assert.deepEqual(executed[0], ['repositoryManager.studio.runs.focus']);
      // The run ends (stopped): no Stop, a Hide, and the final state stays.
      await store.log('live-1', { at: at(11), type: 'finish', status: 'stopped', reason: 'Cancelled' });
      await live.waitForFunction(() => document.getElementById('run-state').textContent === 'Stopped');
      assert.equal(await live.isVisible('#run-stop'), false);
      assert.equal(await live.locator('.node[data-node="write"].run-stopped').count(), 1);
      assert.match(await live.textContent('.node[data-node="write"] .run-word'), /^■ Stopped$/);
      await live.click('#run-hide');
      assert.equal(await live.isVisible('#run-banner'), false);
      assert.equal(await live.locator('#nodes .node[class*="run-"]').count(), 0, 'a hidden run left its marks on the diagram');
      await live.close();

      store = new RunStore(path.join(tmp, 'runs-2'));
      // Light, waiting at the step that writes: the word and the engine's lock both show.
      await begin('live-2', { status: 'waiting', startedAt: at(100), states: { 'read-new': 'done', 'read-old': 'done', compare: 'done', analyze: 'done' },
        extra: { waiting: { node: 'write', kind: 'effect', title: 'Write a file: write', effect: 'write', preview: 'x' } } });
      for (const [index, id] of ['read-new', 'read-old', 'compare', 'analyze'].entries()) {
        await store.log('live-2', { at: at(101 + index * 2), type: 'node', node: id });
        await store.log('live-2', { at: at(102 + index * 2), type: 'done', node: id });
      }
      await store.log('live-2', { at: at(110), type: 'waiting', node: 'write', kind: 'effect', effect: 'write' });
      const waiting = await open(sampleText, { theme: 'light', width: 1760, height: 820, runs, now: NOW });
      await waiting.locator('#run-banner:not([hidden])').waitFor();
      assert.match(await waiting.textContent('#run-banner .run-line'), /Step 5 of 5 · started 10:01Waiting for you$/);
      assert.equal(await waiting.isVisible('#run-stop'), false, 'Stop is offered while waiting at an approval');
      assert.equal(await waiting.textContent('.node[data-node="write"] .run-word'), '⏸ Waiting for you');
      assert.equal(await waiting.textContent('.node[data-node="write"] .lock'), '🔒 asks before it writes files');
      await snap(waiting, '34-studio-editor-run-live-light');
      await waiting.close();

      // An earlier version of the file, a step the file no longer has, and a failed step with its error.
      store = new RunStore(path.join(tmp, 'runs-3'));
      const older = { ...sample, nodes: [...sample.nodes, { id: 'gone', type: 'gate', title: 'Old check', with: { title: 'ok?' } }], edges: [...sample.edges, { from: 'write', to: 'gone' }] };
      // The page is open before the run starts: it is followed from its log, and it ends failed.
      const earlier = await open(sampleText, { runs, now: NOW });
      await begin('live-3', { status: 'failed', workflow: older, hash: 'an-older-hash', startedAt: at(200), states: { 'read-new': 'done', 'read-old': 'failed' }, extra: { error: 'read-old: boom' } });
      await store.log('live-3', { at: at(201), type: 'node', node: 'read-new' });
      await store.log('live-3', { at: at(202), type: 'done', node: 'read-new' });
      await store.log('live-3', { at: at(203), type: 'node', node: 'read-old' });
      await store.log('live-3', { at: at(204), type: 'finish', status: 'failed', node: 'read-old', error: 'boom' });
      await earlier.locator('#run-banner:not([hidden])').waitFor();
      await earlier.waitForFunction(() => document.getElementById('run-state').textContent === 'Failed');
      assert.match(await earlier.textContent('#run-earlier'), /This was an earlier version of this file\. Steps no longer in the file: Old check \(gone\) — not started\./);
      assert.equal(await earlier.textContent('.node[data-node="read-old"] .run-title'), 'Failed: boom');
      assert.equal(await earlier.locator('#nodes .node[data-node="gone"]').count(), 0, 'a step the file no longer has was drawn');
      assert.equal(await earlier.textContent('.node[data-node="read-new"] .run-word'), '✓ Done');
      await earlier.click('.node[data-node="read-old"]');
      await earlier.locator('#run-note .error-text').waitFor();
      assert.equal(await earlier.textContent('#run-note .error-text'), 'boom');
      assert.match(await earlier.textContent('#run-note .run-state'), /Failed/);
      await earlier.close();

      // The elapsed time ticks on the page, with the real clock.
      store = new RunStore(path.join(tmp, 'runs-4'));
      const since = new Date(Date.now() - 3000).toISOString();
      await begin('live-4', { startedAt: since });
      await store.log('live-4', { at: since, type: 'node', node: 'read-new' });
      const ticking = await open(sampleText, { runs });
      await ticking.locator('.node[data-node="read-new"] .tick').waitFor();
      const first = await ticking.textContent('.tick');
      await ticking.waitForFunction(text => document.querySelector('.tick').textContent !== text, first, { timeout: 4000 });
      await ticking.close();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }

    assert.deepEqual(errors, []);
    console.log('Studio editor UI test passed; screenshots in ui-snapshots/30-34');
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch(error => { console.error(error); process.exit(1); });
