/**
 * The Requirements area of the Activity Bar, beside Repository Manager: one place to choose what
 * the Requirement editor shows.
 *
 * - Clarifications: the workspace's clarification ("dou") files, each opening to its items. A
 *   file open in the editor lists its items as they are in the editor, unsaved ones included.
 * - Requirements: the requirements the current file's items clarify, with whether each is Ready.
 *   The editor works out readiness (it needs the unsaved items and the requirement text), so this
 *   view follows the file last shown in a Requirement editor.
 *
 * A click opens the file and shows that item or requirement; the editor's own choice (a chip, a
 * Next action) is shown back here.
 */
import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { DouError, nowIso, parse } from './douDocument';
import { decodeUtf8 } from './requirementCatalog';
import { OutlineRequirement, PageOutline, REQUIREMENT_EDITOR_VIEW_TYPE, RequirementEditorProvider } from './requirementEditorProvider';

export const REQUIREMENTS_VIEW_ID = 'repositoryManager.requirements';
export const REQUIREMENTS_CATALOG_VIEW_ID = 'repositoryManager.requirementsCatalog';
const CONTAINER_COMMAND = 'workbench.view.extension.repository-manager-requirements';
const MAX_SCANNED = 5000;
const MAX_BYTES = 2_000_000;
// Front matter that names a schema version is how a clarification file is told from other Markdown.
const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;
const SCHEMA_VERSION = /(?<![^\n])schema_version: [123][ \t]*\r?(?=\n|$)/;
const UNRESOLVED = new Set(['open', 'investigating', 'proposed']);
const PLACEHOLDER = /^(-\s*)?(pending|tbd)?$/i;

/** An item as the side bar lists it: from the editor while the file is open, else from the file. */
export interface ClarificationItem { id: string; status: string; summary: string; unsaved?: boolean; new?: boolean }

export interface ClarificationFile {
  uri: vscode.Uri;
  /** The artifact ID, or the file name when the file does not parse. */
  id: string;
  title: string;
  version?: number;
  items: ClarificationItem[];
  /** Why the file does not parse; it then opens as text, where it can be fixed. */
  error?: string;
}

/** One line about an item: its desired outcome (v3), else its first question. */
function summaryOf(values: Record<string, string>, version: number): string {
  const outcome = values['Desired outcome'] || '';
  if (version === 3 && !PLACEHOLDER.test(outcome.trim())) { return outcome.split('\n')[0].trim(); }
  const questions = values.Questions ?? values.Question ?? '';
  const ticked = questions.split('\n').map(line => /^\s*[-*]\s*\[[ xX]\]\s*(.+)$/.exec(line)).find(Boolean);
  return (ticked ? ticked[1] : questions.split('\n')[0]).trim();
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
      uri, id: parsed.id, title, version: parsed.version,
      items: parsed.items.map(item => ({ id: item.id, status: item.values.Status, summary: summaryOf(item.values, parsed.version) }))
    };
  } catch (error) {
    return { uri, id: path.basename(uri.fsPath), title, items: [], error: error instanceof DouError || error instanceof Error ? error.message : String(error) };
  }
}

type FileNode = { kind: 'file'; file: ClarificationFile };
type ItemNode = { kind: 'item'; file: ClarificationFile; item: ClarificationItem };
export type ClarificationNode = FileNode | ItemNode;
type RequirementNode = { uri: vscode.Uri; requirement: OutlineRequirement };
/** A folder of the requirement documents (a project), holding requirements and folders. */
type RequirementFolderNode = { uri: vscode.Uri; folder: string; label: string; folders: RequirementFolderNode[]; requirements: RequirementNode[]; parent?: RequirementFolderNode };
type CatalogNode = RequirementNode | RequirementFolderNode;
const isFolder = (node: CatalogNode): node is RequirementFolderNode => 'folder' in node;

/**
 * The requirements as a tree of the folders their documents are in, one folder per project: the
 * folders every document shares are left out, and a folder with only one folder in it is joined
 * to it ("sw_reqs/boschkms_usage"). A requirement no document defines stays at the top.
 */
export function requirementTree(uri: vscode.Uri, requirements: OutlineRequirement[]): { top: CatalogNode[]; parents: Map<string, RequirementFolderNode> } {
  const dirs = requirements.map(r => (r.file || '').split('/').slice(0, -1).filter(Boolean));
  const located = dirs.filter((_, i) => requirements[i].file);
  let shared = located.length ? located[0].length : 0;
  for (const dir of located) {
    let n = 0;
    while (n < shared && n < dir.length && dir[n] === located[0][n]) { n++; }
    shared = n;
  }
  const root: RequirementFolderNode = { uri, folder: '', label: '', folders: [], requirements: [] };
  requirements.forEach((requirement, i) => {
    let at = root;
    if (requirement.file) {
      for (const name of dirs[i].slice(shared)) {
        let next = at.folders.find(f => f.label === name);
        if (!next) {
          next = { uri, folder: at.folder ? `${at.folder}/${name}` : name, label: name, folders: [], requirements: [] };
          at.folders.push(next);
        }
        at = next;
      }
    }
    at.requirements.push({ uri, requirement });
  });
  const parents = new Map<string, RequirementFolderNode>();
  const join = (folder: RequirementFolderNode, parent?: RequirementFolderNode): RequirementFolderNode => {
    while (folder.folders.length === 1 && !folder.requirements.length) {
      const only = folder.folders[0];
      folder = { ...only, label: `${folder.label}/${only.label}` };
    }
    folder.parent = parent;
    folder.folders = folder.folders.map(child => join(child, folder));
    folder.folders.sort((a, b) => a.label.localeCompare(b.label));
    for (const node of folder.requirements) { parents.set(node.requirement.id, folder); }
    return folder;
  };
  root.folders = root.folders.map(child => join(child));
  root.folders.sort((a, b) => a.label.localeCompare(b.label));
  return { top: [...root.folders, ...root.requirements], parents };
}

const STATUS_COLORS: Record<string, string> = { open: 'charts.blue', investigating: 'charts.yellow', proposed: 'charts.yellow', resolved: 'charts.green', agreed: 'charts.green' };
const shortId = (file: ClarificationFile, id: string) => (id.startsWith(file.id + '-') ? id.slice(file.id.length + 1) : id);

export class ClarificationsTreeProvider implements vscode.TreeDataProvider<ClarificationNode> {
  private readonly changed = new vscode.EventEmitter<ClarificationNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private timer?: ReturnType<typeof setTimeout>;
  private scanned?: Promise<ClarificationFile[]>;
  private nodes = new Map<string, FileNode>();
  /** Status to show; 'all' shows every item. */
  filter = 'all';

  constructor(private readonly editors: RequirementEditorProvider) {
    // An open file's items follow the editor; only its own row needs redrawing, and again once
    // it closes, to go back to the saved items.
    let live = new Set<string>();
    editors.onDidChangeOutline(() => {
      const now = new Set([...this.nodes.keys()].filter(key => editors.outlineFor(this.nodes.get(key)!.file.uri)));
      for (const key of new Set([...live, ...now])) {
        const node = this.nodes.get(key);
        if (node) { this.changed.fire(node); }
      }
      live = now;
    });
  }

  /** Files changed on disk: scan again once a burst of saves settles (an editor, Git, an agent). */
  refresh(): void {
    if (this.timer) { clearTimeout(this.timer); }
    this.timer = setTimeout(() => { this.timer = undefined; this.scanned = undefined; this.changed.fire(undefined); }, 300);
  }

  /** Redraw with the current filter, without scanning again. */
  redraw(): void { this.changed.fire(undefined); }

  async files(): Promise<ClarificationFile[]> {
    this.scanned ??= (async () => {
      const uris = await vscode.workspace.findFiles('**/*.md', '{**/node_modules/**,**/.git/**}', MAX_SCANNED);
      const files = (await Promise.all(uris.map(readClarification))).filter((file): file is ClarificationFile => Boolean(file));
      return files.sort((a, b) => vscode.workspace.asRelativePath(a.uri).localeCompare(vscode.workspace.asRelativePath(b.uri), undefined, { numeric: true }));
    })();
    return this.scanned;
  }

  /** The items of a file: the editor's (with unsaved edits) while it is open, else the saved ones. */
  itemsOf(file: ClarificationFile): ClarificationItem[] {
    return this.editors.outlineFor(file.uri)?.items ?? file.items;
  }

  private shown(items: ClarificationItem[]): ClarificationItem[] {
    return this.filter === 'all' ? items : items.filter(item => item.status === this.filter);
  }

  async getChildren(element?: ClarificationNode): Promise<ClarificationNode[]> {
    if (!element) {
      const files = await this.files();
      this.nodes = new Map(files.map(file => [file.uri.toString(), this.nodes.get(file.uri.toString()) ?? { kind: 'file', file }]));
      for (const file of files) { (this.nodes.get(file.uri.toString()) as FileNode).file = file; }
      return [...this.nodes.values()].filter(node => this.filter === 'all' || this.shown(this.itemsOf(node.file)).length);
    }
    if (element.kind === 'item') { return []; }
    return this.shown(this.itemsOf(element.file)).map(item => ({ kind: 'item', file: element.file, item }));
  }

  getParent(element: ClarificationNode): ClarificationNode | undefined {
    return element.kind === 'item' ? this.nodes.get(element.file.uri.toString()) : undefined;
  }

  /** The node of an item, to reveal it; none while the filter hides it. */
  itemNode(uri: vscode.Uri, id: string): ItemNode | undefined {
    const node = this.nodes.get(uri.toString());
    const item = node && this.shown(this.itemsOf(node.file)).find(x => x.id === id);
    return node && item ? { kind: 'item', file: node.file, item } : undefined;
  }

  getTreeItem(node: ClarificationNode): vscode.TreeItem {
    const file = node.file;
    if (node.kind === 'item') {
      const { item } = node;
      const tree = new vscode.TreeItem(shortId(file, item.id), vscode.TreeItemCollapsibleState.None);
      tree.id = `${file.uri.toString()}#${item.id}`;
      tree.description = (item.new ? '● new · ' : item.unsaved ? '● ' : '') + item.summary;
      tree.iconPath = new vscode.ThemeIcon(item.unsaved ? 'circle-large-filled' : 'circle-filled', new vscode.ThemeColor(STATUS_COLORS[item.status] || 'descriptionForeground'));
      tree.tooltip = new vscode.MarkdownString().appendText(`${item.id} · ${item.status}${item.new ? ' · not saved yet' : item.unsaved ? ' · unsaved edits' : ''}\n\n${item.summary}`);
      tree.contextValue = 'clarificationItem';
      tree.command = { command: 'repositoryManager.requirements.reveal', title: 'Show', arguments: [file.uri, 'item', item.id] };
      return tree;
    }
    const outline = this.editors.outlineFor(file.uri);
    const folder = path.dirname(vscode.workspace.asRelativePath(file.uri));
    const where = folder === '.' ? path.basename(file.uri.fsPath) : `${folder}/${path.basename(file.uri.fsPath)}`;
    if (file.error && !outline) {
      const tree = new vscode.TreeItem(file.title ? `${file.id} · ${file.title}` : file.id, vscode.TreeItemCollapsibleState.None);
      tree.id = file.uri.toString();
      tree.resourceUri = file.uri;
      tree.contextValue = 'clarificationFileInvalid';
      tree.description = 'does not validate';
      tree.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'));
      tree.tooltip = new vscode.MarkdownString().appendText(`${where}\n\n${file.error}\n\nOpens as Markdown text, to fix it.`);
      tree.command = { command: 'vscode.open', title: 'Open', arguments: [file.uri] };
      return tree;
    }
    const items = this.itemsOf(file);
    const open = items.filter(item => UNRESOLVED.has(item.status)).length;
    const title = outline?.title || file.title;
    const tree = new vscode.TreeItem(title ? `${file.id} · ${title}` : file.id,
      outline ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
    tree.id = file.uri.toString();
    tree.resourceUri = file.uri;
    tree.contextValue = 'clarificationFile';
    tree.description = `${outline?.dirty ? '● ' : ''}${open ? `${open}/${items.length} open` : `${items.length} resolved`}${folder === '.' ? '' : ' · ' + folder}`;
    tree.iconPath = new vscode.ThemeIcon('checklist');
    tree.tooltip = new vscode.MarkdownString().appendText(`${where}\nSchema v${outline?.version ?? file.version} · ${open} of ${items.length} items open${outline?.dirty ? ' · unsaved edits' : ''}`);
    tree.command = { command: 'vscode.openWith', title: 'Open in Requirement Editor', arguments: [file.uri, REQUIREMENT_EDITOR_VIEW_TYPE] };
    return tree;
  }
}

const REQUIREMENT_FILTERS: Array<[string, string, (r: OutlineRequirement) => boolean]> = [
  ['all', 'All requirements', () => true],
  ['notready', 'Not ready', r => !r.ready],
  ['ready', 'Ready', r => r.ready],
  ['empty', 'Without a clarification', r => r.empty],
  ['unresolved', 'With unresolved clarifications', r => r.unresolved],
  ['missing', 'Not found in the source', r => r.missing],
];

/** The requirements of the file last shown in a Requirement editor. */
export class RequirementsCatalogProvider implements vscode.TreeDataProvider<CatalogNode> {
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;
  filter = 'all';
  private tree: ReturnType<typeof requirementTree> | undefined;

  constructor(private readonly editors: RequirementEditorProvider) {
    editors.onDidChangeOutline(() => this.redraw());
  }

  redraw(): void { this.tree = undefined; this.changed.fire(); }

  get outline(): { uri: vscode.Uri; outline: PageOutline } | undefined {
    const current = this.editors.currentDocument;
    return current?.outline ? { uri: current.uri, outline: current.outline } : undefined;
  }

  /** The tree for the current file and filter, built once per change. */
  private current(): ReturnType<typeof requirementTree> | undefined {
    const current = this.outline;
    if (!current) { return undefined; }
    if (!this.tree) {
      const keep = REQUIREMENT_FILTERS.find(([key]) => key === this.filter)?.[2] ?? (() => true);
      this.tree = requirementTree(current.uri, current.outline.requirements.filter(keep));
    }
    return this.tree;
  }

  getChildren(element?: CatalogNode): CatalogNode[] {
    if (!element) { return this.current()?.top ?? []; }
    return isFolder(element) ? [...element.folders, ...element.requirements] : [];
  }

  getParent(element: CatalogNode): CatalogNode | undefined {
    return isFolder(element) ? element.parent : this.current()?.parents.get(element.requirement.id);
  }

  /** The node of a requirement shown now (not hidden by the filter), to reveal it. */
  nodeFor(id: string): RequirementNode | undefined {
    const tree = this.current();
    if (!tree) { return undefined; }
    const folder = tree.parents.get(id);
    return (folder ? folder.requirements : tree.top.filter((n): n is RequirementNode => !isFolder(n))).find(n => n.requirement.id === id);
  }

  getTreeItem(node: CatalogNode): vscode.TreeItem {
    if (isFolder(node)) {
      const tree = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      tree.id = `${node.uri.toString()}#folder:${node.folder}`;
      const all = (f: RequirementFolderNode): OutlineRequirement[] => [...f.requirements.map(n => n.requirement), ...f.folders.flatMap(all)];
      const list = all(node);
      tree.description = `${list.filter(r => r.ready).length}/${list.length} Ready`;
      tree.tooltip = node.folder;
      tree.iconPath = new vscode.ThemeIcon('folder');
      return tree;
    }
    const { uri, requirement: r } = node;
    // The ID only: titles are long; the tooltip and the editor show them.
    const tree = new vscode.TreeItem(r.id, vscode.TreeItemCollapsibleState.None);
    tree.id = `${uri.toString()}#req:${r.id}`;
    tree.description = r.ready ? 'Ready' : r.missing ? 'not found' : r.empty ? 'No clarification' : `${r.met}/${r.rules}`;
    tree.iconPath = r.ready ? new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green'))
      : r.missing ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
      : r.empty ? new vscode.ThemeIcon('circle-large-outline')
      : new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.yellow'));
    tree.tooltip = new vscode.MarkdownString().appendText(`${r.id}${r.title ? ' · ' + r.title : ''}${r.file ? `\n${r.file}` : ''}\n${r.ready ? 'Ready' : `Not ready: ${r.met} of ${r.rules} conditions met`} · ${r.clarifications} clarification${r.clarifications === 1 ? '' : 's'}${r.next ? `\nNext: ${r.next}` : ''}`);
    tree.command = { command: 'repositoryManager.requirements.reveal', title: 'Show', arguments: [uri, 'req', r.id] };
    return tree;
  }

  /** One line above the list: what there is, and where it comes from. */
  message(): string | undefined {
    const current = this.outline?.outline;
    if (!current) { return undefined; }
    const list = current.requirements;
    if (!current.source.configured) {
      return current.source.syncing ? 'Fetching requirements…' : 'No requirements source yet: use ⚙ Change source to read titles, text and Ready.';
    }
    const ready = list.filter(r => r.ready).length, empty = list.filter(r => r.empty).length;
    return `${list.length} requirement${list.length === 1 ? '' : 's'} · ${ready} ready · ${empty} without a clarification · from ${current.source.root}`
      + (current.source.error ? ` · ${current.source.error}` : '') + (current.skipped ? ` · ${current.skipped} file(s) skipped` : '');
  }
}

/** Run an action on an editor's page once it is ready (it may have just been opened). */
async function whenReady(run: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (run()) { return true; }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return false;
}

/** A new clarification file from the v3 template, in a folder the user picks, opened in the editor. */
async function newClarificationFile(extensionUri: vscode.Uri, tree: ClarificationsTreeProvider, from?: ClarificationNode): Promise<void> {
  const workspace = vscode.workspace.workspaceFolders?.[0];
  let folder: vscode.Uri | undefined = from ? vscode.Uri.file(path.dirname(from.file.uri.fsPath)) : undefined;
  if (!folder) {
    const known = [...new Set((await tree.files()).map(file => path.dirname(file.uri.fsPath)))];
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

/** The Requirement editor, the Requirements area of the Activity Bar, and their commands. */
export function registerRequirements(context: vscode.ExtensionContext): void {
  const editors = RequirementEditorProvider.register(context);
  const clarifications = new ClarificationsTreeProvider(editors);
  const requirements = new RequirementsCatalogProvider(editors);
  const clarificationView = vscode.window.createTreeView(REQUIREMENTS_VIEW_ID, { treeDataProvider: clarifications, showCollapseAll: true });
  const requirementView = vscode.window.createTreeView(REQUIREMENTS_CATALOG_VIEW_ID, { treeDataProvider: requirements });
  const status = vscode.window.createStatusBarItem('repositoryManager.requirements.ready', vscode.StatusBarAlignment.Left, 50);
  status.name = 'Requirements';
  status.command = CONTAINER_COMMAND;
  const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');
  watcher.onDidChange(() => clarifications.refresh());
  watcher.onDidCreate(() => clarifications.refresh());
  watcher.onDidDelete(() => clarifications.refresh());

  // The filter in each view's description, the source line above the requirements, and the
  // status bar while a Requirement editor is the active tab.
  const describe = () => {
    const current = requirements.outline;
    clarificationView.description = clarifications.filter === 'all' ? undefined : `Status: ${clarifications.filter}`;
    const filter = REQUIREMENT_FILTERS.find(([key]) => key === requirements.filter)?.[1];
    requirementView.description = [current?.outline.id, requirements.filter === 'all' ? undefined : filter].filter(Boolean).join(' · ') || undefined;
    requirementView.message = requirements.message();
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
    const active = tab instanceof vscode.TabInputCustom && tab.viewType === REQUIREMENT_EDITOR_VIEW_TYPE && current && tab.uri.toString() === current.uri.toString();
    if (!active || !current) { status.hide(); return; }
    const list = current.outline.requirements;
    const unsaved = current.outline.unsavedFields;
    status.text = `$(checklist) ${list.filter(r => r.ready).length}/${list.length} Ready` + (unsaved ? ` · ${unsaved} unsaved` : '');
    status.tooltip = `${current.outline.id}: ${list.filter(r => r.ready).length} of ${list.length} requirements Ready${unsaved ? `, ${unsaved} unsaved field${unsaved === 1 ? '' : 's'}` : ''}. Click to show the Requirements side bar.`;
    status.show();
  };
  // What the editor shows is selected in the side bar too (without taking the focus). It counts
  // as shown only once revealed: a hidden view or a filter that hides it is tried again later.
  let shown = '';
  const follow = () => {
    const current = requirements.outline;
    const selected = current?.outline.selected;
    if (!current || !selected?.id) { return; }
    const key = `${current.uri.toString()}#${selected.kind}:${selected.id}`;
    if (key === shown) { return; }
    const reveal = <T>(view: vscode.TreeView<T>, node: T | undefined) => {
      if (!view.visible || !node) { return; }
      void Promise.resolve(view.reveal(node, { select: true, focus: false })).then(() => { shown = key; }, () => undefined);
    };
    if (selected.kind === 'item') {
      reveal(clarificationView, clarifications.itemNode(current.uri, selected.id));
    } else {
      reveal(requirementView, requirements.nodeFor(selected.id));
    }
  };
  editors.onDidChangeOutline(() => { describe(); follow(); });

  const pick = async <T extends string>(title: string, options: Array<[T, string]>, current: string): Promise<T | undefined> => {
    const chosen = await vscode.window.showQuickPick(options.map(([value, label]) => ({ label, value, description: value === current ? 'current' : undefined })), { title });
    return chosen?.value;
  };

  context.subscriptions.push(
    clarificationView, requirementView, status, watcher,
    clarificationView.onDidChangeVisibility(follow),
    requirementView.onDidChangeVisibility(follow),
    vscode.window.tabGroups.onDidChangeTabs(describe),
    vscode.commands.registerCommand('repositoryManager.requirements.refresh', () => clarifications.refresh()),
    vscode.commands.registerCommand('repositoryManager.requirements.reveal', async (uri: vscode.Uri | string, kind: 'item' | 'req', id: string) => {
      const target = typeof uri === 'string' ? vscode.Uri.parse(uri) : uri;
      await vscode.commands.executeCommand('vscode.openWith', target, REQUIREMENT_EDITOR_VIEW_TYPE);
      shown = `${target.toString()}#${kind}:${id}`;
      editors.select(target, { kind, id });
    }),
    vscode.commands.registerCommand('repositoryManager.requirements.filterClarifications', async () => {
      const statuses: Array<[string, string]> = [['all', 'All statuses'], ['open', 'Open'], ['investigating', 'Investigating'], ['resolved', 'Resolved'], ['proposed', 'Proposed (schema v1)'], ['agreed', 'Agreed (schema v1)']];
      const value = await pick('Show clarifications', statuses, clarifications.filter);
      if (value) { clarifications.filter = value; clarifications.redraw(); describe(); follow(); }
    }),
    vscode.commands.registerCommand('repositoryManager.requirements.filterRequirements', async () => {
      const value = await pick('Show requirements', REQUIREMENT_FILTERS.map(([key, label]) => [key, label] as [string, string]), requirements.filter);
      if (value) { requirements.filter = value; requirements.redraw(); describe(); follow(); }
    }),
    vscode.commands.registerCommand('repositoryManager.requirements.newItem', async (node?: ClarificationNode) => {
      const uri = node?.file.uri ?? editors.currentDocument?.uri;
      if (!uri) { void vscode.window.showInformationMessage('Open a clarification file first, or use New Clarification File.'); return; }
      await vscode.commands.executeCommand('vscode.openWith', uri, REQUIREMENT_EDITOR_VIEW_TYPE);
      await whenReady(() => editors.command('addItem', uri));
    }),
    vscode.commands.registerCommand('repositoryManager.requirements.changeSource', async () => {
      if (!editors.command('sourceDialog')) { void vscode.window.showInformationMessage('Open a clarification file first: the requirements source belongs to its repository.'); }
    }),
    vscode.commands.registerCommand('repositoryManager.requirements.newFile', async (from?: ClarificationNode) => {
      try {
        await newClarificationFile(context.extensionUri, clarifications, from);
      } catch (error) {
        void vscode.window.showErrorMessage(`New clarification file: ${error instanceof Error ? error.message : String(error)}`);
      }
    }),
    vscode.commands.registerCommand('repositoryManager.requirements.openAsText', (node?: ClarificationNode) => {
      if (node?.file.uri) { return vscode.commands.executeCommand('vscode.openWith', node.file.uri, 'default'); }
      return undefined;
    })
  );
  describe();
}
