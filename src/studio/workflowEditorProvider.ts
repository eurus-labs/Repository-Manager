/**
 * The Studio's visual editor for `*.workflow.json` (docs/agent-studio.md, "Visual editor"). The
 * file is a text document and stays the only source: the page draws it and sends edits, the
 * host applies them (workflowEdit.ts) and replaces the document's text, and any change to the
 * document, from here or from the JSON editor, draws the page again. Undo, Save and dirty state
 * are VS Code's own.
 */
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import { workflowEffects } from './engine';
import { StepDefinition, stepRegistry } from './steps';
import { validateWorkflow, Workflow } from './workflow';
import { applyEdit, EditError, EditOperation, positions, problemNodes, serializeWorkflow, settingText } from './workflowEdit';

export const WORKFLOW_EDITOR = 'repositoryManager.workflowEditor';

const EFFECT_ASKS: Record<string, string> = { write: 'writes files', command: 'runs a command', external: 'sends to another system' };

/** What the page draws: the workflow, where each node sits, its problems, and the steps it can add. */
export function editorState(text: string, steps: Map<string, StepDefinition>): Record<string, unknown> {
  const catalog = [...steps.values()].map(step => ({
    type: step.type, title: step.title, effect: step.effect, usesModel: Boolean(step.usesModel),
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
  const problems = validateWorkflow(workflow, steps).map(problem => ({ ...problem, nodes: problemNodes(workflow, problem.where) }));
  // Settings as the form shows them: text as is, anything else as JSON.
  const settings = Object.fromEntries(workflow.nodes.filter(node => node && typeof node.id === 'string')
    .map(node => [node.id, Object.fromEntries(Object.entries(node.with ?? {}).map(([key, setting]) => [key, settingText(setting)]))]));
  return {
    type: 'load', editable: true, workflow, settings, problems, catalog,
    positions: positions(workflow),
    effects: problems.length ? undefined : workflowEffects(workflow, steps)
  };
}

export class WorkflowEditorProvider implements vscode.CustomTextEditorProvider {
  private readonly steps = stepRegistry();

  constructor(private readonly extensionUri: vscode.Uri) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(WORKFLOW_EDITOR, new WorkflowEditorProvider(context.extensionUri),
      { webviewOptions: { retainContextWhenHidden: true } });
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    const resources = vscode.Uri.joinPath(this.extensionUri, 'resources');
    panel.webview.options = { enableScripts: true, localResourceRoots: [resources] };
    panel.webview.html = workflowEditorHtml(
      panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'studioEditor.js')).toString(),
      panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'studioEditor.css')).toString(),
      panel.webview.cspSource);
    const send = () => { void panel.webview.postMessage(editorState(document.getText(), this.steps)); };
    const changes = vscode.workspace.onDidChangeTextDocument(event => { if (event.document.uri.toString() === document.uri.toString()) { send(); } });
    panel.onDidDispose(() => changes.dispose());
    panel.webview.onDidReceiveMessage(async (message: { type?: string; operation?: EditOperation }) => {
      switch (message.type) {
        case 'ready': send(); return;
        case 'edit': await this.edit(document, panel, message.operation); return;
        case 'openAsJson': await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); return;
        case 'run':
          if (document.isDirty) { await document.save(); }
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
