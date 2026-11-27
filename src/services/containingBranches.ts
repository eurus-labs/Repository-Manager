/**
 * The branches that contain a commit, for the dashboard's commit details. One `git for-each-ref`
 * lists local and remote branches together; names are read from full ref names, never guessed from
 * a short name (a local branch may be called `origin/topic` next to `refs/remotes/origin/topic`).
 */

import { GitCommandService } from './gitCommandService';
import { SNAPSHOT_REF_PREFIX } from './localChangesSnapshot';
import { DISCARD_REF_PREFIX } from './discardService';

/** One branch shown as a chip: a local branch (with the origin copy folded in) or a remote-only one. */
export interface ContainingBranch {
  /** `x` for a local branch, `origin/x` (the full remote name) for a remote-only one. */
  name: string;
  kind: 'local' | 'remote';
  /** The checked-out branch. */
  current: boolean;
  /** A local branch whose `origin/<name>` also contains the commit. */
  onOrigin: boolean;
}

export const CONTAINING_BRANCHES_TIMEOUT_MS = 10000;

const HEADS = 'refs/heads/';
const REMOTES = 'refs/remotes/';

export async function listContainingBranches(
  git: GitCommandService,
  repositoryPath: string,
  commitHash: string
): Promise<ContainingBranch[]> {
  // A hex object name only: nothing else, least of all an option, reaches Git.
  if (typeof commitHash !== 'string' || !/^[0-9a-f]{4,64}$/i.test(commitHash)) {
    throw new Error('Invalid commit hash');
  }
  const sha = await git.resolveRevision(repositoryPath, commitHash);
  const root = git.resolveRepositoryPath(repositoryPath);
  const output = await git.execGitRaw(
    ['for-each-ref', '--contains', sha, '--format=%(HEAD)%00%(refname)', 'refs/heads', 'refs/remotes'],
    root,
    CONTAINING_BRANCHES_TIMEOUT_MS
  );

  const locals = new Map<string, boolean>();
  const remotes: string[] = [];
  for (const line of output.split('\n')) {
    const [head, ref] = line.split('\0');
    if (!ref || ref.startsWith(SNAPSHOT_REF_PREFIX) || ref.startsWith(DISCARD_REF_PREFIX)) { continue; }
    if (ref.startsWith(HEADS)) {
      const name = ref.slice(HEADS.length);
      if (name) { locals.set(name, head === '*'); }
    } else if (ref.startsWith(REMOTES)) {
      const name = ref.slice(REMOTES.length);
      // `origin/HEAD` is a pointer to a branch, and a bare remote name is not a branch.
      if (!name.includes('/') || /^[^/]+\/HEAD$/.test(name)) { continue; }
      remotes.push(name);
    }
  }

  const folded = new Set<string>();
  const result: ContainingBranch[] = [];
  for (const [name, current] of locals) {
    const onOrigin = remotes.includes(`origin/${name}`);
    if (onOrigin) { folded.add(`origin/${name}`); }
    result.push({ name, kind: 'local', current, onOrigin });
  }
  for (const name of remotes) {
    if (!folded.has(name)) { result.push({ name, kind: 'remote', current: false, onOrigin: false }); }
  }
  const rank = (branch: ContainingBranch): number => (branch.current ? 0 : branch.kind === 'local' ? 1 : 2);
  return result.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
