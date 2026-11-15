/**
 * Webview Message Handler
 * Handles all messages from the webview panel
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { HistoryQuery } from '../types';
import { GitCommandService } from '../services/gitCommandService';
import { HistoryAction } from '../services/historyActionService';
import { HistoryRewriteAction, ResetMode } from '../services/historyRewriteService';
import { ConflictPrediction, ConflictPredictionService, PredictedOperation } from '../services/conflictPredictionService';
import { confirmSending, describeSides, explainPredictedConflicts, formatConflictExplanation } from '../services/conflictExplanation';
import { buildUndoPrompt, collectUndoContext, describeUndoPlan, parseUndoPlan, UndoPlan } from '../services/naturalUndo';
import { buildResolutionPrompt, checkResolution, describeSuggestion, parseResolutions, readConflictedFile, spliceResolutions } from '../services/conflictResolution';
import { StashOperation } from '../services/stashActionService';
import { openCommitChange, openWorkingChange } from '../changeDocuments';
import { recordUsage } from '../services/usageLog';
import {
  MessageHandlerContext, rememberPushAfterCommit, requireRecord, requireString, sendDashboardError,
  sendToWebview, showResult
} from './handlerSupport';
import {
  handleDiscardChanges, handleGetWorkingTreeChanges, handleGetWorkingTreePreview, handleStashAction, handleStashChanges
} from './workingTreeHandlers';

export type MessagePayload = {
  submodules?: string[];
  submodule?: string;
  branchName?: string;
  baseBranch?: string;
  branch?: string;
  commit?: string;
  isRebasing?: boolean;
};

// Moved, still importable from here: the panel and the tests use this module as the entry point.
export { MessageHandlerContext } from './handlerSupport';
export {
  handleDiscardChanges, handleGetWorkingTreeChanges, handleGetWorkingTreePreview, handleStashAction, handleStashChanges
} from './workingTreeHandlers';

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
    await recordCommitUsage(ctx, repositoryPath, files.length, request.metrics);
    await ctx.reloadDashboardHistory([repositoryPath]);
    await ctx.refresh();
  }
}

/** The dialog's timing and Copilot use, with the size of the commit just made (numbers only). */
async function recordCommitUsage(ctx: MessageHandlerContext, repositoryPath: string, files: number, metrics: unknown): Promise<void> {
  const m = metrics && typeof metrics === 'object' ? metrics as Record<string, unknown> : {};
  const durationMs = typeof m.durationMs === 'number' && Number.isFinite(m.durationMs) && m.durationMs >= 0 ? m.durationMs : 0;
  const editRatio = typeof m.editRatio === 'number' && m.editRatio >= 0 && m.editRatio <= 1 ? m.editRatio : undefined;
  let lines: number | undefined;
  try {
    const numstat = await new GitCommandService(ctx.workspaceRoot).execGit(['show', '--numstat', '--format=', 'HEAD'], ctx.gitOps.resolveRepositoryPath(repositoryPath), 10000);
    lines = numstat.split('\n').reduce((sum, row) => {
      const [added, removed] = row.split('\t');
      return sum + (Number(added) || 0) + (Number(removed) || 0);
    }, 0);
  } catch { /* the size stays unknown */ }
  recordUsage({ kind: 'commit', durationMs, copilot: m.copilot === true, editRatio: m.copilot === true ? editRatio : undefined, files, lines });
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
    const files = !named.length ? 'a conflict Git ties to no single file (such as a directory rename)'
      : named.length > 8 ? `${named.slice(0, 8).join(', ')} and ${named.length - 8} more` : named.join(', ');
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
  // Never through a link (it may point out of the repository), and never over newer edits.
  if (fs.lstatSync(target).isSymbolicLink() || fs.readFileSync(target, 'utf8') !== file.current) {
    showResult(false, `${file.path} changed while the suggestion was open, so it was not written. Ask again for a new suggestion.`);
    return true;
  }
  fs.writeFileSync(target, proposed);
  showResult(true, `Wrote the suggested resolution to ${file.path}. It is not staged: check it, then stage it and continue in Source Control.`);
  await ctx.refresh();
  return true;
}

const UNDO_ACTION_NAMES: Record<UndoPlan['action'], string> = {
  reset: 'Reset the branch', revert: 'Revert a commit', drop: 'Drop a commit', discard: 'Discard uncommitted changes',
  abort: 'Abort the paused operation', none: 'Nothing'
};

/**
 * Undo in plain language (services/naturalUndo.ts): the user says what to undo, Copilot picks one
 * existing action with a commit or files it was shown, code checks it and says from Git what it does,
 * and on Continue the action runs through its own dialog, as from its menu. Nothing runs before that.
 */
export async function handleNaturalUndo(ctx: MessageHandlerContext, payload: { repositoryPath: string; request?: string }): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string') {
    return;
  }
  const copilot = ctx.conflictExplainer;
  if (!copilot) {
    showResult(false, 'Undo in plain language needs Copilot in VS Code.');
    return;
  }
  const request = (payload.request ?? await vscode.window.showInputBox({
    title: `Undo in ${payload.repositoryPath}`, ignoreFocusOut: true,
    prompt: 'Say what to undo. Copilot picks one of the dashboard\'s actions; you see it, and its own confirmation, before anything runs.',
    placeHolder: 'e.g. undo my last 2 commits but keep the changes · undo the rebase I just did'
  }) ?? '').trim();
  if (!request) {
    return;
  }
  const git = new GitCommandService(ctx.workspaceRoot);
  const root = git.resolveRepositoryPath(payload.repositoryPath);
  let context;
  try {
    context = await collectUndoContext(git, payload.repositoryPath);
  } catch (error) {
    showResult(false, error instanceof Error ? error.message : String(error));
    return;
  }
  if (!await confirmSending(copilot, root, 'Ask Copilot', 'Ask Copilot how to undo this?',
    'Your request, the last 20 commits\' hashes and subjects, recent reflog entries and the names of changed files are sent to the ' +
      'selected Copilot model. No file contents are sent, and nothing runs until you confirm.')) {
    return;
  }
  let answer;
  try {
    answer = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Asking Copilot how to undo it…', cancellable: true },
      async (_progress, token) => {
        const reply = await copilot.complete(buildUndoPrompt(context, request, copilot.language()), token, 4000);
        return token.isCancellationRequested ? undefined : { plan: parseUndoPlan(reply.text, context), model: reply.model };
      });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== 'Cancelled') { showResult(false, `Could not plan the undo: ${message}`); }
    return;
  }
  if (!answer) {
    return;
  }
  const { plan, model } = answer;
  if (plan.action === 'none') {
    const again = await vscode.window.showWarningMessage('Copilot found no undo action for that.',
      { modal: true, detail: `${plan.question}\n\nYour request: "${request}"` }, 'Ask again');
    if (again === 'Ask again') { await handleNaturalUndo(ctx, { repositoryPath: payload.repositoryPath }); }
    return;
  }
  const facts = await describeUndoPlan(git, payload.repositoryPath, plan, context);
  const go = await vscode.window.showWarningMessage(`${UNDO_ACTION_NAMES[plan.action]}?`, { modal: true, detail:
    `Your request: "${request}"\n\nCopilot's reading (${model}; a suggestion): ${plan.explanation || '(no explanation)'}\n\n` +
    `What it does, from Git:\n${facts}\n\nContinue opens the action's own confirmation; nothing runs before you confirm there.` }, 'Continue');
  if (go !== 'Continue') {
    return;
  }
  switch (plan.action) {
    case 'reset':
    case 'drop':
      await handleRewriteHistoryCommit(ctx, { repositoryPath: payload.repositoryPath, commit: plan.commit!, action: plan.action, mode: plan.mode });
      return;
    case 'revert':
      await handleApplyHistoryCommit(ctx, { repositoryPath: payload.repositoryPath, commit: plan.commit!, operation: 'revert' });
      return;
    case 'discard':
      await handleDiscardChanges(ctx, { repositoryPath: payload.repositoryPath, paths: plan.paths });
      return;
    case 'abort':
      if (context.pending === 'rebase') {
        await handleResolveHistoryRebase(ctx, { repositoryPath: payload.repositoryPath, command: 'abort' });
      } else if (context.pending === 'cherry-pick' || context.pending === 'revert' || context.pending === 'merge') {
        const sure = await vscode.window.showWarningMessage(`Abort the ${context.pending} in ${payload.repositoryPath}?`, { modal: true }, 'Abort');
        if (sure !== 'Abort') { return; }
        const aborted = await ctx.gitOps.abortHistoryAction(payload.repositoryPath, context.pending);
        showResult(aborted.success, aborted.message);
        await ctx.reloadDashboardHistory([payload.repositoryPath]);
        await ctx.refresh();
      } else {
        showResult(false, `A paused ${context.pending} cannot be aborted from here; use git ${context.pending} --abort.`);
      }
      return;
  }
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
  // The prediction (and any explanation) was for the HEAD of then; a commit made meanwhile changes it.
  if (predicted.prediction && predicted.prediction.head !== headBefore) {
    showResult(false, `${branch} moved while the question was open, so the predicted conflicts no longer apply. Nothing was run; start the ${payload.operation} again.`);
    return;
  }
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
  repositoryPath: string; commit: string; action: HistoryRewriteAction; mode?: ResetMode
}): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string' || typeof payload.commit !== 'string' ||
      !['rebase', 'reset', 'drop'].includes(payload.action)) {
    return;
  }
  try {
    const preview = await ctx.gitOps.previewHistoryRewrite(payload.repositoryPath, payload.commit, payload.action);
    // A mode already chosen (a plain-language undo the user approved) skips the picker; a hard reset
    // still asks for the branch name below.
    let mode: ResetMode | undefined = payload.action === 'reset' && ['soft', 'mixed', 'hard'].includes(payload.mode || '') ? payload.mode : undefined;
    if (payload.action === 'reset' && !mode) {
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
 * A changed file in VS Code's diff editor, in a tab: an uncommitted file (`working`) as HEAD ↔ the
 * file on disk, or a commit's file as `base` (none for a root commit) ↔ `target`.
 */
export async function handleOpenChangeInEditor(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');
  const git = new GitCommandService(ctx.workspaceRoot);
  try {
    const root = ctx.gitOps.resolveRepositoryPath(repositoryPath);
    const filePath = git.resolveFilePath(requireString(request, 'path'));
    if (request.working === true) {
      const [changes, head] = await Promise.all([
        ctx.gitOps.getWorkingTreeChanges(repositoryPath),
        // No first commit yet: HEAD is empty, and every file shows as added.
        git.resolveRevision(repositoryPath, 'HEAD').catch(() => '')
      ]);
      const change = changes.find(item => item.path === filePath);
      if (!change) {
        showResult(false, `${filePath} has no uncommitted changes now.`);
        return;
      }
      await openWorkingChange({ root, head, change });
      return;
    }
    const target = await git.resolveRevision(repositoryPath, requireString(request, 'target'));
    const base = typeof request.base === 'string' && request.base ? await git.resolveRevision(repositoryPath, request.base) : '';
    const oldPath = typeof request.oldPath === 'string' && request.oldPath ? git.resolveFilePath(request.oldPath) : undefined;
    await openCommitChange({ root, base, target, path: filePath, oldPath });
  } catch (error) {
    showResult(false, `Cannot open the diff: ${error instanceof Error ? error.message : String(error)}`);
  }
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
  // Whether origin has the branch comes from Git, not from the page: a menu opened before the
  // page had its branch list cannot know, and must not hide the choice to delete origin's too.
  let hasRemote = payload.hasRemote === true;
  try {
    const local = (await ctx.gitOps.getBranches(payload.submodule)).find(branch => branch.name === payload.branch && !branch.isRemote);
    if (local) { hasRemote = Boolean(local.hasRemote); }
  } catch {
    // Keep what the page said.
  }
  const LOCAL = 'Delete Local Branch';
  const BOTH = `Delete Local and origin/${payload.branch}`;
  const choice = await vscode.window.showWarningMessage(
    `Delete branch '${payload.branch}' in ${payload.submodule}?`,
    { modal: true, detail: hasRemote
      ? `origin/${payload.branch} also exists. Deleting it there affects everyone who uses the remote.`
      : 'The branch is deleted even if it has commits that are not merged anywhere.' },
    ...(hasRemote ? [LOCAL, BOTH] : [LOCAL])
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
  'openChangeInEditor': (ctx, payload) => handleOpenChangeInEditor(ctx, payload),
  'naturalUndo': (ctx, payload) => handleNaturalUndo(ctx, payload as { repositoryPath: string }),
  'suggestConflictResolution': async (ctx, payload) => { await handleSuggestConflictResolution(ctx, payload as { repositoryPath: string; path: string }); },
  'stashChanges': (ctx, payload) => handleStashChanges(ctx, payload as { repositoryPath: string; paths?: string[] }),
  'stashAction': (ctx, payload) => handleStashAction(ctx, payload as { repositoryPath: string; stash: string; operation: StashOperation }),
  'getCommits': (ctx, payload) => handleGetCommits(ctx, payload as { submodule: string }),
  'getRecordedCommit': (ctx, payload) => handleGetRecordedCommit(ctx, payload as { submodule: string }),
  'updateToRecorded': (ctx, payload) => handleUpdateToRecorded(ctx, payload as { submodule: string }),
  'deleteBranch': (ctx, payload) => handleDeleteBranch(ctx, payload as { submodule: string; branch: string; hasRemote?: boolean }),
  'setRebaseStatus': (ctx, payload) => handleSetRebaseStatus(ctx, payload as { submodule: string; isRebasing: boolean })
};
