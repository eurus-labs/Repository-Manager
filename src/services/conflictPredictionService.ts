/**
 * Predicts the conflicts a history action would stop on, before it runs, by running the same
 * merges in memory with `git merge-tree --write-tree` (Git 2.40 or newer for --merge-base). Nothing
 * is checked out and no ref moves; a rebase's intermediate results are written as unreferenced
 * commits (`commit-tree`), which Git prunes like any other unreachable object.
 *
 * These are Git's own answers, not guesses: the dialog shows them as facts. A rebase is replayed
 * commit by commit and the prediction stops at the first one that conflicts, since what follows
 * depends on how that conflict is resolved.
 */

import { GitCommandService } from './gitCommandService';

export type PredictedOperation = 'cherry-pick' | 'revert' | 'merge' | 'rebase' | 'drop';

export interface PredictedConflict {
  /** The commit whose change conflicts (for merge, the merged commit). */
  commit: string;
  subject: string;
  paths: string[];
  /** Git's kind of each path's conflict ("contents", "modify/delete", "rename/delete", …). */
  kinds: Record<string, string[]>;
  /** The simulated result: its conflicted files hold diff3 markers (side A, base, side B). */
  tree: string;
  /** The commit side A stands for: HEAD, or for a rebase the commit being replayed onto. */
  sideA: string;
}

export interface ConflictPrediction {
  /** False when this Git cannot simulate it; `reason` says why, and nothing is claimed. */
  supported: boolean;
  reason?: string;
  operation: PredictedOperation;
  /** The selected commit (for rebase, the commit moved onto), resolved. */
  target: string;
  /** The current branch, or HEAD when detached. */
  branch: string;
  conflicts: PredictedConflict[];
  /** Commits replayed before the first conflict, out of `steps`. */
  replayed: number;
  steps: number;
  /** A rebase was not predicted past its first conflict. */
  stoppedEarly: boolean;
}

const MAX_STEPS = 200;

export class ConflictPredictionService {
  constructor(private git: GitCommandService) {}

  /**
   * `commit` is the selected commit; for rebase, the commit the current branch moves onto; for a
   * merge commit picked or reverted, `mainline` names the parent, as `git -m` does.
   */
  async predict(repositoryPath: string, operation: PredictedOperation, commit: string, mainline?: number): Promise<ConflictPrediction> {
    const cwd = this.git.resolveRepositoryPath(repositoryPath);
    const sha = await this.git.resolveRevision(repositoryPath, commit);
    const head = await this.git.resolveRevision(repositoryPath, 'HEAD');
    const branch = await this.git.execGit(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd, 5000).catch(() => 'HEAD');
    const result = (conflicts: PredictedConflict[], replayed: number, steps: number, stoppedEarly = false): ConflictPrediction =>
      ({ supported: true, operation, target: sha, branch, conflicts, replayed, steps, stoppedEarly });
    try {
      if (operation === 'merge' || operation === 'cherry-pick' || operation === 'revert') {
        let mergeBase: string | undefined;
        let theirs = sha;
        if (operation !== 'merge') {
          const parent = await this.git.execGit(['rev-parse', '--verify', `${sha}^${mainline || 1}^{commit}`], cwd, 5000)
            .catch(() => { throw new Unsupported('A root commit cannot be simulated.'); });
          // Picking applies parent → commit; reverting applies commit → parent.
          [mergeBase, theirs] = operation === 'cherry-pick' ? [parent, sha] : [sha, parent];
        }
        const merged = await this.mergeTree(cwd, mergeBase, head, theirs);
        return result(merged.paths.length ? [await this.conflict(cwd, sha, merged, head)] : [], 1, 1);
      }
      // rebase onto `sha`, or drop `sha`: replay the branch's own commits, oldest first.
      const onto = operation === 'drop' ? `${sha}^` : sha;
      const from = operation === 'drop' ? sha : await this.git.execGit(['merge-base', sha, head], cwd, 5000);
      const commits = (await this.git.execGit(['rev-list', '--reverse', '--first-parent', `${from}..${head}`], cwd, 10000))
        .split('\n').filter(Boolean);
      if (commits.length > MAX_STEPS) {
        throw new Unsupported(`More than ${MAX_STEPS} commits to replay; not simulated.`);
      }
      let base = await this.git.resolveRevision(repositoryPath, onto);
      for (let index = 0; index < commits.length; index++) {
        const step = commits[index];
        const merged = await this.mergeTree(cwd, `${step}^`, base, step);
        if (merged.paths.length) {
          return result([await this.conflict(cwd, step, merged, base)], index, commits.length, index < commits.length - 1);
        }
        base = await this.git.execGit(['commit-tree', merged.tree, '-p', base, '-m', 'conflict prediction'], cwd, 10000);
      }
      return result([], commits.length, commits.length);
    } catch (error) {
      if (error instanceof Unsupported) {
        return { supported: false, reason: error.message, operation, target: sha, branch, conflicts: [], replayed: 0, steps: 0, stoppedEarly: false };
      }
      throw error;
    }
  }

  private async conflict(cwd: string, commit: string, merged: MergeTreeResult, sideA: string): Promise<PredictedConflict> {
    const subject = await this.git.execGit(['show', '-s', '--format=%s', commit], cwd, 5000).catch(() => '');
    return { commit, subject, paths: merged.paths, kinds: merged.kinds, tree: merged.tree, sideA };
  }

  private async mergeTree(cwd: string, mergeBase: string | undefined, sideA: string, sideB: string): Promise<MergeTreeResult> {
    let output: string;
    try {
      // -z: paths exactly as they are; exit code 1 means "conflicts", with the tree still written.
      // diff3 keeps the base lines in the conflicted files, for an explanation of both changes.
      output = await this.git.execGitRaw(['-c', 'merge.conflictStyle=diff3', 'merge-tree', '--write-tree', '--name-only', '-z',
        ...(mergeBase ? [`--merge-base=${mergeBase}`] : []), sideA, sideB], cwd, 60000, true);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/unknown option|usage: git merge-tree/i.test(message)) {
        throw new Unsupported('Predicting conflicts needs Git 2.40 or newer.');
      }
      throw error;
    }
    return parseMergeTree(output);
  }
}

interface MergeTreeResult { tree: string; paths: string[]; kinds: Record<string, string[]> }

/**
 * `merge-tree --write-tree --name-only -z` output: the tree, the conflicted paths, an empty entry,
 * then messages as `<count> <path>… <type> <message>`. Only the conflict types are kept: the
 * messages name the sides by the hashes given to merge-tree, which the user never chose.
 */
export function parseMergeTree(output: string): MergeTreeResult {
  const entries = output.split('\0');
  const tree = entries[0];
  let index = 1;
  const paths: string[] = [];
  for (; index < entries.length && entries[index] !== ''; index++) { paths.push(entries[index]); }
  const kinds: Record<string, string[]> = {};
  for (index++; index < entries.length;) {
    const count = Number(entries[index]);
    if (!Number.isInteger(count) || count < 1) { break; }
    const named = entries.slice(index + 1, index + 1 + count);
    const type = /^CONFLICT \((.+)\)$/.exec(entries[index + 1 + count] || '');
    if (type) {
      for (const path of named) { kinds[path] = [...new Set([...(kinds[path] || []), type[1]])]; }
    }
    index += count + 3;
  }
  return { tree, paths: [...new Set(paths)], kinds };
}

class Unsupported extends Error {}
