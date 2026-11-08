/**
 * Repository Manager Extension
 * Main entry point for the VS Code extension
 */

import * as vscode from 'vscode';
import { GitOperations } from './gitOperations';
import { RepositoryTreeProvider } from './repositoryTreeProvider';
import { PRManager } from './prManager';
import { registerBasicCommands, CommandContext } from './commands/submoduleCommands';
import { registerCreateBranchCommand } from './commands/createBranchCommand';
import { registerReviewCommands } from './commands/reviewCommands';
import { registerDiscardCommands } from './commands/discardCommands';
import { RepositoryManagerLauncher } from './repositoryManagerLauncher';
import { RepositoryManagerPanel } from './repositoryManagerPanel';
import { CHANGE_DOCUMENT_SCHEME, ChangeDocumentProvider } from './changeDocuments';
import { registerRequirements } from './requirements/requirementsView';
import { registerAgent } from './agent/agentView';
import { registerStudio } from './studio/studioCommands';
import { WorkflowEditorProvider } from './studio/workflowEditorProvider';
import * as path from 'path';
import { setUsageLog, UsageLog, usageReport } from './services/usageLog';

let repositoryTreeProvider: RepositoryTreeProvider;
let gitOps: GitOperations;
let prManager: PRManager;

/** Shown by a command that needs a folder when the window has none. */
export const NO_FOLDER_MESSAGE = 'Repository Manager: open a folder to use this command.';

export function activate(context: vscode.ExtensionContext) {
  const log = vscode.window.createOutputChannel('Repository Manager');
  context.subscriptions.push(log);
  log.appendLine(`Activating Repository Manager ${context.extension?.packageJSON?.version ?? ''}`.trim());

  // Each part registers on its own: one that throws is logged and reported, and the others
  // (above all the Git commands) are still registered, so their commands are never "not found".
  const failed: string[] = [];
  const step = (name: string, register: () => void): void => {
    try {
      register();
    } catch (error) {
      failed.push(name);
      const detail = error instanceof Error ? (error.stack || error.message) : String(error);
      log.appendLine(`${name} failed to start: ${detail}`);
      console.error(`Repository Manager: ${name} failed to start`, error);
    }
  };

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  log.appendLine(workspaceRoot ? `Workspace folder: ${workspaceRoot}` : 'No workspace folder open');

  if (workspaceRoot) {
    step('Git commands', () => registerGit(context, workspaceRoot));
    step('Agent', () => registerAgent(context));
    step('Studio', () => registerStudio(context, workspaceRoot));
  } else {
    // The commands are declared in package.json, so VS Code shows them (and the Activity Bar
    // shows the launcher) with no folder too: register them to say why they cannot run.
    step('Git commands', () => registerWithoutFolder(context));
  }
  // A clarification file opens in the Requirement editor with or without a folder.
  step('Requirements', () => registerRequirements(context));
  // A workflow file opens in the Workflow Editor with or without a folder; running it needs one.
  step('Workflow editor', () => context.subscriptions.push(WorkflowEditorProvider.register(context)));

  const declared: string[] = (context.extension?.packageJSON?.contributes?.commands ?? []).map((c: { command: string }) => c.command);
  void Promise.resolve(vscode.commands.getCommands(true)).then(registered => {
    const missing = declared.filter(id => !registered.includes(id));
    log.appendLine(missing.length ? `Commands not registered: ${missing.join(', ')}` : `All ${declared.length} commands registered`);
  }, () => undefined);

  if (failed.length) {
    void vscode.window.showErrorMessage(`Repository Manager: ${failed.join(' and ')} failed to start. See Output → Repository Manager.`, 'Show Output')
      .then(choice => { if (choice) { log.show(); } });
    return;
  }
  if (!workspaceRoot) {
    return;
  }

  // Show welcome message on first activation
  const hasShownWelcome = context.globalState.get('repositoryManager.welcomeShown');
  if (!hasShownWelcome) {
    vscode.window.showInformationMessage(
      'Repository Manager is ready! Open the panel with Ctrl+Shift+G M (Cmd+Shift+G M on Mac)',
      'Open Panel'
    ).then(selection => {
      if (selection === 'Open Panel') {
        vscode.commands.executeCommand('repositoryManager.openPanel');
      }
    });
    context.globalState.update('repositoryManager.welcomeShown', true);
  }
}

/** The Git dashboard, its commands and its side bar, for the window's first folder. */
function registerGit(context: vscode.ExtensionContext, workspaceRoot: string): void {
  // Initialize services
  gitOps = new GitOperations(workspaceRoot);
  prManager = new PRManager(workspaceRoot);

  // Keep the provider as a command refresh dependency. The Activity Bar shows the
  // dashboard's own repository list (RepositoryManagerLauncher), not this tree.
  repositoryTreeProvider = new RepositoryTreeProvider(workspaceRoot);

  // Create command context
  const commandContext: CommandContext = {
    gitOps,
    repositoryTreeProvider,
    prManager,
    workspaceRoot,
    extensionUri: context.extensionUri
  };

  // Register commands
  RepositoryManagerPanel.globalState = context.globalState;
  registerBasicCommands(context, commandContext);
  registerCreateBranchCommand(context, gitOps, repositoryTreeProvider);
  registerReviewCommands(context, workspaceRoot);
  registerDiscardCommands(context, gitOps);
  registerUsage(context);
  // Right-click a local branch in the Side Bar: VS Code's menu passes the row's data-vscode-context.
  context.subscriptions.push(vscode.commands.registerCommand('repositoryManager.deleteBranchFromMenu',
    (branch: unknown) => RepositoryManagerPanel.currentPanel?.deleteBranchFromMenu(branch)));
  // The committed side of a changed file opened in the diff editor; registered here, not by the
  // dashboard, so tabs VS Code restores after a reload still show it.
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(CHANGE_DOCUMENT_SCHEME,
    new ChangeDocumentProvider(() => (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath))));
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      RepositoryManagerLauncher.viewType,
      new RepositoryManagerLauncher(context.extensionUri, {
        isOpen: () => Boolean(RepositoryManagerPanel.currentPanel),
        open: async () => RepositoryManagerPanel.createOrShow(context.extensionUri, workspaceRoot, context.workspaceState, true),
        post: message => RepositoryManagerPanel.currentPanel?.post(message),
        sidebarShown: () => RepositoryManagerPanel.currentPanel?.sidebarShown()
      })
    )
  );

  // Auto-refresh when files change
  const watcher = vscode.workspace.createFileSystemWatcher('**/.gitmodules');
  watcher.onDidChange(() => repositoryTreeProvider.refresh());
  watcher.onDidCreate(() => repositoryTreeProvider.refresh());
  watcher.onDidDelete(() => repositoryTreeProvider.refresh());
  context.subscriptions.push(watcher);
}

/** The usage log (src/services/usageLog.ts) and its report, opened as a Markdown document. */
function registerUsage(context: vscode.ExtensionContext): void {
  const log = new UsageLog(path.join(context.globalStorageUri.fsPath, 'usage.jsonl'),
    () => vscode.workspace.getConfiguration('repositoryManager').get<boolean>('usage.enabled', true));
  setUsageLog(log);
  context.subscriptions.push(
    vscode.commands.registerCommand('repositoryManager.showUsage', async () => {
      const document = await vscode.workspace.openTextDocument({ language: 'markdown', content: usageReport(log.read(), log.file) });
      await vscode.window.showTextDocument(document, { preview: false });
    }),
    vscode.commands.registerCommand('repositoryManager.clearUsage', async () => {
      const clear = 'Clear';
      if (await vscode.window.showWarningMessage('Clear the recorded usage? The report starts again from nothing.', { modal: true }, clear) === clear) {
        log.clear();
      }
    }),
    { dispose: () => setUsageLog(undefined) }
  );
}

/** With no folder open, every Git and Agent command shows an error instead of being "not found". */
function registerWithoutFolder(context: vscode.ExtensionContext): void {
  const declared: string[] = (context.extension?.packageJSON?.contributes?.commands ?? []).map((c: { command: string }) => c.command);
  for (const id of declared.filter(id => !id.startsWith('repositoryManager.requirements.'))) {
    context.subscriptions.push(vscode.commands.registerCommand(id, () => vscode.window.showErrorMessage(NO_FOLDER_MESSAGE)));
  }
}

export function deactivate() {
  console.log('Repository Manager extension is now deactivated');
}
