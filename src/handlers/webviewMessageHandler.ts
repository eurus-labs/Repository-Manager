/**
 * Webview Message Handler
 * Handles all messages from the webview panel
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { GitOperations } from '../gitOperations';
import { PRManager } from '../prManager';
import { HistoryQuery } from '../types';
import { GitCommandService } from '../services/gitCommandService';
import { HistoryAction } from '../services/historyActionService';
import { HistoryRewriteAction, ResetMode } from '../services/historyRewriteService';
import { ConflictPrediction, ConflictPredictionService, PredictedOperation } from '../services/conflictPredictionService';
import { ConflictExplainerHost, confirmSending, describeSides, explainPredictedConflicts, formatConflictExplanation } from '../services/conflictExplanation';
import { buildResolutionPrompt, checkResolution, describeSuggestion, parseResolutions, readConflictedFile, spliceResolutions } from '../services/conflictResolution';
import { STASH_OPERATIONS, StashActionData, StashOperation } from '../services/stashActionService';

export interface MessageHandlerContext {
  panel: vscode.WebviewPanel;
  gitOps: GitOperations;
  prManager: PRManager;
  workspaceRoot: string;
  refresh: () => Promise<void>;
  reloadDashboardHistory: (repositoryPaths: string[]) => Promise<void>;
  /** Where small per-repository choices are remembered, such as Push after commit. */
  workspaceState?: vscode.Memento;
  /** Copilot, for explaining a history action's predicted conflicts; absent, the dialog does not offer it. */
  conflictExplainer?: ConflictExplainerHost;
  /** Shows a suggested resolution as a diff from the file as it is now. */
  showProposedFile?: (filePath: string, current: string, proposed: string) => Promise<void>;
}

const PUSH_AFTER_COMMIT_KEY = 'repositoryManager.pushAfterCommit';

/** Repositories (absolute roots) whose commit dialog has Push after commit ticked. */
function pushAfterCommitRoots(ctx: MessageHandlerContext): string[] {
  const value = ctx.workspaceState?.get<unknown>(PUSH_AFTER_COMMIT_KEY);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

async function rememberPushAfterCommit(ctx: MessageHandlerContext, repositoryPath: string, push: boolean): Promise<void> {
  if (!ctx.workspaceState) { return; }
  const root = ctx.gitOps.resolveRepositoryPath(repositoryPath);
  const roots = pushAfterCommitRoots(ctx).filter(item => item !== root);
  await ctx.workspaceState.update(PUSH_AFTER_COMMIT_KEY, push ? [...roots, root] : roots);
}

export type MessagePayload = {
  submodules?: string[];
  submodule?: string;
  branchName?: string;
  baseBranch?: string;
  branch?: string;
  commit?: string;
  isRebasing?: boolean;
};

/**
 * Show result message to user
 */
function showResult(success: boolean, message: string): void {
  if (success) {
    vscode.window.showInformationMessage(message);
  } else {
    vscode.window.showErrorMessage(message);
  }
}

/**
 * Send a message to the webview with await and error logging
 */
async function sendToWebview(ctx: MessageHandlerContext, message: { type: string; payload: unknown }): Promise<void> {
  try {
    const delivered = await ctx.panel.webview.postMessage(message);
    if (!delivered) {
      console.warn(`[RepositoryManager] Message '${message.type}' was NOT delivered to webview`);
    }
  } catch (error) {
    console.error(`[RepositoryManager] Failed to send message '${message.type}' to webview:`, error);
  }
}

function requireRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid dashboard request payload');
  }
  return payload as Record<string, unknown>;
}

function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing or invalid '${field}'`);
  }
  return value;
}

async function sendDashboardError(
  ctx: MessageHandlerContext,
  request: string,
  repositoryPath: string,
  error: unknown
): Promise<void> {
  await sendToWebview(ctx, {
    type: 'dashboardError',
    payload: {
      request,
      repositoryPath,
      message: error instanceof Error ? error.message : 'Unknown dashboard backend error'
    }
  });
}

export async function handleGetHistory(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');
  const query: HistoryQuery = {
    repositoryPath,
    limit: typeof request.limit === 'number' ? request.limit : undefined,
    offset: typeof request.offset === 'number' ? request.offset : undefined,
    search: typeof request.search === 'string' ? request.search : undefined,
    branch: typeof request.branch === 'string' ? request.branch : undefined,
    includeRemotes: request.includeRemotes === true
  };

  try {
    const history = await ctx.gitOps.getHistory(query);
    await sendToWebview(ctx, {
      type: 'historyLoaded',
      payload: {
        ...history,
        requestId: typeof request.requestId === 'number' ? request.requestId : 0
      }
    });
  } catch (error) {
    // A search replaced by a newer request has no one waiting; reporting it would cover the new result.
    if (error instanceof Error && error.name === 'SupersededError') { return; }
    await sendDashboardError(ctx, 'getHistory', repositoryPath, error);
  }
}

export async function handleGetCommitDetail(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');
  const commitHash = requireString(request, 'commitHash');
  const baseRevision = typeof request.baseRevision === 'string' && request.baseRevision.length > 0
    ? request.baseRevision
    : undefined;

  try {
    const detail = await ctx.gitOps.getCommitDetail(repositoryPath, commitHash, baseRevision);
    await sendToWebview(ctx, {
      type: 'commitDetailLoaded',
      payload: { repositoryPath, detail, baseRevision, targetRevision: commitHash }
    });
  } catch (error) {
    await sendDashboardError(ctx, 'getCommitDetail', repositoryPath, error);
  }
}

export async function handleGetFileDiff(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');
  const commitHash = requireString(request, 'commitHash');
  const filePath = requireString(request, 'path');
  const baseRevision = typeof request.baseRevision === 'string' && request.baseRevision.length > 0
    ? request.baseRevision
    : undefined;

  try {
    const diff = await ctx.gitOps.getFileDiff(repositoryPath, commitHash, filePath, baseRevision);
    await sendToWebview(ctx, { type: 'fileDiffLoaded', payload: diff });
  } catch (error) {
    await sendDashboardError(ctx, 'getFileDiff', repositoryPath, error);
  }
}

export async function handleGetRepositoryRefs(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');

  try {
    const refs = await ctx.gitOps.getRepositoryRefs(repositoryPath);
    await sendToWebview(ctx, { type: 'repositoryRefsLoaded', payload: refs });
  } catch (error) {
    await sendDashboardError(ctx, 'getRepositoryRefs', repositoryPath, error);
  }
}

export async function handleGetWorkingTreeChanges(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');

  try {
    const changes = await ctx.gitOps.getWorkingTreeChanges(repositoryPath);
    const pushAfterCommit = pushAfterCommitRoots(ctx).includes(ctx.gitOps.resolveRepositoryPath(repositoryPath));
    // The dashboard (its Uncommitted changes row) and the commit dialog both ask; the reply says which.
    const purpose = request.purpose === 'dashboard' ? 'dashboard' : undefined;
    await sendToWebview(ctx, {
      type: 'workingTreeChangesLoaded',
      payload: { repositoryPath, changes, pushAfterCommit, purpose }
    });
  } catch (error) {
    await sendDashboardError(ctx, 'getWorkingTreeChanges', repositoryPath, error);
  }
}

export async function handleGetWorkingTreePreview(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');
  const filePath = requireString(request, 'path');
  const mode = request.mode;
  const requestId = typeof request.requestId === 'number' ? request.requestId : 0;

  try {
    if (mode !== 'staged' && mode !== 'unstaged') {
      throw new Error('Invalid preview mode');
    }
    const preview = await ctx.gitOps.getWorkingTreePreview(repositoryPath, filePath, mode, requestId);
    await sendToWebview(ctx, { type: 'workingTreePreviewLoaded', payload: preview });
  } catch (error) {
    await sendToWebview(ctx, {
      type: 'workingTreePreviewError',
      payload: {
        repositoryPath,
        path: filePath,
        mode,
        requestId,
        message: error instanceof Error ? error.message : 'Unable to load diff'
      }
    });
  }
}

export async function handleCommitFiles(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');
  const message = requireString(request, 'message');
  const files = Array.isArray(request.files)
    ? request.files.filter((file): file is string => typeof file === 'string' && file.length > 0)
    : [];

  const partial = request.partial === 'staged' || request.partial === 'whole' ? request.partial : undefined;
  await rememberPushAfterCommit(ctx, repositoryPath, request.push === true);
  const result = await ctx.gitOps.commitFiles(repositoryPath, files, message, partial);
  // Push after commit: only once the commit exists. A failed push leaves the commit in place, and says so.
  const pushed = result.success && request.push === true ? await ctx.gitOps.pushChanges(repositoryPath) : undefined;
  const summary = pushed ? `${result.message}; ${pushed.success ? 'pushed' : pushed.message.replace(/^Failed to push: /, 'not pushed: ')}` : result.message;
  showResult(result.success && (!pushed || pushed.success), summary);
  await sendToWebview(ctx, {
    type: 'commitFilesResult',
    payload: { repositoryPath, success: result.success, message: summary, pushed: pushed ? pushed.success : undefined }
  });

  if (result.success) {
    await ctx.reloadDashboardHistory([repositoryPath]);
    await ctx.refresh();
  }
}

/**
 * Handler for initializing submodules
 */
export async function handleInitSubmodules(ctx: MessageHandlerContext): Promise<void> {
  const result = await ctx.gitOps.initSubmodules();
  showResult(result.success, result.message);
  await ctx.refresh();
}

/**
 * Handler for updating submodules
 */
export async function handleUpdateSubmodules(ctx: MessageHandlerContext): Promise<void> {
  const result = await ctx.gitOps.updateSubmodules();
  showResult(result.success, result.message);
  await ctx.refresh();
}

/**
 * Handler for creating a branch
 */
export async function handleCreateBranch(
  ctx: MessageHandlerContext,
  payload: { submodules: string[]; branchName: string; baseBranch: string }
): Promise<void> {
  const results = await ctx.gitOps.createBranchAcrossSubmodules(
    payload.submodules,
    payload.branchName,
    payload.baseBranch,
    true
  );

  let successCount = 0;
  let failCount = 0;
  const successfulPaths: string[] = [];

  results.forEach((result, repositoryPath) => {
    if (result.success) {
      successCount++;
      successfulPaths.push(repositoryPath);
    } else {
      failCount++;
    }
  });

  if (failCount === 0) {
    vscode.window.showInformationMessage(
      `Branch '${payload.branchName}' created in ${successCount} repository/repositories`
    );
  } else {
    vscode.window.showWarningMessage(
      `Branch created in ${successCount} repository/repositories, failed in ${failCount}`
    );
  }

  if (successfulPaths.length > 0) {
    await ctx.reloadDashboardHistory(successfulPaths);
  }
  await ctx.refresh();
}

/**
 * Handler for creating a branch with review
 */
export async function handleCreateBranchWithReview(
  ctx: MessageHandlerContext,
  payload: { submodules: string[]; branchName: string; baseBranch: string }
): Promise<void> {
  const results = await ctx.gitOps.createBranchAcrossSubmodules(
    payload.submodules,
    payload.branchName,
    payload.baseBranch,
    true
  );

  // Convert results map to array for sending to webview
  const resultsArray: Array<{ repository: string; success: boolean; message: string }> = [];
  results.forEach((result, submodulePath) => {
    resultsArray.push({
      repository: submodulePath,
      success: result.success,
      message: result.message
    });
  });

  // Send results to webview for review
  await sendToWebview(ctx, {
    type: 'branchCreationResults',
    payload: {
      branchName: payload.branchName,
      results: resultsArray
    }
  });

  const successfulPaths = resultsArray
    .filter(result => result.success)
    .map(result => result.repository);
  if (successfulPaths.length > 0) {
    await ctx.reloadDashboardHistory(successfulPaths);
  }
  await ctx.refresh();
}

/**
 * Fallback branches when getBranches fails
 */
const FALLBACK_BRANCHES = [
  { name: 'main', isCurrent: false, isRemote: false },
  { name: 'master', isCurrent: false, isRemote: false },
  { name: 'develop', isCurrent: false, isRemote: false }
];

/**
 * Handler for getting base branches for create modal
 */
export async function handleGetBaseBranchesForCreate(ctx: MessageHandlerContext): Promise<void> {
  let branches = FALLBACK_BRANCHES;

  try {
    const result = await ctx.gitOps.getBranches('.');
    if (result && result.length > 0) {
      branches = result;
    }
  } catch (error) {
    console.error('[RepositoryManager] Error getting base branches:', error);
  }

  // Always send the response, whether we got real branches or fallback
  await sendToWebview(ctx, {
    type: 'baseBranchesForCreate',
    payload: { branches }
  });
}

/**
 * Handler for pushing created branches
 */
export async function handlePushCreatedBranches(
  ctx: MessageHandlerContext,
  payload: { submodules: string[]; branchName: string }
): Promise<void> {
  if (!payload || !Array.isArray(payload.submodules) || typeof payload.branchName !== 'string' || !payload.branchName) {
    return;
  }
  const results: Array<{ submodule: string; success: boolean; message: string }> = [];

  for (const submodulePath of payload.submodules) {
    try {
      // The branch just created, by name: not whatever happens to be checked out by now.
      const result = await ctx.gitOps.pushChanges(submodulePath, payload.branchName);
      results.push({ submodule: submodulePath, success: result.success, message: result.message });
    } catch (error) {
      results.push({ submodule: submodulePath, success: false, message: error instanceof Error ? error.message : 'Unknown error' });
    }
  }

  const pushed = results.filter(result => result.success);
  const failed = results.filter(result => !result.success);
  if (!failed.length) {
    vscode.window.showInformationMessage(`Branch '${payload.branchName}' pushed to ${pushed.length} remote(s)`);
  } else {
    // Each failure with Git's own reason: rejected, no remote, no access.
    vscode.window.showWarningMessage(
      `Pushed '${payload.branchName}' to ${pushed.length}/${results.length} remotes. ` +
      failed.map(result => `${result.submodule}: ${result.message}`).join(' · ')
    );
  }

  // The new origin/<branch> is a ref the history shows; a push moves no HEAD, so reload it.
  if (pushed.length) {
    await ctx.reloadDashboardHistory(pushed.map(result => result.submodule));
  }
  await ctx.refresh();
}

/**
 * Handler for checking out a branch
 */
export async function handleCheckoutBranch(
  ctx: MessageHandlerContext,
  payload: { submodule: string; branch: string; replaceWithRemote?: boolean }
): Promise<void> {
  if (payload.replaceWithRemote) {
    const confirm = await vscode.window.showWarningMessage(
      `Replace local branch '${payload.branch}' with 'origin/${payload.branch}'? Local-only commits will be discarded.`,
      { modal: true },
      'Use origin'
    );
    if (confirm !== 'Use origin') {
      await sendToWebview(ctx, {
        type: 'branchCheckoutResult',
        payload: {
          repositoryPath: payload.submodule,
          branch: payload.branch,
          success: false,
          cancelled: true,
          message: 'Branch replacement cancelled'
        }
      });
      return;
    }
  }

  const result = await ctx.gitOps.checkoutBranch(
    payload.submodule,
    payload.branch,
    payload.replaceWithRemote === true
  );
  showResult(result.success, result.message);
  await ctx.refresh();
  await sendToWebview(ctx, {
    type: 'branchCheckoutResult',
    payload: {
      repositoryPath: payload.submodule,
      branch: payload.branch,
      success: result.success,
      message: result.message
    }
  });
}

/**
 * Handler for pulling changes
 */
export async function handlePullChanges(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const result = await ctx.gitOps.pullChanges(payload.submodule);
  showResult(result.success, result.message);
  try {
    await ctx.refresh();
  } finally {
    // Always report back so the toolbar button leaves its busy state.
    await sendToWebview(ctx, {
      type: 'repositoryOperationResult',
      payload: { operation: 'pull', repositoryPath: payload.submodule, ...result }
    });
  }
}

/**
 * Handler for pushing changes
 */
export async function handlePushChanges(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const result = await ctx.gitOps.pushChanges(payload.submodule);
  showResult(result.success, result.message);
  try {
    await ctx.refresh();
  } finally {
    // Always report back so the toolbar button leaves its busy state.
    await sendToWebview(ctx, {
      type: 'repositoryOperationResult',
      payload: { operation: 'push', repositoryPath: payload.submodule, ...result }
    });
  }
}

/**
 * Handler for fetching remote refs without modifying the working tree.
 */
export async function handleFetchUpdates(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const result = await ctx.gitOps.fetchUpdates(payload.submodule);
  showResult(result.success, result.message);
  try {
    await ctx.refresh();
  } finally {
    // Always report back so the toolbar button leaves its busy state.
    await sendToWebview(ctx, {
      type: 'repositoryOperationResult',
      payload: { operation: 'fetch', repositoryPath: payload.submodule, ...result }
    });
  }
}

/**
 * Handler for syncing versions
 */
export async function handleSyncVersions(
  ctx: MessageHandlerContext,
  payload: { submodules: string[] }
): Promise<void> {
  // Sync only the selected submodules, or all if none selected
  const submodulesToSync = payload.submodules.length > 0 ? payload.submodules : undefined;
  const results = await ctx.gitOps.syncAllSubmodules(submodulesToSync);
  let successCount = 0;
  const errors: string[] = [];

  results.forEach((result, submodulePath) => {
    if (result.success) {
      successCount++;
    } else {
      errors.push(`${submodulePath}: ${result.message}`);
    }
  });

  if (errors.length === 0) {
    vscode.window.showInformationMessage(
      `Successfully synced ${successCount} repository/repositories to recorded commits`
    );
  } else {
    // Show detailed error message
    const errorSummary = errors.length <= 3
      ? errors.join(' | ')
      : `${errors.slice(0, 2).join(' | ')} and ${errors.length - 2} more`;
    vscode.window.showWarningMessage(
      `Synced ${successCount}/${results.size}. Failed: ${errorSummary}`
    );
  }
  await ctx.refresh();
  // HEADs moved: reload history, refs and commit detail if one of these repositories is on screen.
  await ctx.reloadDashboardHistory(Array.from(results.keys()));
}

/**
 * Handler for resetting one linked repository to the commit the parent records,
 * after a modal confirmation.
 */
export async function handleSyncRepositoryToRecorded(
  ctx: MessageHandlerContext,
  payload: unknown
): Promise<void> {
  const repositoryPath = requireString(requireRecord(payload), 'repositoryPath');
  const repository = (await ctx.gitOps.getSubmodules()).find(item => item.path === repositoryPath);
  const recordedCommit = repository ? await ctx.gitOps.getRecordedCommit(repositoryPath) : '';
  if (!repository || !recordedCommit) {
    vscode.window.showErrorMessage(`No recorded commit found for '${repositoryPath}'.`);
    return;
  }

  const onBranch = repository.currentBranch
    ? `Branch '${repository.currentBranch}' keeps its commits; ${repository.name} will be on a detached HEAD.`
    : `${repository.name} stays on a detached HEAD.`;
  const changes = repository.hasChanges
    ? ' It has uncommitted changes, which Git will refuse to overwrite if they conflict.'
    : '';
  const confirm = 'Reset to recorded';
  const choice = await vscode.window.showWarningMessage(
    `Reset ${repository.name} to the recorded commit ${recordedCommit.substring(0, 8)}?`,
    { modal: true, detail: `HEAD is at ${repository.currentCommit}. ${onBranch}${changes}` },
    confirm
  );
  if (choice !== confirm) {
    return;
  }

  // Act only on the commit the user confirmed; the parent may have moved while the modal was open.
  if (await ctx.gitOps.getRecordedCommit(repositoryPath) !== recordedCommit) {
    vscode.window.showErrorMessage(
      `The recorded commit changed while confirming; ${repository.name} was not reset. Review it and try again.`
    );
    await ctx.refresh();
    return;
  }
  const result = await ctx.gitOps.syncSubmodule(repositoryPath, recordedCommit);
  showResult(result.success, result.success
    ? `Reset ${repository.name} to the recorded commit ${recordedCommit.substring(0, 8)}`
    : result.message);
  await ctx.refresh();
  // HEAD moved: reload history, refs and commit detail if this repository is on screen.
  await ctx.reloadDashboardHistory([repositoryPath]);
}

/**
 * Handler for creating a PR
 */
export async function handleCreatePR(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  await ctx.prManager.createPRWithGitHub(payload.submodule);
}

/**
 * Handler for opening a submodule in explorer
 */
export async function handleOpenSubmodule(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const fullPath = path.join(ctx.workspaceRoot, payload.submodule);
  const uri = vscode.Uri.file(fullPath);
  await vscode.commands.executeCommand('revealInExplorer', uri);
}

/**
 * Handler for staging a submodule
 */
export async function handleStageSubmodule(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const result = await ctx.gitOps.stageSubmodule(payload.submodule);
  showResult(result.success, result.message);
}

/**
 * Handler for getting branches
 */
export async function handleGetBranches(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  let branches = [
    { name: 'main', isCurrent: false, isRemote: false },
    { name: 'master', isCurrent: false, isRemote: false }
  ];

  try {
    const result = await ctx.gitOps.getBranches(payload.submodule);
    if (result && result.length > 0) {
      branches = result;
    }
  } catch (error) {
    console.error('[RepositoryManager] Error getting branches:', error);
  }

  await sendToWebview(ctx, {
    type: 'branches',
    payload: { submodule: payload.submodule, branches }
  });
}

/**
 * Handler for checking out a commit
 */
export async function handleCheckoutCommit(
  ctx: MessageHandlerContext,
  payload: { submodule: string; commit: string; fromHistory?: boolean }
): Promise<void> {
  if (payload.fromHistory) {
    const decision = await vscode.window.showWarningMessage(
      `Checkout ${payload.commit.slice(0, 12)} in ${payload.submodule}? This will leave HEAD detached.`,
      { modal: true }, 'Checkout commit'
    );
    if (decision !== 'Checkout commit') {
      return;
    }
  }
  const result = await ctx.gitOps.checkoutCommit(payload.submodule, payload.commit, payload.fromHistory);
  showResult(result.success, result.message);
  if (result.success) {
    await ctx.reloadDashboardHistory([payload.submodule]);
  }
  await ctx.refresh();
}

export async function handleCreateBranchFromCommit(ctx: MessageHandlerContext, payload: {
  repositoryPath: string; branchName: string; commit: string; checkout: boolean
}): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string' || typeof payload.branchName !== 'string' ||
      typeof payload.commit !== 'string' || typeof payload.checkout !== 'boolean') {
    return;
  }
  const result = await ctx.gitOps.createBranchFromCommit(payload.repositoryPath, payload.branchName, payload.commit, payload.checkout);
  if (result.success && (result.data as { checkoutFailed?: boolean } | undefined)?.checkoutFailed) {
    vscode.window.showWarningMessage(result.message);
  } else {
    showResult(result.success, result.message);
  }
  if (result.success) {
    await ctx.reloadDashboardHistory([payload.repositoryPath]);
    await ctx.refresh();
  }
}

export async function handleCopyHistoryCommit(ctx: MessageHandlerContext, payload: {
  repositoryPath: string; commit: string; field: 'hash' | 'subject'
}): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string' || typeof payload.commit !== 'string' ||
      (payload.field !== 'hash' && payload.field !== 'subject')) {
    return;
  }
  const git = new GitCommandService(ctx.workspaceRoot);
  const sha = await git.resolveRevision(payload.repositoryPath, payload.commit);
  const text = payload.field === 'hash' ? sha : await git.execGit(['show', '-s', '--format=%s', sha], git.resolveRepositoryPath(payload.repositoryPath));
  await vscode.env.clipboard.writeText(text);
}

export async function handleCreateTagFromCommit(ctx: MessageHandlerContext, payload: {
  repositoryPath: string; commit: string
}): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string' || typeof payload.commit !== 'string') {
    return;
  }
  const git = new GitCommandService(ctx.workspaceRoot);
  const sha = await git.resolveRevision(payload.repositoryPath, payload.commit);
  const name = await vscode.window.showInputBox({
    title: `Add annotated tag at ${sha.slice(0, 12)}`,
    prompt: `Repository: ${payload.repositoryPath}`,
    placeHolder: 'e.g. v1.4.0',
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'Enter a tag name.'
  });
  if (name === undefined) {
    return;
  }
  const message = await vscode.window.showInputBox({
    title: `Message for tag ${name}`,
    prompt: `Tag ${sha.slice(0, 12)} in ${payload.repositoryPath} (local only)`,
    ignoreFocusOut: true,
    validateInput: value => value.trim() ? undefined : 'Enter a tag message.'
  });
  if (message === undefined) {
    return;
  }
  const result = await ctx.gitOps.createAnnotatedTag(payload.repositoryPath, name, message, sha);
  showResult(result.success, result.message);
  if (result.success) {
    await ctx.reloadDashboardHistory([payload.repositoryPath]);
    await ctx.refresh();
  }
}

/**
 * What Git predicts the action will stop on, for its confirmation dialog: simulated in memory
 * (ConflictPredictionService), so it is a fact, not a guess. A failed simulation never blocks the
 * action; the dialog just says nothing was predicted.
 */
async function predictConflicts(ctx: MessageHandlerContext, repositoryPath: string, operation: PredictedOperation,
  commit: string, mainline?: number): Promise<{ text: string; prediction?: ConflictPrediction }> {
  let prediction: ConflictPrediction;
  try {
    prediction = await new ConflictPredictionService(new GitCommandService(ctx.workspaceRoot)).predict(repositoryPath, operation, commit, mainline);
  } catch (error) {
    return { text: `Conflicts were not predicted: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!prediction.supported) {
    return { text: `Conflicts were not predicted: ${prediction.reason}` };
  }
  if (!prediction.conflicts.length) {
    return { prediction, text: prediction.steps > 1 ? `Predicted by Git: no conflicts in the ${prediction.steps} commits replayed.` : 'Predicted by Git: no conflicts.' };
  }
  return { prediction, text: prediction.conflicts.map(conflict => {
    const where = prediction.steps > 1 ? ` (commit ${prediction.replayed + 1} of ${prediction.steps})` : '';
    // A conflict that is not about lines (a file deleted on one side) says so: it is resolved differently.
    const named = conflict.paths.map(path => {
      const kinds = (conflict.kinds[path] || []).filter(kind => kind !== 'contents' && kind !== 'content');
      return kinds.length ? `${path} (${kinds.join(', ')})` : path;
    });
    const files = named.length > 8 ? `${named.slice(0, 8).join(', ')} and ${named.length - 8} more` : named.join(', ');
    return `Predicted by Git: conflicts at ${conflict.commit.slice(0, 12)} ${conflict.subject}${where} in ${files}.` +
      (prediction.stoppedEarly ? ' Later commits depend on how this is resolved, so they were not predicted.' : '') +
      ' You resolve them in Source Control, then continue or abort.';
  }).join('\n') };
}

const EXPLAIN_CONFLICTS = 'Explain conflicts';

/**
 * The action's confirmation. When Git predicted conflicts and Copilot is available, it also offers
 * Explain conflicts: Copilot's reading is added to the same question, which is asked again, so the
 * user decides with it in front of them. A failed explanation says so and still lets the action run.
 */
async function confirmHistoryAction(ctx: MessageHandlerContext, repositoryPath: string, question: string, detail: string,
  label: string, prediction: ConflictPrediction | undefined): Promise<boolean> {
  const explainer = ctx.conflictExplainer;
  const explainable = Boolean(explainer && prediction && prediction.conflicts.length);
  const first = await vscode.window.showWarningMessage(question, { modal: true, detail }, label, ...(explainable ? [EXPLAIN_CONFLICTS] : []));
  if (first !== EXPLAIN_CONFLICTS || !explainer || !prediction) {
    return first === label;
  }
  const outcome = await explainPredictedConflicts(explainer, new GitCommandService(ctx.workspaceRoot), repositoryPath, prediction,
    work => Promise.resolve(vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: 'Explaining the predicted conflicts with Copilot…', cancellable: true }, (_progress, token) => work(token))));
  if (outcome.kind === 'cancelled') {
    return false;
  }
  const conflict = prediction.conflicts[0];
  const reading = outcome.kind === 'explained'
    ? formatConflictExplanation(outcome.explanation, describeSides(prediction, conflict), outcome.model,
      conflict.paths.filter(path => !outcome.explanation.files.some(file => file.path === path)))
    : `Copilot could not explain the conflicts: ${outcome.message}`;
  const again = await vscode.window.showWarningMessage(question, { modal: true, detail: `${detail}\n\n${reading}` }, label);
  return again === label;
}

const SUGGEST_RESOLUTION = 'Suggest resolution';
const APPLY_SUGGESTION = 'Apply suggestion';

/**
 * Suggest resolution for one conflicted file (services/conflictResolution.ts): Copilot resolves each
 * conflict block, code checks each side's change, the result is shown as a diff, and Apply writes the
 * file only, if it has not changed meanwhile. It is never staged and the operation never continues.
 * Returns false when the user stopped, so a run over several files ends there.
 */
export async function handleSuggestConflictResolution(ctx: MessageHandlerContext, payload: { repositoryPath: string; path: string }): Promise<boolean> {
  if (!payload || typeof payload.repositoryPath !== 'string' || typeof payload.path !== 'string' || !payload.path) {
    return false;
  }
  const copilot = ctx.conflictExplainer;
  if (!copilot) {
    showResult(false, 'Suggesting a resolution needs Copilot in VS Code.');
    return false;
  }
  const git = new GitCommandService(ctx.workspaceRoot);
  const root = git.resolveRepositoryPath(payload.repositoryPath);
  let file;
  try {
    file = await readConflictedFile(git, payload.repositoryPath, payload.path);
  } catch (error) {
    showResult(false, error instanceof Error ? error.message : String(error));
    return true;
  }
  if (!await confirmSending(copilot, root, SUGGEST_RESOLUTION, `Suggest a resolution for ${file.path} with Copilot?`,
    `Its ${file.blocks.length} conflict${file.blocks.length === 1 ? '' : 's'}, both sides and the base, and the file around them (up to 60 KB) ` +
      'are sent to the selected Copilot model. Nothing is written until you apply the suggestion.')) {
    return false;
  }
  let suggestion;
  try {
    suggestion = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification,
      title: `Suggesting a resolution for ${file.path} with Copilot…`, cancellable: true }, async (_progress, token) => {
      const reply = await copilot.complete(buildResolutionPrompt(file, copilot.language()), token, 120000);
      if (token.isCancellationRequested) { return undefined; }
      return { ...parseResolutions(reply.text, file.blocks), model: reply.model };
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'Cancelled') { showResult(false, `No suggestion for ${file.path}: ${message}`); }
    return message !== 'Cancelled';
  }
  if (!suggestion) {
    return false;
  }
  // The file keeps its own line endings (Git's versions are usually LF; Windows checkouts often CRLF).
  const merged = spliceResolutions(file.merged, file.blocks, suggestion.resolutions);
  const proposed = file.current.includes('\r\n') ? merged.replace(/\r?\n/g, '\r\n') : merged;
  await ctx.showProposedFile?.(file.path, file.current, proposed);
  const check = checkResolution(file.blocks, suggestion.resolutions);
  const answer = await vscode.window.showWarningMessage(`Apply the suggested resolution to ${file.path}?`,
    { modal: true, detail: describeSuggestion(file, check, suggestion.resolutions, suggestion.summary, suggestion.model) }, APPLY_SUGGESTION);
  if (answer !== APPLY_SUGGESTION) {
    return false;
  }
  const target = path.join(root, file.path);
  if (fs.readFileSync(target, 'utf8') !== file.current) {
    showResult(false, `${file.path} changed while the suggestion was open, so it was not written. Ask again for a new suggestion.`);
    return true;
  }
  fs.writeFileSync(target, proposed);
  showResult(true, `Wrote the suggested resolution to ${file.path}. It is not staged: check it, then stage it and continue in Source Control.`);
  await ctx.refresh();
  return true;
}

/** Suggest resolution for each file still in conflict, one at a time, until the user stops. */
async function suggestForConflictedFiles(ctx: MessageHandlerContext, repositoryPath: string): Promise<void> {
  const git = new GitCommandService(ctx.workspaceRoot);
  const conflicted = (await git.execGitRaw(['diff', '--name-only', '-z', '--diff-filter=U'], git.resolveRepositoryPath(repositoryPath), 10000)
    .catch(() => '')).split('\0').filter(Boolean);
  for (const filePath of [...new Set(conflicted)]) {
    if (!await handleSuggestConflictResolution(ctx, { repositoryPath, path: filePath })) { return; }
  }
}

export async function handleApplyHistoryCommit(ctx: MessageHandlerContext, payload: {
  repositoryPath: string; commit: string; operation: HistoryAction
}): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string' || typeof payload.commit !== 'string' ||
      !['cherry-pick', 'revert', 'merge'].includes(payload.operation)) {
    return;
  }
  const { sha, branch, parents } = await ctx.gitOps.describeHistoryCommit(payload.repositoryPath, payload.commit);
  let mainline: number | undefined;
  if (payload.operation !== 'merge' && parents.length > 1) {
    const picked = await vscode.window.showQuickPick(parents.map((parent, index) => ({
      label: `Parent ${index + 1} · ${parent.slice(0, 12)}`,
      description: index === 0 ? 'First parent' : undefined,
      index: index + 1
    })), { title: `Choose the mainline parent for ${payload.operation}`, placeHolder: 'Select the parent to compare the merge against' });
    if (!picked) {
      return;
    }
    mainline = picked.index;
  }
  const label = payload.operation === 'cherry-pick' ? 'Cherry pick' : payload.operation === 'revert' ? 'Revert' : 'Merge';
  const predicted = await predictConflicts(ctx, payload.repositoryPath, payload.operation, sha, mainline);
  const approved = await confirmHistoryAction(ctx, payload.repositoryPath,
    `${label} ${sha.slice(0, 12)} ${payload.operation === 'merge' ? 'into' : 'on'} ${branch} in ${payload.repositoryPath}?`,
    `${predicted.text}\nThe working tree must be clean. Conflicts can be resolved in Source Control.`, label, predicted.prediction);
  if (!approved) {
    return;
  }
  const git = new GitCommandService(ctx.workspaceRoot);
  const headBefore = await git.resolveRevision(payload.repositoryPath, 'HEAD');
  const result = await ctx.gitOps.applyHistoryCommit(payload.repositoryPath, sha, payload.operation, mainline, branch);
  const pending = (result.data as { pending?: HistoryAction } | undefined)?.pending;
  if (pending) {
    const choice = await vscode.window.showWarningMessage(result.message, ...(ctx.conflictExplainer ? [SUGGEST_RESOLUTION] : []), 'Abort operation');
    if (choice === 'Abort operation') {
      const aborted = await ctx.gitOps.abortHistoryAction(payload.repositoryPath, pending);
      showResult(aborted.success, aborted.message);
    } else if (choice === SUGGEST_RESOLUTION) {
      await suggestForConflictedFiles(ctx, payload.repositoryPath);
    }
  } else {
    showResult(result.success, result.message);
  }
  const headAfter = pending ? await git.resolveRevision(payload.repositoryPath, 'HEAD') : headBefore;
  if (result.success || (pending && headAfter !== headBefore)) {
    await ctx.reloadDashboardHistory([payload.repositoryPath]);
  }
  await ctx.refresh();
}

export async function handleRewriteHistoryCommit(ctx: MessageHandlerContext, payload: {
  repositoryPath: string; commit: string; action: HistoryRewriteAction
}): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string' || typeof payload.commit !== 'string' ||
      !['rebase', 'reset', 'drop'].includes(payload.action)) {
    return;
  }
  try {
    const preview = await ctx.gitOps.previewHistoryRewrite(payload.repositoryPath, payload.commit, payload.action);
    let mode: ResetMode | undefined;
    if (payload.action === 'reset') {
      const selection = await vscode.window.showQuickPick([
        { label: 'Soft', description: 'Move HEAD; keep index and working files', value: 'soft' as const },
        { label: 'Mixed', description: 'Move HEAD and reset index; keep working files', value: 'mixed' as const },
        { label: 'Hard', description: 'Move HEAD, index and working files; create backup branch first', value: 'hard' as const }
      ], { title: `Reset ${preview.branch} to ${preview.target.slice(0, 12)}`, placeHolder: 'Choose reset mode' });
      if (!selection) {
        return;
      }
      mode = selection.value;
    }
    const label = payload.action === 'rebase' ? 'Rebase' : payload.action === 'drop' ? 'Drop commit' : `Reset (${mode})`;
    const shown = preview.affected.map(item => `${item.hash.slice(0, 12)} ${item.subject}`).join('\n');
    const more = preview.affectedCount > preview.affected.length ? `\n… and ${preview.affectedCount - preview.affected.length} more` : '';
    const detail = `Repository: ${payload.repositoryPath}\nCurrent branch: ${preview.branch}\n` +
      `HEAD: ${preview.head}\nSelected: ${preview.target} ${preview.targetSubject}\n` +
      `${payload.action === 'drop' ? 'Commits replayed after dropping the selected commit' : 'Commits affected'} (${preview.affectedCount}):` +
      `\n${shown || '(none)'}${more}\nWorking tree must be clean. ` +
      `${payload.action === 'drop' || mode === 'hard' ? 'A local backup branch will be created.' : 'Commits may receive new hashes.'}`;
    // Reset never conflicts: nothing to predict.
    const predicted = payload.action === 'reset' ? undefined : await predictConflicts(ctx, payload.repositoryPath, payload.action, preview.target);
    const approved = await confirmHistoryAction(ctx, payload.repositoryPath, `${label} on ${preview.branch}?`,
      predicted ? `${detail}\n${predicted.text}` : detail, label, predicted?.prediction);
    if (!approved) {
      return;
    }
    if (mode === 'hard') {
      const confirmation = await vscode.window.showInputBox({
        title: `Confirm hard reset of ${preview.branch}`, prompt: `Type ${preview.branch} to confirm`,
        ignoreFocusOut: true, validateInput: value => value === preview.branch ? undefined : 'Type the current branch name.'
      });
      if (confirmation !== preview.branch) {
        return;
      }
    }
    const result = await ctx.gitOps.executeHistoryRewrite(payload.repositoryPath, preview.target, payload.action,
      preview.branch, preview.head, mode);
    const pending = (result.data as { pending?: string } | undefined)?.pending;
    let resolved = false;
    if (pending === 'rebase') {
      const choice = await vscode.window.showWarningMessage(result.message, ...(ctx.conflictExplainer ? [SUGGEST_RESOLUTION] : []),
        'Continue rebase', 'Abort rebase');
      if (choice === SUGGEST_RESOLUTION) {
        await suggestForConflictedFiles(ctx, payload.repositoryPath);
      } else if (choice) {
        const recovery = await ctx.gitOps.resolveHistoryRebase(payload.repositoryPath, choice === 'Continue rebase' ? 'continue' : 'abort');
        showResult(recovery.success, recovery.message);
        resolved = recovery.success;
      }
    } else {
      showResult(result.success, result.message);
    }
    const headAfter = await new GitCommandService(ctx.workspaceRoot).resolveRevision(payload.repositoryPath, 'HEAD');
    if (result.success || resolved || headAfter !== preview.head) {
      await ctx.reloadDashboardHistory([payload.repositoryPath]);
    }
    await ctx.refresh();
  } catch (error) {
    showResult(false, error instanceof Error ? error.message : String(error));
  }
}

/**
 * Apply, Pop or Drop the stash selected in the dashboard. Only Drop asks first: Apply and Pop
 * leave the stash's changes in the working tree (Pop keeps the stash when they conflict), while
 * Drop throws them away. After Apply or Pop the dashboard opens the uncommitted changes.
 */
export async function handleStashAction(ctx: MessageHandlerContext, payload: {
  repositoryPath: string; stash: string; operation: StashOperation
}): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string' || typeof payload.stash !== 'string' ||
      !STASH_OPERATIONS.includes(payload.operation)) {
    return;
  }
  if (payload.operation === 'drop') {
    let stash;
    try {
      stash = await ctx.gitOps.describeStash(payload.repositoryPath, payload.stash);
    } catch (error) {
      showResult(false, error instanceof Error ? error.message : String(error));
      return;
    }
    const approved = await vscode.window.showWarningMessage(
      `Drop ${stash.ref}${stash.message ? ` (${stash.message})` : ''}?`,
      { modal: true, detail: `Its changes are deleted without being applied. Repository: ${payload.repositoryPath}` },
      'Drop stash');
    if (approved !== 'Drop stash') {
      return;
    }
  }
  const result = await ctx.gitOps.runStashAction(payload.repositoryPath, payload.stash, payload.operation);
  const data = result.data as StashActionData | undefined;
  if (data && (data.changedWorkingTree || data.removedStash)) {
    await sendToWebview(ctx, { type: 'stashActionCompleted', payload: { repositoryPath: payload.repositoryPath,
      operation: payload.operation, changedWorkingTree: data.changedWorkingTree, removedStash: data.removedStash } });
  }
  if (data && data.conflicts && data.conflicts.length) {
    void vscode.window.showWarningMessage(result.message, 'Open Source Control').then(choice => {
      if (choice) { void vscode.commands.executeCommand('workbench.view.scm'); }
    });
  } else {
    showResult(result.success, result.message);
  }
  if (result.success || (data && data.changedWorkingTree)) {
    await ctx.reloadDashboardHistory([payload.repositoryPath]);
  }
  await ctx.refresh();
}

/**
 * Discard Changes, from the uncommitted changes' context menus: one file (`paths`) or every change
 * (`all`). Always asked first, from the host, naming what goes and that new files are deleted; the
 * service keeps a copy before it changes anything, and its message says how to bring files back.
 */
export async function handleDiscardChanges(ctx: MessageHandlerContext, payload: {
  repositoryPath: string; paths?: string[]; all?: boolean
}): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string') { return; }
  const paths = Array.isArray(payload.paths) ? payload.paths.filter((item): item is string => typeof item === 'string' && item.length > 0) : undefined;
  if (payload.all !== true && !(paths && paths.length)) { return; }
  const target = payload.all === true ? undefined : paths;
  let plan;
  try {
    plan = await ctx.gitOps.planDiscard(payload.repositoryPath, target);
  } catch (error) {
    showResult(false, error instanceof Error ? error.message : String(error));
    return;
  }
  const count = plan.restored.length + plan.deleted.length;
  if (!count) {
    const why = plan.skipped.map(item => `${item.path} is ${item.reason}`).join('; ');
    showResult(false, `Nothing to discard${why ? `: ${why}` : ''}.`);
    return;
  }
  const single = target && count === 1 ? plan.restored[0] || plan.deleted[0] : undefined;
  const label = single ? 'Discard' : 'Discard all';
  const question = single
    ? `Discard changes to ${single}?`
    : `Discard all ${count} changed file${count === 1 ? '' : 's'} in ${payload.repositoryPath}?`;
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  const newFiles = (n: number) => `${n} new file${n === 1 ? ' is' : 's are'}`;
  const shownDeleted = plan.deleted.slice(0, 5).join(', ') + (plan.deleted.length > 5 ? ', …' : '');
  const lines: string[] = [];
  if (plan.restored.length) {
    lines.push(single ? 'Staged and unstaged changes go back to HEAD.'
      : `${files(plan.restored.length)} ${plan.restored.length === 1 ? 'goes' : 'go'} back to HEAD.`);
  }
  if (plan.deleted.length) {
    lines.push(single ? 'This new file is deleted.' : `${newFiles(plan.deleted.length)} deleted: ${shownDeleted}.`);
  }
  if (plan.skipped.length) {
    lines.push(`Left alone: ${plan.skipped.map(item => `${item.path} (${item.reason})`).join('; ')}.`);
  }
  lines.push('A copy is kept first, and the message after says how to bring the files back.');
  const approved = await vscode.window.showWarningMessage(question, { modal: true, detail: lines.join('\n') }, label);
  if (approved !== label) { return; }
  // Exactly the files the question named: one that appeared while it was open is not deleted unseen.
  const result = await ctx.gitOps.discardChanges(payload.repositoryPath, [...plan.restored, ...plan.deleted]);
  showResult(result.success, result.message);
  await ctx.reloadDashboardHistory([payload.repositoryPath]);
  await ctx.refresh();
}

/**
 * Report which Git operation is paused in a repository, so the history menu only offers
 * Continue/Abort rebase while a rebase is actually in progress.
 */
export async function handleGetPendingOperation(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const repositoryPath = requireString(requireRecord(payload), 'repositoryPath');
  const operation = await ctx.gitOps.getPendingOperation(repositoryPath).catch(() => undefined);
  await sendToWebview(ctx, { type: 'pendingOperationLoaded', payload: { repositoryPath, operation: operation || null } });
}

export async function handleResolveHistoryRebase(ctx: MessageHandlerContext, payload: {
  repositoryPath: string; command: 'continue' | 'abort'
}): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string' || !['continue', 'abort'].includes(payload.command)) {
    return;
  }
  if (payload.command === 'abort') {
    const confirmed = await vscode.window.showWarningMessage(
      `Abort the rebase in ${payload.repositoryPath}?`, { modal: true }, 'Abort rebase');
    if (confirmed !== 'Abort rebase') {
      return;
    }
  }
  const git = new GitCommandService(ctx.workspaceRoot);
  const headBefore = await git.resolveRevision(payload.repositoryPath, 'HEAD');
  const result = await ctx.gitOps.resolveHistoryRebase(payload.repositoryPath, payload.command);
  showResult(result.success, result.message);
  const headAfter = await git.resolveRevision(payload.repositoryPath, 'HEAD');
  if (result.success || headAfter !== headBefore) {
    await ctx.reloadDashboardHistory([payload.repositoryPath]);
  }
  await ctx.refresh();
}

/**
 * Handler for getting commits
 */
export async function handleGetCommits(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const commits = await ctx.gitOps.getRecentCommits(payload.submodule, 20);
  await sendToWebview(ctx, {
    type: 'commits',
    payload: { submodule: payload.submodule, commits }
  });
}

/**
 * Handler for getting recorded commit
 */
export async function handleGetRecordedCommit(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const recordedCommit = await ctx.gitOps.getRecordedCommit(payload.submodule);
  const currentCommit = await ctx.gitOps.getCurrentCommit(payload.submodule);
  await sendToWebview(ctx, {
    type: 'recordedCommit',
    payload: {
      submodule: payload.submodule,
      recordedCommit,
      currentCommit,
      isMatching: recordedCommit === currentCommit
    }
  });
}

/**
 * Handler for updating to recorded commit
 */
export async function handleUpdateToRecorded(
  ctx: MessageHandlerContext,
  payload: { submodule: string }
): Promise<void> {
  const result = await ctx.gitOps.updateToRecordedCommit(payload.submodule);
  showResult(result.success, result.message);
  await ctx.refresh();
}

/**
 * Handler for deleting a branch
 */
export async function handleDeleteBranch(
  ctx: MessageHandlerContext,
  payload: { submodule: string; branch: string; hasRemote?: boolean }
): Promise<void> {
  // One VS Code dialog asks both questions. The webview's own confirm() is not used: a sandboxed
  // webview may ignore browser dialogs (it then returns false), and the branch list need not sit
  // in the dashboard.
  const LOCAL = 'Delete Local Branch';
  const BOTH = `Delete Local and origin/${payload.branch}`;
  const choice = await vscode.window.showWarningMessage(
    `Delete branch '${payload.branch}' in ${payload.submodule}?`,
    { modal: true, detail: payload.hasRemote
      ? `origin/${payload.branch} also exists. Deleting it there affects everyone who uses the remote.`
      : 'The branch is deleted even if it has commits that are not merged anywhere.' },
    ...(payload.hasRemote ? [LOCAL, BOTH] : [LOCAL])
  );

  if (choice !== LOCAL && choice !== BOTH) {
    return;
  }

  const result = await ctx.gitOps.deleteBranch(payload.submodule, payload.branch, choice === BOTH);
  showResult(result.success, result.message);

  // Refresh the inline branch list plus the active dashboard refs and history.
  if (result.success) {
    try {
      const branches = await ctx.gitOps.getBranches(payload.submodule);
      await sendToWebview(ctx, {
        type: 'branches',
        payload: { submodule: payload.submodule, branches }
      });
    } catch {
      // The regular repository refresh below remains as a fallback.
    }
    await ctx.reloadDashboardHistory([payload.submodule]);
  }

  await ctx.refresh();
}

/**
 * Handler for setting rebase status
 */
export async function handleSetRebaseStatus(
  ctx: MessageHandlerContext,
  payload: { submodule: string; isRebasing: boolean }
): Promise<void> {
  await sendToWebview(ctx, {
    type: 'rebaseStatusUpdated',
    payload: { submodule: payload.submodule, isRebasing: payload.isRebasing }
  });
}

/**
 * Message handler map for quick lookup
 */
export const messageHandlers: Record<string, (ctx: MessageHandlerContext, payload?: unknown) => Promise<void>> = {
  'getHistory': (ctx, payload) => handleGetHistory(ctx, payload),
  'getCommitDetail': (ctx, payload) => handleGetCommitDetail(ctx, payload),
  'getFileDiff': (ctx, payload) => handleGetFileDiff(ctx, payload),
  'getRepositoryRefs': (ctx, payload) => handleGetRepositoryRefs(ctx, payload),
  'getWorkingTreeChanges': (ctx, payload) => handleGetWorkingTreeChanges(ctx, payload),
  'getWorkingTreePreview': (ctx, payload) => handleGetWorkingTreePreview(ctx, payload),
  'commitFiles': (ctx, payload) => handleCommitFiles(ctx, payload),
  'initSubmodules': (ctx) => handleInitSubmodules(ctx),
  'updateSubmodules': (ctx) => handleUpdateSubmodules(ctx),
  'createBranch': (ctx, payload) => handleCreateBranch(ctx, payload as { submodules: string[]; branchName: string; baseBranch: string }),
  'createBranchWithReview': (ctx, payload) => handleCreateBranchWithReview(ctx, payload as { submodules: string[]; branchName: string; baseBranch: string }),
  'getBaseBranchesForCreate': (ctx) => handleGetBaseBranchesForCreate(ctx),
  'pushCreatedBranches': (ctx, payload) => handlePushCreatedBranches(ctx, payload as { submodules: string[]; branchName: string }),
  'checkoutBranch': (ctx, payload) => handleCheckoutBranch(
    ctx,
    payload as { submodule: string; branch: string; replaceWithRemote?: boolean }
  ),
  'pullChanges': (ctx, payload) => handlePullChanges(ctx, payload as { submodule: string }),
  'pushChanges': (ctx, payload) => handlePushChanges(ctx, payload as { submodule: string }),
  'fetchUpdates': (ctx, payload) => handleFetchUpdates(ctx, payload as { submodule: string }),
  'syncVersions': (ctx, payload) => handleSyncVersions(ctx, payload as { submodules: string[] }),
  'syncRepositoryToRecorded': (ctx, payload) => handleSyncRepositoryToRecorded(ctx, payload),
  'createPR': (ctx, payload) => handleCreatePR(ctx, payload as { submodule: string }),
  'openSubmodule': (ctx, payload) => handleOpenSubmodule(ctx, payload as { submodule: string }),
  'stageSubmodule': (ctx, payload) => handleStageSubmodule(ctx, payload as { submodule: string }),
  'getBranches': (ctx, payload) => handleGetBranches(ctx, payload as { submodule: string }),
  'checkoutCommit': (ctx, payload) => handleCheckoutCommit(ctx, payload as { submodule: string; commit: string; fromHistory?: boolean }),
  'createBranchFromCommit': (ctx, payload) => handleCreateBranchFromCommit(ctx, payload as { repositoryPath: string; branchName: string; commit: string; checkout: boolean }),
  'copyHistoryCommit': (ctx, payload) => handleCopyHistoryCommit(ctx, payload as { repositoryPath: string; commit: string; field: 'hash' | 'subject' }),
  'createTagFromCommit': (ctx, payload) => handleCreateTagFromCommit(ctx, payload as { repositoryPath: string; commit: string }),
  'applyHistoryCommit': (ctx, payload) => handleApplyHistoryCommit(ctx, payload as { repositoryPath: string; commit: string; operation: HistoryAction }),
  'rewriteHistoryCommit': (ctx, payload) => handleRewriteHistoryCommit(ctx, payload as { repositoryPath: string; commit: string; action: HistoryRewriteAction }),
  'resolveHistoryRebase': (ctx, payload) => handleResolveHistoryRebase(ctx, payload as { repositoryPath: string; command: 'continue' | 'abort' }),
  'getPendingOperation': (ctx, payload) => handleGetPendingOperation(ctx, payload),
  'discardChanges': (ctx, payload) => handleDiscardChanges(ctx, payload as { repositoryPath: string; paths?: string[]; all?: boolean }),
  'suggestConflictResolution': async (ctx, payload) => { await handleSuggestConflictResolution(ctx, payload as { repositoryPath: string; path: string }); },
  'stashAction': (ctx, payload) => handleStashAction(ctx, payload as { repositoryPath: string; stash: string; operation: StashOperation }),
  'getCommits': (ctx, payload) => handleGetCommits(ctx, payload as { submodule: string }),
  'getRecordedCommit': (ctx, payload) => handleGetRecordedCommit(ctx, payload as { submodule: string }),
  'updateToRecorded': (ctx, payload) => handleUpdateToRecorded(ctx, payload as { submodule: string }),
  'deleteBranch': (ctx, payload) => handleDeleteBranch(ctx, payload as { submodule: string; branch: string; hasRemote?: boolean }),
  'setRebaseStatus': (ctx, payload) => handleSetRebaseStatus(ctx, payload as { submodule: string; isRebasing: boolean })
};
