// Webview script for Repository Manager
// This file is loaded as an external script by the webview panel.
// Initial repository data is provided via window.__initialRepositories (set by inline script).

(function () {
  const vscode = acquireVsCodeApi();

  // Restore state from previous session
  const previousState = vscode.getState() || {};
  let repositoryData = previousState.repositoryData || previousState.submoduleData || (window.__initialRepositories || []);
  let activeDashboardRepository = previousState.activeDashboardRepository || (repositoryData[0] && repositoryData[0].path) || '.';
  let selectedDashboardCommit = previousState.selectedDashboardCommit || null;
  let historyNextOffset = null;
  let historySearchTimer = null;
  let historyRequestId = 0;
  let selectedDashboardFile = null;
  let comparisonBaseHash = null;
  let activeComparisonTarget = null;
  let comparisonSource = null;
  let commitCompareSelection = Array.isArray(previousState.commitCompareSelection)
    ? previousState.commitCompareSelection.slice(0, 2)
    : [];
  let comparisonRepository = previousState.comparisonRepository || activeDashboardRepository;
  let dashboardHistoryState = previousState.dashboardHistoryState || {};
  let dashboardActivated = false;
  let loadedHistoryCommits = [];
  let repositoryRefs = { branches: [], tags: [], remotes: [], stashes: [] };
  // The checked-out branch's configured upstream, from the latest first history page.
  let loadedHistoryUpstream = null;
  let pendingBranchCheckout = null;
  let pendingHistoryViewport = null;
  let historyPanelHeight = Number(previousState.historyPanelHeight) || 0;
  let historyAppendPending = false; // a Load more page is on its way (also started by scrolling)
  let summaryModelsState = 'idle'; // the Model menu's list: idle (not loaded), loading, loaded
  // Reviews also check clean code when this is on (the "Clean code" box); remembered across reloads.
  let reviewQuality = Boolean(previousState.reviewQuality);
  let filesPanelWidth = Number(previousState.filesPanelWidth) || 0;
  const defaultHistoryColumnWidths = [76, 420, 150, 110, 80];
  let historyColumnWidths = Array.isArray(previousState.historyColumnWidths)
    && previousState.historyColumnWidths.length === defaultHistoryColumnWidths.length
    ? previousState.historyColumnWidths.map(Number)
    : [];
  let renderedHistoryColumnWidths = defaultHistoryColumnWidths.slice();
  let historyGraphWidth = 76;
  let loadedHistoryGraphModel = null;
  let historyGraphGeometryFrame = 0;
  let historyGraphGeometrySignature = '';
  let historyColumnMinimums = [52, 80, 58, 54, 52];
  const runningToolbarOperations = new Set();
  let workingTreeChanges = [];
  // Repository whose unsent commit message is kept in the Commit dialog (Escape or Cancel keep the draft).
  let commitDraftRepository = null;
  let previewedWorkingTreeFile = null;
  let workingTreePreviewMode = 'unstaged';
  // Uncommitted changes: a row above the history and the working tree in the detail pane. They are
  // shown by default when there are changes and no commit was picked (commitChosen).
  const WORKING_TREE = '__working_tree__';
  let workingTree = { repositoryPath: null, changes: [] };
  let commitChosen = false;
  // Apart from the commit dialog's preview ids, so each side knows its own replies.
  let workingPreviewRequestId = 1000000;
  let workingDiffMode = null;
  let uncommittedRowRendered = false;
  // The active repository's branch and commit at the last repository list, to notice HEAD moving.
  let activeHeadSignature = { repositoryPath: null, head: '' };
  let historyDrawnReported = false;
  let workingTreePreviewRequestId = 0;
  let changeSummaryRequestId = 0;
  let changeSummarySelection = null;
  let selectedSummaryModelId = '';
  // The chosen model's name until the list loads (it is restored from the extension at start).
  let selectedSummaryModelName = '';
  let selectedModelRestored = false;
  // The model id the extension has saved ('' for Default); after a fallback it differs from the one in use.
  let savedSummaryModelId = '';
  let summaryModels = []; // { id, name } in Copilot's order, once loaded
  let pinnedModelIds = []; // saved by the extension for every workspace; listed first in the Model menu
  // The Repository Review tab's last review, as the extension reports it (ReviewBridge).
  let reviewStatus = { state: 'idle' };
  let historyDateFormat = null; // shared by every history row (see formatHistoryDate)
  let repositoryDataAt = Date.now(); // when the repository list was last received (the page starts with it)
  // Names for the ends of the loaded comparison (e.g. a release tag and a branch), for reviews of it.
  let comparisonLabels = null;
  const changeSummaries = new Map();
  let activeChangeSummaryKey = null;
  let historyContextTarget = null;
  let branchFromCommitTarget = null;

  function hideHistoryContextMenu() {
    document.getElementById('historyContextMenu').hidden = true;
    const changesMenu = document.getElementById('changesContextMenu');
    if (changesMenu) changesMenu.hidden = true;
  }

  // Discard for the uncommitted changes: right-click a changed file (that file, or all), or the
  // Uncommitted changes row (all). The host asks first, keeps a copy, then discards.
  let changesContextTarget = null;
  function showChangesContextMenu(element, x, y) {
    const file = element.closest('.changed-file-item');
    if (file && selectedDashboardCommit !== WORKING_TREE) return false;
    if (!dashboardWorkingChanges().length) return false;
    hideHistoryContextMenu();
    changesContextTarget = { repositoryPath: activeDashboardRepository, path: file ? file.dataset.path : null };
    const menu = document.getElementById('changesContextMenu');
    menu.querySelector('[data-action="contextDiscardFile"]').hidden = !file;
    menu.hidden = false;
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    menu.style.left = `${Math.max(0, Math.min(x, width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(0, Math.min(y, height - menu.offsetHeight - 8))}px`;
    menu.querySelector('button:not([hidden])').focus();
    return true;
  }

  // Review branch's menu: the changed files (the button's own review) or every file. Nothing is
  // remembered, so All files, which sends far more code, is always chosen on purpose.
  function hideReviewBranchMenu(restoreFocus) {
    const menu = document.getElementById('reviewBranchMenu');
    const toggle = document.getElementById('reviewBranchMenuButton');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus();
    }
  }

  function showReviewBranchMenu() {
    const menu = document.getElementById('reviewBranchMenu');
    const toggle = document.getElementById('reviewBranchMenuButton');
    if (!menu || !toggle) return;
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    const anchor = toggle.getBoundingClientRect();
    const width = window.innerWidth || document.documentElement.clientWidth;
    menu.style.left = `${Math.max(0, Math.min(anchor.right - menu.offsetWidth, width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${anchor.bottom + 2}px`;
    menu.querySelector('button').focus();
  }

  // The ⚙ menu next to Model: when to ask before code is sent to Copilot (a VS Code setting the
  // extension owns and reports), and a way to all the extension's settings.
  function hideCopilotSettingsMenu(restoreFocus) {
    const menu = document.getElementById('copilotSettingsMenu');
    const toggle = document.getElementById('copilotSettingsButton');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus();
    }
  }

  function showCopilotSettingsMenu() {
    const menu = document.getElementById('copilotSettingsMenu');
    const toggle = document.getElementById('copilotSettingsButton');
    if (!menu || !toggle) return;
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    const anchor = toggle.getBoundingClientRect();
    const width = window.innerWidth || document.documentElement.clientWidth;
    menu.style.left = `${Math.max(0, Math.min(anchor.left, width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${anchor.bottom + 2}px`;
    (menu.querySelector('[aria-checked="true"]') || menu.querySelector('button')).focus();
  }

  function renderCopilotSettings(settings) {
    document.querySelectorAll('#copilotSettingsMenu [data-action="setAskBeforeSending"]').forEach(item => {
      item.setAttribute('aria-checked', String(item.dataset.value === settings.askBeforeSending));
    });
  }

  // The Model menu: Default, the pinned models, the rest in Copilot's order, and Reload. Each model
  // row is two items: choose it, or pin it (📌), so a model can be pinned without being chosen.
  function summaryModelRow(model, pinned) {
    const name = escapeHtml(model.name);
    const id = escapeHtml(model.id);
    return `<div class="summary-model-row" role="none">` +
      `<button type="button" role="menuitemradio" class="summary-model-choice" data-action="chooseSummaryModel" data-model-id="${id}" aria-checked="${model.id === selectedSummaryModelId}">${name}</button>` +
      `<button type="button" role="menuitemcheckbox" class="summary-model-pin" data-action="toggleSummaryModelPin" data-model-id="${id}" aria-checked="${pinned}" aria-label="${pinned ? 'Unpin' : 'Pin'} ${name}" title="${pinned ? 'Unpin: list it with the other models' : 'Pin: list it first, in every workspace'}">📌</button>` +
      `</div>`;
  }

  function renderSummaryModelMenu() {
    const menu = document.getElementById('summaryModelMenu');
    const name = document.getElementById('summaryModelName');
    const selected = summaryModels.find(model => model.id === selectedSummaryModelId);
    if (name) {
      name.textContent = selected ? selected.name
        : selectedSummaryModelId && selectedSummaryModelName ? selectedSummaryModelName
          : summaryModelsState === 'loading' && !summaryModels.length ? 'Default (loading list…)' : 'Default';
    }
    if (!menu) return;
    const pinned = summaryModels.filter(model => pinnedModelIds.includes(model.id));
    const others = summaryModels.filter(model => !pinnedModelIds.includes(model.id));
    let html = `<button type="button" role="menuitemradio" class="summary-model-choice" data-action="chooseSummaryModel" data-model-id="" aria-checked="${!selectedSummaryModelId}" title="The first Copilot model VS Code offers">Default</button>`;
    if (summaryModelsState === 'loading') html += '<div class="menu-heading" role="presentation">Loading models…</div>';
    if (pinned.length) {
      html += '<div class="menu-heading" role="presentation">Pinned</div>' + pinned.map(model => summaryModelRow(model, true)).join('');
      if (others.length) html += '<div class="menu-heading" role="presentation">All models</div>';
    }
    html += others.map(model => summaryModelRow(model, false)).join('');
    html += '<div class="menu-separator" role="separator"></div><button type="button" role="menuitem" class="summary-model-choice" data-action="reloadSummaryModels">↻ Reload model list</button>';
    // Rebuilding the menu drops focus: put it back on the same item (a pinned row moves to the top).
    const focused = menu.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focused ? [focused.dataset.action, focused.dataset.modelId] : null;
    menu.innerHTML = html;
    if (focusKey && !menu.hidden) {
      const again = Array.from(menu.querySelectorAll('button')).find(item => item.dataset.action === focusKey[0] && item.dataset.modelId === focusKey[1]);
      (again || menu.querySelector('[role="menuitemradio"][aria-checked="true"]') || menu.querySelector('button')).focus();
    }
  }

  function hideSummaryModelMenu(restoreFocus) {
    const menu = document.getElementById('summaryModelMenu');
    const toggle = document.getElementById('summaryModelButton');
    if (!menu || menu.hidden) return;
    menu.hidden = true;
    if (toggle) {
      toggle.setAttribute('aria-expanded', 'false');
      if (restoreFocus) toggle.focus();
    }
  }

  function showSummaryModelMenu() {
    const menu = document.getElementById('summaryModelMenu');
    const toggle = document.getElementById('summaryModelButton');
    if (!menu || !toggle) return;
    if (summaryModelsState === 'idle') actions.loadSummaryModels(); // the list loads on first open
    renderSummaryModelMenu();
    menu.hidden = false;
    toggle.setAttribute('aria-expanded', 'true');
    const anchor = toggle.getBoundingClientRect();
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    menu.style.left = `${Math.max(0, Math.min(anchor.left, width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${anchor.bottom + 2}px`;
    menu.style.maxHeight = `${Math.max(120, height - anchor.bottom - 12)}px`;
    (menu.querySelector('[role="menuitemradio"][aria-checked="true"]') || menu.querySelector('button')).focus();
  }

  // Arrow keys move between rows (keeping to the choose or pin column), Left/Right between the two.
  function moveInSummaryModelMenu(event) {
    const menu = document.getElementById('summaryModelMenu');
    const current = event.target.closest && event.target.closest('#summaryModelMenu button');
    if (!menu || !current) return;
    const onPin = current.classList.contains('summary-model-pin');
    let next = null;
    if (event.key === 'ArrowRight' && !onPin) next = current.parentElement.querySelector('.summary-model-pin');
    else if (event.key === 'ArrowLeft' && onPin) next = current.parentElement.querySelector('.summary-model-choice');
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const choices = Array.from(menu.querySelectorAll('.summary-model-choice'));
      const at = choices.indexOf(onPin ? current.parentElement.querySelector('.summary-model-choice') : current);
      const index = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
        : (at + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      next = choices[index];
      // Stay in the pin column when the row has one.
      const pin = onPin && next.parentElement.classList.contains('summary-model-row') ? next.parentElement.querySelector('.summary-model-pin') : null;
      if (pin) next = pin;
    } else return;
    event.preventDefault();
    if (next) next.focus();
  }

  // Operation paused in each repository ('rebase', 'merge', ...), as last reported by the extension.
  const pendingOperations = {};
  let historyContextMenuPoint = null;

  // Show menu items such as Continue/Abort rebase only while their operation is in progress.
  function applyHistoryMenuOperation() {
    const operation = pendingOperations[activeDashboardRepository] || null;
    document.querySelectorAll('#historyContextMenu [data-requires-operation]').forEach(item => {
      item.hidden = item.dataset.requiresOperation !== operation;
    });
  }

  function positionHistoryContextMenu() {
    const menu = document.getElementById('historyContextMenu');
    if (!menu || !historyContextMenuPoint) return;
    const width = window.innerWidth || document.documentElement.clientWidth;
    const height = window.innerHeight || document.documentElement.clientHeight;
    menu.style.left = `${Math.max(0, Math.min(historyContextMenuPoint.x, width - menu.offsetWidth - 8))}px`;
    menu.style.top = `${Math.max(0, Math.min(historyContextMenuPoint.y, height - menu.offsetHeight - 8))}px`;
  }

  function showHistoryContextMenu(element, x, y) {
    const commit = loadedHistoryCommits.find(item => item.hash === element.dataset.commit);
    if (!commit) return false;
    historyContextTarget = { repositoryPath: activeDashboardRepository, hash: commit.hash };
    const menu = document.getElementById('historyContextMenu');
    historyContextMenuPoint = { x, y };
    applyHistoryMenuOperation();
    menu.hidden = false;
    positionHistoryContextMenu();
    menu.querySelector('button:not([hidden])').focus();
    // The cached state can be stale (e.g. a rebase continued in a terminal); refresh it while the menu is open.
    postMessage('getPendingOperation', { repositoryPath: activeDashboardRepository });
    return true;
  }

  // Webviews cannot show alert(): what is missing is said in the dialog, next to its buttons.
  function showCreateBranchHint(text) {
    const hint = document.getElementById('createBranchHint');
    if (!hint) return;
    hint.textContent = text;
    hint.hidden = !text;
  }

  function restoreBranchModalControls() {
    branchFromCommitTarget = null;
    const baseInput = document.getElementById('baseBranchInput');
    baseInput.disabled = false;
    baseInput.value = '';
    baseInput.placeholder = 'Loading branches...';
    document.getElementById('baseBranch').value = '';
    document.getElementById('baseBranchHint').textContent = '';
    document.getElementById('baseBranchDropdown').style.pointerEvents = '';
    document.getElementById('branchFromCommitCheckoutRow').hidden = true;
    document.querySelectorAll('.branch-repository').forEach(cb => {
      if (cb.dataset.originalDisabled !== undefined) {
        cb.disabled = cb.dataset.originalDisabled === 'true';
      }
    });
  }

  function changeSummaryKey(selection, repositoryPath = activeDashboardRepository) {
    return JSON.stringify([repositoryPath, selection.baseSha, selection.targetSha, selectedSummaryModelId]);
  }

  function cancelPendingChangeSummary() {
    if (!activeChangeSummaryKey) return;
    const record = changeSummaries.get(activeChangeSummaryKey);
    if (record && record.pending) {
      record.pending = false;
      record.status = 'Summary cancelled.';
      postMessage('cancelChangeSummary', {});
    }
    activeChangeSummaryKey = null;
  }

  function resetChangeSummary(cancelPending = false) {
    if (cancelPending) cancelPendingChangeSummary();
    changeSummarySelection = null;
    applyReviewLock(); // nothing for Review commit until the next commit or comparison loads
    const area = document.getElementById('changeSummary');
    const result = document.getElementById('changeSummaryResult');
    const status = document.getElementById('changeSummaryStatus');
    const cancel = document.getElementById('cancelChangeSummaryButton');
    const start = document.getElementById('summarizeChangesButton');
    const actions = document.getElementById('commitHeaderActions');
    if (area) area.hidden = true;
    if (actions) actions.hidden = true;
    if (result) result.innerHTML = '';
    if (status) status.textContent = '';
    if (cancel) cancel.hidden = true;
    if (start) start.disabled = false;
  }

  // The bar under the commit header holds only the summary's status and result, so it shows only
  // while one of them has something to say; its buttons sit in the header.
  function syncChangeSummaryArea() {
    const area = document.getElementById('changeSummary');
    const status = document.getElementById('changeSummaryStatus');
    const result = document.getElementById('changeSummaryResult');
    if (area) area.hidden = !(status && status.textContent.trim()) && !(result && result.innerHTML.trim());
  }

  function restoreChangeSummary() {
    // The header's actions: Review changes for uncommitted changes (Commit is in the toolbar), then Summarize.
    const workingActions = document.getElementById('workingTreeActions');
    if (workingActions) workingActions.hidden = !(changeSummarySelection && changeSummarySelection.local);
    // Apply, Pop and Drop for a stash shown on its own (not as one side of a comparison).
    const stashActions = document.getElementById('stashActions');
    if (stashActions) stashActions.hidden = !(changeSummarySelection && changeSummarySelection.stash);
    if (!changeSummarySelection) return;
    const record = changeSummaries.get(changeSummaryKey(changeSummarySelection));
    document.getElementById('commitHeaderActions').hidden = false;
    document.getElementById('changeSummaryResult').innerHTML = '';
    document.getElementById('changeSummaryStatus').textContent = record ? record.status : '';
    document.getElementById('summarizeChangesButton').disabled = Boolean(record && record.pending);
    document.getElementById('cancelChangeSummaryButton').hidden = !record || !record.pending;
    if (record && record.summary) {
      renderChangeSummary({ requestId: record.requestId, repositoryPath: record.repositoryPath,
        summary: record.summary, model: record.model });
    }
    syncChangeSummaryArea();
  }

  function isCurrentChangeSummary(payload) {
    return payload && changeSummarySelection && payload.repositoryPath === activeDashboardRepository &&
      changeSummarySelection.targetSha === selectedDashboardCommit &&
      changeSummarySelection.baseSha === comparisonBaseHash &&
      changeSummaries.get(changeSummaryKey(changeSummarySelection))?.requestId === payload.requestId;
  }

  function finishChangeSummary() {
    document.getElementById('cancelChangeSummaryButton').hidden = true;
    document.getElementById('summarizeChangesButton').disabled = false;
  }

  function renderChangeSummary(payload) {
    if (!isCurrentChangeSummary(payload)) return;
    const data = payload.summary;
    if (!data || data.targetSha !== changeSummarySelection.targetSha ||
        data.baseSha !== (changeSummarySelection.baseSha || '4b825dc642cb6eb9a060e54bf8d69288fbee4904')) return;
    finishChangeSummary();
    document.getElementById('changeSummaryStatus').textContent = `Completed · ${payload.model}`;
    const changed = new Set(changeSummarySelection.files.map(file => file.path));
    function claim(item) {
      const refs = (item.evidence || []).map(ref => changed.has(ref)
        ? `<button class="change-summary-evidence" type="button" data-action="selectChangedFile" data-path="${escapeHtml(ref)}">${escapeHtml(ref)}</button>`
        : `<button class="change-summary-evidence" type="button" data-action="selectHistoryCommit" data-commit="${escapeHtml(ref)}">${escapeHtml(ref.slice(0, 12))}</button>`).join('');
      return `<li>${escapeHtml(item.text)}${refs ? `<div>${refs}</div>` : ''}</li>`;
    }
    function section(title, items) {
      return `<section><h4>${title}</h4>${items.length ? `<ul>${items.map(claim).join('')}</ul>` : '<p>None identified from the provided context.</p>'}</section>`;
    }
    const limitations = [...(data.limitations || []), ...(data.coverage.omitted || []),
      ...(data.coverage.truncatedCommits ? ['Commit history was truncated.'] : [])];
    document.getElementById('changeSummaryResult').innerHTML =
      `<p class="change-summary-revisions">${escapeHtml(data.repositoryPath)} · ${data.root ? 'Empty tree' : escapeHtml(data.baseSha)} → ${escapeHtml(data.targetSha)}</p>` +
      `<p>Coverage: ${data.coverage.includedFiles}/${data.coverage.totalFiles} file patches.</p>` +
      section('Summary', [data.intent, ...data.behaviorChanges]) + section('Affected areas', data.affectedAreas) +
      section('Dependency / config', data.dependencyConfigChanges) +
      section('Possible breaking changes', data.possibleBreakingChanges) + section('Risk hints', data.riskHints) +
      section('Suggested tests', data.suggestedTests) +
      `<section><h4>Coverage limitations</h4><ul>${limitations.map(item => `<li>${escapeHtml(item)}</li>`).join('') || '<li>None reported.</li>'}</ul></section>`;
    syncChangeSummaryArea();
  }

  // Save state helper
  function saveState() {
    vscode.setState({
      repositoryData,
      activeDashboardRepository,
      selectedDashboardCommit,
      commitCompareSelection,
      comparisonRepository,
      dashboardHistoryState,
      historyPanelHeight,
      reviewQuality,
      filesPanelWidth,
      historyColumnWidths
    });
  }

  function postMessage(type, payload) {
    vscode.postMessage({ type, payload });
  }

  function setToolbarOperationState(operation, state, message) {
    const button = document.querySelector(`[data-operation="${operation}"]`);
    if (!button) return;
    button.classList.remove('is-busy', 'is-success', 'is-error');
    if (state === 'running') {
      runningToolbarOperations.add(operation);
      button.classList.add('is-busy');
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    } else {
      runningToolbarOperations.delete(operation);
      button.disabled = false;
      button.removeAttribute('aria-busy');
      if (state === 'success') button.classList.add('is-success');
      if (state === 'error') button.classList.add('is-error');
      window.setTimeout(function () {
        button.classList.remove('is-success', 'is-error');
      }, 900);
    }
    // Keep the button's own label in its tooltip; append only the latest failure.
    if (!button.dataset.baseTitle) button.dataset.baseTitle = button.title;
    button.title = state === 'error' && message
      ? `${button.dataset.baseTitle}: ${message}`
      : button.dataset.baseTitle;
  }

  function runToolbarOperation(operation, type) {
    if (runningToolbarOperations.has(operation)) return;
    setToolbarOperationState(operation, 'running');
    postMessage(type, { submodule: activeDashboardRepository });
  }

  function reloadActiveDashboardData() {
    requestDashboardHistory(0, false);
    postMessage('getRepositoryRefs', { repositoryPath: activeDashboardRepository });
  }

  // Action handlers
  const actions = {
    contextCherryPick: () => {
      if (!historyContextTarget) return;
      postMessage('applyHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, operation: 'cherry-pick' });
      hideHistoryContextMenu();
    },
    contextRevert: () => {
      if (!historyContextTarget) return;
      postMessage('applyHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, operation: 'revert' });
      hideHistoryContextMenu();
    },
    contextMerge: () => {
      if (!historyContextTarget) return;
      postMessage('applyHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, operation: 'merge' });
      hideHistoryContextMenu();
    },
    contextRebase: () => {
      if (!historyContextTarget) return;
      postMessage('rewriteHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, action: 'rebase' });
      hideHistoryContextMenu();
    },
    contextReset: () => {
      if (!historyContextTarget) return;
      postMessage('rewriteHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, action: 'reset' });
      hideHistoryContextMenu();
    },
    contextDrop: () => {
      if (!historyContextTarget) return;
      postMessage('rewriteHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, action: 'drop' });
      hideHistoryContextMenu();
    },
    contextContinueRebase: () => {
      if (!historyContextTarget) return;
      postMessage('resolveHistoryRebase', { repositoryPath: historyContextTarget.repositoryPath, command: 'continue' });
      hideHistoryContextMenu();
    },
    contextAbortRebase: () => {
      if (!historyContextTarget) return;
      postMessage('resolveHistoryRebase', { repositoryPath: historyContextTarget.repositoryPath, command: 'abort' });
      hideHistoryContextMenu();
    },
    contextAddTag: () => {
      if (!historyContextTarget) return;
      postMessage('createTagFromCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash });
      hideHistoryContextMenu();
    },
    contextCopyHash: () => {
      if (!historyContextTarget) return;
      postMessage('copyHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, field: 'hash' });
      hideHistoryContextMenu();
    },
    contextCopySubject: () => {
      if (!historyContextTarget) return;
      postMessage('copyHistoryCommit', { repositoryPath: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, field: 'subject' });
      hideHistoryContextMenu();
    },
    contextCheckoutCommit: () => {
      if (!historyContextTarget) return;
      postMessage('checkoutCommit', { submodule: historyContextTarget.repositoryPath,
        commit: historyContextTarget.hash, fromHistory: true });
      hideHistoryContextMenu();
    },
    contextCreateBranch: () => {
      if (!historyContextTarget) return;
      branchFromCommitTarget = { ...historyContextTarget };
      hideHistoryContextMenu();
      actions.openCreateBranchModal(true);
    },
    // The model list loads when the Model menu is first opened (no separate button).
    loadSummaryModels: () => {
      if (summaryModelsState === 'loading') return;
      summaryModelsState = 'loading';
      renderSummaryModelMenu();
      postMessage('loadSummaryModels', {});
    },
    toggleSummaryModelMenu: () => {
      const menu = document.getElementById('summaryModelMenu');
      if (!menu) return;
      if (menu.hidden) showSummaryModelMenu(); else hideSummaryModelMenu(true);
    },
    // The choice is remembered for every workspace; Default is saved as no model.
    chooseSummaryModel: (el) => {
      const id = el.dataset.modelId || '';
      hideSummaryModelMenu(true);
      const model = summaryModels.find(candidate => candidate.id === id);
      selectedModelRestored = true; // a later settings reply must not undo this choice
      // Choosing Default after a fallback still forgets the saved model, though Default is already in use.
      if (id !== savedSummaryModelId) {
        savedSummaryModelId = id;
        postMessage('setSelectedModel', { model: model ? { id: model.id, name: model.name } : null });
      }
      if (id === selectedSummaryModelId) return;
      cancelPendingChangeSummary();
      selectedSummaryModelId = id;
      selectedSummaryModelName = model ? model.name : '';
      renderSummaryModelMenu();
      restoreChangeSummary();
      publishReviewContext(); // the review tab's Fix uses the same model
    },
    // Pinning keeps the menu open, so several models can be pinned in a row.
    toggleSummaryModelPin: (el) => {
      const id = el.dataset.modelId;
      if (!id) return;
      pinnedModelIds = pinnedModelIds.includes(id) ? pinnedModelIds.filter(pinned => pinned !== id) : pinnedModelIds.concat(id);
      renderSummaryModelMenu();
      postMessage('setPinnedModels', { ids: pinnedModelIds });
    },
    // One list request at a time: replies carry no request id, so an older one could land last.
    reloadSummaryModels: () => {
      if (summaryModelsState === 'loading') return;
      summaryModelsState = 'idle';
      actions.loadSummaryModels();
    },
    summarizeChanges: () => {
      if (!changeSummarySelection) return;
      const key = changeSummaryKey(changeSummarySelection);
      if (changeSummaries.get(key)?.pending) return;
      cancelPendingChangeSummary();
      const requestId = ++changeSummaryRequestId;
      changeSummaries.set(key, { requestId, repositoryPath: activeDashboardRepository,
        pending: true, status: 'Collecting context…', summary: null, model: null });
      activeChangeSummaryKey = key;
      document.getElementById('changeSummaryResult').innerHTML = '';
      restoreChangeSummary();
      // Local changes: the extension summarizes HEAD → a snapshot of the working tree it takes now.
      postMessage('summarizeChanges', { repositoryPath: activeDashboardRepository,
        baseSha: changeSummarySelection.baseSha, targetSha: changeSummarySelection.targetSha,
        local: changeSummarySelection.local === true || undefined, requestId, modelId: selectedSummaryModelId });
    },
    stashAction: (el) => {
      if (!changeSummarySelection || !changeSummarySelection.stash) return;
      postMessage('stashAction', { repositoryPath: activeDashboardRepository,
        stash: changeSummarySelection.targetSha, operation: el.dataset.operation });
    },
    contextDiscardFile: () => {
      const target = changesContextTarget;
      hideHistoryContextMenu();
      if (!target || !target.path) return;
      postMessage('discardChanges', { repositoryPath: target.repositoryPath, paths: [target.path] });
    },
    contextDiscardAll: () => {
      const target = changesContextTarget;
      hideHistoryContextMenu();
      if (!target) return;
      postMessage('discardChanges', { repositoryPath: target.repositoryPath, all: true });
    },
    cancelChangeSummary: () => {
      cancelPendingChangeSummary();
      restoreChangeSummary();
    },
    refresh: () => runToolbarOperation('refresh', 'refresh'),

    pullActiveRepository: () => runToolbarOperation('pull', 'pullChanges'),
    pushActiveRepository: () => runToolbarOperation('push', 'pushChanges'),
    fetchActiveRepository: () => runToolbarOperation('fetch', 'fetchUpdates'),

    loadMoreHistory: () => {
      if (historyNextOffset !== null && !historyAppendPending) requestDashboardHistory(historyNextOffset, true);
    },

    selectWorkingTree: () => {
      commitChosen = false;
      selectWorkingTree();
    },
    workingDiffMode: (el) => requestWorkingDiff(el.dataset.mode),

    selectHistoryCommit: (el, event) => {
      const commitHash = el.dataset.commit;
      // Rows of a history being replaced may belong to the previous repository.
      if (!commitHash || (el.closest && el.closest('.history-stale'))) return;
      commitChosen = true;
      // Ctrl/Cmd-click or Shift-click picks the row for a comparison, like the graph node (as Git Graph does).
      if (event && (event.ctrlKey || event.metaKey || event.shiftKey)) {
        toggleCommitCompareNode(commitHash);
        return;
      }
      clearCommitComparison(false);
      loadParentCommitDetail(commitHash);
    },

    selectChangedFile: (el) => {
      const filePath = el.dataset.path;
      if (!filePath || !selectedDashboardCommit) return;
      selectedDashboardFile = filePath;
      document.querySelectorAll('.changed-file-item').forEach(item => {
        item.classList.toggle('active', item.dataset.path === filePath);
      });
      const fileName = document.getElementById('diffFileName');
      const diff = document.getElementById('dashboardDiff');
      if (fileName) fileName.textContent = filePath;
      const workingModes = document.getElementById('workingDiffModes');
      if (selectedDashboardCommit === WORKING_TREE) {
        // A live update re-renders the list: keep the diff on screen until the new one arrives.
        if (diff && diff.dataset.workingPath !== filePath) diff.innerHTML = '<span class="diff-placeholder">Loading patch…</span>';
        requestWorkingDiff(workingDiffMode);
        return;
      }
      if (workingModes) workingModes.hidden = true;
      if (diff) delete diff.dataset.workingPath;
      if (diff) diff.innerHTML = '<span class="diff-placeholder">Loading patch…</span>';
      postMessage('getFileDiff', {
        repositoryPath: activeDashboardRepository,
        commitHash: selectedDashboardCommit,
        baseRevision: comparisonBaseHash || undefined,
        path: filePath
      });
    },

    toggleReferenceSection: (el) => {
      const section = el.dataset.section;
      if (!section) return;
      const panel = document.querySelector(`[data-reference-panel="${section}"]`);
      if (!panel) return;
      const willOpen = panel.hidden;
      document.querySelectorAll('[data-reference-panel]').forEach(item => { item.hidden = true; });
      document.querySelectorAll('.reference-summary-row').forEach(item => item.classList.remove('expanded'));
      panel.hidden = !willOpen;
      el.classList.toggle('expanded', willOpen);
    },

    selectReference: (el) => {
      const revision = el.dataset.revision;
      if (!revision) return;
      setHistoryRevision(revision);
      captureDashboardFilters();
      saveState();
      requestDashboardHistory(0, false);
    },

    toggleBranchFolder: (el) => {
      const folder = el.dataset.folder;
      if (!folder) return;
      const key = `${activeDashboardRepository}\u0000${folder}`;
      if (collapsedBranchFolders.has(key)) collapsedBranchFolders.delete(key); else collapsedBranchFolders.add(key);
      if (repositoryRefs) renderRepositoryRefs(Object.assign({ repositoryPath: activeDashboardRepository }, repositoryRefs));
    },

    selectDashboardBranch: (el) => {
      requestBranchCheckout(el.dataset.branch);
    },

    selectDashboardRepository: (el) => {
      const repositoryPath = el.dataset.path;
      if (!repositoryPath || repositoryPath === activeDashboardRepository) return;
      activateDashboardRepository(repositoryPath);
      renderRepositorySwitcher();
    },

    // The extension host asks for confirmation before moving HEAD.
    syncRepositoryToRecorded: (el) => {
      if (el.dataset.path) postMessage('syncRepositoryToRecorded', { repositoryPath: el.dataset.path });
    },

    replaceLocalBranchFromRemote: (el) => {
      requestBranchCheckout(el.dataset.branch, true);
    },

    deleteDashboardBranch: (el) => {
      const branch = el.dataset.branch;
      if (!branch || !activeDashboardRepository) return;
      // The extension asks whether to delete the local branch only or origin's as well.
      postMessage('deleteBranch', {
        submodule: activeDashboardRepository,
        branch,
        hasRemote: el.dataset.hasRemote === 'true'
      });
    },

    openBranchCompareModal: () => {
      const modal = document.getElementById('branchCompareModal');
      const base = document.getElementById('compareBaseBranch');
      const target = document.getElementById('compareTargetBranch');
      populateBranchCompareSelects(base, target);
      if (modal) modal.classList.add('active');
    },

    compareBranches: () => {
      const base = document.getElementById('compareBaseBranch');
      const target = document.getElementById('compareTargetBranch');
      const hint = document.getElementById('branchCompareHint');
      if (!base || !target || !base.value || !target.value || base.value === target.value) {
        // Webviews cannot show alert(): say it in the dialog.
        if (hint) { hint.hidden = false; hint.textContent = 'Select two different branches or tags to compare.'; }
        return;
      }
      if (hint) hint.hidden = true;
      const modal = document.getElementById('branchCompareModal');
      if (modal) modal.classList.remove('active');
      commitCompareSelection = [];
      comparisonRepository = activeDashboardRepository;
      // The picked names label the comparison and any review of it (not the resolved hashes).
      const label = select => (select.selectedOptions[0] && select.selectedOptions[0].dataset.label) || select.value;
      loadComparison(base.value, target.value, 'branches', { base: label(base), target: label(target) });
    },

    clearCommitComparison: () => clearCommitComparison(true),

    toggleCommitCompareNode: (el) => toggleCommitCompareNode(el.dataset.commit),

    previewWorkingTreeFile: (el) => {
      selectWorkingTreePreview(el.dataset.path);
    },

    previewWorkingTreeMode: (el) => {
      requestWorkingTreePreview(el.dataset.mode);
    },

    openCommitChangesModal: () => {
      const repository = getRepository(activeDashboardRepository);
      const modal = document.getElementById('commitChangesModal');
      const repositoryLabel = document.getElementById('commitChangesRepository');
      const repositoryPath = document.getElementById('commitChangesRepositoryPath');
      const changesList = document.getElementById('commitChangesList');
      const message = document.getElementById('commitMessage');
      const result = document.getElementById('commitChangesResult');
      const selectAll = document.getElementById('commitSelectAll');
      const commitButton = document.getElementById('commitSelectedFilesButton');

      if (repositoryLabel) repositoryLabel.textContent = repository ? repository.name : activeDashboardRepository;
      if (repositoryPath) repositoryPath.value = activeDashboardRepository;
      if (changesList) changesList.innerHTML = '<div class="dashboard-loading">Loading changed files…</div>';
      workingTreeChanges = [];
      previewedWorkingTreeFile = null;
      workingTreePreviewRequestId++;
      const previewPath = document.getElementById('commitPreviewPath');
      const previewModes = document.getElementById('commitPreviewModes');
      const previewDiff = document.getElementById('commitPreviewDiff');
      const truncated = document.getElementById('commitPreviewTruncated');
      if (previewPath) previewPath.textContent = 'Select a file to preview its changes';
      if (previewModes) previewModes.hidden = true;
      if (previewDiff) previewDiff.innerHTML = '<span class="diff-placeholder">Select a file to preview its changes.</span>';
      if (truncated) truncated.textContent = '';
      if (message && commitDraftRepository !== activeDashboardRepository) message.value = '';
      commitDraftRepository = activeDashboardRepository;
      if (result) result.textContent = '';
      if (selectAll) selectAll.checked = true;
      if (commitButton) commitButton.disabled = false;
      document.querySelectorAll('input[name="commitPartial"]').forEach(radio => { radio.checked = false; });
      if (commitMessageRequest) postMessage('cancelCommitMessage', {});
      endCommitMessageRequest('');
      previousCommitMessage = null;
      updatePartialChoice();
      if (modal) modal.classList.add('active');

      postMessage('getWorkingTreeChanges', { repositoryPath: activeDashboardRepository });
    },

    // Copilot writes the message for the selected files; a second click while it writes cancels.
    generateCommitMessage: () => {
      if (commitMessageRequest) {
        postMessage('cancelCommitMessage', {});
        endCommitMessageRequest('Cancelled.');
        return;
      }
      const repositoryPath = document.getElementById('commitChangesRepositoryPath').value;
      const files = Array.from(document.querySelectorAll('.commit-change-checkbox:checked')).map(checkbox => checkbox.dataset.path).filter(Boolean);
      if (!files.length) {
        setCommitMessageStatus('Select the files to commit first: the message describes them.');
        return;
      }
      const partialChoice = document.querySelector('input[name="commitPartial"]:checked');
      // The message describes what will be committed: for a partly staged file that depends on the choice.
      if (selectedPartlyStaged().length && !partialChoice) {
        setCommitMessageStatus('Choose how to commit the partly staged files first: the message describes that.');
        return;
      }
      commitMessageRequest = ++commitMessageRequestId;
      commitMessagePendingPartial = partialChoice ? partialChoice.value : null;
      const button = document.getElementById('commitMessageGenerate');
      if (button) button.textContent = 'Cancel';
      setCommitMessageStatus('Reading the selected changes…');
      postMessage('generateCommitMessage', { requestId: commitMessageRequest, repositoryPath, files,
        partial: partialChoice ? partialChoice.value : undefined, modelId: selectedSummaryModelId || undefined });
    },
    undoCommitMessage: () => {
      const draft = document.getElementById('commitMessage');
      if (draft && previousCommitMessage !== null) draft.value = previousCommitMessage;
      previousCommitMessage = null;
      setCommitMessageStatus('Your earlier message is back.');
    },

    commitSelectedChanges: () => {
      const repositoryPath = document.getElementById('commitChangesRepositoryPath').value;
      const message = document.getElementById('commitMessage').value.trim();
      const files = Array.from(document.querySelectorAll('.commit-change-checkbox:checked'))
        .map(checkbox => checkbox.dataset.path)
        .filter(Boolean);
      const result = document.getElementById('commitChangesResult');
      const commitButton = document.getElementById('commitSelectedFilesButton');

      if (files.length === 0) {
        if (result) result.textContent = 'Select at least one changed file.';
        return;
      }
      if (!message) {
        if (result) result.textContent = 'Enter a commit message.';
        return;
      }
      const partialChoice = document.querySelector('input[name="commitPartial"]:checked');
      if (selectedPartlyStaged().length && !partialChoice) {
        if (result) result.textContent = 'Choose how to commit the partly staged files.';
        return;
      }
      const push = Boolean((document.getElementById('commitPushAfter') || {}).checked);

      if (result) result.textContent = push ? 'Creating commit, then pushing…' : 'Creating commit…';
      if (commitButton) commitButton.disabled = true;
      postMessage('commitFiles', { repositoryPath, files, message, push,
        partial: selectedPartlyStaged().length ? partialChoice.value : undefined });
    },

    openCreateBranchModal: (fromHistory = false) => {
      const fromCommit = fromHistory === true && branchFromCommitTarget;
      restoreBranchModalControls();
      if (fromCommit) branchFromCommitTarget = fromCommit;
      // Reset form fields
      document.getElementById('ticketId').value = '';
      document.getElementById('taskTitle').value = '';
      document.getElementById('productName').value = '';
      document.getElementById('releaseVersion').value = '';
      document.getElementById('devBranchName').value = '';
      document.getElementById('baseBranch').value = '';
      const baseBranchInput = document.getElementById('baseBranchInput');
      if (baseBranchInput) {
        baseBranchInput.value = '';
        baseBranchInput.placeholder = 'Loading branches...';
        baseBranchInput.disabled = Boolean(fromCommit);
      }
      document.getElementById('baseBranchDropdown').style.pointerEvents = fromCommit ? 'none' : '';
      document.getElementById('branchFromCommitCheckoutRow').hidden = !fromCommit;
      document.getElementById('branchFromCommitCheckout').checked = true;
      document.querySelectorAll('.branch-repository').forEach(cb => {
        if (cb.dataset.originalDisabled === undefined) cb.dataset.originalDisabled = cb.disabled ? 'true' : 'false';
        cb.disabled = fromCommit ? cb.value !== fromCommit.repositoryPath : cb.dataset.originalDisabled === 'true';
        cb.checked = fromCommit ? cb.value === fromCommit.repositoryPath : !cb.disabled;
      });
      const baseBranchList = document.getElementById('baseBranchList');
      if (baseBranchList) {
        baseBranchList.innerHTML = '';
      }
      const baseBranchDropdown = document.getElementById('baseBranchDropdown');
      if (baseBranchDropdown) {
        baseBranchDropdown.classList.remove('open');
      }
      // Request branches from the first available repository.
      if (fromCommit) {
        document.getElementById('baseBranch').value = fromCommit.hash;
        baseBranchInput.value = `Commit ${fromCommit.hash.slice(0, 12)}`;
        baseBranchInput.placeholder = '';
        updatePrefixOptions();
        document.getElementById('baseBranchHint').textContent = 'Branch starts at the selected commit.';
      } else {
        postMessage('getBaseBranchesForCreate', {});
      }
      showCreateBranchHint('');
      document.getElementById('createBranchModal').classList.add('active');
      // Retry if branches haven't loaded after 2s
      if (!fromCommit) retryLoadBaseBranches(3);
    },

    closeModal: (el) => {
      const modalId = el.dataset.modal;
      document.getElementById(modalId).classList.remove('active');
      if (modalId === 'createBranchModal') restoreBranchModalControls();
      // Closing the commit dialog stops a message still being written (the draft itself is kept).
      if (modalId === 'commitChangesModal' && commitMessageRequest) {
        postMessage('cancelCommitMessage', {});
        endCommitMessageRequest('');
      }
    },

    createBranch: () => {
      showCreateBranchHint('');
      const branchName = document.getElementById('branchName').value.trim();
      const baseBranch = document.getElementById('baseBranch').value.trim() || 'main';

      // Validate branch name
      if (!branchName ||
          branchName.includes('your-branch-name') ||
          branchName.endsWith('-') ||
          branchName.endsWith('_') ||
          branchName.includes('x.x.x')) {
        showCreateBranchHint('Fill in every field, so the branch name is complete.');
        return;
      }

      if (branchFromCommitTarget) {
        postMessage('createBranchFromCommit', { repositoryPath: branchFromCommitTarget.repositoryPath,
          commit: branchFromCommitTarget.hash, branchName,
          checkout: document.getElementById('branchFromCommitCheckout').checked });
        document.getElementById('createBranchModal').classList.remove('active');
        restoreBranchModalControls();
        return;
      }

      const checkboxes = document.querySelectorAll('.branch-repository:checked');
      const repositories = Array.from(checkboxes).map(cb => cb.value);
      if (repositories.length === 0) {
        showCreateBranchHint('Select at least one repository.');
        return;
      }

      // Store pending info for review
      pendingBranchInfo = { repositories, branchName, baseBranch };
      postMessage('createBranchWithReview', { submodules: repositories, branchName, baseBranch });
      document.getElementById('createBranchModal').classList.remove('active');
    },

    confirmAndPush: () => {
      if (!pendingBranchInfo) return;
      const shouldPush = document.getElementById('pushAfterCreate').checked;
      if (shouldPush) {
        postMessage('pushCreatedBranches', {
          submodules: pendingBranchInfo.repositories,
          branchName: pendingBranchInfo.branchName
        });
      }
      pendingBranchInfo = null;
      document.getElementById('reviewBranchModal').classList.remove('active');
    },

    // Reviews start at once: "changes" reviews the diff Base → Target, "branch" every file at Target.
    // The current branch: what it adds since the default branch ('changes'), or every file at its tip.
    reviewRelease: (el) => {
      hideReviewBranchMenu(false);
      startReview({ kind: 'release', scope: el.dataset.scope === 'changes' ? 'changes' : 'branch' });
    },
    toggleCopilotSettingsMenu: () => {
      const menu = document.getElementById('copilotSettingsMenu');
      if (!menu) return;
      if (menu.hidden) showCopilotSettingsMenu(); else hideCopilotSettingsMenu(true);
    },
    // The choice is shown at once; the extension saves it and reports the setting back.
    setAskBeforeSending: (el) => {
      renderCopilotSettings({ askBeforeSending: el.dataset.value });
      hideCopilotSettingsMenu(true);
      postMessage('setCopilotSettings', { askBeforeSending: el.dataset.value });
    },
    openExtensionSettings: () => {
      hideCopilotSettingsMenu(false);
      postMessage('openExtensionSettings', {});
    },
    toggleReviewBranchMenu: () => {
      const menu = document.getElementById('reviewBranchMenu');
      if (!menu || reviewLocked()) return;
      if (menu.hidden) showReviewBranchMenu(); else hideReviewBranchMenu(true);
    },
    // Local changes: HEAD → a snapshot of the working tree the extension takes when the review starts.
    // Whether there is anything to review is decided when the snapshot is taken, not from the last refresh.
    reviewLocal: () => startReview({ kind: 'local', scope: 'changes' }),
    // Review the changes the detail pane shows: the selected commit against its parent, or the
    // loaded comparison from Base to Target. Every file at the branch tip is reviewed from All files in the Review branch menu.
    reviewSelection: () => {
      if (!changeSummarySelection || changeSummarySelection.local) return;
      const { baseSha, targetSha } = changeSummarySelection;
      const labels = comparisonLabels || {};
      startReview({ scope: 'changes', base: comparisonSource ? baseSha || undefined : undefined, target: targetSha,
        baseLabel: labels.base, targetLabel: labels.target });
    },


    contextReviewCommit: () => {
      if (!historyContextTarget) return;
      hideHistoryContextMenu();
      // No base: the extension reviews the commit against its parent.
      startReview({ scope: 'changes', target: historyContextTarget.hash });
    },

    contextReviewSnapshot: () => {
      if (!historyContextTarget) return;
      hideHistoryContextMenu();
      startReview({ scope: 'branch', target: historyContextTarget.hash });
    },

    // The Repository Review tab: opened beside the dashboard, where reviews run and are read.
    openReviewTab: () => postMessage('openReviewTab', {}),

    syncAll: () => postMessage('syncVersions', { submodules: [] })
  };

  let commitMessageRequestId = 0;
  let commitMessageRequest = 0;
  // The partly staged choice the last written message describes.
  let commitMessagePartial = null;
  let commitMessagePendingPartial = null;
  let previousCommitMessage = null;

  function setCommitMessageStatus(html, isHtml) {
    const status = document.getElementById('commitMessageStatus');
    if (!status) return;
    if (isHtml) status.innerHTML = html; else status.textContent = html;
  }

  function endCommitMessageRequest(message) {
    commitMessageRequest = 0;
    const button = document.getElementById('commitMessageGenerate');
    if (button) button.textContent = 'Write with Copilot';
    if (message !== undefined) setCommitMessageStatus(message);
  }

  function updateCommitSelectionCount() {
    const selected = document.querySelectorAll('.commit-change-checkbox:checked').length;
    const count = document.getElementById('commitSelectionCount');
    if (count) count.textContent = selected + ' selected';
    updatePartialChoice();
  }

  // Renders a unified patch with old/new file line numbers. Git's file headers
  // (diff/index/---/+++) are dropped because the panel title already names the file.
  function renderPatchLines(patch) {
    const lines = String(patch || '').replace(/\n$/, '').split('\n');
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    const row = (className, oldNumber, newNumber, text) => `<span class="diff-line ${className}"><i class="diff-ln">${oldNumber}</i><i class="diff-ln">${newNumber}</i><span class="diff-text">${escapeHtml(text) || ' '}</span></span>`;
    return lines.map(line => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        return row('diff-hunk', '', '', line);
      }
      if (!inHunk || line.startsWith('diff --git ')) {
        inHunk = false;
        if (/^(diff --git |index |--- |\+\+\+ )/.test(line)) return '';
        return row('diff-meta', '', '', line);
      }
      if (line.startsWith('+')) return row('diff-addition', '', newLine++, line);
      if (line.startsWith('-')) return row('diff-deletion', oldLine++, '', line);
      if (line.startsWith('\\')) return row('diff-meta', '', '', line);
      return row('diff-context', oldLine++, newLine++, line);
    }).join('');
  }

  function selectWorkingTreePreview(filePath) {
    const change = workingTreeChanges.find(item => item.path === filePath);
    if (!change) return;
    previewedWorkingTreeFile = filePath;
    document.querySelectorAll('.commit-change-preview-button').forEach(button => {
      button.classList.toggle('active', button.dataset.path === filePath);
    });
    const heading = document.getElementById('commitPreviewPath');
    const modes = document.getElementById('commitPreviewModes');
    if (heading) heading.textContent = filePath;
    if (modes) {
      modes.hidden = false;
      // Both stay visible: an empty side is disabled and says why, rather than disappearing.
      modes.querySelectorAll('button').forEach(button => {
        const empty = button.dataset.mode === 'staged' ? !change.staged : !change.unstaged && !change.untracked;
        button.disabled = empty;
        button.title = empty
          ? (button.dataset.mode === 'staged' ? 'Nothing of this file is staged' : 'No changes beyond what is staged')
          : (button.dataset.mode === 'staged' ? 'Show the changes already staged (the index)' : 'Show the changes not staged yet (the working tree)');
      });
    }
    requestWorkingTreePreview(change.unstaged || change.untracked ? 'unstaged' : 'staged');
  }

  function requestWorkingTreePreview(mode) {
    const change = workingTreeChanges.find(item => item.path === previewedWorkingTreeFile);
    if (!change || (mode === 'staged' && !change.staged)
      || (mode === 'unstaged' && !change.unstaged && !change.untracked)) return;
    workingTreePreviewMode = mode;
    workingTreePreviewRequestId++;
    const modes = document.getElementById('commitPreviewModes');
    if (modes) modes.querySelectorAll('button').forEach(button => {
      button.classList.toggle('active', button.dataset.mode === mode);
      button.setAttribute('aria-pressed', button.dataset.mode === mode ? 'true' : 'false');
    });
    const diff = document.getElementById('commitPreviewDiff');
    const truncated = document.getElementById('commitPreviewTruncated');
    if (diff) diff.innerHTML = '<span class="diff-placeholder">Loading diff…</span>';
    if (truncated) truncated.textContent = '';
    postMessage('getWorkingTreePreview', {
      repositoryPath: document.getElementById('commitChangesRepositoryPath').value,
      path: previewedWorkingTreeFile,
      mode,
      requestId: workingTreePreviewRequestId
    });
  }

  function isCurrentWorkingTreePreview(payload) {
    const modal = document.getElementById('commitChangesModal');
    const repositoryPath = document.getElementById('commitChangesRepositoryPath');
    return modal && modal.classList.contains('active') && repositoryPath
      && payload.repositoryPath === repositoryPath.value
      && payload.path === previewedWorkingTreeFile
      && payload.mode === workingTreePreviewMode
      && payload.requestId === workingTreePreviewRequestId;
  }

  function renderWorkingTreeChanges(payload) {
    const repositoryPath = document.getElementById('commitChangesRepositoryPath');
    if (!repositoryPath || repositoryPath.value !== payload.repositoryPath) return;

    const changes = Array.isArray(payload.changes) ? payload.changes : [];
    workingTreeChanges = changes;
    const pushAfter = document.getElementById('commitPushAfter');
    if (pushAfter) pushAfter.checked = Boolean(payload.pushAfterCommit);
    const list = document.getElementById('commitChangesList');
    if (!list) return;
    if (changes.length === 0) {
      list.innerHTML = '<div class="dashboard-empty">Working tree is clean.</div>';
      updateCommitSelectionCount();
      return;
    }

    list.innerHTML = changes.map(change => {
      const state = change.conflicted
        ? 'conflict'
        : change.untracked
          ? 'untracked'
          : change.staged && change.unstaged
            ? 'staged + modified'
            : change.staged
              ? 'staged'
              : 'modified';
      const rename = change.originalPath
        ? '<small>' + escapeHtml(change.originalPath) + ' →</small>'
        : '';
      return '<div class="commit-change-row' + (change.conflicted ? ' conflicted' : '') + '">' +
        '<input type="checkbox" class="commit-change-checkbox" data-path="' + escapeHtml(change.path) + '"' +
          ' aria-label="Include ' + escapeHtml(change.path) + ' in commit"' +
          (change.conflicted ? ' disabled' : ' checked') + '>' +
        '<button type="button" class="commit-change-preview-button" data-action="previewWorkingTreeFile"' +
          ' data-path="' + escapeHtml(change.path) + '" title="' + escapeHtml(change.path) + '">' +
          '<span class="commit-change-path">' + rename + '<strong>' + escapeHtml(change.path) + '</strong></span>' +
          '<span class="commit-change-state">' + state + '</span>' +
        '</button>' +
      '</div>';
    }).join('');
    updateCommitSelectionCount();
    selectWorkingTreePreview(changes[0].path);
  }

  // Selected files staged, then changed again: the commit takes either the staged part or the whole file.
  function selectedPartlyStaged() {
    const selected = new Set(Array.from(document.querySelectorAll('.commit-change-checkbox:checked')).map(checkbox => checkbox.dataset.path));
    return workingTreeChanges.filter(change => selected.has(change.path) && change.staged && change.unstaged && !change.untracked && !change.conflicted);
  }

  function updatePartialChoice() {
    const fieldset = document.getElementById('commitPartialChoice');
    if (!fieldset) return;
    const partly = selectedPartlyStaged();
    fieldset.hidden = partly.length === 0;
    const legend = document.getElementById('commitPartialLegend');
    if (legend && partly.length) {
      legend.textContent = partly.length === 1
        ? `${partly[0].path} is partly staged: it was staged, then changed again`
        : `${partly.length} selected files are partly staged: staged, then changed again`;
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function getRepository(path) {
    return repositoryData.find(repository => repository.path === path);
  }

  // Branch alignment: linked repositories should be on the parent repository's branch.
  // Commit alignment (atRecordedCommit) is tracked separately. A submodule checked out
  // detached at the commit the parent records is the normal result of `git submodule update`:
  // it is pinned, not a problem.
  function getRepositoryAlignment(repository, targetBranch) {
    if (repository.isParentRepo) return 'parent';
    if (repository.status === 'uninitialized') return 'uninitialized';
    // Detached with no recorded commit is "unrecorded" (its own badge): Align has nothing to restore.
    if (!repository.currentBranch) return repository.atRecordedCommit === true ? 'pinned' : repository.atRecordedCommit === false ? 'detached' : 'unrecorded';
    return targetBranch && repository.currentBranch !== targetBranch ? 'drifted' : 'aligned';
  }

  function renderRepositorySwitcher() {
    const list = document.getElementById('dashboardRepositories');
    const summary = document.getElementById('repositoryAlignment');
    if (!list) return;
    const parent = repositoryData.find(repository => repository.isParentRepo) || repositoryData[0];
    const targetBranch = parent ? parent.currentBranch : '';
    const linked = repositoryData.filter(repository => repository !== parent);
    const aligned = linked.filter(repository => ['aligned', 'pinned'].includes(getRepositoryAlignment(repository, targetBranch))
      && repository.atRecordedCommit === true).length;
    if (summary) {
      // The word is hidden in a narrow sidebar; the tooltip keeps the full meaning.
      summary.innerHTML = linked.length ? `${aligned}/${linked.length}<span class="alignment-word"> aligned</span>` : '';
      summary.title = `${aligned} of ${linked.length} linked repositories are at the commit the parent records, on ${targetBranch || 'the parent branch'} or pinned there (detached)`;
      summary.classList.toggle('drifted', aligned < linked.length);
    }

    list.innerHTML = repositoryData.map(repository => {
      const alignment = getRepositoryAlignment(repository, targetBranch);
      const active = repository.path === activeDashboardRepository;
      const unavailable = alignment === 'uninitialized';
      const branch = repository.currentBranch || `(detached) ${repository.currentCommit || ''}`.trim();
      const badges = [
        changeBadges(repository.changeCounts),
        repository.behind > 0 ? `<span class="repo-badge" title="${repository.behind} commit(s) behind its upstream branch: Pull brings them in">↓${repository.behind}</span>` : '',
        repository.ahead > 0 ? `<span class="repo-badge" title="${repository.ahead} commit(s) ahead of its upstream branch: Push sends them">↑${repository.ahead}</span>` : '',
        alignment === 'pinned'
          ? `<span class="repo-badge repo-badge-muted" title="Detached at the commit the parent records, as git submodule update leaves it. Nothing to fix; check out ${escapeHtml(targetBranch || 'a branch')} only to commit here">pinned</span>`
          : '',
        alignment === 'drifted'
          ? `<span class="repo-badge repo-badge-drift" title="On ${escapeHtml(repository.currentBranch)}, not on the parent's branch ${escapeHtml(targetBranch)}. Checkout ${escapeHtml(targetBranch)} to align it">drift</span>`
          : '',
        alignment === 'detached'
          ? `<span class="repo-badge repo-badge-drift" title="Detached at ${escapeHtml(repository.currentCommit || 'a commit')}, which is not the commit the parent records. Align restores the recorded commit">detached</span>`
          : '',
        repository.atRecordedCommit === false
          ? `<span class="repo-badge repo-badge-drift" title="HEAD ${escapeHtml(repository.currentCommit)} differs from the commit ${escapeHtml(repository.recordedCommit)} the parent records. Align (or Reset to recorded) checks out the recorded commit; committing the parent records this one instead">≠ recorded</span>`
          : '',
        !repository.isParentRepo && alignment !== 'uninitialized' && repository.atRecordedCommit === undefined
          ? '<span class="repo-badge repo-badge-drift" title="The parent records no commit for this repository yet, for example a submodule added but not committed. Commit the parent to record one">unrecorded</span>'
          : '',
        alignment === 'uninitialized' ? '<span class="repo-badge repo-badge-muted" title="Declared in .gitmodules but not cloned. Initialize submodules to check it out">not initialized</span>' : ''
      ].join('');
      const title = unavailable
        ? `${repository.name} is not initialized`
        : `${repository.name} · ${branch} · ${repository.status}${alignment === 'drifted' ? ` (parent is on ${targetBranch})` : ''}`;
      const resetAction = repository.atRecordedCommit === false
        ? `<button class="sidebar-repository-action" type="button" data-action="syncRepositoryToRecorded" data-path="${escapeHtml(repository.path)}" title="Reset ${escapeHtml(repository.name)} to the recorded commit ${escapeHtml(repository.recordedCommit)}">Reset to recorded</button>`
        : '';
      return `<div class="sidebar-repository-row"><button class="sidebar-repository-item${active ? ' active' : ''}" type="button"${active ? ' aria-current="true"' : ''} data-action="selectDashboardRepository" data-path="${escapeHtml(repository.path)}" title="${escapeHtml(title)}"${unavailable ? ' disabled' : ''}>
        <span class="repo-status-dot status-${escapeHtml(repository.status)}" aria-hidden="true"></span>
        <span class="repo-copy"><strong>${escapeHtml(repository.name)}${repository.isParentRepo ? ' <small>parent</small>' : ''}</strong><code>${escapeHtml(branch)}</code></span>
        <span class="repo-badges">${badges}</span>
      </button>${resetAction}</div>`;
    }).join('') || '<span class="sidebar-placeholder">No repositories</span>';
    applyReviewLock();
  }

  // Local changes by kind, as VS Code's Source Control letters; the tooltip spells them out.
  const CHANGE_KINDS = [
    ['staged', 'S', 'staged', 'repo-change-staged'],
    ['modified', 'M', 'modified, not staged', 'repo-change-modified'],
    ['untracked', 'U', 'untracked', 'repo-change-untracked'],
    ['conflicted', 'C', 'with conflicts', 'repo-change-conflicted']
  ];

  function changeBadges(counts) {
    if (!counts) return '';
    return CHANGE_KINDS.filter(([key]) => counts[key] > 0).map(([key, letter, words, className]) => {
      const label = `${counts[key]} file${counts[key] === 1 ? '' : 's'} ${words}`;
      return `<span class="repo-badge repo-change ${className}" title="${label}" aria-label="${label}">${letter}${counts[key]}</span>`;
    }).join('');
  }

  function shortRevision(revision) {
    if (!revision) return '';
    return revision.length >= 12 && /^[0-9a-f]+$/i.test(revision) ? revision.slice(0, 8) : revision;
  }

  function checkoutBranchFromRef(ref) {
    if (!ref || !ref.name) return '';
    if (ref.kind === 'head' || ref.kind === 'local-branch') return ref.name;
    if (ref.kind === 'remote-branch') {
      const separator = ref.name.indexOf('/');
      return separator >= 0 ? ref.name.slice(separator + 1) : ref.name;
    }
    return '';
  }

  function renderHistoryRefs(refs, interactive) {
    return (refs || []).map(ref => {
      const className = `history-ref ref-${escapeHtml(ref.kind)}`;
      const branch = interactive ? checkoutBranchFromRef(ref) : '';
      if (!branch) return `<span class="${className}" title="${escapeHtml(ref.name)}">${escapeHtml(ref.name)}</span>`;
      return `<button class="${className}" type="button" data-branch="${escapeHtml(branch)}" title="Double-click to checkout ${escapeHtml(branch)}">${escapeHtml(ref.name)}</button>`;
    }).join('');
  }

  function setBranchCheckoutPending(isPending) {
    document.querySelectorAll('[data-branch]').forEach(item => {
      const matches = pendingBranchCheckout && item.dataset.branch === pendingBranchCheckout.branch;
      item.classList.toggle('checkout-pending', Boolean(isPending && matches));
      if (isPending && matches) item.setAttribute('aria-busy', 'true');
      else item.removeAttribute('aria-busy');
    });
  }

  function requestBranchCheckout(branch, replaceWithRemote = false) {
    if (!branch || pendingBranchCheckout) return;
    const current = getRepository(activeDashboardRepository);
    if (current && current.currentBranch === branch && !replaceWithRemote) {
      setHistoryRevision('');
      requestDashboardHistory(0, false);
      return;
    }
    pendingBranchCheckout = { repositoryPath: activeDashboardRepository, branch, replaceWithRemote };
    setBranchCheckoutPending(true);
    postMessage('checkoutBranch', {
      submodule: activeDashboardRepository,
      branch,
      replaceWithRemote
    });
  }

  function updateCommitCompareUI() {
    document.querySelectorAll('.history-row').forEach(row => {
      const marker = commitCompareSelection[0] === row.dataset.commit
        ? 'B'
        : commitCompareSelection[1] === row.dataset.commit
          ? 'T'
          : '';
      row.classList.toggle('compare-base', marker === 'B');
      row.classList.toggle('compare-target', marker === 'T');
    });
    document.querySelectorAll('.graph-node-control').forEach(node => {
      const marker = commitCompareSelection[0] === node.dataset.commit
        ? 'B'
        : commitCompareSelection[1] === node.dataset.commit
          ? 'T'
          : '';
      node.dataset.marker = marker;
      node.setAttribute('aria-pressed', marker ? 'true' : 'false');
      const accessibleLabel = marker
        ? `${marker === 'B' ? 'Base' : 'Target'} commit ${shortRevision(node.dataset.commit)}. Press to remove from comparison.`
        : `Select commit ${shortRevision(node.dataset.commit)} for comparison.`;
      node.setAttribute('aria-label', accessibleLabel);
      const markerLabel = node.querySelector('.graph-node-marker');
      const title = node.querySelector('title');
      if (markerLabel) markerLabel.textContent = marker;
      if (title) title.textContent = accessibleLabel;
    });
    const status = document.getElementById('commitCompareStatus');
    if (!status) return;
    if (commitCompareSelection.length === 0) {
      status.hidden = true;
      status.innerHTML = '';
      return;
    }
    status.hidden = false;
    status.innerHTML = commitCompareSelection.length === 1
      ? `<span class="compare-role">B</span> ${escapeHtml(shortRevision(commitCompareSelection[0]))} · Ctrl+click a second commit <button type="button" data-action="clearCommitComparison" aria-label="Clear comparison">×</button>`
      : `<span class="compare-range" title="Base ${escapeHtml(shortRevision(commitCompareSelection[0]))} → Target ${escapeHtml(shortRevision(commitCompareSelection[1]))}"><span class="compare-role">B</span> ${escapeHtml(shortRevision(commitCompareSelection[0]))} → <span class="compare-role compare-role-target">T</span> ${escapeHtml(shortRevision(commitCompareSelection[1]))}</span> <button type="button" data-action="clearCommitComparison" aria-label="Clear comparison">×</button>`;
    applyReviewLock();
  }

  function loadParentCommitDetail(commitHash) {
    if (!commitHash) return;
    if (commitHash === WORKING_TREE) { selectWorkingTree(); return; }
    resetChangeSummary();
    selectedDashboardCommit = commitHash;
    activeComparisonTarget = commitHash;
    comparisonBaseHash = null;
    comparisonSource = null;
    comparisonLabels = null;
    document.querySelectorAll('.history-row').forEach(row => {
      row.classList.toggle('active', row.dataset.commit === commitHash);
    });
    updateUncommittedRow();
    const workingModes = document.getElementById('workingDiffModes');
    if (workingModes) workingModes.hidden = true;
    updateCommitCompareUI();
    saveState();
    showCommitDetailLoading();
    postMessage('getCommitDetail', {
      repositoryPath: activeDashboardRepository,
      commitHash
    });
  }

  function clearCommitComparison(restoreParent) {
    const shouldRestoreParent = Boolean(restoreParent && comparisonSource && selectedDashboardCommit);
    commitCompareSelection = [];
    comparisonRepository = activeDashboardRepository;
    updateCommitCompareUI();
    saveState();
    if (shouldRestoreParent) loadParentCommitDetail(selectedDashboardCommit);
  }

  function toggleCommitCompareNode(commitHash) {
    if (!commitHash) return;
    commitChosen = true; // a picked node, or half of a comparison, is not replaced by the working tree
    const transition = window.RepositoryHistoryGraph.transitionCompareSelection(
      commitCompareSelection,
      commitHash,
      Boolean(comparisonSource)
    );
    commitCompareSelection = transition.selection;
    comparisonRepository = activeDashboardRepository;
    updateCommitCompareUI();
    saveState();
    if (transition.action === 'compare') {
      loadComparison(commitCompareSelection[0], commitCompareSelection[1], 'commits');
    } else if (transition.action === 'parent') {
      const remainingCommit = commitCompareSelection[0] || selectedDashboardCommit;
      if (remainingCommit) loadParentCommitDetail(remainingCommit);
    }
  }

  function loadComparison(baseRevision, targetRevision, source, labels) {
    comparisonLabels = labels || null;
    resetChangeSummary();
    selectedDashboardCommit = targetRevision;
    activeComparisonTarget = targetRevision;
    comparisonBaseHash = baseRevision;
    comparisonSource = source;
    document.querySelectorAll('.history-row').forEach(row => {
      row.classList.toggle('active', row.dataset.commit === targetRevision);
    });
    showCommitDetailLoading();
    const status = document.getElementById('commitCompareStatus');
    if (status) {
      status.hidden = false;
      const kind = { branches: 'Compare', review: 'Review' }[source] || 'Commits';
      const base = labels && labels.base ? labels.base : shortRevision(baseRevision);
      const target = labels && labels.target ? labels.target : shortRevision(targetRevision);
      status.innerHTML = `<span class="compare-range" title="${kind}: ${escapeHtml(base)} → ${escapeHtml(target)}">${kind}: ${escapeHtml(base)} → ${escapeHtml(target)}</span> <button type="button" data-action="clearCommitComparison" aria-label="Clear comparison">×</button>`;
      applyReviewLock();
    }
    saveState();
    postMessage('getCommitDetail', {
      repositoryPath: activeDashboardRepository,
      commitHash: targetRevision,
      baseRevision
    });
  }

  function populateBranchCompareSelects(baseSelect, targetSelect) {
    if (!baseSelect || !targetSelect) return;
    const branches = repositoryRefs.branches || [];
    const branchOptions = branches.map(branch => {
      const revision = branch.isRemote ? `origin/${branch.name}` : branch.name;
      return `<option value="${escapeHtml(revision)}" data-label="${escapeHtml(revision)}">${escapeHtml(branch.name)}${branch.isRemote ? ' (remote)' : ''}</option>`;
    }).join('');
    // Tags too, newest version first, so a release (1.12.0 → main) is two picks. refs/tags/ keeps a
    // tag apart from a branch of the same name; the label is the tag's own name.
    const tagOptions = sortTagsByVersion(repositoryRefs.tags || []).map(tag =>
      `<option value="refs/tags/${escapeHtml(tag.name)}" data-label="${escapeHtml(tag.name)}">${escapeHtml(tag.name)}</option>`).join('');
    const options = (branchOptions ? `<optgroup label="Branches">${branchOptions}</optgroup>` : '') +
      (tagOptions ? `<optgroup label="Tags">${tagOptions}</optgroup>` : '');
    baseSelect.innerHTML = options || '<option value="">No branches or tags</option>';
    targetSelect.innerHTML = options || '<option value="">No branches or tags</option>';
    const current = branches.find(branch => branch.isCurrent);
    const alternative = branches.find(branch => !branch.isCurrent && !branch.isRemote) || branches.find(branch => !branch.isCurrent);
    if (current) baseSelect.value = current.name;
    if (alternative) targetSelect.value = alternative.isRemote ? `origin/${alternative.name}` : alternative.name;
  }

  // Version tags (1.12.0, v2.0.0) newest first, compared number by number; other tags after, by name.
  function sortTagsByVersion(tags) {
    const version = name => { const match = /^v?(\d+(?:\.\d+)*)$/.exec(name); return match ? match[1].split('.').map(Number) : null; };
    return tags.slice().sort((a, b) => {
      const left = version(a.name);
      const right = version(b.name);
      if (left && right) {
        for (let i = 0; i < Math.max(left.length, right.length); i++) {
          const difference = (right[i] || 0) - (left[i] || 0);
          if (difference) return difference;
        }
        return 0;
      }
      if (left || right) return left ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  function getDashboardFilters(repositoryPath) {
    return window.RepositoryHistoryGraph.normalizeHistoryFilters(dashboardHistoryState[repositoryPath]);
  }

  function setHistoryRevision(revision) {
    if (!activeDashboardRepository) return;
    const current = getDashboardFilters(activeDashboardRepository);
    dashboardHistoryState[activeDashboardRepository] = Object.assign({}, current, {
      branch: revision || ''
    });
  }

  function captureDashboardFilters() {
    if (!activeDashboardRepository) return;
    const current = getDashboardFilters(activeDashboardRepository);
    const includeRemotes = document.getElementById('dashboardIncludeRemotes');
    const search = document.getElementById('dashboardSearch');
    dashboardHistoryState[activeDashboardRepository] = {
      branch: current.branch,
      includeRemotes: Boolean(includeRemotes && includeRemotes.checked),
      search: search ? search.value : ''
    };
  }

  function applyDashboardFilters(repositoryPath) {
    const filters = getDashboardFilters(repositoryPath);
    const includeRemotes = document.getElementById('dashboardIncludeRemotes');
    const search = document.getElementById('dashboardSearch');
    if (includeRemotes) includeRemotes.checked = filters.includeRemotes;
    if (search) search.value = filters.search;
  }

  function activateDashboardRepository(repositoryPath) {
    const repository = getRepository(repositoryPath);
    if (!repository) return;

    if (dashboardActivated) captureDashboardFilters();
    if (repositoryPath !== activeDashboardRepository) {
      cancelPendingChangeSummary();
      changeSummaries.clear();
    }
    if (repositoryPath !== activeDashboardRepository) {
      commitChosen = false;
      workingTree = { repositoryPath: null, changes: [] };
    }
    activeDashboardRepository = repositoryPath;
    resetChangeSummary();
    const canRestoreComparison = !dashboardActivated && comparisonRepository === repositoryPath;
    if (!canRestoreComparison) {
      selectedDashboardCommit = null;
      commitCompareSelection = [];
      comparisonRepository = repositoryPath;
    }
    selectedDashboardFile = null;
    historyNextOffset = null;
    loadedHistoryCommits = [];
    comparisonBaseHash = null;
    activeComparisonTarget = null;
    comparisonSource = null;
    comparisonLabels = null;
    repositoryRefs = { branches: [], tags: [], remotes: [], stashes: [] };
    applyDashboardFilters(repositoryPath);
    dashboardActivated = true;
    updateCommitCompareUI();
    // The review tab follows the repository the dashboard shows.
    publishReviewContext();
    const behindCount = document.getElementById('dashboardBehindCount');
    const aheadCount = document.getElementById('dashboardAheadCount');
    if (behindCount) {
      behindCount.textContent = repository.behind > 0 ? String(repository.behind) : '';
      behindCount.hidden = repository.behind <= 0;
    }
    if (aheadCount) {
      aheadCount.textContent = repository.ahead > 0 ? String(repository.ahead) : '';
      aheadCount.hidden = repository.ahead <= 0;
    }

    const history = document.getElementById('dashboardHistory');
    showHistoryLoading(history);
    clearCommitDetail();
    saveState();
    requestDashboardHistory(0, false);
    postMessage('getRepositoryRefs', { repositoryPath });
    // Update the repository list (ahead/behind, changes) only when it is not fresh. It used to send
    // 'refresh', whose result reloads history and refs: opening the dashboard loaded everything twice.
    if (Date.now() - repositoryDataAt > 5000) postMessage('refreshRepositories', {});
  }

  // While new history loads, the old rows stay (dimmed, not clickable) instead of the list
  // flashing to a loading message; with nothing shown yet, the message appears.
  function showHistoryLoading(history) {
    if (!history) return;
    // inert keeps keyboard focus and Enter off the old rows too, not only the pointer.
    if (history.querySelector('.history-row')) { history.classList.add('history-stale'); history.inert = true; }
    else { uncommittedRowRendered = false; history.innerHTML = '<div class="dashboard-loading">Loading history…</div>'; }
  }

  function captureHistoryViewport(history) {
    if (!history) return null;
    const scrollTop = history.scrollTop;
    const rows = Array.from(history.querySelectorAll('.history-row'));
    const anchor = rows.find(row => row.offsetTop + row.offsetHeight > scrollTop);
    return {
      commit: anchor ? anchor.dataset.commit : null,
      offset: anchor ? anchor.offsetTop - scrollTop : 0,
      scrollTop
    };
  }

  function requestDashboardHistory(offset, append, options) {
    const search = document.getElementById('dashboardSearch');
    const includeRemotes = document.getElementById('dashboardIncludeRemotes');
    const history = document.getElementById('dashboardHistory');
    const preserveViewport = Boolean(options && options.preserveViewport && !append);
    const viewport = preserveViewport ? captureHistoryViewport(history) : null;
    if (!append && !preserveViewport) loadedHistoryCommits = [];
    captureDashboardFilters();
    const filters = getDashboardFilters(activeDashboardRepository);
    saveState();
    if (!append && !preserveViewport) showHistoryLoading(history);
    // A fresh load supersedes a page still on its way, whose reply will be dropped.
    historyAppendPending = Boolean(append);
    if (!append) historyRequestId += 1;
    pendingHistoryViewport = viewport
      ? Object.assign({}, viewport, { requestId: historyRequestId, repositoryPath: activeDashboardRepository })
      : null;
    postMessage('getHistory', {
      repositoryPath: activeDashboardRepository,
      limit: 100,
      offset: offset || 0,
      search: search ? search.value.trim() : '',
      branch: filters.branch || undefined,
      includeRemotes: Boolean(includeRemotes && includeRemotes.checked),
      append: Boolean(append),
      requestId: historyRequestId
    });
  }

  // Branch names grouped by '/' into folders: feature/a and feature/b sit under "feature".
  // Folders come first, then branches, each alphabetically.
  function buildBranchTree(branches) {
    const root = { folders: new Map(), branches: [], path: '' };
    branches.forEach(branch => {
      const parts = branch.name.split('/');
      let node = root;
      parts.slice(0, -1).forEach(part => {
        if (!part) return;
        if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), branches: [], path: node.path ? `${node.path}/${part}` : part });
        node = node.folders.get(part);
      });
      node.branches.push(branch);
    });
    return root;
  }

  function countBranches(node) {
    let count = node.branches.length;
    node.folders.forEach(child => { count += countBranches(child); });
    return count;
  }

  function hasCurrentBranch(node) {
    return node.branches.some(branch => branch.isCurrent) || Array.from(node.folders.values()).some(hasCurrentBranch);
  }

  const collapsedBranchFolders = new Set(); // `${repositoryPath}\0${folder}`

  function renderBranchTree(node, depth, renderBranch) {
    const folders = Array.from(node.folders.entries()).sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => {
      // The folder holding the checked-out branch is never collapsed out of sight.
      const expanded = !collapsedBranchFolders.has(`${activeDashboardRepository}\u0000${child.path}`) || hasCurrentBranch(child);
      return `<div class="sidebar-branch-folder-row branch-depth-${Math.min(depth, 6)}"><button type="button" class="sidebar-branch-folder" data-action="toggleBranchFolder" data-folder="${escapeHtml(child.path)}" aria-expanded="${expanded}" title="${escapeHtml(child.path)}/"><span class="sidebar-branch-chevron" aria-hidden="true">${expanded ? '▾' : '▸'}</span><span>${escapeHtml(name)}</span><small>${countBranches(child)}</small></button></div>` +
        (expanded ? `<div role="group" aria-label="${escapeHtml(child.path)}">${renderBranchTree(child, depth + 1, renderBranch)}</div>` : '');
    }).join('');
    const leaves = node.branches.slice().sort((a, b) => a.name.localeCompare(b.name)).map(branch => renderBranch(branch, depth)).join('');
    return folders + leaves;
  }

  function formatHistoryDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value || '';
    const ageMs = Date.now() - date.getTime();
    if (ageMs >= 0 && ageMs < 60 * 60 * 1000) return `${Math.max(1, Math.floor(ageMs / 60000))} min ago`;
    if (ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000) return `${Math.floor(ageMs / 3600000)} h ago`;
    if (ageMs >= 0 && ageMs < 7 * 24 * 60 * 60 * 1000) return `${Math.floor(ageMs / 86400000)} d ago`;
    // One formatter for every row: building an Intl.DateTimeFormat per date cost ~140 ms per 2000 rows.
    if (!historyDateFormat) historyDateFormat = new Intl.DateTimeFormat(undefined, { month: 'short', day: '2-digit', year: 'numeric' });
    return historyDateFormat.format(date);
  }

  // A lane change: an S-curve whose handles meet halfway down, so it leaves and enters each column
  // vertically and turns evenly however tall the row is (fixed 9px handles bent sharply in tall rows).
  function laneCurve(fromX, fromY, toX, toY) {
    const half = (toY - fromY) / 2;
    return `M ${fromX} ${fromY} C ${fromX} ${fromY + half}, ${toX} ${toY - half}, ${toX} ${toY}`;
  }

  function renderHistoryGraph(commits, graphModel, rowHeights = []) {
    const paths = [];
    const nodes = [];
    const controls = [];
    let top = 0;
    graphModel.rows.forEach((layout, index) => {
      const commit = commits[index];
      const rowHeight = rowHeights[index] || graphModel.rowHeight;
      const middle = top + (rowHeight / 2);
      const bottom = top + rowHeight;
      const currentX = window.RepositoryHistoryGraph.laneX(layout.lane);
      // Colours follow branches, not columns: each branch path keeps its colour.
      const tone = value => `graph-lane-${(value === undefined ? 0 : value) % 8}`;
      const color = layout.color === undefined ? layout.lane : layout.color;
      const beforeColors = layout.beforeColors || [];
      const afterColors = layout.afterColors || [];
      const continuingLaneCount = Math.max(layout.before.length, layout.after.length);
      for (let lane = 0; lane < continuingLaneCount; lane += 1) {
        if (lane === layout.lane) continue;
        if (layout.before[lane] && layout.after[lane] && layout.before[lane] === layout.after[lane]) {
          const x = window.RepositoryHistoryGraph.laneX(lane);
          paths.push(`<path class="graph-edge ${tone(afterColors[lane] === undefined ? lane : afterColors[lane])}" d="M ${x} ${top} V ${bottom}"/>`);
        }
      }

      if (!layout.startsHere) {
        paths.push(`<path class="graph-edge ${tone(color)}" d="M ${currentX} ${top} V ${middle}"/>`);
      }
      // Other children of this commit arrive from their own columns.
      (layout.incomingLanes || []).forEach(lane => {
        const x = window.RepositoryHistoryGraph.laneX(lane);
        paths.push(`<path class="graph-edge ${tone(beforeColors[lane] === undefined ? lane : beforeColors[lane])}" d="${laneCurve(x, top, currentX, middle)}"/>`);
      });
      layout.parentLanes.forEach((parentLane, parentIndex) => {
        const parentX = window.RepositoryHistoryGraph.laneX(parentLane);
        const edgeColor = layout.parentColors ? layout.parentColors[parentIndex] : parentIndex === 0 ? layout.lane : parentLane;
        paths.push(parentLane === layout.lane
          ? `<path class="graph-edge ${tone(edgeColor)}" d="M ${currentX} ${middle} V ${bottom}"/>`
          : `<path class="graph-edge ${tone(edgeColor)}" d="${laneCurve(currentX, middle, parentX, bottom)}"/>`);
      });

      const decorated = (commit.refs || []).length > 0 || layout.isMerge;
      nodes.push(layout.isHead
        ? `<circle class="graph-node graph-node-head ${tone(color)}" cx="${currentX}" cy="${middle}" r="6"/>`
        : decorated
          ? `<circle class="graph-node ${tone(color)}" cx="${currentX}" cy="${middle}" r="5.5"/><circle class="graph-node-core ${tone(color)}" cx="${currentX}" cy="${middle}" r="2.3"/>`
          : `<circle class="graph-node-core ${tone(color)}" cx="${currentX}" cy="${middle}" r="4"/>`);
      controls.push(`<g class="graph-node-control" data-action="toggleCommitCompareNode" data-commit="${escapeHtml(commit.hash)}" transform="translate(${currentX} ${middle})" role="button" tabindex="0" aria-label="Select commit ${escapeHtml(commit.shortHash)} for comparison" aria-pressed="false" data-marker=""><title>Select ${escapeHtml(commit.shortHash)} for comparison</title><circle class="graph-node-hit" r="12"/><circle class="graph-node-selection" r="10"/><text class="graph-node-marker" text-anchor="middle" dominant-baseline="central"></text></g>`);
      top = bottom;
    });
    return `<svg class="history-graph-overlay" width="${graphModel.width}" height="${top}" viewBox="0 0 ${graphModel.width} ${top}">${paths.join('')}${nodes.join('')}${controls.join('')}</svg>`;
  }

  function renderGraphCell() {
    return '<span class="history-graph-cell" aria-hidden="true"></span>';
  }

  function scheduleHistoryGraphGeometry() {
    if (historyGraphGeometryFrame) return;
    historyGraphGeometryFrame = requestAnimationFrame(() => {
      historyGraphGeometryFrame = 0;
      const history = document.getElementById('dashboardHistory');
      if (!history || !loadedHistoryGraphModel) return;
      const rows = Array.from(history.querySelectorAll('.history-row'));
      if (!rows.length || rows.length !== loadedHistoryCommits.length) return;
      const heights = rows.map(row => row.offsetHeight);
      const signature = heights.join(',');
      if (signature === historyGraphGeometrySignature) return;
      const overlay = history.querySelector('.history-graph-overlay');
      if (!overlay) return;
      overlay.outerHTML = renderHistoryGraph(loadedHistoryCommits, loadedHistoryGraphModel, heights);
      historyGraphGeometrySignature = signature;
      updateCommitCompareUI();
    });
  }

  // Older commits load when the end of the list is within 400px of the view; there is no button.
  function loadHistoryNearEnd() {
    const list = document.getElementById('dashboardHistory');
    if (!list || historyNextOffset === null || historyAppendPending) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 400) actions.loadMoreHistory();
  }

  function renderHistoryPage(payload) {
    if (!payload || payload.repositoryPath !== activeDashboardRepository || payload.requestId !== historyRequestId) return;
    const history = document.getElementById('dashboardHistory');
    if (!history) return;

    history.classList.remove('history-stale');
    history.inert = false;
    if (payload.offset > 0) historyAppendPending = false;
    const appendError = history.querySelector('.history-append-error');
    if (appendError) appendError.remove(); // the page that failed has loaded since
    const renderedCount = loadedHistoryCommits.length;
    let addedCommits = [];
    if (payload.offset > 0) {
      const knownHashes = new Set(loadedHistoryCommits.map(commit => commit.hash));
      addedCommits = (payload.commits || []).filter(commit => !knownHashes.has(commit.hash));
      loadedHistoryCommits = loadedHistoryCommits.concat(addedCommits);
    } else {
      loadedHistoryCommits = payload.commits || [];
      loadedHistoryUpstream = typeof payload.upstream === 'string' ? payload.upstream : null;
    }
    const graphModel = window.RepositoryHistoryGraph.buildGraphModel(loadedHistoryCommits, { upstream: loadedHistoryUpstream });
    loadedHistoryGraphModel = graphModel;
    historyGraphGeometrySignature = '';
    const historyRegion = history.closest('.history-region');
    historyGraphWidth = graphModel.width;
    if (historyRegion) historyRegion.style.setProperty('--graph-width', `${graphModel.width}px`);
    const renderRows = commits => commits.map(commit => {
      const refs = renderHistoryRefs(commit.refs, true);
      return `<div class="history-row" data-action="selectHistoryCommit" data-commit="${escapeHtml(commit.hash)}" tabindex="0" title="Ctrl+click or Shift+click to compare">
        ${renderGraphCell()}
        <span class="history-message">${refs ? `<span class="history-refs">${refs}</span>` : ''}<button class="history-subject" type="button" data-action="selectHistoryCommit" data-commit="${escapeHtml(commit.hash)}">${escapeHtml(commit.subject)}</button></span>
        <span class="history-author" title="${escapeHtml(commit.authorEmail)}">${escapeHtml(commit.authorName)}</span>
        <span class="history-date">${escapeHtml(formatHistoryDate(commit.authoredAt))}</span>
        <code class="history-hash">${escapeHtml(commit.shortHash)}</code>
      </div>`;
    }).join('');

    const append = payload.offset > 0;
    // Column widths read the current layout, so they are set before the rows change: reading it
    // after writing 2000 rows forced a full layout right away (~160 ms).
    applyHistoryColumnWidths(historyColumnWidths);
    const content = history.querySelector('.history-table-content');
    if (append && content && content.querySelectorAll('.history-row').length === renderedCount) {
      // Load more adds only the new rows; the graph is redrawn once, from the rows' real heights,
      // by the geometry pass in the next frame. Re-rendering every row made each page slower.
      if (addedCommits.length) content.insertAdjacentHTML('beforeend', renderRows(addedCommits));
      scheduleHistoryGraphGeometry();
    } else {
      const rows = renderRows(loadedHistoryCommits);
      const uncommitted = uncommittedRowHtml();
      uncommittedRowRendered = Boolean(uncommitted);
      history.innerHTML = uncommitted + (rows
        ? `<div class="history-table-content">${renderHistoryGraph(loadedHistoryCommits, graphModel)}${rows}</div>`
        : '<div class="dashboard-empty">No commits match this view.</div>');
    }
    const viewport = pendingHistoryViewport;
    if (viewport && viewport.requestId === payload.requestId && viewport.repositoryPath === payload.repositoryPath) {
      const anchor = viewport.commit
        ? Array.from(history.querySelectorAll('.history-row')).find(row => row.dataset.commit === viewport.commit)
        : null;
      history.scrollTop = anchor ? Math.max(0, anchor.offsetTop - viewport.offset) : 0;
      pendingHistoryViewport = null;
    }
    historyNextOffset = payload.nextOffset;
    updateCommitCompareUI();
    // Once, for repositoryManager.debug.timings: when the first history page is on screen.
    if (!historyDrawnReported && loadedHistoryCommits.length) {
      historyDrawnReported = true;
      requestAnimationFrame(() => requestAnimationFrame(() => postMessage('dashboardTiming', { name: 'history drawn' })));
    }
    // A page that does not reach past the view cannot be scrolled to its end: load the next one now.
    requestAnimationFrame(loadHistoryNearEnd);

    if (!append && payload.commits && payload.commits.length > 0) {
      const visibleHashes = new Set(loadedHistoryCommits.map(commit => commit.hash));
      commitCompareSelection = comparisonRepository === activeDashboardRepository
        ? commitCompareSelection.filter(hash => visibleHashes.has(hash)).slice(0, 2)
        : [];
      const preferred = payload.commits.find(commit => commit.hash === selectedDashboardCommit) || payload.commits[0];
      updateCommitCompareUI();
      if (commitCompareSelection.length === 2) {
        loadComparison(commitCompareSelection[0], commitCompareSelection[1], 'commits');
      } else if (dashboardWorkingChanges().length && (selectedDashboardCommit === WORKING_TREE || (!commitChosen && commitCompareSelection.length === 0))) {
        selectWorkingTree();
      } else {
        loadParentCommitDetail(preferred.hash);
      }
    }
    if (!append) requestWorkingTreeSummary();
  }

  // Set when a stash was applied or popped in this repository; the next status opens its changes.
  let openWorkingTreeAfterStash = null;

  // One status request at a time per repository: a second ask while one runs asks once more afterwards.
  let workingSummaryInFlight = null;
  let workingSummaryAgain = false;
  function requestWorkingTreeSummary() {
    if (!activeDashboardRepository) return;
    if (workingSummaryInFlight === activeDashboardRepository) { workingSummaryAgain = true; return; }
    workingSummaryInFlight = activeDashboardRepository;
    workingSummaryAgain = false;
    postMessage('getWorkingTreeChanges', { repositoryPath: activeDashboardRepository, purpose: 'dashboard' });
  }

  function workingSummaryAnswered(repositoryPath) {
    if (workingSummaryInFlight !== repositoryPath) return;
    workingSummaryInFlight = null;
    if (workingSummaryAgain) requestWorkingTreeSummary();
  }

  function dashboardWorkingChanges() {
    return workingTree.repositoryPath === activeDashboardRepository ? workingTree.changes : [];
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

  function uncommittedRowHtml() {
    const changes = dashboardWorkingChanges();
    if (!changes.length) return '';
    const active = selectedDashboardCommit === WORKING_TREE;
    return `<div class="uncommitted-row${active ? ' active' : ''}" id="uncommittedRow" data-action="selectWorkingTree" role="button" tabindex="0" aria-pressed="${active}" title="Your staged and unstaged changes, not committed yet">
      <span class="uncommitted-graph"><span class="uncommitted-dot" aria-hidden="true"></span></span>
      <span class="history-message"><strong class="history-subject">Uncommitted changes</strong><span class="uncommitted-counts">${escapeHtml(workingTreeCountText(changes))}</span></span>
      <span class="history-author"></span><span class="history-date">Now</span><code class="history-hash">*</code>
    </div>`;
  }

  function updateUncommittedRow() {
    const history = document.getElementById('dashboardHistory');
    if (!history) return;
    const html = uncommittedRowHtml();
    // Nothing shown and nothing to show: leave the history alone.
    if (!html && !uncommittedRowRendered) return;
    const existing = uncommittedRowRendered ? document.getElementById('uncommittedRow') : null;
    uncommittedRowRendered = Boolean(html);
    if (existing && html) existing.outerHTML = html;
    else if (existing) existing.remove();
    else if (html) history.insertAdjacentHTML('afterbegin', html);
  }

  // The status of the active repository arrived (on load, after a refresh or a live update).
  function applyWorkingTreeSummary(payload) {
    if (payload) workingSummaryAnswered(payload.repositoryPath);
    if (!payload || payload.repositoryPath !== activeDashboardRepository) return;
    workingTree = { repositoryPath: payload.repositoryPath, changes: Array.isArray(payload.changes) ? payload.changes : [] };
    updateUncommittedRow();
    const hasChanges = workingTree.changes.length > 0;
    if (openWorkingTreeAfterStash === payload.repositoryPath) {
      // A stash was just applied or popped: show where its changes went.
      openWorkingTreeAfterStash = null;
      if (hasChanges) { selectWorkingTree(); return; }
    }
    if (selectedDashboardCommit === WORKING_TREE) {
      if (hasChanges) renderWorkingTreeDetail();
      else if (loadedHistoryCommits.length) loadParentCommitDetail(loadedHistoryCommits[0].hash);
      else clearCommitDetail();
    } else if (hasChanges && !commitChosen && !comparisonSource && commitCompareSelection.length === 0) {
      selectWorkingTree();
    }
  }

  function selectWorkingTree() {
    if (!dashboardWorkingChanges().length) return;
    if (selectedDashboardCommit !== WORKING_TREE) selectedDashboardFile = null;
    resetChangeSummary();
    selectedDashboardCommit = WORKING_TREE;
    activeComparisonTarget = null;
    comparisonBaseHash = null;
    comparisonSource = null;
    comparisonLabels = null;
    commitCompareSelection = [];
    updateCommitCompareUI();
    document.querySelectorAll('.history-row').forEach(row => row.classList.remove('active'));
    updateUncommittedRow();
    saveState();
    renderWorkingTreeDetail();
  }

  // The detail pane for the working tree: what the next commit would hold, file by file.
  function renderWorkingTreeDetail() {
    const changes = dashboardWorkingChanges();
    const summary = document.getElementById('dashboardCommitSummary');
    const files = document.getElementById('dashboardChangedFiles');
    const count = document.getElementById('changedFileCount');
    // Laid out like a commit: avatar, title, what and where, the "hash" (*), then its actions.
    // Summarize changes below works on the same snapshot of the working tree a review uses.
    // A summary is of the changes as they were: when the files or their state change, it goes.
    const signature = JSON.stringify(changes.map(change => [change.path, change.staged, change.unstaged, change.untracked, change.conflicted]));
    if (changeSummarySelection && changeSummarySelection.local && changeSummarySelection.signature !== signature) {
      const key = changeSummaryKey(changeSummarySelection);
      if (!(changeSummaries.get(key) || {}).pending) changeSummaries.delete(key);
      changeSummarySelection.signature = signature;
      restoreChangeSummary();
    }
    if (!changeSummarySelection || !changeSummarySelection.local) {
      changeSummarySelection = { local: true, baseSha: null, targetSha: WORKING_TREE, files: [], signature };
      restoreChangeSummary();
    }
    if (summary) {
      const repository = getRepository(activeDashboardRepository);
      const where = repository && repository.currentBranch ? `on ${repository.currentBranch}` : 'detached HEAD';
      const head = repository && repository.currentCommit ? ` · HEAD ${shortRevision(repository.currentCommit)} → working tree` : '';
      summary.innerHTML = `<div class="commit-avatar uncommitted-avatar" aria-hidden="true">*</div><div class="commit-summary-copy"><strong>Uncommitted changes</strong><span>${escapeHtml(workingTreeCountText(changes))} · ${escapeHtml(where)}${escapeHtml(head)}</span></div><code title="Not committed yet">*</code>`;
    }
    if (count) count.textContent = String(changes.length);
    // Review changes follows the review lock; Review commit has no commit to review here.
    applyReviewLock();
    if (!files) return;
    files.innerHTML = changes.map(change => {
      const status = change.conflicted ? 'unmerged' : change.untracked ? 'added' : change.originalPath ? 'renamed'
        : (change.indexStatus === 'D' || change.workTreeStatus === 'D') ? 'deleted' : (change.indexStatus === 'A') ? 'added' : 'modified';
      const state = change.conflicted ? 'conflict' : change.untracked ? 'new' : change.staged && change.unstaged ? 'staged + modified' : change.staged ? 'staged' : 'modified';
      return `<button class="changed-file-item status-${escapeHtml(status)}" type="button" data-action="selectChangedFile" data-path="${escapeHtml(change.path)}" title="${escapeHtml(state)}"><span class="file-status-glyph">${changedFileGlyph(status)}</span><span class="file-path"><strong>${escapeHtml(change.path.split('/').pop())}</strong><small>${escapeHtml(change.originalPath ? `${change.originalPath} → ${change.path}` : change.path)} · ${escapeHtml(state)}</small></span><span>›</span></button>`;
    }).join('');
    const kept = selectedDashboardFile && Array.from(files.querySelectorAll('.changed-file-item')).find(item => item.dataset.path === selectedDashboardFile);
    const first = kept || files.querySelector('.changed-file-item');
    if (first) actions.selectChangedFile(first);
  }

  // Staged diff (the index) or Unstaged diff (the working tree) of the selected file.
  function requestWorkingDiff(mode) {
    const change = dashboardWorkingChanges().find(item => item.path === selectedDashboardFile);
    const modes = document.getElementById('workingDiffModes');
    if (!change) return;
    const canStaged = change.staged;
    const canUnstaged = change.unstaged || change.untracked;
    workingDiffMode = mode === 'staged' && canStaged ? 'staged' : mode === 'unstaged' && canUnstaged ? 'unstaged' : canUnstaged ? 'unstaged' : 'staged';
    if (modes) {
      modes.hidden = false;
      modes.querySelectorAll('button').forEach(button => {
        const empty = button.dataset.mode === 'staged' ? !canStaged : !canUnstaged;
        button.disabled = empty;
        button.classList.toggle('active', button.dataset.mode === workingDiffMode);
        button.setAttribute('aria-pressed', button.dataset.mode === workingDiffMode ? 'true' : 'false');
      });
    }
    postMessage('getWorkingTreePreview', { repositoryPath: activeDashboardRepository, path: change.path, mode: workingDiffMode, requestId: ++workingPreviewRequestId });
  }


  function renderRepositoryRefs(payload) {
    if (!payload || payload.repositoryPath !== activeDashboardRepository) return;
    const branches = payload.branches || [];
    const tags = payload.tags || [];
    const remotes = payload.remotes || [];
    const stashes = payload.stashes || [];
    repositoryRefs = { branches, tags, remotes, stashes };
    const branchList = document.getElementById('dashboardBranches');
    const tagList = document.getElementById('dashboardTags');
    const remoteList = document.getElementById('dashboardRemotes');
    const stashList = document.getElementById('dashboardStashes');

    const branchCount = document.getElementById('branchRefCount');
    const tagCount = document.getElementById('tagRefCount');
    const remoteCount = document.getElementById('remoteRefCount');
    const stashCount = document.getElementById('stashRefCount');
    if (branchCount) branchCount.textContent = branches.length;
    if (tagCount) tagCount.textContent = tags.length;
    if (remoteCount) remoteCount.textContent = remotes.length;
    if (stashCount) stashCount.textContent = stashes.length;

    if (branchList) {
      const renderBranch = (branch, depth) => {
        const useOrigin = branch.hasRemote
          ? `<button class="sidebar-ref-origin-action" type="button" data-action="replaceLocalBranchFromRemote" data-branch="${escapeHtml(branch.name)}" title="Reset local branch to origin/${escapeHtml(branch.name)}">Reset to origin</button>`
          : '';
        const deleteBranch = !branch.isCurrent && !branch.isRemote
          ? `<button class="sidebar-ref-delete-action" type="button" data-action="deleteDashboardBranch" data-branch="${escapeHtml(branch.name)}" data-has-remote="${branch.hasRemote ? 'true' : 'false'}" title="Delete local branch ${escapeHtml(branch.name)}" aria-label="Delete local branch ${escapeHtml(branch.name)}">×</button>`
          : '';
        const branchActions = useOrigin || deleteBranch
          ? `<span class="sidebar-ref-actions">${useOrigin}${deleteBranch}</span>`
          : '';
        const leaf = branch.name.split('/').pop();
        return `<div class="sidebar-ref-row branch-depth-${Math.min(depth, 6)}"><button class="sidebar-ref-item${branch.isCurrent ? ' current' : ''}" type="button" data-action="selectDashboardBranch" data-branch="${escapeHtml(branch.name)}" title="${escapeHtml(branch.name)}" aria-pressed="${branch.isCurrent ? 'true' : 'false'}"><span>⑂</span><span>${escapeHtml(leaf)}</span>${branch.isCurrent ? '<small>HEAD</small>' : ''}</button>${branchActions}</div>`;
      };
      branchList.innerHTML = renderBranchTree(buildBranchTree(branches), 0, renderBranch) || '<span class="sidebar-placeholder">No branches</span>';
    }
    if (tagList) {
      tagList.innerHTML = tags.map(tag => `<button class="reference-detail-item" type="button" data-action="selectReference" data-revision="${escapeHtml(tag.name)}"><span>◇</span><span class="reference-detail-copy"><strong>${escapeHtml(tag.name)}</strong><small>${escapeHtml(shortRevision(tag.targetHash))}${tag.createdAt ? ` · ${escapeHtml(formatHistoryDate(tag.createdAt))}` : ''}</small></span></button>`).join('') || '<span class="sidebar-placeholder">No tags</span>';
    }
    if (remoteList) {
      remoteList.innerHTML = remotes.map(remote => `<div class="reference-detail-item" title="Fetch: ${escapeHtml(remote.fetchUrl)}&#10;Push: ${escapeHtml(remote.pushUrl)}"><span>☁</span><span class="reference-detail-copy"><strong>${escapeHtml(remote.name)}</strong><small>fetch · ${escapeHtml(remote.fetchUrl || 'not configured')}</small><small>push · ${escapeHtml(remote.pushUrl || 'not configured')}</small></span></div>`).join('') || '<span class="sidebar-placeholder">No remotes</span>';
    }
    if (stashList) {
      stashList.innerHTML = stashes.map(stash => `<button class="reference-detail-item" type="button" data-action="selectReference" data-revision="${escapeHtml(stash.ref)}"><span>▱</span><span class="reference-detail-copy"><strong>${escapeHtml(stash.ref)} · ${escapeHtml(stash.subject)}</strong><small>${escapeHtml(formatHistoryDate(stash.createdAt))}</small></span></button>`).join('') || '<span class="sidebar-placeholder">No stashes</span>';
    }
    updateSelectedBranchUI();
    populateBranchCompareSelects(document.getElementById('compareBaseBranch'), document.getElementById('compareTargetBranch'));
  }

  function updateSelectedBranchUI(revision) {
    const currentBranch = (repositoryRefs.branches || []).find(branch => branch.isCurrent);
    const selectedRevision = revision || (currentBranch ? currentBranch.name : '');
    document.querySelectorAll('#dashboardBranches .sidebar-ref-item').forEach(item => {
      const selected = item.dataset.branch === selectedRevision;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', selected ? 'true' : 'false');
    });
  }

  function clearCommitDetail() {
    selectedDashboardFile = null;
    const summary = document.getElementById('dashboardCommitSummary');
    const files = document.getElementById('dashboardChangedFiles');
    const diff = document.getElementById('dashboardDiff');
    if (summary) summary.innerHTML = '<div class="detail-placeholder">Select a commit to inspect its changed files and diff.</div>';
    if (files) files.innerHTML = '';
    if (diff) diff.innerHTML = '<span class="diff-placeholder">Select a changed file to load its patch.</span>';
    const count = document.getElementById('changedFileCount');
    if (count) count.textContent = '0';
  }

  function showCommitDetailLoading() {
    const summary = document.getElementById('dashboardCommitSummary');
    const files = document.getElementById('dashboardChangedFiles');
    const diff = document.getElementById('dashboardDiff');
    if (summary) summary.innerHTML = '<div class="dashboard-loading">Loading commit detail…</div>';
    if (files) files.innerHTML = '';
    if (diff) diff.innerHTML = '<span class="diff-placeholder">Select a changed file to load its patch.</span>';
  }

  function changedFileGlyph(status) {
    const glyphs = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', 'type-changed': 'T', unmerged: '!', unknown: '?' };
    return glyphs[status] || '?';
  }

  function renderCommitDetail(payload) {
    if (!payload || payload.repositoryPath !== activeDashboardRepository || !payload.detail) return;
    const detail = payload.detail;
    const expectedTarget = activeComparisonTarget || selectedDashboardCommit;
    if (payload.targetRevision !== expectedTarget && detail.hash !== expectedTarget) return;
    selectedDashboardCommit = detail.hash;
    activeComparisonTarget = detail.hash;
    comparisonBaseHash = detail.comparisonBaseHash || null;
    resetChangeSummary();
    changeSummarySelection = { baseSha: comparisonBaseHash, targetSha: detail.hash, files: detail.files || [],
      stash: Boolean(detail.stash) && detail.comparisonMode === 'parent' };
    applyReviewLock(); // Review commit has something to review
    restoreChangeSummary();
    const summary = document.getElementById('dashboardCommitSummary');
    const files = document.getElementById('dashboardChangedFiles');
    const count = document.getElementById('changedFileCount');
    if (summary) {
      const refs = (detail.refs || []).map(ref => `<span class="history-ref ref-${escapeHtml(ref.kind)}">${escapeHtml(ref.name)}</span>`).join('');
      const initials = (detail.authorName || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(part => part.charAt(0)).join('').toUpperCase();
      const comparisonText = detail.comparisonBaseHash
        ? `${detail.comparisonMode === 'parent' ? 'Parent' : 'Compare'} ${escapeHtml(shortRevision(detail.comparisonBaseHash))} → ${escapeHtml(detail.shortHash)}`
        : `Root commit → ${escapeHtml(detail.shortHash)}`;
      // A stash reads as one: its own message, which stash it is and the branch it was made on.
      const stash = detail.stash;
      const title = stash ? stash.message || detail.subject : detail.subject;
      const who = stash ? `Stash ${stash.ref}${stash.branch ? ` · on ${stash.branch}` : ''}` : detail.authorName;
      const avatar = stash ? '<div class="commit-avatar stash-avatar" aria-hidden="true">▱</div>' : `<div class="commit-avatar">${escapeHtml(initials)}</div>`;
      summary.innerHTML = `${avatar}<div class="commit-summary-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(who)} · ${escapeHtml(formatHistoryDate(detail.authoredAt))} · ${comparisonText}</span>${detail.body && detail.body !== detail.subject ? `<p>${escapeHtml(detail.body)}</p>` : ''}</div><code>${escapeHtml(detail.shortHash)}</code><div class="commit-summary-refs">${refs}</div>`;
    }
    if (count) count.textContent = String((detail.files || []).length);
    if (files) {
      files.innerHTML = (detail.files || []).map(file => `<button class="changed-file-item status-${escapeHtml(file.status)}" type="button" data-action="selectChangedFile" data-path="${escapeHtml(file.path)}"><span class="file-status-glyph">${changedFileGlyph(file.status)}</span><span class="file-path"><strong>${escapeHtml(file.path.split('/').pop())}</strong><small>${escapeHtml(file.oldPath ? `${file.oldPath} → ${file.path}` : file.path)}</small></span><span>›</span></button>`).join('') || '<div class="dashboard-empty">No changed files.</div>';
      const jumpFile = pendingEvidenceJump && (detail.files || []).find(file =>
        file.path === pendingEvidenceJump.path || file.oldPath === pendingEvidenceJump.path);
      const firstFile = jumpFile
        ? Array.from(files.querySelectorAll('.changed-file-item')).find(item => item.dataset.path === jumpFile.path)
        : files.querySelector('.changed-file-item');
      if (!jumpFile) pendingEvidenceJump = null;
      if (firstFile) actions.selectChangedFile(firstFile);
    }
  }

  function renderFileDiff(payload) {
    if (!payload || payload.repositoryPath !== activeDashboardRepository || payload.commitHash !== selectedDashboardCommit || payload.path !== selectedDashboardFile) return;
    const diff = document.getElementById('dashboardDiff');
    const truncated = document.getElementById('diffTruncated');
    if (!diff) return;
    diff.innerHTML = renderPatchLines(payload.patch);
    if (truncated) truncated.textContent = payload.truncated ? 'Patch truncated at 1 MiB' : '';
    highlightEvidenceLine();
  }

  function renderDashboardError(payload) {
    if (payload && payload.request === 'getWorkingTreeChanges') {
      // The status could not be read: say so rather than keep showing the last one as current.
      workingSummaryAnswered(payload.repositoryPath);
      if (payload.repositoryPath !== activeDashboardRepository) return;
      workingTree = { repositoryPath: payload.repositoryPath, changes: [] };
      updateUncommittedRow();
      if (selectedDashboardCommit === WORKING_TREE) {
        const summary = document.getElementById('dashboardCommitSummary');
        if (summary) summary.innerHTML = `<div class="dashboard-error">Cannot read the local changes: ${escapeHtml(payload.message)}</div>`;
      }
      return;
    }
    if (!payload || payload.repositoryPath !== activeDashboardRepository) return;
    const history = document.getElementById('dashboardHistory');
    if (payload.request === 'getHistory' && history) {
      const appending = historyAppendPending;
      historyAppendPending = false;
      history.classList.remove('history-stale');
      history.inert = false;
      // A next page that failed keeps the rows already shown, with a way to ask for it again
      // (scrolling near the end asks again too).
      if (appending && history.querySelector('.history-row')) {
        const previous = history.querySelector('.history-append-error');
        if (previous) previous.remove();
        history.insertAdjacentHTML('beforeend', `<div class="dashboard-error history-append-error" role="alert">${escapeHtml(payload.message)} <button type="button" class="link-button" data-action="loadMoreHistory">Retry</button></div>`);
        return;
      }
      { uncommittedRowRendered = false; history.innerHTML = `<div class="dashboard-error">${escapeHtml(payload.message)}</div>`; }
      return;
    }
    const target = payload.request === 'getCommitDetail'
      ? document.getElementById('dashboardCommitSummary')
      : payload.request === 'getFileDiff'
        ? document.getElementById('dashboardDiff')
        : null;
    if (target) target.innerHTML = `<div class="dashboard-error">${escapeHtml(payload.message)}</div>`;
  }

  // Ripple effect for buttons
  document.body.addEventListener('mousedown', function (e) {
    const btn = e.target.closest('.btn');
    if (!btn) return;
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    const rect = btn.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    ripple.addEventListener('animationend', function () { ripple.remove(); });
  });

  // Event delegation - handle all clicks
  document.body.addEventListener('click', function (e) {
    if (!e.target.closest('#historyContextMenu, #changesContextMenu')) hideHistoryContextMenu();
    if (!e.target.closest('#reviewBranchMenu, #reviewBranchMenuButton')) hideReviewBranchMenu(false);
    if (!e.target.closest('#copilotSettingsMenu, #copilotSettingsButton')) hideCopilotSettingsMenu(false);
    if (!e.target.closest('#summaryModelMenu, #summaryModelButton')) hideSummaryModelMenu(false);
    let el = e.target;

    // Walk up the DOM tree to find element with data-action
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.action) {
        const action = el.dataset.action;
        if (actions[action]) {
          e.preventDefault();
          actions[action](el, e);
        }
        return;
      }
      el = el.parentElement;
    }
  });

  document.body.addEventListener('contextmenu', function (e) {
    const changesElement = e.target.closest('#uncommittedRow, #dashboardChangedFiles .changed-file-item');
    if (changesElement) {
      if (showChangesContextMenu(changesElement, e.clientX, e.clientY)) e.preventDefault();
      return;
    }
    const commitElement = e.target.closest('.history-row, .graph-node-control[data-commit]');
    if (!commitElement) {
      hideHistoryContextMenu();
      return;
    }
    if (showHistoryContextMenu(commitElement, e.clientX, e.clientY)) e.preventDefault();
  });
  window.addEventListener('scroll', hideHistoryContextMenu, true);
  window.addEventListener('blur', hideHistoryContextMenu);
  // The menu is placed under its button once: scrolling or resizing would leave it behind.
  // Scrolling inside the Model menu (a long list) keeps it open.
  window.addEventListener('scroll', (e) => {
    hideReviewBranchMenu(false); hideCopilotSettingsMenu(false);
    if (!(e.target && e.target.id === 'summaryModelMenu')) hideSummaryModelMenu(false);
  }, true);
  window.addEventListener('resize', () => { hideReviewBranchMenu(false); hideCopilotSettingsMenu(false); hideSummaryModelMenu(false); });
  document.body.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      hideHistoryContextMenu();
      hideReviewBranchMenu(true);
      hideCopilotSettingsMenu(true);
      hideSummaryModelMenu(true);
    }
    moveInSummaryModelMenu(e);
    const changesKeyTarget = (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) &&
      e.target.closest('#uncommittedRow, #dashboardChangedFiles .changed-file-item');
    if (changesKeyTarget) {
      e.preventDefault();
      const rect = changesKeyTarget.getBoundingClientRect();
      showChangesContextMenu(changesKeyTarget, rect.left + 10, rect.top + 10);
    } else if ((e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) && e.target.closest('.history-row')) {
      e.preventDefault();
      const rect = e.target.getBoundingClientRect();
      showHistoryContextMenu(e.target.closest('.history-row'), rect.left + 10, rect.top + 10);
    }
  });

  document.body.addEventListener('dblclick', function (e) {
    const branchRef = e.target.closest('.history-ref[data-branch]');
    if (!branchRef) return;
    e.preventDefault();
    e.stopPropagation();
    requestBranchCheckout(branchRef.dataset.branch);
  });

  // The Uncommitted changes row is a div (it holds no button of its own): Enter and Space open it.
  document.body.addEventListener('keydown', function (e) {
    const row = e.target.closest && e.target.closest('#uncommittedRow');
    if (!row || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    actions.selectWorkingTree();
  });

  document.body.addEventListener('keydown', function (e) {
    const graphNode = e.target.closest && e.target.closest('.graph-node-control');
    if (!graphNode || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    toggleCommitCompareNode(graphNode.dataset.commit);
  });

  // Handle workspace folder switching
  const workspaceFolderSelect = document.getElementById('workspaceFolderSelect');
  if (workspaceFolderSelect) {
    workspaceFolderSelect.addEventListener('change', function (e) {
      const folderPath = e.target.value;
      if (folderPath) {
        postMessage('switchWorkspaceFolder', { folderPath });
      }
    });
  }

  // The repository and branch list is shown in VS Code's Side Bar, not in this tab. The dashboard
  // still renders it (hidden here) and owns its state; it sends a copy to the Side Bar after every
  // change and runs the Side Bar's clicks on its own elements, through the same handlers.
  const dashboardSidebar = document.querySelector('.dashboard-shell .dashboard-sidebar');
  // An element's key names what it does (its action and data), so it stays valid across refreshes.
  const mirrorKey = element => JSON.stringify(Object.keys(element.dataset).filter(name => name !== 'mirrorKey').sort()
    .map(name => [name, element.dataset[name]]));
  let sidebarPublishPending = false;
  function publishSidebar() {
    sidebarPublishPending = false;
    if (!dashboardSidebar) return;
    dashboardSidebar.querySelectorAll('[data-action]').forEach(element => {
      const key = mirrorKey(element);
      if (element.dataset.mirrorKey !== key) element.dataset.mirrorKey = key;
    });
    postMessage('sidebarSnapshot', { html: dashboardSidebar.innerHTML });
  }
  function scheduleSidebarPublish() {
    if (sidebarPublishPending) return;
    sidebarPublishPending = true;
    requestAnimationFrame(publishSidebar);
  }
  if (dashboardSidebar && typeof MutationObserver === 'function') {
    new MutationObserver(records => {
      // Writing the keys is itself a change; only other changes need a new copy.
      if (records.some(record => record.attributeName !== 'data-mirror-key')) scheduleSidebarPublish();
    }).observe(dashboardSidebar, { subtree: true, childList: true, characterData: true, attributes: true });
  }
  function runSidebarAction(payload) {
    if (!dashboardSidebar || !payload || typeof payload.key !== 'string') return;
    const target = Array.from(dashboardSidebar.querySelectorAll('[data-action]')).find(element => mirrorKey(element) === payload.key);
    // A click from an older copy whose item is gone (or now disabled) does nothing.
    if (!target || target.disabled || target.getAttribute('aria-disabled') === 'true') return;
    if (payload.event === 'dblclick') target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    else target.click();
  }

  // Handle messages from extension
  window.addEventListener('message', event => {
    const message = event.data;
    if (!message || !message.type) return;

    try {
      switch (message.type) {
        case 'summaryModelsLoaded': {
          const models = Array.isArray(message.payload?.models) ? message.payload.models : [];
          summaryModels = models.filter(model => model && typeof model.id === 'string' && typeof model.name === 'string');
          // Pins of models Copilot no longer offers are kept (the model may come back), not shown.
          if (Array.isArray(message.payload?.pinned)) pinnedModelIds = message.payload.pinned.filter(id => typeof id === 'string');
          // A chosen model Copilot does not offer now falls back to Default here, but stays saved:
          // it may be back once Copilot is signed in again.
          if (selectedSummaryModelId && !summaryModels.some(model => model.id === selectedSummaryModelId)) {
            cancelPendingChangeSummary();
            selectedSummaryModelId = '';
            selectedSummaryModelName = '';
            publishReviewContext();
          }
          summaryModelsState = 'loaded';
          renderSummaryModelMenu();
          restoreChangeSummary();
          break;
        }
        case 'summaryModelsError': {
          // Opening the menu again retries.
          summaryModelsState = 'idle';
          renderSummaryModelMenu();
          document.getElementById('changeSummaryStatus').textContent = message.payload?.message || 'Unable to load models.';
          syncChangeSummaryArea();
          break;
        }
        case 'changeSummaryProgress':
        case 'changeSummaryLoaded':
        case 'changeSummaryError': {
          const payload = message.payload;
          const entry = Array.from(changeSummaries.entries()).find(([, record]) =>
            record.requestId === payload?.requestId && record.repositoryPath === payload.repositoryPath);
          if (!entry || !entry[1].pending) break;
          const [key, record] = entry;
          if (message.type === 'changeSummaryProgress') {
            record.status = payload.status;
          } else {
            record.pending = false;
            if (activeChangeSummaryKey === key) activeChangeSummaryKey = null;
            if (message.type === 'changeSummaryLoaded') {
              record.summary = payload.summary;
              record.model = payload.model;
              record.status = `Completed · ${payload.model}`;
            } else {
              record.status = payload.message;
            }
          }
          if (isCurrentChangeSummary(payload)) {
            if (record.summary) renderChangeSummary(payload);
            else restoreChangeSummary();
          }
          break;
        }
        case 'workingTreeChangesLoaded':
          if (message.payload && message.payload.purpose === 'dashboard') applyWorkingTreeSummary(message.payload);
          else renderWorkingTreeChanges(message.payload);
          break;

        case 'workingTreePreviewLoaded': {
          const payload = message.payload;
          if (payload.requestId === workingPreviewRequestId && selectedDashboardCommit === WORKING_TREE && payload.path === selectedDashboardFile) {
            const dashboardDiff = document.getElementById('dashboardDiff');
            const dashboardTruncated = document.getElementById('diffTruncated');
            if (dashboardDiff) {
              dashboardDiff.dataset.workingPath = payload.path;
              dashboardDiff.innerHTML = payload.patch ? renderPatchLines(payload.patch) : '<span class="diff-placeholder">No changes in this view.</span>';
            }
            if (dashboardTruncated) dashboardTruncated.textContent = payload.truncated ? 'Patch truncated at 1 MiB' : '';
            break;
          }
          if (!isCurrentWorkingTreePreview(payload)) break;
          const diff = document.getElementById('commitPreviewDiff');
          const truncated = document.getElementById('commitPreviewTruncated');
          if (diff) diff.innerHTML = payload.patch
            ? renderPatchLines(payload.patch)
            : '<span class="diff-placeholder">No changes in this view.</span>';
          if (truncated) truncated.textContent = payload.truncated ? 'Patch truncated at 1 MiB' : '';
          break;
        }

        case 'workingTreePreviewError': {
          const payload = message.payload;
          if (payload.requestId === workingPreviewRequestId && selectedDashboardCommit === WORKING_TREE) {
            const dashboardDiff = document.getElementById('dashboardDiff');
            if (dashboardDiff) dashboardDiff.innerHTML = '<span class="dashboard-error">' + escapeHtml(payload.message) + '</span>';
            break;
          }
          if (!isCurrentWorkingTreePreview(payload)) break;
          const diff = document.getElementById('commitPreviewDiff');
          if (diff) diff.innerHTML = '<span class="dashboard-error">' + escapeHtml(payload.message) + '</span>';
          break;
        }

        case 'commitMessageProgress':
          if (message.payload.requestId === commitMessageRequest) setCommitMessageStatus(message.payload.message || '');
          break;

        case 'commitMessageFailed':
          if (message.payload.requestId === commitMessageRequest) endCommitMessageRequest(message.payload.message || 'Could not write a message.');
          break;

        case 'commitMessageGenerated': {
          const payload = message.payload;
          // Only into the dialog it was asked from, still open on the same repository.
          const dialog = document.getElementById('commitChangesModal');
          const dialogRepository = document.getElementById('commitChangesRepositoryPath');
          if (payload.requestId !== commitMessageRequest || !dialog || !dialog.classList.contains('active')
            || !dialogRepository || dialogRepository.value !== payload.repositoryPath) break;
          const draft = document.getElementById('commitMessage');
          // Your own draft is kept for Undo, not lost.
          previousCommitMessage = draft && draft.value.trim() ? draft.value : null;
          if (draft) draft.value = payload.message;
          commitMessagePartial = commitMessagePendingPartial;
          endCommitMessageRequest();
          // "Written by Claude Haiku 4.5, following AGENTS.md and commitlint.config.js. Check it before committing."
          const sources = (payload.convention || []).filter(source => typeof source === 'string');
          const convention = sources.length
            ? `following ${sources.length > 1 ? `${sources.slice(0, -1).join(', ')} and ${sources.at(-1)}` : sources[0]}`
            : 'in Conventional Commits style, as this repository names no commit convention';
          const omittedCount = (payload.omitted || []).length;
          const omitted = omittedCount === 1 ? ' 1 file was too large to send, so Copilot saw only its name.'
            : omittedCount > 1 ? ` ${omittedCount} files were too large to send, so Copilot saw only their names.` : '';
          setCommitMessageStatus(`Written by ${escapeHtml(payload.model || 'Copilot')}, ${escapeHtml(convention)}.${escapeHtml(omitted)} Check it before committing.` +
            (previousCommitMessage !== null ? ' <button type="button" class="link-button" data-action="undoCommitMessage">Undo</button>' : ''), true);
          break;
        }

        case 'commitFilesResult': {
          const repositoryPath = document.getElementById('commitChangesRepositoryPath');
          if (!repositoryPath || repositoryPath.value !== message.payload.repositoryPath) break;
          const result = document.getElementById('commitChangesResult');
          const commitButton = document.getElementById('commitSelectedFilesButton');
          if (result) result.textContent = message.payload.message || '';
          if (commitButton) commitButton.disabled = false;
          if (message.payload.success) {
            // A message still being written was for the changes just committed.
            if (commitMessageRequest) { postMessage('cancelCommitMessage', {}); endCommitMessageRequest(''); }
            commitMessagePartial = null;
            const draft = document.getElementById('commitMessage');
            if (draft) draft.value = '';
            document.getElementById('commitChangesModal').classList.remove('active');
          }
          break;
        }

        // The Repository Review tab's progress or result, for the Review button.
        case 'reviewStatus':
          reviewStatus = message.payload || { state: 'idle' };
          applyReviewLock();
          break;

        // Evidence of a diff review: the comparison it reviewed, with the cited line highlighted.
        case 'showReviewEvidence': {
          const payload = message.payload || {};
          if (payload.folder !== currentWorkspaceFolder() || payload.repositoryPath !== activeDashboardRepository) break;
          pendingEvidenceJump = { path: payload.path, side: payload.side, line: payload.line };
          commitCompareSelection = [];
          updateCommitCompareUI();
          loadComparison(payload.baseSha, payload.targetSha, 'review');
          break;
        }

        case 'pendingOperationLoaded': {
          const payload = message.payload || {};
          pendingOperations[payload.repositoryPath] = payload.operation || null;
          const menu = document.getElementById('historyContextMenu');
          if (menu && !menu.hidden && payload.repositoryPath === activeDashboardRepository) {
            applyHistoryMenuOperation();
            positionHistoryContextMenu();
          }
          break;
        }

        case 'workspaceFolderChanged': {
          // Paths such as '.' now point into a different folder: forget everything tied to the old one.
          repositoryData = (message.payload && message.payload.repositories) || [];
          repositoryDataAt = Date.now();
          dashboardHistoryState = {};
          Object.keys(pendingOperations).forEach(key => delete pendingOperations[key]);
          cancelPendingChangeSummary();
          changeSummaries.clear();
          activeDashboardRepository = null;
          if (repositoryData.length > 0) {
            activateDashboardRepository(repositoryData[0].path);
          } else {
            loadedHistoryCommits = [];
            clearCommitDetail();
            const history = document.getElementById('dashboardHistory');
            if (history) { uncommittedRowRendered = false; history.innerHTML = '<div class="dashboard-empty">No Git repository in this folder.</div>'; }
            saveState();
          }
          renderRepositorySwitcher();
          break;
        }

        case 'updateSubmodules': {
          repositoryData = message.payload.submodules;
          repositoryDataAt = Date.now();
          saveState();
          updateRepositoryRows(repositoryData);
          // The active repository can vanish (e.g. removed from .gitmodules); fall back to one that exists.
          if (repositoryData.length > 0 && !getRepository(activeDashboardRepository)) {
            activateDashboardRepository(repositoryData[0].path);
          }
          renderRepositorySwitcher();
          // The review tab notes uncommitted changes in the reviewed repository: keep it current.
          publishReviewContext();
          // So does the Uncommitted changes row (a refresh, a live update, or an action's result).
          requestWorkingTreeSummary();
          // A commit, checkout or reset made outside the dashboard moved HEAD: its history is reloaded too.
          {
            const active = getRepository(activeDashboardRepository);
            const head = active ? `${active.currentBranch || ''}@${active.currentCommit || ''}` : '';
            if (head && activeHeadSignature.repositoryPath === activeDashboardRepository && activeHeadSignature.head && activeHeadSignature.head !== head) {
              reloadActiveDashboardData();
            }
            activeHeadSignature = { repositoryPath: activeDashboardRepository, head };
          }
          break;
        }

        case 'repositoryOperationResult': {
          const payload = message.payload || {};
          setToolbarOperationState(payload.operation, payload.success ? 'success' : 'error', payload.message);
          if (payload.success) reloadActiveDashboardData();
          break;
        }

        case 'branchCheckoutResult': {
          const payload = message.payload || {};
          const matchesPending = pendingBranchCheckout
            && pendingBranchCheckout.repositoryPath === payload.repositoryPath
            && pendingBranchCheckout.branch === payload.branch;
          if (matchesPending) {
            setBranchCheckoutPending(false);
            pendingBranchCheckout = null;
          }
          if (payload.success && payload.repositoryPath === activeDashboardRepository) {
            setHistoryRevision('');
            commitCompareSelection = [];
            comparisonBaseHash = null;
            activeComparisonTarget = null;
            comparisonSource = null;
            comparisonLabels = null;
            saveState();
            requestDashboardHistory(0, false, { preserveViewport: true });
            postMessage('getRepositoryRefs', { repositoryPath: activeDashboardRepository });
          }
          break;
        }

        case 'stashActionCompleted': {
          const done = message.payload;
          if (!done || done.repositoryPath !== activeDashboardRepository) break;
          if (done.changedWorkingTree) openWorkingTreeAfterStash = done.repositoryPath;
          // A history filtered to stash@{n} (from the Stashes list) names a moving position: once a
          // stash is removed it is gone or names another stash, so the reload that follows shows all.
          if (done.removedStash && /^stash(@\{\d+\})?$/.test(getDashboardFilters(activeDashboardRepository).branch || '')) {
            setHistoryRevision('');
            saveState();
          }
          break;
        }

        case 'reloadDashboardHistory': {
          const repositoryPaths = Array.isArray(message.payload && message.payload.repositoryPaths)
            ? message.payload.repositoryPaths
            : [];
          if (repositoryPaths.length === 0 || repositoryPaths.includes(activeDashboardRepository)) {
            reloadActiveDashboardData();
          }
          break;
        }

        case 'historyLoaded':
          renderHistoryPage(message.payload);
          break;

        case 'repositoryRefsLoaded':
          renderRepositoryRefs(message.payload);
          break;

        case 'commitDetailLoaded':
          renderCommitDetail(message.payload);
          break;

        case 'fileDiffLoaded':
          renderFileDiff(message.payload);
          break;

        case 'dashboardError':
          renderDashboardError(message.payload);
          break;

        case 'copilotSettingsLoaded':
          if (message.payload) renderCopilotSettings(message.payload);
          // The remembered model, once at start: later replies (a settings change) leave the menu alone.
          if (message.payload && !selectedModelRestored) {
            selectedModelRestored = true;
            const saved = message.payload.selectedModel;
            if (saved && typeof saved.id === 'string' && saved.id && saved.id !== selectedSummaryModelId) {
              selectedSummaryModelId = saved.id;
              savedSummaryModelId = saved.id;
              selectedSummaryModelName = typeof saved.name === 'string' ? saved.name : saved.id;
              renderSummaryModelMenu();
              restoreChangeSummary();
              publishReviewContext(); // the review tab's Fix uses the same model
              // Check it against Copilot's list now, so a model Copilot withdrew falls back to Default
              // before a review or summary asks for it. Only users who chose a model load the list early.
              if (summaryModelsState === 'idle') actions.loadSummaryModels();
            }
          }
          break;

        case 'reviewQualityLoaded':
          if (message.payload && typeof message.payload.includeQuality === 'boolean') setReviewQuality(message.payload.includeQuality, false);
          break;

        case 'publishSidebar':
          publishSidebar();
          break;

        case 'sidebarAction':
          runSidebarAction(message.payload);
          break;

        case 'branchCreationResults': {
          const createdBranch = message.payload.branchName;
          const results = message.payload.results;
          showReviewModal(createdBranch, results);
          break;
        }

        case 'baseBranchesForCreate': {
          const baseBranchHidden = document.getElementById('baseBranch');
          const baseBranchInput = document.getElementById('baseBranchInput');
          const baseBranchList = document.getElementById('baseBranchList');
          const availableBranches = (message.payload && message.payload.branches) || [];

          if (baseBranchList && baseBranchInput && baseBranchHidden) {
            if (availableBranches.length === 0) {
              baseBranchList.innerHTML = '<div class="branch-dropdown-item" data-value="main"><span class="branch-name">main</span></div>';
              baseBranchInput.value = 'main';
              baseBranchHidden.value = 'main';
            } else {
              baseBranchList.innerHTML = availableBranches.map(b => {
                let tags = '';
                if (b.isRemote) {
                  tags += '<span class="branch-tag tag-remote">remote</span>';
                } else {
                  tags += '<span class="branch-tag tag-local">local</span>';
                }
                return `<div class="branch-dropdown-item" data-value="${b.name}">
                  <span class="branch-name">${b.name}</span>
                  <span class="branch-tags">${tags}</span>
                </div>`;
              }).join('');

              // Set default value to first branch
              const firstBranch = availableBranches[0];
              baseBranchInput.value = firstBranch.name;
              baseBranchHidden.value = firstBranch.name;
            }
            baseBranchInput.placeholder = 'Select base branch...';
            updatePrefixOptions();
          }
          break;
        }
      }
    } catch (err) {
      console.error('Error handling message:', message.type, err);
    }
  });

  function updateRepositoryRows(repositories) {
    repositories.forEach(repository => {
      if (repository.path === activeDashboardRepository) {
        const behindCount = document.getElementById('dashboardBehindCount');
        const aheadCount = document.getElementById('dashboardAheadCount');
        if (behindCount) {
          behindCount.textContent = repository.behind > 0 ? String(repository.behind) : '';
          behindCount.hidden = repository.behind <= 0;
        }
        if (aheadCount) {
          aheadCount.textContent = repository.ahead > 0 ? String(repository.ahead) : '';
          aheadCount.hidden = repository.ahead <= 0;
        }
      }
    });
  }

  // Branch naming tool functions
  // Branch hierarchy rules:
  // - main/master -> bugfix/, release/, dev/
  // - dev -> feature/, release/
  // - feature -> feature/, task/
  // - task -> task/
  // - unknown -> no type hint, all prefixes available
  const branchHierarchy = {
    'main': { prefixes: ['bugfix', 'release', 'dev'], hint: 'From main: Create bugfix, release, or dev branches' },
    'master': { prefixes: ['bugfix', 'release', 'dev'], hint: 'From master: Create bugfix, release, or dev branches' },
    'dev': { prefixes: ['feature', 'release'], hint: 'From dev: Create feature or release branches' },
    'feature': { prefixes: ['feature', 'task'], hint: 'From feature: Create feature or task branches' },
    'task': { prefixes: ['task'], hint: 'From task: Create task branches' }
  };

  // Store created branch info for review
  let pendingBranchInfo = null;

  function toKebabCase(str) {
    return str
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  function getBaseBranchType(baseBranch) {
    const lower = baseBranch.toLowerCase();
    if (lower === 'main' || lower === 'master') return 'main';
    if (lower === 'dev' || lower.startsWith('dev/') || lower.startsWith('dev-')) return 'dev';
    if (lower.startsWith('feature/') || lower.startsWith('feature-')) return 'feature';
    if (lower === 'task' || lower.startsWith('task/') || lower.startsWith('task-')) return 'task';
    return 'unknown';
  }

  function updatePrefixOptions() {
    const baseBranchEl = document.getElementById('baseBranch');
    const baseBranch = (baseBranchEl ? baseBranchEl.value.trim() : '') || 'main';
    const branchType = getBaseBranchType(baseBranch);
    const rules = branchHierarchy[branchType];

    const prefixSelect = document.getElementById('branchPrefix');
    const currentValue = prefixSelect.value;

    let prefixes;
    if (rules) {
      prefixes = [...rules.prefixes, 'none'];
      // Update hints only for known branch types
      document.getElementById('baseBranchHint').textContent = 'Type: ' + branchType;
      document.getElementById('prefixRuleHint').textContent = rules.hint + '. None creates a branch without a prefix';
    } else {
      // Unknown branch type - don't show type hint, show all prefix options
      prefixes = ['bugfix', 'feature', 'task', 'release', 'dev', 'none'];
      document.getElementById('baseBranchHint').textContent = '';
      document.getElementById('prefixRuleHint').textContent = 'None creates a branch without a prefix';
    }

    // Update options based on rules
    prefixSelect.innerHTML = prefixes.map(p => {
      const label = p === 'none' ? 'None' : p + '/';
      return `<option value="${p}">${label}</option>`;
    }).join('');

    // Try to keep current selection if valid, otherwise use first option
    if (prefixes.includes(currentValue)) {
      prefixSelect.value = currentValue;
    } else {
      prefixSelect.value = prefixes[0];
    }

    toggleBranchFormFields();
  }

  function updateBranchPreview() {
    const prefix = document.getElementById('branchPrefix').value;
    const preview = document.getElementById('branchPreview');
    const branchNameInput = document.getElementById('branchName');
    let branchName = '';

    if (prefix === 'release') {
      const productName = document.getElementById('productName').value.trim();
      const version = document.getElementById('releaseVersion').value.trim();
      if (productName && version) {
        branchName = 'release/' + productName + '_' + version;
      } else if (productName) {
        branchName = 'release/' + productName + '_';
      } else {
        branchName = 'release/ProductName_x.x.x';
      }
    } else if (prefix === 'dev') {
      const devName = document.getElementById('devBranchName').value.trim();
      const kebabDevName = toKebabCase(devName);
      if (kebabDevName) {
        branchName = 'dev/' + kebabDevName;
      } else {
        branchName = 'dev/your-branch-name';
      }
    } else {
      const ticketId = document.getElementById('ticketId').value.trim();
      const taskTitle = document.getElementById('taskTitle').value.trim();
      const kebabTitle = toKebabCase(taskTitle);
      const prefixStr = prefix === 'none' ? '' : prefix + '/';

      if (ticketId && kebabTitle) {
        branchName = prefixStr + ticketId + '-' + kebabTitle;
      } else if (ticketId) {
        branchName = prefix === 'none' ? ticketId : prefixStr + ticketId + '-';
      } else if (kebabTitle) {
        branchName = prefixStr + kebabTitle;
      } else {
        branchName = prefixStr + 'your-branch-name';
      }
    }

    preview.textContent = branchName;
    preview.style.color = (branchName.includes('your-branch-name') || branchName.endsWith('_') || branchName.endsWith('-') || branchName.endsWith('x.x.x'))
      ? 'var(--text-secondary)'
      : 'var(--text-primary)';
    branchNameInput.value = branchName;
  }

  function toggleBranchFormFields() {
    const prefix = document.getElementById('branchPrefix').value;
    const ticketIdGroup = document.getElementById('ticketIdGroup');
    const taskTitleGroup = document.getElementById('taskTitleGroup');
    const releaseInfoGroup = document.getElementById('releaseInfoGroup');
    const devBranchGroup = document.getElementById('devBranchGroup');

    // Hide all first
    ticketIdGroup.style.display = 'none';
    taskTitleGroup.style.display = 'none';
    releaseInfoGroup.style.display = 'none';
    devBranchGroup.style.display = 'none';

    if (prefix === 'release') {
      releaseInfoGroup.style.display = 'block';
    } else if (prefix === 'dev') {
      devBranchGroup.style.display = 'block';
    } else {
      // feature, task, bugfix, or no prefix
      ticketIdGroup.style.display = 'block';
      taskTitleGroup.style.display = 'block';
    }
    updateBranchPreview();
  }

  function showReviewModal(branchName, results) {
    const resultsDiv = document.getElementById('branchCreationResults');
    const successCount = results.filter(r => r.success).length;
    const failCount = results.filter(r => !r.success).length;

    let html = '<div style="margin-bottom: 12px;">';
    if (failCount === 0) {
      html += `<span style="color: var(--success);">\u2713 Branch created successfully in ${successCount} repository/repositories</span>`;
    } else {
      html += `<span style="color: var(--warning);">\u26A0 Created in ${successCount}, failed in ${failCount} repository/repositories</span>`;
    }
    html += '</div>';

    // Show per-repository results.
    html += '<div style="max-height: 150px; overflow-y: auto; font-size: 12px;">';
    results.forEach(r => {
      const icon = r.success ? '\u2713' : '\u2717';
      const color = r.success ? 'var(--success)' : 'var(--error)';
      html += `<div style="padding: 4px 0; color: ${color};">${icon} ${r.repository}: ${r.message}</div>`;
    });
    html += '</div>';

    resultsDiv.innerHTML = html;
    document.getElementById('reviewBranchName').textContent = branchName;
    document.getElementById('reviewBranchModal').classList.add('active');
  }

  // Retry mechanism for base branch loading
  let branchRetryTimer = null;
  function retryLoadBaseBranches(retriesLeft) {
    if (branchRetryTimer) {
      clearTimeout(branchRetryTimer);
      branchRetryTimer = null;
    }
    if (retriesLeft <= 0) return;
    branchRetryTimer = setTimeout(function () {
      branchRetryTimer = null;
      const baseBranchList = document.getElementById('baseBranchList');
      if (!baseBranchList) return;
      // Check if still showing loading text (branches not received yet)
      const loadingEl = baseBranchList.querySelector('.branch-select-loading');
      if (loadingEl) {
        console.log('[RepositoryManager] Retrying base branch load, retries left:', retriesLeft - 1);
        postMessage('getBaseBranchesForCreate', {});
        retryLoadBaseBranches(retriesLeft - 1);
      }
    }, 2000);
  }

  // Event listeners for branch naming inputs
  document.getElementById('branchPrefix').addEventListener('change', toggleBranchFormFields);
  document.getElementById('ticketId').addEventListener('input', updateBranchPreview);
  document.getElementById('taskTitle').addEventListener('input', updateBranchPreview);
  document.getElementById('productName').addEventListener('input', updateBranchPreview);
  document.getElementById('releaseVersion').addEventListener('input', updateBranchPreview);
  document.getElementById('devBranchName').addEventListener('input', updateBranchPreview);

  // Custom branch dropdown event handlers
  const baseBranchDropdown = document.getElementById('baseBranchDropdown');
  const baseBranchInput = document.getElementById('baseBranchInput');
  const baseBranchList = document.getElementById('baseBranchList');
  const baseBranchHidden = document.getElementById('baseBranch');

  if (baseBranchInput && baseBranchDropdown) {
    // Toggle dropdown on input click
    baseBranchInput.addEventListener('click', function(e) {
      e.stopPropagation();
      baseBranchDropdown.classList.toggle('open');
    });

    // Handle branch selection
    baseBranchList.addEventListener('click', function(e) {
      const item = e.target.closest('.branch-dropdown-item');
      if (item) {
        const value = item.dataset.value;
        baseBranchInput.value = value;
        baseBranchHidden.value = value;
        baseBranchDropdown.classList.remove('open');
        updatePrefixOptions();
      }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', function(e) {
      if (!baseBranchDropdown.contains(e.target)) {
        baseBranchDropdown.classList.remove('open');
      }
    });
  }

  // Scrolling near the end loads the next page (keyboard focus on a row scrolls the list too).
  const historyList = document.getElementById('dashboardHistory');
  if (historyList) historyList.addEventListener('scroll', loadHistoryNearEnd, { passive: true });

  const dashboardSearch = document.getElementById('dashboardSearch');
  // Down/Up on the closed Model button opens its menu, as on a select.
  const summaryModelButton = document.getElementById('summaryModelButton');
  if (summaryModelButton) {
    summaryModelButton.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      e.preventDefault();
      if (document.getElementById('summaryModelMenu').hidden) showSummaryModelMenu();
    });
  }
  if (dashboardSearch) {
    dashboardSearch.addEventListener('input', function () {
      captureDashboardFilters();
      saveState();
      if (historySearchTimer) clearTimeout(historySearchTimer);
      historySearchTimer = setTimeout(function () {
        requestDashboardHistory(0, false);
      }, 250);
    });
  }

  const commitSelectAll = document.getElementById('commitSelectAll');
  if (commitSelectAll) {
    commitSelectAll.addEventListener('change', function () {
      document.querySelectorAll('.commit-change-checkbox:not(:disabled)').forEach(checkbox => {
        checkbox.checked = commitSelectAll.checked;
      });
      updateCommitSelectionCount();
    });
  }

  // A written message describes one choice for partly staged files: changing it says so.
  const commitPartialChoice = document.getElementById('commitPartialChoice');
  if (commitPartialChoice) {
    commitPartialChoice.addEventListener('change', function () {
      const choice = document.querySelector('input[name="commitPartial"]:checked');
      if (commitMessagePartial && choice && choice.value !== commitMessagePartial) {
        setCommitMessageStatus(`The message was written for ${commitMessagePartial === 'staged' ? 'the staged part only' : 'the whole files'}: write it again to match this choice.`);
      }
    });
  }

  const commitChangesList = document.getElementById('commitChangesList');
  if (commitChangesList) {
    commitChangesList.addEventListener('change', function (event) {
      if (!event.target.classList.contains('commit-change-checkbox')) return;
      const selectable = Array.from(document.querySelectorAll('.commit-change-checkbox:not(:disabled)'));
      if (commitSelectAll) {
        commitSelectAll.checked = selectable.length > 0 && selectable.every(checkbox => checkbox.checked);
      }
      updateCommitSelectionCount();
    });
  }

  const dashboardIncludeRemotes = document.getElementById('dashboardIncludeRemotes');
  if (dashboardIncludeRemotes) {
    dashboardIncludeRemotes.addEventListener('change', function () {
      captureDashboardFilters();
      saveState();
      requestDashboardHistory(0, false);
    });
  }

  function clampPanelSize(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function getHistoryColumnMinimum(index) {
    return historyColumnMinimums[index] || 1;
  }

  function applyHistoryColumnWidths(widths) {
    const region = document.querySelector('.history-region');
    const history = document.getElementById('dashboardHistory');
    if (!region || !history) return;

    const contentWidth = history.clientWidth || region.clientWidth;
    const padding = parseFloat(getComputedStyle(region).getPropertyValue('--history-horizontal-padding')) || 12;
    const available = Math.max(1, contentWidth - 2 * padding - 4 * 8);
    const baseMinimums = [
      Math.min(historyGraphWidth, Math.max(34, Math.floor(available * .24))),
      80, 58, 54, 52
    ];
    const minimumTotal = baseMinimums.reduce((sum, value) => sum + value, 0);
    const factor = Math.min(1, available / minimumTotal);
    historyColumnMinimums = baseMinimums.map(value => value * factor);

    const requested = Array.isArray(widths) && widths.length === defaultHistoryColumnWidths.length
      ? widths : defaultHistoryColumnWidths;
    const next = requested.map((width, index) => {
      const normalized = Number.isFinite(Number(width)) ? Number(width) : defaultHistoryColumnWidths[index];
      return Math.max(historyColumnMinimums[index], normalized);
    });
    let remaining = available - next.reduce((sum, width) => sum + width, 0);
    if (remaining < 0) {
      // When space runs out, give up Author and Date before Message, then Commit, then Graph.
      // Message keeps a proportional share here (it is the column people read), but a user can
      // still drag it narrower: the resize minimum stays historyColumnMinimums.
      const messageShare = Math.max(historyColumnMinimums[1], Math.floor(available * .35));
      // Second pass drops the Message share so the columns always fit.
      for (const floorOf of [index => (index === 1 ? messageShare : historyColumnMinimums[index]), index => historyColumnMinimums[index]]) {
        for (const index of [2, 3, 1, 4, 0]) {
          if (remaining >= 0) break;
          const reduction = Math.max(0, Math.min(-remaining, next[index] - floorOf(index)));
          next[index] -= reduction;
          remaining += reduction;
        }
      }
    } else {
      next[1] += remaining;
    }
    renderedHistoryColumnWidths = next;
    region.style.setProperty('--history-content-width', `${contentWidth}px`);
    ['graph', 'message', 'author', 'date', 'commit'].forEach((name, index) => {
      region.style.setProperty(`--history-${name}-column-width`, `${next[index]}px`);
    });
    scheduleHistoryGraphGeometry();
  }

  function setupHistoryColumnResizers() {
    const header = document.getElementById('historyTableHeader');
    const history = document.getElementById('dashboardHistory');
    if (!header || !history) return;

    applyHistoryColumnWidths(historyColumnWidths);

    history.scrollLeft = 0;
    // A taller list (window or splitter) can bring its end into view without a scroll event.
    new ResizeObserver(() => { applyHistoryColumnWidths(historyColumnWidths); loadHistoryNearEnd(); })
      .observe(history);

    header.querySelectorAll('.history-column-resizer').forEach(handle => {
      const columnIndex = Number(handle.dataset.columnIndex);
      if (columnIndex === 4) {
        handle.remove();
        return;
      }
      let startX = 0;
      let startWidth = 0;
      let adjacentWidth = 0;
      const adjacentIndex = columnIndex + 1;

      handle.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        startX = event.clientX;
        startWidth = renderedHistoryColumnWidths[columnIndex];
        adjacentWidth = renderedHistoryColumnWidths[adjacentIndex];
        handle.classList.add('dragging');
        handle.setPointerCapture(event.pointerId);
      });

      handle.addEventListener('pointermove', function (event) {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        const pairWidth = startWidth + adjacentWidth;
        const nextWidth = clampPanelSize(
          startWidth + event.clientX - startX,
          getHistoryColumnMinimum(columnIndex),
          pairWidth - getHistoryColumnMinimum(adjacentIndex)
        );
        historyColumnWidths = (historyColumnWidths.length ? historyColumnWidths : defaultHistoryColumnWidths).slice();
        historyColumnWidths[columnIndex] = nextWidth;
        historyColumnWidths[adjacentIndex] = pairWidth - nextWidth;
        applyHistoryColumnWidths(historyColumnWidths);
      });

      handle.addEventListener('pointerup', function (event) {
        if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
        handle.classList.remove('dragging');
        saveState();
      });

      handle.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 16 : -16;
        const pairWidth = renderedHistoryColumnWidths[columnIndex] + renderedHistoryColumnWidths[adjacentIndex];
        historyColumnWidths = (historyColumnWidths.length ? historyColumnWidths : defaultHistoryColumnWidths).slice();
        historyColumnWidths[columnIndex] = clampPanelSize(
          renderedHistoryColumnWidths[columnIndex] + delta,
          getHistoryColumnMinimum(columnIndex),
          pairWidth - getHistoryColumnMinimum(adjacentIndex)
        );
        historyColumnWidths[adjacentIndex] = pairWidth - historyColumnWidths[columnIndex];
        applyHistoryColumnWidths(historyColumnWidths);
        saveState();
      });
    });
  }

  function applyHistoryPanelHeight(height) {
    const main = document.querySelector('.dashboard-main');
    const controls = document.querySelector('.history-controls');
    if (!main || !controls) return;
    const max = main.clientHeight - controls.offsetHeight - 6 - 120;
    historyPanelHeight = clampPanelSize(height, 120, Math.max(120, max));
    main.style.gridTemplateRows = `${controls.offsetHeight}px ${historyPanelHeight}px 6px minmax(120px, 1fr)`;
  }

  function applyFilesPanelWidth(width) {
    const content = document.querySelector('.commit-content');
    if (!content) return;
    const max = content.clientWidth - 6 - 220;
    filesPanelWidth = clampPanelSize(width, 170, Math.max(170, max));
    content.style.gridTemplateColumns = `${filesPanelWidth}px 6px minmax(220px, 1fr)`;
  }

  function setupDashboardSplitters() {
    const historySplitter = document.getElementById('historyDiffSplitter');
    const filesSplitter = document.getElementById('filesDiffSplitter');
    const historyRegion = document.querySelector('.history-region');
    const commitContent = document.querySelector('.commit-content');

    if (historyPanelHeight > 0) applyHistoryPanelHeight(historyPanelHeight);
    if (filesPanelWidth > 0) applyFilesPanelWidth(filesPanelWidth);

    if (historySplitter && historyRegion) {
      historySplitter.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        historySplitter.classList.add('dragging');
        historySplitter.setPointerCapture(event.pointerId);
      });
      historySplitter.addEventListener('pointermove', function (event) {
        if (!historySplitter.hasPointerCapture(event.pointerId)) return;
        applyHistoryPanelHeight(event.clientY - historyRegion.getBoundingClientRect().top);
      });
      historySplitter.addEventListener('pointerup', function (event) {
        if (historySplitter.hasPointerCapture(event.pointerId)) historySplitter.releasePointerCapture(event.pointerId);
        historySplitter.classList.remove('dragging');
        saveState();
      });
      historySplitter.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
        event.preventDefault();
        applyHistoryPanelHeight((historyPanelHeight || historyRegion.offsetHeight) + (event.key === 'ArrowDown' ? 24 : -24));
        saveState();
      });
    }

    if (filesSplitter && commitContent) {
      filesSplitter.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        filesSplitter.classList.add('dragging');
        filesSplitter.setPointerCapture(event.pointerId);
      });
      filesSplitter.addEventListener('pointermove', function (event) {
        if (!filesSplitter.hasPointerCapture(event.pointerId)) return;
        applyFilesPanelWidth(event.clientX - commitContent.getBoundingClientRect().left);
      });
      filesSplitter.addEventListener('pointerup', function (event) {
        if (filesSplitter.hasPointerCapture(event.pointerId)) filesSplitter.releasePointerCapture(event.pointerId);
        filesSplitter.classList.remove('dragging');
        saveState();
      });
      filesSplitter.addEventListener('keydown', function (event) {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        applyFilesPanelWidth((filesPanelWidth || 300) + (event.key === 'ArrowRight' ? 24 : -24));
        saveState();
      });
    }

    window.addEventListener('resize', function () {
      if (historyPanelHeight > 0) applyHistoryPanelHeight(historyPanelHeight);
      if (filesPanelWidth > 0) applyFilesPanelWidth(filesPanelWidth);
    });
  }

  // ---- Security and compliance review ----
  // Reviews run and are read in the Repository Review tab (resources/review.js). The dashboard
  // starts them from its buttons and history menu, shows their status on the Review button, and
  // shows the evidence of a diff review in its own diff.
  let pendingEvidenceJump = null;
  let lastReviewContext = '';

  // Starts at once with security and team policy, using the model chosen for AI summaries; the
  // extension opens the review tab and asks for consent until it is allowed for the repository.
  function startReview(options) {
    if (!activeDashboardRepository || reviewLocked()) return;
    const repository = getRepository(activeDashboardRepository);
    postMessage('requestReview', Object.assign({}, options, { repositoryPath: activeDashboardRepository, folder: currentWorkspaceFolder(),
      repositoryName: repository ? repository.name : activeDashboardRepository, modelId: selectedSummaryModelId || undefined,
      includeQuality: reviewQuality }));
  }

  // Clean code is remembered by the host (global state), so a new dashboard panel keeps it.
  function setReviewQuality(value, save) {
    reviewQuality = value;
    const toggle = document.getElementById('reviewQualityToggle');
    if (toggle) toggle.checked = value;
    saveState();
    if (save) postMessage('setReviewQuality', { enabled: value });
  }

  // A review runs in the background: the rest of the dashboard stays usable (other repositories,
  // folders, tabs and commits). Only starting a second review waits, since it would replace this one.
  function currentWorkspaceFolder() {
    const select = document.getElementById('workspaceFolderSelect');
    return select ? select.value : '';
  }

  // What the review tab follows: the repository and folder shown here, and the selected model.
  function publishReviewContext() {
    const repository = getRepository(activeDashboardRepository);
    const payload = { repositoryPath: activeDashboardRepository, folder: currentWorkspaceFolder(),
      repositoryName: repository ? repository.name : activeDashboardRepository || '', modelId: selectedSummaryModelId || '',
      repositories: repositoryData.map(item => ({ path: item.path, name: item.name, hasChanges: Boolean(item.hasChanges) })) };
    const key = JSON.stringify(payload);
    if (key === lastReviewContext) return;
    lastReviewContext = key;
    postMessage('dashboardContext', payload);
  }

  function reviewLocked() {
    return reviewStatus.state === 'running';
  }

  const REVIEW_LOCK_HINT = 'A review is running. Wait for it, or cancel it in the Review tab to start another.';

  // The review buttons wait while a review runs; the Review button shows its progress, then the
  // number of blocking items. Review commit needs a commit or a comparison to review.
  function applyReviewLock() {
    const locked = reviewLocked();
    if (document.body && document.body.classList) document.body.classList.toggle('review-running', locked);
    const badge = document.getElementById('reviewTabBadge');
    if (badge) {
      badge.textContent = reviewStatus.state === 'running' ? `${reviewStatus.percent || 0}%`
        : reviewStatus.state === 'completed' && reviewStatus.blocking ? String(reviewStatus.blocking) : '';
      badge.classList.toggle('review-open-badge-blocking', reviewStatus.state === 'completed' && reviewStatus.blocking > 0);
    }
    if (locked) hideReviewBranchMenu(false);
    const lockable = '[data-action="reviewRelease"], [data-action="reviewSelection"], [data-action="reviewLocal"], #reviewBranchMenuButton, ' +
      '#historyContextMenu [data-action="contextReviewCommit"], #historyContextMenu [data-action="contextReviewSnapshot"]';
    document.querySelectorAll(lockable).forEach(element => {
      const nothingSelected = element.dataset.action === 'reviewSelection' && (!changeSummarySelection || changeSummarySelection.local);
      if (locked || nothingSelected) {
        element.setAttribute('aria-disabled', 'true');
        // Saved once per lock, even when it is empty: a button with no title of its own must not
        // save the lock's hint on the next progress update and get it back as its title.
        if (element.dataset.unlockedTitle === undefined) element.dataset.unlockedTitle = element.getAttribute('title') || '';
        element.setAttribute('title', locked ? REVIEW_LOCK_HINT : 'Select a commit, or load a comparison, to review it');
      } else if (element.getAttribute('aria-disabled') === 'true') {
        element.removeAttribute('aria-disabled');
        const title = element.dataset.unlockedTitle;
        delete element.dataset.unlockedTitle;
        if (title) element.setAttribute('title', title); else element.removeAttribute('title');
      }
    });
  }

  function highlightEvidenceLine() {
    if (!pendingEvidenceJump) return;
    const column = pendingEvidenceJump.side === 'base' ? 0 : 1;
    const row = Array.from(document.querySelectorAll('#dashboardDiff .diff-line')).find(line => {
      const number = line.querySelectorAll('.diff-ln')[column];
      return number && number.textContent === String(pendingEvidenceJump.line);
    });
    pendingEvidenceJump = null;
    if (!row) return;
    document.querySelectorAll('#dashboardDiff .diff-line-highlight').forEach(line => line.classList.remove('diff-line-highlight'));
    row.classList.add('diff-line-highlight');
    row.scrollIntoView({ block: 'center' });
  }

  // Dialog behaviour for every .modal-overlay: move focus in when it opens, keep Tab inside,
  // close on Escape through the dialog's own close button, and return focus when it closes.
  const FOCUSABLE = 'button, [href], input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])';
  const dialogReturnFocus = new Map();

  function focusableIn(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE))
      .filter(element => !element.disabled && element.getClientRects().length > 0);
  }

  function topOpenDialog() {
    const open = Array.from(document.querySelectorAll('.modal-overlay.active'));
    return open.length ? open[open.length - 1] : null;
  }

  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    new MutationObserver(() => {
      const isOpen = overlay.classList.contains('active');
      if (isOpen && !dialogReturnFocus.has(overlay)) {
        dialogReturnFocus.set(overlay, document.activeElement);
        // Wait a frame so fields shown while opening (e.g. by prefix rules) are focusable.
        requestAnimationFrame(() => {
          if (!overlay.classList.contains('active') || overlay.contains(document.activeElement)) return;
          const preferred = overlay.querySelector('[data-initial-focus]');
          const target = preferred && preferred.getClientRects().length
            ? preferred
            : focusableIn(overlay).find(element => !element.classList.contains('modal-close'));
          if (target) target.focus();
        });
      } else if (!isOpen && dialogReturnFocus.has(overlay)) {
        const opener = dialogReturnFocus.get(overlay);
        dialogReturnFocus.delete(overlay);
        if (opener && opener.isConnected && typeof opener.focus === 'function' && !topOpenDialog()) opener.focus();
      }
    }).observe(overlay, { attributes: true, attributeFilter: ['class'] });
  });

  document.addEventListener('keydown', function (event) {
    const dialog = topOpenDialog();
    if (!dialog) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // An open dropdown inside the dialog closes first.
      const dropdown = dialog.querySelector('.branch-dropdown.open');
      if (dropdown) {
        dropdown.classList.remove('open');
        return;
      }
      const close = dialog.querySelector('.modal-close');
      if (close) close.click();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusableIn(dialog);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (!dialog.contains(document.activeElement)) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });

  // Initialize UI on load
  setupHistoryColumnResizers();
  setupDashboardSplitters();
  if (repositoryData.length > 0) {
    if (!getRepository(activeDashboardRepository)) activeDashboardRepository = repositoryData[0].path;
    activateDashboardRepository(activeDashboardRepository);
  }
  renderRepositorySwitcher();
  const qualityToggle = document.getElementById('reviewQualityToggle');
  if (qualityToggle) {
    qualityToggle.checked = reviewQuality;
    qualityToggle.addEventListener('change', () => setReviewQuality(qualityToggle.checked, true));
  }
  // The Clean code choice and the review tab's status live in the extension; the tab follows here.
  postMessage('getReviewQuality', {});
  postMessage('getCopilotSettings', {});
  postMessage('getReviewStatus', {});
  publishReviewContext();
  applyReviewLock();
})();
