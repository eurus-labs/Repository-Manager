// State of the dashboard's Uncommitted changes: the last status read, the files picked for Discard,
// the files a confirmed discard is removing, and the one-at-a-time status request.
// Pure logic, no DOM and no messages: webview.js renders and posts. Loaded before webview.js
// (see src/webview/dashboardScripts.ts); also required by Node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RepositoryDashboardWorkingTree = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function workingChangeStatus(change) {
    const status = change.conflicted ? 'unmerged' : change.untracked ? 'added' : change.originalPath ? 'renamed'
      : (change.indexStatus === 'D' || change.workTreeStatus === 'D') ? 'deleted' : (change.indexStatus === 'A') ? 'added' : 'modified';
    const state = change.conflicted ? 'conflict' : change.untracked ? 'new' : change.staged && change.unstaged ? 'staged + modified' : change.staged ? 'staged' : 'modified';
    return { status, state };
  }

  function workingTreeCountText(changes) {
    const count = predicate => changes.filter(predicate).length;
    return [
      [count(change => change.staged && !change.conflicted), 'staged'],
      [count(change => change.unstaged && !change.conflicted), 'modified'],
      [count(change => change.untracked), 'new'],
      [count(change => change.conflicted), 'conflicted']
    ].filter(([value]) => value > 0).map(([value, label]) => `${value} ${label}`).join(' · ');
  }

  function createWorkingTreeState() {
    let workingTree = { repositoryPath: null, changes: [] };
    // Uncommitted files picked for Discard: the Side Bar's Changes and the files list share them.
    // Shift extends from the anchor, the last file toggled on its own.
    const selection = new Set();
    let anchor = null;
    // Files a confirmed discard is removing (discardStarted): left out of every list until Git is done.
    let discarding = { repositoryPath: null, paths: new Set() };
    // The newest status read seen per purpose and repository (the host numbers each read as it starts).
    const statusSeen = new Map();
    // One status request at a time per repository: a second ask while one runs asks once more afterwards.
    let summaryInFlight = null;
    let summaryAgain = false;

    // The active repository's uncommitted changes, without the files a confirmed discard is removing.
    function changes(activeRepo) {
      if (workingTree.repositoryPath !== activeRepo) return [];
      if (discarding.repositoryPath !== activeRepo || !discarding.paths.size) return workingTree.changes;
      return workingTree.changes.filter(change => !discarding.paths.has(change.path));
    }

    function isKnown(activeRepo) {
      return workingTree.repositoryPath === activeRepo;
    }

    // The raw number of changes (the Activity Bar badge), not the discard-filtered list.
    function count(activeRepo) {
      return workingTree.repositoryPath === activeRepo ? workingTree.changes.length : 0;
    }

    // False for a reply older than one already shown: concurrent reads can answer out of order.
    function isLatestStatus(payload, purpose) {
      if (!payload || typeof payload.sequence !== 'number') return true;
      const key = `${purpose}\u0000${payload.repositoryPath}`;
      if (payload.sequence < (statusSeen.get(key) || 0)) return false;
      statusSeen.set(key, payload.sequence);
      return true;
    }

    function setStatus(repositoryPath, list) {
      workingTree = { repositoryPath, changes: Array.isArray(list) ? list : [] };
    }

    // Forget the status and the selection (another repository became active).
    function reset() {
      workingTree = { repositoryPath: null, changes: [] };
      clearSelection();
    }

    function has(filePath) {
      return selection.has(filePath);
    }

    // The selected files in list order (the order Discard names them).
    function selectedPaths(activeRepo) {
      return changes(activeRepo).map(change => change.path).filter(filePath => selection.has(filePath));
    }

    // A click toggles one file; Shift adds the files from the anchor to it.
    function toggle(filePath, shiftKey, activeRepo) {
      const order = changes(activeRepo).map(change => change.path);
      const to = order.indexOf(filePath);
      if (to < 0) return false;
      const from = shiftKey && anchor ? order.indexOf(anchor) : -1;
      if (from >= 0) {
        order.slice(Math.min(from, to), Math.max(from, to) + 1).forEach(item => selection.add(item));
      } else {
        if (selection.has(filePath)) selection.delete(filePath); else selection.add(filePath);
        anchor = filePath;
      }
      return true;
    }

    function selectAllOrClear(activeRepo) {
      const list = changes(activeRepo);
      const all = list.length > 0 && list.every(change => selection.has(change.path));
      selection.clear();
      if (!all) list.forEach(change => selection.add(change.path));
      anchor = null;
    }

    function clearSelection() {
      selection.clear();
      anchor = null;
    }

    // Files no longer changed (discarded, committed) leave the selection.
    function prune(activeRepo) {
      const present = new Set(changes(activeRepo).map(change => change.path));
      selection.forEach(item => { if (!present.has(item)) selection.delete(item); });
      if (anchor && !present.has(anchor)) anchor = null;
    }

    // A confirmed discard: true when it applies to the active repository.
    function startDiscard(payload, activeRepo) {
      if (!payload || payload.repositoryPath !== activeRepo || !Array.isArray(payload.paths)) return false;
      discarding = { repositoryPath: payload.repositoryPath, paths: new Set(payload.paths) };
      return true;
    }

    function finishDiscard(payload) {
      if (!payload || payload.repositoryPath !== discarding.repositoryPath) return { handled: false, success: false };
      discarding = { repositoryPath: null, paths: new Set() };
      return { handled: true, success: payload.success === true };
    }

    // True when the caller should post the status request now.
    function requestSummary(activeRepo) {
      if (!activeRepo) return false;
      if (summaryInFlight === activeRepo) { summaryAgain = true; return false; }
      summaryInFlight = activeRepo;
      summaryAgain = false;
      return true;
    }

    // True when a request came in while this one ran: the caller asks again.
    function summaryAnswered(repositoryPath) {
      if (summaryInFlight !== repositoryPath) return false;
      summaryInFlight = null;
      return summaryAgain;
    }

    return {
      changes, isKnown, count, isLatestStatus, setStatus, reset,
      has, selectedPaths, toggle, selectAllOrClear, clearSelection, prune,
      startDiscard, finishDiscard, requestSummary, summaryAnswered
    };
  }

  return Object.freeze({ createWorkingTreeState, workingTreeCountText, workingChangeStatus });
});
