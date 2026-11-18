/**
 * A write-ahead journal for a step's file writes (issue #140). Each write is recorded, and flushed to
 * disk, before the file itself changes; the journal goes once the step's result (with its changes) is
 * saved. A journal still there means the process ended while the step ran: recovery puts each file
 * back as it was before the step, unless the person changed it since. No `vscode` here.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface JournalEntry {
  /** Relative to `root`, with forward slashes. */
  path: string;
  /** The content before this write; null when the write created the file. */
  before: string | null;
  /** The content after this write; null when a script deleted the file. */
  after: string | null;
}

export class WriteJournal {
  constructor(readonly file: string, private readonly root: string) {}

  /** Appends one write and flushes it, before the caller writes the file. */
  record(entry: JournalEntry): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const handle = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(handle, `${JSON.stringify({ root: this.root, at: Date.now(), ...entry })}\n`);
      fs.fsyncSync(handle);
    } finally {
      fs.closeSync(handle);
    }
  }

  /** The step's changes are saved elsewhere (or undone): nothing left to recover. */
  clear(): void {
    fs.rmSync(this.file, { force: true });
  }
}

export interface Recovery {
  /** Files put back as they were before the step. */
  restored: string[];
  /** Files changed since the step, unreadable, or reached through a link: left as they are. */
  kept: string[];
}

/** Thrown when a journal exists but cannot be read: it is kept so recovery can be tried again. */
export class JournalUnreadable extends Error {}

/** When the journal's last write was recorded (ms), for undoing overlapping journals newest first. */
export function journalTime(file: string): number {
  let last = 0;
  for (const line of readJournal(file).split('\n')) {
    try { const at = (JSON.parse(line) as { at?: unknown }).at; if (typeof at === 'number' && at > last) { last = at; } } catch { /* torn */ }
  }
  return last || (() => { try { return fs.statSync(file).mtimeMs; } catch { return 0; } })();
}

function readJournal(file: string): string {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) {
    // Only a missing journal is an empty one: any other failure must not lose the saved contents.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return ''; }
    throw new JournalUnreadable(`The write journal ${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * The file a journal entry names, if it is still a plain file (or absent) inside the root once links
 * are resolved. A path that now leads elsewhere (a link put in its place, or in a parent folder's)
 * is never written through.
 */
function plainTarget(root: string, relative: string): string | undefined {
  const absolute = path.resolve(root, relative);
  const inside = (candidate: string, base: string) => { const rest = path.relative(base, candidate); return !rest.startsWith('..') && !path.isAbsolute(rest); };
  if (!inside(absolute, root)) { return undefined; }
  let realRoot: string;
  try { realRoot = fs.realpathSync(root); } catch { return undefined; }
  // The deepest folder that exists, resolved, must stay inside the root.
  let folder = path.dirname(absolute);
  while (!fs.existsSync(folder) && folder !== path.dirname(folder)) { folder = path.dirname(folder); }
  try { if (!inside(fs.realpathSync(folder), realRoot)) { return undefined; } } catch { return undefined; }
  try { if (fs.lstatSync(absolute).isSymbolicLink()) { return undefined; } } catch { /* absent: fine */ }
  return absolute;
}

/** Writes through a temporary file and a rename, so a crash never leaves the file half written. */
export function writeAtomically(absolute: string, content: string): void {
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${Date.now()}.tmp`);
  let mode: number | undefined;
  try { mode = fs.statSync(absolute).mode; } catch { mode = undefined; }
  fs.writeFileSync(temporary, content, mode === undefined ? undefined : { mode });
  try { fs.renameSync(temporary, absolute); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
}

/**
 * Puts back the files a journal names. For each file the journal holds its writes in order: the
 * content before the first one is restored when the file now holds any content of that chain (a
 * write that never reached the disk leaves the previous one). Anything else was changed since and is
 * kept. A torn last line (the process ended while recording) is ignored: its write never happened.
 * Writes go through a temporary file, so a file is always one complete state. Running it again
 * changes nothing more. The journal is removed afterwards; one that cannot be read is kept and
 * reported (JournalUnreadable).
 */
export function recoverJournal(file: string, isDirty: (absolutePath: string) => boolean = () => false): Recovery {
  const text = readJournal(file);
  const chains = new Map<string, { root: string; path: string; states: Array<string | null> }>();
  for (const line of text.split('\n')) {
    if (!line.trim()) { continue; }
    let entry: { root?: unknown; path?: unknown; before?: unknown; after?: unknown };
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry.root !== 'string' || typeof entry.path !== 'string' || !(entry.after === null || typeof entry.after === 'string')
      || !(entry.before === null || typeof entry.before === 'string')) { continue; }
    const key = `${entry.root}\u0000${entry.path}`;
    const chain = chains.get(key) ?? { root: entry.root, path: entry.path, states: [entry.before] };
    chain.states.push(entry.after);
    chains.set(key, chain);
  }
  const recovery: Recovery = { restored: [], kept: [] };
  for (const chain of chains.values()) {
    const absolute = plainTarget(chain.root, chain.path);
    if (!absolute) { recovery.kept.push(chain.path); continue; }
    let current: string | null;
    try { current = fs.readFileSync(absolute, 'utf8'); } catch { current = null; }
    const original = chain.states[0];
    if (current === original) { continue; }
    if (!chain.states.includes(current) || isDirty(absolute)) { recovery.kept.push(chain.path); continue; }
    if (original === null) { fs.rmSync(absolute, { force: true }); } else {
      // Absent now (a script deleted it): only an empty path is written, never a folder or link that is there instead.
      if (current === null) {
        try { fs.lstatSync(absolute); recovery.kept.push(chain.path); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { recovery.kept.push(chain.path); continue; } }
        try { fs.mkdirSync(path.dirname(absolute), { recursive: true }); } catch { recovery.kept.push(chain.path); continue; }
      }
      writeAtomically(absolute, original);
    }
    recovery.restored.push(chain.path);
  }
  fs.rmSync(file, { force: true });
  return recovery;
}
