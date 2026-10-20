const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { LiveChanges, affectsRefs, affectsStatus, MAX_CHECKED_FILES } = require('../../out/liveChanges.js');
const { ignoredPaths } = require('../../out/services/ignoredPaths.js');

async function checkIgnoredPaths() {
  const base = mkdtempSync(path.join(tmpdir(), 'repository-manager-ignored-'));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com', GIT_ALLOW_PROTOCOL: 'file' };
  const git = (cwd, ...args) => execFileSync('git', ['-c', 'protocol.file.allow=always', ...args], { cwd, env, encoding: 'utf8' });
  try {
    const lib = path.join(base, 'lib-src');
    mkdirSync(lib);
    git(lib, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(lib, '.gitignore'), 'dist/\n');
    git(lib, 'add', '.');
    git(lib, 'commit', '-qm', 'lib');
    const root = path.join(base, 'w');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(root, '.gitignore'), 'out/\n*.log\n');
    writeFileSync(path.join(root, 'kept.log'), 'tracked\n');
    git(root, 'add', '.gitignore');
    git(root, 'add', '-f', 'kept.log');
    git(root, 'submodule', '-q', 'add', lib, 'lib');
    git(root, 'commit', '-qm', 'root');
    mkdirSync(path.join(root, 'out'));
    mkdirSync(path.join(root, 'lib', 'dist'));
    mkdirSync(path.join(root, 'lib', 'out'));
    const at = (...parts) => path.join(root, ...parts);
    const ignored = await ignoredPaths([at('out', 'a.js'), at('out'), at('b.log'), at('kept.log'), at('src.ts'),
      at('lib', 'dist', 'x.js'), at('lib', 'out', 'y.js'), at('lib', 'index.ts')], root);
    // Each file against its own repository's .gitignore; a tracked file that matches still shows.
    assert.deepEqual([...ignored].sort(), [at('b.log'), at('lib', 'dist', 'x.js'), at('out'), at('out', 'a.js')].sort());
    await assert.rejects(ignoredPaths([path.join(base, 'elsewhere.txt')], root), /Not in a repository/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function main() {
  await checkIgnoredPaths();
  // Which paths can change git status: files, and Git's index, HEAD and refs; not its internals.
  for (const file of ['/w/src/a.ts', '/w/.gitignore', '/w/.git/index', '/w/.git/HEAD', '/w/.git/refs/heads/main',
    '/w/.git/modules/lib/index', 'C:\\w\\.git\\index', '/w/lib/.git',
    // A submodule named after a nested path, packed refs, the local exclude file, a linked worktree.
    '/w/.git/modules/libs/foo/index', '/w/.git/modules/libs/foo/refs/heads/main', '/w/.git/packed-refs',
    '/w/.git/info/exclude', '/w/.git/worktrees/fix/index', '/w/.git/worktrees/fix/HEAD']) {
    assert.equal(affectsStatus(file), file !== '/w/lib/.git', file);
  }
  for (const file of ['/w/.git/objects/ab/cdef', '/w/.git/index.lock', '/w/.git/logs/HEAD', '/w/.git/FETCH_HEAD',
    '/w/.git/modules/lib/objects/12/34', '/w/.git/refs/heads/main.lock', '/w/.git/ORIG_HEAD',
    '/w/.git/modules/libs/foo/logs/refs/heads/main', '/w/.git/hooks/pre-commit']) {
    assert.equal(affectsStatus(file), false, file);
  }

  // A fake clock: timers run when the test says so.
  let now = 0;
  const timers = new Map();
  let next = 1;
  const advance = async ms => {
    now += ms;
    for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
    await new Promise(resolve => setImmediate(resolve));
  };
  let refreshes = 0;
  let canRefresh = true;
  let release;
  let slow = false;
  const live = new LiveChanges({
    refresh: () => { refreshes++; return slow ? new Promise(resolve => { release = resolve; }) : Promise.resolve(); },
    canRefresh: () => canRefresh,
    setTimer: (callback, ms) => { const id = next++; timers.set(id, { callback, at: now + ms }); return id; },
    clearTimer: id => timers.delete(id),
    now: () => now
  }, 800);

  // A burst of saves: one refresh, once they have been quiet for the delay.
  live.notify('/w/a.ts');
  await advance(500);
  live.notify('/w/b.ts');
  await advance(500);
  assert.equal(refreshes, 0, 'refreshed before the events settled');
  await advance(300);
  assert.equal(refreshes, 1);
  // Git's internal churn alone never refreshes.
  live.notify('/w/.git/objects/aa/bb');
  live.notify('/w/.git/index.lock');
  await advance(2000);
  assert.equal(refreshes, 1);

  // Hidden dashboard, or an action running: the refresh waits, then runs once on resume.
  canRefresh = false;
  live.notify('/w/a.ts');
  live.notify('/w/.git/index');
  await advance(1000);
  assert.equal(refreshes, 1);
  live.resume();
  await advance(0);
  assert.equal(refreshes, 1, 'refreshed while it could not');
  canRefresh = true;
  live.resume();
  await advance(0);
  assert.equal(refreshes, 2);
  live.resume();
  await advance(0);
  assert.equal(refreshes, 2, 'resume without new events refreshed again');

  // Events during a refresh ask for exactly one more, after it ends.
  slow = true;
  live.notify('/w/a.ts');
  await advance(800);
  assert.equal(refreshes, 3);
  live.notify('/w/b.ts');
  await advance(800);
  assert.equal(refreshes, 3, 'two refreshes ran at once');
  slow = false;
  release();
  await advance(0);
  await advance(0);
  assert.equal(refreshes, 4);

  // Our refresh's git status rewrites the index: that alone does not start another refresh,
  // for a moment after it; a ref change in that moment, or an index change later, still does.
  live.notify('/w/a.ts');
  await advance(800);
  assert.equal(refreshes, 5);
  live.notify('/w/.git/index');
  live.notify('/w/.git/modules/libs/foo/index');
  await advance(1000);
  assert.equal(refreshes, 5, 'the refresh refreshed itself');
  live.notify('/w/.git/refs/heads/main');
  await advance(800);
  assert.equal(refreshes, 6);
  await advance(2000);
  live.notify('/w/.git/index');
  await advance(800);
  assert.equal(refreshes, 7, 'a later staging was ignored');

  // With an ignore check: a batch of only ignored files (a build) does not refresh; one other file,
  // a Git change, a failed check, or too many files to check, does.
  let ignoredAnswer = paths => Promise.resolve(new Set(paths.filter(file => file.includes('/out/'))));
  let checks = 0;
  const filtered = new LiveChanges({
    refresh: () => { refreshes++; return Promise.resolve(); },
    canRefresh: () => true,
    setTimer: (callback, ms) => { const id = next++; timers.set(id, { callback, at: now + ms }); return id; },
    clearTimer: id => timers.delete(id),
    now: () => now,
    ignored: paths => { checks++; return ignoredAnswer(paths); }
  }, 800);
  const before = refreshes;
  filtered.notify('/w/out/a.js');
  filtered.notify('/w/out/b.js');
  await advance(800);
  assert.deepEqual([refreshes - before, checks], [0, 1], 'ignored build output refreshed');
  filtered.notify('/w/out/c.js');
  filtered.notify('/w/src/a.ts');
  await advance(800);
  assert.equal(refreshes - before, 1);
  filtered.notify('/w/out/d.js');
  filtered.notify('/w/.git/refs/heads/main');
  await advance(800);
  assert.deepEqual([refreshes - before, checks], [2, 2], 'a Git change was checked against .gitignore');
  await advance(2000);
  ignoredAnswer = () => Promise.reject(new Error('no git'));
  filtered.notify('/w/out/e.js');
  await advance(800);
  assert.equal(refreshes - before, 3, 'a failed check skipped the refresh');
  for (let index = 0; index <= MAX_CHECKED_FILES; index++) { filtered.notify(`/w/out/${index}.js`); }
  ignoredAnswer = paths => Promise.resolve(new Set(paths));
  await advance(800);
  assert.equal(refreshes - before, 4, 'a huge batch was not refreshed');
  filtered.dispose();

  // Disposed: nothing more.
  live.notify('/w/a.ts');
  live.dispose();
  await advance(5000);
  assert.equal(refreshes, 11);

  // A ref made, moved or deleted outside the dashboard (a branch from a terminal) is said to the refresh,
  // which HEAD alone does not show; a file save is not, and the next batch starts clean.
  for (const file of ['/w/.git/refs/heads/feature', '/w/.git/refs/heads/history-backup/drop-1', '/w/.git/packed-refs', '/w/.git/refs/stash',
    '/w/.git/refs/tags/v1', 'C:\\w\\.git\\refs\\heads\\x', '/w/.git/modules/lib/refs/heads/x']) {
    assert.equal(affectsRefs(file), true, file);
  }
  for (const file of ['/w/.git/refs/heads/x.lock', '/w/.git/logs/refs/heads/x', '/w/.git/HEAD', '/w/.git/index', '/w/src/refs/x.ts']) {
    assert.equal(affectsRefs(file), false, file);
  }
  const changes = [];
  const refs = new LiveChanges({
    refresh: change => { changes.push(change); return Promise.resolve(); },
    canRefresh: () => true,
    setTimer: (callback, ms) => { const id = next++; timers.set(id, { callback, at: now + ms }); return id; },
    clearTimer: id => timers.delete(id),
    now: () => now
  }, 800);
  refs.notify('/w/a.ts');
  refs.notify('/w/.git/refs/heads/from-terminal');
  await advance(800);
  refs.notify('/w/b.ts');
  await advance(800);
  assert.deepEqual(changes, [{ refsChanged: true }, { refsChanged: false }]);
  refs.dispose();
  console.log('Live changes smoke passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
