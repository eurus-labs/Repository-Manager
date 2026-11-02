export interface ToolbarRepositoryState {
  ahead?: number;
  behind?: number;
}

/**
 * The dashboard's one row of commands: Fetch, Pull and Push, New branch, Commit, and ⋯ for the
 * rest (Refresh, Compare branches, Undo, Include remote branches, Review branch, the Copilot
 * model and settings). Align is on the sidebar's Repositories title, Review changes on the
 * changes it reviews.
 */
export function renderDashboardToolbar(repository?: ToolbarRepositoryState): string {
  return `
    <div class="command-cluster command-cluster-right">
      <div class="dashboard-remote-actions" role="group" aria-label="Remote operations">
        <button class="dashboard-command" data-action="fetchActiveRepository" data-operation="fetch" title="Fetch" aria-label="Fetch"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18a4 4 0 0 1-.5-8A6 6 0 0 1 18 9a4 4 0 0 1 0 9"></path><path d="M12 12v8M9 17l3 3 3-3"></path></svg><span class="command-label">Fetch</span></button>
        <button class="dashboard-command" data-action="pullActiveRepository" data-operation="pull" title="Pull" aria-label="Pull"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v15M6 13l6 6 6-6"></path></svg><span class="command-label">Pull</span><small id="dashboardBehindCount" ${repository?.behind ? '' : 'hidden'}>${repository?.behind || ''}</small></button>
        <button class="dashboard-command" data-action="pushActiveRepository" data-operation="push" title="Push" aria-label="Push"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20V5M6 11l6-6 6 6"></path></svg><span class="command-label">Push</span><small id="dashboardAheadCount" ${repository?.ahead ? '' : 'hidden'}>${repository?.ahead || ''}</small></button>
      </div>
      <button class="dashboard-command dashboard-command-secondary" data-action="openCreateBranchModal" title="New branch" aria-label="New branch"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="5" r="2"></circle><circle cx="6" cy="19" r="2"></circle><path d="M6 7v10M8 7h4a4 4 0 0 1 4 4v1M16 9v6M13 12h6"></path></svg><span class="command-label">New branch</span></button>
      <button class="dashboard-command dashboard-command-commit" data-action="openCommitChangesModal" title="Commit selected files" aria-label="Commit selected files"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h5M15 12h5"></path><circle cx="12" cy="12" r="3"></circle></svg><span class="command-label">Commit…</span></button>
      <button class="dashboard-icon-command dashboard-more-button" type="button" data-action="toggleDashboardMoreMenu" id="dashboardMoreButton" aria-haspopup="menu" aria-expanded="false" aria-controls="dashboardMoreMenu" aria-label="More actions" title="More: Refresh, Compare branches, Undo, Include remote branches, Review branch, Copilot model and settings"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.5"></circle><circle cx="12" cy="12" r="1.5"></circle><circle cx="19" cy="12" r="1.5"></circle></svg><span class="more-badge" id="dashboardMoreBadge" hidden></span></button>
    </div>
  `;
}
