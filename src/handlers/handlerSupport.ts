/**
 * What every dashboard message handler shares: the context it runs in, how it answers the page,
 * and how it checks a request. No handler lives here.
 */
import * as vscode from 'vscode';
import { GitOperations } from '../gitOperations';
import { PRManager } from '../prManager';
import { ConflictExplainerHost } from '../services/conflictExplanation';

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
export function pushAfterCommitRoots(ctx: MessageHandlerContext): string[] {
  const value = ctx.workspaceState?.get<unknown>(PUSH_AFTER_COMMIT_KEY);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export async function rememberPushAfterCommit(ctx: MessageHandlerContext, repositoryPath: string, push: boolean): Promise<void> {
  if (!ctx.workspaceState) { return; }
  const root = ctx.gitOps.resolveRepositoryPath(repositoryPath);
  const roots = pushAfterCommitRoots(ctx).filter(item => item !== root);
  await ctx.workspaceState.update(PUSH_AFTER_COMMIT_KEY, push ? [...roots, root] : roots);
}


/**
 * Show result message to user
 */
export function showResult(success: boolean, message: string): void {
  if (success) {
    vscode.window.showInformationMessage(message);
  } else {
    vscode.window.showErrorMessage(message);
  }
}

/**
 * Send a message to the webview with await and error logging
 */
export async function sendToWebview(ctx: MessageHandlerContext, message: { type: string; payload: unknown }): Promise<void> {
  try {
    const delivered = await ctx.panel.webview.postMessage(message);
    if (!delivered) {
      console.warn(`[RepositoryManager] Message '${message.type}' was NOT delivered to webview`);
    }
  } catch (error) {
    console.error(`[RepositoryManager] Failed to send message '${message.type}' to webview:`, error);
  }
}

export function requireRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid dashboard request payload');
  }
  return payload as Record<string, unknown>;
}

export function requireString(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing or invalid '${field}'`);
  }
  return value;
}

export async function sendDashboardError(
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
