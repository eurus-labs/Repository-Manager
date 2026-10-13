const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Apply, Pop and Drop from the dashboard, against real repositories: each acts on the stash whose
// hash the webview sent, whatever its stash@{n} is by then, and only Drop asks first.
const shown = [];
let answer;
const fakeVscode = {
  window: {
    async showWarningMessage(message, ...rest) {
      const modal = typeof rest[0] === 'object' && rest[0] && rest[0].modal;
      shown.push({ kind: modal ? 'confirm' : 'warning', message });
      return modal ? answer : undefined;
    },
    showInformationMessage(message) { shown.push({ kind: 'info', message }); },
    showErrorMessage(message) { shown.push({ kind: 'error', message }); }
  },
  commands: { executeCommand() {} }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { handleStashAction } = require('../../out/handlers/webviewMessageHandler.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { StashActionService } = require('../../out/services/stashActionService.js');
Module._load = originalLoad;

function repository() {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-stash-action-'));
  const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  run('init', '-q', '-b', 'main');
  run('config', 'user.name', 'Stash Action Test');
  run('config', 'user.email', 'stash@example.com');
  writeFileSync(path.join(root, 'tracked.txt'), 'base\n');
  writeFileSync(path.join(root, 'other.txt'), 'other\n');
  run('add', '.');
  run('commit', '-qm', 'base');
  const read = name => readFileSync(path.join(root, name), 'utf8');
  const write = (name, text) => writeFileSync(path.join(root, name), text);
  const stashes = () => run('stash', 'list', '--format=%H %gs').split('\n').filter(Boolean);
  return { root, run, read, write, stashes };
}

function context(repo) {
  const service = new StashActionService(new GitCommandService(repo.root));
  const calls = { posted: [], reloaded: 0, refreshed: 0 };
  const ctx = {
    workspaceRoot: repo.root,
    panel: { webview: { postMessage: async message => { calls.posted.push(message); return true; } } },
    gitOps: {
      describeStash: (...args) => service.describe(...args),
      runStashAction: (...args) => service.run(...args)
    },
    async reloadDashboardHistory(paths) { assert.deepEqual(paths, ['.']); calls.reloaded++; },
    async refresh() { calls.refreshed++; }
  };
  return { ctx, calls, service };
}

async function main() {
  const repos = [];
  try {
    // Pop a stash made with -u: tracked edits and the new file come back, and the stash goes.
    {
      const repo = repository(); repos.push(repo);
      repo.write('tracked.txt', 'stashed edit\n');
      repo.write('new.txt', 'new file\n');
      repo.run('stash', 'push', '-u', '-m', 'with new file');
      const hash = repo.run('rev-parse', 'stash@{0}');
      assert.equal(existsSync(path.join(repo.root, 'new.txt')), false);
      const { ctx, calls } = context(repo);
      shown.length = 0;
      await handleStashAction(ctx, { repositoryPath: '.', stash: hash, operation: 'pop' });
      assert.equal(repo.read('tracked.txt'), 'stashed edit\n');
      assert.equal(repo.read('new.txt'), 'new file\n', 'Pop left the untracked file behind');
      assert.deepEqual(repo.stashes(), [], 'Pop kept the stash');
      assert.deepEqual(shown.map(item => item.kind), ['info'], 'Pop asked before applying');
      assert.match(shown[0].message, /Popped stash@\{0\} \(with new file\)/);
      assert.deepEqual(calls.posted.map(message => message.type), ['stashActionCompleted']);
      assert.equal(calls.reloaded, 1);
      assert.equal(calls.refreshed, 1);
    }

    // Apply onto a dirty tree keeps both the local edit and the stash; Drop acts on the stash that
    // was selected even after a newer one moved it to stash@{1}, and only after it is confirmed.
    {
      const repo = repository(); repos.push(repo);
      repo.write('tracked.txt', 'older\n');
      repo.run('stash', 'push', '-m', 'older');
      const older = repo.run('rev-parse', 'stash@{0}');
      repo.write('tracked.txt', 'newer\n');
      repo.run('stash', 'push', '-m', 'newer');
      const newer = repo.run('rev-parse', 'stash@{0}');
      const { ctx, calls } = context(repo);

      repo.write('other.txt', 'local edit\n');
      shown.length = 0;
      await handleStashAction(ctx, { repositoryPath: '.', stash: older, operation: 'apply' });
      assert.equal(repo.read('tracked.txt'), 'older\n', 'Apply applied the wrong stash');
      assert.equal(repo.read('other.txt'), 'local edit\n', 'Apply lost a local edit');
      assert.equal(repo.stashes().length, 2, 'Apply removed the stash');
      assert.match(shown.at(-1).message, /Applied stash@\{1\} \(older\)/);
      repo.run('checkout', '--', '.');

      // Drop asks first; cancelling changes nothing.
      answer = undefined;
      shown.length = 0;
      calls.posted.length = 0;
      await handleStashAction(ctx, { repositoryPath: '.', stash: older, operation: 'drop' });
      assert.deepEqual(shown.map(item => item.kind), ['confirm']);
      assert.match(shown[0].message, /^Drop stash@\{1\} \(older\)\?$/);
      assert.equal(repo.stashes().length, 2, 'a cancelled Drop dropped the stash');
      answer = 'Drop stash';
      await handleStashAction(ctx, { repositoryPath: '.', stash: older, operation: 'drop' });
      assert.deepEqual(repo.stashes().map(line => line.split(' ')[0]), [newer], 'Drop dropped the wrong stash');
      assert.match(shown.at(-1).message, new RegExp(`git stash store ${older}`), 'Drop did not say how to restore it');
      assert.deepEqual(calls.posted, [], 'Drop opened the uncommitted changes');

      // A stash that is gone by the time the button is pressed is reported, not guessed at.
      shown.length = 0;
      await handleStashAction(ctx, { repositoryPath: '.', stash: older, operation: 'pop' });
      assert.deepEqual(shown.map(item => item.kind), ['error']);
      assert.match(shown[0].message, /no longer exists/);
      assert.equal(repo.stashes().length, 1);
    }

    // Pop that conflicts leaves the conflict to resolve and keeps the stash, as git stash pop does.
    {
      const repo = repository(); repos.push(repo);
      repo.write('tracked.txt', 'stashed\n');
      repo.run('stash', 'push', '-m', 'conflicting');
      const hash = repo.run('rev-parse', 'stash@{0}');
      repo.write('tracked.txt', 'committed since\n');
      repo.run('commit', '-qam', 'change the same line');
      const { ctx, calls, service } = context(repo);
      shown.length = 0;
      await handleStashAction(ctx, { repositoryPath: '.', stash: hash, operation: 'pop' });
      assert.deepEqual(shown.map(item => item.kind), ['warning']);
      assert.match(shown[0].message, /applied with conflicts in 1 file: resolve them in Source Control\. The stash is kept/);
      assert.equal(repo.stashes().length, 1, 'a conflicting Pop dropped the stash');
      assert.match(repo.read('tracked.txt'), /<<<<<<<.*\n/);
      assert.deepEqual(calls.posted.map(message => message.type), ['stashActionCompleted']);
      assert.equal(calls.reloaded, 1, 'the conflicted working tree was not reloaded');

      // With conflicts already in the tree nothing runs, and they are not taken for the stash's.
      const again = await service.run('.', hash, 'apply');
      assert.equal(again.success, false);
      assert.match(again.message, /^Resolve the conflicts in Source Control before applying stash@\{0\}/);
      assert.equal(again.data.changedWorkingTree, false);
    }

    // Git refuses, changing nothing, when a local edit is in the way: say why, keep the stash.
    {
      const repo = repository(); repos.push(repo);
      repo.write('tracked.txt', 'stashed\n');
      repo.run('stash', 'push', '-m', 'blocked');
      const hash = repo.run('rev-parse', 'stash@{0}');
      repo.write('tracked.txt', 'local edit in the way\n');
      const { ctx, calls } = context(repo);
      shown.length = 0;
      await handleStashAction(ctx, { repositoryPath: '.', stash: hash, operation: 'pop' });
      assert.deepEqual(shown.map(item => item.kind), ['error']);
      assert.match(shown[0].message, /^Pop stash@\{0\} \(blocked\) failed: .*overwritten/s);
      assert.equal(repo.read('tracked.txt'), 'local edit in the way\n');
      assert.equal(repo.stashes().length, 1);
      assert.deepEqual(calls.posted, []);
      assert.equal(calls.reloaded, 0);
    }

    // Anything the webview sends that is not one of the three actions is ignored.
    {
      const repo = repository(); repos.push(repo);
      repo.write('tracked.txt', 'kept\n');
      repo.run('stash', 'push', '-m', 'kept');
      const hash = repo.run('rev-parse', 'stash@{0}');
      const { ctx } = context(repo);
      shown.length = 0;
      await handleStashAction(ctx, { repositoryPath: '.', stash: hash, operation: 'clear' });
      await handleStashAction(ctx, { repositoryPath: '.', stash: 42, operation: 'drop' });
      assert.deepEqual(shown, []);
      assert.equal(repo.stashes().length, 1);
    }
    console.log('Stash action smoke passed');
  } finally {
    for (const repo of repos) rmSync(repo.root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
