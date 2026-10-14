/**
 * Discard Changes for the dashboard's uncommitted changes: one file, or all of them.
 *
 * Discarding puts each file back as it is at HEAD, staged and unstaged changes alike
 * (`git restore --source=HEAD --staged --worktree`), and deletes new files that are not ignored
 * (`git clean -f`, never -x). It cannot be undone from Git's own history, so before anything is
 * changed the working tree is saved as a commit (the same snapshot a review of local changes reads)
 * and kept by a ref under DISCARD_REF_PREFIX; `git restore --source=<sha> --worktree -- <path>`
 * brings the files back. The newest MAX_BACKUPS are kept per repository.
 *
 * Left alone, and said so:
 * - linked repositories (a changed submodule commit): restoring the index would not move the
 *   checkout, so the change would stay; use Align or the repository itself;
 * - new nested Git repositories, which `git clean` would delete with their own history.
 *
 * Nothing runs while a merge, rebase, cherry-pick or revert is paused: discarding then would
 * resolve or drop part of it behind the user's back.
 */

import * as path from 'path';
import { readdirSync, rmdirSync } from 'fs';
import { CommandResult, WorkingTreeChange } from '../types';
import { GitCommandService } from './gitCommandService';
import { CommitService } from './commitService';
import { HistoryActionService } from './historyActionService';
import { snapshotLocalChanges } from './localChangesSnapshot';

/** Kept outside branches, tags and remotes, and out of the dashboard's history. */
export const DISCARD_REF_PREFIX = 'refs/repository-manager/discarded/';
const MAX_BACKUPS = 20;
const CHUNK = 200;

export interface DiscardPlan {
  /** Tracked files put back as at HEAD (a rename lists its new path). */
  restored: string[];
  /** New files deleted. */
  deleted: string[];
  /** Left alone, with the reason. */
  skipped: { path: string; reason: string }[];
}

export interface DiscardResultData extends DiscardPlan {
  /** The commit holding the files as they were, kept by a ref; absent when nothing was discarded. */
  backup?: string;
}

export class DiscardService {
  constructor(private git: GitCommandService) {}

  /** What discarding `paths` (or every change, when undefined) would do now. */
  async plan(repositoryPath: string, paths?: string[]): Promise<DiscardPlan> {
    const root = this.git.resolveRepositoryPath(repositoryPath);
    const changes = await new CommitService(this.git).getWorkingTreeChanges(repositoryPath);
    const wanted = paths ? new Set(paths) : undefined;
    const selected = wanted
      ? changes.filter(change => wanted.has(change.path) || (change.originalPath && wanted.has(change.originalPath)))
      : changes;
    const gitlinks = await this.gitlinks(root, selected);
    const plan: DiscardPlan = { restored: [], deleted: [], skipped: [] };
    for (const change of selected) {
      if (gitlinks.has(change.path)) {
        plan.skipped.push({ path: change.path, reason: 'a linked repository: align it or change it in that repository' });
      } else if (change.untracked && change.path.endsWith('/')) {
        plan.skipped.push({ path: change.path, reason: 'a new Git repository: delete it yourself if you mean to' });
      } else if (change.untracked) {
        plan.deleted.push(change.path);
      } else {
        plan.restored.push(change.path);
      }
    }
    return plan;
  }

  async discard(repositoryPath: string, paths?: string[]): Promise<CommandResult> {
    const root = this.git.resolveRepositoryPath(repositoryPath);
    let backup: string | undefined;
    try {
      await this.git.execGit(['rev-parse', '--verify', 'HEAD^{commit}'], root, 10000)
        .catch(() => { throw new Error('This repository has no commit yet, so there is nothing to put the files back to.'); });
      const pending = await new HistoryActionService(this.git).pendingOperation(repositoryPath);
      if (pending) {
        throw new Error(`A ${pending} is in progress. Finish or abort it before discarding changes.`);
      }
      const plan = await this.plan(repositoryPath, paths);
      if (!plan.restored.length && !plan.deleted.length) {
        const why = plan.skipped.length ? ` ${plan.skipped.map(item => `${item.path} is ${item.reason}`).join('; ')}.` : '';
        return { success: false, data: { ...plan }, message: `Nothing to discard.${why}` };
      }
      // A copy first: if it cannot be made, nothing is discarded.
      const snapshot = await snapshotLocalChanges(this.git, root);
      backup = snapshot?.snapshotSha;
      if (backup) { await this.keepBackup(root, backup); }

      const changes = await new CommitService(this.git).getWorkingTreeChanges(repositoryPath);
      const restoredSet = new Set(plan.restored);
      // A rename is put back on both sides: the old path returns, the new one goes.
      const restorePaths = changes.filter(change => restoredSet.has(change.path))
        .flatMap(change => change.originalPath ? [change.originalPath, change.path] : [change.path]);
      for (let index = 0; index < restorePaths.length; index += CHUNK) {
        await this.git.execGit(['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--',
          ...restorePaths.slice(index, index + CHUNK)], root, 120000);
      }
      for (let index = 0; index < plan.deleted.length; index += CHUNK) {
        await this.git.execGit(['--literal-pathspecs', 'clean', '-f', '--', ...plan.deleted.slice(index, index + CHUNK)], root, 120000);
      }
      removeEmptyParents(root, plan.deleted);

      const data: DiscardResultData = { ...plan, backup };
      return { success: true, data, message: describe(plan, backup, paths) };
    } catch (error) {
      // Stopped partway: whatever was discarded is in the copy made first.
      const copy = backup ? ` Files already discarded are in ${backup}: git restore --source=${backup} --worktree -- .` : '';
      return { success: false, message: `Discard failed: ${error instanceof Error ? error.message : String(error)}${copy}` };
    }
  }

  /** Paths among `changes` that are linked repositories (gitlinks), in the index or at HEAD. */
  private async gitlinks(root: string, changes: WorkingTreeChange[]): Promise<Set<string>> {
    const tracked = changes.filter(change => !change.untracked).map(change => change.path);
    const found = new Set<string>();
    for (let index = 0; index < tracked.length; index += CHUNK) {
      const chunk = tracked.slice(index, index + CHUNK);
      // -z: paths exactly as they are, never quoted.
      const staged = await this.git.execGitRaw(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...chunk], root, 30000).catch(() => '');
      const atHead = await this.git.execGitRaw(['--literal-pathspecs', 'ls-tree', '-z', 'HEAD', '--', ...chunk], root, 30000).catch(() => '');
      for (const record of `${staged}\0${atHead}`.split('\0')) {
        const match = /^160000 (?:commit )?[0-9a-f]+(?: \d)?\t([\s\S]+)$/.exec(record);
        if (match) { found.add(match[1]); }
      }
    }
    return found;
  }

  private async keepBackup(root: string, sha: string): Promise<void> {
    await this.git.execGit(['update-ref', `${DISCARD_REF_PREFIX}${Date.now()}`, sha], root, 10000);
    const refs = (await this.git.execGit(['for-each-ref', '--sort=-refname', '--format=%(refname)', DISCARD_REF_PREFIX], root, 10000))
      .split('\n').filter(Boolean);
    // Names are millisecond times of the same length, so the name order is the age order.
    for (const ref of refs.slice(MAX_BACKUPS)) {
      await this.git.execGit(['update-ref', '-d', ref], root, 10000);
    }
  }
}

function describe(plan: DiscardPlan, backup: string | undefined, paths?: string[]): string {
  const count = plan.restored.length + plan.deleted.length;
  const what = paths && count === 1 ? (plan.restored[0] || plan.deleted[0]) : `${count} file${count === 1 ? '' : 's'}`;
  const deleted = plan.deleted.length && !(paths && count === 1)
    ? ` (${plan.deleted.length} new file${plan.deleted.length === 1 ? '' : 's'} deleted)` : '';
  const skipped = plan.skipped.length ? ` Left alone: ${plan.skipped.map(item => item.path).join(', ')}.` : '';
  const target = paths && count === 1 ? what : '.';
  const restore = backup ? ` To bring ${count === 1 ? 'it' : 'them'} back: git restore --source=${backup} --worktree -- ${target}` : '';
  return `Discarded changes to ${what}${deleted}.${skipped}${restore}`;
}

/** After `git clean`, the folders that only held the deleted files, up to the repository root. */
function removeEmptyParents(root: string, files: string[]): void {
  const folders = new Set<string>();
  for (const file of files) {
    for (let folder = path.dirname(file); folder && folder !== '.'; folder = path.dirname(folder)) { folders.add(folder); }
  }
  // Deepest first, so a parent is tried after its children.
  for (const folder of Array.from(folders).sort((a, b) => b.split('/').length - a.split('/').length)) {
    const full = path.join(root, folder);
    try {
      if (!readdirSync(full).length) { rmdirSync(full); }
    } catch {
      // Gone already, or not empty: leave it.
    }
  }
}
