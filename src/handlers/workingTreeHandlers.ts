/**
 * The dashboard's uncommitted changes: their status and previews, Discard (with Undo), Stash… for
 * selected files, and Apply / Pop / Drop of a stash. Each handler answers the page the way the
 * others do (see handlerSupport.ts); the message names are routed in webviewMessageHandler.ts.
 */
import * as vscode from 'vscode';
import * as path from 'path';
import { STASH_OPERATIONS, StashActionData, StashOperation } from '../services/stashActionService';
import { DiscardResultData } from '../services/discardService';
import {
  MessageHandlerContext, pushAfterCommitRoots, requireRecord, requireString, sendDashboardError, sendToWebview, showResult
} from './handlerSupport';

/**
 * Numbers each working-tree status read when it starts. Reads run concurrently (a refresh after a
 * discard, live changes, a repository switch), so replies can arrive out of order; the page keeps
 * the highest number it has seen, and an older read never replaces a newer one.
 */
let workingTreeStatusSequence = 0;

export async function handleGetWorkingTreeChanges(ctx: MessageHandlerContext, payload: unknown): Promise<void> {
  const request = requireRecord(payload);
  const repositoryPath = requireString(request, 'repositoryPath');
  const sequence = ++workingTreeStatusSequence;

  try {
    const changes = await ctx.gitOps.getWorkingTreeChanges(repositoryPath);
    const pushAfterCommit = pushAfterCommitRoots(ctx).includes(ctx.gitOps.resolveRepositoryPath(repositoryPath));
    // The dashboard (its Uncommitted changes row) and the commit dialog both ask; the reply says which.
    const purpose = request.purpose === 'dashboard' ? 'dashboard' : undefined;
    await sendToWebview(ctx, {
      type: 'workingTreeChangesLoaded',
      payload: { repositoryPath, changes, pushAfterCommit, purpose, sequence }
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

/** How many file names the discard question lists before "and N more". */
const DISCARD_NAMES_SHOWN = 8;

/**
 * Discard Changes, from the uncommitted changes' menus, the Side Bar's Changes and the files list:
 * some files (`paths`, one or a selection) or every change (`all`). Always asked first, from the
 * host, naming what goes; the service keeps a copy before it changes anything, and the message
 * after offers Undo, which puts the files back from that copy.
 *
 * The dashboard hears `discardStarted` as soon as the question is answered, so it can drop the files
 * from its lists at once, then the new status and `discardFinished` once Git is done. The history
 * does not change, so it is not reloaded.
 */
export async function handleDiscardChanges(ctx: MessageHandlerContext, payload: {
  repositoryPath: string; paths?: string[]; all?: boolean
}): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string') { return; }
  const paths = Array.isArray(payload.paths) ? payload.paths.filter((item): item is string => typeof item === 'string' && item.length > 0) : undefined;
  if (payload.all !== true && !(paths && paths.length)) { return; }
  const repositoryPath = payload.repositoryPath;
  const target = payload.all === true ? undefined : paths;
  let plan;
  try {
    plan = await ctx.gitOps.planDiscard(repositoryPath, target);
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
  const label = target ? 'Discard' : 'Discard All';
  const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
  const repositoryName = path.basename(ctx.gitOps.resolveRepositoryPath(repositoryPath));
  const question = single ? `Discard changes to ${path.basename(single)}?`
    : target ? `Discard changes to ${files(count)}?` : `Discard all ${files(count)} changed in ${repositoryName}?`;
  const lines: string[] = [];
  if (single) {
    lines.push(single, plan.deleted.length ? 'This new file will be deleted.' : 'Its staged and unstaged changes will be lost.');
  } else {
    const names = [...plan.restored, ...plan.deleted];
    lines.push(...names.slice(0, DISCARD_NAMES_SHOWN), ...(names.length > DISCARD_NAMES_SHOWN ? [`and ${names.length - DISCARD_NAMES_SHOWN} more`] : []), '');
    if (plan.restored.length) { lines.push(`${files(plan.restored.length)} go${plan.restored.length === 1 ? 'es' : ''} back to HEAD.`); }
    if (plan.deleted.length) { lines.push(`${plan.deleted.length} new file${plan.deleted.length === 1 ? ' is' : 's are'} deleted.`); }
  }
  if (plan.skipped.length) {
    lines.push(`Left alone: ${plan.skipped.map(item => `${item.path} (${item.reason})`).join('; ')}.`);
  }
  lines.push('A copy is kept first: Undo in the message that follows brings them back.');
  const approved = await vscode.window.showWarningMessage(question, { modal: true, detail: lines.join('\n') }, label);
  if (approved !== label) { return; }
  // Exactly the files the question named: one that appeared while it was open is not deleted unseen.
  const discarded = [...plan.restored, ...plan.deleted];
  await sendToWebview(ctx, { type: 'discardStarted', payload: { repositoryPath, paths: discarded } });
  const result = await ctx.gitOps.discardChanges(repositoryPath, discarded);
  // The new status first: the lists show it without waiting for every repository to be listed again.
  await handleGetWorkingTreeChanges(ctx, { repositoryPath, purpose: 'dashboard' });
  await sendToWebview(ctx, { type: 'discardFinished', payload: { repositoryPath, paths: discarded, success: result.success } });
  const data = result.data as DiscardResultData | undefined;
  if (result.success && data && data.backup && data.changed.length) {
    const backup = data.backup;
    // Not awaited: the message can wait in the notification center while the dashboard goes on.
    void Promise.resolve(vscode.window.showInformationMessage(result.message, 'Undo')).then(choice => {
      if (choice === 'Undo') { void undoDiscard(ctx, repositoryPath, backup, data.changed); }
    });
  } else {
    showResult(result.success, result.message);
  }
  await ctx.refresh();
}

/** Stash… for the files picked in Changes: asks for an optional message, then stashes just them. */
export async function handleStashChanges(ctx: MessageHandlerContext, payload: {
  repositoryPath: string; paths?: string[]
}): Promise<void> {
  if (!payload || typeof payload.repositoryPath !== 'string') { return; }
  const paths = Array.isArray(payload.paths) ? payload.paths.filter((item): item is string => typeof item === 'string' && item.length > 0) : [];
  if (!paths.length) { return; }
  const count = `${paths.length} file${paths.length === 1 ? '' : 's'}`;
  const message = await vscode.window.showInputBox({
    title: `Stash ${count}`,
    prompt: 'A message for the stash (optional). The other changes stay in the working tree.',
    placeHolder: paths.length === 1 ? path.basename(paths[0]) : `${count}`
  });
  if (message === undefined) { return; }
  const repositoryPath = payload.repositoryPath;
  const result = await ctx.gitOps.stashPaths(repositoryPath, paths, message);
  await handleGetWorkingTreeChanges(ctx, { repositoryPath, purpose: 'dashboard' });
  showResult(result.success, result.message);
  if (result.success) {
    // Every older stash moved down one place: a history filtered to stash@{n} would now show another.
    await sendToWebview(ctx, { type: 'stashActionCompleted', payload: { repositoryPath,
      operation: 'push', changedWorkingTree: false, removedStash: false, movedStashes: true } });
    await ctx.reloadDashboardHistory([repositoryPath]);
  }
  await ctx.refresh();
}

/** Undo from the message after a discard: the files come back from the copy it kept. */
async function undoDiscard(ctx: MessageHandlerContext, repositoryPath: string, backup: string, paths: string[]): Promise<void> {
  try {
    const result = await ctx.gitOps.restoreDiscarded(repositoryPath, backup, paths);
    await handleGetWorkingTreeChanges(ctx, { repositoryPath, purpose: 'dashboard' });
    showResult(result.success, result.message);
    await ctx.refresh();
  } catch (error) {
    // The dashboard may have closed since the discard; the files are back either way.
    console.error('[RepositoryManager] Undo discard:', error);
  }
}
