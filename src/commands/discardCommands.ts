/**
 * Repository Manager: Remove Discard Copies — lets go of the copies Discard keeps before it changes
 * anything (refs under refs/repository-manager/discarded/), in the parent and every linked
 * repository. Asks first: Undo of those discards stops working. Git frees the space in a later
 * cleanup (`git gc`).
 */

import * as vscode from 'vscode';
import { GitOperations } from '../gitOperations';

export interface DiscardCopiesUi {
  /** A modal question; resolves true for `action`. */
  confirm(message: string, detail: string, action: string): Promise<boolean>;
  notify(message: string, isError?: boolean): void;
}

type DiscardCopiesGit = Pick<GitOperations, 'getParentRepoInfo' | 'getSubmodules' | 'listDiscardCopies' | 'removeDiscardCopies'>;

export async function removeDiscardCopies(gitOps: DiscardCopiesGit, ui: DiscardCopiesUi): Promise<void> {
  const parent = await gitOps.getParentRepoInfo();
  const repositories = [...(parent ? [parent] : []), ...await gitOps.getSubmodules()]
    .filter(repository => repository.status !== 'uninitialized');
  const found: Array<{ name: string; path: string; refs: string[] }> = [];
  for (const repository of repositories) {
    // A repository Git cannot read has nothing to remove here; the others still count.
    const refs = await gitOps.listDiscardCopies(repository.path).catch(() => [] as string[]);
    if (refs.length) { found.push({ name: repository.name, path: repository.path, refs }); }
  }
  const total = found.reduce((sum, item) => sum + item.refs.length, 0);
  if (!total) {
    ui.notify('No discard copies to remove.');
    return;
  }
  const copies = (n: number) => `${n} cop${n === 1 ? 'y' : 'ies'}`;
  const detail = [...found.map(item => `${item.name}: ${copies(item.refs.length)}`), '',
    'Undo of those discards will no longer work. Git frees the space in a later cleanup.'].join('\n');
  if (!await ui.confirm(`Remove ${copies(total)} kept by Discard?`, detail, 'Remove')) { return; }
  let removed = 0;
  const failed: string[] = [];
  for (const item of found) {
    try {
      removed += await gitOps.removeDiscardCopies(item.path, item.refs);
    } catch (error) {
      failed.push(`${item.name} (${error instanceof Error ? error.message : String(error)})`);
    }
  }
  const where = found.length === 1 ? ` in ${found[0].name}` : ` in ${found.length - failed.length} repositories`;
  if (failed.length) {
    ui.notify(`Removed ${copies(removed)}${removed ? where : ''}. Could not remove those in ${failed.join('; ')}.`, true);
  } else {
    ui.notify(`Removed ${copies(removed)}${where}.`);
  }
}

export function registerDiscardCommands(context: vscode.ExtensionContext, gitOps: GitOperations): void {
  context.subscriptions.push(vscode.commands.registerCommand('repositoryManager.removeDiscardCopies', () =>
    removeDiscardCopies(gitOps, {
      confirm: async (message, detail, action) =>
        await vscode.window.showWarningMessage(message, { modal: true, detail }, action) === action,
      notify: (message, isError) => {
        void (isError ? vscode.window.showErrorMessage(message) : vscode.window.showInformationMessage(message));
      }
    })));
}
