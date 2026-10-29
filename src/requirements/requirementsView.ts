/**
 * Requirements in the Repository Manager Side Bar: the clarification ("dou") files of the
 * workspace, each with how many of its items are still open. A click opens the file in the
 * Requirement editor; New Clarification File starts one from the v3 template.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DouError, nowIso, parse } from './douDocument';
import { decodeUtf8 } from './requirementCatalog';
import { REQUIREMENT_EDITOR_VIEW_TYPE, RequirementEditorProvider } from './requirementEditorProvider';

export const REQUIREMENTS_VIEW_ID = 'repositoryManager.requirements';
const MAX_SCANNED = 5000;
const MAX_BYTES = 2_000_000;
// Front matter that names a schema version is how a clarification file is told from other Markdown.
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const SCHEMA_VERSION = /(?<![^\n])schema_version: [123][ \t]*\r?(?=\n|$)/;
const UNRESOLVED = new Set(['open', 'investigating', 'proposed']);

export interface ClarificationFile {
  uri: vscode.Uri;
  /** The artifact ID, or the file name when the file does not parse. */
  id: string;
  title: string;
  version?: number;
  items: number;
  unresolved: number;
  /** Why the file does not parse; it then opens as text, where it can be fixed. */
  error?: string;
}

/** A clarification file's summary, or undefined for other Markdown. */
export async function readClarification(uri: vscode.Uri): Promise<ClarificationFile | undefined> {
  let content: string;
  try {
    const stat = await fs.stat(uri.fsPath);
    if (!stat.isFile() || stat.size > MAX_BYTES) { return undefined; }
    content = decodeUtf8(await fs.readFile(uri.fsPath));
  } catch {
    return undefined;
  }
  const meta = FRONT_MATTER.exec(content);
  if (!meta || !SCHEMA_VERSION.test(meta[1])) { return undefined; }
  const title = /(?<![^\n])title:[ \t]*([^\r\n]*)/.exec(meta[1])?.[1].trim().replace(/^["']|["']$/g, '') || '';
  try {
    const parsed = parse(content);
    return {
      uri, id: parsed.id, title, version: parsed.version, items: parsed.items.length,
      unresolved: parsed.items.filter(item => UNRESOLVED.has(item.values.Status)).length
    };
  } catch (error) {
    return { uri, id: path.basename(uri.fsPath), title, items: 0, unresolved: 0, error: error instanceof DouError || error instanceof Error ? error.message : String(error) };
  }
}

export class RequirementsTreeProvider implements vscode.TreeDataProvider<ClarificationFile> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  private timer?: ReturnType<typeof setTimeout>;

  refresh(): void {
    // Saves often come in bursts (an editor, Git, an agent): redraw once they settle.
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { this.timer = undefined; this.changed.fire(); }, 300);
  }

  async getChildren(element?: ClarificationFile): Promise<ClarificationFile[]> {
    if (element) { return []; }
    const uris = await vscode.workspace.findFiles('**/*.md', '{**/node_modules/**,**/.git/**}', MAX_SCANNED);
    const files = (await Promise.all(uris.map(readClarification))).filter((file): file is ClarificationFile => Boolean(file));
    return files.sort((a, b) => vscode.workspace.asRelativePath(a.uri).localeCompare(vscode.workspace.asRelativePath(b.uri), undefined, { numeric: true }));
  }

  getTreeItem(file: ClarificationFile): vscode.TreeItem {
    const item = new vscode.TreeItem(file.title ? `${file.id} · ${file.title}` : file.id, vscode.TreeItemCollapsibleState.None);
    const folder = path.dirname(vscode.workspace.asRelativePath(file.uri));
    const where = folder === '.' ? path.basename(file.uri.fsPath) : `${folder}/${path.basename(file.uri.fsPath)}`;
    item.resourceUri = file.uri;
    item.contextValue = 'clarificationFile';
    if (file.error) {
      item.description = 'does not validate';
      item.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      item.tooltip = new vscode.MarkdownString().appendText(`${where}\n\n${file.error}\n\nOpens as Markdown text, to fix it.`);
      item.command = { command: 'vscode.open', title: 'Open', arguments: [file.uri] };
      return item;
    }
    const counts = file.unresolved ? `${file.unresolved} of ${file.items} open` : `${file.items} item${file.items === 1 ? '' : 's'} resolved`;
    item.description = `${counts} · ${folder === '.' ? '' : folder + ' · '}v${file.version}`;
    item.iconPath = new vscode.ThemeIcon(file.unresolved ? 'issue-draft' : 'pass', file.unresolved ? undefined : new vscode.ThemeColor('testing.iconPassed'));
    item.tooltip = new vscode.MarkdownString().appendText(`${where}\nSchema v${file.version} · ${counts}`);
    item.command = { command: 'vscode.openWith', title: 'Open in Requirement Editor', arguments: [file.uri, REQUIREMENT_EDITOR_VIEW_TYPE] };
    return item;
  }
}

/** A new clarification file from the v3 template, in a folder the user picks, opened in the editor. */
async function newClarificationFile(extensionUri: vscode.Uri, tree: RequirementsTreeProvider, from?: ClarificationFile): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  let folder: vscode.Uri | undefined = from ? vscode.Uri.file(path.dirname(from.uri.fsPath)) : undefined;
  if (!folder) {
    const known = [...new Set((await tree.getChildren()).map(file => path.dirname(file.uri.fsPath)))];
    const suggested = workspace ? path.join(workspace.uri.fsPath, 'docs', 'clarifications') : undefined;
    const choices: Array<vscode.QuickPickItem & { folder?: string }> = [...known, ...(suggested && !known.includes(suggested) ? [suggested] : [])]
      .map(f => ({ label: vscode.workspace.asRelativePath(f), folder: f }));
    choices.push({ label: 'Choose a folder…' });
    const picked = await vscode.window.showQuickPick(choices, { title: 'New Clarification File', placeHolder: 'Folder for the new file' });
    if (!picked) { return; }
    if (picked.folder) {
      folder = vscode.Uri.file(picked.folder);
    } else {
      folder = (await vscode.window.showOpenDialog({ canSelectFiles: false, canSelectFolders: true, canSelectMany: false, defaultUri: workspace?.uri, openLabel: 'Use Folder' }))?.[0];
      if (!folder) { return; }
    }
  }
  const target = folder;
  const id = await vscode.window.showInputBox({
    title: 'New Clarification File', prompt: 'Artifact ID: capital letters, digits and "-", kept for good (item IDs start with it)', placeHolder: 'CLR-004',
    validateInput: async value => {
      if (!/^[A-Z][A-Z0-9-]*$/.test(value)) { return 'Use capital letters, digits and "-", starting with a letter, e.g. CLR-004.'; }
      return await fs.stat(path.join(target.fsPath, `${value}.md`)).then(() => `${value}.md already exists here.`, () => undefined);
    }
  });
  if (!id) { return; }
  const title = await vscode.window.showInputBox({ title: 'New Clarification File', prompt: 'Short topic of this clarification', placeHolder: 'Message delivery retries' });
  if (title === undefined) { return; }
  const template = await fs.readFile(vscode.Uri.joinPath(extensionUri, 'resources', 'requirements', 'template-v3.md').fsPath, 'utf8');
  const now = nowIso();
  const content = template
    .replace(/CLR-NEW/g, id)
    .replace(/^title: .*$/m, `title: ${title.replace(/[\r\n]+/g, ' ').trim() || id}`)
    .replace(/2026-10-27T09:00:00\+07:00/g, now);
  parse(content);
  const file = vscode.Uri.file(path.join(target.fsPath, `${id}.md`));
  await fs.mkdir(target.fsPath, { recursive: true });
  await fs.writeFile(file.fsPath, content, { encoding: 'utf8', flag: 'wx' });
  tree.refresh();
  await vscode.commands.executeCommand('vscode.openWith', file, REQUIREMENT_EDITOR_VIEW_TYPE);
}

/** The Requirement editor, the Requirements view and their commands. */
export function registerRequirements(context: vscode.ExtensionContext): void {
  const tree = new RequirementsTreeProvider();
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');
  watcher.onDidChange(() => tree.refresh());
  watcher.onDidCreate(() => tree.refresh());
  watcher.onDidDelete(() => tree.refresh());
  context.subscriptions.push(
    RequirementEditorProvider.register(context),
    vscode.window.registerTreeDataProvider(REQUIREMENTS_VIEW_ID, tree),
    watcher,
    vscode.commands.registerCommand('repositoryManager.requirements.refresh', () => tree.refresh()),
    vscode.commands.registerCommand('repositoryManager.requirements.newFile', async (from?: ClarificationFile) => {
      try {
        await newClarificationFile(context.extensionUri, tree, from);
      } catch (error) {
        void vscode.window.showErrorMessage(`New clarification file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('repositoryManager.requirements.openAsText', (file?: ClarificationFile) => {
      if (file?.uri) { return vscode.commands.executeCommand('vscode.openWith', file.uri, 'default'); }
      return undefined;
    })
  );
}
