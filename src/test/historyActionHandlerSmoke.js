const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-handler-'));
const run = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
let warnings = 0;
const fakeVscode = { window: {
  async showWarningMessage(message, options) {
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
  showInformationMessage() {}, showErrorMessage() {}
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
    console.log('History action handler smoke passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
