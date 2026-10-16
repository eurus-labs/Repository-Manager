/**
 * How long the dashboard takes to open: from creating the panel to the first history page drawn
 * with its graph. Not part of `npm test` (it measures, it does not assert); run it with
 * `npm run bench:load` after `npm run compile`.
 *
 * It runs the real RepositoryManagerPanel against a fake `vscode` whose webview is a Chromium page,
 * on a generated repository: a parent with merges, branches, tags and a remote, three linked
 * repositories, and untracked files. Every Git command the extension runs is timed too.
 *
 * Options (environment): BENCH_RUNS (default 5), BENCH_COMMITS (parent, default 5000),
 * BENCH_SUB_COMMITS (each linked repository, default 1500), BENCH_FIXTURE (a folder to keep the
 * generated repository between runs), BENCH_SPAWN_MS and BENCH_FETCH_MS (added to every Git process,
 * and to every fetch, to stand for a slower machine and a remote over the network), BENCH_JSON=1
 * (print the raw timings as JSON).
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright-core');

const root = path.resolve(__dirname, '../..');
const RUNS = Number(process.env.BENCH_RUNS || 5);
const COMMITS = Number(process.env.BENCH_COMMITS || 5000);
const SUB_COMMITS = Number(process.env.BENCH_SUB_COMMITS || 1500);
const SPAWN_MS = Number(process.env.BENCH_SPAWN_MS || 0);
const FETCH_MS = Number(process.env.BENCH_FETCH_MS || 0);
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Bench', GIT_AUTHOR_EMAIL: 'bench@example.com', GIT_COMMITTER_NAME: 'Bench', GIT_COMMITTER_EMAIL: 'bench@example.com' };
Object.assign(process.env, env);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env, maxBuffer: 1 << 28 });

/** A history of `count` commits on main, a side branch merged back every 25 commits, branches and tags. */
function importHistory(repo, count, label, extraRefs) {
  const lines = [];
  let mark = 0;
  const time = 1700000000;
  const blob = text => { lines.push('blob', `mark :${++mark}`, `data ${Buffer.byteLength(text)}`, text); return mark; };
  const commit = (ref, parents, message, file, i) => {
    const content = blob(`${label} ${i}\n`);
    lines.push(`commit ${ref}`, `mark :${++mark}`, `committer Bench <bench@example.com> ${time + i * 60} +0000`,
      `data ${Buffer.byteLength(message)}`, message);
    if (parents[0]) lines.push(`from :${parents[0]}`);
    for (const parent of parents.slice(1)) lines.push(`merge :${parent}`);
    lines.push(`M 100644 :${content} ${file}`, '');
    return mark;
  };
  let tip = 0;
  const marks = [];
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % 25 === 0) {
      // A side branch of 4 commits from 10 commits back, merged into main.
      let side = marks[Math.max(0, marks.length - 10)];
      for (let s = 0; s < 4; s++) side = commit('refs/heads/side', [side], `feat: side work ${i}.${s}`, `side/${i % 7}.txt`, i * 10 + s);
      tip = commit('refs/heads/main', [tip, side], `Merge side work ${i}`, `merge/${i % 5}.txt`, i * 10 + 5);
    } else {
      tip = commit('refs/heads/main', tip ? [tip] : [], `chore: ${label} change ${i}`, `src/f${i % 50}.txt`, i * 10);
    }
    marks.push(tip);
  }
  lines.push('');
  execFileSync('git', ['fast-import', '--quiet'], { cwd: repo, input: lines.join('\n'), env, maxBuffer: 1 << 28 });
  git(repo, 'update-ref', '-d', 'refs/heads/side');
  if (extraRefs) {
    const shas = git(repo, 'rev-list', 'main').trim().split('\n');
    for (let b = 0; b < 30; b++) git(repo, 'branch', `feature/topic-${b}`, shas[(b * 97) % shas.length]);
    for (let t = 0; t < 30; t++) git(repo, 'tag', `v1.${t}.0`, shas[(t * 131) % shas.length]);
  }
  git(repo, 'checkout', '-q', '-f', 'main');
}

function createFixture(base) {
  const marker = path.join(base, '.complete');
  if (fs.existsSync(marker)) return path.join(base, 'workspace');
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  const subs = [];
  for (const name of ['lib-a', 'lib-b', 'lib-c']) {
    const repo = path.join(base, 'origins', name);
    fs.mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    importHistory(repo, SUB_COMMITS, name, false);
    subs.push({ name, repo });
  }
  const origin = path.join(base, 'origin.git');
  const seed = path.join(base, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  importHistory(seed, COMMITS, 'parent', true);
  for (const sub of subs) git(seed, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub.repo, sub.name);
  git(seed, 'commit', '-qm', 'chore: add linked repositories');
  git(base, 'clone', '-q', '--bare', seed, origin);
  const workspace = path.join(base, 'workspace');
  git(base, '-c', 'protocol.file.allow=always', 'clone', '-q', '--recurse-submodules', origin, workspace);
  for (const sub of subs) {
    // Linked repositories: on main, with a local edit.
    git(path.join(workspace, sub.name), 'checkout', '-q', 'main');
    fs.appendFileSync(path.join(workspace, sub.name, 'src/f1.txt'), 'local edit\n');
  }
  for (let i = 0; i < 200; i++) {
    fs.mkdirSync(path.join(workspace, 'scratch', `d${i % 10}`), { recursive: true });
    fs.writeFileSync(path.join(workspace, 'scratch', `d${i % 10}`, `u${i}.txt`), 'untracked\n');
  }
  fs.appendFileSync(path.join(workspace, 'src/f3.txt'), 'local edit\n');
  fs.writeFileSync(marker, '');
  return workspace;
}

/** Every Git command the extension runs, with when it started and ended (ms after `t0`). */
const gitLog = [];
let t0 = 0;
function instrumentGit() {
  const { GitCommandService } = require(path.join(root, 'out/services/gitCommandService'));
  // execGit goes through execGitRaw, so each process is counted once.
  for (const method of ['execGitRaw', 'execGitBuffer']) {
    const original = GitCommandService.prototype[method];
    GitCommandService.prototype[method] = function (args, ...rest) {
      const entry = { cmd: args.filter(arg => !arg.startsWith('--format')).slice(0, 4).join(' '), start: Date.now() - t0 };
      gitLog.push(entry);
      const done = () => { entry.end = Date.now() - t0; };
      // A slower machine: every Git process costs SPAWN_MS more (Windows process start, a virus
      // scanner), and a fetch FETCH_MS more (a remote over the network).
      const extra = SPAWN_MS + (args.includes('fetch') ? FETCH_MS : 0);
      const result = extra
        ? new Promise(resolve => setTimeout(resolve, extra)).then(() => original.call(this, args, ...rest))
        : original.call(this, args, ...rest);
      result.then(done, done);
      return result;
    };
  }
}

function fakeVscode(onPanel) {
  const noop = () => ({ dispose() {} });
  const settings = { autoFetch: true, autoFetchInterval: 5, liveChanges: true };
  return {
    ViewColumn: { One: 1, Beside: 2 },
    Uri: {
      joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts), toString() { return this.fsPath; } }),
      file: fsPath => ({ fsPath, toString: () => fsPath })
    },
    window: {
      activeTextEditor: undefined,
      showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
      createWebviewPanel: () => onPanel()
    },
    workspace: {
      workspaceFolders: [],
      textDocuments: [],
      getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback), inspect: () => undefined, update: async () => undefined }),
      onDidChangeConfiguration: noop,
      registerTextDocumentContentProvider: noop,
      createFileSystemWatcher: () => ({ onDidChange: noop, onDidCreate: noop, onDidDelete: noop, dispose() {} }),
      fs: { readFile: async () => new Uint8Array() }
    },
    env: { language: 'en', clipboard: { writeText: async () => undefined } },
    commands: { executeCommand: async () => undefined },
    lm: { selectChatModels: async () => [] },
    LanguageModelChatMessage: { User: text => text },
    CancellationTokenSource: class { constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: noop }; } cancel() {} dispose() {} }
  };
}

async function measureOnce(browser, workspace, server, state) {
  gitLog.length = 0;
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const marks = {};
  let toHost = null;
  await page.exposeFunction('__postToHost', message => { if (toHost) toHost(message); });
  await page.exposeFunction('__mark', (name) => { if (!(name in marks)) marks[name] = Date.now() - t0; });
  // The page reports the first history row and the drawn graph by itself (no polling from here).
  await page.addInitScript(() => {
    const seen = new Set();
    const mark = name => { if (!seen.has(name)) { seen.add(name); window.__mark(name); } };
    new MutationObserver(() => {
      if (document.querySelector('.history-row')) {
        mark('firstRow');
        // The graph is drawn once its geometry pass has laid lines over the measured rows.
        const graph = document.querySelector('#dashboardHistory svg');
        if (graph && graph.querySelector('path, circle')) {
          requestAnimationFrame(() => requestAnimationFrame(() => mark('graphDrawn')));
        }
      }
    }).observe(document, { childList: true, subtree: true, attributes: true });
  });
  let resolveHtml;
  const htmlSet = new Promise(resolve => { resolveHtml = resolve; });
  const panelListeners = {};
  const panel = {
    visible: true,
    webview: {
      cspSource: 'http:',
      asWebviewUri: uri => ({ toString: () => `http://127.0.0.1:${server.address().port}/resources/${path.basename(uri.fsPath)}` }),
      set html(value) { marks.html = Date.now() - t0; state.html = value; resolveHtml(); },
      get html() { return state.html; },
      postMessage: async message => { await page.evaluate(data => window.postMessage(data, '*'), message).catch(() => undefined); return true; },
      onDidReceiveMessage: listener => { panelListeners.message = listener; return { dispose() {} }; }
    },
    onDidDispose: () => ({ dispose() {} }),
    onDidChangeViewState: () => ({ dispose() {} }),
    reveal() {}, dispose() {}
  };
  const vscode = fakeVscode(() => panel);
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === 'vscode') return vscode;
    return originalLoad.call(this, request, parent, isMain);
  };
  for (const key of Object.keys(require.cache)) if (key.startsWith(path.join(root, 'out'))) delete require.cache[key];
  instrumentGit();
  const { RepositoryManagerPanel } = require(path.join(root, 'out/repositoryManagerPanel'));
  Module._load = originalLoad;
  toHost = message => panelListeners.message && panelListeners.message(message);

  const memento = { get: () => undefined, update: async () => undefined, keys: () => [] };
  t0 = Date.now();
  RepositoryManagerPanel.createOrShow({ fsPath: root }, workspace, memento);
  await htmlSet;
  const html = state.html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, '')
    .replace('<head>', `<head><script>window.acquireVsCodeApi = () => ({ getState() { return null; }, setState() {},
      postMessage(message) { window.__postToHost(message); } });</script>`);
  state.page = html;
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  for (let i = 0; i < 2400 && !('graphDrawn' in marks); i++) await new Promise(resolve => setTimeout(resolve, 25));
  // Let the background work started at open (fetch, refresh) finish, to see when it ends.
  await new Promise(resolve => setTimeout(resolve, 1500 + 4 * FETCH_MS));
  const result = { ...marks, git: gitLog.map(entry => ({ ...entry })) };
  RepositoryManagerPanel.currentPanel && RepositoryManagerPanel.currentPanel.dispose();
  await page.close();
  return result;
}

const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]; };

async function main() {
  const base = process.env.BENCH_FIXTURE || path.join(os.tmpdir(), `repository-manager-bench-${COMMITS}-${SUB_COMMITS}`);
  const started = Date.now();
  const workspace = createFixture(base);
  console.log(`fixture: ${workspace} (${COMMITS} commits + 3 × ${SUB_COMMITS}; ready in ${Date.now() - started} ms)`);
  const state = {};
  const server = http.createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); return res.end(state.page || ''); }
    if (req.url.startsWith('/resources/')) {
      res.setHeader('content-type', req.url.endsWith('.css') ? 'text/css' : 'text/javascript');
      return res.end(fs.readFileSync(path.join(root, 'resources', path.basename(req.url))));
    }
    res.statusCode = 404; res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || undefined });
  const runs = [];
  try {
    for (let run = 0; run < RUNS + 1; run++) {
      const result = await measureOnce(browser, workspace, server, state);
      if (run > 0) runs.push(result); // the first run warms Git's and the OS's caches
    }
  } finally {
    await browser.close();
    server.close();
  }
  const keys = ['html', 'firstRow', 'graphDrawn'];
  console.log(`\nopen → (median of ${runs.length} runs, ms)`);
  for (const key of keys) console.log(`  ${key.padEnd(11)} ${String(median(runs.map(run => run[key] ?? NaN))).padStart(6)}   [${runs.map(run => run[key]).join(', ')}]`);
  // Git commands of the median run, by start time.
  const sample = runs.find(run => run.graphDrawn === median(runs.map(r => r.graphDrawn))) || runs[0];
  console.log('\nGit commands (one run): start → end ms');
  for (const entry of sample.git.sort((a, b) => a.start - b.start)) {
    console.log(`  ${String(entry.start).padStart(5)} → ${String(entry.end ?? '…').padStart(5)}  ${entry.cmd}`);
  }
  if (process.env.BENCH_JSON) console.log(JSON.stringify(runs));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
