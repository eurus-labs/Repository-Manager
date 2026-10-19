const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Confirm & Push after creating a branch: the branch is pushed by name, the history is reloaded so
// its origin/<branch> label shows, and a failed push says why.
const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-push-created-'));
const git = (cwd, ...args) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], {
  cwd,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
  env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Push Test', GIT_AUTHOR_EMAIL: 'push@example.com', GIT_COMMITTER_NAME: 'Push Test', GIT_COMMITTER_EMAIL: 'push@example.com' }
}).trim();

const infos = [];
const warnings = [];
const fakeVscode = { window: {
  showInformationMessage(message) { infos.push(message); },
  showWarningMessage(message) { warnings.push(message); },
  showErrorMessage() {}
} };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { handlePushCreatedBranches } = require('../../out/handlers/webviewMessageHandler.js');
const { GitOperations } = require('../../out/gitOperations.js');
Module._load = originalLoad;

async function main() {
  try {
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
    git(workspace, 'submodule', 'add', '-q', lib, 'lib');
    git(workspace, 'commit', '-qm', 'add lib');
    git(workspace, 'push', '-q', 'origin', 'main');

    const branch = 'task/ECPT-1-push-created';
    git(workspace, 'branch', branch);
    git(path.join(workspace, 'lib'), 'branch', branch);
    // The linked repository's remote is gone, so its push fails.
    git(path.join(workspace, 'lib'), 'remote', 'set-url', 'origin', path.join(base, 'missing-remote'));

    let refreshed = 0;
    const reloads = [];
    const ctx = { workspaceRoot: workspace, gitOps: new GitOperations(workspace), async refresh() { refreshed++; },
      async reloadDashboardHistory(paths) { reloads.push(paths); } };

    // Main stays checked out: the new branch is pushed by its name, not whatever is current.
    await handlePushCreatedBranches(ctx, { submodules: ['.', 'lib'], branchName: branch });
    assert.equal(git(workspace, 'rev-parse', `origin/${branch}`), git(workspace, 'rev-parse', branch), 'origin/<branch> was not created');
    assert.equal(git(remote, 'rev-parse', `refs/heads/${branch}`), git(workspace, 'rev-parse', branch));
    assert.equal(git(workspace, 'rev-parse', '--abbrev-ref', `${branch}@{upstream}`), `origin/${branch}`);
    assert.throws(() => git(remote, 'rev-parse', '--verify', 'refs/heads/HEAD'));
    // Only the repository that was pushed gets its history reloaded, so its new label shows.
    assert.deepEqual(reloads, [['.']]);
    assert.equal(refreshed, 1);
    // The warning names the repository that failed and Git's reason.
    assert.equal(infos.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], new RegExp(`Pushed '${branch}' to 1/2 remotes`));
    assert.match(warnings[0], /lib: Failed to push: .*missing-remote/);

    // Every push succeeding: one information message, and both histories reloaded.
    git(path.join(workspace, 'lib'), 'remote', 'set-url', 'origin', lib);
    await handlePushCreatedBranches(ctx, { submodules: ['.', 'lib'], branchName: branch });
    assert.equal(git(lib, 'rev-parse', `refs/heads/${branch}`), git(path.join(workspace, 'lib'), 'rev-parse', branch));
    assert.deepEqual(infos, [`Branch '${branch}' pushed to 2 remote(s)`]);
    assert.deepEqual(reloads.at(-1), ['.', 'lib']);

    // A message without a branch name pushes nothing.
    await handlePushCreatedBranches(ctx, { submodules: ['.'] });
    assert.equal(reloads.length, 2);
    assert.equal(refreshed, 2);
    console.log('Push created branches smoke passed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
