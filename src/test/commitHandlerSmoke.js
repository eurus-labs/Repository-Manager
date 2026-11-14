const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-commit-handler-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Commit Test', GIT_AUTHOR_EMAIL: 'commit@example.com', GIT_COMMITTER_NAME: 'Commit Test', GIT_COMMITTER_EMAIL: 'commit@example.com' };
Object.assign(process.env, env);
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim();

const shown = [];
const fakeVscode = { window: {
  showInformationMessage(message) { shown.push(['info', message]); },
  showErrorMessage(message) { shown.push(['error', message]); }
} };
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { messageHandlers } = require('../../out/handlers/webviewMessageHandler.js');
const { GitOperations } = require('../../out/gitOperations.js');
const usage = require('../../out/services/usageLog.js');
Module._load = originalLoad;

async function main() {
  try {
    const remote = path.join(base, 'remote.git');
    git(base, 'init', '-q', '--bare', '-b', 'main', remote);
    const repo = path.join(base, 'repo');
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(repo, 'a.txt'), '1\n');
    git(repo, 'add', 'a.txt');
    git(repo, 'commit', '-qm', 'base');
    git(repo, 'remote', 'add', 'origin', remote);

    const stored = new Map();
    const posted = [];
    const ctx = {
      panel: { webview: { postMessage: async message => { posted.push(message); return true; } } },
      gitOps: new GitOperations(repo), prManager: {}, workspaceRoot: repo,
      refresh: async () => {}, reloadDashboardHistory: async () => {},
      workspaceState: { get: key => stored.get(key), update: async (key, value) => { stored.set(key, value); } }
    };
    const last = type => posted.filter(message => message.type === type).at(-1).payload;
    const loadChanges = async () => {
      await messageHandlers.getWorkingTreeChanges(ctx, { repositoryPath: '.' });
      return last('workingTreeChangesLoaded');
    };

    // Issue #141: each status read is numbered when it starts, so a slow early read that answers
    // last still carries the lower number and the page can drop it.
    {
      const real = ctx.gitOps;
      let release;
      const slow = new Promise(resolve => { release = resolve; });
      let reads = 0;
      ctx.gitOps = Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
        getWorkingTreeChanges: async (...args) => { if (reads++ === 0) { await slow; } return real.getWorkingTreeChanges(...args); }
      });
      const first = messageHandlers.getWorkingTreeChanges(ctx, { repositoryPath: '.', purpose: 'dashboard' });
      const second = messageHandlers.getWorkingTreeChanges(ctx, { repositoryPath: '.', purpose: 'dashboard' });
      await second; release(); await first;
      const replies = posted.filter(message => message.type === 'workingTreeChangesLoaded').map(message => message.payload.sequence);
      assert.equal(replies.length, 2);
      assert.ok(replies[0] > replies[1], `the later-started read answered first with a higher number: ${replies}`);
      ctx.gitOps = real;
      posted.length = 0;
    }

    // Push after commit is off until it is used, then remembered for this repository.
    writeFileSync(path.join(repo, 'a.txt'), '2\n');
    assert.equal((await loadChanges()).pushAfterCommit, false);
    await messageHandlers.commitFiles(ctx, { repositoryPath: '.', files: ['a.txt'], message: 'second', push: true });
    let result = last('commitFilesResult');
    assert.deepEqual([result.success, result.pushed], [true, true], result.message);
    assert.match(result.message, /^Created commit [0-9a-f]+; pushed$/);
    assert.equal(git(remote, 'rev-parse', 'main'), git(repo, 'rev-parse', 'HEAD'), 'the commit was not pushed');
    assert.equal((await loadChanges()).pushAfterCommit, true);

    // A failed push keeps the commit and says that only the push failed.
    git(repo, 'remote', 'set-url', 'origin', path.join(base, 'missing.git'));
    writeFileSync(path.join(repo, 'a.txt'), '3\n');
    await messageHandlers.commitFiles(ctx, { repositoryPath: '.', files: ['a.txt'], message: 'third', push: true });
    result = last('commitFilesResult');
    assert.deepEqual([result.success, result.pushed], [true, false]);
    assert.match(result.message, /^Created commit [0-9a-f]+; not pushed: /);
    assert.equal(git(repo, 'log', '-1', '--format=%s'), 'third');
    assert.equal(shown.at(-1)[0], 'error', 'a failed push was reported as a success');

    // A commit from the dialog goes into the usage log: its timing, Copilot use and size, no message.
    const usageLog = new usage.UsageLog(path.join(base, 'usage', 'usage.jsonl'));
    usage.setUsageLog(usageLog);
    writeFileSync(path.join(repo, 'a.txt'), '3\nmore\n');
    await messageHandlers.commitFiles(ctx, { repositoryPath: '.', files: ['a.txt'], message: 'usage', push: false,
      metrics: { durationMs: 4200, copilot: true, editRatio: 0.25 } });
    const [entry] = usageLog.read();
    assert.deepEqual({ ...entry, at: undefined }, { at: undefined, kind: 'commit', durationMs: 4200, copilot: true, editRatio: 0.25, files: 1, lines: 1 });
    assert.equal(JSON.stringify(entry).includes('usage"') || JSON.stringify(entry).includes('a.txt'), false, 'the message or a path was recorded');
    // Bad numbers from the page are not trusted; a failed commit is not recorded.
    await messageHandlers.commitFiles(ctx, { repositoryPath: '.', files: ['missing.txt'], message: 'nothing', metrics: { durationMs: -5, copilot: 'yes' } });
    assert.equal(usageLog.read().length, 1, 'a failed commit was recorded');
    writeFileSync(path.join(repo, 'a.txt'), '3\n');
    await messageHandlers.commitFiles(ctx, { repositoryPath: '.', files: ['a.txt'], message: 'odd', metrics: { durationMs: -5, copilot: 'yes', editRatio: 3 } });
    assert.deepEqual([usageLog.read()[1].durationMs, usageLog.read()[1].copilot, usageLog.read()[1].editRatio], [0, false, undefined]);
    // Align is recorded once a run, from the dashboard or from the Command Palette (the same Git call).
    await messageHandlers.syncVersions(ctx, { submodules: [] });
    await ctx.gitOps.syncAllSubmodules();
    assert.deepEqual(usageLog.read().filter(item => item.kind === 'align').map(item => [item.repositories, item.failed]), [[0, 0], [0, 0]]);
    usage.setUsageLog(undefined);

    // Unticked: no push, and the choice is remembered as off.
    writeFileSync(path.join(repo, 'a.txt'), '4\n');
    await messageHandlers.commitFiles(ctx, { repositoryPath: '.', files: ['a.txt'], message: 'fourth', push: false });
    result = last('commitFilesResult');
    assert.deepEqual([result.success, result.pushed], [true, undefined]);
    assert.equal((await loadChanges()).pushAfterCommit, false);

    // A failed commit never pushes.
    writeFileSync(path.join(repo, 'a.txt'), '5\n');
    git(repo, 'add', 'a.txt');
    writeFileSync(path.join(repo, 'a.txt'), '6\n');
    await messageHandlers.commitFiles(ctx, { repositoryPath: '.', files: ['a.txt'], message: 'no choice', push: true });
    result = last('commitFilesResult');
    assert.deepEqual([result.success, result.pushed], [false, undefined]);
    assert.match(result.message, /partly staged/);
    console.log('Commit handler smoke passed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
