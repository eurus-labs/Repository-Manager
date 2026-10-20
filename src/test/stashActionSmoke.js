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
let inputs = [];
let picks = [];
const fakeVscode = {
  window: {
    async showWarningMessage(message, ...rest) {
      const modal = typeof rest[0] === 'object' && rest[0] && rest[0].modal;
      shown.push({ kind: modal ? 'confirm' : 'warning', message });
      return modal ? answer : undefined;
    },
    showInformationMessage(message) { shown.push({ kind: 'info', message }); },
    async showInputBox(options) { shown.push({ kind: 'input', message: options.title }); return inputs.shift(); },
    async showQuickPick(items, options) { shown.push({ kind: 'pick', message: options.title, items: items.map(item => item.label) }); return items[picks.shift()]; },
    showErrorMessage(message) { shown.push({ kind: 'error', message }); }
  },
  commands: { executeCommand() {} }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { handleStashAction, handleStashPush } = require('../../out/handlers/webviewMessageHandler.js');
const { CommitService } = require('../../out/services/commitService.js');
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
      runStashAction: (...args) => service.run(...args),
      pushStash: (...args) => service.push(...args),
      getWorkingTreeChanges: (...args) => new CommitService(new GitCommandService(repo.root)).getWorkingTreeChanges(...args)
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
      // Drop says the stash is gone (a history filtered to it must be cleared) but changed no files.
      assert.deepEqual(calls.posted.map(message => [message.type, message.payload.changedWorkingTree, message.payload.removedStash]),
        [['stashActionCompleted', false, true]]);

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

    // A -u stash whose untracked file is already in the way: Git restores the tracked edit, then stops
    // without a conflict. That is reported as partway, with the changes shown and the stash kept.
    {
      const repo = repository(); repos.push(repo);
      repo.write('tracked.txt', 'stashed edit\n');
      repo.write('new.txt', 'from the stash\n');
      repo.run('stash', 'push', '-u', '-m', 'partway');
      const hash = repo.run('rev-parse', 'stash@{0}');
      repo.write('new.txt', 'already here\n');
      const { ctx, calls } = context(repo);
      shown.length = 0;
      await handleStashAction(ctx, { repositoryPath: '.', stash: hash, operation: 'pop' });
      assert.equal(repo.read('tracked.txt'), 'stashed edit\n', 'the fixture no longer stops partway');
      assert.equal(repo.read('new.txt'), 'already here\n');
      assert.deepEqual(shown.map(item => item.kind), ['error']);
      assert.match(shown[0].message, /^Pop stash@\{0\} \(partway\) stopped partway: .*already exists.*Some of its changes are in the working tree; the stash is kept\.$/s);
      assert.equal(repo.stashes().length, 1);
      assert.deepEqual(calls.posted.map(message => [message.type, message.payload.changedWorkingTree, message.payload.removedStash]),
        [['stashActionCompleted', true, false]], 'a partly applied stash did not open the changes');
      assert.equal(calls.reloaded, 1, 'a partly applied stash did not reload the dashboard');
    }

    // Two clicks on Pop for stash@{1} at once: the second must not pop the stash that moved into
    // stash@{1} after the first, so the actions run one at a time and look the position up last.
    {
      const repo = repository(); repos.push(repo);
      repo.write('tracked.txt', 'older\n');
      repo.run('stash', 'push', '-m', 'older');
      const older = repo.run('rev-parse', 'stash@{0}');
      repo.write('tracked.txt', 'middle\n');
      repo.run('stash', 'push', '-m', 'middle');
      const middle = repo.run('rev-parse', 'stash@{0}');
      repo.write('tracked.txt', 'newer\n');
      repo.run('stash', 'push', '-m', 'newer');
      const newer = repo.run('rev-parse', 'stash@{0}');
      const { service } = context(repo);
      const [first, second] = await Promise.all([service.run('.', middle, 'drop'), service.run('.', middle, 'drop')]);
      assert.equal(first.success, true);
      assert.equal(second.success, false);
      assert.match(second.message, /no longer exists/);
      assert.deepEqual(repo.stashes().map(line => line.split(' ')[0]), [newer, older], 'a second click dropped another stash');
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
    // Stash Changes: a message, then whether to take new files; the working tree is clean after.
    {
      const repo = repository(); repos.push(repo);
      const { ctx, calls, service } = context(repo);
      repo.write('tracked.txt', 'edit\n');
      repo.run('add', 'tracked.txt');
      repo.write('other.txt', 'unstaged edit\n');
      repo.write('new.txt', 'new file\n');
      // Escape at the message asks nothing more and stashes nothing.
      shown.length = 0; inputs = [undefined];
      await handleStashPush(ctx, { repositoryPath: '.' });
      assert.deepEqual([repo.stashes().length, shown.map(item => item.kind)], [0, ['input']]);
      // Tracked changes only: the new file stays.
      shown.length = 0; inputs = ['half-done form']; picks = [1];
      await handleStashPush(ctx, { repositoryPath: '.' });
      assert.deepEqual(shown.find(item => item.kind === 'pick').items, ['Include new files (1 file)', 'Tracked changes only (2 files)']);
      assert.match(repo.stashes()[0], /On main: half-done form$/);
      assert.equal(repo.read('tracked.txt'), 'base\n');
      assert.equal(repo.read('other.txt'), 'other\n');
      assert.equal(repo.read('new.txt'), 'new file\n');
      assert.equal(repo.run('status', '--porcelain'), '?? new.txt');
      assert.match(shown.at(-1).message, /^Stashed the changes as stash@\{0\} \(half-done form\)\./);
      assert.deepEqual(calls.posted.at(-1), { type: 'stashActionCompleted', payload: { repositoryPath: '.', operation: 'push', changedWorkingTree: true, removedStash: false } });
      assert.equal(calls.reloaded, 1, 'the history and Stashes list were not reloaded');
      // Only new files left: Include them is the only choice; no message is fine.
      shown.length = 0; inputs = ['']; picks = [0];
      await handleStashPush(ctx, { repositoryPath: '.' });
      assert.deepEqual(shown.find(item => item.kind === 'pick').items, ['Include new files (1 file)']);
      assert.equal(repo.stashes().length, 2);
      assert.equal(repo.run('status', '--porcelain'), '', 'the new file was not stashed');
      assert.match(repo.run('stash', 'show', '--include-untracked', '--name-only', 'stash@{0}'), /new\.txt/);
      // Nothing left: said, and no question.
      shown.length = 0;
      await handleStashPush(ctx, { repositoryPath: '.' });
      assert.deepEqual(shown, [{ kind: 'error', message: 'Nothing to stash: there are no changes.' }]);
      // The service refuses tracked-only with only new files, and while files are in conflict.
      repo.write('another.txt', 'x\n');
      assert.match((await service.push('.', {})).message, /^Stash failed: Nothing to stash: there are no changes to tracked files/);
      repo.run('stash', 'push', '-u', '-m', 'clean slate');
      repo.write('tracked.txt', 'mine\n'); repo.run('commit', '-qam', 'mine');
      repo.run('checkout', '-q', '-b', 'side', 'HEAD~1'); repo.write('tracked.txt', 'theirs\n'); repo.run('commit', '-qam', 'theirs');
      assert.throws(() => repo.run('merge', 'main'));
      const refused = await service.push('.', { includeUntracked: true });
      assert.match(refused.message, /^Stash failed: A merge is in progress\. Finish or abort it before stashing\.$/);
      repo.run('merge', '--abort');
    }
    console.log('Stash action smoke passed');
  } finally {
    for (const repo of repos) rmSync(repo.root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
