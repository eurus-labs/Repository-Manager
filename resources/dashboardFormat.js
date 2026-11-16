// Formatting helpers shared by the dashboard scripts.
// Loaded before webview.js (see src/webview/dashboardScripts.ts); also required by Node tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.RepositoryDashboardFormat = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function shortRevision(revision) {
    if (!revision) return '';
    return revision.length >= 12 && /^[0-9a-f]+$/i.test(revision) ? revision.slice(0, 8) : revision;
  }

  return Object.freeze({ escapeHtml, shortRevision });
});
