import { stashDiffTarget } from './stashTarget';
import { GitCommandService } from './gitCommandService';

const MAX_TREE_ENTRIES = 50000;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIFF_BYTES = 256 * 1024;
const MAX_SEARCH_FILES = 200;
const MAX_SEARCH_MATCHES = 100;
const MAX_SEARCH_BYTES = 16 * 1024 * 1024;

export interface SnapshotEntry { path: string; mode: string; objectId: string; type: string }
export interface SnapshotTree { entries: SnapshotEntry[]; truncated: boolean; totalEntries: number }
export interface SnapshotFile {
  path: string; revision: string; content: string; startLine: number; endLine: number;
  totalLines: number; truncated: boolean;
}
export interface SnapshotSearch {
  matches: { path: string; line: number; text: string }[];
  checkedFiles: number;
  skipped: { path: string; reason: string }[];
  truncated: boolean;
}
export interface SnapshotDiff { baseSha: string; targetSha: string; patch: string; truncated: boolean }

/** Read-only, bounded access to a commit, including commits that are not checked out. */
export class ReviewSnapshot {
  private readonly byPath: Map<string, SnapshotEntry>;

  constructor(
    private git: GitCommandService,
    readonly repositoryPath: string,
    readonly targetSha: string,
    readonly tree: SnapshotTree
  ) {
    this.byPath = new Map(tree.entries.map(entry => [entry.path, entry]));
  }

  listTree(prefix = '', limit = 500): SnapshotTree {
    if (!Number.isInteger(limit) || limit < 1 || limit > 5000) {throw new Error('Invalid tree limit');}
    const normalized = prefix ? this.safePath(prefix) : '';
    const entries = this.tree.entries.filter(entry => !normalized || entry.path === normalized || entry.path.startsWith(`${normalized}/`));
    return { entries: entries.slice(0, limit), totalEntries: entries.length, truncated: this.tree.truncated || entries.length > limit };
  }

  /** Tree entry for an exact repository path, in constant time. */
  entry(filePath: string): SnapshotEntry | undefined {
    return this.byPath.get(filePath);
  }

  fileExists(filePath: string): boolean {
    return this.byPath.has(this.safePath(filePath));
  }

  async readFile(filePath: string, startLine = 1, lineCount = 200): Promise<SnapshotFile> {
    if (!Number.isInteger(startLine) || startLine < 1 || !Number.isInteger(lineCount) || lineCount < 1 || lineCount > 500) {
      throw new Error('Invalid line range');
    }
    const normalized = this.safePath(filePath);
    const entry = this.byPath.get(normalized);
    if (!entry) {
      throw new Error(this.tree.truncated
        ? `File unavailable; snapshot tree truncated: ${normalized}`
        : `File is not in the snapshot: ${normalized}`);
    }
    if (entry.mode === '160000' || entry.mode === '120000' || entry.type !== 'blob') {
      throw new Error(`Cannot read gitlink or symlink as source code: ${normalized}`);
    }
    const bytes = await this.readBlob(entry);
    if (bytes.includes(0)) {throw new Error(`Binary file is not readable as text: ${normalized}`);}
    const lines = bytes.toString('utf8').split(/\r?\n/);
    if (lines[lines.length - 1] === '') {lines.pop();}
    const endLine = Math.min(lines.length, startLine + lineCount - 1);
    return {
      path: normalized, revision: this.targetSha,
      content: lines.slice(startLine - 1, endLine).join('\n'), startLine, endLine,
      totalLines: lines.length, truncated: startLine > 1 || endLine < lines.length
    };
  }

  async searchCode(query: string, prefix = ''): Promise<SnapshotSearch> {
    if (!query || query.length > 200 || query.includes('\0')) {throw new Error('Invalid search query');}
    const normalized = prefix ? this.safePath(prefix) : '';
    const entries = this.tree.entries.filter(entry => !normalized || entry.path === normalized || entry.path.startsWith(`${normalized}/`));
    const matches: SnapshotSearch['matches'] = [];
    const skipped: SnapshotSearch['skipped'] = [];
    let checkedFiles = 0;
    let scannedBytes = 0;
    let truncated = this.tree.truncated;
    for (const entry of entries) {
      if (matches.length >= MAX_SEARCH_MATCHES || checkedFiles >= MAX_SEARCH_FILES || scannedBytes >= MAX_SEARCH_BYTES) {
        truncated = true;
        break;
      }
      if (entry.type !== 'blob' || entry.mode === '120000') {
        skipped.push({ path: entry.path, reason: 'gitlink or symlink' });
        continue;
      }
      try {
        const bytes = await this.readBlob(entry);
        scannedBytes += bytes.length;
        if (bytes.includes(0)) {
          skipped.push({ path: entry.path, reason: 'binary file' });
          continue;
        }
        checkedFiles++;
        bytes.toString('utf8').split(/\r?\n/).forEach((text, index) => {
          if (matches.length < MAX_SEARCH_MATCHES && text.includes(query)) {
            matches.push({ path: entry.path, line: index + 1, text: text.slice(0, 500) });
          }
        });
      } catch (error) {
        skipped.push({ path: entry.path, reason: error instanceof Error ? error.message : 'unreadable' });
      }
    }
    return { matches, checkedFiles, skipped, truncated };
  }

  async readDiff(baseSha: string, filePath?: string): Promise<SnapshotDiff> {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseSha)) {throw new Error('Base must be a commit SHA');}
    const resolvedBase = await this.git.execGit(['rev-parse', '--verify', `${baseSha}^{commit}`], this.repositoryPath, 5000);
    const args = ['-c', 'diff.external=', 'diff', '--no-ext-diff', '--no-textconv', '--unified=3', resolvedBase, this.targetSha, '--'];
    if (filePath) {args.push(this.safePath(filePath));}
    const patch = await this.git.execGitRaw(args, this.repositoryPath, 20000);
    const bytes = Buffer.from(patch, 'utf8');
    return { baseSha: resolvedBase, targetSha: this.targetSha,
      patch: bytes.subarray(0, MAX_DIFF_BYTES).toString('utf8'), truncated: bytes.length > MAX_DIFF_BYTES };
  }

  private safePath(filePath: string): string {
    if (filePath.includes('\0') || filePath === '.' || filePath.startsWith('-')) {throw new Error('Invalid snapshot path');}
    return this.git.resolveFilePath(filePath);
  }

  private async readBlob(entry: SnapshotEntry): Promise<Buffer> {
    const size = Number(await this.git.execGit(['cat-file', '-s', entry.objectId], this.repositoryPath, 10000));
    if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) {throw new Error('File exceeds snapshot read budget');}
    // cat-file takes an object ID from ls-tree; it never reads the current working tree.
    return this.git.execGitBuffer(['cat-file', 'blob', entry.objectId], this.repositoryPath, 10000);
  }
}

export class ReviewSnapshotService {
  constructor(private git: GitCommandService) {}

  async open(repositoryPath: string, revision: string): Promise<ReviewSnapshot> {
    const root = this.git.resolveRepositoryPath(repositoryPath);
    // A stash is reviewed with its untracked files: the snapshot reads the commit holding them.
    const targetSha = await stashDiffTarget(this.git, root, await this.git.resolveRevision(repositoryPath, revision));
    const output = await this.git.execGitRaw(['ls-tree', '-rz', '--full-tree', targetSha], root, 30000);
    const records = output.split('\0').filter(Boolean);
    const entries = records.slice(0, MAX_TREE_ENTRIES).map(record => {
      const tab = record.indexOf('\t');
      const header = record.slice(0, tab).split(' ');
      if (tab < 0 || header.length !== 3 || !/^[a-f0-9]{40}$|^[a-f0-9]{64}$/.test(header[2])) {
        throw new Error('Invalid Git tree entry');
      }
      return { mode: header[0], type: header[1], objectId: header[2], path: record.slice(tab + 1) };
    });
    return new ReviewSnapshot(this.git, root, targetSha,
      { entries, totalEntries: records.length, truncated: records.length > MAX_TREE_ENTRIES });
  }
}
