/**
 * The Studio's visual editor for `*.workflow.json` (docs/agent-studio.md, "Visual editor"). The
 * file is a text document and stays the only source: the page draws it and sends edits, the
 * host applies them (workflowEdit.ts) and replaces the document's text, and any change to the
 * document, from here or from the JSON editor, draws the page again. Undo, Save and dirty state
 * are VS Code's own.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { RunLogEntry, RunState, workflowEffects } from './engine';
import { activityLine, runTimeline, stepOutcome } from './runsReport';
import { StepDefinition } from './steps';
import { studioSteps } from './registry';
import { StudioRuns } from './studioCommands';
import { runOrder, validateWorkflow, Workflow, workflowHash } from './workflow';
import { applyEdit, EditError, EditOperation, positions, problemNodes, serializeWorkflow, settingText } from './workflowEdit';

export const WORKFLOW_EDITOR = 'repositoryManager.workflowEditor';

const EFFECT_ASKS: Record<string, string> = { write: 'writes files', command: 'runs a command', external: 'sends to another system' };

/** What the page draws: the workflow, where each node sits, its problems, and the steps it can add. */
export function editorState(text: string, steps: Map<string, StepDefinition>): Record<string, unknown> {
  const catalog = [...steps.values()].map(step => ({
    type: step.type, title: step.title, description: step.description ?? '', effect: step.effect, usesModel: Boolean(step.usesModel),
    required: step.required, optional: step.optional ?? [], asks: step.type === 'gate' ? 'waits for you' : EFFECT_ASKS[step.effect] ?? ''
  }));
  let value: unknown;
  try { value = JSON.parse(text); } catch (error) {
    return { type: 'load', editable: false, error: `The file is not valid JSON (${error instanceof Error ? error.message : String(error)}). Open it as JSON to fix it.`, catalog };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as Workflow).nodes)) {
    return { type: 'load', editable: false, error: 'This JSON is not a workflow: it has no "nodes" list. Open it as JSON to fix it.', catalog };
  }
  const workflow = value as Workflow;
  const validated = validateWorkflow(workflow, steps);
  // Entries the diagram cannot draw (a node without an id, an edge without ends): said, not drawn.
  const record = (item: unknown): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item);
  const unreadable = !workflow.nodes.every(node => record(node) && typeof node.id === 'string' && typeof node.type === 'string')
    || (workflow.edges !== undefined && !(Array.isArray(workflow.edges) && workflow.edges.every(edge => record(edge) && typeof edge.from === 'string' && typeof edge.to === 'string')))
    || (workflow.layout !== undefined && !record(workflow.layout));
  if (unreadable) {
    return { type: 'load', editable: false, catalog,
      error: `The diagram cannot be drawn:\n${validated.slice(0, 6).map(problem => `• ${problem.where}: ${problem.message}`).join('\n') || '• a node, an edge or the layout is not in the expected shape.'}\nOpen it as JSON to fix it.` };
  }
  const problems = validated.map(problem => ({ ...problem, nodes: problemNodes(workflow, problem.where) }));
  // Settings as the form shows them: text as is, anything else as JSON.
  const settings = Object.fromEntries(workflow.nodes.filter(node => node && typeof node.id === 'string')
    .map(node => [node.id, Object.fromEntries(Object.entries(node.with ?? {}).map(([key, setting]) => [key, settingText(setting)]))]));
  return {
    type: 'load', editable: true, workflow, settings, problems, catalog,
    positions: positions(workflow),
    effects: problems.length ? undefined : workflowEffects(workflow, steps)
  };
}

/** The page hears about a run at most this often while it writes its log (a confirming post follows). */
export const RUN_POST_INTERVAL_MS = 250;

/**
 * What the diagram shows of a run (plan 10): each step's state as `runTimeline` reads it from the log, the
 * same words as the chat's run card, and how the run's copy of the workflow stands against the open file.
 * Steps the file no longer has are listed in `missing`, not drawn.
 */
export function runStateMessage(state: RunState, log: RunLogEntry[], saved: Workflow, fileText: string): Record<string, unknown> {
  // The log's finish is written just before the state is saved: it is the first to say the run ended.
  const finish = [...log].reverse().find(entry => entry.type === 'finish');
  const status = finish && (finish.status === 'done' || finish.status === 'failed' || finish.status === 'stopped') ? finish.status : state.status;
  const timeline = runTimeline({ state: { ...state, status }, log }, saved);
  const byId = new Map(timeline.nodes.map(node => [node.node, node]));
  const since = new Map<string, string>();
  for (const entry of log) { if (entry.type === 'node' && typeof entry.node === 'string') { since.set(entry.node, entry.at); } }
  let order: string[];
  try { order = runOrder(saved); } catch { order = saved.nodes.map(node => node.id); }
  const inFile = new Set<string>();
  try { for (const node of (JSON.parse(fileText) as Workflow).nodes) { if (node && typeof node.id === 'string') { inFile.add(node.id); } } } catch { /* not JSON: nothing is drawn */ }
  const steps: Record<string, unknown> = {};
  const missing: Array<{ id: string; title: string; outcome: string }> = [];
  const outcomes = order.map(id => {
    const node = byId.get(id);
    const outcome = stepOutcome(node?.outcome ?? 'pending', status);
    const title = saved.nodes.find(candidate => candidate.id === id)?.title ?? id;
    if (inFile.has(id)) {
      steps[id] = { outcome, ...(outcome === 'running' && since.has(id) ? { since: since.get(id) } : {}), ...(node?.error && outcome === 'failed' ? { error: node.error } : {}) };
    } else { missing.push({ id, title, outcome }); }
    return outcome;
  });
  const active = outcomes.findIndex(outcome => outcome === 'running' || outcome === 'waiting' || outcome === 'failed' || outcome === 'stopped');
  const finished = outcomes.filter(outcome => outcome === 'done' || outcome === 'skipped').length;
  const step = active >= 0 ? active + 1 : Math.min(order.length, finished + (status === 'done' ? 0 : 1));
  // What the running step is doing now: the last activity line it wrote.
  const running = active >= 0 && status === 'running' ? order[active] : undefined;
  const last = running ? [...log].reverse().find(entry => entry.node === running && activityLine(entry)) : undefined;
  return {
    type: 'runState',
    run: {
      id: state.id, title: state.workflow.title, status, startedAt: state.startedAt, step, total: order.length,
      earlier: state.workflow.hash !== workflowHash(fileText), steps, missing,
      stoppable: status === 'running', ...(last ? { activity: activityLine(last)!.text } : {})
    }
  };
}

/** Follows the runs of the open file's workflow id and posts their state to the page. */
class LiveRun {
  private tracked?: { id: string; startedAt: string; live: boolean };
  private posted = '';
  private timer?: ReturnType<typeof setTimeout>;
  private lastPost = 0;
  private readonly dirty = new Set<string>();
  private readonly other = new Set<string>();
  /** An entry arrived since the last look was asked for. */
  private fresh = false;
  private subscription?: { dispose(): void };
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly runs: StudioRuns, private readonly document: vscode.TextDocument, private readonly post: (message: unknown) => void) {
    this.enqueue(() => this.start());
  }

  get runId(): string | undefined { return this.tracked?.id; }

  /** The file changed (its hash and steps are part of what the page shows): say what the run is now, if there is one. */
  again(): void { this.enqueue(() => this.render()); }

  /** The page was opened anew: send the latest state again, even if it did not change. */
  resend(): void { this.posted = ''; this.again(); }

  dispose(): void {
    this.disposed = true;
    this.subscription?.dispose();
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
  }

  private enqueue(job: () => Promise<void>): void {
    this.queue = this.queue.then(() => { if (!this.disposed) { return job(); } }).catch(error => console.error('[RepositoryManager] Workflow editor runs:', error));
  }

  private fileId(): string | undefined {
    try { const value = JSON.parse(this.document.getText()) as { id?: unknown }; return typeof value.id === 'string' ? value.id : undefined; } catch { return undefined; }
  }

  private async start(): Promise<void> {
    const store = await this.runs.runs();
    if (this.disposed) { return; }
    // A run that goes on already: the newest one of this workflow that is running or waiting.
    const id = this.fileId();
    const found = id ? (await store.list()).find(state => state.workflow.id === id && (state.status === 'running' || state.status === 'waiting')) : undefined;
    if (this.disposed) { return; }
    if (found) { this.tracked = { id: found.id, startedAt: found.startedAt, live: true }; await this.render(); }
    if (this.disposed) { return; }
    this.subscription = store.onLog(runId => {
      if (this.disposed || this.other.has(runId)) { return; }
      this.dirty.add(runId);
      this.fresh = true;
      this.arm(false);
    });
  }

  /** At most one post per interval; an entry is written just before its state is saved, so one more look follows it. */
  private arm(confirm: boolean): void {
    if (this.timer || this.disposed) { return; }
    const wait = Math.max(0, RUN_POST_INTERVAL_MS - (Date.now() - this.lastPost));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.lastPost = Date.now();
      // An entry that came while this one was waiting has had no look of its own: confirm again.
      const again = this.fresh;
      this.fresh = false;
      this.enqueue(() => this.flush());
      if (!confirm || again) { this.arm(true); }
    }, wait);
  }

  private async flush(): Promise<void> {
    const store = await this.runs.runs();
    const id = this.fileId();
    const runIds = [...this.dirty];
    this.dirty.clear();
    for (const runId of runIds) {
      const state = await store.load(runId).catch(() => undefined);
      if (this.disposed) { return; }
      if (!state) { continue; }
      // The file may be unreadable for a moment (mid-edit in the JSON editor): that says nothing about the run.
      if (!id) { continue; }
      if (state.workflow.id !== id) { if (this.tracked?.id !== runId) { this.other.add(runId); } continue; }
      const live = state.status === 'running' || state.status === 'waiting';
      // The newest run that is going on is the one shown; a finished one stays until another starts.
      if (!this.tracked || this.tracked.id === runId || (live && (!this.tracked.live || state.startedAt >= this.tracked.startedAt))) {
        this.tracked = { id: runId, startedAt: state.startedAt, live };
      }
    }
    await this.render();
  }

  private async render(): Promise<void> {
    if (!this.tracked) { return; }
    const store = await this.runs.runs();
    const runId = this.tracked.id;
    const state = await store.load(runId).catch(() => undefined);
    const saved = await store.loadWorkflow(runId).catch(() => undefined);
    const log = await store.readLog(runId).catch(() => [] as RunLogEntry[]);
    if (this.disposed || !state || !saved) { return; }
    const message = runStateMessage(state, log, saved, this.document.getText());
    const status = (message.run as { status: string }).status;
    this.tracked.live = status === 'running' || status === 'waiting';
    const text = JSON.stringify(message);
    if (text === this.posted) { return; }
    this.posted = text;
    this.post(message);
  }
}

export class WorkflowEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly steps = studioSteps();

  constructor(private readonly extensionUri: vscode.Uri, private readonly runs?: StudioRuns) {}

  static register(context: vscode.ExtensionContext, runs?: StudioRuns): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(WORKFLOW_EDITOR, new WorkflowEditorProvider(context.extensionUri, runs),
      { webviewOptions: { retainContextWhenHidden: true } });
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const resources = vscode.Uri.joinPath(this.extensionUri, 'resources');
    panel.webview.options = { enableScripts: true, localResourceRoots: [resources] };
    panel.webview.html = workflowEditorHtml(
      panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'studioEditor.js')).toString(),
      panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'studioEditor.css')).toString(),
      panel.webview.cspSource);
    // The runs of this file's workflow, drawn on the diagram while they go on; it lives as long as the panel.
    const live = this.runs ? new LiveRun(this.runs, document, message => { void panel.webview.postMessage(message); }) : undefined;
    const send = () => { void panel.webview.postMessage(editorState(document.getText(), this.steps)); live?.again(); };
    // Edits apply one after another, each to the text the one before left: two quick edits must
    // not both start from the same text and undo each other.
    let queue: Promise<void> = Promise.resolve();
    const changes = vscode.workspace.onDidChangeTextDocument(event => { if (event.document.uri.toString() === document.uri.toString()) { send(); } });
    panel.onDidDispose(() => { changes.dispose(); live?.dispose(); });
    panel.webview.onDidReceiveMessage(async (message: { type?: string; operation?: EditOperation; run?: string }) => {
      switch (message.type) {
        case 'ready': send(); live?.resend(); return;
        case 'stopRun':
          // Only the run the diagram shows can be stopped from it.
          if (this.runs && live && message.run && message.run === live.runId && !this.runs.stop(message.run)) {
            void panel.webview.postMessage({ type: 'editFailed', message: 'That run is not running in this window, so it cannot be stopped from here.' });
          }
          return;
        case 'openRuns': await vscode.commands.executeCommand('repositoryManager.studio.runs.focus'); return;
        case 'edit': queue = queue.then(() => this.edit(document, panel, message.operation)); await queue; return;
        case 'openAsJson': await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); return;
        case 'run':
          // Run reads the file from disk: an edit that was not saved must not run the older one.
          if (document.isDirty && !await document.save()) {
            void panel.webview.postMessage({ type: 'editFailed', message: 'The workflow was not saved, so it was not run. Save it, then Run.' });
            return;
          }
          await vscode.commands.executeCommand('repositoryManager.studio.runWorkflow', document.uri);
          return;
      }
    });
  }

  private async edit(document: vscode.TextDocument, panel: vscode.WebviewPanel, operation: EditOperation | undefined): Promise<void> {
    if (!operation) { return; }
    try {
      const current = JSON.parse(document.getText()) as Workflow;
      const next = serializeWorkflow(applyEdit(current, operation, type => this.steps.get(type)?.required ?? []));
      if (next === document.getText()) { return; }
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), next);
      await vscode.workspace.applyEdit(edit);
    } catch (error) {
      void panel.webview.postMessage({ type: 'editFailed', message: error instanceof EditError || error instanceof SyntaxError ? error.message : String(error) });
    }
  }
}

function workflowEditorHtml(script: string, style: string, cspSource: string): string {
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}';">
  <title>Workflow</title>
  <link rel="stylesheet" href="${style}">
</head>
<body>
  <header class="bar">
    <div class="heading"><h1 id="title">Opening…</h1><p id="subtitle"></p></div>
    <div class="actions">
      <button type="button" id="arrange" title="Lay the nodes out again by their order">Arrange</button>
      <button type="button" id="json" title="Open this file in the text editor">Open as JSON</button>
      <button type="button" id="run" class="primary" title="Run this workflow (Run Workflow…)">Run</button>
    </div>
  </header>
  <div id="notice" role="alert" hidden></div>
  <div id="run-banner" class="run-banner" hidden></div>
  <div id="run-status" class="sr-only" role="status"></div>
  <main class="layout">
    <aside class="palette" aria-label="Steps">
      <h2>Add a step</h2>
      <div id="palette"></div>
      <h2>Problems <span id="problem-count"></span></h2>
      <ul id="problems"></ul>
    </aside>
    <section class="canvas-wrap" aria-label="Diagram">
      <svg id="canvas" role="group" aria-label="Workflow diagram"><g id="edges"></g><g id="nodes"></g></svg>
    </section>
    <aside class="panel" id="panel" aria-label="Details"></aside>
  </main>
  <script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
}
