import * as vscode from 'vscode';
import { getSidebarHtml } from './webview/template';

/** What the Side Bar view needs from the dashboard panel, without importing it. */
export interface SidebarDashboard {
  isOpen(): boolean;
  /** Opens the dashboard, or reveals it without taking focus from the Side Bar. */
  open(): Promise<void>;
  post(message: { type: string; payload?: unknown }): Thenable<boolean> | undefined;
  /** The Side Bar became visible (its Changes list keeps local changes current too). */
  sidebarShown?(): void;
}

/**
 * The Activity Bar's Side Bar: the repositories, branches, tags, remotes and stashes of the
 * dashboard. The dashboard owns that state and sends a rendered copy after every change
 * (`update`); clicks here go back to the dashboard (`sidebarAction`), which runs them.
 */
export class RepositoryManagerLauncher implements vscode.WebviewViewProvider {
  static readonly viewType = 'repositoryManager.launcher';
  static current: RepositoryManagerLauncher | undefined;

  private view?: vscode.WebviewView;
  /** The last copy the dashboard sent; a recreated view shows it at once. */
  private html?: string;

  constructor(private readonly extensionUri: vscode.Uri, private readonly dashboard: SidebarDashboard) {
    RepositoryManagerLauncher.current = this;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources')] };
    view.webview.html = getSidebarHtml({
      scriptUri: view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'sidebar.js')),
      styleUri: view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'resources', 'webview.css'))
    });
    view.webview.onDidReceiveMessage(message => { void this.receive(message); });
    // Showing the Side Bar opens the dashboard next to it, as the icon always did.
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        void this.ensureDashboard();
        this.dashboard.sidebarShown?.();
      }
    });
    view.onDidDispose(() => { if (this.view === view) { this.view = undefined; } });
    if (view.visible) { void this.ensureDashboard(); }
  }

  /** Whether the Side Bar view is on screen. */
  get visible(): boolean {
    return Boolean(this.view && this.view.visible);
  }

  /** A new copy of the list from the dashboard. */
  update(html: string): void {
    this.html = html;
    void this.view?.webview.postMessage({ type: 'sidebarSnapshot', payload: { html } });
  }

  /** The dashboard closed: its list is no longer current, and clicks have nothing to act on. */
  dashboardClosed(): void {
    this.html = undefined;
    void this.view?.webview.postMessage({ type: 'sidebarClosed' });
  }

  private async ensureDashboard(): Promise<void> {
    if (!this.dashboard.isOpen()) { await this.dashboard.open(); }
  }

  private async receive(message: { type?: string; payload?: unknown }): Promise<void> {
    switch (message?.type) {
      case 'sidebarReady':
        // A recreated view starts empty: show the last copy, and ask the dashboard for a fresh one.
        if (this.html !== undefined) {
          this.update(this.html);
        } else if (!this.dashboard.isOpen()) {
          void this.view?.webview.postMessage({ type: 'sidebarClosed' });
        }
        void this.dashboard.post({ type: 'publishSidebar' });
        return;
      case 'openDashboard':
        await this.dashboard.open();
        return;
      case 'sidebarAction':
        if (this.dashboard.isOpen()) {
          void this.dashboard.post({ type: 'sidebarAction', payload: message.payload });
        } else {
          // The list was from a closed dashboard; open it rather than act on a stale item.
          await this.dashboard.open();
        }
        return;
    }
  }
}
