const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-rewrite-ui-'));
const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
let typedName = 'wrong';
let promptDetail = '';
const fakeVscode = { window: {
  async showQuickPick(items) { return items.find(item => item.value === 'hard'); },
  async showWarningMessage(message, options, button) {
    assert.match(options.detail, /backup branch will be created/);
    assert.match(options.detail, /Commits affected \(1\)/);
    promptDetail = options.detail;
    return button;
  },
  async showInputBox() { return typedName; },
  showInformationMessage() {}, showErrorMessage(message) { throw new Error(message); }
} };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { handleRewriteHistoryCommit, handleResolveHistoryRebase } = require('../../out/handlers/webviewMessageHandler.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { HistoryRewriteService } = require('../../out/services/historyRewriteService.js');
Module._load = originalLoad;

async function main() {
  try {
    run('init', '-q');
    run('config', 'user.name', 'Rewrite Handler Test');
    run('config', 'user.email', 'rewrite-ui@example.com');
    writeFileSync(path.join(root, 'first.txt'), 'base\n');
    run('add', '.');
    run('commit', '-qm', 'base');
    const base = run('rev-parse', 'HEAD');
    const branch = run('symbolic-ref', '--short', 'HEAD');
    writeFileSync(path.join(root, 'second.txt'), 'later\n');
    run('add', '.');
    run('commit', '-qm', 'later');
    const head = run('rev-parse', 'HEAD');
    const service = new HistoryRewriteService(new GitCommandService(root));
    let refreshes = 0;
    let reloads = 0;
    const ctx = { workspaceRoot: root, gitOps: {
      previewHistoryRewrite: (...args) => service.preview(...args),
      executeHistoryRewrite: (...args) => service.execute(...args)
    },
    async refresh() { refreshes++; },
    async reloadDashboardHistory(paths) { assert.deepEqual(paths, ['.']); reloads++; }
    };
    const payload = { repositoryPath: '.', commit: base, action: 'reset' };
    await handleRewriteHistoryCommit(ctx, payload);
    assert.equal(run('rev-parse', 'HEAD'), head, 'wrong typed branch must cancel hard reset');
    assert.equal(reloads, 0);
    typedName = branch;
    await handleRewriteHistoryCommit(ctx, payload);
    assert.match(promptDetail, new RegExp(head));
    assert.doesNotMatch(promptDetail, /predict/i, 'a reset never conflicts, so it predicts nothing');
    assert.equal(run('rev-parse', 'HEAD'), base);
    assert.equal(reloads, 1);
    assert.equal(refreshes, 1);
    assert.equal(run('for-each-ref', '--format=%(objectname)', 'refs/heads/history-backup/'), head);
    fakeVscode.window.showErrorMessage = message => assert.match(message, /another conflict/);
    ctx.gitOps.resolveHistoryRebase = async () => {
      run('commit', '--allow-empty', '-qm', 'intermediate rebase commit');
      return { success: false, message: 'another conflict' };
    };
    await handleResolveHistoryRebase(ctx, { repositoryPath: '.', command: 'continue' });
    assert.equal(reloads, 2, 'a continue that advances HEAD must reload history even if it stops again');
    assert.equal(refreshes, 2);

    // A colliding untracked file is refused before any confirm modal; an unrelated one is not.
    const added = (() => {
      writeFileSync(path.join(root, 'clash.txt'), 'tracked\n');
      run('add', '.');
      run('commit', '-qm', 'add clash');
      const sha = run('rev-parse', 'HEAD');
      run('rm', '-q', 'clash.txt');
      run('commit', '-qm', 'remove clash');
      return sha;
    })();
    const headBeforeRefusal = run('rev-parse', 'HEAD');
    const shown = [];
    const refusals = [];
    fakeVscode.window.showErrorMessage = message => refusals.push(message);
    fakeVscode.window.showWarningMessage = async (message, options, button) => { shown.push(options.detail); return button; };
    writeFileSync(path.join(root, 'clash.txt'), 'mine\n');
    await handleRewriteHistoryCommit(ctx, { repositoryPath: '.', commit: added, action: 'reset', mode: 'hard' });
    assert.equal(shown.length, 0, 'no confirm modal for a refused action');
    assert.match(refusals[0], /These untracked files would be overwritten by reset: clash\.txt\./);
    assert.equal(run('rev-parse', 'HEAD'), headBeforeRefusal);
    assert.equal(readFileSync(path.join(root, 'clash.txt'), 'utf8'), 'mine\n');
    rmSync(path.join(root, 'clash.txt'));
    writeFileSync(path.join(root, 'notes.local'), 'mine\n');
    await handleRewriteHistoryCommit(ctx, { repositoryPath: '.', commit: added, action: 'reset', mode: 'mixed' });
    assert.equal(shown.length, 1);
    assert.match(shown[0], /Changes to tracked files must be committed or stashed first; untracked files stay as they are\./);
    assert.equal(run('rev-parse', 'HEAD'), added);
    assert.equal(readFileSync(path.join(root, 'notes.local'), 'utf8'), 'mine\n');

    // Rebase onto a named branch: the question names it, lists the commits that move, and predicts conflicts.
    run('reset', '--hard', '-q');
    rmSync(path.join(root, 'notes.local'), { force: true });
    const fork = run('rev-parse', 'HEAD');
    const commitFile = (file, subject) => { writeFileSync(path.join(root, file), `${subject}\n`); run('add', file); run('commit', '-qm', subject); };
    run('switch', '-q', '-c', 'feature/x');
    commitFile('x1.txt', 'x one');
    commitFile('x2.txt', 'x two');
    const xTip = run('rev-parse', 'HEAD');
    run('switch', '-q', branch);
    commitFile('own.txt', 'own commit');
    const ownBefore = run('rev-parse', 'HEAD');
    const asked = [];
    fakeVscode.window.showWarningMessage = async (message, options, button) => { asked.push({ message, detail: options.detail }); return button; };
    const reloadsBefore = reloads;
    await handleRewriteHistoryCommit(ctx, { repositoryPath: '.', action: 'rebase', ontoBranch: 'feature/x' });
    assert.equal(asked.length, 1);
    assert.equal(asked[0].message, `Rebase ${branch} onto feature/x?`);
    assert.match(asked[0].detail, /Onto: feature\/x, at [0-9a-f]{40} x two/);
    assert.match(asked[0].detail, /Commits affected \(1\):\n[0-9a-f]{12} own commit/);
    assert.match(asked[0].detail, /Predicted by Git: no conflicts/);
    assert.equal(run('rev-parse', 'HEAD~1'), xTip, "main's own commit sits on feature/x's tip");
    assert.equal(run('log', '-1', '--format=%s'), 'own commit');
    assert.equal(reloads, reloadsBefore + 1);

    // The branch moves while the question is open: nothing runs, and the message says so.
    run('reset', '--hard', '-q', ownBefore);
    asked.length = 0;
    const moved = [];
    fakeVscode.window.showErrorMessage = message => moved.push(message);
    fakeVscode.window.showWarningMessage = async (message, options, button) => {
      asked.push(message);
      const tree = run('rev-parse', `${xTip}^{tree}`);
      run('update-ref', 'refs/heads/feature/x', run('commit-tree', tree, '-p', xTip, '-m', 'x moved'));
      return button;
    };
    await handleRewriteHistoryCommit(ctx, { repositoryPath: '.', action: 'rebase', ontoBranch: 'feature/x' });
    assert.equal(asked.length, 1);
    assert.equal(run('rev-parse', 'HEAD'), ownBefore, 'a moved branch must not be rebased onto');
    assert.equal(moved.length, 1, 'a moved branch reports an error');
    assert.match(moved[0], /Branch feature\/x moved while the question was open\. Nothing was run; start the rebase again\./);
    run('update-ref', 'refs/heads/feature/x', xTip);

    // Commits already on origin: the question warns and the button says so; unpushed commits get neither.
    const origin = path.join(root, '..', `${path.basename(root)}-origin.git`);
    execFileSync('git', ['init', '-q', '--bare', origin]);
    run('remote', 'add', 'origin', origin);
    run('switch', '-q', '-c', 'pub', fork);
    commitFile('pub1.txt', 'pub one');
    run('push', '-q', 'origin', 'pub');
    commitFile('pub2.txt', 'pub two');
    const pubBefore = run('rev-parse', 'HEAD');
    const buttons = [];
    fakeVscode.window.showWarningMessage = async (message, options, ...items) => { buttons.push({ detail: options.detail, items }); return undefined; };
    await handleRewriteHistoryCommit(ctx, { repositoryPath: '.', action: 'rebase', ontoBranch: 'feature/x' });
    assert.equal(buttons.length, 1);
    assert.match(buttons[0].detail, /^1 of these commits are already on origin\. Rebasing rewrites them: you will have to force-push pub, and anyone who built on them must rebase too\.\n\n/);
    assert.match(buttons[0].detail, /Commits affected \(2\)/);
    assert.deepEqual(buttons[0].items, ['Rebase anyway']);
    assert.equal(run('rev-parse', 'HEAD'), pubBefore, 'declining runs nothing');
    run('switch', '-q', branch);
    buttons.length = 0;
    await handleRewriteHistoryCommit(ctx, { repositoryPath: '.', action: 'rebase', ontoBranch: 'feature/x' });
    assert.equal(buttons.length, 1);
    assert.doesNotMatch(buttons[0].detail, /already on origin/);
    assert.deepEqual(buttons[0].items, ['Rebase']);
    rmSync(origin, { recursive: true, force: true });
    run('remote', 'remove', 'origin');

    // A branch tip that adds a file which is untracked here is refused before the question, with the file named.
    run('switch', '-q', '-c', 'feature/y', fork);
    commitFile('clash2.txt', 'y adds clash2');
    run('switch', '-q', branch);
    writeFileSync(path.join(root, 'clash2.txt'), 'mine\n');
    asked.length = 0;
    moved.length = 0;
    fakeVscode.window.showWarningMessage = async (message, options, button) => { asked.push(message); return button; };
    await handleRewriteHistoryCommit(ctx, { repositoryPath: '.', action: 'rebase', ontoBranch: 'feature/y' });
    assert.equal(asked.length, 0, 'no question for a refused rebase');
    assert.match(moved[0], /These untracked files would be overwritten by rebase: clash2\.txt\./);
    assert.equal(run('rev-parse', 'HEAD'), ownBefore);
    rmSync(path.join(root, 'clash2.txt'));

    // A branch that does not exist, or a name that looks like an option, is refused too.
    moved.length = 0;
    await handleRewriteHistoryCommit(ctx, { repositoryPath: '.', action: 'rebase', ontoBranch: 'no/such' });
    await handleRewriteHistoryCommit(ctx, { repositoryPath: '.', action: 'rebase', ontoBranch: '--abort' });
    assert.match(moved[0], /Branch no\/such no longer exists\./);
    assert.match(moved[1], /Invalid branch name\./);
    assert.equal(asked.length, 0);
    console.log('History rewrite handler smoke passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
