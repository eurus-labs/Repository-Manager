/**
 * A commit object holding the working tree as it is now, so local changes can be reviewed like any
 * other diff (HEAD → snapshot) by an engine that reads revisions.
 *
 * The snapshot is built in a temporary index copied from the real one, then `git add -A` (staged and
 * unstaged changes, and new files that .gitignore does not exclude), and written with `commit-tree`.
 * HEAD, branches, the real index and the working tree are not touched. While a saved review reads a
 * snapshot, a ref under SNAPSHOT_REF_PREFIX keeps it (`keepSnapshots`); without one, Git removes the
 * commit in a later garbage collection, like any unreachable object.
 *
 * The commit's author, committer and dates are fixed (HEAD's date), so the same changes on the same
 * HEAD give the same commit: running the review again reuses its saved components and decisions.
 */

import * as path from 'path';
import { copyFileSync, existsSync, rmSync } from 'fs';
import { GitCommandService } from './gitCommandService';

export interface LocalChangesSnapshot {
  headSha: string;
  snapshotSha: string;
}

export const SNAPSHOT_MESSAGE = 'Local changes (Repository Manager review snapshot)';

/** Limit each explicit path list without widening a discard's snapshot to unrelated files. */
const MAX_LISTED_PATHS = 200;

/**
 * The snapshot of `root`'s working tree; undefined when there is nothing beyond HEAD. Throws without a first commit.
 * With `paths`, only those files are taken from the working tree (on top of what is staged): a
 * discard needs a copy of the files it changes, not of every untracked file in the repository.
 */
export async function snapshotLocalChanges(git: GitCommandService, root: string, paths?: string[]): Promise<LocalChangesSnapshot | undefined> {
  // Independent reads run together: each Git process costs its start-up time, which is most of it on Windows.
  const [head, gitIndex, headInfo] = await Promise.allSettled([
    git.execGit(['rev-parse', '--verify', 'HEAD^{commit}'], root, 10000),
    git.execGit(['rev-parse', '--git-path', 'index'], root),
    // HEAD's date (the snapshot's fixed date) and tree (to tell whether anything changed).
    git.execGit(['log', '-1', '--format=%cI%n%T', 'HEAD'], root, 10000)
  ]);
  if (head.status === 'rejected') {
    throw new Error('This repository has no commit yet: commit once, then review the changes after it.');
  }
  if (gitIndex.status === 'rejected') { throw gitIndex.reason; }
  if (headInfo.status === 'rejected') { throw headInfo.reason; }
  const headSha = head.value;
  const [date, headTree] = headInfo.value.split('\n');
  const indexPath = path.resolve(root, gitIndex.value);
  const temporaryIndex = `${indexPath}.repository-manager-review-${process.pid}-${Date.now()}`;
  try {
    // From the real index, so what is staged (including intent-to-add entries) is the starting point.
    if (existsSync(indexPath)) { copyFileSync(indexPath, temporaryIndex); }
    const env: NodeJS.ProcessEnv = { ...process.env };
    env['GIT_INDEX_FILE'] = temporaryIndex;
    if (!existsSync(indexPath)) { await git.execGitRaw(['read-tree', 'HEAD'], root, 30000, false, env); }
    if (paths?.length) {
      // A discard may overwrite a recreated rename source even when it is now ignored. Copy every
      // explicitly requested path, and fail before discarding if any cannot be copied.
      for (let index = 0; index < paths.length; index += MAX_LISTED_PATHS) {
        await git.execGitRaw(['--literal-pathspecs', 'add', '-A', '-f', '--',
          ...paths.slice(index, index + MAX_LISTED_PATHS)], root, 60000, false, env);
      }
    } else {
      await git.execGitRaw(['add', '-A'], root, 60000, false, env);
    }
    const tree = (await git.execGitRaw(['write-tree'], root, 30000, false, env)).trim();
    if (tree === headTree) { return undefined; }
    // A fixed identity and date: the snapshot never leaves this repository, and needs no user identity.
    for (const role of ['AUTHOR', 'COMMITTER']) {
      env[`GIT_${role}_NAME`] = 'Repository Manager';
      env[`GIT_${role}_EMAIL`] = 'review-snapshot@localhost';
      env[`GIT_${role}_DATE`] = date;
    }
    const snapshotSha = (await git.execGitRaw(['commit-tree', tree, '-p', headSha, '-m', SNAPSHOT_MESSAGE], root, 30000, false, env)).trim();
    return { headSha, snapshotSha };
  } finally {
    rmSync(temporaryIndex, { force: true });
  }
}

/**
 * Where the snapshots of saved reviews are kept: outside branches, tags and remotes, so `git branch`,
 * `git tag` and a plain push leave them out, and the dashboard's history leaves them out too.
 */
export const SNAPSHOT_REF_PREFIX = 'refs/repository-manager/snapshots/';
const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * Keeps exactly the snapshots in `keep` from garbage collection: a ref under SNAPSHOT_REF_PREFIX for
 * each one that still exists, and none for any other. Only refs under that prefix are touched.
 */
export async function keepSnapshots(git: GitCommandService, root: string, keep: string[]): Promise<void> {
  const wanted = new Set(keep.filter(sha => FULL_SHA.test(sha)));
  const existing = (await git.execGit(['for-each-ref', '--format=%(refname)', SNAPSHOT_REF_PREFIX], root, 10000))
    .split('\n').filter(Boolean);
  for (const ref of existing) {
    if (!wanted.has(ref.slice(SNAPSHOT_REF_PREFIX.length))) { await git.execGit(['update-ref', '-d', ref], root, 10000); }
  }
  for (const sha of wanted) {
    if (existing.includes(`${SNAPSHOT_REF_PREFIX}${sha}`)) { continue; }
    // Removed already (before it was kept, or by a gc elsewhere): there is nothing left to keep.
    const exists = await git.execGit(['cat-file', '-e', `${sha}^{commit}`], root, 10000).then(() => true, () => false);
    if (exists) { await git.execGit(['update-ref', `${SNAPSHOT_REF_PREFIX}${sha}`, sha], root, 10000); }
  }
}
