const assert = require('node:assert/strict');
const { createHistoryState } = require('../../resources/dashboardHistory.js');
const { normalizeHistoryFilters } = require('../../resources/historyGraph.js');

const A = '/repo/a';
const B = '/repo/b';
const make = savedFilters => createHistoryState({ savedFilters, normalizeFilters: normalizeHistoryFilters });
const commit = n => ({ hash: `h${n}`, subject: `commit ${n}` });
const hashes = state => state.loadedCommits().map(item => item.hash);
const page = (state, repositoryPath, extra) => Object.assign({ repositoryPath, requestId: state.currentRequestId(), offset: 0, commits: [commit(1), commit(2)], nextOffset: 2, upstream: 'origin/main' }, extra);

// a) a page for an older request or another repository is ignored, and changes nothing.
{
  const state = make();
  const first = state.startLoad({ repositoryPath: A });
  assert.equal(first, 1);
  assert.ok(state.acceptPage(page(state, A), A));
  const second = state.startLoad({ repositoryPath: A });
  assert.equal(second, 2);
  assert.equal(state.acceptPage({ ...page(state, A), requestId: first, commits: [commit(9)] }, A), null, 'an older request id was accepted');
  assert.deepEqual(hashes(state), [], 'a fresh load starts with no commits');
  assert.equal(state.acceptPage(page(state, B), A), null, 'another repository was accepted');
  assert.equal(state.acceptPage(null, A), null);
  assert.equal(state.acceptPage(undefined, A), null);
}

// b) offset 0 replaces the commits and the upstream; an append adds only new hashes and returns them.
{
  const state = make();
  state.startLoad({ repositoryPath: A });
  assert.deepEqual(state.acceptPage(page(state, A), A), { append: false, renderedCount: 0, addedCommits: [] });
  assert.deepEqual(hashes(state), ['h1', 'h2']);
  assert.equal(state.loadedUpstream(), 'origin/main');
  assert.equal(state.currentNextOffset(), 2);
  assert.equal(state.canLoadMore(), true);
  state.startLoad({ append: true, repositoryPath: A });
  assert.equal(state.canLoadMore(), false, 'Load more is refused while a page is pending');
  const accepted = state.acceptPage(page(state, A, { offset: 2, commits: [commit(2), commit(3), commit(4)], nextOffset: null }), A);
  assert.deepEqual(accepted.addedCommits.map(item => item.hash), ['h3', 'h4'], 'an append added a known hash');
  assert.equal(accepted.renderedCount, 2);
  assert.equal(accepted.append, true);
  assert.deepEqual(hashes(state), ['h1', 'h2', 'h3', 'h4']);
  assert.equal(state.loadedUpstream(), 'origin/main', 'an append kept the upstream');
  assert.equal(state.canLoadMore(), false, 'Load more is refused at the end');
  state.startLoad({ repositoryPath: A });
  state.acceptPage(page(state, A, { commits: [commit(7)], upstream: undefined }), A);
  assert.deepEqual(hashes(state), ['h7'], 'offset 0 replaces the commits');
  assert.equal(state.loadedUpstream(), null, 'offset 0 replaces the upstream');
  assert.equal(state.findCommit('h7').subject, 'commit 7');
  assert.equal(state.findCommit('h1'), undefined);
  assert.equal(state.firstCommit().hash, 'h7');
  state.clearCommits();
  assert.equal(state.firstCommit(), null);
}

// c) a fresh load supersedes a pending append; a page for an older id arriving meanwhile leaves the pending flag.
{
  const state = make();
  state.startLoad({ repositoryPath: A });
  state.acceptPage(page(state, A), A);
  const id = state.startLoad({ append: true, repositoryPath: A });
  assert.equal(id, 1, 'an append keeps the request id');
  assert.equal(state.canLoadMore(), false);
  assert.equal(state.acceptPage({ ...page(state, A), requestId: 0, offset: 2 }, A), null);
  assert.equal(state.canLoadMore(), false, 'an ignored page cleared the pending flag');
  assert.equal(state.startLoad({ repositoryPath: A }), 2, 'a fresh load takes a new id');
  assert.equal(state.canLoadMore(), true, 'a fresh load left the superseded append pending');
  assert.equal(state.acceptPage({ ...page(state, A), requestId: 1, offset: 2, commits: [commit(5)] }, A), null, 'the superseded append was accepted');
}

// d) a failed append clears pending and says it was an append.
{
  const state = make();
  state.startLoad({ repositoryPath: A });
  state.acceptPage(page(state, A), A);
  state.startLoad({ append: true, repositoryPath: A });
  assert.equal(state.failPage(), true);
  assert.equal(state.canLoadMore(), true, 'the pending flag stayed after a failed append');
  assert.equal(state.failPage(), false, 'a second failure is not an append');
  state.startLoad({ repositoryPath: A });
  assert.equal(state.failPage(), false, 'a failed first page is not an append');
  assert.deepEqual(hashes(state), [], 'a failed page changed the commits');
}

// e) the viewport comes back once, only for its request and repository; preserving keeps the rows.
{
  const state = make();
  state.startLoad({ repositoryPath: A });
  state.acceptPage(page(state, A), A);
  const viewport = { commit: 'h2', offset: 12, scrollTop: 40 };
  const id = state.startLoad({ preserveViewport: true, viewport, repositoryPath: A });
  assert.deepEqual(hashes(state), ['h1', 'h2'], 'a preserving load cleared the commits');
  assert.equal(state.takeViewport({ requestId: id, repositoryPath: B }), null, 'another repository got the viewport');
  assert.equal(state.takeViewport({ requestId: id + 1, repositoryPath: A }), null, 'another request got the viewport');
  assert.equal(state.takeViewport(null), null);
  assert.deepEqual(state.takeViewport({ requestId: id, repositoryPath: A }), { commit: 'h2', offset: 12, scrollTop: 40, requestId: id, repositoryPath: A });
  assert.equal(state.takeViewport({ requestId: id, repositoryPath: A }), null, 'the viewport came back twice');
  state.startLoad({ preserveViewport: true, viewport, repositoryPath: A });
  state.startLoad({ repositoryPath: A });
  assert.equal(state.takeViewport({ requestId: state.currentRequestId() - 1, repositoryPath: A }), null, 'a new load kept the old viewport');
}

// f) filters: the old saved shape is restored, unknown values are normalized, kept across a reset, cleared by clear-all.
{
  const saved = { [A]: { branch: 'feature/x', includeRemotes: false, search: 'fix' }, [B]: { branch: 7, includeRemotes: 'yes', search: null } };
  const state = make(saved);
  assert.deepEqual(state.getFilters(A), { branch: 'feature/x', includeRemotes: false, search: 'fix', firstParent: false });
  assert.deepEqual(state.getFilters(B), { branch: '', includeRemotes: true, search: '', firstParent: false }, 'unknown values were not normalized');
  assert.deepEqual(state.getFilters('/unknown'), { branch: '', includeRemotes: true, search: '', firstParent: false });
  state.setFilters(A, { includeRemotes: true, search: 'new' });
  assert.deepEqual(state.getFilters(A), { branch: 'feature/x', includeRemotes: true, search: 'new', firstParent: false }, 'setting the page filters lost the revision');
  state.setRevision(B, 'main');
  state.setRevision(A, '');
  assert.deepEqual(state.getFilters(B), { branch: 'main', includeRemotes: true, search: '', firstParent: false });
  assert.equal(state.getFilters(A).branch, '');
  state.startLoad({ repositoryPath: A });
  state.acceptPage(page(state, A), A);
  state.reset();
  assert.deepEqual(hashes(state), []);
  assert.equal(state.currentNextOffset(), null);
  assert.equal(state.canLoadMore(), false);
  assert.equal(state.getFilters(B).branch, 'main', 'a reset dropped the filters');
  assert.deepEqual(Object.keys(state.snapshot()).sort(), [A, B].sort());
  assert.deepEqual(JSON.parse(JSON.stringify(state.snapshot()[B])), { branch: 'main', includeRemotes: true, search: '', firstParent: false });
  state.clearFilters();
  assert.deepEqual(state.snapshot(), {});
  assert.deepEqual(state.getFilters(B), { branch: '', includeRemotes: true, search: '', firstParent: false });
  assert.deepEqual(make(null).snapshot(), {});
  assert.deepEqual(make('x').snapshot(), {});
  // First parent only: kept per repository, read as off from a state saved before it existed.
  const withFirstParent = make({ [A]: { branch: '', includeRemotes: true, search: '', firstParent: true }, [B]: { branch: 'main', includeRemotes: true, search: '' } });
  assert.equal(withFirstParent.getFilters(A).firstParent, true);
  assert.equal(withFirstParent.getFilters(B).firstParent, false, 'an older saved state did not read as off');
  withFirstParent.setFilters(B, { includeRemotes: true, search: '', firstParent: true });
  assert.equal(withFirstParent.getFilters(B).firstParent, true);
  assert.equal(withFirstParent.getFilters(A).firstParent, true, 'another repository changed');
  withFirstParent.setFilters(A, { includeRemotes: true, search: '' });
  assert.equal(withFirstParent.getFilters(A).firstParent, false, 'a missing value did not turn it off');
  withFirstParent.setRevision(B, 'topic');
  assert.equal(withFirstParent.getFilters(B).firstParent, true, 'changing the revision lost the option');
  assert.equal(JSON.parse(JSON.stringify(withFirstParent.snapshot()))[B].firstParent, true, 'the option is not in the saved state');
}

// g) two instances share nothing; the factory reads historyGraph.js's normalizer from the global when none is passed.
{
  const one = make();
  const two = make();
  one.startLoad({ repositoryPath: A });
  one.acceptPage(page(one, A), A);
  one.setRevision(A, 'main');
  assert.deepEqual(hashes(two), []);
  assert.equal(two.currentRequestId(), 0);
  assert.equal(two.getFilters(A).branch, '');
  globalThis.RepositoryHistoryGraph = { normalizeHistoryFilters };
  assert.equal(createHistoryState({ savedFilters: { [A]: { branch: 'g' } } }).getFilters(A).branch, 'g');
  assert.equal(Object.isFrozen(require('../../resources/dashboardHistory.js')), true);
}

console.log('dashboardHistorySmoke ok');
