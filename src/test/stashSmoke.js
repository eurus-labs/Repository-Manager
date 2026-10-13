const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { GitOperations } = require('../../out/gitOperations');
const { GitCommandService } = require('../../out/services/gitCommandService');
const { ChangeContextService } = require('../../out/services/changeContextService');
const { ReviewSnapshotService } = require('../../out/services/reviewSnapshotService');
const { isStashSnapshot, parseStashSubject } = require('../../out/services/stashTarget');

// A stash is read as one change: with the untracked files `git stash -u` keeps in a third parent, and
// without the index and untracked-files commits in the history.
const identity = ['-c', 'user.name=Stash Test', '-c', 'user.email=stash@example.com'];
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-stash-'));
  const git = (...args) => execFileSync('git', [...identity, ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'tracked.txt'), 'one\n');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'add tracked');
  return { root, git };
}

async function main() {
  assert.deepEqual(parseStashSubject('On main: try this'), { branch: 'main', message: 'try this' });
  assert.deepEqual(parseStashSubject('WIP on feature/x: abc1234 add y'), { branch: 'feature/x', message: 'abc1234 add y' });
  assert.deepEqual(parseStashSubject('odd'), { branch: '', message: 'odd' });

  // A stash with a staged edit, an unstaged edit and an untracked file.
  const { root, git } = repo();
  fs.appendFileSync(path.join(root, 'tracked.txt'), 'staged\n');
  git('add', 'tracked.txt');
  fs.appendFileSync(path.join(root, 'tracked.txt'), 'unstaged\n');
  fs.writeFileSync(path.join(root, 'untracked.txt'), 'brand new\n');
  git('stash', 'push', '-u', '-q', '-m', 'wip: try');
  const stashSha = git('rev-parse', 'stash@{0}');
  const ops = new GitOperations(root);
  const detail = await ops.getCommitDetail('.', 'stash@{0}');
  assert.equal(detail.hash, stashSha);
  assert.deepEqual(detail.files.map(file => `${file.path}:${file.status}`), ['tracked.txt:modified', 'untracked.txt:added'],
    'the untracked file of a stash is missing');
  assert.deepEqual(detail.stash, { ref: 'stash@{0}', branch: 'main', message: 'wip: try' });
  assert.equal(detail.comparisonBaseHash, git('rev-parse', 'HEAD'), 'a stash is not compared with where it was made');
  const untrackedDiff = await ops.getFileDiff('.', stashSha, 'untracked.txt');
  assert.match(untrackedDiff.patch, /\+brand new/);
  assert.equal(untrackedDiff.commitHash, stashSha, 'the diff names the synthetic commit instead of the stash');
  assert.match((await ops.getFileDiff('.', stashSha, 'tracked.txt')).patch, /\+staged\n\+unstaged/);

  // Summaries and reviews see both files; the summary stays about the stash itself.
  const gitService = new GitCommandService(root);
  const packet = await new ChangeContextService(gitService).collect('.', stashSha);
  assert.equal(packet.targetSha, stashSha);
  assert.deepEqual(packet.patches.map(patch => patch.path), ['tracked.txt', 'untracked.txt']);
  // Its commits are the stash alone: Git's index and untracked-files commits are not there to cite.
  assert.deepEqual(packet.commits.map(commit => commit.hash), [stashSha], 'the summary lists the stash\'s internal commits');
  const snapshots = new ReviewSnapshotService(gitService);
  const snapshot = await snapshots.open('.', stashSha);
  assert.notEqual(snapshot.targetSha, stashSha);
  assert.equal((await snapshots.open('.', stashSha)).targetSha, snapshot.targetSha, 'the stash snapshot is not the same commit each time');
  assert.equal(git('rev-parse', `${snapshot.targetSha}^`), git('rev-parse', 'HEAD'), 'the stash snapshot is not on where the stash was made');
  assert.equal(git('show', `${snapshot.targetSha}:untracked.txt`), 'brand new');
  assert.equal(await isStashSnapshot(gitService, root, snapshot.targetSha), true);
  assert.equal(await isStashSnapshot(gitService, root, stashSha), false);
  assert.equal(git('status', '--porcelain'), '', 'reading the stash changed the working tree or index');
  assert.deepEqual(fs.readdirSync(path.join(root, '.git')).filter(name => name.includes('repository-manager-stash')), [], 'a temporary index was left behind');

  // The history shows the stash as one commit on its base: no index or untracked-files commits.
  const history = await ops.getHistory({ repositoryPath: '.', branch: 'stash@{0}' });
  assert.deepEqual(history.commits.map(commit => [commit.subject, commit.parentHashes.length]), [['On main: wip: try', 1], ['add tracked', 0]]);
  const all = await ops.getHistory({ repositoryPath: '.', includeRemotes: true });
  assert.equal(all.commits.some(commit => /^(index|untracked files) on main/.test(commit.subject)), false, 'Git\'s stash commits show in the history');

  // A stash without untracked files is already complete: it is read as it is.
  fs.appendFileSync(path.join(root, 'tracked.txt'), 'second\n');
  git('stash', 'push', '-q', '-m', 'plain');
  const plain = await ops.getCommitDetail('.', 'stash@{0}');
  assert.deepEqual(plain.files.map(file => file.path), ['tracked.txt']);
  assert.equal(plain.stash.ref, 'stash@{0}');
  assert.equal((await ops.getCommitDetail('.', stashSha)).stash.ref, 'stash@{1}', 'an older stash is not named by its place');
  // Its place moved, but it is the same stash: the commit it is read as (and reviews cached by it) stays.
  assert.equal((await snapshots.open('.', stashSha)).targetSha, snapshot.targetSha, 'a newer stash changed the commit an older one is read as');
  // An internal commit that is also somewhere the user went stays in the history: a branch on it,
  // or the revision the history was asked from.
  const indexCommit = git('rev-parse', `${stashSha}^2`);
  const subjects = page => page.commits.map(commit => commit.hash);
  assert.ok(subjects(await ops.getHistory({ repositoryPath: '.', branch: indexCommit })).includes(indexCommit), 'the commit asked for was hidden');
  git('branch', 'look-at-index', indexCommit);
  assert.ok(subjects(await ops.getHistory({ repositoryPath: '.', includeRemotes: true })).includes(indexCommit), 'a commit with a branch on it was hidden');
  git('branch', '-D', 'look-at-index');
  assert.equal(subjects(await ops.getHistory({ repositoryPath: '.', includeRemotes: true })).includes(indexCommit), false);
  assert.equal((await snapshots.open('.', git('rev-parse', 'stash@{0}'))).targetSha, git('rev-parse', 'stash@{0}'));

  // A merge with three parents that is not a stash is never rewritten, and keeps its parents in the history.
  const merge = repo();
  for (const name of ['a', 'b']) {
    merge.git('checkout', '-q', '-b', name, 'main');
    fs.writeFileSync(path.join(merge.root, `${name}.txt`), `${name}\n`);
    merge.git('add', `${name}.txt`);
    merge.git('commit', '-qm', `add ${name}`);
  }
  merge.git('checkout', '-q', 'main');
  fs.writeFileSync(path.join(merge.root, 'main.txt'), 'main\n'); // so the merge cannot fast-forward
  merge.git('add', 'main.txt');
  merge.git('commit', '-qm', 'add main');
  merge.git('merge', '-q', '--no-edit', 'a', 'b');
  const octopus = merge.git('rev-parse', 'HEAD');
  const mergeOps = new GitOperations(merge.root);
  const mergeDetail = await mergeOps.getCommitDetail('.', octopus);
  assert.equal(mergeDetail.parentHashes.length, 3);
  assert.equal(mergeDetail.stash, undefined);
  assert.equal((await new ReviewSnapshotService(new GitCommandService(merge.root)).open('.', octopus)).targetSha, octopus);
  assert.equal((await mergeOps.getHistory({ repositoryPath: '.' })).commits[0].parentHashes.length, 3);

  // A SHA-256 repository: the untracked files are read in with its own empty tree.
  const wide = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-stash-sha256-'));
  const wideGit = (...args) => execFileSync('git', [...identity, ...args], { cwd: wide, encoding: 'utf8' }).trim();
  wideGit('init', '-q', '--object-format=sha256', '-b', 'main');
  fs.writeFileSync(path.join(wide, 'a.txt'), 'a\n');
  wideGit('add', 'a.txt');
  wideGit('commit', '-qm', 'a');
  // `git stash` cannot save in a SHA-256 repository before Git 2.45 or so ("Cannot save the current
  // status"), so the stash is built as `git stash -u` builds it: three parents, in the stash reflog.
  const blob = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: wide, input: 'new\n', encoding: 'utf8' }).trim();
  const untrackedIndex = path.join(wide, '.git', 'untracked-index');
  const withIndex = (...args) => execFileSync('git', [...identity, ...args], { cwd: wide, encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: untrackedIndex } }).trim();
  withIndex('update-index', '--add', '--cacheinfo', `100644,${blob},new.txt`);
  const untrackedTree = withIndex('write-tree');
  fs.rmSync(untrackedIndex);
  const wideIndexCommit = wideGit('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'index on main: a');
  const untrackedCommit = wideGit('commit-tree', untrackedTree, '-m', 'untracked files on main: a');
  const wideStash = wideGit('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-p', wideIndexCommit, '-p', untrackedCommit, '-m', 'On main: wide');
  wideGit('update-ref', '--create-reflog', '-m', 'On main: wide', 'refs/stash', wideStash);
  const wideDetail = await new GitOperations(wide).getCommitDetail('.', 'stash@{0}');
  assert.equal(wideDetail.hash.length, 64);
  assert.deepEqual(wideDetail.files.map(file => file.path), ['new.txt'], 'a SHA-256 stash lost its untracked file');

  for (const dir of [root, merge.root, wide]) fs.rmSync(dir, { recursive: true, force: true });
  console.log('Stash smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
