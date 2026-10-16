/**
 * Which changed files Git ignores, so live changes can skip a refresh for build output and
 * dependency folders (`out/`, `node_modules/`) that `git status` never shows.
 *
 * Each path is checked in the repository that holds it (a submodule has its own .gitignore), with
 * one `git check-ignore --stdin` per repository. Tracked files are never reported as ignored, even
 * when a pattern matches them, because their changes do show.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as path from 'path';
import { GitCommandService } from './gitCommandService';

/** The ignored subset of `paths` (absolute). Throws when Git cannot answer: the caller refreshes. */
export async function ignoredPaths(paths: string[], workspaceRoot: string, timeoutMs = 10000): Promise<Set<string>> {
  const byRoot = new Map<string, string[]>();
  const rootOf = new Map<string, string | undefined>();
  for (const file of paths) {
    const dir = path.dirname(file);
    if (!rootOf.has(dir)) { rootOf.set(dir, repositoryRoot(dir, workspaceRoot)); }
    const root = rootOf.get(dir);
    if (!root) { throw new Error(`Not in a repository: ${file}`); }
    const group = byRoot.get(root);
    if (group) { group.push(file); } else { byRoot.set(root, [file]); }
  }
  const ignored = new Set<string>();
  for (const [root, files] of byRoot) {
    const relative = new Map(files.map(file => [path.relative(root, file).split(path.sep).join('/'), file]));
    for (const name of await checkIgnore(root, [...relative.keys()], timeoutMs)) {
      const file = relative.get(name);
      if (file) { ignored.add(file); }
    }
  }
  return ignored;
}

/** The nearest folder at or above `dir`, inside the workspace, with a `.git` (a repository or a submodule). */
function repositoryRoot(dir: string, workspaceRoot: string): string | undefined {
  const top = path.resolve(workspaceRoot);
  for (let current = path.resolve(dir); ; current = path.dirname(current)) {
    if (path.relative(top, current).startsWith('..')) { return undefined; }
    if (existsSync(path.join(current, '.git'))) { return current; }
    if (current === top || path.dirname(current) === current) { return undefined; }
  }
}

/** `git check-ignore`: exit 0 lists the ignored paths, exit 1 means none is. */
function checkIgnore(root: string, names: string[], timeoutMs: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const args = ['check-ignore', '--stdin', '-z'];
    const started = Date.now();
    const child = spawn('git', args, { cwd: root, windowsHide: true });
    const out: Buffer[] = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('git check-ignore timed out')); }, timeoutMs);
    child.stdout.on('data', chunk => out.push(chunk));
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      GitCommandService.observer?.({ args, cwd: root, ms: Date.now() - started, ok: code === 0 || code === 1 });
      if (code === 0 || code === 1) {
        resolve(Buffer.concat(out).toString('utf8').split('\0').filter(Boolean));
      } else {
        reject(new Error(`git check-ignore exited with ${code}`));
      }
    });
    child.stdin.on('error', () => { /* Git exited early; 'close' reports it. */ });
    child.stdin.end(names.map(name => `${name}\0`).join(''));
  });
}
