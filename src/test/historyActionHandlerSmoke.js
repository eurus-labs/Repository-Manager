const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-handler-'));
const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
let warnings = 0;
let override;
let errors = [];
const fakeVscode = { window: {
  async showWarningMessage(message, options) {
    if (override) { return override(message, options); }
    warnings++;
    if (warnings === 1) {
      // Git's simulation names the conflict before anything changes.
      assert.match(options.detail, /^Predicted by Git: conflicts at [0-9a-f]{12} source edit in shared\.txt\. You resolve them in Source Control/);
      return 'Cherry pick';
    }
    assert.match(message, /Resolve conflicts/);
    writeFileSync(path.join(root, 'shared.txt'), 'resolved\n');
    run('add', 'shared.txt');
    run('cherry-pick', '--continue');
    return undefined;
  },
  showInformationMessage() {}, showErrorMessage(message) { errors.push(message); }
} };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { handleApplyHistoryCommit } = require('../../out/handlers/webviewMessageHandler.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { HistoryActionService } = require('../../out/services/historyActionService.js');
Module._load = originalLoad;

async function main() {
  try {
    run('init', '-q');
    run('config', 'user.name', 'History Handler Test');
    run('config', 'user.email', 'handler@example.com');
    writeFileSync(path.join(root, 'shared.txt'), 'base\n');
    run('add', 'shared.txt');
    run('commit', '-qm', 'base');
    const base = run('rev-parse', 'HEAD');
    run('switch', '-c', 'source');
    writeFileSync(path.join(root, 'shared.txt'), 'source\n');
    run('commit', '-qam', 'source edit');
    const source = run('rev-parse', 'HEAD');
    run('switch', '-c', 'target', base);
    writeFileSync(path.join(root, 'shared.txt'), 'target\n');
    run('commit', '-qam', 'target edit');
    let reloaded = 0;
    let refreshed = 0;
    const service = new HistoryActionService(new GitCommandService(root));
    const ctx = { workspaceRoot: root,
      gitOps: {
        describeHistoryCommit: (...args) => service.describe(...args),
        applyHistoryCommit: (...args) => service.apply(...args),
        abortHistoryAction: (...args) => service.abort(...args)
      },
      async reloadDashboardHistory(paths) { assert.deepEqual(paths, ['.']); reloaded++; },
      async refresh() { refreshed++; }
    };
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', commit: source, operation: 'cherry-pick' });
    assert.equal(warnings, 2);
    assert.equal(reloaded, 1, 'continued cherry-pick must reload history');
    assert.equal(refreshed, 1);
    assert.equal(await service.pendingOperation('.'), undefined);
    assert.notEqual(run('rev-parse', 'HEAD'), base);

    // An untracked file at a path the action writes is refused before any confirm modal.
    run('switch', '-q', '-c', 'side', base);
    writeFileSync(path.join(root, 'side.txt'), 'side\n');
    run('add', 'side.txt');
    run('commit', '-qm', 'side commit');
    const side = run('rev-parse', 'HEAD');
    run('switch', '-q', 'target');
    const targetHead = run('rev-parse', 'HEAD');
    const details = [];
    override = (message, options) => { details.push(options.detail); return 'Cherry pick'; };
    writeFileSync(path.join(root, 'side.txt'), 'mine\n');
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', commit: side, operation: 'cherry-pick' });
    assert.equal(details.length, 0, 'no confirm modal for a refused action');
    assert.equal(errors.length, 1);
    assert.match(errors[0], /These untracked files would be overwritten by cherry-pick: side\.txt\./);
    assert.equal(run('rev-parse', 'HEAD'), targetHead);
    rmSync(path.join(root, 'side.txt'));

    // An unrelated untracked file does not block, and the confirm text says so.
    writeFileSync(path.join(root, 'notes.local'), 'mine\n');
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', commit: side, operation: 'cherry-pick' });
    assert.equal(details.length, 1);
    assert.match(details[0], /Changes to tracked files must be committed or stashed first; untracked files stay as they are\. Conflicts can be resolved in Source Control\./);
    assert.notEqual(run('rev-parse', 'HEAD'), targetHead);
    assert.equal(readFileSync(path.join(root, 'notes.local'), 'utf8'), 'mine\n');

    // Merging a named branch: the question lists the incoming commits (first 20 and the count), says fast-forward
    // when it is one, and the merge message names the branch.
    const targetName = run('symbolic-ref', '--short', 'HEAD');
    run('switch', '-q', '-c', 'inc');
    for (let n = 1; n <= 22; n++) {
      writeFileSync(path.join(root, `inc${n}.txt`), `${n}\n`);
      run('add', '.');
      run('commit', '-qm', `inc ${n}`);
    }
    const incTip = run('rev-parse', 'HEAD');
    run('switch', '-q', targetName);
    const seen = [];
    override = (message, options) => { seen.push({ message, detail: options.detail }); return 'Merge'; };
    errors = [];
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', operation: 'merge', branch: 'inc' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].message, `Merge inc into ${targetName} in .?`);
    assert.match(seen[0].detail, /^Fast-forward: no merge commit is made\. Incoming commits \(22\):\n/);
    assert.equal(seen[0].detail.split('\n').filter(line => /^[0-9a-f]{12} inc \d+$/.test(line)).length, 20, 'the first 20 are listed');
    assert.match(seen[0].detail, /\n… and 2 more\n/);
    assert.equal(run('rev-parse', 'HEAD'), incTip, 'a fast-forward moves to the branch tip');

    // Already in HEAD: nothing to merge, no question, nothing runs.
    seen.length = 0;
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', operation: 'merge', branch: 'inc' });
    assert.equal(seen.length, 0);
    assert.match(errors.at(-1), new RegExp(`Nothing to merge: inc is already in ${targetName}\\.`));

    // A real merge: one incoming commit, no fast-forward, and the merge commit names the branch.
    run('switch', '-q', '-c', 'div', base);
    writeFileSync(path.join(root, 'div.txt'), 'div\n');
    run('add', '.');
    run('commit', '-qm', 'div commit');
    const divTip = run('rev-parse', 'HEAD');
    run('switch', '-q', targetName);
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', operation: 'merge', branch: 'div' });
    assert.equal(seen.length, 1);
    assert.match(seen[0].detail, /^Incoming commits \(1\):\n[0-9a-f]{12} div commit\n/);
    assert.doesNotMatch(seen[0].detail, /Fast-forward/);
    assert.equal(run('log', '-1', '--format=%s'), `Merge branch 'div' into ${targetName}`);
    assert.equal(run('rev-parse', 'HEAD^2'), divTip);

    // The branch moves while the question is open: nothing runs.
    run('branch', 'div2', base);
    run('switch', '-q', 'div2');
    writeFileSync(path.join(root, 'div2.txt'), 'div2\n');
    run('add', '.');
    run('commit', '-qm', 'div2 commit');
    const div2Tip = run('rev-parse', 'HEAD');
    run('switch', '-q', targetName);
    const headBeforeMove = run('rev-parse', 'HEAD');
    errors = [];
    override = () => {
      run('update-ref', 'refs/heads/div2', run('commit-tree', run('rev-parse', `${div2Tip}^{tree}`), '-p', div2Tip, '-m', 'div2 moved'));
      return 'Merge';
    };
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', operation: 'merge', branch: 'div2' });
    assert.equal(errors.length, 1);
    assert.match(errors[0], /Branch div2 moved while the question was open\. Nothing was run; start the merge again\./);
    assert.equal(run('rev-parse', 'HEAD'), headBeforeMove);

    // Untracked files that the branch would write are refused before the question, with the file named.
    run('switch', '-q', '-c', 'clasher', base);
    writeFileSync(path.join(root, 'clash3.txt'), 'tracked\n');
    run('add', '.');
    run('commit', '-qm', 'clasher adds clash3');
    run('switch', '-q', targetName);
    writeFileSync(path.join(root, 'clash3.txt'), 'mine\n');
    seen.length = 0;
    errors = [];
    override = (message, options) => { seen.push(options.detail); return 'Merge'; };
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', operation: 'merge', branch: 'clasher' });
    assert.equal(seen.length, 0);
    assert.match(errors[0], /These untracked files would be overwritten by merge: clash3\.txt\./);
    rmSync(path.join(root, 'clash3.txt'));
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', operation: 'merge', branch: '--abort' });
    assert.match(errors.at(-1), /Invalid branch name\./);

    // A label's kind keeps its namespace: a local branch called origin/topic beside refs/remotes/origin/topic.
    const commitOn = (name, file, from) => {
      run('switch', '-q', '-c', name, from);
      writeFileSync(path.join(root, file), `${name}\n`);
      run('add', file);
      run('commit', '-qm', `${name} commit`);
      const sha = run('rev-parse', 'HEAD');
      run('switch', '-q', targetName);
      return sha;
    };
    const topicA = commitOn('tmp-a', 'topic-a.txt', base);
    const topicB = commitOn('tmp-b', 'topic-b.txt', base);
    run('branch', 'origin/topic', topicA);
    run('update-ref', 'refs/remotes/origin/topic', topicB);
    const beforeTopic = run('rev-parse', 'HEAD');
    override = () => 'Merge';
    for (const [kind, expected] of [['remote', topicB], ['local', topicA], [undefined, topicA]]) {
      run('reset', '-q', '--hard', beforeTopic);
      await handleApplyHistoryCommit(ctx, { repositoryPath: '.', operation: 'merge', branch: 'origin/topic', kind });
      assert.equal(run('rev-parse', 'HEAD^2'), expected, `merge of a ${kind} label used the wrong ref`);
    }
    run('reset', '-q', '--hard', beforeTopic);

    // merge.ff=false: the question says a merge commit is made, and it is.
    const aheadTip = commitOn('ahead', 'ahead.txt', targetName);
    seen.length = 0;
    override = (message, options) => { seen.push(options.detail); return 'Merge'; };
    run('config', 'merge.ff', 'false');
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', operation: 'merge', branch: 'ahead', kind: 'local' });
    assert.equal(seen.length, 1);
    assert.doesNotMatch(seen[0], /Fast-forward/);
    assert.match(seen[0], /^A merge commit will be made \(merge\.ff=false\)\. Incoming commits \(1\):/);
    assert.equal(run('rev-parse', 'HEAD^2'), aheadTip, 'merge.ff=false makes a two-parent commit');

    // merge.ff=only with a diverged branch: refused before the question, nothing runs.
    run('reset', '-q', '--hard', beforeTopic);
    commitOn('diverged', 'diverged.txt', base);
    run('config', 'merge.ff', 'only');
    seen.length = 0;
    errors = [];
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', operation: 'merge', branch: 'diverged', kind: 'local' });
    assert.equal(seen.length, 0);
    assert.match(errors[0], new RegExp(`^merge\\.ff=only: diverged cannot be fast-forwarded into ${targetName}, so Git would refuse this merge\\.`));
    assert.equal(run('rev-parse', 'HEAD'), beforeTopic);
    run('config', '--unset', 'merge.ff');
    console.log('History action handler smoke passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
