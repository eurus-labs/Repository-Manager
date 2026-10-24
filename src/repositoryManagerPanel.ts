/**
 * Webview panel for Repository Manager
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitOperations } from './gitOperations';
import { OpenTimings } from './openTimings';
import { SubmoduleInfo } from './types';
import { PRManager } from './prManager';
import { getHtmlForWebview, getReviewHtml, WebviewResourceUris, WorkspaceFolderInfo } from './webview/template';
import { ReviewBridge } from './reviewBridge';
import { messageHandlers, MessageHandlerContext } from './handlers/webviewMessageHandler';
import { GitCommandService } from './services/gitCommandService';
import { ChangeContextService, MAX_PATCH_BYTES } from './services/changeContextService';
import { snapshotLocalChanges } from './services/localChangesSnapshot';
import { CopilotSummaryProvider } from './services/changeSummaryService';
import { SecurityReviewService } from './services/securityReviewService';
import { SecurityReviewProvider } from './services/securityReviewProvider';
import { ReviewController, ReviewRunner } from './reviewController';
import { ReviewConsentStore } from './reviewConsent';
import { ReviewHistoryStore } from './reviewHistory';
import { ReviewUnitCache } from './reviewUnitCache';
import { ReviewSkillStore } from './reviewSkillStore';
import { readPinnedModels, readSelectedModel, savePinnedModels, saveSelectedModel } from './modelPreferences';
import { ConflictExplainerHost } from './services/conflictExplanation';
import { RepositoryManagerLauncher } from './repositoryManagerLauncher';
import { CommitMessageController } from './commitMessageController';
import { LiveChanges } from './liveChanges';
import { ignoredPaths } from './services/ignoredPaths';
import { ASK_BEFORE_SENDING, ASK_BEFORE_SENDING_KEY, AskBeforeSending, askBeforeSending, askBeforeSendingTarget, consentHooks } from './copilotSettings';

/** Read-only documents for opening review evidence at the reviewed revision. */
const REVIEW_EVIDENCE_SCHEME = 'repository-manager-review';

/** Webview requests that only read Git state and may run during a background fetch. */
/** Where the repositories last listed in a folder are kept, to show the page before they are listed again. */
const REPOSITORY_LIST_KEY = 'repositoryManager.repositoryList';
/** The first background fetch starts at the latest this long after opening, if no history was asked for. */
const FIRST_FETCH_DELAY_MS = 3000;

const READ_ONLY_MESSAGES = new Set([
  'getHistory', 'getCommitDetail', 'getFileDiff', 'getRepositoryRefs', 'getWorkingTreeChanges',
  'getWorkingTreePreview', 'getBranches', 'getCommits', 'getRecordedCommit', 'getBaseBranchesForCreate',
  'getPendingOperation', 'summarizeChanges', 'cancelChangeSummary', 'loadSummaryModels', 'refreshRepositories',
  // Reviews read pinned commits only; they never touch refs a background fetch updates.
  'requestReview', 'openReviewTab', 'dashboardContext', 'getReviewStatus', 'reviewReady', 'showReviewEvidence',
  'startReview', 'cancelReview', 'exportReviewReport', 'openReviewEvidence', 'setFindingTriage',
  'proposeReviewFix', 'discardReviewFix', 'cancelReviewFix', 'listReviewHistory', 'openStoredReview', 'deleteStoredReview',
  // Writing a commit message reads the working tree's diff; nothing is committed.
  'generateCommitMessage', 'cancelCommitMessage',
  // The Copilot settings menu and pinned models: VS Code settings and state only, no Git.
  'getCopilotSettings', 'setCopilotSettings', 'openExtensionSettings', 'setPinnedModels', 'setSelectedModel',
  // The Side Bar's copy of the repository list; no Git.
  'sidebarSnapshot',
  // A changed file in the diff editor: reads Git, changes nothing.
  'openChangeInEditor',
  // When the page drew its first history (repositoryManager.debug.timings); no Git.
  'dashboardTiming'
]);

export class RepositoryManagerPanel {
  public static currentPanel: RepositoryManagerPanel | undefined;
  /** The extension's global state, for what follows the user across workspaces (review skills). */
  public static globalState: vscode.Memento | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private _gitOps: GitOperations;
  private _prManager: PRManager;
  private _disposables: vscode.Disposable[] = [];
  private _workspaceRoot: string;
  private readonly _summaryProvider = new CopilotSummaryProvider();
  private readonly _reviews: ReviewController;
  private readonly _commitMessages: CommitMessageController;
  /** Routes review messages between this dashboard, the Repository Review tab and the controller. */
  private readonly _reviewBridge: ReviewBridge;
  private _reviewPanel?: vscode.WebviewPanel;
  private readonly _skills: ReviewSkillStore;
  /** "Always allow for this repository", when the setting asks once per repository. */
  private readonly _consent: ReviewConsentStore;
  private readonly _evidenceDocuments = new Map<string, string>();
  private _summaryToken?: vscode.CancellationTokenSource;
  private _summaryRequest = 0;
  private _autoFetchTimer?: NodeJS.Timeout;
  private _autoFetchRun?: Promise<void>;
  private _lastAutoFetch = 0;
  /**
   * The first background fetch waits for the first history page (or FIRST_FETCH_DELAY_MS), so the
   * Git processes of opening the dashboard do not compete with it.
   */
  private _autoFetchHeld = true;
  private _autoFetchHoldTimer?: NodeJS.Timeout;
  /** Whether the webview has its HTML; until then a full update may show a list known from before. */
  private _htmlShown = false;
  private readonly _timings?: OpenTimings;
  private _messagesInFlight = 0;
  /** Git actions (not read-only requests) running now: a live refresh waits for them. */
  private _actionsInFlight = 0;
  private readonly _liveChanges: LiveChanges;
  private _fileWatcher?: vscode.FileSystemWatcher;

  /** `preserveFocus` keeps the keyboard where it is, as when the Side Bar opens the dashboard. */
  public static createOrShow(extensionUri: vscode.Uri, workspaceRoot: string, workspaceState?: vscode.Memento, preserveFocus = false) {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (RepositoryManagerPanel.currentPanel) {
      RepositoryManagerPanel.currentPanel._panel.reveal(column, preserveFocus);
      RepositoryManagerPanel.currentPanel.refresh();
      RepositoryManagerPanel.currentPanel._autoFetchIfDue();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'repositoryManager',
      'Repository Manager',
      { viewColumn: column || vscode.ViewColumn.One, preserveFocus },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'resources')]
      }
    );

    panel.iconPath = tabIcon(extensionUri, 'dashboard');
    RepositoryManagerPanel.currentPanel = new RepositoryManagerPanel(
      panel,
      extensionUri,
      workspaceRoot,
      workspaceState
    );
  }

  private readonly _workspaceState?: vscode.Memento;

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    workspaceRoot: string,
    workspaceState?: vscode.Memento
  ) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    this._workspaceRoot = workspaceRoot;
    this._workspaceState = workspaceState;
    this._timings = OpenTimings.fromSettings();
    this._gitOps = new GitOperations(workspaceRoot);
    this._prManager = new PRManager(workspaceRoot);

    const consent = new ReviewConsentStore(workspaceState);
    this._consent = consent;
    // Whether to ask before code goes to Copilot (repositoryManager.copilot.askBeforeSending): by default never.
    const consentFor = consentHooks(() => this._askBeforeSending(), root => consent.has(root));
    // Finished components of earlier reviews: a stopped review continues instead of starting over.
    const unitCache = new ReviewUnitCache(workspaceState);
    const skills = new ReviewSkillStore(path.join(extensionUri.fsPath, 'resources', 'review-skills'), RepositoryManagerPanel.globalState);
    this._skills = skills;
    // Assigned before the controller, which posts through it.
    this._reviewBridge = new ReviewBridge({
      controller: { handles: type => this._reviews.handles(type), handle: message => this._reviews.handle(message) },
      postDashboard: message => this._panel.webview.postMessage(message),
      openView: () => this._openReviewPanel(),
      revealDashboard: () => this._panel.reveal(undefined, false)
    });
    this._commitMessages = new CommitMessageController({
      workspaceRoot: () => this._workspaceRoot,
      post: message => Promise.resolve(this._panel.webview.postMessage(message)),
      ask: (message, detail, actions) => Promise.resolve(vscode.window.showInformationMessage(message, { modal: true, detail }, ...actions)),
      alwaysConfirm: consentFor.alwaysConfirm,
      isConsentRemembered: consentFor.isConsentRemembered,
      rememberConsent: root => consent.allow(root),
      complete: (prompt, modelId, token) => this._summaryProvider.complete(prompt, modelId, token as vscode.CancellationToken),
      createCancellation: () => new vscode.CancellationTokenSource()
    });
    this._reviews = new ReviewController({
      workspaceRoot: () => this._workspaceRoot,
      post: message => this._reviewBridge.toReview(message),
      ask: (message, detail, actions) => Promise.resolve(vscode.window.showInformationMessage(message, { modal: true, detail }, ...actions)),
      alwaysConfirm: consentFor.alwaysConfirm,
      isConsentRemembered: consentFor.isConsentRemembered,
      rememberConsent: root => consent.allow(root),
      createRunner: root => new SecurityReviewService(new GitCommandService(root), undefined, unitCache, () => skills.snapshot()) as unknown as ReviewRunner,
      createCancellation: () => new vscode.CancellationTokenSource(),
      copyText: text => Promise.resolve(vscode.env.clipboard.writeText(text)),
      saveText: async (fileName, text) => {
        const folder = vscode.Uri.file(this._workspaceRoot);
        // The filter key is the label VS Code shows in the dialog.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const target = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.joinPath(folder, fileName), filters: { Markdown: ['md'] } });
        if (!target) { return false; }
        await vscode.workspace.fs.writeFile(target, Buffer.from(text, 'utf8'));
        return true;
      },
      openText: async (content, revision, filePath, line) => {
        // The path keeps the file extension, so VS Code picks the right language.
        const uri = vscode.Uri.from({ scheme: REVIEW_EVIDENCE_SCHEME, path: `/${revision.slice(0, 8)}/${filePath}` });
        this._evidenceDocuments.set(uri.toString(), content);
        const document = await vscode.workspace.openTextDocument(uri);
        const position = new vscode.Position(Math.min(line, document.lineCount) - 1, 0);
        await vscode.window.showTextDocument(document, { preview: true, selection: new vscode.Range(position, position) });
      },
      notify: (message, isError) => {
        void (isError ? vscode.window.showErrorMessage(message) : vscode.window.showInformationMessage(message));
      },
      createFixModel: modelId => {
        const provider = new SecurityReviewProvider();
        return { request: (instructions, input, token, onText) =>
          provider.requestJson(instructions, input, modelId, token as vscode.CancellationToken, undefined, onText) };
      },
      language: () => vscode.env.language,
      isDirtyInEditor: absolutePath => vscode.workspace.textDocuments.some(document =>
        document.isDirty && document.uri.scheme === 'file' && document.uri.fsPath === absolutePath),
      workingTreeChanged: () => { this.refresh(); },
      history: new ReviewHistoryStore(workspaceState),
      skills,
      pickSkillFile: async () => {
        // The filter key is the label VS Code shows in the dialog.
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Import skill', filters: { Markdown: ['md'] } });
        if (!picked || !picked[0]) { return undefined; }
        return Buffer.from(await vscode.workspace.fs.readFile(picked[0])).toString('utf8');
      }
    });
    this._disposables.push(vscode.workspace.registerTextDocumentContentProvider(REVIEW_EVIDENCE_SCHEME, {
      provideTextDocumentContent: uri => this._evidenceDocuments.get(uri.toString()) || ''
    }));

    this._update();

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    this._panel.webview.onDidReceiveMessage(
      async (message) => {
        await this._handleMessage(message);
      },
      null,
      this._disposables
    );

    this._panel.onDidChangeViewState(() => { this._autoFetchIfDue(); this._liveChanges.resume(); }, null, this._disposables);
    // Local changes stay current while you edit: file events refresh the repository list once they
    // settle (repositoryManager.liveChanges). They also run while only the Side Bar shows (its
    // Changes list, with a diff open in front of the dashboard); with neither visible, the refresh
    // waits and catches up when one is shown.
    this._liveChanges = new LiveChanges({
      refresh: () => this.refresh(),
      canRefresh: () => (this._panel.visible || Boolean(RepositoryManagerLauncher.current?.visible)) && this._actionsInFlight === 0,
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: handle => clearTimeout(handle as NodeJS.Timeout),
      ignored: paths => ignoredPaths(paths, this._workspaceRoot)
    });
    // The watcher exists only while the setting is on: with it off, no file event reaches the extension.
    const watchFiles = () => {
      this._fileWatcher?.dispose();
      this._fileWatcher = undefined;
      if (!vscode.workspace.getConfiguration('repositoryManager').get<boolean>('liveChanges', true)) { return; }
      const watcher = vscode.workspace.createFileSystemWatcher('**/*');
      const onFileEvent = (uri: vscode.Uri) => this._liveChanges.notify(uri.fsPath);
      watcher.onDidChange(onFileEvent);
      watcher.onDidCreate(onFileEvent);
      watcher.onDidDelete(onFileEvent);
      this._fileWatcher = watcher;
    };
    watchFiles();
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('repositoryManager.liveChanges')) { watchFiles(); }
      // The settings menu shows the choice made anywhere, also in the Settings editor.
      if (event.affectsConfiguration(`repositoryManager.${ASK_BEFORE_SENDING_KEY}`) ||
          event.affectsConfiguration('repositoryManager.review.confirmBeforeSending')) { void this._postCopilotSettings(); }
    }, null, this._disposables);
    this._disposables.push({ dispose: () => { this._fileWatcher?.dispose(); this._liveChanges.dispose(); } });
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('repositoryManager.autoFetch')
        || event.affectsConfiguration('repositoryManager.autoFetchInterval')) {
        this._scheduleAutoFetch();
      }
    }, null, this._disposables);
    this._scheduleAutoFetch();
    this._autoFetchHoldTimer = setTimeout(() => this._releaseAutoFetch(), FIRST_FETCH_DELAY_MS);
  }

  /**
   * Lets the background fetch run. The first one starts now if nothing is in flight; otherwise the
   * request that ends last starts it (see _handleMessage), however long the requests take.
   */
  private _releaseAutoFetch(): void {
    if (!this._autoFetchHeld) { return; }
    this._autoFetchHeld = false;
    if (this._autoFetchHoldTimer) { clearTimeout(this._autoFetchHoldTimer); }
    this._autoFetchHoldTimer = undefined;
    this._autoFetchIfDue();
  }

  /** Background fetch interval in ms, or 0 when disabled. */
  private _autoFetchIntervalMs(): number {
    const config = vscode.workspace.getConfiguration('repositoryManager');
    const minutes = config.get<number>('autoFetchInterval', 5);
    return config.get<boolean>('autoFetch', true) && minutes > 0 ? minutes * 60000 : 0;
  }

  private _scheduleAutoFetch(): void {
    if (this._autoFetchTimer) {
      clearInterval(this._autoFetchTimer);
      this._autoFetchTimer = undefined;
    }
    const interval = this._autoFetchIntervalMs();
    if (interval > 0) {
      this._autoFetchTimer = setInterval(() => this._autoFetchIfDue(), interval);
    }
  }

  /**
   * Fetch every initialized repository so ahead/behind counts stay current. Runs only while
   * the panel is visible, at most once per interval, and never alongside a user action.
   */
  private _autoFetchIfDue(): void {
    const interval = this._autoFetchIntervalMs();
    if (this._autoFetchHeld || !interval || !this._panel.visible || this._autoFetchRun || this._messagesInFlight > 0
      || Date.now() - this._lastAutoFetch < interval - 1000) {
      return;
    }
    this._lastAutoFetch = Date.now();
    const gitOps = this._gitOps;
    this._autoFetchRun = (async () => {
      const repositories = await this._listRepositories();
      for (const repository of repositories) {
        // Stop early when the user starts an action or switches workspace folder.
        if (this._messagesInFlight > 0 || gitOps !== this._gitOps) {
          return;
        }
        if (repository.status !== 'uninitialized') {
          await gitOps.fetchInBackground(repository.path).catch(() => undefined);
        }
      }
      if (gitOps === this._gitOps) {
        await this.refresh();
      }
    })().catch(() => undefined).finally(() => {
      this._autoFetchRun = undefined;
    });
  }

  /**
   * Get all workspace folders info for the folder selector
   */
  private _getWorkspaceFolders(): WorkspaceFolderInfo[] {
    const folders = vscode.workspace.workspaceFolders || [];
    return folders.map(folder => ({
      name: folder.name,
      path: folder.uri.fsPath,
      isCurrent: folder.uri.fsPath === this._workspaceRoot
    }));
  }

  /**
   * Switch to a different workspace folder
   */
  private async _switchWorkspaceFolder(folderPath: string): Promise<void> {
    this._cancelSummary();
    // A running review keeps going: it is pinned to the folder it started in.
    const folders = vscode.workspace.workspaceFolders || [];
    const targetFolder = folders.find(f => f.uri.fsPath === folderPath);
    if (!targetFolder) {
      vscode.window.showErrorMessage(`Workspace folder not found: ${path.basename(folderPath)}`);
      return;
    }

    this._workspaceRoot = folderPath;
    this._gitOps = new GitOperations(folderPath);
    this._prManager = new PRManager(folderPath);
    // Repository paths are relative to the folder (the root is always '.'), so the webview
    // must be told explicitly to drop the old folder's history, refs and selection.
    await this._panel.webview.postMessage({
      type: 'workspaceFolderChanged',
      payload: { repositories: await this._listRepositories() }
    });
  }

  /** A message for the dashboard webview (the Side Bar forwards its clicks this way). */
  public post(message: { type: string; payload?: unknown }): Thenable<boolean> {
    return this._panel.webview.postMessage(message);
  }

  /** The Side Bar was shown: file events held while nothing was visible refresh now. */
  public sidebarShown(): void {
    this._liveChanges.resume();
  }

  public async refresh(fullRefresh: boolean = false) {
    await this._update(fullRefresh);
  }

  public async reloadDashboardHistory(repositoryPaths: string[]): Promise<void> {
    await this._panel.webview.postMessage({
      type: 'reloadDashboardHistory',
      payload: { repositoryPaths }
    });
  }

  private _getResourceUris(): WebviewResourceUris {
    const graphScriptUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'historyGraph.js')
    );
    const scriptUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview.js')
    );
    const styleUri = this._panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview.css')
    );
    return { graphScriptUri, scriptUri, styleUri };
  }

  /** Parent repository first, then linked repositories. */
  private async _listRepositories(gitOps: GitOperations = this._gitOps) {
    const submodules = await gitOps.getSubmodules();
    const parentRepo = await gitOps.getParentRepoInfo();
    return parentRepo ? [parentRepo, ...submodules] : submodules;
  }

  private async _update(fullRefresh: boolean = true) {
    const gitOps = this._gitOps;
    // Opening: the page is shown at once with the repositories known from the last time (or the
    // parent alone), so its history loads while every repository's status is read; the fresh list
    // follows as an update. Listing first made the page wait for one status per repository.
    const early = fullRefresh && !this._htmlShown ? this._knownRepositories() : undefined;
    if (early) { this._showHtml(early); }
    const allRepos = await this._listRepositories(gitOps);
    // A workspace folder switch while listing makes this result stale; the switch posts its own.
    if (gitOps !== this._gitOps) {
      return;
    }
    this._timings?.mark('repositories listed');
    void this._workspaceState?.update(REPOSITORY_LIST_KEY, { root: this._workspaceRoot, repositories: allRepos });

    if (fullRefresh && !early) {
      this._showHtml(allRepos);
    } else {
      // Send data update instead of regenerating HTML
      this._panel.webview.postMessage({
        type: 'updateSubmodules',
        payload: { submodules: allRepos }
      });
    }
  }

  private _showHtml(repositories: SubmoduleInfo[]): void {
    this._htmlShown = true;
    this._panel.webview.html = getHtmlForWebview(repositories, this._getResourceUris(), this._getWorkspaceFolders());
    this._timings?.mark('page shown');
  }

  /**
   * For a folder holding a repository: its repositories as last listed, or the parent repository
   * alone (its state not known yet). Otherwise undefined, so the page waits for the list.
   */
  private _knownRepositories(): SubmoduleInfo[] | undefined {
    // Nothing is shown before the list for a folder that is not (or no longer) a repository.
    if (!fs.existsSync(path.join(this._workspaceRoot, '.git'))) { return undefined; }
    const saved = this._workspaceState?.get<{ root?: string; repositories?: SubmoduleInfo[] }>(REPOSITORY_LIST_KEY);
    if (saved && saved.root === this._workspaceRoot && Array.isArray(saved.repositories) && saved.repositories.length) {
      return saved.repositories;
    }
    return [{ name: path.basename(this._workspaceRoot) || 'Parent Repository', path: '.', url: '', branch: '',
      currentCommit: '', currentBranch: '', status: 'unknown', hasChanges: false, ahead: 0, behind: 0, isParentRepo: true }];
  }

  /**
   * Create message handler context
   */
  private _createHandlerContext(): MessageHandlerContext {
    return {
      panel: this._panel,
      gitOps: this._gitOps,
      prManager: this._prManager,
      workspaceRoot: this._workspaceRoot,
      refresh: () => this.refresh(),
      reloadDashboardHistory: (repositoryPaths) => this.reloadDashboardHistory(repositoryPaths),
      workspaceState: this._workspaceState,
      conflictExplainer: this._conflictExplainer(),
      showProposedFile: async (filePath, current, proposed) => {
        // Read-only documents of the review scheme: nothing here can be edited or saved by mistake.
        const stamp = Date.now();
        const left = vscode.Uri.from({ scheme: REVIEW_EVIDENCE_SCHEME, path: `/conflict-${stamp}/now/${filePath}` });
        const right = vscode.Uri.from({ scheme: REVIEW_EVIDENCE_SCHEME, path: `/conflict-${stamp}/suggested/${filePath}` });
        this._evidenceDocuments.set(left.toString(), current);
        this._evidenceDocuments.set(right.toString(), proposed);
        await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(filePath)}: now ↔ suggested resolution`, { preview: true });
      }
    };
  }

  /** Copilot for a history action's predicted conflicts: the toolbar's model, and the same consent as reviews. */
  private _conflictExplainer(): ConflictExplainerHost {
    const consentFor = consentHooks(() => this._askBeforeSending(), root => this._consent.has(root));
    return {
      ask: (message, detail, actions) => Promise.resolve(vscode.window.showInformationMessage(message, { modal: true, detail }, ...actions)),
      alwaysConfirm: consentFor.alwaysConfirm,
      isConsentRemembered: consentFor.isConsentRemembered,
      rememberConsent: root => this._consent.allow(root),
      complete: (prompt, token, maxChars) => this._summaryProvider.complete(prompt, readSelectedModel(RepositoryManagerPanel.globalState)?.id,
        token as vscode.CancellationToken, maxChars),
      language: () => vscode.env.language
    };
  }

  private async _handleMessage(message: { type: string; payload?: unknown }) {
    this._messagesInFlight++;
    const action = !READ_ONLY_MESSAGES.has(message.type);
    if (action) { this._actionsInFlight++; }
    try {
      // Git actions wait for a running background fetch so they never race it for ref locks.
      if (this._autoFetchRun && !READ_ONLY_MESSAGES.has(message.type)) {
        await this._autoFetchRun;
      }
      if (message.type === 'getHistory') { this._timings?.markOnce('history asked'); }
      await this._dispatchMessage(message);
      if (message.type === 'getHistory') {
        this._timings?.markOnce('history sent');
        this._releaseAutoFetch();
      }
    } finally {
      this._messagesInFlight--;
      // The first fetch, released while the dashboard was still answering, starts once it is done.
      if (this._messagesInFlight === 0 && this._lastAutoFetch === 0) { this._autoFetchIfDue(); }
      if (action) {
        this._actionsInFlight--;
        // File events during the action asked for a refresh; the action's own refresh may cover them.
        this._liveChanges.resume();
      }
    }
  }

  private async _dispatchMessage(message: { type: string; payload?: unknown }) {
    try {
      if (this._reviewBridge.fromDashboard(message)) { return; }
      if (message.type === 'dashboardTiming') {
        const name = (message.payload as { name?: unknown } | undefined)?.name;
        if (typeof name === 'string') { this._timings?.markOnce(name); }
        return;
      }
      if (this._reviews.handles(message.type)) {
        await this._reviews.handle(message);
        return;
      }
      if (this._commitMessages.handles(message.type)) {
        await this._commitMessages.handle(message);
        return;
      }
      if (message.type === 'getCopilotSettings') {
        await this._postCopilotSettings();
        return;
      }
      if (message.type === 'setCopilotSettings') {
        const value = (message.payload as { askBeforeSending?: unknown } | undefined)?.askBeforeSending;
        if (ASK_BEFORE_SENDING.includes(value as AskBeforeSending)) {
          const config = vscode.workspace.getConfiguration('repositoryManager');
          await config.update(ASK_BEFORE_SENDING_KEY, value, askBeforeSendingTarget(config) === 'workspace'
            ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global);
        }
        await this._postCopilotSettings();
        return;
      }
      if (message.type === 'setPinnedModels') {
        await savePinnedModels(RepositoryManagerPanel.globalState, (message.payload as { ids?: unknown } | undefined)?.ids);
        return;
      }
      if (message.type === 'setSelectedModel') {
        await saveSelectedModel(RepositoryManagerPanel.globalState, (message.payload as { model?: unknown } | undefined)?.model);
        return;
      }
      if (message.type === 'openExtensionSettings') {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:eurus-labs.repository-manager');
        return;
      }
      if (message.type === 'sidebarSnapshot') {
        const html = (message.payload as { html?: unknown } | undefined)?.html;
        if (typeof html === 'string') { RepositoryManagerLauncher.current?.update(html); }
        return;
      }
      if (message.type === 'cancelChangeSummary') {
        this._cancelSummary();
        return;
      }
      if (message.type === 'summarizeChanges') {
        await this._summarizeChanges(message.payload);
        return;
      }
      if (message.type === 'loadSummaryModels') {
        try {
          const models = await this._summaryProvider.listModels();
          const pinned = readPinnedModels(RepositoryManagerPanel.globalState);
          await this._panel.webview.postMessage({ type: 'summaryModelsLoaded', payload: { models, pinned } });
        } catch (error) {
          await this._panel.webview.postMessage({ type: 'summaryModelsError', payload: {
            message: error instanceof Error ? error.message : 'Unable to load Copilot models.'
          } });
        }
        return;
      }
      // The repository list only (switching repository): no result, so nothing else reloads.
      if (message.type === 'refreshRepositories') {
        await this.refresh();
        return;
      }
      // Handle refresh separately as it's not in the handler map
      if (message.type === 'refresh') {
        try {
          await this.refresh();
          await this._panel.webview.postMessage({
            type: 'repositoryOperationResult',
            payload: { operation: 'refresh', success: true, message: 'Dashboard refreshed' }
          });
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : 'Unknown error';
          await this._panel.webview.postMessage({
            type: 'repositoryOperationResult',
            payload: { operation: 'refresh', success: false, message: `Refresh failed: ${errorMessage}` }
          });
          throw error;
        }
        return;
      }

      // Handle workspace folder switch
      if (message.type === 'switchWorkspaceFolder') {
        const payload = message.payload as { folderPath: string };
        if (payload && payload.folderPath) {
          await this._switchWorkspaceFolder(payload.folderPath);
        }
        return;
      }

      // Look up the handler in the message handlers map
      const handler = messageHandlers[message.type];
      if (handler) {
        const ctx = this._createHandlerContext();
        await handler(ctx, message.payload);
      } else {
        console.warn(`Unhandled webview message type: ${message.type}`);
      }
    } catch (error) {
      console.error(`Error handling webview message '${message.type}':`, error);
      // Try to notify the user about the error
      try {
        const errorMsg = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Repository Manager: ${errorMsg}`);
      } catch {
        // Last resort - ignore
      }
    }
  }

  /**
   * The Repository Review tab, beside the dashboard. Closing it leaves a running review going
   * (ReviewBridge replays it when the tab opens again); closing the dashboard closes it.
   */
  private _openReviewPanel(): void {
    if (this._reviewPanel) {
      this._reviewPanel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel('repositoryManager.review', 'Repository Review',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(this._extensionUri, 'resources')] });
    panel.iconPath = tabIcon(this._extensionUri, 'review');
    this._reviewPanel = panel;
    panel.webview.html = getReviewHtml({
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'review.js')),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'resources', 'webview.css'))
    });
    this._reviewBridge.attach({ post: message => panel.webview.postMessage(message) });
    panel.webview.onDidReceiveMessage(async (message: { type: string; payload?: unknown }) => {
      // Like the dashboard's messages: writing (an applied fix) waits for a background fetch.
      if (this._autoFetchRun && !READ_ONLY_MESSAGES.has(message.type)) { await this._autoFetchRun.catch(() => undefined); }
      await this._reviewBridge.fromReview(message);
    }, null, this._disposables);
    panel.onDidDispose(() => {
      if (this._reviewPanel === panel) {
        this._reviewPanel = undefined;
        this._reviewBridge.detach();
      }
    }, null, this._disposables);
  }

  public dispose() {
    if (this._autoFetchHoldTimer) { clearTimeout(this._autoFetchHoldTimer); }
    this._timings?.dispose();
    this._cancelSummary();
    this._reviews.cancel();
    this._commitMessages.cancel();
    const reviewPanel = this._reviewPanel;
    this._reviewPanel = undefined;
    reviewPanel?.dispose();
    if (this._autoFetchTimer) {
      clearInterval(this._autoFetchTimer);
    }
    RepositoryManagerPanel.currentPanel = undefined;
    RepositoryManagerLauncher.current?.dashboardClosed();
    this._panel.dispose();

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  private _cancelSummary(): void {
    this._summaryRequest++;
    this._summaryToken?.cancel();
    this._summaryToken?.dispose();
    this._summaryToken = undefined;
  }

  private _askBeforeSending(): AskBeforeSending {
    return askBeforeSending(vscode.workspace.getConfiguration('repositoryManager'));
  }

  private async _postCopilotSettings(): Promise<void> {
    await this._panel.webview.postMessage({ type: 'copilotSettingsLoaded', payload: {
      askBeforeSending: this._askBeforeSending(), selectedModel: readSelectedModel(RepositoryManagerPanel.globalState) ?? null
    } });
  }

  private async _summarizeChanges(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    const request = payload as Record<string, unknown>;
    const { repositoryPath, targetSha, baseSha, requestId, modelId } = request;
    const local = request.local === true;
    if (typeof repositoryPath !== 'string' || (!local && typeof targetSha !== 'string') ||
        (baseSha !== null && typeof baseSha !== 'string') || typeof requestId !== 'number' ||
        (modelId !== undefined && typeof modelId !== 'string')) {
      return;
    }
    this._cancelSummary();
    const generation = this._summaryRequest;
    const root = this._workspaceRoot;
    const controller = new vscode.CancellationTokenSource();
    this._summaryToken = controller;
    const send = async (type: string, extra: Record<string, unknown>) => {
      if (generation === this._summaryRequest && !controller.token.isCancellationRequested) {
        await this._panel.webview.postMessage({ type, payload: { requestId, repositoryPath, ...extra } });
      }
    };
    try {
      await send('changeSummaryProgress', { status: local ? 'Reading the local changes…' : 'Collecting context…' });
      const git = new GitCommandService(root);
      // Local changes: HEAD → a snapshot of the working tree (as Review changes takes it); nothing
      // is committed, staged or changed.
      let range: { base?: string; target: string; label?: string };
      if (local) {
        const snapshot = await snapshotLocalChanges(git, git.resolveRepositoryPath(repositoryPath));
        if (!snapshot) {
          await send('changeSummaryError', { message: 'There are no local changes to summarize.' });
          return;
        }
        range = { base: snapshot.headSha, target: snapshot.snapshotSha, label: 'HEAD → local changes (staged, unstaged and new files)' };
      } else {
        range = { base: typeof baseSha === 'string' ? baseSha : undefined, target: targetSha as string };
      }
      const context = await new ChangeContextService(git).collect(repositoryPath, range.target, range.base);
      if (generation !== this._summaryRequest || controller.token.isCancellationRequested) {
        return;
      }
      // Asked only when the setting says so, like reviews: by default the summary starts at once.
      const ask = this._askBeforeSending();
      const repositoryRoot = git.resolveRepositoryPath(repositoryPath);
      if (ask === 'always' || (ask === 'oncePerRepository' && !this._consent.has(repositoryRoot))) {
        const always = 'Always allow for this repository';
        const decision = await vscode.window.showInformationMessage(
          `Summarize ${context.coverage.totalFiles} changed files with Copilot?`,
          { modal: true, detail: `${context.repositoryPath}\n${range.label || `${context.baseSha} → ${context.targetSha}`}\n` +
            `${context.patches.length} patches (up to ${Math.round(MAX_PATCH_BYTES / 1000)} KB total) may be sent across multiple model requests. ` +
            `${context.coverage.omitted.length} items have no patch. Review changed files in the dashboard first.` },
          ...(ask === 'always' ? ['Summarize'] : ['Summarize', always])
        );
        if ((decision !== 'Summarize' && decision !== always) || generation !== this._summaryRequest || controller.token.isCancellationRequested) {
          await send('changeSummaryError', { message: 'Summary cancelled.' });
          return;
        }
        if (decision === always) { await this._consent.allow(repositoryRoot); }
      }
      await send('changeSummaryProgress', { status: 'Summarizing…' });
      const result = await this._summaryProvider.summarize(context, controller.token, status => {
        void send('changeSummaryProgress', { status });
      }, modelId || undefined);
      await send('changeSummaryProgress', { status: 'Validating…' });
      await send('changeSummaryLoaded', { summary: result.summary, model: result.model });
    } catch (error) {
      await send('changeSummaryError', { message: error instanceof Error ? error.message : 'Unable to summarize changes.' });
    } finally {
      if (generation === this._summaryRequest) {
        this._summaryToken = undefined;
      }
      controller.dispose();
    }
  }
}

/**
 * The editor tab's icon, so the dashboard and the review tab are told apart at a glance: the
 * repository tree of the Activity Bar, and a shield for the review. A tab draws its icon as an
 * image, which takes no theme color, so each comes in a light and a dark version.
 */
export function tabIcon(extensionUri: vscode.Uri, name: 'dashboard' | 'review'): { light: vscode.Uri; dark: vscode.Uri } {
  return {
    light: vscode.Uri.joinPath(extensionUri, 'resources', 'tab-icons', `${name}-light.svg`),
    dark: vscode.Uri.joinPath(extensionUri, 'resources', 'tab-icons', `${name}-dark.svg`)
  };
}
