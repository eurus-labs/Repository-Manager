const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { BranchService } = require('../../out/services/branchService.js');

// Ignore the developer's global Git config, for this process and the git it spawns.
Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Checkout Test', GIT_AUTHOR_EMAIL: 'checkout@example.com',
  GIT_COMMITTER_NAME: 'Checkout Test', GIT_COMMITTER_EMAIL: 'checkout@example.com'
});
const bases = [];
const env = process.env;
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

// upstream pushes to the bare remote; local is a second clone that checks branches out.
function setup() {
  const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-checkout-'));
  bases.push(base);
  const remote = path.join(base, 'remote.git');
  git(base, 'init', '-q', '--bare', '-b', 'main', remote);
  const upstream = path.join(base, 'upstream');
  git(base, 'clone', '-q', remote, upstream);
  git(upstream, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(upstream, 'f.txt'), '1\n');
  git(upstream, 'add', 'f.txt');
  git(upstream, 'commit', '-qm', 'base');
  git(upstream, 'push', '-q', 'origin', 'main');
  git(upstream, 'checkout', '-q', '-b', 'x');
  git(upstream, 'push', '-q', 'origin', 'x');
  git(upstream, 'checkout', '-q', 'main');
  const local = path.join(base, 'local');
  git(base, 'clone', '-q', remote, local);
  return { base, remote, upstream, local };
}
function commit(repo, file, content, message) {
  writeFileSync(path.join(repo, file), content);
  git(repo, 'add', file);
  git(repo, 'commit', '-qm', message);
}
/** Commit on x in upstream and push it, leaving upstream on main. */
function pushOnX(repos, file, content, message) {
  git(repos.upstream, 'checkout', '-q', 'x');
  commit(repos.upstream, file, content, message);
  git(repos.upstream, 'push', '-q', 'origin', 'x');
  const head = git(repos.upstream, 'rev-parse', 'HEAD');
  git(repos.upstream, 'checkout', '-q', 'main');
  return head;
}
function service(repo, calls) {
  const cmd = new GitCommandService(repo);
  if (calls) {
    const run = cmd.execGitRaw.bind(cmd);
    cmd.execGitRaw = (args, ...rest) => { calls.push(args); return run(args, ...rest); };
  }
  return new BranchService(cmd);
}
/**
 * A click: the checkout step, then (when it says the update is pending) the update step, as the
 * handler runs them. Returns the update's result, or the checkout's when there is nothing to update
 * or the checkout failed.
 */
async function checkout(repo, branch, calls, updateOptions) {
  const branches = service(repo, calls);
  const switched = await branches.switchBranch('.', branch);
  if (!switched.success || !switched.data || switched.data.update !== 'pending') return switched;
  return branches.updateBranch('.', branch, updateOptions);
}
const outcome = result => result.data && result.data.update;
const currentBranch = repo => git(repo, 'symbolic-ref', '--short', 'HEAD');

async function main() {
  try {
    // Behind: the fetch runs, so commits pushed after local's last fetch arrive and x fast-forwards.
    let repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    pushOnX(repos, 'f.txt', '2\n', 'two');
    let pushed = pushOnX(repos, 'f.txt', '3\n', 'three');
    let result = await checkout(repos.local, 'x');
    assert.equal(result.success, true, result.message);
    assert.equal(outcome(result), 'fast-forwarded');
    assert.match(result.message, /Updated x by 2 commits from origin/);
    assert.equal(currentBranch(repos.local), 'x');
    assert.equal(git(repos.local, 'rev-parse', 'HEAD'), pushed);

    // No local x: origin/x is known from the clone, then two more commits are pushed.
    repos = setup();
    pushOnX(repos, 'f.txt', '2\n', 'two');
    pushed = pushOnX(repos, 'f.txt', '3\n', 'three');
    assert.notEqual(git(repos.local, 'rev-parse', 'origin/x'), pushed);
    result = await checkout(repos.local, 'x');
    assert.equal(result.success, true, result.message);
    assert.equal(currentBranch(repos.local), 'x');
    assert.equal(git(repos.local, 'rev-parse', 'x'), pushed);
    assert.equal(git(repos.local, 'rev-parse', '--abbrev-ref', 'x@{upstream}'), 'origin/x');

    // Deleted on origin: the local branch is checked out as local-only.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    git(repos.upstream, 'push', '-q', 'origin', ':x');
    result = await checkout(repos.local, 'x');
    assert.equal(result.success, true, result.message);
    assert.equal(outcome(result), 'local-only');
    assert.equal(currentBranch(repos.local), 'x');

    // Ahead by 1: left alone.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    commit(repos.local, 'g.txt', 'a\n', 'local only');
    let before = git(repos.local, 'rev-parse', 'HEAD');
    git(repos.local, 'checkout', '-q', 'main');
    result = await checkout(repos.local, 'x');
    assert.equal(outcome(result), 'ahead');
    assert.match(result.message, /x has 1 commit not on origin/);
    assert.equal(git(repos.local, 'rev-parse', 'x'), before);

    // Diverged: 1 ahead, 1 behind.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    commit(repos.local, 'g.txt', 'a\n', 'local only');
    before = git(repos.local, 'rev-parse', 'HEAD');
    git(repos.local, 'checkout', '-q', 'main');
    pushOnX(repos, 'h.txt', 'b\n', 'remote only');
    result = await checkout(repos.local, 'x');
    assert.equal(result.success, true, result.message);
    assert.equal(outcome(result), 'diverged');
    assert.match(result.message, /1 ahead, 1 behind/);
    assert.equal(git(repos.local, 'rev-parse', 'x'), before);

    // Behind with an uncommitted change to a file the update touches: blocked, nothing touched.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    pushOnX(repos, 'f.txt', '2\n', 'two');
    const xBefore = git(repos.local, 'rev-parse', 'x');
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    writeFileSync(path.join(repos.local, 'f.txt'), 'dirty\n');
    result = await checkout(repos.local, 'x');
    assert.equal(result.success, true, result.message);
    assert.equal(outcome(result), 'blocked');
    assert.match(result.message, /not updated: local changes would be overwritten/);
    assert.equal(currentBranch(repos.local), 'x');
    assert.equal(git(repos.local, 'rev-parse', 'x'), xBefore);
    assert.equal(readFileSync(path.join(repos.local, 'f.txt'), 'utf8'), 'dirty\n');

    // The fetch fails (origin URL points nowhere): x is behind its last fetched origin/x and still fast-forwards to it.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    pushed = pushOnX(repos, 'f.txt', '2\n', 'two');
    git(repos.local, 'fetch', '-q', 'origin');
    const lastFetched = git(repos.local, 'rev-parse', 'origin/x');
    assert.equal(lastFetched, pushed);
    pushOnX(repos, 'f.txt', '3\n', 'three'); // never fetched by local
    git(repos.local, 'remote', 'set-url', 'origin', path.join(repos.base, 'missing.git'));
    assert.notEqual(git(repos.local, 'rev-parse', 'x'), lastFetched);
    result = await checkout(repos.local, 'x');
    assert.equal(result.success, true, result.message);
    assert.equal(outcome(result), 'fast-forwarded');
    assert.match(result.message, /Could not fetch origin; used origin\/x as last fetched/);
    assert.match(result.message, /Updated x by 1 commit from origin/);
    assert.equal(currentBranch(repos.local), 'x');
    assert.equal(git(repos.local, 'rev-parse', 'x'), lastFetched);

    // The checkout step alone: no fetch, no network. It checks out x at once, even though origin has
    // newer commits, and says the update is pending.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    const xTip = git(repos.local, 'rev-parse', 'x');
    pushOnX(repos, 'f.txt', '2\n', 'two');
    let steps = [];
    result = await service(repos.local, steps).switchBranch('.', 'x');
    assert.equal(result.success, true, result.message);
    assert.equal(result.data.update, 'pending');
    assert.equal(result.data.unchanged, false);
    assert.equal(currentBranch(repos.local), 'x');
    assert.equal(git(repos.local, 'rev-parse', 'x'), xTip);
    assert.deepEqual(steps.map(args => args[0]), ['for-each-ref', 'checkout'], JSON.stringify(steps));
    // The current branch: one process, nothing checked out.
    steps = [];
    result = await service(repos.local, steps).switchBranch('.', 'x');
    assert.equal(result.data.unchanged, true);
    assert.deepEqual(steps.map(args => args[0]), ['for-each-ref']);

    // A remote-only branch keeps the old order: fetch first, then create it from the fetched copy.
    repos = setup();
    pushed = pushOnX(repos, 'f.txt', '2\n', 'two');
    steps = [];
    result = await service(repos.local, steps).switchBranch('.', 'x');
    assert.equal(result.success, true, result.message);
    assert.equal(result.data.update, 'up-to-date');
    assert.equal(git(repos.local, 'rev-parse', 'x'), pushed);
    const order = steps.map(args => args[0]);
    assert.ok(order.indexOf('fetch') >= 0 && order.indexOf('fetch') < order.indexOf('checkout'), JSON.stringify(steps));

    // The command paths that wait for one message still get the checkout and the update together.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    pushed = pushOnX(repos, 'f.txt', '2\n', 'two');
    result = await service(repos.local).checkoutBranch('.', 'x');
    assert.equal(outcome(result), 'fast-forwarded', result.message);
    assert.equal(git(repos.local, 'rev-parse', 'HEAD'), pushed);

    // Guards before the merge. HEAD left the branch (a direct git checkout while the fetch ran):
    // main is not fast-forwarded onto origin/x, and the fetched origin/x stays.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    pushed = pushOnX(repos, 'f.txt', '2\n', 'two');
    const mainTip = git(repos.local, 'rev-parse', 'main');
    result = await service(repos.local).switchBranch('.', 'x');
    assert.equal(result.data.update, 'pending');
    git(repos.local, 'checkout', '-q', 'main');
    result = await service(repos.local).updateBranch('.', 'x');
    assert.equal(result.success, true, result.message);
    assert.equal(result.data.skipped, 'head-moved');
    assert.equal(git(repos.local, 'rev-parse', 'main'), mainTip);
    assert.notEqual(git(repos.local, 'rev-parse', 'x'), pushed);
    assert.equal(git(repos.local, 'rev-parse', 'origin/x'), pushed);

    // A merge in progress: no fast-forward.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    pushOnX(repos, 'f.txt', '2\n', 'two');
    const beforeMerge = git(repos.local, 'rev-parse', 'x');
    await service(repos.local).switchBranch('.', 'x');
    writeFileSync(path.join(repos.local, '.git', 'MERGE_HEAD'), `${git(repos.local, 'rev-parse', 'main')}\n`);
    result = await service(repos.local).updateBranch('.', 'x');
    assert.equal(result.data.skipped, 'operation-pending');
    assert.equal(git(repos.local, 'rev-parse', 'x'), beforeMerge);

    // A newer click: the update stops after its fetch.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    pushed = pushOnX(repos, 'f.txt', '2\n', 'two');
    await service(repos.local).switchBranch('.', 'x');
    result = await service(repos.local).updateBranch('.', 'x', { isLatest: () => false });
    assert.equal(result.data.skipped, 'newer-click');
    assert.notEqual(git(repos.local, 'rev-parse', 'x'), pushed);
    assert.equal(git(repos.local, 'rev-parse', 'origin/x'), pushed);

    // A running auto-fetch: the update waits for it to end, then runs its own fetch of the branch.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    pushed = pushOnX(repos, 'f.txt', '2\n', 'two');
    await service(repos.local).switchBranch('.', 'x');
    steps = [];
    let settled = false;
    result = await service(repos.local, steps).updateBranch('.', 'x', {
      settleAutoFetch: async () => { assert.equal(steps.some(args => args[0] === 'fetch'), false); settled = true; }
    });
    assert.equal(settled, true);
    assert.equal(outcome(result), 'fast-forwarded', result.message);
    assert.equal(steps.filter(args => args[0] === 'fetch').length, 1, JSON.stringify(steps));

    // A local-only branch: checked out without any fetch.
    repos = setup();
    git(repos.local, 'checkout', '-q', '-b', 'mine');
    git(repos.local, 'checkout', '-q', 'main');
    const calls = [];
    result = await checkout(repos.local, 'mine', calls);
    assert.equal(result.success, true, result.message);
    assert.equal(outcome(result), 'local-only');
    assert.equal(currentBranch(repos.local), 'mine');
    assert.equal(calls.some(args => args[0] === 'fetch'), false, JSON.stringify(calls));

    // The current branch, behind: fast-forwarded.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    pushed = pushOnX(repos, 'f.txt', '2\n', 'two');
    result = await checkout(repos.local, 'x');
    assert.equal(outcome(result), 'fast-forwarded');
    assert.equal(git(repos.local, 'rev-parse', 'HEAD'), pushed);

    // A branch that exists nowhere fails, with no branch change.
    repos = setup();
    result = await checkout(repos.local, 'nope');
    assert.equal(result.success, false);
    assert.equal(currentBranch(repos.local), 'main');

    // Reset to origin still replaces the local branch.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    commit(repos.local, 'g.txt', 'a\n', 'local only');
    const originX = git(repos.local, 'rev-parse', 'origin/x');
    result = await service(repos.local).checkoutBranch('.', 'x', true);
    assert.equal(result.success, true, result.message);
    assert.equal(git(repos.local, 'rev-parse', 'x'), originX);
    assert.equal(existsSync(path.join(repos.local, 'g.txt')), false);

    // A remote-only branch deleted on origin, with a tracked file of the same name: the click fails
    // and the file keeps its edit (a bare `checkout x` would restore it as a path).
    repos = setup();
    commit(repos.upstream, 'x', 'tracked\n', 'a file named like the branch');
    git(repos.upstream, 'push', '-q', 'origin', 'main');
    git(repos.local, 'pull', '-q', 'origin', 'main');
    git(repos.upstream, 'push', '-q', 'origin', ':x');
    writeFileSync(path.join(repos.local, 'x'), 'edited\n');
    result = await checkout(repos.local, 'x');
    assert.equal(result.success, false, result.message);
    assert.match(result.message, /x is no longer on origin/);
    assert.equal(currentBranch(repos.local), 'main');
    assert.equal(readFileSync(path.join(repos.local, 'x'), 'utf8'), 'edited\n');

    // A tag named like the branch does not stand in for it: x is behind and is fast-forwarded.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'checkout', '-q', 'main');
    pushed = pushOnX(repos, 'f.txt', '2\n', 'pushed');
    git(repos.local, 'fetch', '-q', 'origin');
    git(repos.local, 'tag', 'x', pushed);
    result = await checkout(repos.local, 'x');
    assert.equal(outcome(result), 'fast-forwarded', result.message);
    assert.equal(git(repos.local, 'rev-parse', 'refs/heads/x'), pushed);

    // merge.autoStash does not carry overlapping edits across the update: it stays blocked.
    repos = setup();
    git(repos.local, 'checkout', '-q', 'x');
    git(repos.local, 'config', 'merge.autoStash', 'true');
    const stashedBefore = git(repos.local, 'rev-parse', 'x');
    pushOnX(repos, 'f.txt', '2\n', 'pushed');
    writeFileSync(path.join(repos.local, 'f.txt'), 'dirty\n');
    result = await checkout(repos.local, 'x');
    assert.equal(outcome(result), 'blocked', result.message);
    assert.equal(git(repos.local, 'rev-parse', 'x'), stashedBefore);
    assert.equal(readFileSync(path.join(repos.local, 'f.txt'), 'utf8'), 'dirty\n');
    assert.equal(git(repos.local, 'stash', 'list'), '');
    console.log('Branch checkout smoke passed.');
  } finally {
    for (const base of bases) rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
