/**
 * How the tool is used, to tell what it saves (docs/usage-metrics.md). Each line of the log is one
 * finished action with numbers only: no paths, messages or code. The log stays on this machine.
 * No `vscode` here, so tests run in Node.
 */
import * as fs from 'fs';
import * as path from 'path';

export type UsageEvent =
  /** A commit from the dialog: time from opening it to committing, and whether Copilot wrote the message. */
  | { kind: 'commit'; durationMs: number; copilot: boolean; editRatio?: number; files: number; lines?: number }
  /** Align (sync) of linked repositories to the commits the parent records. */
  | { kind: 'align'; repositories: number; failed: number; durationMs: number }
  /** A review fix applied: its files, and the findings it closed. */
  | { kind: 'reviewFix'; files: number; findings: number };

export type UsageEntry = UsageEvent & { at: string };

/** Commits whose dialog stayed open longer than this were left for something else: not timed. */
export const IDLE_LIMIT_MS = 10 * 60 * 1000;
/** A comparison needs this many commits on each side before it is shown. */
export const MIN_SAMPLES = 20;
/** Copilot's message counts as kept when less than this share of it changed. */
export const KEPT_RATIO = 0.1;
const MAX_BYTES = 1024 * 1024;

export class UsageLog {
  constructor(readonly file: string, private readonly enabled: () => boolean = () => true, private readonly maxBytes = MAX_BYTES) {}

  /** Never throws: a log that cannot be written must not stop the action it records. */
  record(event: UsageEvent, at = new Date()): void {
    try {
      if (!this.enabled()) { return; }
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify({ at: at.toISOString(), ...event }) + '\n');
      if (fs.statSync(this.file).size > this.maxBytes) {
        // Keep the newer half.
        const lines = fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean);
        fs.writeFileSync(this.file, lines.slice(Math.floor(lines.length / 2)).join('\n') + '\n');
      }
    } catch { /* ignored on purpose */ }
  }

  read(): UsageEntry[] {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return []; }
    const entries: UsageEntry[] = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) { continue; }
      try {
        const entry = JSON.parse(line);
        if (entry && typeof entry.at === 'string' && ['commit', 'align', 'reviewFix'].includes(entry.kind)) { entries.push(entry); }
      } catch { /* a damaged line is skipped */ }
    }
    return entries;
  }

  clear(): void {
    try { fs.rmSync(this.file, { force: true }); } catch { /* ignored */ }
  }
}

let current: UsageLog | undefined;
export function setUsageLog(log: UsageLog | undefined): void { current = log; }
export function recordUsage(event: UsageEvent): void { current?.record(event); }
export function usageLog(): UsageLog | undefined { return current; }

/** The share of `before` that changed to become `after` (0: kept as is, 1: rewritten). */
export function editRatio(before: string, after: string): number {
  const a = [...before.slice(0, 2000)], b = [...after.slice(0, 2000)];
  if (!a.length) { return b.length ? 1 : 0; }
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    previous = row;
  }
  return Math.min(1, previous[b.length] / Math.max(a.length, b.length));
}

export function median(values: number[]): number | undefined {
  if (!values.length) { return undefined; }
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const seconds = (ms: number | undefined) => ms === undefined ? '—' : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${(ms / 60000).toFixed(1)} min`;
const percent = (part: number, whole: number) => whole ? `${Math.round(part / whole * 100)}%` : '—';
const commits = (entries: UsageEntry[]) => entries.filter((entry): entry is UsageEntry & { kind: 'commit' } => entry.kind === 'commit');

/** With and without Copilot, timed commits only; the comparison waits for enough of each. */
function compare(items: Array<UsageEntry & { kind: 'commit' }>): { line: string; ready: boolean } {
  const timed = items.filter(item => item.durationMs > 0 && item.durationMs <= IDLE_LIMIT_MS);
  const withCopilot = timed.filter(item => item.copilot).map(item => item.durationMs);
  const without = timed.filter(item => !item.copilot).map(item => item.durationMs);
  const ready = withCopilot.length >= MIN_SAMPLES && without.length >= MIN_SAMPLES;
  const line = `with Copilot ${seconds(median(withCopilot))} (n=${withCopilot.length}) · typed ${seconds(median(without))} (n=${without.length})`;
  return { line, ready };
}

const SIZES: Array<[string, (files: number) => boolean]> = [['1 file', n => n <= 1], ['2–5 files', n => n >= 2 && n <= 5], ['6+ files', n => n >= 6]];

/** The report, in Markdown: a Summary to share, then Details to decide what to work on. */
export function usageReport(entries: UsageEntry[], logFile?: string): string {
  const all = commits(entries);
  const out: string[] = ['# Repository Manager usage', ''];
  if (!entries.length) {
    out.push('Nothing recorded yet. Commits from the dialog, Align and applied review fixes are recorded as you use them.');
    return out.join('\n') + '\n';
  }
  const first = entries[0].at.slice(0, 10), last = entries[entries.length - 1].at.slice(0, 10);
  out.push(`From ${first} to ${last}. Medians; n is how many actions each number comes from.`, '', '## Summary', '');

  const overall = compare(all);
  out.push(`- **Commits:** ${all.length}, ${percent(all.filter(item => item.copilot).length, all.length)} with a Copilot message.`);
  out.push(overall.ready
    ? `- **Time to commit:** ${overall.line}.`
    : `- **Time to commit:** still collecting (${MIN_SAMPLES} of each needed): ${overall.line}.`);
  const rated = all.filter(item => item.copilot && typeof item.editRatio === 'number');
  if (rated.length) {
    const kept = rated.filter(item => item.editRatio! < KEPT_RATIO).length;
    out.push(`- **Copilot messages kept** (less than ${KEPT_RATIO * 100}% changed): ${percent(kept, rated.length)} of ${rated.length}.`);
  }
  const aligns = entries.filter((entry): entry is UsageEntry & { kind: 'align' } => entry.kind === 'align');
  if (aligns.length) {
    const repositories = aligns.reduce((sum, item) => sum + item.repositories, 0);
    out.push(`- **Align:** ${aligns.length} run${aligns.length === 1 ? '' : 's'}, ${repositories} repositories in all, median ${median(aligns.map(item => item.repositories))} per run, ${seconds(median(aligns.map(item => item.durationMs)))} each.`);
  }
  const fixes = entries.filter((entry): entry is UsageEntry & { kind: 'reviewFix' } => entry.kind === 'reviewFix');
  if (fixes.length) {
    out.push(`- **Review fixes applied:** ${fixes.length}, closing ${fixes.reduce((sum, item) => sum + item.findings, 0)} findings in ${fixes.reduce((sum, item) => sum + item.files, 0)} files.`);
  }

  out.push('', '## Details', '', '### Time to commit by size', '', '| Size | With Copilot | Typed | Compared |', '| --- | --- | --- | --- |');
  for (const [label, fits] of SIZES) {
    const group = all.filter(item => fits(item.files));
    const timed = group.filter(item => item.durationMs > 0 && item.durationMs <= IDLE_LIMIT_MS);
    const withCopilot = timed.filter(item => item.copilot).map(item => item.durationMs);
    const without = timed.filter(item => !item.copilot).map(item => item.durationMs);
    const ready = withCopilot.length >= MIN_SAMPLES && without.length >= MIN_SAMPLES;
    out.push(`| ${label} | ${seconds(median(withCopilot))} (n=${withCopilot.length}) | ${seconds(median(without))} (n=${without.length}) | ${ready ? 'yes' : 'not yet'} |`);
  }
  if (rated.length) {
    out.push('', '### How much of Copilot\'s message you changed', '', '| Size | Median changed | Kept | n |', '| --- | --- | --- | --- |');
    for (const [label, fits] of SIZES) {
      const group = rated.filter(item => fits(item.files));
      if (!group.length) { continue; }
      const ratio = median(group.map(item => item.editRatio!))!;
      out.push(`| ${label} | ${Math.round(ratio * 100)}% | ${percent(group.filter(item => item.editRatio! < KEPT_RATIO).length, group.length)} | ${group.length} |`);
    }
  }
  const idle = all.filter(item => item.durationMs > IDLE_LIMIT_MS).length;
  out.push('', '### What these numbers leave out', '');
  out.push(`- ${idle} commit${idle === 1 ? '' : 's'} with the dialog open longer than ${IDLE_LIMIT_MS / 60000} minutes ${idle === 1 ? 'is' : 'are'} counted but not timed.`);
  out.push('- You choose when to use Copilot, so the two groups are not the same kind of commit; compare within a size.');
  out.push('- Commits made outside the dialog (terminal, Source Control) are not recorded, so there is no "before the tool" time here.');
  const failedAligns = aligns.filter(item => item.failed).length;
  if (failedAligns) { out.push(`- ${failedAligns} Align run${failedAligns === 1 ? '' : 's'} had failures.`); }
  out.push('', '---', '', `Recorded on this machine only${logFile ? ` (${logFile})` : ''}: counts and durations, no paths, messages or code. Turn it off with the setting \`repositoryManager.usage.enabled\`.`);
  return out.join('\n') + '\n';
}
