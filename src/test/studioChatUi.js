// Drives the Studio Chat (resources/studioChat.js, under its real Content Security Policy) in
// headless Chromium against the real StudioChatProvider, through a fake `vscode` whose vscode.lm
// answers from a script. Checks goal → plan card → per-step model → proposed change → accept → Run,
// and writes screenshots to ui-snapshots/.
// Run with `npm run test:ui`; set PLAYWRIGHT_CHROMIUM_PATH if Chromium is elsewhere.
const assert = require('assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const Module = require('module');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const outputDir = path.join(root, 'ui-snapshots');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-studio-chat-ui-'));
const workspace = path.join(base, 'workspace');
fs.mkdirSync(workspace, { recursive: true });

// --- the fake `vscode` ------------------------------------------------------------------------------
const replies = [];
const prompts = [];
const fileUri = fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` });
const lmModel = (family, name) => ({
  id: `${family}-id`, name, vendor: 'copilot', family, version: '1', maxInputTokens: 200000,
  countTokens: async text => Math.ceil(text.length / 4),
  sendRequest: async messages => {
    prompts.push({ family, text: messages[0].text });
    // A reply takes a moment, so the page shows that it is drafting.
    await new Promise(resolve => setTimeout(resolve, 150));
    const reply = replies.shift();
    return { text: (async function* () { yield JSON.stringify(reply); })() };
  }
});
let viewProvider;
const fakeVscode = {
  Uri: { file: fileUri, joinPath: (uri, ...parts) => fileUri(path.join(uri.fsPath, ...parts)) },
  Range: class {}, WorkspaceEdit: class { replace() {} },
  CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() {} },
  LanguageModelChatMessage: { User: text => ({ text }) },
  lm: { selectChatModels: async () => [lmModel('gpt-4o', 'GPT-4o'), lmModel('claude-sonnet', 'Claude Sonnet')] },
  workspace: { textDocuments: [] },
  window: { registerWebviewViewProvider: (_id, provider) => { viewProvider = provider; return { dispose() {} }; }, showWarningMessage: async () => undefined },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { StudioChatProvider } = require('../../out/studio/studioChat.js');
const { stepRegistry } = require('../../out/studio/steps.js');
Module._load = originalLoad;

const plan = () => ({
  title: 'Summarize notes',
  criteria: ['notes/summary.md holds a summary of the text'],
  inputs: { text: { type: 'string', title: 'Text' } },
  types: { Summary: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
  prompts: { summarize: { instructions: 'Summarize the text.', output: 'Summary' } },
  nodes: [
    { id: 'summarize', type: 'prompt', title: 'Summarize', prompt: 'summarize', with: { input: '${inputs.text}' } },
    { id: 'write', type: 'file.write', title: 'Write the summary', with: { path: 'notes/summary.md', content: '${summarize.output.summary}' } }
  ],
  edges: [{ from: 'summarize', to: 'write' }]
});

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
  const memento = () => { const values = new Map(); return { get: key => values.get(key), update: async (key, value) => { values.set(key, value); } }; };

  const ran = [];
  const runs = {
    steps: stepRegistry(),
    run: async (workflow, _hash, onUpdate) => {
      ran.push(workflow);
      const state = { id: 'run-1', status: 'running', nodes: {}, criteria: workflow.criteria };
      onUpdate(state);
      await new Promise(resolve => setTimeout(resolve, 50));
      const done = { ...state, status: 'done', nodes: { write: { status: 'done', output: { path: 'notes/summary.md' } } } };
      onUpdate(done);
      return done;
    }
  };

  const open = async ({ theme = 'dark', width = 420, height = 900, folder = true } = {}) => {
    const context = {
      subscriptions: [], extensionUri: fileUri(root), storageUri: fileUri(path.join(base, `storage-${pages.size}`)),
      globalStorageUri: fileUri(path.join(base, 'global')), globalState: memento(), workspaceState: memento()
    };
    StudioChatProvider.register(context, folder ? runs : undefined, folder ? workspace : undefined);
    const page = await browser.newPage({ viewport: { width, height } });
    let listener;
    const view = {
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
      window.acquireVsCodeApi = () => ({ getState: () => null, setState: () => undefined, postMessage: message => window.__postToHost(message) });
    });
    viewProvider.resolveWebviewView(view);
    const route = `/chat-${pages.size + 1}`;
    pages.set(route, view.webview.html.replace('</head>', `<link rel="stylesheet" href="${origin}/theme-${theme}.css"></head>`));
    await page.goto(origin + route);
    await page.locator('.empty h2').waitFor();
    return page;
  };

  try {
    const page = await open();
    // The empty chat: what it does, the composer, the models this VS Code offers.
    assert.match(await page.textContent('.empty'), /proposes a plan of steps and what “done” means/);
    assert.deepEqual(await page.locator('#model option').evaluateAll(options => options.map(option => option.value)), ['', 'copilot:gpt-4o', 'copilot:claude-sonnet']);
    await snap(page, '40-studio-chat-empty');

    // A goal, typed and sent with Enter, drafted by the model picked in the composer.
    await page.selectOption('#model', 'copilot:claude-sonnet');
    replies.push({ reply: 'Here is a plan: summarize the text, then write it.', workflow: plan() });
    await page.fill('#message', 'Summarize the text I give into notes/summary.md');
    await page.press('#message', 'Enter');
    await page.locator('[data-testid="thinking"]').waitFor();
    assert.equal(await page.textContent('#send'), 'Stop');
    await page.locator('.card[data-card="current"]').waitFor();
    assert.equal(prompts[prompts.length - 1].family, 'claude-sonnet');
    assert.equal(await page.textContent('.message.user p'), 'Summarize the text I give into notes/summary.md');
    assert.equal(await page.inputValue('#message'), '');

    // The card: the AI's criteria (editable), the steps in run order with what each asks, Run.
    const card = page.locator('.card[data-card="current"]');
    assert.equal(await card.locator('.criteria input').inputValue(), 'notes/summary.md holds a summary of the text');
    assert.deepEqual(await card.locator('.step').evaluateAll(items => items.map(item => item.dataset.step)), ['summarize', 'write']);
    assert.equal(await card.locator('.step[data-step="write"] .badge.write').textContent(), 'writes · asks first');
    assert.equal(await card.locator('.step[data-step="write"] select').count(), 0, 'a step without a model has no model choice');
    assert.equal(await card.locator('button:has-text("Run")').isDisabled(), false);
    await snap(page, '41-studio-chat-plan');

    // A model for one step, and a criterion edited on the card.
    await card.locator('.step[data-step="summarize"] select').selectOption('copilot:gpt-4o');
    await page.waitForFunction(() => document.querySelector('.card[data-card="current"] .step[data-step="summarize"] select').value === 'copilot:gpt-4o');
    await card.locator('.criteria input').fill('The summary is at most 5 lines');
    await card.locator('.criteria input').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('.card[data-card="current"] .criteria input').value === 'The summary is at most 5 lines');

    // Remove every criterion: the plan cannot run, and says why.
    await card.locator('.criteria button.icon').click();
    await page.locator('.card[data-card="current"] .problems').waitFor();
    assert.equal(await page.locator('.card[data-card="current"] button:has-text("Run")').isDisabled(), true);
    await page.click('.card[data-card="current"] button.link');
    await page.locator('.card[data-card="current"] .problems').waitFor({ state: 'detached' });

    // A change that also drops the write step: shown as a diff, the plan untouched until Accept.
    const dropped = plan(); dropped.nodes = [dropped.nodes[0]]; dropped.edges = []; dropped.criteria = ['A summary exists'];
    replies.push({ reply: 'Shorter now.', workflow: dropped });
    await page.fill('#message', 'Make the summary shorter');
    await page.click('#send');
    const proposed = page.locator('.card[data-card="proposed"]');
    await proposed.waitFor();
    assert.match(await proposed.locator('[data-testid="diff"]').textContent(), /− write/);
    assert.equal(await proposed.locator('.step.removed').count(), 1);
    assert.match(prompts[prompts.length - 1].text, /"model":"copilot:gpt-4o"/, 'the change starts from the plan with its edits');
    await snap(page, '42-studio-chat-change');
    await proposed.locator('button:has-text("Discard")').click();
    await page.locator('.card[data-card="discarded"]').waitFor();
    assert.equal(await page.locator('.card[data-card="current"] .step').count(), 2, 'Discard kept the plan');

    // Accept a change that keeps the steps; then Run, and the run's card shows what to check.
    const kept = plan(); kept.criteria = ['The summary is at most 5 lines', 'It names the source text'];
    kept.nodes[0].model = 'copilot:gpt-4o';
    replies.push({ reply: 'Added a criterion.', workflow: kept });
    await page.fill('#message', 'It should also name the source');
    await page.click('#send');
    await page.locator('.card[data-card="proposed"] button:has-text("Accept change")').click();
    await page.waitForFunction(() => document.querySelectorAll('.card[data-card="current"] .criteria input').length === 2);
    await page.click('.card[data-card="current"] button:has-text("Run")');
    await page.locator('.card.run[data-run="done"]').waitFor();
    assert.equal(ran.length, 1);
    assert.deepEqual(ran[0].criteria, ['The summary is at most 5 lines', 'It names the source text']);
    assert.match(await page.textContent('.card.run'), /Wrote notes\/summary\.md/);
    assert.match(await page.textContent('.card.run'), /It names the source text/);
    await snap(page, '43-studio-chat-run');

    // Light theme, no folder: nothing to run or save, and the page says so.
    const lone = await open({ theme: 'light', folder: false });
    assert.match(await lone.textContent('.empty'), /Open a folder to run or save a plan/);
    replies.push({ reply: 'A plan.', workflow: plan() });
    await lone.fill('#message', 'Summarize');
    await lone.press('#message', 'Enter');
    await lone.locator('.card[data-card="current"]').waitFor();
    assert.equal(await lone.locator('.card[data-card="current"] button:has-text("Run")').isDisabled(), true);
    await snap(lone, '44-studio-chat-light');

    assert.deepEqual(errors, []);
    console.log('Studio chat UI test passed; screenshots in ui-snapshots/40-44');
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
