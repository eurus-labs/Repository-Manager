const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Opening the dashboard: the page is shown before every repository's status is read, the first
// background fetch waits for the first history page, and repositoryManager.debug.timings writes
// where the time goes.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Open Test', GIT_AUTHOR_EMAIL: 'open@example.com',
  GIT_COMMITTER_NAME: 'Open Test', GIT_COMMITTER_EMAIL: 'open@example.com'
});
const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-open-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

const settings = { autoFetch: true, autoFetchInterval: 5, liveChanges: false, 'debug.timings': false };
const outputLines = [];
let panel;
const posted = [];
const noopEvent = () => ({ dispose() {} });
function newPanel() {
  const listeners = {};
  panel = {
    visible: true, iconPath: undefined, listeners,
    webview: {
      html: '', cspSource: 'test',
      asWebviewUri: uri => ({ toString: () => uri.fsPath }),
      postMessage: async message => { posted.push(message); return true; },
      onDidReceiveMessage: listener => { listeners.message = listener; return { dispose() {} }; }
    },
    onDidDispose: noopEvent, reveal() {}, dispose() {},
    onDidChangeViewState: listener => { listeners.viewState = listener; return { dispose() {} }; }
  };
  return panel;
}
const fakeVscode = {
  ViewColumn: { One: 1 },
  Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts), toString() { return this.fsPath; } }) },
  window: {
    activeTextEditor: undefined,
    showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
    createWebviewPanel: () => newPanel(),
    createOutputChannel: () => ({ appendLine: line => outputLines.push(line), dispose() {} })
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback), inspect: () => undefined }),
    onDidChangeConfiguration: noopEvent,
    registerTextDocumentContentProvider: noopEvent,
    createFileSystemWatcher: () => ({ onDidChange: noopEvent, onDidCreate: noopEvent, onDidDelete: noopEvent, dispose() {} })
  },
  lm: { selectChatModels: async () => [] },
  LanguageModelChatMessage: { User: text => text },
  CancellationTokenSource: class { constructor() { this.token = {}; } cancel() {} dispose() {} }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { RepositoryManagerPanel } = require('../../out/repositoryManagerPanel.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
Module._load = originalLoad;

const tick = (ms = 0) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, what, timeoutMs = 15000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await tick(20);
  }
}
const embedded = html => JSON.parse(/window\.__initialRepositories = (.*?);<\/script>/.exec(html)[1]);
function memento() {
  const values = new Map();
  return { get: key => values.get(key), update: async (key, value) => { values.set(key, value); }, keys: () => Array.from(values.keys()) };
}
// Every Git process the extension runs, by its first arguments.
const commands = [];
function watchGit() {
  const original = GitCommandService.prototype.execGitRaw;
  GitCommandService.prototype.execGitRaw = function (args, ...rest) {
    commands.push(args.slice(0, 2).join(' '));
    return original.call(this, args, ...rest);
  };
}

async function main() {
  try {
    // A parent repository with a remote and one linked repository.
    const remote = path.join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', remote);
    const lib = path.join(base, 'lib-origin');
    mkdirSync(lib);
    git(lib, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(lib, 'lib.txt'), 'lib\n');
    git(lib, 'add', '.');
    git(lib, 'commit', '-qm', 'lib');
    const workspace = path.join(base, 'workspace');
    git(base, 'clone', '-q', remote, workspace);
    git(workspace, 'checkout', '-q', '-b', 'main');
    writeFileSync(path.join(workspace, 'app.txt'), 'app\n');
    git(workspace, 'add', '.');
    git(workspace, 'commit', '-qm', 'app');
    git(workspace, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    git(workspace, 'commit', '-qm', 'add lib');
    git(workspace, 'push', '-q', 'origin', 'main');
    watchGit();
    const state = memento();
    const extension = { fsPath: path.join(__dirname, '..', '..') };

    // First open: nothing known yet, so the page shows the parent alone at once, before any status.
    RepositoryManagerPanel.createOrShow(extension, workspace, state);
    const first = embedded(panel.webview.html);
    assert.deepEqual(first.map(repository => [repository.path, repository.status, repository.isParentRepo]), [['.', 'unknown', true]],
      'the page waited for the repositories to be listed');
    assert.equal(first[0].name, 'workspace');
    // The listed repositories follow as an update, and are kept for the next open.
    await waitFor(() => posted.some(message => message.type === 'updateSubmodules'), 'the repository list');
    const listed = posted.find(message => message.type === 'updateSubmodules').payload.submodules;
    assert.deepEqual(listed.map(repository => repository.path), ['.', 'lib']);
    assert.deepEqual(state.get('repositoryManager.repositoryList').repositories.map(repository => repository.path), ['.', 'lib']);
    assert.equal(state.get('repositoryManager.repositoryList').root, workspace);

    // The first background fetch waits for the first history page: none yet, though it is due and
    // VS Code reports the panel shown (as it does when a panel opens).
    panel.listeners.viewState();
    await tick(700);
    assert.equal(commands.filter(command => command.startsWith('fetch')).length, 0, 'fetched before the history was asked for');
    await panel.listeners.message({ type: 'getHistory', payload: { repositoryPath: '.', limit: 100, offset: 0, includeRemotes: true } });
    assert.ok(posted.some(message => message.type === 'historyLoaded'));
    await waitFor(() => commands.some(command => command.startsWith('fetch')), 'the fetch after the first history page');
    RepositoryManagerPanel.currentPanel.dispose();

    // Next open: the repositories known from last time are on the page at once.
    posted.length = 0;
    commands.length = 0;
    RepositoryManagerPanel.createOrShow(extension, workspace, state);
    assert.deepEqual(embedded(panel.webview.html).map(repository => repository.path), ['.', 'lib'], 'the saved list was not used');
    // Without a history request, the fetch still starts, a few seconds after opening.
    await waitFor(() => commands.some(command => command.startsWith('fetch')), 'the fetch without a history request', 8000);
    // Its fetches end before the next case counts any.
    await RepositoryManagerPanel.currentPanel._autoFetchRun;
    RepositoryManagerPanel.currentPanel.dispose();

    // Requests still being answered when the history is sent (refs, here slower than the first
    // fetch's 3 s hold): the fetch waits for them, then starts as soon as the last one ends.
    commands.length = 0;
    RepositoryManagerPanel.createOrShow(extension, workspace, state);
    const dispatch = RepositoryManagerPanel.prototype._dispatchMessage;
    let answerRefs;
    const refsHeld = new Promise(resolve => { answerRefs = resolve; });
    RepositoryManagerPanel.prototype._dispatchMessage = async function (message) {
      if (message.type === 'getRepositoryRefs') { await refsHeld; }
      return dispatch.call(this, message);
    };
    const refs = panel.listeners.message({ type: 'getRepositoryRefs', payload: { repositoryPath: '.' } });
    await panel.listeners.message({ type: 'getHistory', payload: { repositoryPath: '.', limit: 100, offset: 0, includeRemotes: true } });
    await tick(5600);
    assert.equal(commands.filter(command => command.startsWith('fetch')).length, 0, 'fetched while a request was being answered');
    answerRefs();
    await refs;
    RepositoryManagerPanel.prototype._dispatchMessage = dispatch;
    await waitFor(() => commands.some(command => command.startsWith('fetch')), 'the fetch after the last request', 2000);
    RepositoryManagerPanel.currentPanel.dispose();

    // A folder that is not a repository, with nothing saved: the page waits for the list.
    const plain = path.join(base, 'plain');
    mkdirSync(plain);
    RepositoryManagerPanel.createOrShow(extension, plain, memento());
    assert.equal(panel.webview.html, '', 'a folder without a repository showed a parent');
    await waitFor(() => panel.webview.html !== '', 'the page of a folder without a repository');
    assert.deepEqual(embedded(panel.webview.html), []);
    RepositoryManagerPanel.currentPanel.dispose();
    // Nor does a folder that was a repository last time: the saved list is not shown without its .git.
    const gone = memento();
    await gone.update('repositoryManager.repositoryList', { root: plain, repositories: state.get('repositoryManager.repositoryList').repositories });
    RepositoryManagerPanel.createOrShow(extension, plain, gone);
    assert.equal(panel.webview.html, '', 'the saved list of a folder that is no longer a repository was shown');
    await waitFor(() => panel.webview.html !== '', 'the page of a folder that is no longer a repository');
    assert.deepEqual(embedded(panel.webview.html), []);
    RepositoryManagerPanel.currentPanel.dispose();

    // repositoryManager.debug.timings: the steps of opening and every Git command, with durations.
    settings['debug.timings'] = true;
    RepositoryManagerPanel.createOrShow(extension, workspace, state);
    await panel.listeners.message({ type: 'getHistory', payload: { repositoryPath: '.', limit: 100, offset: 0, includeRemotes: true } });
    await panel.listeners.message({ type: 'dashboardTiming', payload: { name: 'history drawn' } });
    // A search reads Git as a stream: it is in the timings too.
    await panel.listeners.message({ type: 'getHistory', payload: { repositoryPath: '.', limit: 100, offset: 0, search: 'app' } });
    await waitFor(() => outputLines.some(line => / repositories listed$/.test(line)), 'the timings of listing');
    const steps = outputLines.filter(line => /^\+ *\d+ ms [a-z]/.test(line)).map(line => line.replace(/^\+ *\d+ ms /, ''));
    for (const step of ['page shown', 'history asked', 'history sent', 'history drawn', 'repositories listed']) {
      assert.ok(steps.includes(step), `no "${step}" in the timings: ${steps.join(', ')}`);
    }
    assert.ok(outputLines.some(line => /^\+ *\d+ ms {3}git log --max-count=101 .* \(\d+ ms\) in /.test(line)), 'no Git command in the timings');
    assert.ok(outputLines.some(line => /^\+ *\d+ ms {3}git log --topo-order .* \(\d+ ms\) in /.test(line)), 'no search in the timings');
    RepositoryManagerPanel.currentPanel.dispose();
    assert.equal(GitCommandService.observer, undefined, 'the timings kept watching Git after the dashboard closed');
    console.log('Dashboard open smoke passed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exit(1); });
