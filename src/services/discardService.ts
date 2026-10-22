/**
 * Discard Changes for the dashboard's uncommitted changes: one file, or all of them.
 *
 * Discarding puts each file back as it is at HEAD, staged and unstaged changes alike
 * (`git restore --source=HEAD --staged --worktree`), and deletes new files that are not ignored
 * (directly, not with `git clean`). It cannot be undone from Git's own history, so before anything is
 * changed the working tree is saved as a commit (the same snapshot a review of local changes reads)
 * and kept by a ref under DISCARD_REF_PREFIX; `git restore --source=<sha> --worktree -- <path>`
 * brings the files back. The newest MAX_BACKUPS are kept per repository.
 *
 * Left alone, and said so:
 * - linked repositories (a changed submodule commit): restoring the index would not move the
 *   checkout, so the change would stay; use Align or the repository itself;
 * - new nested Git repositories, which deleting would take with their own history.
 *
 * Nothing runs while a merge, rebase, cherry-pick or revert is paused: discarding then would
 * resolve or drop part of it behind the user's back.
 */

import * as path from 'path';
import { chmodSync, readdirSync, rmdirSync, unlinkSync } from 'fs';
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
  /** Every path the discard changed (a rename's old path too): what Undo puts back from `backup`. */
  changed: string[];
}

export interface RestoreResultData {
  /** Paths put back as they were before the discard. */
  restored: string[];
  /** Paths changed again since the discard, left as they are now. */
  kept: string[];
}

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

export class DiscardService {
  constructor(private git: GitCommandService) {}

  /** What discarding `paths` (or every change, when undefined) would do now. */
  async plan(repositoryPath: string, paths?: string[]): Promise<DiscardPlan> {
    return (await this.planWithChanges(repositoryPath, paths)).plan;
  }

  /** The plan, and the changes it was made from (one `git status` serves both). */
  private async planWithChanges(repositoryPath: string, paths?: string[]): Promise<{ plan: DiscardPlan; changes: WorkingTreeChange[] }> {
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
    return { plan, changes: selected };
  }

  async discard(repositoryPath: string, paths?: string[]): Promise<CommandResult> {
    const root = this.git.resolveRepositoryPath(repositoryPath);
    let backup: string | undefined;
    try {
      // The checks and the plan read different things: they run together, and fail in this order.
      const [head, pending, planned] = await Promise.allSettled([
        this.git.execGit(['rev-parse', '--verify', 'HEAD^{commit}'], root, 10000),
        new HistoryActionService(this.git).pendingOperation(repositoryPath),
        this.planWithChanges(repositoryPath, paths)
      ]);
      if (head.status === 'rejected') {
        throw new Error('This repository has no commit yet, so there is nothing to put the files back to.');
      }
      if (pending.status === 'rejected') { throw pending.reason; }
      if (pending.value) {
        throw new Error(`A ${pending.value} is in progress. Finish or abort it before discarding changes.`);
      }
      if (planned.status === 'rejected') { throw planned.reason; }
      const { plan, changes } = planned.value;
      if (!plan.restored.length && !plan.deleted.length) {
        const why = plan.skipped.length ? ` ${plan.skipped.map(item => `${item.path} is ${item.reason}`).join('; ')}.` : '';
        return { success: false, data: { ...plan, changed: [] }, message: `Nothing to discard.${why}` };
      }
      const restoredSet = new Set(plan.restored);
      const restoredChanges = changes.filter(change => restoredSet.has(change.path));
      // A rename is put back on both sides: the old path returns, the new one goes.
      const restorePaths = restoredChanges.flatMap(change => change.originalPath ? [change.originalPath, change.path] : [change.path]);

      // A copy first, of the files about to change: if it cannot be made, nothing is discarded. A
      // staged deletion is in neither the index nor the working tree, so there is nothing to copy.
      const copied = [...restoredChanges.filter(change => change.indexStatus !== 'D' || change.unstaged).map(change => change.path), ...plan.deleted];
      const snapshot = await snapshotLocalChanges(this.git, root, copied);
      backup = snapshot?.snapshotSha;
      // The copy is a commit already; the ref only keeps it from a garbage collection weeks later, so
      // it is written (and old copies dropped) while the files are put back, not before.
      const kept = backup
        ? this.git.execGit(['update-ref', `${DISCARD_REF_PREFIX}${Date.now()}`, backup], root, 10000)
          .then(() => this.pruneBackups(root)).then(() => true, () => false)
        : Promise.resolve(true);

      for (let index = 0; index < restorePaths.length; index += CHUNK) {
        await this.git.execGit(['--literal-pathspecs', 'restore', '--source=HEAD', '--staged', '--worktree', '--',
          ...restorePaths.slice(index, index + CHUNK)], root, 120000);
      }
      // New files are deleted here rather than by `git clean`: they are copied already, and that is
      // one Git process less to wait for.
      deleteNewFiles(root, plan.deleted);
      removeEmptyParents(root, plan.deleted);
      // Not kept by a ref, the copy still serves Undo now; Git only removes it in a later cleanup.
      const unkept = await kept ? '' : ` The copy ${backup} could not be kept for later; Git removes it in a future cleanup.`;

      const data: DiscardResultData = { ...plan, backup, changed: [...restorePaths, ...plan.deleted] };
      return { success: true, data, message: describe(plan, paths) + unkept };
    } catch (error) {
      // Stopped partway: whatever was discarded is in the copy made first.
      const copy = backup ? ` Files already discarded are in ${backup}: git restore --source=${backup} --worktree -- .` : '';
      return { success: false, message: `Discard failed: ${error instanceof Error ? error.message : String(error)}${copy}` };
    }
  }

  /**
   * Undo a discard: `paths` go back as they were in `backup` (the copy the discard kept), as
   * unstaged changes and new files. A path changed again since the discard is left as it is now.
   */
  async restore(repositoryPath: string, backup: string, paths: string[]): Promise<CommandResult> {
    const root = this.git.resolveRepositoryPath(repositoryPath);
    try {
      if (!FULL_SHA.test(backup)) { throw new Error('That copy is not a commit.'); }
      const wanted = Array.from(new Set(paths.map(item => this.git.resolveFilePath(item))));
      if (!wanted.length) { throw new Error('No files to bring back.'); }
      await this.git.execGit(['cat-file', '-e', `${backup}^{commit}`], root, 10000)
        .catch(() => { throw new Error('The copy kept before discarding is gone.'); });
      // After the discard each path matched HEAD (or was gone): one with a change now was edited since.
      const since = new Set<string>();
      for (let index = 0; index < wanted.length; index += CHUNK) {
        const status = await this.git.execGitRaw(['--literal-pathspecs', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--',
          ...wanted.slice(index, index + CHUNK)], root, 30000);
        const records = status.split('\0');
        for (let at = 0; at < records.length; at++) {
          const record = records[at];
          if (record.length < 4) { continue; }
          since.add(record.slice(3));
          if (record[0] === 'R' || record[0] === 'C') { since.add(records[++at]); }
        }
      }
      const restored = wanted.filter(item => !since.has(item));
      const kept = wanted.filter(item => since.has(item));
      if (!restored.length) {
        return { success: false, data: { restored, kept }, message: `Nothing brought back: ${kept.join(', ')} changed since the discard.` };
      }
      // A path missing from the copy (deleted before the discard) is deleted again.
      for (let index = 0; index < restored.length; index += CHUNK) {
        await this.git.execGit(['--literal-pathspecs', 'restore', `--source=${backup}`, '--worktree', '--',
          ...restored.slice(index, index + CHUNK)], root, 120000);
      }
      const data: RestoreResultData = { restored, kept };
      const what = restored.length === 1 ? restored[0] : `${restored.length} files`;
      const left = kept.length ? ` Left as they are, since they changed after the discard: ${kept.join(', ')}.` : '';
      return { success: true, data, message: `Brought back ${what}.${left}` };
    } catch (error) {
      return { success: false, message: `Undo failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  }

  /** Paths among `changes` that are linked repositories (gitlinks), in the index or at HEAD. */
  private async gitlinks(root: string, changes: WorkingTreeChange[]): Promise<Set<string>> {
    const tracked = changes.filter(change => !change.untracked).map(change => change.path);
    const found = new Set<string>();
    for (let index = 0; index < tracked.length; index += CHUNK) {
      const chunk = tracked.slice(index, index + CHUNK);
      // -z: paths exactly as they are, never quoted. The index and HEAD are read together.
      const [staged, atHead] = await Promise.all([
        this.git.execGitRaw(['--literal-pathspecs', 'ls-files', '-s', '-z', '--', ...chunk], root, 30000).catch(() => ''),
        this.git.execGitRaw(['--literal-pathspecs', 'ls-tree', '-z', 'HEAD', '--', ...chunk], root, 30000).catch(() => '')
      ]);
      for (const record of `${staged}\0${atHead}`.split('\0')) {
        const match = /^160000 (?:commit )?[0-9a-f]+(?: \d)?\t([\s\S]+)$/.exec(record);
        if (match) { found.add(match[1]); }
      }
    }
    return found;
  }

  /** The copies kept by earlier discards (their refs), newest first. */
  async listCopies(repositoryPath: string): Promise<string[]> {
    const root = this.git.resolveRepositoryPath(repositoryPath);
    return (await this.git.execGit(['for-each-ref', '--sort=-refname', '--format=%(refname)', DISCARD_REF_PREFIX], root, 10000))
      .split('\n').filter(Boolean);
  }

  /** Lets go of these copies (refs under DISCARD_REF_PREFIX only); Git removes them in a later cleanup. Returns how many went. */
  async removeCopies(repositoryPath: string, refs: string[]): Promise<number> {
    const root = this.git.resolveRepositoryPath(repositoryPath);
    let removed = 0;
    for (const ref of refs.filter(item => item.startsWith(DISCARD_REF_PREFIX) && !item.includes('..'))) {
      await this.git.execGit(['update-ref', '-d', ref], root, 10000);
      removed++;
    }
    return removed;
  }

  /** Only the newest MAX_BACKUPS copies are kept. */
  private async pruneBackups(root: string): Promise<void> {
    const refs = (await this.git.execGit(['for-each-ref', '--sort=-refname', '--format=%(refname)', DISCARD_REF_PREFIX], root, 10000))
      .split('\n').filter(Boolean);
    // Names are millisecond times of the same length, so the name order is the age order.
    for (const ref of refs.slice(MAX_BACKUPS)) {
      await this.git.execGit(['update-ref', '-d', ref], root, 10000);
    }
  }
}

/** One short sentence; the message offers Undo, so it names no Git command. */
function describe(plan: DiscardPlan, paths?: string[]): string {
  const count = plan.restored.length + plan.deleted.length;
  const what = paths && count === 1 ? (plan.restored[0] || plan.deleted[0]) : `${count} file${count === 1 ? '' : 's'}`;
  const deleted = plan.deleted.length && !(paths && count === 1)
    ? ` (${plan.deleted.length} new file${plan.deleted.length === 1 ? '' : 's'} deleted)` : '';
  const skipped = plan.skipped.length ? ` Left alone: ${plan.skipped.map(item => item.path).join(', ')}.` : '';
  return `Discarded changes to ${what}${deleted}.${skipped}`;
}

/**
 * Deletes new (untracked) files of `root`. Each must stay inside the repository; a symbolic link is
 * removed itself, never what it points to, and a folder (a nested repository) is never removed.
 */
function deleteNewFiles(root: string, files: string[]): void {
  for (const file of files) {
    const full = path.resolve(root, file);
    const relative = path.relative(root, full);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`${file} is outside the repository`);
    }
    try {
      unlinkSync(full);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') { continue; }
      // A read-only file on Windows: Git deletes it anyway, so this does too.
      if (code !== 'EPERM' && code !== 'EACCES') { throw error; }
      chmodSync(full, 0o666);
      unlinkSync(full);
    }
  }
}

/** After deleting new files, the folders that only held them, up to the repository root. */
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
