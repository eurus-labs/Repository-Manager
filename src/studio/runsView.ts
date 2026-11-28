/**
 * The Studio's Runs view (docs/agent-studio.md, phase 3): every run with what it measures, filters,
 * and one run's timeline; Resume for a waiting run and the raw log for any. The page is rendered by
 * runsPage.ts from the run states and logs RunStore keeps.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { RunStatus } from './engine';
import { renderRunsPage } from './runsPage';
import { RunRecord, RunsFilter, runTimeline } from './runsReport';
import { StudioRuns } from './studioCommands';

export const RUNS_VIEW = 'repositoryManager.studio.runs';
/** Runs read for the view, newest first: the summary counts these. */
export const RUNS_READ = 300;
/** While a run goes on, the view is drawn again at most this often (a trailing refresh follows). */
export const REFRESH_INTERVAL_MS = 250;

type Incoming = { type?: string; run?: string; key?: string; value?: string };

export class RunsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private filter: RunsFilter = {};
  private selected?: string;
  private lastRefresh = 0;
  private timer?: ReturnType<typeof setTimeout>;
  /** The newest refresh started: an older one that finishes later does not overwrite it. */
  private drawing = 0;
  /** The page last drawn, without its nonce: a refresh that would draw the same page leaves it alone. */
  private drawn = '';

  static register(context: vscode.ExtensionContext, runs: StudioRuns | undefined): RunsViewProvider {
    const provider = new RunsViewProvider(runs);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(RUNS_VIEW, provider));
    return provider;
  }

  constructor(private readonly runs: StudioRuns | undefined) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.onDidReceiveMessage((message: Incoming) => { void this.receive(message); });
    view.onDidChangeVisibility(() => { if (view.visible) { void this.refresh(); } });
    void this.refresh();
    void this.follow(view);
  }

  /**
   * Draws the view again as the runs' logs grow, from whichever of chat, editor, Run Workflow… or Resume
   * started them. Only while the view is shown; the subscription ends with the view.
   */
  private async follow(view: vscode.WebviewView): Promise<void> {
    if (!this.runs) { return; }
    let ended = false;
    const subscriptions: Array<{ dispose(): void }> = [];
    const end = () => {
      ended = true;
      subscriptions.forEach(subscription => subscription.dispose());
      if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
      if (this.view === view) { this.view = undefined; }
    };
    view.onDidDispose(end);
    let store;
    try { store = await this.runs.runs(); } catch { return; }
    if (ended) { return; }
    // At most one redraw per REFRESH_INTERVAL_MS. A log line is written just before the state it belongs to
    // is saved, so a redraw that follows an entry is confirmed by one more (drawn only if it differs).
    const arm = (confirm: boolean): void => {
      if (this.timer) { return; }
      const wait = Math.max(0, REFRESH_INTERVAL_MS - (Date.now() - this.lastRefresh));
      this.timer = setTimeout(() => {
        this.timer = undefined;
        if (ended || !view.visible) { return; }
        void this.refresh();
        if (!confirm) { arm(true); }
      }, wait);
    };
    subscriptions.push(store.onLog(() => { if (view.visible) { arm(false); } }));
  }

  /** Reads the runs again and redraws (also after a run changes). */
  async refresh(): Promise<void> {
    const view = this.view;
    if (!view) { return; }
    const nonce = randomBytes(16).toString('base64');
    if (!this.runs) {
      this.drawn = '';
      view.webview.html = `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';"></head><body><p>Open a folder to see its workflow runs.</p></body></html>`;
      return;
    }
    const drawing = ++this.drawing;
    this.lastRefresh = Date.now();
    const store = await this.runs.runs();
    const states = (await store.list()).slice(0, RUNS_READ);
    // Runs whose log cannot be read are still listed: their times are "no data".
    const records: RunRecord[] = await Promise.all(states.map(async state => ({ state, log: await store.readLog(state.id).catch(() => []) })));
    const chosen = records.find(record => record.state.id === this.selected);
    const workflow = chosen ? await store.loadWorkflow(chosen.state.id).catch(() => undefined) : undefined;
    // A newer refresh started while this one read: it draws, not this one.
    if (drawing !== this.drawing || this.view !== view) { return; }
    const html = renderRunsPage({
      records, filter: this.filter, nonce, cspSource: view.webview.cspSource,
      selected: chosen ? { record: chosen, timeline: runTimeline(chosen, workflow) } : undefined
    });
    const same = html.split(nonce).join('');
    if (same === this.drawn) { return; }
    this.drawn = same;
    view.webview.html = html;
  }

  private async receive(message: Incoming): Promise<void> {
    try {
      switch (message.type) {
        case 'refresh': break;
        case 'select': this.selected = message.run; break;
        case 'filter':
          if (message.key === 'workflow') { this.filter = { ...this.filter, workflow: message.value || undefined }; }
          if (message.key === 'status') { this.filter = { ...this.filter, status: (message.value || undefined) as RunStatus | 'interrupted' | undefined }; }
          break;
        case 'stop':
          if (message.run && this.runs && !this.runs.stop(message.run)) {
            void vscode.window.showInformationMessage('That run is not running in this window, so it cannot be stopped from here.');
          }
          break;
        case 'resume': if (message.run && this.runs) { await this.runs.resume(message.run); } break;
        case 'rawLog': if (message.run && this.runs) { await this.runs.openLog(message.run); } return;
        default: return;
      }
    } catch (error) {
      void vscode.window.showErrorMessage(`Workflow Runs: ${error instanceof Error ? error.message : String(error)}`);
    }
    await this.refresh();
  }
}
