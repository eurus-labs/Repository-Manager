const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

// Discard Changes against real repositories: what goes back to HEAD, what is deleted, what is left
// alone, the copy kept first (and that its restore command works), and when nothing runs at all.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Discard Test', GIT_AUTHOR_EMAIL: 'discard@example.com',
  GIT_COMMITTER_NAME: 'Discard Test', GIT_COMMITTER_EMAIL: 'discard@example.com'
});
const shown = [];
let answer;
let infoAnswer; // the button chosen in the message after a discard (Undo)
const fakeVscode = {
  window: {
    async showWarningMessage(message, ...rest) {
      const options = typeof rest[0] === 'object' && rest[0] ? rest[0] : {};
      shown.push({ kind: options.modal ? 'confirm' : 'warning', message, detail: options.detail || '' });
      return options.modal ? answer : undefined;
    },
    showInformationMessage(message, ...items) { shown.push({ kind: 'info', message, items }); return Promise.resolve(infoAnswer); },
    showErrorMessage(message) { shown.push({ kind: 'error', message }); }
  },
  commands: { executeCommand() {} }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { handleDiscardChanges } = require('../../out/handlers/webviewMessageHandler.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { DiscardService, DISCARD_REF_PREFIX } = require('../../out/services/discardService.js');
const { HistoryService } = require('../../out/services/historyService.js');
const { CommitService } = require('../../out/services/commitService.js');
const { removeDiscardCopies } = require('../../out/commands/discardCommands.js');
Module._load = originalLoad;

const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-discard-'));
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const write = (root, file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
const read = (root, file) => readFileSync(path.join(root, file), 'utf8');
// Not trimmed at the start: a porcelain line can begin with a space (" M lib").
const status = root => execFileSync('git', ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '--untracked-files=all'],
  { cwd: root, encoding: 'utf8' }).trimEnd();

function repository(name) {
  const root = path.join(base, name);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  write(root, 'a.txt', 'a\n');
  write(root, 'b.txt', 'b\n');
  write(root, 'gone.txt', 'gone\n');
  write(root, 'tên có dấu cách.txt', 'base\n');
  write(root, '.gitignore', 'ignored.log\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  return root;
}

function context(root) {
  const service = new DiscardService(new GitCommandService(root));
  const calls = { reloaded: 0, refreshed: 0, posted: [] };
  const git = new GitCommandService(root);
  const ctx = {
    workspaceRoot: root,
    panel: { webview: { postMessage: async message => { calls.posted.push(message); return true; } } },
    gitOps: {
      planDiscard: (...args) => service.plan(...args),
      discardChanges: (...args) => service.discard(...args),
      restoreDiscarded: (...args) => service.restore(...args),
      resolveRepositoryPath: repositoryPath => git.resolveRepositoryPath(repositoryPath),
      getWorkingTreeChanges: repositoryPath => new CommitService(git).getWorkingTreeChanges(repositoryPath)
    },
    async reloadDashboardHistory(paths) { assert.deepEqual(paths, ['.']); calls.reloaded++; },
    async refresh() { calls.refreshed++; }
  };
  return { ctx, calls, service };
}

async function main() {
  try {
    // A rename restores both names, so its copy must include a recreated original path too.
    for (const recreated of [true, false, 'ignored']) {
      const renamedRoot = repository(`rename-undo-${recreated}`);
      const { service: renamedService } = context(renamedRoot);
      git(renamedRoot, 'mv', 'a.txt', 'renamed.txt');
      if (recreated) write(renamedRoot, 'a.txt', 'recreated original\n');
      if (recreated === 'ignored') write(renamedRoot, '.gitignore', 'ignored.log\na.txt\n');
      const discarded = await renamedService.discard('.', ['renamed.txt']);
      assert.equal(discarded.success, true, discarded.message);
      assert.equal(read(renamedRoot, 'a.txt'), 'a\n');
      assert.equal(existsSync(path.join(renamedRoot, 'renamed.txt')), false);
      if (recreated) assert.equal(git(renamedRoot, 'show', `${discarded.data.backup}:a.txt`), 'recreated original');
      const restored = await renamedService.restore('.', discarded.data.backup, discarded.data.changed);
      assert.equal(restored.success, true, restored.message);
      assert.equal(read(renamedRoot, 'renamed.txt'), 'a\n');
      if (recreated) assert.equal(read(renamedRoot, 'a.txt'), 'recreated original\n');
      else assert.equal(existsSync(path.join(renamedRoot, 'a.txt')), false);
    }

    // Undo compares with the discard's original HEAD, even after commits or a branch switch.
    // It still restores other selected files that have stayed at the original baseline.
    for (const after of ['commit', 'branch', 'unrelated-commit']) {
      const advancedRoot = repository(`undo-after-${after}`);
      const { service: advancedService } = context(advancedRoot);
      if (after === 'branch') {
        git(advancedRoot, 'checkout', '-qb', 'other');
        write(advancedRoot, 'a.txt', 'new branch contents\n');
        git(advancedRoot, 'commit', '-qam', 'change on other branch');
        git(advancedRoot, 'checkout', '-q', 'main');
      }
      write(advancedRoot, 'a.txt', 'discarded a\n');
      write(advancedRoot, 'b.txt', 'discarded b\n');
      const discarded = await advancedService.discard('.', ['a.txt', 'b.txt']);
      assert.equal(discarded.success, true, discarded.message);
      if (after === 'branch') git(advancedRoot, 'checkout', '-q', 'other');
      else {
        write(advancedRoot, after === 'commit' ? 'a.txt' : 'gone.txt', 'new committed contents\n');
        git(advancedRoot, 'commit', '-qam', 'edit after discard');
      }
      const restored = await advancedService.restore('.', discarded.data.backup, discarded.data.changed);
      assert.equal(restored.success, true, restored.message);
      assert.deepEqual(restored.data.kept, after === 'unrelated-commit' ? [] : ['a.txt']);
      assert.equal(read(advancedRoot, 'a.txt'), after === 'unrelated-commit' ? 'discarded a\n'
        : after === 'branch' ? 'new branch contents\n' : 'new committed contents\n');
      assert.equal(read(advancedRoot, 'b.txt'), 'discarded b\n');
      assert.equal(git(advancedRoot, 'diff', '--cached', '--name-only'), '', 'Undo changed the index');
    }

    // Preserve index-only edits and new files recreated after discard, including ignored paths.
    for (const after of ['staged', 'untracked', 'ignored']) {
      const editedRoot = repository(`undo-after-${after}`);
      const { service: editedService } = context(editedRoot);
      const file = after === 'staged' ? 'a.txt' : 'new.txt';
      write(editedRoot, file, 'discarded contents\n');
      const discarded = await editedService.discard('.', [file]);
      assert.equal(discarded.success, true, discarded.message);
      write(editedRoot, file, 'new contents\n');
      if (after === 'staged') {
        git(editedRoot, 'add', file);
        write(editedRoot, file, 'a\n'); // the worktree alone matches the baseline
      }
      if (after === 'ignored') write(editedRoot, '.gitignore', 'ignored.log\nnew.txt\n');
      const before = read(editedRoot, file);
      const restored = await editedService.restore('.', discarded.data.backup, discarded.data.changed);
      assert.equal(restored.success, false, restored.message);
      assert.deepEqual(restored.data.kept, [file]);
      assert.equal(read(editedRoot, file), before);
      if (after === 'staged') assert.equal(git(editedRoot, 'show', ':a.txt'), 'new contents');
    }

    // Every kind of change in one repository.
    const root = repository('main');
    const lib = path.join(base, 'lib-origin');
    mkdirSync(lib);
    git(lib, 'init', '-q', '-b', 'main');
    write(lib, 'lib.txt', '1\n');
    git(lib, 'add', '.');
    git(lib, 'commit', '-qm', 'lib 1');
    git(root, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'lib');
    git(root, 'commit', '-qm', 'add lib');
    write(path.join(root, 'lib'), 'lib.txt', '2\n');
    git(path.join(root, 'lib'), 'commit', '-qam', 'lib 2'); // the linked repository moved: a changed gitlink
    write(root, 'a.txt', 'a edited\n');                    // unstaged
    write(root, 'b.txt', 'b staged\n');
    git(root, 'add', 'b.txt');                             // staged
    write(root, 'added.txt', 'staged new\n');
    git(root, 'add', 'added.txt');                         // a new file, staged
    rmSync(path.join(root, 'gone.txt'));                   // deleted
    write(root, 'tên có dấu cách.txt', 'edited\n');        // a name Git would quote
    write(root, 'notes/new/idea.md', 'idea\n');            // new, in new folders
    write(root, 'ignored.log', 'keep me\n');               // ignored: never touched
    const nested = path.join(root, 'scratch');
    mkdirSync(nested);
    git(nested, 'init', '-q', '-b', 'main');               // a new nested repository
    write(nested, 'x.txt', 'x\n');
    git(nested, 'add', '.');
    git(nested, 'commit', '-qm', 'x');

    const { ctx, calls, service } = context(root);

    // One file: asked first, naming it; cancelling changes nothing.
    answer = undefined;
    shown.length = 0;
    const before = status(root);
    await handleDiscardChanges(ctx, { repositoryPath: '.', paths: ['a.txt'] });
    assert.equal(shown[0].kind, 'confirm');
    assert.equal(shown[0].message, 'Discard changes to a.txt?');
    assert.equal(shown[0].detail, 'a.txt\nIts staged and unstaged changes will be lost.\nA copy is kept first: Undo in the message that follows brings them back.');
    assert.equal(status(root), before, 'a cancelled Discard changed the working tree');
    assert.equal(calls.reloaded, 0);

    // Confirmed: only that file goes back. The dashboard hears at once (discardStarted), then gets
    // the new status and discardFinished; the history is not reloaded. The message offers Undo.
    answer = 'Discard';
    infoAnswer = 'Undo';
    shown.length = 0;
    await handleDiscardChanges(ctx, { repositoryPath: '.', paths: ['a.txt'] });
    assert.equal(read(root, 'b.txt'), 'b staged\n', 'another file was discarded');
    assert.deepEqual(calls.posted.map(message => message.type), ['discardStarted', 'workingTreeChangesLoaded', 'discardFinished']);
    assert.deepEqual(calls.posted[0].payload, { repositoryPath: '.', paths: ['a.txt'] });
    assert.equal(calls.posted[1].payload.purpose, 'dashboard');
    assert.ok(!calls.posted[1].payload.changes.some(change => change.path === 'a.txt'), 'the status after still lists a.txt');
    assert.equal(calls.posted[2].payload.success, true);
    assert.equal(calls.reloaded, 0, 'a discard reloaded the history');
    assert.deepEqual(shown.find(item => item.kind === 'info'), { kind: 'info', message: 'Discarded changes to a.txt.', items: ['Undo'] });
    // Undo (chosen above) brings the file back from the copy, as an unstaged change.
    for (let i = 0; i < 100 && read(root, 'a.txt') !== 'a edited\n'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(read(root, 'a.txt'), 'a edited\n', 'Undo did not bring the file back');
    for (let i = 0; i < 100 && shown.at(-1).message !== 'Brought back a.txt.'; i++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(shown.at(-1).message, 'Brought back a.txt.');
    infoAnswer = undefined;
    calls.posted.length = 0;

    // A new file: deleted, with the folders that only held it; the copy brings it back too.
    shown.length = 0;
    await handleDiscardChanges(ctx, { repositoryPath: '.', paths: ['notes/new/idea.md'] });
    assert.match(shown[0].detail, /This new file will be deleted\./);
    assert.equal(existsSync(path.join(root, 'notes')), false, 'empty folders were left behind');
    const newCopy = git(root, 'for-each-ref', '--sort=-refname', '--count=1', '--format=%(objectname)', DISCARD_REF_PREFIX);
    const undone = await service.restore('.', newCopy, ['notes/new/idea.md']);
    assert.equal(undone.success, true, undone.message);
    assert.equal(read(root, 'notes/new/idea.md'), 'idea\n');
    // Undo leaves a file edited since the discard as it is.
    write(root, 'a.txt', 'a edited\n');
    const copy = (await service.discard('.', ['a.txt'])).data.backup;
    write(root, 'a.txt', 'typed after\n');
    const editedSince = await service.restore('.', copy, ['a.txt']);
    assert.equal(editedSince.success, false);
    assert.match(editedSince.message, /a\.txt changed since the discard/);
    assert.equal(read(root, 'a.txt'), 'typed after\n');
    write(root, 'a.txt', 'a edited\n');
    assert.equal((await service.restore('.', 'not-a-sha', ['a.txt'])).success, false);

    // All: tracked files back to HEAD (staged, new and quoted names too), new files deleted; the
    // linked repository, the nested repository and ignored files are left alone and named.
    const plan = await service.plan('.');
    assert.deepEqual(plan.skipped.map(item => item.path).sort(), ['lib', 'scratch/']);
    answer = 'Discard All';
    shown.length = 0;
    // A file saved while the question is open was not in it, so it is not deleted.
    const asking = fakeVscode.window.showWarningMessage;
    fakeVscode.window.showWarningMessage = async (...args) => {
      write(root, 'saved-meanwhile.txt', 'not asked about\n');
      return asking(...args);
    };
    await handleDiscardChanges(ctx, { repositoryPath: '.', all: true });
    fakeVscode.window.showWarningMessage = asking;
    assert.equal(read(root, 'saved-meanwhile.txt'), 'not asked about\n', 'Discard all deleted a file it did not ask about');
    rmSync(path.join(root, 'saved-meanwhile.txt'));
    const confirm = shown[0];
    assert.equal(confirm.message, `Discard all 6 files changed in main?`);
    assert.match(confirm.detail, /^(\S.*\n){6}\n5 files go back to HEAD\.\n1 new file is deleted\./);
    assert.match(confirm.detail, /Left alone: lib \(a linked repository[^)]*\); scratch\/ \(a new Git repository[^)]*\)\./);
    const summary = shown.at(-1).message;
    // The question named what was left alone; the result names what was discarded.
    assert.equal(summary, 'Discarded changes to 6 files (1 new file deleted).');
    for (const [file, text] of [['a.txt', 'a\n'], ['b.txt', 'b\n'], ['gone.txt', 'gone\n'], ['tên có dấu cách.txt', 'base\n']]) {
      assert.equal(read(root, file), text, `${file} is not as at HEAD`);
    }
    assert.equal(existsSync(path.join(root, 'added.txt')), false, 'a staged new file was kept');
    assert.equal(read(root, 'ignored.log'), 'keep me\n', 'an ignored file was touched');
    assert.equal(existsSync(path.join(nested, '.git')), true, 'the nested repository was deleted');
    assert.equal(git(path.join(root, 'lib'), 'log', '-1', '--format=%s'), 'lib 2', 'the linked repository was moved');
    assert.deepEqual(status(root).split('\n').sort(), [' M lib', '?? scratch/']);

    // The copies are kept out of the dashboard's history.
    const backups = git(root, 'for-each-ref', '--format=%(objectname)', DISCARD_REF_PREFIX).split('\n').filter(Boolean);
    assert.equal(backups.length, 4);
    const history = await new HistoryService(new GitCommandService(root)).getHistory({ repositoryPath: '.', limit: 50, offset: 0 });
    assert.deepEqual(history.commits.map(commit => commit.subject), ['add lib', 'base']);

    // Only the newest 20 copies are kept.
    for (let index = 0; index < 25; index++) git(root, 'update-ref', `${DISCARD_REF_PREFIX}${1000000000000 + index}`, backups[0]);
    write(root, 'a.txt', 'again\n');
    await service.discard('.', ['a.txt']);
    const kept = git(root, 'for-each-ref', '--format=%(refname)', DISCARD_REF_PREFIX).split('\n').filter(Boolean);
    assert.equal(kept.length, 20);
    assert.ok(kept.every(ref => !ref.endsWith('1000000000000')), 'the oldest copy was kept');

    // A rename goes back on both sides.
    git(root, 'mv', 'b.txt', 'renamed.txt');
    await service.discard('.', ['renamed.txt']);
    assert.equal(read(root, 'b.txt'), 'b\n');
    assert.equal(existsSync(path.join(root, 'renamed.txt')), false);

    // Nothing runs while a merge is paused, nor before the first commit.
    git(root, 'checkout', '-q', '-b', 'other');
    write(root, 'a.txt', 'other\n');
    git(root, 'commit', '-qam', 'other');
    git(root, 'checkout', '-q', 'main');
    write(root, 'a.txt', 'main\n');
    git(root, 'commit', '-qam', 'main');
    assert.throws(() => git(root, 'merge', 'other'));
    const paused = status(root);
    const refused = await service.discard('.', ['a.txt']);
    assert.equal(refused.success, false);
    assert.match(refused.message, /A merge is in progress\. Finish or abort it before discarding changes\./);
    assert.equal(status(root), paused);
    git(root, 'merge', '--abort');

    const empty = path.join(base, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '-q', '-b', 'main');
    write(empty, 'first.txt', 'first\n');
    const unborn = await new DiscardService(new GitCommandService(empty)).discard('.', ['first.txt']);
    assert.equal(unborn.success, false);
    assert.match(unborn.message, /no commit yet/);
    assert.equal(read(empty, 'first.txt'), 'first\n');

    // A new symbolic link is deleted itself; the file it points to, outside the repository, stays.
    const outside = path.join(base, 'outside.txt');
    writeFileSync(outside, 'keep\n');
    symlinkSync(outside, path.join(root, 'link.txt'));
    const linked = await service.discard('.', ['link.txt']);
    assert.equal(linked.success, true, linked.message);
    assert.equal(existsSync(path.join(root, 'link.txt')), false);
    assert.equal(readFileSync(outside, 'utf8'), 'keep\n', 'the link\'s target was deleted');

    // Remove Discard Copies: asks first, naming each repository's count, then lets them all go.
    const copiesBefore = git(root, 'for-each-ref', '--format=%(refname)', DISCARD_REF_PREFIX).split('\n').filter(Boolean).length;
    assert.ok(copiesBefore > 1);
    const copyGit = { getParentRepoInfo: async () => ({ name: 'main', path: '.', status: 'modified' }),
      // An uninitialized linked repository is not read; one that fails to list is skipped.
      getSubmodules: async () => [{ name: 'lib', path: 'lib', status: 'uninitialized' }, { name: 'broken', path: 'broken', status: 'clean' }],
      listDiscardCopies: async repositoryPath => { if (repositoryPath === 'broken') throw new Error('no repo'); return service.listCopies(repositoryPath); },
      removeDiscardCopies: (...args) => service.removeCopies(...args) };
    const asked = [];
    const told = [];
    const copiesUi = answer => ({ confirm: async (message, detail, action) => { asked.push([message, detail, action]); return answer; },
      notify: (message, isError) => told.push([message, Boolean(isError)]) });
    await removeDiscardCopies(copyGit, copiesUi(false));
    assert.deepEqual(asked[0].slice(0, 1), [`Remove ${copiesBefore} copies kept by Discard?`]);
    assert.match(asked[0][1], new RegExp(`^main: ${copiesBefore} copies\\n\\nUndo of those discards will no longer work\\.`));
    assert.equal(git(root, 'for-each-ref', '--format=%(refname)', DISCARD_REF_PREFIX).split('\n').filter(Boolean).length, copiesBefore, 'declining removed copies');
    await removeDiscardCopies(copyGit, copiesUi(true));
    assert.deepEqual(told, [[`Removed ${copiesBefore} copies in main.`, false]]);
    assert.equal(git(root, 'for-each-ref', '--format=%(refname)', DISCARD_REF_PREFIX), '');
    // Only discard copies: a review snapshot's ref, or a branch, is never touched.
    assert.equal(await service.removeCopies('.', ['refs/heads/main', 'refs/repository-manager/snapshots/x']), 0);
    assert.equal(git(root, 'rev-parse', '--verify', '-q', 'refs/heads/main').length, 40);
    await removeDiscardCopies(copyGit, copiesUi(true));
    assert.deepEqual(told.at(-1), ['No discard copies to remove.', false]);

    // Anything else from the webview is ignored.
    shown.length = 0;
    await handleDiscardChanges(ctx, { repositoryPath: '.' });
    await handleDiscardChanges(ctx, { repositoryPath: '.', paths: [] });
    await handleDiscardChanges(ctx, { repositoryPath: 42, all: true });
    assert.deepEqual(shown, []);
    console.log('Discard smoke passed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
