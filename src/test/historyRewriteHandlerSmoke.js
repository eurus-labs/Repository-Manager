const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
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
    console.log('History rewrite handler smoke passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
