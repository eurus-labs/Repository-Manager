/**
 * HTML template for the webview panel
 */

import { RepositoryInfo } from '../types';
import * as vscode from 'vscode';
import { renderDashboardToolbar } from './toolbar';

/**
 * URIs for external webview resources
 */
export interface WebviewResourceUris {
  graphScriptUri: vscode.Uri;
  scriptUri: vscode.Uri;
  styleUri: vscode.Uri;
}

/**
 * Workspace folder info for folder selector
 */
export interface WorkspaceFolderInfo {
  name: string;
  path: string;
  isCurrent: boolean;
}

function escapeHtml(value: string | undefined): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Render the modals
 */
function renderModals(repositories: RepositoryInfo[]): string {
  return `
    <!-- Create Branch Modal -->
    <div class="modal-overlay" id="createBranchModal">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="createBranchModalTitle">
        <div class="modal-header">
          <div class="modal-heading"><span class="modal-title" id="createBranchModalTitle">Branch across repositories</span><span>One branch name, created from the same base in every selected repository.</span></div>
          <button class="modal-close" aria-label="Close" data-action="closeModal" data-modal="createBranchModal">&times;</button>
        </div>
        <div class="modal-body">
          <div class="form-group">
            <label class="form-label">Repositories</label>
            <div id="repositoryCheckboxes" class="branch-repository-list">
              ${repositories.map(repository => `
                <label class="branch-repository-row">
                  <input type="checkbox" class="branch-repository" value="${escapeHtml(repository.path)}" ${repository.status === 'conflict' ? 'disabled' : 'checked'}>
                  <strong>${escapeHtml(repository.name)}</strong>
                  <code>${escapeHtml(repository.currentBranch || `(detached) ${repository.currentCommit || ''}`)}</code>
                  <span class="repository-modal-status status-${repository.status}">${repository.isParentRepo ? 'parent' : repository.status}</span>
                </label>
              `).join('')}
            </div>
          </div>
          <div class="branch-form-grid branch-form-grid-equal">
            <div class="form-group">
              <label class="form-label">Base branch</label>
              <div class="branch-dropdown" id="baseBranchDropdown">
                <input type="text" class="branch-dropdown-input" id="baseBranchInput" placeholder="Loading branches..." readonly>
                <span class="branch-dropdown-arrow">▼</span>
                <div class="branch-dropdown-list" id="baseBranchList"><!-- Populated dynamically --></div>
              </div>
              <input type="hidden" id="baseBranch" value="">
              <div id="baseBranchHint" class="form-hint"></div>
            </div>
            <div class="form-group">
              <label class="form-label">Type</label>
              <select class="form-select" id="branchPrefix">
                <option value="bugfix">bugfix</option>
                <option value="release">release</option>
                <option value="dev">dev</option>
                <option value="none">None</option>
              </select>
              <div id="prefixRuleHint" class="form-hint"></div>
            </div>
          </div>
          <div class="branch-form-grid">
            <div class="form-group" id="ticketIdGroup">
              <label class="form-label">Ticket ID <span>optional</span></label>
              <input type="text" class="form-input" id="ticketId" placeholder="e.g., ECPT-15474">
            </div>
            <div class="form-group" id="taskTitleGroup">
              <label class="form-label">Task title</label>
              <input type="text" class="form-input" id="taskTitle" placeholder="e.g., CAN timeout handling">
            </div>
          </div>
          <div class="form-group" id="releaseInfoGroup" style="display: none;">
            <label class="form-label">Product Name</label>
            <input type="text" class="form-input" id="productName" placeholder="e.g., HexOGen">
            <label class="form-label" style="margin-top: 12px;">Version</label>
            <input type="text" class="form-input" id="releaseVersion" placeholder="e.g., 10.54.0">
          </div>
          <div class="form-group" id="devBranchGroup" style="display: none;">
            <label class="form-label">Development Branch Name</label>
            <input type="text" class="form-input" id="devBranchName" placeholder="e.g., sprint-42 or v2-refactor">
          </div>
          <div class="form-group">
            <label class="form-label branch-name-label">Branch name</label>
            <div id="branchPreview" class="branch-name-preview">
              bugfix/your-branch-name
            </div>
            <input type="hidden" id="branchName">
          </div>
          <label class="form-label" id="branchFromCommitCheckoutRow" hidden><input type="checkbox" id="branchFromCommitCheckout" checked> Checkout new branch</label>
        </div>
        <div class="modal-footer">
          <span class="form-hint compare-hint" id="createBranchHint" role="alert" hidden></span>
          <button class="btn" data-action="closeModal" data-modal="createBranchModal">Cancel</button>
          <button class="btn btn-primary" data-action="createBranch">Review &amp; create</button>
        </div>
      </div>
    </div>

    <!-- Review Branch Modal -->
    <div class="modal-overlay" id="reviewBranchModal">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="reviewBranchModalTitle">
        <div class="modal-header">
          <span class="modal-title" id="reviewBranchModalTitle">Review Created Branch</span>
          <button class="modal-close" aria-label="Close" data-action="closeModal" data-modal="reviewBranchModal">&times;</button>
        </div>
        <div class="modal-body">
          <div id="branchCreationResults" style="margin-bottom: 16px;"></div>
          <div class="form-group">
            <label class="form-label">Branch Name</label>
            <div id="reviewBranchName" style="padding: 10px 12px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 6px; font-family: var(--vscode-editor-font-family); word-break: break-all;"></div>
          </div>
          <div class="form-group">
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer;">
              <input type="checkbox" id="pushAfterCreate" checked>
              <span>Push branch to remote after confirmation</span>
            </label>
          </div>
        </div>
        <div class="modal-footer">
          <button class="btn" data-action="closeModal" data-modal="reviewBranchModal">Close</button>
          <button class="btn btn-primary" data-action="confirmAndPush">Confirm & Push</button>
        </div>
      </div>
    </div>

    <!-- Commit Changes Modal -->
    <div class="modal-overlay" id="commitChangesModal">
      <div class="modal commit-changes-modal" role="dialog" aria-modal="true" aria-labelledby="commitChangesModalTitle">
        <div class="modal-header">
          <div class="modal-heading">
            <span class="modal-title" id="commitChangesModalTitle">Create Commit</span>
            <span id="commitChangesRepository">Repository</span>
          </div>
          <button class="modal-close" aria-label="Close" data-action="closeModal" data-modal="commitChangesModal">&times;</button>
        </div>
        <div class="modal-body">
          <input type="hidden" id="commitChangesRepositoryPath">
          <div class="commit-changes-toolbar">
            <label><input type="checkbox" id="commitSelectAll" checked> Select all</label>
            <div class="commit-filter" id="commitFilter" role="group" aria-label="Show files">
              <button type="button" data-action="setCommitFilter" data-filter="all" aria-pressed="true" title="Every changed file">All <span id="commitFilterAllCount">0</span></button>
              <button type="button" data-action="setCommitFilter" data-filter="tracked" aria-pressed="false" title="Files Git already tracks: modified, staged, deleted, renamed">Tracked <span id="commitFilterTrackedCount">0</span></button>
              <button type="button" data-action="setCommitFilter" data-filter="untracked" aria-pressed="false" title="New files Git does not track yet">Untracked <span id="commitFilterUntrackedCount">0</span></button>
            </div>
            <span id="commitSelectionCount">0 selected</span>
          </div>
          <div class="commit-preview-layout">
            <div class="commit-changes-list" id="commitChangesList">
              <div class="dashboard-loading">Loading changed files…</div>
            </div>
            <div class="commit-preview-panel">
              <div class="commit-preview-heading">
                <span id="commitPreviewPath">Select a file to preview its changes</span>
                <div class="commit-preview-modes" id="commitPreviewModes" role="group" aria-label="Which changes the preview shows" hidden>
                  <button type="button" data-action="previewWorkingTreeMode" data-mode="staged" title="Show the changes already staged (the index)">Staged diff</button>
                  <button type="button" data-action="previewWorkingTreeMode" data-mode="unstaged" title="Show the changes not staged yet (the working tree)">Unstaged diff</button>
                </div>
              </div>
              <pre class="diff-viewer commit-preview-diff" id="commitPreviewDiff"><span class="diff-placeholder">Select a file to preview its changes.</span></pre>
              <span class="commit-preview-truncated" id="commitPreviewTruncated"></span>
            </div>
          </div>
          <div class="form-group commit-message-group">
            <div class="commit-message-heading">
              <label class="form-label" for="commitMessage">Commit message</label>
              <button type="button" class="btn commit-message-generate" id="commitMessageGenerate" data-action="generateCommitMessage" title="Copilot writes a message for the selected files, following this repository's commit convention (AGENTS.md, CONTRIBUTING.md, commitlint), or Conventional Commits when it has none. You review and edit it before committing">Write with Copilot</button>
            </div>
            <div class="commit-message-status" id="commitMessageStatus" role="status" aria-live="polite"></div>
            <textarea class="form-input commit-message-input" id="commitMessage" data-initial-focus rows="3" placeholder="Describe the changes"></textarea>
          </div>
          <fieldset class="commit-partial" id="commitPartialChoice" hidden>
            <legend id="commitPartialLegend">Some selected files are partly staged</legend>
            <label><input type="radio" name="commitPartial" value="staged"> Commit only the staged part <small>(later changes stay unstaged)</small></label>
            <label><input type="radio" name="commitPartial" value="whole"> Commit the whole file <small>(as it is in the working tree)</small></label>
          </fieldset>
          <div class="commit-result" id="commitChangesResult" role="status" aria-live="polite"></div>
        </div>
        <div class="modal-footer">
          <label class="commit-push-option" title="Push the current branch once the commit is created. Remembered for this repository"><input type="checkbox" id="commitPushAfter"> Push after commit</label>
          <button class="btn" data-action="closeModal" data-modal="commitChangesModal">Cancel</button>
          <button class="btn btn-primary" id="commitSelectedFilesButton" data-action="commitSelectedChanges">Commit selected</button>
        </div>
      </div>
    </div>

    <!-- Compare Branches Modal -->
    <div class="modal-overlay" id="branchCompareModal">
      <div class="modal branch-compare-modal" role="dialog" aria-modal="true" aria-labelledby="branchCompareModalTitle">
        <div class="modal-header">
          <div class="modal-heading"><span class="modal-title" id="branchCompareModalTitle">Compare branches</span><span>Show the changes from a base branch or tag to a target branch or tag, such as a release tag to main.</span></div>
          <button class="modal-close" aria-label="Close" data-action="closeModal" data-modal="branchCompareModal">&times;</button>
        </div>
        <div class="modal-body branch-compare-fields">
          <div class="form-group">
            <label class="form-label" for="compareBaseBranch">Base</label>
            <select class="form-select" id="compareBaseBranch"><option value="">Loading branches...</option></select>
          </div>
          <span class="compare-direction" aria-hidden="true">→</span>
          <div class="form-group">
            <label class="form-label" for="compareTargetBranch">Target</label>
            <select class="form-select" id="compareTargetBranch"><option value="">Loading branches...</option></select>
          </div>
        </div>
        <div class="modal-footer">
          <span class="form-hint compare-hint" id="branchCompareHint" role="alert" hidden></span>
          <button class="btn" data-action="closeModal" data-modal="branchCompareModal">Cancel</button>
          <button class="btn btn-primary" data-action="compareBranches">Compare</button>
        </div>
      </div>
    </div>
  `;
}

/**
 * Generate a nonce for CSP
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

/**
 * The workspace folder the dashboard shows, at the top of the sidebar. It is a button, not a
 * <select>, so the Side Bar's copy works too: the host asks which folder in a Quick Pick.
 */
function renderWorkspaceFolderButton(folders: WorkspaceFolderInfo[], repositoryCount: number): string {
  const current = folders.find(f => f.isCurrent) || folders[0];
  if (!current) {
    return '';
  }
  const many = folders.length > 1;
  return `
      <button type="button" class="workspace-folder-button" id="workspaceFolderButton" data-action="pickWorkspaceFolder" data-folder="${escapeHtml(current.path)}" title="${escapeHtml(current.path)}${many ? ' — choose another workspace folder' : ''}"${many ? '' : ' aria-disabled="true"'}>
        <span class="workspace-folder-name" id="workspaceFolderName">${escapeHtml(current.name)}</span>
        <span class="workspace-folder-count" id="workspaceFolderCount">${repositoryCount} ${repositoryCount === 1 ? 'repository' : 'repositories'}</span>
        ${many ? '<span class="workspace-folder-caret" aria-hidden="true">▾</span>' : ''}
      </button>`;
}

function renderDashboardSidebar(workspaceFolders: WorkspaceFolderInfo[], repositoryCount: number): string {
  return `
    <aside class="dashboard-sidebar">
      ${renderWorkspaceFolderButton(workspaceFolders, repositoryCount)}
      <section class="sidebar-section repositories-section">
        <div class="sidebar-section-title"><span>Repositories</span><span id="repositoryAlignment" title="Linked repositories on the parent repository's branch and at the commit it records">—</span><span class="sidebar-section-tools"><button type="button" class="sidebar-title-action" data-action="syncAll" title="Align linked repositories with the commits the parent records" aria-label="Align linked repositories with recorded commits"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7h-7M17 4l3 3-3 3M4 17h7M7 20l-3-3 3-3"></path></svg></button></span></div>
        <div class="sidebar-repository-list" id="dashboardRepositories" role="group" aria-label="Repositories"></div>
      </section>
      <section class="sidebar-section branches-section" data-sidebar-section="branches">
        <div class="sidebar-section-title"><button type="button" class="sidebar-section-toggle" data-action="toggleSidebarSection" data-section="branches" aria-expanded="true" aria-controls="dashboardBranches"><span class="sidebar-section-chevron" aria-hidden="true">▾</span><span>Branches</span></button><span id="branchRefCount">—</span></div>
        <div class="sidebar-ref-list" id="dashboardBranches"><span class="sidebar-placeholder">Loading branches…</span></div>
      </section>
      <section class="sidebar-section changes-section" data-sidebar-section="changes">
        <div class="sidebar-section-title"><button type="button" class="sidebar-section-toggle" data-action="toggleSidebarSection" data-section="changes" aria-expanded="true" aria-controls="dashboardChanges" title="The active repository's uncommitted changes. Click a file to open its diff in an editor tab"><span class="sidebar-section-chevron" aria-hidden="true">▾</span><span>Changes</span></button><span class="sidebar-section-tools"><button type="button" class="sidebar-title-action" data-action="openCommitChangesModal" title="Commit selected files" aria-label="Commit selected files"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h5M15 12h5"></path><circle cx="12" cy="12" r="3"></circle></svg></button></span><span class="sidebar-section-tools" id="sidebarChangesTools"></span><span id="changesRefCount">—</span></div>
        <div class="sidebar-selection-bar" id="sidebarSelectionBar" hidden></div>
        <div class="sidebar-changes-list" id="dashboardChanges" role="list" aria-label="Uncommitted changes"><span class="sidebar-placeholder">Loading changes…</span></div>
      </section>
      <footer class="sidebar-reference-summary">
        <button class="reference-summary-row" type="button" data-action="toggleReferenceSection" data-section="tags"><span>Tags</span><span id="tagRefCount">—</span><i>›</i></button>
        <div class="reference-detail-list" id="dashboardTags" data-reference-panel="tags" hidden></div>
        <button class="reference-summary-row" type="button" data-action="toggleReferenceSection" data-section="remotes"><span>Remotes</span><span id="remoteRefCount">—</span><i>›</i></button>
        <div class="reference-detail-list" id="dashboardRemotes" data-reference-panel="remotes" hidden></div>
        <button class="reference-summary-row" type="button" data-action="toggleReferenceSection" data-section="stashes"><span>Stashes</span><span id="stashRefCount">—</span><i>›</i></button>
        <div class="reference-detail-list" id="dashboardStashes" data-reference-panel="stashes" hidden></div>
      </footer>
    </aside>
  `;
}

function renderDashboard(repositories: RepositoryInfo[], workspaceFolders: WorkspaceFolderInfo[]): string {
  const activeRepository = repositories[0];
  return `
    <div class="dashboard-shell">
      <header class="dashboard-command-bar">
        <div class="dashboard-heading">
          <h2 class="dashboard-title" id="dashboardTitle">${escapeHtml(activeRepository?.name || 'Repository Manager')}</h2>
          <div class="dashboard-subtitle" id="dashboardSubtitle">History of this repository, newest first.</div>
        </div>
        ${renderDashboardToolbar(activeRepository)}
      </header>
      <div class="dashboard-body">
        ${renderDashboardSidebar(workspaceFolders, repositories.length)}
        <main class="dashboard-main">
          <div class="history-controls">
            <input id="dashboardIncludeRemotes" type="checkbox" checked hidden>
            <div class="commit-compare-status" id="commitCompareStatus" role="status" aria-live="polite" hidden></div>
            <div class="dashboard-search"><span>⌕</span><input id="dashboardSearch" type="text" placeholder="Search author, commit, message, or ref"></div>
          </div>
          <section class="history-region">
            <div class="history-table-header" id="historyTableHeader">
              <span class="history-column-header graph-column">Graph<span class="history-column-resizer" data-column-index="0" role="separator" aria-label="Resize Graph column" aria-orientation="vertical" tabindex="0"></span></span>
              <span class="history-column-header">Message<span class="history-column-resizer" data-column-index="1" role="separator" aria-label="Resize Message column" aria-orientation="vertical" tabindex="0"></span></span>
              <span class="history-column-header">Author<span class="history-column-resizer" data-column-index="2" role="separator" aria-label="Resize Author column" aria-orientation="vertical" tabindex="0"></span></span>
              <span class="history-column-header">Date<span class="history-column-resizer" data-column-index="3" role="separator" aria-label="Resize Date column" aria-orientation="vertical" tabindex="0"></span></span>
              <span class="history-column-header">Commit<span class="history-column-resizer" data-column-index="4" role="separator" aria-label="Resize Commit column" aria-orientation="vertical" tabindex="0"></span></span>
            </div>
            <div class="history-table" id="dashboardHistory"><div class="dashboard-loading">Loading history…</div></div>
          </section>
          <div class="dashboard-splitter dashboard-splitter-horizontal" id="historyDiffSplitter" role="separator" aria-label="Resize history and diff panels" aria-orientation="horizontal" tabindex="0"></div>
          <section class="commit-detail-region">
            <div class="commit-header">
              <div class="commit-summary" id="dashboardCommitSummary">
                <div class="detail-placeholder">Select a commit to inspect its changed files and diff.</div>
              </div>
              <div class="commit-header-actions" id="commitHeaderActions" role="group" aria-label="Actions on these changes" hidden><span class="working-tree-actions" id="workingTreeActions" hidden><button type="button" class="btn" data-action="reviewLocal" id="reviewLocalChangesButton" title="Review your local changes before committing: staged and unstaged changes and new files (not those .gitignore excludes), as they are now. Nothing is committed or staged">Review changes</button></span><span class="working-tree-actions" id="selectionReviewActions" hidden><button type="button" class="btn" data-action="reviewSelection" id="reviewSelectionHeaderButton" title="Review these committed changes: the commit against its parent, or the comparison from Base to Target">Review changes</button></span><span class="stash-actions" id="stashActions" hidden><button type="button" class="btn" data-action="stashAction" data-operation="apply" title="Apply this stash to the working tree and keep it">Apply</button><button type="button" class="btn" data-action="stashAction" data-operation="pop" title="Apply this stash to the working tree and remove it">Pop</button><button type="button" class="btn" data-action="stashAction" data-operation="drop" title="Delete this stash without applying it">Drop…</button></span><button type="button" class="btn" data-action="summarizeChanges" id="summarizeChangesButton" title="Summarize these changes with Copilot">Summarize changes</button><button type="button" class="btn" data-action="cancelChangeSummary" id="cancelChangeSummaryButton" hidden>Cancel</button></div>
            </div>
            <div class="change-summary" id="changeSummary" hidden>
              <div class="change-summary-status" id="changeSummaryStatus" role="status"></div>
              <div class="change-summary-result" id="changeSummaryResult"></div>
            </div>
            <div class="commit-content" id="commitContent">
              <div class="changed-files-panel">
                <div class="panel-title"><span>Changed files</span><span id="changedFileCount">0</span></div>
                <div class="changed-files-list" id="dashboardChangedFiles"></div>
              </div>
              <div class="dashboard-splitter dashboard-splitter-vertical" id="filesDiffSplitter" role="separator" aria-label="Resize changed files and diff panels" aria-orientation="vertical" tabindex="0"></div>
              <div class="diff-panel">
                <div class="panel-title"><span id="diffFileName">Diff</span><span class="working-diff-modes" id="workingDiffModes" role="group" aria-label="Which uncommitted changes the diff shows" hidden><button type="button" data-action="workingDiffMode" data-mode="staged" title="The changes already staged (the index)">Staged</button><button type="button" data-action="workingDiffMode" data-mode="unstaged" title="The changes not staged yet (the working tree)">Unstaged</button></span><span id="diffTruncated"></span><button type="button" class="diff-open-editor" id="openDiffInEditorButton" data-action="openDiffInEditor" title="Open this file's diff in an editor tab, in VS Code's diff editor (double-click a file does the same)" hidden>Open ↗</button></div>
                <pre class="diff-viewer" id="dashboardDiff"><span class="diff-placeholder">Select a changed file to load its patch.</span></pre>
              </div>
            </div>
          </section>
        </main>
      </div>
    </div>
  `;
}

/**
 * Generate the full HTML for the webview
 */
/** Resources for the Side Bar view: the dashboard's stylesheet and the Side Bar script. */
export interface SidebarResourceUris {
  scriptUri: vscode.Uri;
  styleUri: vscode.Uri;
}

/**
 * The Side Bar view. It starts empty and shows the list the dashboard sends it: the dashboard
 * keeps rendering its sidebar (hidden in the editor tab) and mirrors it here.
 */
export function getSidebarHtml(resourceUris: SidebarResourceUris): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${resourceUris.styleUri.scheme}:; script-src 'nonce-${nonce}';">
  <title>Repositories</title>
  <link rel="stylesheet" href="${resourceUris.styleUri}">
</head>
<body class="sidebar-view">
  <aside class="dashboard-sidebar" id="sidebarRoot" aria-label="Repositories and branches"><span class="sidebar-placeholder">Opening the dashboard…</span></aside>
  <script nonce="${nonce}" src="${resourceUris.scriptUri}"></script>
</body>
</html>`;
}

/** The Repository Review tab: its script fills the panel and talks to the extension (ReviewBridge). */
export function getReviewHtml(resourceUris: SidebarResourceUris): string {
  const nonce = getNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${resourceUris.styleUri.scheme}:; script-src 'nonce-${nonce}';">
  <title>Repository Review</title>
  <link rel="stylesheet" href="${resourceUris.styleUri}">
</head>
<body class="review-view-body">
  <main class="review-panel review-view" id="reviewPanel">
    <div class="review-header">
      <div class="review-title"><strong id="reviewTitle">Review</strong><span id="reviewMeta"></span></div>
      <div class="review-actions">
        <span class="review-status" id="reviewStatus" role="status" aria-live="polite"></span>
        <button type="button" class="btn" data-action="cancelReview" id="cancelReviewButton" hidden>Cancel</button>
        <button type="button" class="btn" data-action="exportReview" data-format="copy" id="copyReviewButton" hidden>Copy Markdown</button>
        <button type="button" class="btn" data-action="exportReview" data-format="save" id="saveReviewButton" hidden>Save report…</button>
      </div>
    </div>
    <details class="review-history" id="reviewHistory" hidden>
      <summary>Past reviews <span class="review-history-count" id="reviewHistoryCount"></span></summary>
      <p class="review-history-note">Saved in this workspace on this machine, never in the repository.</p>
      <ul class="review-history-list" id="reviewHistoryList"></ul>
    </details>
    <details class="review-skills" id="reviewSkills">
      <summary>Review skills <span class="review-history-count" id="reviewSkillsCount"></span></summary>
      <p class="review-history-note">Checklists given to Copilot with the files they match. Turn one off, or import your own Markdown file with the same header.</p>
      <ul class="review-skills-list" id="reviewSkillsList"></ul>
      <div class="review-skills-actions"><button type="button" class="btn" data-action="importReviewSkill">Import skill…</button><span id="reviewSkillsStatus" role="status"></span></div>
    </details>
    <div class="review-body" id="reviewBody"></div>
  </main>
  <script nonce="${nonce}" src="${resourceUris.scriptUri}"></script>
</body>
</html>`;
}

/** The Requirement editor: a clarification file as a form; its script talks to RequirementEditorProvider. */
export function getRequirementEditorHtml(resourceUris: SidebarResourceUris & { cspSource: string }): string {
  const nonce = getNonce();
  // Images: the editor's own blob: URLs for files in the repository, and https images named in
  // Visual aids, which the webview loads straight from their site.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${resourceUris.cspSource}; img-src ${resourceUris.cspSource} blob: https:; script-src 'nonce-${nonce}';">
  <title>Requirement Editor</title>
  <link rel="stylesheet" href="${resourceUris.styleUri}">
</head>
<body>
<header>
  <div class="title">
    <svg class="doc-icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M9 13h6M9 17h4"/></svg>
    <div class="heading"><h1 id="doc-title">Opening…</h1><p id="filename"></p></div>
    <div class="toolbar">
      <span id="state"></span>
      <button class="icon" id="reload" title="Reload: read the file again" aria-label="Reload"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg></button>
      <button class="icon" id="download" title="Download draft: save the current text to another file" aria-label="Download draft"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg></button>
      <button class="primary" id="save" title="Save (Ctrl+S)">Save</button>
    </div>
  </div>
  <div class="subhead">
    <nav class="crumbs" id="crumbs" aria-label="Location"></nav>
    <div class="seg-switch" role="group" aria-label="View">
      <button type="button" id="mode-form" aria-pressed="true" title="Form (Alt+1)">Form</button>
      <button type="button" id="mode" aria-pressed="false" title="Edit the whole Markdown source (Alt+3)">Markdown</button>
    </div>
  </div>
  <div id="message" role="status" aria-live="polite"></div>
</header>
<main>
  <div id="form-view">
    <div id="form"></div>
    <div class="empty-state" id="empty" hidden>
      <p>This file has no clarification yet.</p>
      <button type="button" class="primary" id="add">+ New clarification</button>
    </div>
  </div>
  <div id="trace" hidden>
    <div class="source-bar" id="source-bar"></div>
    <div id="req-list"></div>
  </div>
  <div id="raw" hidden>
    <p class="note">Markdown edits the whole file. Choose Form, or an item or requirement in the side bar, to validate it and go back.</p>
    <textarea id="source" aria-label="Markdown source" spellcheck="false"></textarea>
  </div>
  <footer>Markdown is the source of truth. Only fields you change are rewritten. Save does not update referenced requirements.</footer>
</main>
  <script nonce="${nonce}" src="${resourceUris.scriptUri}"></script>
</body>
</html>`;
}
export function getHtmlForWebview(repositories: RepositoryInfo[], resourceUris: WebviewResourceUris, workspaceFolders: WorkspaceFolderInfo[] = []): string {
  const nonce = getNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${resourceUris.styleUri.scheme}:; script-src 'nonce-${nonce}';">
  <title>Repository Manager</title>
  <link rel="stylesheet" href="${resourceUris.styleUri}">
</head>
<body>
  ${renderDashboard(repositories, workspaceFolders)}

  ${renderModals(repositories)}

  <div class="history-context-menu" id="historyContextMenu" role="menu" aria-label="Commit actions" hidden>
    <button type="button" role="menuitem" data-action="contextAddTag">Add Tag…</button>
    <button type="button" role="menuitem" data-action="contextCreateBranch">Create Branch…</button>
    <button type="button" role="menuitem" data-action="contextCheckoutCommit">Checkout…</button>
    <div class="history-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="contextCherryPick">Cherry Pick…</button>
    <button type="button" role="menuitem" data-action="contextRevert">Revert…</button>
    <button type="button" role="menuitem" data-action="contextMerge">Merge into current branch…</button>
    <div class="history-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="contextRebase">Rebase current branch onto this commit…</button>
    <button type="button" role="menuitem" data-action="contextReset">Reset current branch to this commit…</button>
    <button type="button" role="menuitem" data-action="contextDrop">Drop this commit…</button>
    <div class="history-context-branches" id="historyContextBranches" hidden></div>
    <button type="button" role="menuitem" data-action="contextContinueRebase" data-requires-operation="rebase" hidden>Continue rebase</button>
    <button type="button" role="menuitem" data-action="contextAbortRebase" data-requires-operation="rebase" hidden>Abort rebase…</button>
    <div class="history-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="contextCopyHash">Copy Commit Hash</button>
    <button type="button" role="menuitem" data-action="contextCopySubject">Copy Commit Subject</button>
    <div class="history-context-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="contextReviewCommit" title="Review what this commit changed against its parent (committed content only)">Review changes in this commit</button>
    <button type="button" role="menuitem" data-action="contextReviewSnapshot" title="Review every file as committed at this commit; uncommitted changes are not included">Review branch at this commit</button>
  </div>

  <div class="history-context-menu" id="changesContextMenu" role="menu" aria-label="Changed file actions" hidden>
    <button type="button" role="menuitem" data-action="contextSuggestResolution" title="Ask Copilot to resolve this file's conflicts. You see the result as a diff first; applying writes the file only, without staging it or continuing" hidden>Suggest Resolution…</button>
    <button type="button" role="menuitem" data-action="contextOpenInEditor" title="Open this file's diff in an editor tab, in VS Code's diff editor">Open Changes</button>
    <button type="button" role="menuitem" data-action="contextReviewFile" title="Review only this file's changes with Copilot; the model may still read other files for context">Review Changes in This File</button>
    <button type="button" role="menuitem" data-action="contextDiscardFile" title="Put this file back as it is at HEAD (staged and unstaged changes); a new file is deleted. A copy is kept first">Discard Changes…</button>
    <button type="button" role="menuitem" data-action="contextDiscardAll" title="Put every changed file back as it is at HEAD and delete new files (not ignored ones). A copy is kept first">Discard All Changes…</button>
  </div>

  <div class="history-context-menu dashboard-more-menu" id="dashboardMoreMenu" role="menu" aria-label="More actions" hidden>
    <button type="button" role="menuitem" data-action="refresh" data-operation="refresh" title="Read every repository's status, branches and history again">Refresh</button>
    <button type="button" role="menuitem" data-action="openBranchCompareModal" title="Show the changes from a base branch or tag to a target branch or tag">Compare branches…</button>
    <button type="button" role="menuitem" data-action="naturalUndo" id="naturalUndoButton" title="Say what to undo (e.g. &quot;undo my last 2 commits but keep the changes&quot;). Copilot picks one of the dashboard's actions; you see it, and that action's own confirmation, before anything runs">Undo…</button>
    <button type="button" role="menuitemcheckbox" data-action="toggleIncludeRemotes" id="includeRemotesItem" aria-checked="true" title="Include remote branches in the graph">Include remote branches</button>
    <div class="menu-separator" role="separator"></div>
    <div class="menu-heading" role="presentation">Review with Copilot</div>
    <button type="button" role="menuitem" data-action="reviewRelease" data-scope="changes" title="Review the files the current branch changed since it left the default branch (main or master), as a pull request shows them. Committed changes only: use Review changes for uncommitted work">Review branch: changed files</button>
    <button type="button" role="menuitem" data-action="reviewRelease" data-scope="branch" title="Every file as committed at the tip of the current branch. Sends far more code to Copilot">Review branch: every file</button>
    <button type="button" role="menuitem" data-action="openReviewTab" id="openReviewTabButton" title="Open the Repository Review tab: progress, results, past reviews and review skills">Open Review tab<span class="review-open-badge" id="reviewTabBadge"></span></button>
    <div class="menu-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="toggleSummaryModelMenu" id="summaryModelButton" aria-haspopup="menu" aria-expanded="false" aria-controls="summaryModelMenu" title="The Copilot model for reviews, summaries, commit messages and fixes; the list loads when you open it. Pin models to list them first"><span id="summaryModelLabel">Copilot model:</span> <span id="summaryModelName">Default</span></button>
    <button type="button" role="menuitem" data-action="toggleCopilotSettingsMenu" id="copilotSettingsButton" aria-haspopup="menu" aria-expanded="false" aria-controls="copilotSettingsMenu" title="Whether to ask before code is sent to Copilot, and all Repository Manager settings">Copilot settings…</button>
  </div>

  <div class="history-context-menu summary-model-menu" id="summaryModelMenu" role="menu" aria-label="Copilot model" hidden></div>

  <div class="history-context-menu copilot-settings-menu" id="copilotSettingsMenu" role="menu" aria-label="Copilot settings" hidden>
    <div class="menu-heading" role="presentation">Ask before sending code to Copilot</div>
    <button type="button" role="menuitemradio" aria-checked="true" data-action="setAskBeforeSending" data-value="never" title="Reviews, fixes, explanations, summaries and commit messages start at once">Never ask</button>
    <button type="button" role="menuitemradio" aria-checked="false" data-action="setAskBeforeSending" data-value="oncePerRepository" title="Ask the first time in each repository; Always allow stops asking there">Once per repository</button>
    <button type="button" role="menuitemradio" aria-checked="false" data-action="setAskBeforeSending" data-value="always" title="Ask before every request that sends code to Copilot">Every time</button>
    <div class="menu-separator" role="separator"></div>
    <button type="button" role="menuitem" data-action="openExtensionSettings" title="Open the Settings editor at Repository Manager's settings">All settings…</button>
  </div>

  <div class="history-context-menu review-branch-menu" id="reviewBranchMenu" role="menu" aria-label="Review branch" hidden>
    <button type="button" role="menuitem" data-action="reviewRelease" data-scope="changes" title="The files the current branch changed since it left the default branch, as a pull request shows them">Changed files</button>
    <button type="button" role="menuitem" data-action="reviewRelease" data-scope="branch" title="Every file as committed at the tip of the current branch. Sends far more code to Copilot">All files</button>
  </div>

  <script nonce="${nonce}">window.__initialRepositories = ${JSON.stringify(repositories)};</script>
  <script nonce="${nonce}" src="${resourceUris.graphScriptUri}"></script>
  <script nonce="${nonce}" src="${resourceUris.scriptUri}"></script>
</body>
</html>`;
}
