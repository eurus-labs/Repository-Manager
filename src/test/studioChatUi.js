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
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '../..');
const outputDir = path.join(root, 'ui-snapshots');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-studio-chat-ui-'));
const workspace = path.join(base, 'workspace');
fs.mkdirSync(workspace, { recursive: true });
// The repository's scripts: the only checks a code step may name.
fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ scripts: { test: 'node test.js' } }));

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
const quickPicks = [];
const openAnswers = [];
const fakeVscode = {
  Uri: { file: fileUri, joinPath: (uri, ...parts) => fileUri(path.join(uri.fsPath, ...parts)) },
  Range: class {}, WorkspaceEdit: class { replace() {} },
  CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false }; } cancel() { this.token.isCancellationRequested = true; } dispose() {} },
  LanguageModelChatMessage: { User: text => ({ text }) },
  lm: { selectChatModels: async () => [lmModel('gpt-4o', 'GPT-4o'), lmModel('claude-sonnet', 'Claude Sonnet')] },
  workspace: { textDocuments: [] },
  window: {
    registerWebviewViewProvider: (_id, provider) => { viewProvider = provider; return { dispose() {} }; }, showWarningMessage: async () => undefined,
    showQuickPick: async items => { quickPicks.push(items); return items[0]; },
    showOpenDialog: async () => openAnswers.shift()
  },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { StudioChatProvider } = require('../../out/studio/studioChat.js');
const { studioSteps } = require('../../out/studio/registry.js');
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
  const commit = 'c'.repeat(40);
  const skillRefOf = name => `github:acme/skills/plugins/testing/skills/${name}@${commit}`;
  const skillList = [
    { ref: skillRefOf('write-tests'), name: 'write-tests', description: 'Tests first.', usesScripts: true },
    // Plan 6, Decision 10: scripts that will not run on a code step are said to be missing, with the reason.
    { ref: skillRefOf('mention-only'), name: 'mention-only', description: 'Names a script it does not have.', usesScripts: true, noScriptFiles: true },
    { ref: skillRefOf('too-big'), name: 'too-big', description: 'Has too many script files.', usesScripts: true }
  ];
  const loadedSkill = ref => {
    const name = ref.replace(/^.*\/skills\//, '').replace(/@.*$/, '');
    const base = { ref, name, description: '', usesScripts: true, body: '', references: {} };
    if (name === 'mention-only') { return { ...base, scripts: [] }; }
    if (name === 'too-big') { return { ...base, scripts: [], scriptsUnavailable: 'its scripts/ folder holds 301 files; at most 300 are cached' }; }
    return { ...base, scripts: ['scripts/run.py'] };
  };
  const runs = {
    steps: studioSteps(),
    scriptRunner: async () => 'container',
    skills: {
      sources: () => ['acme/skills'], ensureTrusted: async () => true, cached: async () => [],
      index: async () => ({ commit, skills: skillList }), load: async ref => loadedSkill(ref)
    },
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

  const open = async ({ theme = 'dark', width = 420, height = 900, folder = true, runs: scripted, root: workspaceRoot = workspace } = {}) => {
    const context = {
      subscriptions: [], extensionUri: fileUri(root), storageUri: fileUri(path.join(base, `storage-${pages.size}`)),
      globalStorageUri: fileUri(path.join(base, 'global')), globalState: memento(), workspaceState: memento()
    };
    StudioChatProvider.register(context, folder ? scripted ?? runs : undefined, folder ? workspaceRoot : undefined);
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
    // "Steps use" says how many steps it applies to (plan 4): the one prompt step names no model, so 1.
    const defaultSelect = card.locator('.default-model select');
    const defaultNote = card.locator('.default-model-note');
    assert.equal(await defaultNote.textContent(), 'used by 1 step');
    assert.equal(await defaultSelect.isDisabled(), false);
    assert.equal(await defaultSelect.getAttribute('aria-describedby'), await defaultNote.getAttribute('id'));
    await snap(page, '41-studio-chat-plan');

    // A model for one step, and a criterion edited on the card.
    await card.locator('.step[data-step="summarize"] select').selectOption('copilot:gpt-4o');
    await page.waitForFunction(() => document.querySelector('.card[data-card="current"] .step[data-step="summarize"] select').value === 'copilot:gpt-4o');
    // Every model-using step now names its own: the default applies to none, so it cannot be changed, and says why.
    assert.equal(await defaultNote.textContent(), 'used by no step: each step that uses a model names its own');
    assert.equal(await defaultSelect.isDisabled(), true);
    assert.equal(await defaultSelect.inputValue(), '', 'the disabled menu still shows the current default');
    assert.equal(await defaultSelect.getAttribute('aria-describedby'), await defaultNote.getAttribute('id'));
    await snap(page, '48-studio-chat-default-unused');
    // Back to "Plan default": the count goes 0 -> 1 and the menu is usable again.
    await card.locator('.step[data-step="summarize"] select').selectOption('');
    await page.waitForFunction(() => document.querySelector('.card[data-card="current"] .default-model-note').textContent === 'used by 1 step');
    assert.equal(await defaultSelect.isDisabled(), false);
    await card.locator('.step[data-step="summarize"] select').selectOption('copilot:gpt-4o');
    await page.waitForFunction(() => document.querySelector('.card[data-card="current"] .step[data-step="summarize"] select').value === 'copilot:gpt-4o');
    await card.locator('.criteria input').fill('The summary is at most 5 lines');
    await card.locator('.criteria input').dispatchEvent('change');
    await page.waitForFunction(() => document.querySelector('.card[data-card="current"] .criteria input').value === 'The summary is at most 5 lines');

    // Remove every criterion: the plan cannot run, and says why.
    await card.locator('.criteria button.icon').click();
    await page.locator('.card[data-card="current"] .problems').waitFor();
    assert.equal(await page.locator('.card[data-card="current"] button:has-text("Run")').isDisabled(), true);
    // Nor can it be exported; once fixed, Export… is offered.
    assert.equal(await page.locator('.card[data-card="current"] button:has-text("Export…")').isDisabled(), true);
    await page.click('.card[data-card="current"] button.link');
    await page.locator('.card[data-card="current"] .problems').waitFor({ state: 'detached' });

    // A change that also drops the write step: shown as a diff, the plan untouched until Accept.
    const dropped = plan(); dropped.nodes = [dropped.nodes[0]]; dropped.edges = []; dropped.criteria = ['A summary is shown'];
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

    // A plan with a code step (changes code, you review) and a skill added to its prompt step.
    const coding = await open({ height: 760 });
    const codePlan = plan();
    codePlan.nodes.push({ id: 'fix', type: 'code', title: 'Fix the parser', with: { task: 'Fix the parser', paths: ['src/'], checks: ['test'] } });
    codePlan.edges.push({ from: 'write', to: 'fix' });
    replies.push({ reply: 'Summarize, write, then fix the code.', workflow: codePlan });
    await coding.fill('#message', 'Summarize and fix the parser');
    await coding.press('#message', 'Enter');
    const codeCard = coding.locator('.card[data-card="current"]');
    await codeCard.waitFor();
    assert.equal(await codeCard.locator('.step[data-step="fix"] .badge.write').textContent(), 'changes code · you review');
    assert.equal(await codeCard.locator('.step[data-step="fix"] select').count(), 1, 'a code step uses a model, so it has a model choice');
    assert.equal(await codeCard.locator('.default-model-note').textContent(), 'used by 2 steps');
    assert.equal(await codeCard.locator('.default-model select').isDisabled(), false);
    await codeCard.locator('[data-skills="summarize"] button.link').click();
    await coding.locator('[data-skills="summarize"] .chip').waitFor();
    assert.match(await coding.locator('[data-skills="summarize"] .chip').textContent(), /^write-tests ⚠×$/);
    assert.match(await coding.locator('[data-skills="summarize"] .chip').getAttribute('title'), /Uses scripts: this step type has no tools, so they are not run here; use a code step/, 'a prompt step does not run scripts');
    // On the code step the same skill's scripts run after approval, in the runner the setting gives (plan 6): no warning sign.
    await codeCard.locator('[data-skills="fix"] button.link').click();
    await coding.locator('[data-skills="fix"] .chip').waitFor();
    await coding.waitForFunction(() => /in a container\)/.test(document.querySelector('[data-skills="fix"] .chip').title));
    assert.match(await coding.locator('[data-skills="fix"] .chip').getAttribute('title'), /Uses scripts: run in this step after your approval \(in a container\)/);
    assert.equal(await coding.locator('[data-skills="fix"] .chip').textContent(), 'write-tests×', 'no warning where the scripts run');
    assert.equal(await coding.locator('[data-skills="fix"] .chip .chip-warning').count(), 0);
    await snap(coding, '45-studio-chat-code-skills');
    // Scripts that will not run on a code step keep the warning sign, with the reason: a skill that only
    // mentions a script, and one whose scripts are over a limit (Decision 10).
    quickPicks.length = 0;
    await codeCard.locator('[data-skills="fix"] button.link').click();
    await coding.locator('[data-skills="fix"] .chip:nth-child(2)').waitFor();
    await codeCard.locator('[data-skills="fix"] button.link').click();
    await coding.locator('[data-skills="fix"] .chip:nth-child(3)').waitFor();
    const mention = coding.locator('[data-skills="fix"] .chip:nth-child(2)');
    const big = coding.locator('[data-skills="fix"] .chip:nth-child(3)');
    await coding.waitForFunction(() => /Mentions scripts but has none in its folder/.test(document.querySelector('[data-skills="fix"] .chip:nth-child(2)').title));
    await coding.waitForFunction(() => /none could be loaded/.test(document.querySelector('[data-skills="fix"] .chip:nth-child(3)').title));
    assert.equal(await mention.textContent(), 'mention-only ⚠×', 'a skill that only mentions a script has the warning sign on a code step');
    assert.match(await mention.getAttribute('title'), /(^|\n)Mentions scripts but has none in its folder/);
    assert.equal(await big.textContent(), 'too-big ⚠×');
    assert.match(await big.getAttribute('title'), /Uses scripts: none could be loaded: its scripts\/ folder holds 301 files; at most 300 are cached/);
    assert.equal(await coding.locator('[data-skills="fix"] .chip:nth-child(1) .chip-warning').count(), 0, 'the skill with script files still has no warning');
    // The picker's detail says the same on a code step, from the host.
    assert.match(quickPicks.flat().find(item => item.label === 'mention-only').detail, /mentions scripts but has none in its folder/);
    for (const name of ['mention-only', 'too-big']) {
      await coding.locator(`[data-skills="fix"] .chip:has-text("${name}") button`).click();
      await coding.locator(`[data-skills="fix"] .chip:has-text("${name}")`).waitFor({ state: 'detached' });
    }
    await coding.locator('[data-skills="fix"] .chip button').click();
    await coding.locator('[data-skills="fix"] .chip').waitFor({ state: 'detached' });
    await coding.locator('[data-skills="summarize"] .chip button').click();
    await coding.locator('[data-skills="summarize"] .chip').waitFor({ state: 'detached' });

    // Directly on this machine, and turned off in the settings.
    for (const [mode, title, warned] of [['direct', /\(directly on this machine\)/, false], ['off', /Uses scripts: turned off in settings/, true]]) {
      const modePage = await open({ height: 700, runs: { ...runs, scriptRunner: async () => mode } });
      const modePlan = plan();
      modePlan.nodes.push({ id: 'fix', type: 'code', title: 'Fix the parser', with: { task: 'Fix the parser', paths: ['src/'], checks: ['test'] } });
      modePlan.edges.push({ from: 'write', to: 'fix' });
      replies.push({ reply: 'Plan.', workflow: modePlan });
      await modePage.fill('#message', 'Fix the parser');
      await modePage.press('#message', 'Enter');
      await modePage.locator('.card[data-card="current"] [data-skills="fix"] button.link').click();
      await modePage.locator('[data-skills="fix"] .chip').waitFor();
      await modePage.waitForFunction(pattern => new RegExp(pattern).test(document.querySelector('[data-skills="fix"] .chip').title), title.source);
      assert.equal(await modePage.locator('[data-skills="fix"] .chip .chip-warning').count(), warned ? 1 : 0, `${mode}: the warning sign only where the scripts will not run`);
    }

    // Plan 9: a coding goal still planned without a code step after the one repair is shown with
    // "Check before running"; the warnings are advice, so Run stays on.
    const advice = await open({ height: 760 });
    const docsOnly = plan();
    docsOnly.criteria = ['Requirements are defined', 'Data sources are identified'];
    docsOnly.nodes = [{ id: 'define', type: 'docs.requirements', title: 'Define Requirements', with: { from: 'docs' } }];
    docsOnly.edges = []; docsOnly.prompts = {}; docsOnly.types = {};
    const promptsBefore = prompts.length;
    replies.push({ reply: 'Define the requirements first.', workflow: docsOnly }, { reply: 'Still the same plan.', workflow: docsOnly });
    await advice.fill('#message', 'i need to create a weather dashboard');
    await advice.press('#message', 'Enter');
    const adviceCard = advice.locator('.card[data-card="current"]');
    await adviceCard.waitFor();
    assert.equal(prompts.length - promptsBefore, 2, 'one repair turn');
    assert.match(prompts[prompts.length - 1].text, /The request asks to change code/);
    assert.equal(await adviceCard.locator('[data-testid="warnings"] summary').textContent(), 'Check before running');
    assert.equal(await adviceCard.locator('[data-testid="warnings"] li').count(), 3, 'the missing code step and two criteria');
    assert.match(await adviceCard.locator('[data-testid="warnings"]').textContent(), /plan it with code steps/);
    assert.equal(await adviceCard.locator('.problems').count(), 0, 'no error: nothing says "cannot run"');
    assert.equal(await adviceCard.locator('button:has-text("Run")').isDisabled(), false, 'warnings leave Run on');
    assert.equal(await adviceCard.locator('button:has-text("Export…")').isDisabled(), false);
    await snap(advice, '53-studio-chat-plan-warning');

    // A plan with no step that uses a model has no "Steps use" at all.
    const plain = await open({ height: 600 });
    const plainPlan = plan(); plainPlan.nodes = [plainPlan.nodes[1]]; plainPlan.edges = []; plainPlan.prompts = {};
    plainPlan.nodes[0].with.content = 'fixed text';
    replies.push({ reply: 'Just write the file.', workflow: plainPlan });
    await plain.fill('#message', 'Write a fixed file');
    await plain.press('#message', 'Enter');
    await plain.locator('.card[data-card="current"]').waitFor();
    assert.equal(await plain.locator('.card[data-card="current"] .default-model').count(), 0);

    // A run in progress (plan 3): the steps with a word each, the running step's clock and last lines,
    // "Activity (N)", Stop instead of Send. The run is scripted: it emits log entries and waits.
    const progress = () => {
      const control = { released: false };
      const scripted = { ...runs, run: async (workflow, _hash, onUpdate, options) => {
        const state = { id: 'run-progress', status: 'running', nodes: {}, criteria: workflow.criteria };
        onUpdate({ ...state });
        control.emit = (entry, secondsAgo = 0) => options.onLog({ at: new Date(Date.now() - secondsAgo * 1000).toISOString(), ...entry });
        control.signal = options.signal;
        while (!control.released && !options.signal.cancelled) await new Promise(resolve => setTimeout(resolve, 20));
        const stopped = options.signal.cancelled;
        control.emit(stopped ? { type: 'finish', status: 'stopped', reason: 'Cancelled' } : { type: 'finish', status: 'done' });
        const final = { ...state, status: stopped ? 'stopped' : 'done', error: stopped ? 'Cancelled' : undefined,
          nodes: stopped ? { summarize: { status: 'done' } } : { summarize: { status: 'done' }, write: { status: 'done' }, fix: { status: 'done' } } };
        onUpdate(final);
        return final;
      } };
      return { scripted, control };
    };
    const startRun = async (page) => {
      const withCode = plan();
      withCode.nodes.push({ id: 'fix', type: 'code', title: 'Fix the parser', with: { task: 'Fix the parser', paths: ['src/'], checks: ['test'] } });
      withCode.edges.push({ from: 'write', to: 'fix' });
      replies.push({ reply: 'Summarize, write, then fix the code.', workflow: withCode });
      await page.fill('#message', 'Summarize and fix the parser');
      await page.press('#message', 'Enter');
      await page.locator('.card[data-card="current"]').waitFor();
      await page.click('.card[data-card="current"] button:has-text("Run")');
      await page.locator('.card.run').waitFor();
    };
    const words = page => page.locator('.run-step').evaluateAll(items => items.map(item => [item.dataset.step, item.dataset.outcome, item.querySelector('.step-word').textContent]));
    const waitFor = (page, expression, arg) => page.waitForFunction(expression, arg, { timeout: 5000 });

    {
      const { scripted, control } = progress();
      const running = await open({ runs: scripted, height: 560 });
      await startRun(running);
      while (!control.emit) await new Promise(resolve => setTimeout(resolve, 20));
      // No log entry yet: the card is as before steps existed (just the head).
      assert.equal(await running.locator('.run-steps').count(), 0);
      control.emit({ type: 'node', node: 'summarize', step: 'prompt' }, 40);
      control.emit({ type: 'model', node: 'summarize', model: 'gpt-4o', inputTokens: 900, outputTokens: 40 }, 39);
      control.emit({ type: 'done', node: 'summarize' }, 30);
      control.emit({ type: 'node', node: 'write', step: 'file.write' }, 29);
      control.emit({ type: 'done', node: 'write' }, 28);
      control.emit({ type: 'node', node: 'fix', step: 'code' }, 65);
      control.emit({ type: 'branch', node: 'fix', branch: 'fix/parser', created: true }, 64);
      for (const note of ['src/parser.ts:1-80', 'src/lexer.ts:1-60', '"tokenize" (4)', 'src/parser.ts', 'src/parser.ts:40-90', 'src/parser.test.ts']) {
        control.emit({ type: 'tool', node: 'fix', ok: true, name: note.includes('"') ? 'search' : 'read_file', note }, 20);
      }
      await running.locator('.run-step[data-step="fix"] .activity.recent li').nth(4).waitFor();
      assert.deepEqual((await words(running)).map(item => item.slice(0, 2)), [['summarize', 'done'], ['write', 'done'], ['fix', 'running']]);
      const stepWords = (await words(running)).map(item => item[2]);
      assert.deepEqual(stepWords.slice(0, 2), ['Done · 10 s', 'Done · 1 s']);
      assert.match(stepWords[2], /^Running · 1:\d\d$/);
      // The running step's last 5 lines, in order; "Activity (N)" holds all of them, collapsed.
      const recent = await running.locator('.run-step[data-step="fix"] .activity.recent li').allTextContents();
      assert.deepEqual(recent, ['read_file src/lexer.ts:1-60', 'search "tokenize" (4)', 'read_file src/parser.ts', 'read_file src/parser.ts:40-90', 'read_file src/parser.test.ts']);
      assert.equal((await running.locator('details.all-activity summary').textContent()), 'Activity (8)');
      assert.equal(await running.locator('details.all-activity').evaluate(node => node.open), false);
      // Stop instead of Send, saying what is lost; the status line names the step.
      assert.equal(await running.textContent('#send'), 'Stop');
      assert.match(await running.getAttribute('#send', 'title'), /Stop the run: the running step's changes are undone\./);
      assert.equal(await running.isDisabled('#send'), false);
      assert.equal(await running.textContent('#run-status'), 'Step 3 of 3, Fix the parser: running');
      // The clock ticks on the page once a second.
      const first = await running.locator('.tick').textContent();
      await running.waitForFunction(old => document.querySelector('.tick').textContent !== old, first, { timeout: 4000 });

      // New lines change neither the status line nor the keyboard focus (Stop keeps it), and the reader's place stays.
      await running.focus('#send');
      const overflow = await running.evaluate(() => { const thread = document.getElementById('thread'); return thread.scrollHeight - thread.clientHeight; });
      assert.ok(overflow > 40, `the thread must overflow for the scroll check (${overflow})`);
      await running.evaluate(() => { document.getElementById('thread').scrollTop = 0; });
      control.emit({ type: 'tool', node: 'fix', ok: false, name: 'edit_file', note: 'no match for the old text' });
      control.emit({ type: 'check', node: 'fix', script: 'test', passed: false, exitCode: 1 });
      await running.locator('details.all-activity summary:has-text("Activity (10)")').waitFor();
      assert.equal(await running.evaluate(() => document.getElementById('thread').scrollTop), 0, 'the thread jumped while the reader was reading above');
      assert.equal(await running.evaluate(() => document.activeElement.id), 'send', 'Stop lost the keyboard focus');
      assert.equal(await running.textContent('#run-status'), 'Step 3 of 3, Fix the parser: running', 'the status line changed with an activity line');
      assert.deepEqual(await running.locator('.run-step[data-step="fix"] .activity.recent li.bad').allTextContents(), ['✗ edit_file failed: no match for the old text', 'Check test failed (exit 1)']);
      // At the bottom, new lines keep the thread at the bottom.
      await running.evaluate(() => { const thread = document.getElementById('thread'); thread.scrollTop = thread.scrollHeight; });
      control.emit({ type: 'tool', node: 'fix', ok: true, name: 'read_file', note: 'src/last.ts:1-9' });
      await running.locator('details.all-activity summary:has-text("Activity (11)")').waitFor();
      assert.ok(await running.evaluate(() => { const thread = document.getElementById('thread'); return thread.scrollHeight - thread.scrollTop - thread.clientHeight < 4; }), 'the thread did not follow new lines at the bottom');
      // An opened "Activity" stays open, with its focus, through the next update.
      await running.locator('details.all-activity summary').click();
      assert.equal(await running.locator('details.all-activity li').count(), 11);
      control.emit({ type: 'tool', node: 'fix', ok: true, name: 'read_file', note: 'src/more.ts:1-9' });
      await running.locator('details.all-activity li').nth(11).waitFor();
      assert.equal(await running.locator('details.all-activity').evaluate(node => node.open), true, 'Activity closed itself');
      assert.equal(await running.evaluate(() => document.activeElement.tagName), 'SUMMARY', 'Activity lost its focus');
      // The reader scrolled away from the focused summary: the next update keeps the place and the focus.
      await running.evaluate(() => { document.getElementById('thread').scrollTop = 0; });
      assert.ok(await running.locator('details.all-activity summary').evaluate(node => node.getBoundingClientRect().top > document.getElementById('thread').getBoundingClientRect().bottom), 'the summary must be out of view for the scroll check');
      const placeBefore = await running.evaluate(() => document.getElementById('thread').scrollTop);
      control.emit({ type: 'tool', node: 'fix', ok: true, name: 'read_file', note: 'src/again.ts:1-9' });
      await running.locator('details.all-activity li').nth(12).waitFor();
      const placeAfter = await running.evaluate(() => document.getElementById('thread').scrollTop);
      assert.ok(Math.abs(placeAfter - placeBefore) <= 2, `restoring the focus scrolled the thread (${placeBefore} -> ${placeAfter})`);
      assert.equal(await running.evaluate(() => document.activeElement.tagName), 'SUMMARY', 'Activity lost its focus after the scroll');
      await running.locator('details.all-activity summary').click();
      await running.evaluate(() => { const thread = document.getElementById('thread'); thread.scrollTop = thread.scrollHeight; });
      assert.equal(await running.isDisabled('#add'), true, 'Add… waits while a run goes');
      await snap(running, '46-studio-chat-run-progress');
      // The step ends: the status line changes now.
      control.emit({ type: 'done', node: 'fix' });
      await waitFor(running, () => document.getElementById('run-status').textContent !== 'Step 3 of 3, Fix the parser: running');
      assert.equal(await running.textContent('#run-status'), '3 of 3 steps finished');
      control.released = true;
      await running.locator('.card.run[data-run="done"]').waitFor();
      assert.equal(await running.textContent('#send'), 'Send');
      assert.equal(await running.textContent('#run-status'), '');
      assert.deepEqual((await words(running)).map(item => item[1]), ['done', 'done', 'done']);
    }

    // Light theme: a skipped step, a running one, then Stop in the chat: the running step reads Stopped.
    {
      const { scripted, control } = progress();
      const light = await open({ runs: scripted, theme: 'light', height: 640 });
      await startRun(light);
      while (!control.emit) await new Promise(resolve => setTimeout(resolve, 20));
      control.emit({ type: 'node', node: 'summarize', step: 'prompt' }, 14);
      control.emit({ type: 'done', node: 'summarize' }, 9);
      control.emit({ type: 'skip', node: 'write' }, 9);
      control.emit({ type: 'node', node: 'fix', step: 'code' }, 8);
      control.emit({ type: 'read', node: 'fix', files: 12 }, 8);
      control.emit({ type: 'tool', node: 'fix', ok: false, name: 'edit_file', note: 'no match for the old text' }, 3);
      control.emit({ type: 'tool', node: 'fix', ok: true, name: 'edit_file', note: 'src/parser.ts' }, 2);
      await light.locator('.run-step[data-step="fix"] .activity.recent li').nth(2).waitFor();
      assert.deepEqual((await words(light)).map(item => item.slice(0, 2)), [['summarize', 'done'], ['write', 'skipped'], ['fix', 'running']]);
      assert.equal((await words(light))[1][2], 'Skipped');
      await light.evaluate(() => { const thread = document.getElementById('thread'); thread.scrollTop = thread.scrollHeight; });
      await snap(light, '47-studio-chat-run-progress-light');
      await light.click('#send');
      await light.locator('.card.run[data-run="stopped"]').waitFor();
      assert.deepEqual((await words(light)).map(item => item.slice(0, 2)), [['summarize', 'done'], ['write', 'skipped'], ['fix', 'stopped']]);
      assert.equal((await words(light))[2][2], 'Stopped');
      assert.equal(await light.textContent('#send'), 'Send');
      assert.equal(await light.isDisabled('#message'), false);
    }

    // Plan 7: files and folders attached to the chat. A Git work tree, so a Git-ignored file can be flagged.
    {
      const ws = path.join(base, 'attach-workspace');
      fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
      execFileSync('git', ['init', '-q'], { cwd: ws });
      fs.writeFileSync(path.join(ws, '.gitignore'), '.env\n');
      fs.writeFileSync(path.join(ws, 'docs/req.md'), '# Requirements\n\nREQ-1 the system shall attach files.\n');
      fs.writeFileSync(path.join(ws, 'docs/design.md'), '# Design\n\nHow the chips look.\n');
      fs.writeFileSync(path.join(ws, 'notes.md'), '# Notes\n\nA file chip.\n');
      fs.writeFileSync(path.join(ws, '.env'), 'KEY=1\n');
      const url = relative => `file://${path.join(ws, relative)}`;
      const chat = await open({ root: ws });
      assert.equal(await chat.isHidden('#attachments'), true, 'no chips, no row');
      assert.equal(await chat.isVisible('#attach-hint'), true);
      assert.equal(await chat.textContent('#attach-hint'), 'Hold Shift to drop files or folders here.');
      const drop = (target, type, data) => chat.evaluate(([selector, mime, text]) => {
        const transfer = new DataTransfer();
        transfer.setData(mime, text);
        const event = new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true });
        document.querySelector(selector).dispatchEvent(event);
        return event.defaultPrevented;
      }, [target, type, data]);
      // A plain-text drop keeps the box's own behavior: nothing is posted, the event is not taken.
      assert.equal(await drop('#message', 'text/plain', 'just some words'), false);
      // A URI list posts `attach`: a file, and a folder.
      assert.equal(await drop('#message', 'text/uri-list', `${url('notes.md')}\r\n${url('.env')}`), true);
      await chat.locator('.attachment[data-attachment="notes.md"]').waitFor();
      await chat.locator('.attachment[data-attachment=".env"]').waitFor();
      // Messages are handled in order: had the plain-text drop posted anything, it would be a chip by now.
      assert.equal(await chat.locator('.attachment').count(), 2);
      assert.equal(await chat.locator('.attachment[data-attachment=".env"] .chip-warning').textContent(), '⚠ ignored by Git, may hold secrets');
      assert.equal(await chat.locator('.attachment[data-attachment="notes.md"] .attachment-outcome').textContent(), 'attached');
      await drop('#message', 'application/vnd.code.uri-list', url('docs'));
      await chat.locator('.attachment[data-attachment="docs"]').waitFor();
      // Add… asks the host (Files… first in the scripted pick), then adds what the dialog returns.
      openAnswers.push([fileUri(path.join(ws, 'docs/design.md'))]);
      await chat.click('#add');
      await chat.locator('.attachment[data-attachment="docs/design.md"]').waitFor();
      assert.equal(quickPicks[quickPicks.length - 1][0].label, 'Files…');
      assert.equal(await chat.locator('.attachment').count(), 4);
      // × removes (it posts `detach`).
      await chat.click('button[aria-label="Remove .env"]');
      await chat.waitForFunction(() => document.querySelectorAll('.attachment').length === 3);
      assert.equal(await chat.locator('.attachment[data-attachment=".env"]').count(), 0);

      // Sent: each chip says how it went in words, the folder lists its files and opens its map.
      replies.push({ reply: 'Here is a plan.', workflow: plan() });
      await chat.fill('#message', 'Plan from the attached files');
      await chat.press('#message', 'Enter');
      await chat.locator('[data-testid="thinking"]').waitFor();
      assert.equal(await chat.isDisabled('#add'), true, 'Add… waits while drafting');
      assert.equal(await chat.isDisabled('button[aria-label="Remove notes.md"]'), true, '× waits while drafting');
      await chat.locator('.card[data-card="current"]').waitFor();
      assert.equal(await chat.isDisabled('#add'), false);
      assert.match(prompts[prompts.length - 1].text, /^=== notes\.md \(full\) ===$/m);
      assert.match(prompts[prompts.length - 1].text, /Map \(a file in the repository; a code step can read it\): \.repository-manager\/maps\/docs\.md/);
      assert.equal(await chat.locator('.attachment[data-attachment="notes.md"] .attachment-outcome').textContent(), 'sent in full');
      assert.equal(await chat.locator('.attachment[data-attachment="docs"] .attachment-outcome').textContent(), '2 files: 2 full');
      assert.equal(await chat.textContent('.message.user .attached'), 'with notes.md, docs (2 files: 2 full), docs/design.md');
      await chat.locator('.attachment[data-attachment="docs"] summary').click();
      assert.deepEqual(await chat.locator('.attachment[data-attachment="docs"] li').allTextContents(), ['docs/design.md: full', 'docs/req.md: full']);
      assert.equal(await chat.locator('.attachment[data-attachment="docs"] button:has-text("Open map")').count(), 1);
      await snap(chat, '49-studio-chat-attachments');
      // The row stays small: the thread above it still scrolls.
      assert.ok((await chat.locator('#attachments').boundingBox()).height <= 900 * 0.3 + 1);
      // A chip whose file went away stays, with the reason in words.
      fs.rmSync(path.join(ws, 'notes.md'));
      replies.push({ reply: 'Again.', workflow: null });
      await chat.fill('#message', 'Once more');
      await chat.press('#message', 'Enter');
      await chat.waitForFunction(() => /not sent: does not exist/.test(document.querySelector('.attachment[data-attachment="notes.md"] .attachment-outcome').textContent));

      // No folder open: the hint is gone.
      const lone2 = await open({ folder: false });
      assert.equal(await lone2.isHidden('#attach-hint'), true);
    }

    // Light theme, no folder: nothing to run or save, and the page says so.
    const lone = await open({ theme: 'light', folder: false });
    assert.match(await lone.textContent('.empty'), /Open a folder to run or save a plan/);
    replies.push({ reply: 'A plan.', workflow: plan() });
    await lone.fill('#message', 'Summarize');
    await lone.press('#message', 'Enter');
    await lone.locator('.card[data-card="current"]').waitFor();
    assert.equal(await lone.locator('.card[data-card="current"] button:has-text("Run")').isDisabled(), true);
    // Without a folder a plan cannot run or be saved, but it can be exported to share.
    assert.equal(await lone.locator('.card[data-card="current"] button:has-text("Export…")').isDisabled(), false);
    await snap(lone, '44-studio-chat-light');

    assert.deepEqual(errors, []);
    console.log('Studio chat UI test passed; screenshots in ui-snapshots/40-49');
  } finally {
    await browser.close();
    server.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
