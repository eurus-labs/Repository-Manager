import { GitCommandService } from './gitCommandService';

/** What a history action may write to the working tree. */
export interface TreeWrites {
  /** Commits whose whole tree is checked out. */
  trees: string[];
  /** Commit ranges whose commits are applied. */
  ranges: string[];
}

const CHUNK = 200;
const LISTED = 20;

/** True when staged or unstaged changes to tracked files exist. Untracked files do not count. */
export async function trackedChanges(git: GitCommandService, cwd: string): Promise<boolean> {
  return Boolean(await git.execGitRaw(['status', '--porcelain=v1', '-z', '--untracked-files=no'], cwd, 10000));
}

function split(output: string): string[] {
  return output.split('\0').filter(Boolean);
}

/**
 * The sorted untracked (not ignored) paths that the action would write. Git overwrites such a file
 * silently in `reset --hard` and stops a rebase half-way, so the caller refuses before running Git.
 */
export async function untrackedCollisions(git: GitCommandService, cwd: string, writes: TreeWrites): Promise<string[]> {
  if (!writes.trees.length && !writes.ranges.length) {
    return [];
  }
  const untracked = split(await git.execGitRaw(['ls-files', '--others', '--exclude-standard', '-z'], cwd, 30000));
  const found = new Set<string>();
  for (let start = 0; start < untracked.length; start += CHUNK) {
    const chunk = untracked.slice(start, start + CHUNK);
    const names = new Set(chunk);
    const written: string[] = [];
    for (const tree of writes.trees) {
      written.push(...split(await git.execGitRaw(['--literal-pathspecs', 'ls-tree', '-r', '-z', '--name-only', tree, '--', ...chunk], cwd, 30000)));
    }
    for (const range of writes.ranges) {
      written.push(...split(await git.execGitRaw(['--literal-pathspecs', 'log', '--no-renames', '--format=', '--name-only', '-z', range, '--', ...chunk], cwd, 30000)));
    }
    for (const file of written) {
      // A written path equal to an untracked file, or below a name that is one, is in its way.
      let candidate = file;
      while (candidate) {
        if (names.has(candidate)) {
          found.add(candidate);
          break;
        }
        const slash = candidate.lastIndexOf('/');
        candidate = slash > 0 ? candidate.slice(0, slash) : '';
      }
    }
  }
  return [...found].sort();
}

export function trackedChangesMessage(before: string): string {
  return `Commit, stash, or discard changes to tracked files before ${before}.`;
}

export function collisionMessage(action: string, paths: string[]): string {
  const shown = paths.slice(0, LISTED).join(', ');
  const more = paths.length > LISTED ? `, and ${paths.length - LISTED} more` : '';
  return `These untracked files would be overwritten by ${action}: ${shown}${more}. Move or commit them, then try again.`;
}

/** Throws the refusal for a collision; resolves when no untracked file is in the way. */
export async function assertNoCollisions(git: GitCommandService, cwd: string, action: string, writes: TreeWrites): Promise<void> {
  const paths = await untrackedCollisions(git, cwd, writes);
  if (paths.length) {
    throw new Error(collisionMessage(action, paths));
  }
}
