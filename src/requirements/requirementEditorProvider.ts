/**
 * The Requirement editor: a custom editor for clarification ("dou") Markdown files. Its page
 * (resources/requirements.js) shows a file as a form, the requirements its items clarify, and the
 * Markdown; this provider answers the page's requests with DouService, the extension's port of the
 * Python dou-editor's local server.
 *
 * VS Code owns the editor's lifecycle, so its unsaved dot, Ctrl+S, the question on close and hot
 * exit work as for any file: the page reports when it has unsaved edits, and VS Code's save asks
 * the page for its text, which DouService writes only if the file is still the version the page
 * loaded. Opening a Markdown file here is a choice (Open With…), so other Markdown stays as text.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { getRequirementEditorHtml } from '../webview/template';
import { DouRequestError, DouService, digest, messageOf } from './douService';
import { RequirementSource } from './requirementCatalog';

export const REQUIREMENT_EDITOR_VIEW_TYPE = 'repositoryManager.requirementEditor';
const MEMORY_KEY = 'repositoryManager.requirementEditor.memory';
/** How long a save or a backup waits for the page to send its text. */
const CONTENT_TIMEOUT_MS = 10_000;

type PageMessage = { type: string; id?: number; method?: string; path?: string; body?: Record<string, unknown>; [key: string]: unknown };

class RequirementDocument implements vscode.CustomDocument {
  /** The page showing this file, once it loaded. */
  page?: { panel: vscode.WebviewPanel; ready: boolean };
  /** Text VS Code kept from an earlier window (hot exit), shown over the file when the page opens. */
  draft?: string;
  /** The version of the file that text was edited from, so a file changed since is not overwritten. */
  draftHash?: string;
  /** The version of the file the page shows, so changes on disk by someone else are noticed. */
  hash?: string;
  readonly contentRequests = new Map<number, (reply: { content: string | null; hash: string | null }) => void>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(readonly uri: vscode.Uri, readonly service: DouService) {}

  track(disposable: vscode.Disposable): void { this.disposables.push(disposable); }

  dispose(): void { this.disposables.forEach(d => d.dispose()); }
}

export class RequirementEditorProvider implements vscode.CustomEditorProvider<RequirementDocument> {
  private readonly changes = new vscode.EventEmitter<vscode.CustomDocumentContentChangeEvent<RequirementDocument>>();
  readonly onDidChangeCustomDocument = this.changes.event;
  /** One requirements source per repository (its `.dou-editor.json`), shared by its files. */
  private readonly sources = new Map<string, RequirementSource>();
  private nextRequest = 0;

  constructor(private readonly extensionUri: vscode.Uri, private readonly storageUri: vscode.Uri, private readonly memory: vscode.Memento) {}

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    const provider = new RequirementEditorProvider(context.extensionUri, context.globalStorageUri, context.globalState);
    return vscode.window.registerCustomEditorProvider(REQUIREMENT_EDITOR_VIEW_TYPE, provider, {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    });
  }

  async openCustomDocument(uri: vscode.Uri, context: vscode.CustomDocumentOpenContext): Promise<RequirementDocument> {
    if (uri.scheme !== 'file') { throw new Error('The Requirement editor opens files on this computer only.'); }
    const cache = path.join(this.storageUri.fsPath, 'requirements');
    const service = new DouService(uri.fsPath, await DouService.sourceFor(uri.fsPath, cache, this.sources));
    const document = new RequirementDocument(uri, service);
    if (context.backupId) {
      const backup = await fs.readFile(vscode.Uri.parse(context.backupId).fsPath, 'utf8').then(JSON.parse).catch(() => undefined);
      if (backup && typeof backup.content === 'string') {
        document.draft = backup.content;
        document.draftHash = typeof backup.hash === 'string' ? backup.hash : undefined;
      }
    }
    // Someone else changed the file: a page without unsaved edits reloads, one with edits warns.
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(path.dirname(uri.fsPath)), path.basename(uri.fsPath)));
    const changed = async () => {
      const hash = await fs.readFile(uri.fsPath).then(digest, () => undefined);
      if (hash && document.hash && hash !== document.hash) { this.post(document, { type: 'changedOnDisk' }); }
    };
    watcher.onDidChange(changed);
    watcher.onDidCreate(changed);
    document.track(watcher);
    return document;
  }

  async resolveCustomEditor(document: RequirementDocument, panel: vscode.WebviewPanel): Promise<void> {
    const resources = vscode.Uri.joinPath(this.extensionUri, 'resources');
    panel.webview.options = { enableScripts: true, localResourceRoots: [resources] };
    panel.webview.html = getRequirementEditorHtml({
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'requirements.js')),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(resources, 'requirements.css')),
      cspSource: panel.webview.cspSource
    });
    document.page = { panel, ready: false };
    panel.webview.onDidReceiveMessage((message: PageMessage) => { void this.receive(document, message); });
    panel.onDidDispose(() => {
      if (document.page?.panel === panel) { document.page = undefined; }
    });
  }

  private post(document: RequirementDocument, message: Record<string, unknown>): void {
    void document.page?.panel.webview.postMessage(message);
  }

  private async receive(document: RequirementDocument, message: PageMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        if (document.page) { document.page.ready = true; }
        this.post(document, { type: 'init', memory: this.memory.get(MEMORY_KEY, {}), draft: document.draft, draftHash: document.draftHash });
        document.draft = document.draftHash = undefined;
        return;
      case 'request':
        return this.answer(document, message);
      case 'dirty':
        if (message.dirty) { this.changes.fire({ document }); }
        return;
      case 'content': {
        const reply = document.contentRequests.get(Number(message.id));
        document.contentRequests.delete(Number(message.id));
        reply?.({ content: typeof message.content === 'string' ? message.content : null, hash: typeof message.hash === 'string' ? message.hash : null });
        return;
      }
      case 'remember':
        if (typeof message.key === 'string' && typeof message.value === 'string') {
          await this.memory.update(MEMORY_KEY, { ...this.memory.get<Record<string, string>>(MEMORY_KEY, {}), [message.key]: message.value });
        }
        return;
      case 'reload':
        return this.reload(document);
      case 'download':
        return this.download(document, message.content, message.filename);
      case 'openLocation':
        return this.openLocation(document, message.file, message.line);
    }
  }

  /** The page's requests, by the paths the Python server answered. */
  private async answer(document: RequirementDocument, message: PageMessage): Promise<void> {
    const service = document.service;
    const route = `${message.method} ${String(message.path).split('?')[0]}`;
    const body = message.body || {};
    try {
      let data: unknown;
      switch (route) {
        case 'GET /api/document': {
          const loaded = await service.document();
          document.hash = loaded.hash;
          data = loaded;
          break;
        }
        case 'GET /api/index': data = await service.index(); break;
        case 'GET /api/asset': data = await service.asset(new URLSearchParams(String(message.path).split('?')[1] || '').get('path') || ''); break;
        case 'GET /api/requirements': data = await service.requirements(); break;
        case 'POST /api/requirements/source': data = await service.setSource(body); break;
        case 'POST /api/requirements/sync': data = await service.syncSource(); break;
        case 'POST /api/parse': data = service.parse(body.content); break;
        case 'POST /api/save': data = await this.saveFromPage(document); break;
        default: throw new DouRequestError('Not found', 404);
      }
      this.post(document, { type: 'response', id: message.id, ok: true, data });
    } catch (error) {
      this.post(document, { type: 'response', id: message.id, ok: false, error: messageOf(error) });
    }
  }

  /** The page's Save button and Submit: VS Code's own save, so its unsaved state follows. */
  private async saveFromPage(document: RequirementDocument): Promise<Record<string, never>> {
    const panel = document.page?.panel;
    if (panel && !panel.active) { panel.reveal(undefined, false); }
    await vscode.commands.executeCommand('workbench.action.files.save');
    return {};
  }

  /** The page's text and the version of the file it edited, asked for when saving or backing up. */
  private requestContent(document: RequirementDocument): Promise<{ content: string; hash: string }> {
    if (!document.page?.ready) { return Promise.reject(new Error('The Requirement editor is not open.')); }
    const id = ++this.nextRequest;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        document.contentRequests.delete(id);
        reject(new Error('The Requirement editor did not answer.'));
      }, CONTENT_TIMEOUT_MS);
      document.contentRequests.set(id, reply => {
        clearTimeout(timer);
        if (reply.content === null || reply.hash === null) { reject(new Error('The file did not load, so there is nothing to save.')); } else { resolve({ content: reply.content, hash: reply.hash }); }
      });
      this.post(document, { type: 'getContent', id });
    });
  }

  async saveCustomDocument(document: RequirementDocument): Promise<void> {
    try {
      const { content, hash } = await this.requestContent(document);
      document.hash = (await document.service.save(content, hash)).hash;
      this.post(document, { type: 'saved' });
    } catch (error) {
      // The page keeps its edits and says why; VS Code keeps the editor unsaved and says so too.
      this.post(document, { type: 'saveFailed', error: messageOf(error) });
      throw new Error(messageOf(error));
    }
  }

  async saveCustomDocumentAs(document: RequirementDocument, destination: vscode.Uri): Promise<void> {
    const { content } = await this.requestContent(document);
    document.service.parse(content);
    await fs.writeFile(destination.fsPath, content, 'utf8');
  }

  async revertCustomDocument(document: RequirementDocument): Promise<void> {
    this.post(document, { type: 'revert' });
  }

  async backupCustomDocument(document: RequirementDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    // The text and the version of the file it was edited from.
    const { content, hash } = await this.requestContent(document);
    await fs.mkdir(path.dirname(context.destination.fsPath), { recursive: true });
    await fs.writeFile(context.destination.fsPath, JSON.stringify({ hash, content }), 'utf8');
    return { id: context.destination.toString(), delete: () => { void fs.rm(context.destination.fsPath, { force: true }); } };
  }

  /** Reload with unsaved edits: ask here (the page cannot), then let VS Code revert the editor. */
  private async reload(document: RequirementDocument): Promise<void> {
    const discard = 'Discard and Reload';
    const choice = await vscode.window.showWarningMessage('Discard unsaved edits and reload the Markdown file?', { modal: true }, discard);
    if (choice !== discard) { return; }
    document.page?.panel.reveal(undefined, false);
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }

  /** "Download draft": the page's text, saved where the user chooses, beside the file by default. */
  private async download(document: RequirementDocument, content: unknown, filename: unknown): Promise<void> {
    if (typeof content !== 'string') { return; }
    const name = typeof filename === 'string' && filename ? path.basename(filename) : 'draft.md';
    // eslint-disable-next-line @typescript-eslint/naming-convention -- the filter's label
    const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(path.dirname(document.uri.fsPath), name)), filters: { Markdown: ['md'] } });
    if (!target) { return; }
    if (target.fsPath === document.uri.fsPath) {
      void vscode.window.showWarningMessage('Save the draft under another name: this is the file being edited.');
      return;
    }
    await fs.writeFile(target.fsPath, content, 'utf8');
    void vscode.window.showInformationMessage(`Draft saved to ${path.basename(target.fsPath)}.`);
  }

  /** A requirement's file:line from a folder source, opened in a text editor beside this one. */
  private async openLocation(document: RequirementDocument, file: unknown, line: unknown): Promise<void> {
    const target = typeof file === 'string' ? document.service.source.locate(file) : undefined;
    if (!target) { return; }
    const at = Math.max(0, Number(line) - 1 || 0);
    await vscode.window.showTextDocument(vscode.Uri.file(target), { viewColumn: vscode.ViewColumn.Beside, selection: new vscode.Range(at, 0, at, 0), preview: true });
  }
}
