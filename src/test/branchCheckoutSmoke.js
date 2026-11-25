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
const checkout = (repo, branch, calls) => service(repo, calls).checkoutBranch('.', branch);
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
    console.log('Branch checkout smoke passed.');
  } finally {
    for (const base of bases) rmSync(base, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
