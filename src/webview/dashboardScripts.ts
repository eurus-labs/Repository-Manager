/**
 * The scripts the dashboard page loads, as file names under resources/, in load order.
 * Order matters: shared helpers come before webview.js, which reads them at start.
 * A new dashboard script is added here and nowhere else; the page template, the panel,
 * the UI snapshot harness and the Node suites all read this list.
 * No `vscode` import: Node tests require the compiled file directly.
 */
export const DASHBOARD_SCRIPTS: readonly string[] = ['historyGraph.js', 'dashboardFormat.js', 'dashboardWorkingTree.js', 'dashboardCommitDialog.js', 'dashboardHistory.js', 'webview.js'];
