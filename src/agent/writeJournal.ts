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
  after: string;
}

export class WriteJournal {
  constructor(readonly file: string, private readonly root: string) {}

  /** Appends one write and flushes it, before the caller writes the file. */
  record(entry: JournalEntry): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const handle = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(handle, `${JSON.stringify({ root: this.root, ...entry })}\n`);
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
  /** Files changed since the step (or unreadable): left as they are. */
  kept: string[];
}

/**
 * Puts back the files a journal names. For each file the journal holds its writes in order: the
 * content before the first one is restored when the file now holds any content of that chain (a
 * write that never reached the disk leaves the previous one). Anything else was changed since and is
 * kept. A torn last line (the process ended while recording) is ignored: its write never happened.
 * Running it again changes nothing more. The journal is removed afterwards.
 */
export function recoverJournal(file: string, isDirty: (absolutePath: string) => boolean = () => false): Recovery {
  const text = (() => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } })();
  const chains = new Map<string, { root: string; path: string; states: Array<string | null> }>();
  for (const line of text.split('\n')) {
    if (!line.trim()) { continue; }
    let entry: { root?: unknown; path?: unknown; before?: unknown; after?: unknown };
    try { entry = JSON.parse(line); } catch { continue; }
    if (typeof entry.root !== 'string' || typeof entry.path !== 'string' || typeof entry.after !== 'string'
      || !(entry.before === null || typeof entry.before === 'string')) { continue; }
    const key = `${entry.root}\u0000${entry.path}`;
    const chain = chains.get(key) ?? { root: entry.root, path: entry.path, states: [entry.before] };
    chain.states.push(entry.after);
    chains.set(key, chain);
  }
  const recovery: Recovery = { restored: [], kept: [] };
  for (const chain of chains.values()) {
    const absolute = path.resolve(chain.root, chain.path);
    // Only inside the root the journal was written for.
    if (path.relative(chain.root, absolute).startsWith('..') || path.isAbsolute(path.relative(chain.root, absolute))) { continue; }
    let current: string | null;
    try { current = fs.readFileSync(absolute, 'utf8'); } catch { current = null; }
    const original = chain.states[0];
    if (current === original) { continue; }
    if (!chain.states.includes(current) || isDirty(absolute)) { recovery.kept.push(chain.path); continue; }
    if (original === null) { fs.rmSync(absolute, { force: true }); } else { fs.writeFileSync(absolute, original); }
    recovery.restored.push(chain.path);
  }
  fs.rmSync(file, { force: true });
  return recovery;
}
