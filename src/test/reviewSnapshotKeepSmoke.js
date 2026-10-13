const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { HistoryService } = require('../../out/services/historyService.js');
const { keepSnapshots, snapshotLocalChanges, SNAPSHOT_REF_PREFIX } = require('../../out/services/localChangesSnapshot.js');
const { ReviewController } = require('../../out/reviewController.js');
const { ReviewHistoryStore, MAX_PER_REPOSITORY } = require('../../out/reviewHistory.js');
const { stashDiffTarget } = require('../../out/services/stashTarget.js');

// A review of local changes reads a snapshot commit nothing points to, which `git gc` removes in
// time. While the review is saved, a ref keeps it, so its evidence and explanations still open.
const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-snapshot-keep-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
const kept = () => git('for-each-ref', '--format=%(refname)', SNAPSHOT_REF_PREFIX).split('\n').filter(Boolean);
const exists = sha => { try { execFileSync('git', ['cat-file', '-e', `${sha}^{commit}`], { cwd: repo, env, stdio: 'ignore' }); return true; } catch { return false; } };
// What `git gc` does once the default two weeks have passed, now.
const collectGarbage = () => git('-c', 'gc.reflogExpireUnreachable=now', '-c', 'gc.pruneExpire=now', 'gc', '--quiet', '--prune=now');

async function main() {
  try {
    git('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, 'app.js'), 'one\n');
    git('add', '.');
    git('commit', '-qm', 'one');
    const service = new GitCommandService(repo);
    const edit = async text => {
      fs.writeFileSync(path.join(repo, 'app.js'), text);
      return (await snapshotLocalChanges(service, repo)).snapshotSha;
    };

    // 1. Kept: a ref under the prefix, and gc leaves the commit. Let go: the ref goes, and so does the commit.
    const first = await edit('two\n');
    const second = await edit('three\n');
    await keepSnapshots(service, repo, [first, second, 'HEAD', 'f'.repeat(40)]);
    assert.deepEqual(kept().sort(), [`${SNAPSHOT_REF_PREFIX}${first}`, `${SNAPSHOT_REF_PREFIX}${second}`].sort(),
      'a name that is not a full hash, or a commit Git no longer has, got a ref');
    collectGarbage();
    assert.ok(exists(first) && exists(second), 'gc removed a kept snapshot');
    await keepSnapshots(service, repo, [second]);
    assert.deepEqual(kept(), [`${SNAPSHOT_REF_PREFIX}${second}`]);
    collectGarbage();
    assert.equal(exists(first), false, 'a snapshot let go was still kept');
    assert.equal(exists(second), true);
    // Only refs under the prefix are touched; branches and tags stay.
    git('tag', 'v1');
    await keepSnapshots(service, repo, []);
    assert.deepEqual(kept(), []);
    assert.equal(git('tag'), 'v1');
    assert.equal(git('branch', '--format=%(refname:short)'), 'main');

    // 2. The dashboard's history (all refs) leaves the kept snapshots out.
    await keepSnapshots(service, repo, [second]);
    const page = await new HistoryService(service).getHistory({ repositoryPath: '.', includeRemotes: true });
    assert.deepEqual(page.commits.map(commit => commit.subject), ['one'], 'a kept snapshot shows in the history');
    await keepSnapshots(service, repo, []);

    // 3. Through the controller: kept while its review is saved, let go when the review is deleted or
    //    pushed out of the history, and kept again when a saved review is opened.
    const state = new Map();
    const history = new ReviewHistoryStore({ get: key => state.get(key), update: async (key, value) => { state.set(key, JSON.parse(JSON.stringify(value))); } });
    const posts = [];
    // Like the real runner (ReviewSurveyService), a review reports the commit it read: for a stash with
    // untracked files, the commit stashDiffTarget builds rather than the stash.
    let reviewedAs = sha => sha;
    const controller = new ReviewController({
      workspaceRoot: () => repo, post: async message => { posts.push(message); }, ask: async () => undefined,
      alwaysConfirm: () => false, isConsentRemembered: () => true, rememberConsent: async () => {},
      createRunner: () => ({ review: async request => ({ request: { ...request, targetSha: await reviewedAs(request.targetSha) }, findings: [], policyResults: [], policyStatus: 'not_configured', limitations: [],
        coverage: { surveyed: 1, analyzed: 1, skipped: [], failed: [], complete: true } }) }),
      createCancellation: () => ({ token: { isCancellationRequested: false }, cancel() {}, dispose() {} }),
      copyText: async () => {}, saveText: async () => true, openText: async () => {}, notify: () => {},
      createFixModel: () => ({ request: async () => ({ response: {} }) }), isDirtyInEditor: () => false, workingTreeChanged: () => {},
      history
    });
    let requestId = 0;
    const start = payload => controller.handle({ type: 'startReview', payload: { requestId: ++requestId, repositoryPath: '.', ...payload } });
    const completed = () => posts.filter(message => message.type === 'reviewCompleted').at(-1).payload;
    fs.writeFileSync(path.join(repo, 'app.js'), 'local edit\n');
    await start({ scope: 'changes', kind: 'local' });
    const local = completed();
    const snapshot = local.result.request.targetSha;
    assert.deepEqual(kept(), [`${SNAPSHOT_REF_PREFIX}${snapshot}`]);
    collectGarbage();
    assert.ok(exists(snapshot), 'gc removed the snapshot of a saved review');
    // A review of a commit keeps nothing of its own, and leaves the snapshot kept.
    await start({ scope: 'branch', targetRevision: 'main' });
    assert.deepEqual(kept(), [`${SNAPSHOT_REF_PREFIX}${snapshot}`]);
    // Its ref removed by hand (or by another workspace): opening the saved review keeps it again.
    git('update-ref', '-d', `${SNAPSHOT_REF_PREFIX}${snapshot}`);
    await controller.handle({ type: 'openStoredReview', payload: { requestId: ++requestId, id: local.historyId } });
    assert.deepEqual(kept(), [`${SNAPSHOT_REF_PREFIX}${snapshot}`]);
    // Deleted from Past reviews: the snapshot is let go.
    await controller.handle({ type: 'deleteStoredReview', payload: { id: local.historyId, repositoryPath: '.' } });
    assert.deepEqual(kept(), []);
    // Pushed out by newer reviews: the history keeps the newest MAX_PER_REPOSITORY, and so do the refs.
    await start({ scope: 'changes', kind: 'local' });
    const again = completed().result.request.targetSha;
    assert.equal(again, snapshot, 'the same changes gave another snapshot');
    assert.deepEqual(kept(), [`${SNAPSHOT_REF_PREFIX}${snapshot}`]);
    for (let i = 0; i < MAX_PER_REPOSITORY; i++) await start({ scope: 'branch', targetRevision: 'main' });
    assert.equal(history.list(repo).some(entry => entry.context.kind === 'local'), false);
    assert.deepEqual(kept(), [], 'a snapshot outlived its review');

    // 4. A saved review of a stash with untracked files reads the commit stashDiffTarget builds: it is
    //    kept like a local snapshot, kept again when the review is opened, and let go with the review.
    fs.writeFileSync(path.join(repo, 'note.txt'), 'untracked\n');
    git('stash', 'push', '-u', '-q', '-m', 'wip');
    const stashSha = git('rev-parse', 'stash@{0}');
    reviewedAs = sha => stashDiffTarget(service, repo, sha);
    const stashSnapshot = await stashDiffTarget(service, repo, stashSha);
    assert.notEqual(stashSnapshot, stashSha);
    await start({ scope: 'branch', targetRevision: 'stash@{0}' });
    const stashReview = completed();
    assert.equal(stashReview.result.request.targetSha, stashSnapshot);
    assert.deepEqual(kept(), [`${SNAPSHOT_REF_PREFIX}${stashSnapshot}`], 'the commit a saved stash review read is not kept');
    collectGarbage();
    assert.ok(exists(stashSnapshot), 'gc removed the commit a saved stash review read');
    git('update-ref', '-d', `${SNAPSHOT_REF_PREFIX}${stashSnapshot}`);
    await controller.handle({ type: 'openStoredReview', payload: { requestId: ++requestId, id: stashReview.historyId } });
    assert.deepEqual(kept(), [`${SNAPSHOT_REF_PREFIX}${stashSnapshot}`], 'opening a saved stash review did not keep its commit again');
    await controller.handle({ type: 'deleteStoredReview', payload: { id: stashReview.historyId, repositoryPath: '.' } });
    assert.deepEqual(kept(), []);
    console.log('Review snapshot keep smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
