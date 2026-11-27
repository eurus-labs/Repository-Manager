// The branches that contain a commit (plan 19): real repositories, a bare origin, a wrapped
// GitCommandService that records every process, and the getCommitBranches handler.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return { window: {} };
  return originalLoad.call(this, request, parent, isMain);
};
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { listContainingBranches } = require('../../out/services/containingBranches.js');
const { handleGetCommitBranches, messageHandlers } = require('../../out/handlers/webviewMessageHandler.js');
Module._load = originalLoad;

const base = mkdtempSync(path.join(tmpdir(), 'rm-contain-'));
const work = path.join(base, 'work');
const bare = path.join(base, 'origin.git');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const run = (...args) => execFileSync('git', args, { cwd: work, encoding: 'utf8', env }).trim();
const commit = (file, text) => {
  writeFileSync(path.join(work, file), text);
  run('add', file);
  run('commit', '-qm', `edit ${file}`);
  return run('rev-parse', 'HEAD');
};
const names = branches => branches.map(branch =>
  `${branch.kind === 'remote' ? 'R:' : ''}${branch.name}${branch.current ? '*' : ''}${branch.onOrigin ? '+o' : ''}`);

class Recording extends GitCommandService {
  constructor(root) { super(root); this.calls = []; }
  async execGitRaw(args, ...rest) { this.calls.push(args); return super.execGitRaw(args, ...rest); }
}

async function main() {
  try {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare], { env });
    execFileSync('git', ['init', '-q', '-b', 'main', work], { env });
    run('config', 'user.name', 'T');
    run('config', 'user.email', 't@example.com');
    run('remote', 'add', 'origin', bare);
    const first = commit('a.txt', 'a\n');
    run('push', '-q', 'origin', 'main');
    run('branch', 'feature/a');
    run('push', '-q', 'origin', 'main:remote-only');
    run('push', '-q', 'origin', 'main:Only');
    run('push', '-q', 'origin', 'main:topic');
    run('fetch', '-q', 'origin');
    run('remote', 'set-head', 'origin', 'main');
    assert.ok(run('for-each-ref', 'refs/remotes/origin/HEAD'), 'origin/HEAD exists in this fixture');
    run('tag', 'feature/a', first); // a tag named like the branch feature/a: never listed, never a second chip
    run('branch', 'origin/topic', first); // a local branch literally named origin/topic, beside refs/remotes/origin/topic
    run('branch', 'only-later');
    run('switch', '-q', 'only-later');
    const later = commit('b.txt', 'b\n');

    const git = new Recording(work);
    // Checked out is only-later: first, then locals A-Z, then remote-only A-Z.
    const result = await listContainingBranches(git, '.', first);
    assert.deepEqual(names(result), [
      'only-later*', 'feature/a', 'main+o', 'origin/topic', 'R:origin/Only', 'R:origin/remote-only', 'R:origin/topic'
    ]);
    assert.equal(git.calls.filter(args => args[0] === 'for-each-ref').length, 1, 'one for-each-ref process');
    assert.deepEqual(git.calls.map(args => args[0]), ['rev-parse', 'for-each-ref'], 'only the validation and the one listing');
    assert.ok(!names(result).some(name => /HEAD/.test(name)), 'no origin/HEAD');
    assert.equal(names(result).filter(name => name === 'feature/a').length, 1, 'the tag feature/a added no chip');

    // A commit only on the checked-out branch, by full and by short sha.
    assert.deepEqual(names(await listContainingBranches(git, '.', later)), ['only-later*']);
    assert.deepEqual(names(await listContainingBranches(git, '.', later.slice(0, 8))), ['only-later*']);

    // The checked-out branch folds with its origin copy.
    run('switch', '-q', 'main');
    assert.equal(names(await listContainingBranches(git, '.', first))[0], 'main*+o');

    // A stash's internal commit is on no branch.
    writeFileSync(path.join(work, 'a.txt'), 'changed\n');
    run('stash', 'push', '-q');
    const stash = run('rev-parse', 'refs/stash');
    assert.deepEqual(await listContainingBranches(git, '.', stash), []);

    // Refused before Git runs.
    const calls = git.calls.length;
    for (const bad of ['--upload-pack=x', '-main', '', 'main', 'HEAD', `${first};x`, 'zz']) {
      await assert.rejects(() => listContainingBranches(git, '.', bad), /Invalid commit hash/, bad);
    }
    assert.equal(git.calls.length, calls, 'a refused hash ran no Git process');
    // A well-formed but unknown object is refused by resolveRevision.
    await assert.rejects(() => listContainingBranches(git, '.', 'deadbeef'));

    // The discard refs are never listed.
    run('update-ref', 'refs/repository-manager/discarded/1', first);
    assert.ok(!names(await listContainingBranches(git, '.', first)).some(name => /discard|repository-manager/.test(name)));

    // The handler: the same requestId back, branches on success, an error flag on failure.
    const sent = [];
    const ctx = {
      panel: { webview: { postMessage: async message => { sent.push(message); return true; } } },
      gitOps: { listContainingBranches: (repositoryPath, hash) => listContainingBranches(git, repositoryPath, hash) }
    };
    assert.equal(typeof messageHandlers.getCommitBranches, 'function');
    await messageHandlers.getCommitBranches(ctx, { repositoryPath: '.', commitHash: first, requestId: 7 });
    assert.equal(sent[0].type, 'commitBranchesLoaded');
    assert.equal(sent[0].payload.requestId, 7);
    assert.equal(sent[0].payload.commitHash, first);
    assert.equal(sent[0].payload.error, undefined);
    assert.equal(names(sent[0].payload.branches)[0], 'main*+o');
    await handleGetCommitBranches(ctx, { repositoryPath: '.', commitHash: '--upload-pack=x', requestId: 8 });
    assert.equal(sent[1].type, 'commitBranchesLoaded');
    assert.equal(sent[1].payload.requestId, 8);
    assert.equal(sent[1].payload.error, true);
    assert.match(sent[1].payload.message, /Invalid commit hash/);
    assert.ok(!sent.some(message => message.type === 'dashboardError'), 'the details are not affected');

    // It reads only: the panel lets it run during a background fetch.
    const panel = readFileSync(path.join(__dirname, '../repositoryManagerPanel.ts'), 'utf8');
    const start = panel.indexOf('const READ_ONLY_MESSAGES');
    assert.match(panel.slice(start, panel.indexOf(']);', start)), /'getCommitBranches'/);
    console.log('containingBranchesSmoke passed');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exit(1); });
