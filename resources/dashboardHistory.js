// State of the dashboard's History: which commits are loaded, the upstream, the request id, the next
// offset, whether a Load more page is on its way, the viewport to restore, and the filters per repository.
// Pure logic, no DOM and no messages: webview.js renders and posts. Loaded before webview.js
// (see src/webview/dashboardScripts.ts); also required by Node tests.
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RepositoryDashboardHistory = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  // savedFilters: the value restored from the webview state ({ [repositoryPath]: { branch, includeRemotes, search, firstParent } }).
  // normalizeFilters defaults to historyGraph.js's, read when called (that script loads first, but not at this one's load).
  function createHistoryState({ savedFilters, normalizeFilters } = {}) {
    const normalize = value => (normalizeFilters || root.RepositoryHistoryGraph.normalizeHistoryFilters)(value);
    let filters = savedFilters && typeof savedFilters === 'object' ? savedFilters : {};
    let commits = [];
    let upstream = null; // the checked-out branch's configured upstream, from the latest first page
    let requestId = 0;
    let nextOffset = null;
    let appendPending = false; // a Load more page is on its way (also started by scrolling)
    let viewport = null;

    function loadedCommits() { return commits; }
    function loadedUpstream() { return upstream; }
    function findCommit(hash) { return commits.find(commit => commit.hash === hash); }
    function firstCommit() { return commits.length ? commits[0] : null; }
    function currentRequestId() { return requestId; }
    function currentNextOffset() { return nextOffset; }
    function clearCommits() { commits = []; }

    // Another repository became active: its commits are not loaded yet. Filters stay per repository.
    function reset() {
      nextOffset = null;
      commits = [];
    }

    // Whether Load more may start: more commits exist and no page is on its way.
    function canLoadMore() { return nextOffset !== null && !appendPending; }

    // Starts a load and returns its request id. A fresh load supersedes a page on its way (its reply
    // will be dropped); an append keeps the id. A viewport to restore is kept for this request only.
    function startLoad({ append, preserveViewport, viewport: kept, repositoryPath } = {}) {
      if (!append && !preserveViewport) commits = [];
      appendPending = Boolean(append);
      if (!append) requestId += 1;
      viewport = kept ? Object.assign({}, kept, { requestId, repositoryPath }) : null;
      return requestId;
    }

    // Takes a history page. Null when it is ignored (another repository or an older request): nothing
    // changes, an append stays pending. Otherwise offset 0 replaces the commits and the upstream, an
    // append adds only commits not loaded yet; returns what the view needs to draw it.
    function acceptPage(payload, activeRepository) {
      if (!payload || payload.repositoryPath !== activeRepository || payload.requestId !== requestId) return null;
      const append = payload.offset > 0;
      if (append) appendPending = false;
      const renderedCount = commits.length;
      let addedCommits = [];
      if (append) {
        const known = new Set(commits.map(commit => commit.hash));
        addedCommits = (payload.commits || []).filter(commit => !known.has(commit.hash));
        commits = commits.concat(addedCommits);
      } else {
        commits = payload.commits || [];
        upstream = typeof payload.upstream === 'string' ? payload.upstream : null;
      }
      nextOffset = payload.nextOffset;
      return { append, renderedCount, addedCommits };
    }

    // A page failed: returns whether it was an append (the rows shown stay), and clears the pending flag.
    function failPage() {
      const wasAppend = appendPending;
      appendPending = false;
      return wasAppend;
    }

    // The viewport kept for a request, once, only for the same request and repository.
    function takeViewport(payload) {
      if (!viewport || !payload || viewport.requestId !== payload.requestId || viewport.repositoryPath !== payload.repositoryPath) return null;
      const taken = viewport;
      viewport = null;
      return taken;
    }

    function getFilters(repositoryPath) { return normalize(filters[repositoryPath]); }
    function setRevision(repositoryPath, revision) {
      filters[repositoryPath] = Object.assign({}, getFilters(repositoryPath), { branch: revision || '' });
    }
    // The filters read from the page; the revision is kept.
    function setFilters(repositoryPath, { includeRemotes, search, firstParent }) {
      filters[repositoryPath] = { branch: getFilters(repositoryPath).branch, includeRemotes: Boolean(includeRemotes), search: typeof search === 'string' ? search : '', firstParent: firstParent === true };
    }
    function clearFilters() { filters = {}; }
    // The value for saveState, in the shape restored from it.
    function snapshot() { return filters; }

    return {
      loadedCommits, loadedUpstream, findCommit, firstCommit, currentRequestId, currentNextOffset, clearCommits, reset,
      canLoadMore, startLoad, acceptPage, failPage, takeViewport,
      getFilters, setRevision, setFilters, clearFilters, snapshot
    };
  }

  return Object.freeze({ createHistoryState });
});
