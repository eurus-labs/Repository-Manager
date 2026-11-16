// State of the dashboard's Commit dialog: the files it lists and their scope and filter, the file
// previewed, the unsent draft's repository, and the message Copilot writes (its request, what it
// replaced, the partly staged choice it describes, the usage numbers).
// Pure logic, no DOM and no messages: webview.js reads the page, renders and posts, and passes
// what it read as arguments. Loaded before webview.js (see src/webview/dashboardScripts.ts);
// also required by Node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RepositoryDashboardCommitDialog = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const FILTERS = ['all', 'tracked', 'untracked'];

  // The share of Copilot's message changed before committing (as src/services/usageLog.ts editRatio).
  function editRatio(before, after) {
    const a = Array.from(before.slice(0, 2000)), b = Array.from(after.slice(0, 2000));
    if (!a.length) return b.length ? 1 : 0;
    let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      const row = [i];
      for (let j = 1; j <= b.length; j++) row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = row;
    }
    return Math.min(1, previous[b.length] / Math.max(a.length, b.length));
  }

  // All, Tracked or Untracked: does the filter show a file that is (not) untracked?
  function fileShown(filter, untracked) {
    return filter === 'all' || (filter === 'untracked') === untracked;
  }

  function createCommitDialogState(options) {
    const initialFilter = options && options.fileFilter;
    let workingTreeChanges = [];
    // Files picked in the Side Bar's Changes when the commit dialog opened: the dialog lists only
    // those (null: every changed file), so the commit and Write with Copilot take just them.
    let commitScope = null;
    // For the usage report: when the dialog opened, and the message Copilot last wrote in it.
    let commitOpenedAt = 0;
    let copilotCommitMessage = null;
    // Repository whose unsent commit message is kept in the Commit dialog (Escape or Cancel keep the draft).
    let commitDraftRepository = null;
    let previewedWorkingTreeFile = null;
    let workingTreePreviewMode = 'unstaged';
    let workingTreePreviewRequestId = 0;
    // The Commit dialog's file filter: all, tracked or untracked.
    let commitFileFilter = FILTERS.includes(initialFilter) ? initialFilter : 'all';
    let commitMessageRequestId = 0;
    let commitMessageRequest = 0;
    // The partly staged choice the last written message describes.
    let commitMessagePartial = null;
    let commitMessagePendingPartial = null;
    let previousCommitMessage = null;

    // The dialog opens: forget the list, scope to the files picked in Changes (none: every file),
    // and keep or drop the draft. clearDraft is true when the draft belonged to another repository:
    // the caller empties the message field.
    function open(activeRepo, pickedPaths, now) {
      workingTreeChanges = [];
      commitOpenedAt = now;
      const picked = Array.isArray(pickedPaths) ? pickedPaths : [];
      commitScope = picked.length ? new Set(picked) : null;
      previewedWorkingTreeFile = null;
      workingTreePreviewRequestId++;
      // A kept draft keeps whether Copilot wrote it; a cleared one is no longer Copilot's.
      const clearDraft = commitDraftRepository !== activeRepo;
      if (clearDraft) copilotCommitMessage = null;
      commitDraftRepository = activeRepo;
      previousCommitMessage = null;
      return { clearDraft };
    }

    // The dialog opened with a Side Bar selection: list every changed file instead.
    function showAll() {
      commitScope = null;
    }

    // The status read arrived: keep the files in scope. Picked files that are no longer changed
    // leave the scope; with none left, every file shows. scopeNote says what the note shows.
    function setChanges(all) {
      const scoped = commitScope ? all.filter(item => commitScope.has(item.path)) : all;
      if (commitScope && !scoped.length) commitScope = null;
      const listed = commitScope ? scoped : all;
      workingTreeChanges = listed;
      return { changes: listed, scopeNote: { scoped: Boolean(commitScope), shown: listed.length, rest: all.length - listed.length } };
    }

    function changes() {
      return workingTreeChanges;
    }

    function change(filePath) {
      return workingTreeChanges.find(item => item.path === filePath) || null;
    }

    function counts() {
      const all = workingTreeChanges.length;
      const untracked = workingTreeChanges.filter(item => item.untracked).length;
      return { all, tracked: all - untracked, untracked };
    }

    function filter() {
      return commitFileFilter;
    }

    // False for a value that is not a filter.
    function setFilter(value) {
      if (!FILTERS.includes(value)) return false;
      commitFileFilter = value;
      return true;
    }

    function shown(item) {
      return fileShown(commitFileFilter, Boolean(item.untracked));
    }

    // Selected files staged, then changed again: the commit takes either the staged part or the whole file.
    function partlyStaged(checkedPaths) {
      const selected = new Set(checkedPaths);
      return workingTreeChanges.filter(item => selected.has(item.path) && item.staged && item.unstaged && !item.untracked && !item.conflicted);
    }

    // The file to preview: its change, or null when it is not listed.
    function previewFile(filePath) {
      const found = change(filePath);
      if (!found) return null;
      previewedWorkingTreeFile = filePath;
      return found;
    }

    function previewedFile() {
      return previewedWorkingTreeFile;
    }

    function previewedChange() {
      return previewedWorkingTreeFile === null ? null : change(previewedWorkingTreeFile);
    }

    // The first listed file the filter shows, or null.
    function firstShownFile() {
      return workingTreeChanges.find(shown) || null;
    }

    // Asks for the previewed file's staged or unstaged side: null when the file has nothing there.
    function nextPreview(mode) {
      const found = previewedChange();
      if (!found || (mode === 'staged' && !found.staged)
        || (mode === 'unstaged' && !found.unstaged && !found.untracked)) return null;
      workingTreePreviewMode = mode;
      workingTreePreviewRequestId++;
      return { requestId: workingTreePreviewRequestId };
    }

    // page: what the page shows, { open, repositoryPath }: the dialog is open, and its repository
    // (null when the page has no such field).
    function isCurrentPreview(payload, page) {
      return Boolean(page && page.open && page.repositoryPath !== null && page.repositoryPath !== undefined
        && payload.repositoryPath === page.repositoryPath
        && payload.path === previewedWorkingTreeFile
        && payload.mode === workingTreePreviewMode
        && payload.requestId === workingTreePreviewRequestId);
    }

    // The request of the message being written; 0 when none.
    function messageRequest() {
      return commitMessageRequest;
    }

    // Copilot starts writing; partial is the partly staged choice it describes (or none).
    function startMessage(partial) {
      commitMessageRequest = ++commitMessageRequestId;
      commitMessagePendingPartial = partial === undefined ? null : partial;
      return commitMessageRequest;
    }

    function isMessage(requestId) {
      return requestId === commitMessageRequest;
    }

    function endMessage() {
      commitMessageRequest = 0;
    }

    // Copilot's message was written over previousDraft (the field's value): a non-blank draft is
    // kept for Undo. Returns it, or null.
    function messageWritten(text, previousDraft) {
      previousCommitMessage = typeof previousDraft === 'string' && previousDraft.trim() ? previousDraft : null;
      copilotCommitMessage = text;
      commitMessagePartial = commitMessagePendingPartial;
      return previousCommitMessage;
    }

    // Your own message again: the one Copilot replaced, or null; the message is no longer Copilot's.
    function undoMessage() {
      const previous = previousCommitMessage;
      copilotCommitMessage = null;
      previousCommitMessage = null;
      return previous;
    }

    function writtenPartial() {
      return commitMessagePartial;
    }

    // The commit went through: the message and its partly staged choice are spent.
    function committed() {
      commitMessagePartial = null;
      copilotCommitMessage = null;
    }

    // For the usage report: time since the dialog opened, and how much of Copilot's message was changed.
    function metrics(message, now) {
      return {
        durationMs: commitOpenedAt ? now - commitOpenedAt : 0,
        copilot: copilotCommitMessage !== null,
        editRatio: copilotCommitMessage !== null ? editRatio(copilotCommitMessage.trim(), message) : undefined
      };
    }

    return {
      open, showAll, setChanges, changes, change, counts, filter, setFilter, shown, partlyStaged,
      previewFile, previewedFile, previewedChange, firstShownFile, nextPreview, isCurrentPreview,
      messageRequest, startMessage, isMessage, endMessage, messageWritten, undoMessage, writtenPartial, committed, metrics
    };
  }

  return Object.freeze({ createCommitDialogState, editRatio, fileShown });
});
