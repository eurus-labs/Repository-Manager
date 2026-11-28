// Drives the Studio's Runs view (src/studio/runsView.ts) in headless Chromium, under its real
// Content Security Policy, against the real provider and a real RunStore with runs the engine made:
// the summary, filters, a run's timeline, Resume for a waiting run and Open raw log. Screenshots go
// to ui-snapshots/. Run with `npm run test:ui`; set PLAYWRIGHT_CHROMIUM_PATH if Chromium is elsewhere.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const outputDir = path.join(root, 'ui-snapshots');
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-runs-ui-'));

let provider;
const fakeVscode = {
  window: {
    registerWebviewViewProvider: (_id, value) => { provider = value; return { dispose() {} }; },
    showErrorMessage: async message => { throw new Error(message); }
  }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { RunsViewProvider } = require('../../out/studio/runsView.js');
Module._load = originalLoad;
const { RunStore, WorkflowEngine } = require('../../out/studio/engine.js');
const { studioSteps } = require('../../out/studio/registry.js');

const flow = {
  schema: 'repository-manager/workflow@1', id: 'note', version: '1.0.0', title: 'Write a note',
  nodes: [
    { id: 'ask', type: 'gate', title: 'Go?', with: { title: 'Write the note?' } },
    { id: 'write', type: 'file.write', title: 'Write it', with: { path: 'notes/n.txt', content: 'hi' } }
  ],
  edges: [{ from: 'ask', to: 'write' }]
};

async function main() {
  const store = new RunStore(path.join(base, 'runs'));
  const engine = new WorkflowEngine({ root: base, steps: studioSteps(), store });
  const never = { cancelled: false };
  let done = await engine.continue(flow, await engine.start(flow, 'h', {}), never);
  done = await engine.continue(flow, await engine.answer(done, true), never);
  await engine.continue(flow, await engine.answer(done, true), never);
  const waiting = await engine.continue(flow, await engine.start(flow, 'h', {}), never);
  // A run cut short by a closed window, as recovery leaves it.
  await store.save({ id: 'cut-run', workflow: { id: 'fix', version: '2.0.0', title: 'Fix the bug', hash: 'h' }, startedAt: '2026-11-15T01:00:00.000Z', updatedAt: '',
    status: 'failed', error: 'fix: VS Code closed while this step ran; its changes were undone (src/a.ts).', inputs: {}, approvals: {},
    nodes: { fix: { status: 'failed', error: 'VS Code closed while this step ran' } }, interrupted: { node: 'fix', restored: ['src/a.ts'], kept: [], at: '2026-11-15T01:02:00.000Z' } });
  await store.log('cut-run', { type: 'node', node: 'fix' });
  await store.log('cut-run', { type: 'recovered', node: 'fix', restored: ['src/a.ts'], kept: [] });

  const calls = [];
  const studioRuns = {
    runs: async () => store,
    // As drive() does with a person approving: answer each question until the run is not waiting.
    resume: async id => {
      calls.push(['resume', id]);
      let current = await store.load(id);
      while (current.status === 'waiting') { current = await engine.continue(flow, await engine.answer(current, true), never); }
      return current;
    },
    openLog: async id => { calls.push(['rawLog', id]); },
    stop: id => { calls.push(['stop', id]); return true; }
  };

  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    let receive;
    let current = '';
    await page.route('https://runs.view.test/', route => route.fulfill({ status: 200, contentType: 'text/html', body: current }));
    let rendered = Promise.resolve();
    const webview = {
      cspSource: 'vscode-resource:', options: {},
      // A real navigation, so the init script that provides acquireVsCodeApi runs on each page.
      set html(value) { current = value; rendered = page.goto('https://runs.view.test/').catch(() => undefined); },
      onDidReceiveMessage: handler => { receive = handler; }
    };
    await page.exposeFunction('postToHost', message => receive(message));
    await page.addInitScript(() => { window.acquireVsCodeApi = () => ({ postMessage: message => window.postToHost(message) }); });
    const settle = async () => { for (let i = 0; i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 25)); await rendered; } };

    new RunsViewProvider(studioRuns).resolveWebviewView({ webview, visible: true, onDidChangeVisibility: () => {}, onDidDispose: () => {} });
    await settle();
    // The summary: 3 runs, 1 done of 2 finished (the waiting run is not counted), 1 interrupted.
    assert.equal(await page.locator('.tile').nth(0).innerText(), '3\nruns');
    assert.equal(await page.locator('.tile').nth(1).innerText(), '50%\ncompleted (1 of 2 finished)');
    assert.match(await page.locator('.tile').nth(3).innerText(), /^1\ninterrupted$/);
    assert.equal(await page.locator('table.runs tbody tr').count(), 3);
    await page.screenshot({ path: path.join(outputDir, '50-studio-runs.png') });

    // Filter by status: interrupted.
    await page.selectOption('select[data-filter="status"]', 'interrupted');
    await settle();
    assert.equal(await page.locator("table.runs tbody tr").count(), 1, `errors: ${errors.join("; ")}`);
    // Its timeline says what recovery did.
    await page.click('button[data-action="select"]');
    await settle();
    assert.match(await page.locator('.detail').innerText(), /VS Code closed while it ran\. Put back: src\/a\.ts\./);
    assert.equal(await page.locator('.detail button[data-action="resume"]').count(), 0, 'an interrupted run offers Resume');
    await page.screenshot({ path: path.join(outputDir, '51-studio-run-interrupted.png') });

    // The waiting run: its timeline and Resume, which answers its gate; then it is done.
    await page.selectOption('select[data-filter="status"]', 'waiting');
    await settle();
    await page.click('button[data-action="select"]');
    await settle();
    assert.match(await page.locator('.detail').innerText(), /Go\?[\s\S]*waiting[\s\S]*not run yet · waiting for you now/);
    await page.screenshot({ path: path.join(outputDir, '52-studio-run-waiting.png') });
    await page.click('.detail button[data-action="resume"]');
    await settle();
    assert.deepEqual(calls[0], ['resume', waiting.id]);
    assert.equal((await store.load(waiting.id)).status, 'done');
    await page.selectOption('select[data-filter="status"]', '');
    await settle();
    assert.equal(await page.locator('.tile').nth(1).innerText(), '67%\ncompleted (2 of 3 finished)');
    await page.click('.detail button[data-action="rawLog"]');
    await settle();
    assert.deepEqual(calls[1], ['rawLog', waiting.id]);

    // A run goes on (plan 10): the view follows its log without a click, and a running run has Stop.
    await store.save({ id: 'going', workflow: { id: 'note', version: '1.0.0', title: 'Write a note', hash: 'h' }, startedAt: '2026-11-28T09:00:00.000Z', updatedAt: '',
      status: 'running', inputs: {}, approvals: {}, nodes: { ask: { status: 'pending' }, write: { status: 'pending' } } });
    await store.saveWorkflow('going', flow);
    await store.log('going', { type: 'start' });
    await store.log('going', { type: 'node', node: 'ask' });
    await page.waitForFunction(() => document.querySelectorAll('table.runs tbody tr').length === 4, undefined, { timeout: 3000 });
    assert.match(await page.locator('.tile').nth(2).innerText(), /^1\nnot finished \(1 running, 0 waiting\)$/);
    await page.click('button[data-action="select"][data-run="going"]');
    await page.locator('.detail button[data-action="stop"]').waitFor();
    assert.equal(await page.locator('.detail button[data-action="resume"]').count(), 0, 'a running run offers Resume');
    assert.match(await page.locator('.detail').innerText(), /Go\?[\s\S]*running/);
    await page.screenshot({ path: path.join(outputDir, '53-studio-run-running.png') });
    // The next step starting shows without a click.
    await store.log('going', { type: 'done', node: 'ask' });
    await store.log('going', { type: 'node', node: 'write' });
    await page.waitForFunction(() => /Write it[\s\S]*running/.test(document.querySelector('.detail').innerText), undefined, { timeout: 3000 });
    // Stop reaches StudioRuns.stop; a finished run has none.
    await page.click('.detail button[data-action="stop"]');
    await settle();
    assert.deepEqual(calls.at(-1), ['stop', 'going']);
    await store.log('going', { type: 'finish', status: 'stopped', reason: 'Cancelled' });
    await store.save({ ...(await store.load('going')), status: 'stopped', error: 'Cancelled' });
    await page.waitForFunction(() => !document.querySelector('.detail button[data-action="stop"]'), undefined, { timeout: 3000 });
    assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
    console.log('Studio runs UI test passed; screenshots in ui-snapshots/50-53');
  } finally {
    await browser.close();
    fs.rmSync(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exit(1); });
