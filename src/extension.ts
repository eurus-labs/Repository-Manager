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
import { RepositoryManagerLauncher } from './repositoryManagerLauncher';
import { RepositoryManagerPanel } from './repositoryManagerPanel';
import { CHANGE_DOCUMENT_SCHEME, ChangeDocumentProvider } from './changeDocuments';

let repositoryTreeProvider: RepositoryTreeProvider;
let gitOps: GitOperations;
let prManager: PRManager;

export function activate(context: vscode.ExtensionContext) {
  console.log('Repository Manager extension is now active');

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

  if (!workspaceRoot) {
    vscode.window.showWarningMessage('Repository Manager: No workspace folder open');
    return;
  }

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

export function deactivate() {
  console.log('Repository Manager extension is now deactivated');
}
