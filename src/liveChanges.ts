/**
 * Keeps the dashboard's view of local changes current while you edit: file events in the
 * workspace (saves, creates, deletes, and Git's own index and ref updates) schedule one repository
 * refresh after they settle, instead of a `git status` per event.
 *
 * Git's internal churn (objects, logs, lock files) is ignored, and so is a batch of files that Git
 * ignores (build output, dependency folders), checked with `git check-ignore` once the batch settles. While the dashboard is hidden, or a
 * user action is running, the refresh waits and runs once when it can. Nothing here depends on
 * VS Code, so it is tested with a fake clock.
 */

export interface LiveChangesDeps {
  /**
   * Refreshes the repository list (status and change counts of every repository). `refsChanged`:
   * a branch, tag or stash changed (made, moved or deleted, e.g. in a terminal), which HEAD alone
   * does not show, so the branch list and graph need reading again.
   */
  refresh(change?: { refsChanged: boolean }): Promise<void>;
  /** Whether a refresh may run now: the dashboard is visible and no user action is running. */
  canRefresh(): boolean;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
  /** Milliseconds now (a fake clock in tests). */
  now?(): number;
  /** The subset of changed working-tree files that Git ignores; when all are, no refresh runs. */
  ignored?(paths: string[]): Promise<Set<string>>;
}

/** Past this many changed files in one batch (a checkout, an install), refresh without checking them. */
export const MAX_CHECKED_FILES = 2000;

/**
 * After a refresh, index files changed only by it are ignored for this long: `git status` (ours, or
 * VS Code's Git) rewrites the index to record file stat data, which must not start another refresh.
 */
export const SELF_INDEX_WRITE_MS = 1500;

/** How long file events must be quiet before the refresh runs. */
export const LIVE_CHANGES_DELAY_MS = 800;

/**
 * Whether a changed path can change what the dashboard shows. Inside `.git` (and a submodule's Git
 * directory under .git/modules/<name>/, whose name may have slashes, or a linked worktree's under
 * .git/worktrees/<name>/), the index, HEAD, refs, packed-refs and info/exclude do; objects, logs,
 * hooks and lock files only churn while Git works.
 */
export function affectsStatus(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const at = normalized.indexOf('/.git/');
  if (at < 0) { return !normalized.endsWith('/.git'); }
  const inner = normalized.slice(at + '/.git/'.length);
  if (inner.endsWith('.lock') || /(^|\/)(logs|objects|hooks)\//.test(inner)) { return false; }
  return /(^|\/)(index|HEAD|packed-refs)$/.test(inner) || /(^|\/)refs\//.test(inner) || /(^|\/)info\/exclude$/.test(inner);
}

/** Whether a changed path is a branch, tag or stash ref (loose under refs/, or packed-refs). */
export function affectsRefs(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const at = normalized.indexOf('/.git/');
  if (at < 0) { return false; }
  const inner = normalized.slice(at + '/.git/'.length);
  // A reflog (logs/refs/...) records a move; the ref itself is what changed.
  if (inner.endsWith('.lock') || /(^|\/)(logs|objects|hooks)\//.test(inner)) { return false; }
  return /(^|\/)packed-refs$/.test(inner) || /(^|\/)refs\//.test(inner);
}

/** An index file (the parent's, a submodule's or a worktree's): what `git status` itself rewrites. */
function isIndexFile(filePath: string): boolean {
  return /\/\.git\/(.+\/)?index$/.test(filePath.replace(/\\/g, '/'));
}

/** A path in a Git directory (or a `.git` file), as opposed to a working-tree file. */
function isInsideGit(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/.git/') || normalized.endsWith('/.git');
}

export class LiveChanges {
  private timer: unknown;
  private pending = false;
  private running = false;
  private disposed = false;
  /** Until when index-only events come from our own refresh. */
  private quietIndexUntil = 0;
  /** Working-tree files changed since the last refresh, to check against .gitignore. */
  private files = new Set<string>();
  /** A change that refreshes whatever the files are: inside .git, or too many files to check. */
  private mustRefresh = false;
  /** A ref changed since the last refresh. */
  private refsChanged = false;

  constructor(private readonly deps: LiveChangesDeps, private readonly delayMs = LIVE_CHANGES_DELAY_MS) {}

  /** A file event: the refresh runs once the events have been quiet for the delay. */
  notify(filePath: string): void {
    if (this.disposed || !affectsStatus(filePath)) { return; }
    if (isIndexFile(filePath) && this.clock() < this.quietIndexUntil) { return; }
    this.pending = true;
    if (affectsRefs(filePath)) { this.refsChanged = true; }
    if (!this.deps.ignored || isInsideGit(filePath) || this.files.size >= MAX_CHECKED_FILES) {
      this.mustRefresh = true;
    } else {
      this.files.add(filePath);
    }
    if (this.timer !== undefined) { this.deps.clearTimer(this.timer); }
    this.timer = this.deps.setTimer(() => { this.timer = undefined; void this.flush(); }, this.delayMs);
  }

  /** The dashboard became visible, or an action finished: run a refresh that had to wait. */
  resume(): void {
    if (this.pending && this.timer === undefined) { void this.flush(); }
  }

  /** Whether Git ignores every file; when it cannot tell, it does not. */
  private async allIgnored(files: string[]): Promise<boolean> {
    try {
      const ignored = await this.deps.ignored!(files);
      return files.every(file => ignored.has(file));
    } catch {
      return false;
    }
  }

  private clock(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) { this.deps.clearTimer(this.timer); }
    this.timer = undefined;
  }

  private async flush(): Promise<void> {
    if (this.disposed || !this.pending || this.running || !this.deps.canRefresh()) { return; }
    this.pending = false;
    this.running = true;
    const files = [...this.files];
    const mustRefresh = this.mustRefresh || files.length === 0;
    const refsChanged = this.refsChanged;
    this.files = new Set();
    this.mustRefresh = false;
    this.refsChanged = false;
    try {
      if (mustRefresh || !(await this.allIgnored(files))) {
        try {
          await this.deps.refresh({ refsChanged });
        } catch {
          // The next file event, or the next action, refreshes again.
        } finally {
          this.quietIndexUntil = this.clock() + SELF_INDEX_WRITE_MS;
        }
      }
    } finally {
      this.running = false;
    }
    // Events during the refresh asked for another one.
    if (this.pending && this.timer === undefined) { void this.flush(); }
  }
}
