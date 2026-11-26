const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Fetch Test', GIT_AUTHOR_EMAIL: 'fetch@example.com',
  GIT_COMMITTER_NAME: 'Fetch Test', GIT_COMMITTER_EMAIL: 'fetch@example.com'
});
const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-autofetch-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// Minimal vscode surface used by RepositoryManagerPanel.
const posted = [];
// Every editor tab the panel opens, by view type: the dashboard and the review tab.
const panels = new Map();
// What each tab's page would post to the host, by view type.
const receivers = new Map();
const rememberPanel = (viewType, panel) => { panels.set(viewType, panel); return panel; };
let panelVisible = true;
let viewStateListener = () => {};
const settings = { autoFetch: true, autoFetchInterval: 5, 'debug.timings': true };
// The lines of the Repository Manager Timings output.
const timingLines = [];
const noopEvent = () => ({ dispose() {} });
const fakeVscode = {
  ViewColumn: { One: 1 },
  Uri: { joinPath: (uri, ...parts) => ({ fsPath: path.join(uri.fsPath, ...parts), toString() { return this.fsPath; } }) },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine: line => timingLines.push(line) }),
    showInformationMessage() {}, showWarningMessage() {}, showErrorMessage() {},
    createWebviewPanel: viewType => rememberPanel(viewType, {
      get visible() { return panelVisible; },
      webview: {
        html: '', cspSource: 'test',
        asWebviewUri: uri => ({ scheme: 'test', toString: () => uri.fsPath }),
        postMessage: async message => { posted.push(message); return true; },
        onDidReceiveMessage: listener => { receivers.set(viewType, listener); return { dispose() {} }; }
      },
      onDidDispose: noopEvent,
      onDidChangeViewState: listener => { viewStateListener = listener; return { dispose() {} }; },
      reveal() {}, dispose() {}
    })
  },
  workspace: {
    workspaceFolders: [],
    getConfiguration: () => ({ get: (key, fallback) => (key in settings ? settings[key] : fallback) }),
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
Module._load = originalLoad;

async function waitFor(predicate, timeoutMs = 15000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for background fetch');
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

async function main() {
  try {
    const remote = path.join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', remote);
    const upstream = path.join(base, 'upstream');
    git(base, 'clone', '-q', remote, upstream);
    git(upstream, 'checkout', '-q', '-b', 'main');
    writeFileSync(path.join(upstream, 'f.txt'), '1\n');
    git(upstream, 'add', 'f.txt');
    git(upstream, 'commit', '-qm', 'base');
    git(upstream, 'push', '-q', 'origin', 'main');
    git(upstream, 'push', '-q', 'origin', 'main:old-feature');
    const local = path.join(base, 'local');
    git(base, 'clone', '-q', remote, local);
    // Deleted on the server; background fetch must not prune it, even with fetch.prune set.
    git(upstream, 'push', '-q', 'origin', '--delete', 'old-feature');
    git(local, 'config', 'fetch.prune', 'true');
    writeFileSync(path.join(upstream, 'f.txt'), '2\n');
    git(upstream, 'commit', '-qam', 'upstream change');
    git(upstream, 'push', '-q');

    // Hidden panel: no background fetch.
    panelVisible = false;
    RepositoryManagerPanel.createOrShow({ fsPath: base }, local);
    // Each tab has its own icon, in a light and a dark version that exist in resources.
    const { existsSync, readFileSync } = require('node:fs');
    const extensionRoot = path.join(__dirname, '..', '..');
    RepositoryManagerPanel.currentPanel._openReviewPanel();
    const icons = ['repositoryManager', 'repositoryManager.review'].map(viewType => {
      const icon = panels.get(viewType) && panels.get(viewType).iconPath;
      assert.ok(icon && icon.light && icon.dark, `the ${viewType} tab has no light and dark icon`);
      return [icon.light.fsPath, icon.dark.fsPath].map(file => path.relative(base, file));
    });
    assert.deepEqual(icons, [['resources/tab-icons/dashboard-light.svg', 'resources/tab-icons/dashboard-dark.svg'],
      ['resources/tab-icons/review-light.svg', 'resources/tab-icons/review-dark.svg']]);
    for (const file of icons.flat()) {
      const svg = readFileSync(path.join(extensionRoot, file), 'utf8');
      // A tab draws its icon as an image: the color is in the file, dark on light and light on dark.
      assert.match(svg, file.endsWith('-light.svg') ? /stroke="#424242"/ : /stroke="#C5C5C5"/, `${file} has the wrong color`);
      assert.doesNotMatch(svg, /currentColor/, `${file} relies on a color a tab does not give it`);
    }
    assert.ok(existsSync(path.join(extensionRoot, 'resources/tab-icons/review-dark.svg')));
    await new Promise(resolve => setTimeout(resolve, 1500));
    assert.equal(git(local, 'rev-parse', 'origin/main'), git(local, 'rev-parse', 'main'), 'fetched while hidden');

    // Becoming visible fetches, then pushes fresh ahead/behind counts to the webview.
    panelVisible = true;
    viewStateListener();
    await waitFor(() => posted.some(message => message.type === 'updateSubmodules'
      && message.payload.submodules.some(repository => repository.isParentRepo && repository.behind === 1)));
    assert.equal(git(local, 'rev-parse', 'origin/main'), git(upstream, 'rev-parse', 'HEAD'));
    assert.ok(git(local, 'branch', '-r').includes('origin/old-feature'), 'background fetch pruned a remote branch');

    // A branch click while an auto-fetch is running: the checkout does not wait for it; the update
    // from origin does, and uses its fetch instead of running a second one.
    git(upstream, 'checkout', '-q', '-b', 'x');
    git(upstream, 'push', '-q', 'origin', 'x');
    git(local, 'fetch', '-q', 'origin');
    git(local, 'branch', 'x', 'origin/x');
    writeFileSync(path.join(upstream, 'f.txt'), '3\n');
    git(upstream, 'commit', '-qam', 'ahead on x');
    git(upstream, 'push', '-q', 'origin', 'x');
    const originX = git(upstream, 'rev-parse', 'HEAD');
    assert.notEqual(git(local, 'rev-parse', 'x'), originX);
    const panel = RepositoryManagerPanel.currentPanel;
    let releaseFetch;
    let fetchEntered = false;
    const gate = new Promise(resolve => { releaseFetch = resolve; });
    const realFetch = panel._gitOps.fetchInBackground.bind(panel._gitOps);
    panel._gitOps.fetchInBackground = async repositoryPath => { fetchEntered = true; await gate; return realFetch(repositoryPath); };
    panel._lastAutoFetch = 1;
    viewStateListener();
    await waitFor(() => fetchEntered);
    posted.length = 0;
    const click = receivers.get('repositoryManager')({ type: 'checkoutBranch', payload: { submodule: '.', branch: 'x' } });
    await waitFor(() => posted.some(message => message.type === 'branchCheckoutResult'));
    assert.equal(posted.find(message => message.type === 'branchCheckoutResult').payload.success, true);
    assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'x', 'the checkout waited for the auto-fetch');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(posted.some(message => message.type === 'branchUpdateResult'), false, 'the update did not wait for the auto-fetch');
    // The page reports when the new history is drawn; the panel writes it into the switch's block.
    await receivers.get('repositoryManager')({ type: 'dashboardTiming', payload: { name: 'branch history drawn' } });
    assert.notEqual(git(local, 'rev-parse', 'x'), originX);
    assert.equal(timingLines.some(line => / git fetch origin /.test(line)), false, 'the update fetched while the auto-fetch was running');
    releaseFetch();
    await click;
    const update = posted.find(message => message.type === 'branchUpdateResult');
    assert.ok(update, 'no branchUpdateResult');
    assert.equal(update.payload.update, 'fast-forwarded', update.payload.message);
    assert.equal(git(local, 'rev-parse', 'x'), originX);
    const block = timingLines.slice(timingLines.findLastIndex(line => line.startsWith('--- Switching to x')));
    // The update fetches its own branch, after the auto-fetch has ended (a line is written when a process ends).
    const fetches = block.filter(line => / git fetch /.test(line));
    assert.equal(fetches.length, 2, `${fetches}`);
    assert.match(fetches[0], / git fetch --all /);
    assert.match(fetches[1], / git fetch origin \+refs\/heads\/x:refs\/remotes\/origin\/x /);
    // The marks of the switch, in order.
    const marks = ['click arrived', 'checkout done', 'result posted', 'branch history drawn', 'update ended: fast-forwarded'];
    const at = marks.map(mark => block.findIndex(line => line.endsWith(` ${mark}`)));
    assert.ok(at.every(index => index >= 0) && at.every((index, position) => position === 0 || index > at[position - 1]), `${at}\n${block.join('\n')}`);

    // The auto-fetch does not prune, so after it ran origin/x is still known here. Origin deletes x:
    // the click's own fetch notices, reports local-only and forgets that one stale ref.
    git(upstream, 'push', '-q', 'origin', ':x');
    assert.ok(git(local, 'branch', '-r').includes('origin/x'));
    posted.length = 0;
    await receivers.get('repositoryManager')({ type: 'checkoutBranch', payload: { submodule: '.', branch: 'x' } });
    assert.equal(posted.find(message => message.type === 'branchUpdateResult').payload.update, 'local-only');
    assert.equal(git(local, 'branch', '-r').includes('origin/x'), false, 'the stale origin/x is still there');
    assert.equal(git(local, 'symbolic-ref', '--short', 'HEAD'), 'x');

    RepositoryManagerPanel.currentPanel.dispose();
    console.log('Auto fetch panel smoke passed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
