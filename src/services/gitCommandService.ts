/**
 * Git Command Service
 * Base service for executing git commands
 */

import { execFile, spawn } from 'child_process';
import * as path from 'path';

/** A request was replaced by a newer one before it finished; nobody is waiting for its answer. */
export class SupersededError extends Error {
  constructor() { super('Superseded by a newer request'); this.name = 'SupersededError'; }
}

/** One finished Git process: for repositoryManager.debug.timings. */
export interface GitCommandTiming { args: string[]; cwd: string; ms: number; ok: boolean }

export class GitCommandService {
  /** Told about every Git process when set (repositoryManager.debug.timings); nothing else uses it. */
  static observer?: (timing: GitCommandTiming) => void;

  constructor(protected workspaceRoot: string) {}

  /**
   * Execute a git command and return the output
   */
  async execGit(args: string[], cwd?: string, timeoutMs: number = 30000): Promise<string> {
    const stdout = await this.execGitRaw(args, cwd, timeoutMs);
    return stdout.trim();
  }

  /**
   * Execute Git without a shell and preserve separators/whitespace for parsers.
   */
  async execGitRaw(
    args: string[],
    cwd?: string,
    timeoutMs: number = 30000,
    allowDiffExitCode = false,
    env?: NodeJS.ProcessEnv
  ): Promise<string> {
    const workDir = cwd || this.workspaceRoot;
    const started = Date.now();

    return new Promise((resolve, reject) => {
      execFile('git', args, {
        cwd: workDir,
        env,
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024,
        timeout: timeoutMs,
        windowsHide: true
      }, (error, stdout, stderr) => {
        GitCommandService.observer?.({ args, cwd: workDir, ms: Date.now() - started, ok: !error });
        if (!error || (allowDiffExitCode && error.code === 1 && !error.killed && !stderr.trim())) {
          resolve(stdout);
          return;
        }

        if (error.killed) {
          reject(new Error(`Git command timed out after ${timeoutMs}ms`));
          return;
        }

        reject(new Error(stderr.trim() || error.message || 'Git command failed'));
      });
    });
  }

  /** Read a Git object without UTF-8 conversion (binary detection and byte limits). */
  async execGitBuffer(args: string[], cwd?: string, timeoutMs = 30000): Promise<Buffer> {
    const workDir = cwd || this.workspaceRoot;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      execFile('git', args, {
        cwd: workDir, encoding: 'buffer',
        maxBuffer: 2 * 1024 * 1024, timeout: timeoutMs, windowsHide: true
      }, (error, stdout, stderr) => {
        GitCommandService.observer?.({ args, cwd: workDir, ms: Date.now() - started, ok: !error });
        if (error) {
          reject(new Error(error.killed ? `Git command timed out after ${timeoutMs}ms` : stderr.toString().trim() || error.message));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  /**
   * Resolve a repository path inside the workspace boundary.
   */
  resolveRepositoryPath(repositoryPath: string): string {
    const root = path.resolve(this.workspaceRoot);
    if (!repositoryPath || repositoryPath === '.') {
      return root;
    }

    if (path.isAbsolute(repositoryPath)) {
      throw new Error('Repository path must be relative to the workspace');
    }

    const resolved = path.resolve(root, repositoryPath);
    const relative = path.relative(root, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Repository path escapes the workspace: ${repositoryPath}`);
    }

    return resolved;
  }

  /**
   * Validate an object name before passing it to commands that accept revisions.
   */
  async resolveRevision(repositoryPath: string, revision: string): Promise<string> {
    if (!revision || revision.startsWith('-')) {
      throw new Error('Invalid Git revision');
    }

    const repositoryRoot = this.resolveRepositoryPath(repositoryPath);
    return this.execGit(['rev-parse', '--verify', `${revision}^{commit}`], repositoryRoot, 5000);
  }

  /**
   * Validate a repository-relative file path.
   */
  resolveFilePath(filePath: string): string {
    if (!filePath || path.isAbsolute(filePath)) {
      throw new Error('File path must be repository-relative');
    }
    const normalized = path.normalize(filePath);
    if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
      throw new Error('File path escapes the repository');
    }
    return normalized.split(path.sep).join('/');
  }

  /**
   * Runs Git and hands its output to `onRecord` one `separator`-terminated record at a time, without
   * buffering it all. `onRecord` returns true to stop: Git is then killed, so a search can end as soon
   * as it has enough matches instead of reading a whole history.
   */
  scanGitRecords(args: string[], cwd: string, separator: string, onRecord: (record: string) => boolean, timeoutMs = 30000,
    signal?: AbortSignal, maxRecordChars = 0): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(new SupersededError()); return; }
      const started = Date.now();
      const child = spawn('git', args, { cwd, windowsHide: true });
      let pending = '';
      let stderr = '';
      let done = false;
      const finish = (error?: Error) => {
        if (done) { return; }
        done = true;
        GitCommandService.observer?.({ args, cwd, ms: Date.now() - started, ok: !error });
        clearTimeout(timer);
        if (error) { reject(error); } else { resolve(); }
      };
      const timer = setTimeout(() => { child.kill(); finish(new Error(`Git command timed out after ${timeoutMs}ms`)); }, timeoutMs);
      // A newer request replaced this one: stop Git instead of letting it read on.
      signal?.addEventListener('abort', () => { child.kill(); finish(new SupersededError()); }, { once: true });
      // onRecord runs inside a stream event: an exception there must reject this promise, not escape
      // into the extension host.
      const handle = (record: string): boolean => {
        try { return onRecord(record); } catch (error) { child.kill(); finish(error instanceof Error ? error : new Error(String(error))); return true; }
      };
      // With maxRecordChars, a record longer than that (a minified file's only line) is handed over
      // cut to that length, and the rest of it is skipped instead of held in memory.
      let skipping = false;
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (done) { return; }
        pending += chunk;
        if (skipping) {
          const end = pending.indexOf(separator);
          if (end < 0) { pending = ''; return; }
          pending = pending.slice(end + separator.length);
          skipping = false;
        }
        let index = pending.indexOf(separator);
        while (index >= 0) {
          const record = pending.slice(0, index);
          pending = pending.slice(index + separator.length);
          if (handle(record)) { child.kill(); finish(); return; }
          index = pending.indexOf(separator);
        }
        if (maxRecordChars > 0 && pending.length > maxRecordChars) {
          if (handle(pending.slice(0, maxRecordChars))) { child.kill(); finish(); return; }
          pending = '';
          skipping = true;
        }
      });
      child.stderr.on('data', data => { stderr += data.toString(); });
      child.on('error', error => finish(error));
      child.on('close', code => {
        if (!done && code === 0 && !skipping && pending.trim()) { handle(pending); }
        finish(code === 0 ? undefined : new Error(stderr.trim() || `Git command failed with code ${code}`));
      });
    });
  }

  /**
   * Execute git command with streaming output
   */
  execGitStream(args: string[], cwd?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const workDir = cwd || this.workspaceRoot;
      const process = spawn('git', args, { cwd: workDir });

      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(stderr || `Git command failed with code ${code}`));
        }
      });

      process.on('error', (error) => {
        reject(error);
      });
    });
  }

  /**
   * Check if the workspace is a git repository
   */
  async isGitRepository(): Promise<boolean> {
    try {
      await this.execGit(['rev-parse', '--git-dir']);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Get the workspace root
   */
  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }
}
