/**
 * Stashes, read as the dashboard shows them: one entry with all its changes.
 *
 * A stash is a commit whose first parent is where it was made (HEAD then), whose second parent holds
 * the index, and, made with `git stash -u`, whose third parent holds the untracked files. Its own
 * tree has only the tracked changes, so a diff from the first parent leaves the new files out. For
 * those stashes the file list, diffs, summaries and reviews read a commit that adds the untracked
 * files to the stash's tree (`stashDiffTarget`). It is built like a review snapshot: in a temporary
 * index, with the stash's own identity and date, so the same stash always gives the same commit.
 *
 * Only commits in the stash reflog count as stashes: a merge that happens to have three parents is
 * never rewritten. The index and untracked-files commits are internal to Git's stash and are left out
 * of the history (`hideStashInternals`).
 */

import * as path from 'path';
import { rmSync } from 'fs';
import { GitCommandService } from './gitCommandService';
import { HistoryCommit } from '../types';

export interface StashEntry {
  hash: string;
  /** `stash@{0}` is the newest. */
  ref: string;
  parents: string[];
  /** The branch it was made on, from its message; empty when the message does not say. */
  branch: string;
  /** The message without Git's "On <branch>: " or "WIP on <branch>: " prefix. */
  message: string;
}

const EMPTY_TREE: Record<string, string> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321'
};
const FIELD = '\x1f';

/**
 * The message of every commit stashDiffTarget builds. It names no stash@{n}: that moves when
 * another stash is pushed, and the commit (and so the review cache keyed by it) must not.
 */
export const STASH_SNAPSHOT_MESSAGE = 'Stash with its untracked files (Repository Manager review snapshot)';

/** Whether `sha` is a commit stashDiffTarget built (a saved review may read one). */
export async function isStashSnapshot(git: GitCommandService, root: string, sha: string): Promise<boolean> {
  const message = await git.execGit(['log', '-1', '--format=%B', sha], root, 5000).catch(() => '');
  return message.trim() === STASH_SNAPSHOT_MESSAGE;
}

/** "On main: try this" or "WIP on main: abc1234 subject" → { branch, message }. */
export function parseStashSubject(subject: string): { branch: string; message: string } {
  const match = /^(?:WIP on|On) (.+?): ([\s\S]*)$/.exec(subject);
  return match ? { branch: match[1], message: match[2] } : { branch: '', message: subject };
}

/** Every stash in `root`, newest first; none when there is no stash (or no reflog to read). */
export async function listStashes(git: GitCommandService, root: string): Promise<StashEntry[]> {
  const output = await git.execGitRaw(['log', '-g', `--format=%H${FIELD}%P${FIELD}%gs`, 'refs/stash', '--'], root, 10000)
    .catch(() => '');
  return output.split('\n').filter(Boolean).map((line, index) => {
    const [hash, parents, subject] = line.split(FIELD);
    return { hash, ref: `stash@{${index}}`, parents: (parents || '').split(' ').filter(Boolean), ...parseStashSubject(subject || '') };
  });
}

/** The stash `sha` is, if it is one. */
export async function findStash(git: GitCommandService, root: string, sha: string): Promise<StashEntry | undefined> {
  return (await listStashes(git, root)).find(stash => stash.hash === sha);
}

/**
 * What to diff for commit `sha`: itself, or for a stash with untracked files a commit holding the
 * stash's tree and those files, on the stash's first parent.
 */
export async function stashDiffTarget(git: GitCommandService, root: string, sha: string): Promise<string> {
  const stash = await findStash(git, root, sha);
  if (!stash || stash.parents.length < 3) { return sha; }
  const [base, , untracked] = stash.parents;
  const indexPath = path.resolve(root, await git.execGit(['rev-parse', '--git-path', 'index'], root));
  const temporaryIndex = `${indexPath}.repository-manager-stash-${process.pid}-${Date.now()}`;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env };
    env['GIT_INDEX_FILE'] = temporaryIndex;
    // A three-way read from the empty tree takes every path from whichever side has it. Untracked
    // files were not tracked, so no path is on both sides and nothing conflicts.
    const format = await git.execGit(['rev-parse', '--show-object-format'], root, 5000).catch(() => 'sha1');
    const emptyTree = EMPTY_TREE[format] || EMPTY_TREE.sha1;
    await git.execGitRaw(['read-tree', '-m', '-i', emptyTree, `${sha}^{tree}`, `${untracked}^{tree}`], root, 30000, false, env);
    const tree = (await git.execGitRaw(['write-tree'], root, 30000, false, env)).trim();
    const [name, email, authorDate, committerDate] = (await git.execGitRaw(
      ['log', '-1', `--format=%an${FIELD}%ae${FIELD}%aI${FIELD}%cI`, sha], root, 10000)).trim().split(FIELD);
    env['GIT_AUTHOR_NAME'] = name; env['GIT_AUTHOR_EMAIL'] = email; env['GIT_AUTHOR_DATE'] = authorDate;
    env['GIT_COMMITTER_NAME'] = name; env['GIT_COMMITTER_EMAIL'] = email; env['GIT_COMMITTER_DATE'] = committerDate;
    return (await git.execGitRaw(['commit-tree', tree, '-p', base, '-m', STASH_SNAPSHOT_MESSAGE], root, 30000, false, env)).trim();
  } finally {
    rmSync(temporaryIndex, { force: true });
  }
}

/** The index and untracked-files commits Git keeps inside these stashes. */
export function stashInternals(stashes: StashEntry[]): Set<string> {
  return new Set(stashes.flatMap(stash => stash.parents.slice(1)));
}

/**
 * The history without the commits Git keeps inside a stash: each stash shows as one commit on the
 * commit it was made from. One that is also somewhere the user went stays: it carries a ref (a
 * branch, a tag, a detached HEAD), or it is the revision the history was asked from (`tip`).
 */
export function hideStashInternals(commits: HistoryCommit[], stashes: StashEntry[], tip?: string): HistoryCommit[] {
  if (!stashes.length) { return commits; }
  const byHash = new Map(stashes.map(stash => [stash.hash, stash]));
  const internal = stashInternals(stashes);
  const hidden = (commit: HistoryCommit) => internal.has(commit.hash) && commit.hash !== tip && !commit.refs.length;
  return commits.filter(commit => !hidden(commit)).map(commit => {
    const stash = byHash.get(commit.hash);
    return stash ? { ...commit, parentHashes: commit.parentHashes.slice(0, 1) } : commit;
  });
}
