/**
 * What a repository script changed in the working tree (issue #139). An approved npm script runs as
 * a process, not through edit_file, so its writes are not in the step's records. The tree is
 * compared before and after the script, through Git: modified tracked files and files not ignored
 * (new, or changed again) are found, anywhere in the repository. A text file becomes a normal change
 * (review shows it, Retry and Stop undo it unless it changed again since); a deleted text file is a change with `after: null` (its content just before the script is known).
 * What cannot be put back is named instead: a deleted binary or large file, or a linked file. Files Git ignores (build output, caches,
 * node_modules) and anything outside the repository are not watched. No `vscode` here.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';

export const MAX_TRACKED_BYTES = 200 * 1024;
const MAX_HASHED_BYTES = 8 * 1024 * 1024;

/** What one path held: text we can restore, nothing, or something we can only compare. */
export type PathState = { kind: 'text'; text: string } | { kind: 'absent' } | { kind: 'opaque'; signature: string };

export interface ScriptEffects {
  /** Text files the script created, changed or deleted: content before the script (null: created) and after (null: deleted). */
  changes: Array<{ path: string; before: string | null; after: string | null }>;
  /** Paths the script changed that cannot be put back (deleted, binary, large, a link), with why. */
  unrecoverable: Array<{ path: string; reason: string }>;
}

function git(root: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd: root, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export function classify(buffer: Buffer): PathState {
  if (buffer.length <= MAX_TRACKED_BYTES && !buffer.includes(0)) {
    const text = buffer.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(buffer)) { return { kind: 'text', text }; }
  }
  return { kind: 'opaque', signature: crypto.createHash('sha1').update(buffer).digest('hex') };
}

/** Whether `relative` reaches its file through a link in a parent folder (root is a real path). */
function throughLink(root: string, relative: string): boolean {
  const parent = path.dirname(path.join(root, relative));
  let probe = parent;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) { probe = path.dirname(probe); }
  try { return fs.realpathSync(probe) !== probe; } catch { return true; }
}

const VIA_LINK = 'via-link';

function readState(root: string, relative: string): PathState {
  // A folder that is now a link leads outside the repository (or elsewhere in it): never read through it.
  if (throughLink(root, relative)) { return { kind: 'opaque', signature: VIA_LINK }; }
  const absolute = path.join(root, relative);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(absolute); } catch { return { kind: 'absent' }; }
  if (stat.isSymbolicLink()) {
    let target = '';
    try { target = fs.readlinkSync(absolute); } catch { /* unreadable */ }
    return { kind: 'opaque', signature: `link:${target}` };
  }
  if (!stat.isFile()) { return { kind: 'opaque', signature: `not-a-file:${stat.mtimeMs}` }; }
  if (stat.size > MAX_HASHED_BYTES) { return { kind: 'opaque', signature: `size:${stat.size}:${stat.mtimeMs}` }; }
  try { return classify(fs.readFileSync(absolute)); } catch { return { kind: 'opaque', signature: `unreadable:${stat.mtimeMs}` }; }
}

/** The paths Git reports as not clean (staged, modified, deleted, untracked), one entry per path. */
async function dirtyPaths(root: string): Promise<string[]> {
  const output = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).toString('utf8');
  const parts = output.split('\0').filter(Boolean);
  const paths: string[] = [];
  for (let index = 0; index < parts.length; index++) {
    const entry = parts[index];
    const code = entry.slice(0, 2);
    paths.push(entry.slice(3));
    // A rename or copy lists its source as the next entry.
    if (/[RC]/.test(code)) { const source = parts[++index]; if (source) { paths.push(source); } }
  }
  return paths;
}

/**
 * What a clean path held: HEAD's content as checked out (line endings and filters applied, as on
 * disk), or nothing when HEAD does not have it.
 */
async function headState(root: string, relative: string): Promise<PathState> {
  try { return classify(await git(root, ['cat-file', '--filters', `HEAD:${relative}`])); } catch { return { kind: 'absent' }; }
}

export interface ScriptSnapshot { readonly root: string; readonly states: Map<string, PathState> }

/** The state of every path that is not clean now. Throws when the folder is not a readable Git repository. */
export async function snapshotTree(root: string): Promise<ScriptSnapshot> {
  const states = new Map<string, PathState>();
  for (const relative of await dirtyPaths(root)) { states.set(relative, readState(root, relative)); }
  return { root, states };
}

const same = (a: PathState, b: PathState): boolean =>
  a.kind === b.kind && (a.kind === 'text' ? a.text === (b as typeof a).text : a.kind === 'opaque' ? a.signature === (b as typeof a).signature : true);

/** What changed between a snapshot taken before a script and the tree now. */
export async function diffSince(before: ScriptSnapshot): Promise<ScriptEffects> {
  const effects: ScriptEffects = { changes: [], unrecoverable: [] };
  const candidates = new Set([...before.states.keys(), ...await dirtyPaths(before.root)]);
  for (const relative of [...candidates].sort()) {
    const was = before.states.get(relative) ?? await headState(before.root, relative);
    const now = readState(before.root, relative);
    if (same(was, now)) { continue; }
    if (now.kind === 'absent') {
      // A deletion whose state before the script was text is a change; undo writes it back.
      if (was.kind === 'text') { effects.changes.push({ path: relative, before: was.text, after: null }); } else { effects.unrecoverable.push({ path: relative, reason: 'deleted' }); }
      continue;
    }
    if (now.kind === 'opaque' || was.kind === 'opaque') {
      const link = now.kind === 'opaque' && (now.signature === VIA_LINK || now.signature.startsWith('link:'));
      effects.unrecoverable.push({ path: relative, reason: link ? 'reached through a link' : 'binary, large or not a plain file' });
      continue;
    }
    effects.changes.push({ path: relative, before: was.kind === 'text' ? was.text : null, after: now.text });
  }
  return effects;
}
