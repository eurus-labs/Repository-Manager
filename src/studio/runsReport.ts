/**
 * What the Runs view shows (docs/agent-studio.md, "How the Runs view measures"), read from the run
 * states and logs the engine already keeps. No `vscode` here.
 *
 * - `done` means the engine finished, not that the code is right: completion rate, the verification
 *   of accepted code steps and retries are reported apart.
 * - Running and waiting runs are counted on their own, never in the denominator of finished runs.
 * - A node's time is split into execution and waiting for a person. A time the log does not have is
 *   "no data" (undefined), never inferred.
 */
import { RunLogEntry, RunState, RunStatus } from './engine';

export interface RunRecord { state: RunState; log: RunLogEntry[] }

export interface RunsSummary {
  total: number;
  running: number;
  waiting: number;
  /** done + failed + stopped: the denominator of the completion rate. */
  finished: number;
  done: number;
  failed: number;
  stopped: number;
  /** Failed because VS Code closed while it ran (a subset of failed). */
  interrupted: number;
  /** done ÷ finished, or undefined with no finished run. */
  completionRate?: number;
  /** Extra attempts of reviewed steps (Retry). */
  retries: number;
  /** Accepted code-step reviews by verdict: passed, failed (accepted anyway), unverified, docsOnly, noChanges. */
  verification: Record<string, number>;
  /** Runs per workflow title, most first. */
  workflows: Array<{ title: string; runs: number }>;
}

export interface RunsFilter { workflow?: string; status?: RunStatus | 'interrupted' }

export function matchesFilter(state: RunState, filter: RunsFilter): boolean {
  if (filter.workflow && state.workflow.title !== filter.workflow) { return false; }
  if (filter.status === 'interrupted') { return Boolean(state.interrupted); }
  return !filter.status || state.status === filter.status;
}

export function summarizeRuns(records: RunRecord[]): RunsSummary {
  const count = (status: RunStatus) => records.filter(record => record.state.status === status).length;
  const summary: RunsSummary = {
    total: records.length, running: count('running'), waiting: count('waiting'), done: count('done'), failed: count('failed'),
    stopped: count('stopped'), finished: 0, interrupted: records.filter(record => record.state.interrupted).length,
    retries: 0, verification: {}, workflows: []
  };
  summary.finished = summary.done + summary.failed + summary.stopped;
  if (summary.finished) { summary.completionRate = summary.done / summary.finished; }
  const titles = new Map<string, number>();
  for (const { state, log } of records) {
    titles.set(state.workflow.title, (titles.get(state.workflow.title) ?? 0) + 1);
    summary.retries += Object.values(state.attempts ?? {}).reduce((sum, attempts) => sum + Math.max(0, attempts - 1), 0);
    for (const entry of log) {
      if (entry.type === 'review' && entry.decision === 'accept' && typeof entry.verdict === 'string') {
        summary.verification[entry.verdict] = (summary.verification[entry.verdict] ?? 0) + 1;
      }
    }
  }
  summary.workflows = [...titles].map(([title, runs]) => ({ title, runs })).sort((a, b) => b.runs - a.runs || a.title.localeCompare(b.title));
  return summary;
}

export type NodeOutcome = 'done' | 'failed' | 'skipped' | 'approved' | 'rejected' | 'accepted' | 'stopped' | 'interrupted' | 'waiting' | 'running' | 'pending';

/** How much of a step's saved result the page shows; the raw log has all of it. */
export const RESULT_CHARS = 2000;

export interface TimelineNode {
  node: string;
  title?: string;
  type?: string;
  /** Execution time (ms), or undefined: no data. */
  executionMs?: number;
  /** Time waiting for a person (ms), or undefined: no data. */
  waitingMs?: number;
  /** Times this node ran (more than one after Retry). */
  runs: number;
  outcome: NodeOutcome;
  /** The verdict of the code step's last review, when it had one. */
  verdict?: string;
  error?: string;
  /** Files put back or kept by crash recovery. */
  recovered?: { restored: string[]; kept: string[] };
  /** Waiting for a person right now: the wait has no length yet. */
  waitingNow?: boolean;
  /** It waited for a person, but the log lacks a time to measure it. */
  waitingUnknown?: boolean;
  /** The step's saved result as text, cut to RESULT_CHARS (`truncated` says so). */
  result?: string;
  truncated?: boolean;
}

/** A saved output as readable text: a string as it is, anything else as indented JSON. */
function resultText(output: unknown): { result?: string; truncated?: boolean } {
  if (output === undefined || output === null || (Array.isArray(output) && !output.length)) { return {}; }
  let text: string;
  try { text = typeof output === 'string' ? output : JSON.stringify(output, null, 2); } catch { return {}; }
  if (!text || !text.trim()) { return {}; }
  return text.length > RESULT_CHARS ? { result: text.slice(0, RESULT_CHARS), truncated: true } : { result: text };
}

export interface RunTimeline {
  nodes: TimelineNode[];
  executionMs?: number;
  waitingMs?: number;
  /** Whether the run had a log at all (older or damaged runs may not). */
  hasLog: boolean;
}

const time = (entry: RunLogEntry): number | undefined => {
  const value = Date.parse(entry.at);
  return Number.isFinite(value) ? value : undefined;
};

/** The run's nodes in the order the log met them, then any it did not, with their times and outcomes. */
export function runTimeline(record: RunRecord, workflow?: { nodes: Array<{ id: string; type: string; title?: string }> }): RunTimeline {
  const { state, log } = record;
  const nodes = new Map<string, TimelineNode & { execStart?: number; waitStart?: number; execUnknown?: boolean; waitUnknown?: boolean; execSeen?: boolean; waitSeen?: boolean }>();
  const meta = new Map((workflow?.nodes ?? []).map(node => [node.id, node]));
  const get = (id: string) => {
    let node = nodes.get(id);
    if (!node) {
      node = { node: id, title: meta.get(id)?.title, type: meta.get(id)?.type, runs: 0, outcome: 'pending' };
      nodes.set(id, node);
    }
    return node;
  };
  const endExecution = (node: ReturnType<typeof get>, at: number | undefined) => {
    if (node.execStart === undefined) { return; }
    if (at === undefined || Number.isNaN(node.execStart)) { node.execUnknown = true; } else { node.executionMs = (node.executionMs ?? 0) + (at - node.execStart); }
    node.execStart = undefined;
  };
  const endWait = (node: ReturnType<typeof get>, at: number | undefined) => {
    if (node.waitStart === undefined) { return; }
    if (at === undefined || Number.isNaN(node.waitStart)) { node.waitUnknown = true; } else { node.waitingMs = (node.waitingMs ?? 0) + (at - node.waitStart); }
    node.waitStart = undefined;
  };
  // The node running or waiting now: a run-level stop (Cancel) is logged without a node.
  let active: string | undefined;
  for (const entry of log) {
    let id = typeof entry.node === 'string' && entry.node ? entry.node : undefined;
    if (!id && entry.type === 'finish' && active) { id = active; }
    if (!id) { continue; }
    const node = get(id);
    const at = time(entry);
    switch (entry.type) {
      case 'node':
        node.runs++; node.execSeen = true; node.outcome = 'running';
        node.execStart = at ?? Number.NaN;
        active = id;
        break;
      case 'waiting':
        active = id;
        endExecution(node, at);
        node.waitSeen = true; node.outcome = 'waiting';
        node.waitStart = at ?? Number.NaN;
        if (entry.kind === 'review' && typeof entry.verdict === 'string') { node.verdict = entry.verdict; }
        break;
      case 'approval':
        endWait(node, at);
        node.outcome = entry.approved ? 'approved' : 'rejected';
        break;
      case 'review':
        endWait(node, at);
        if (typeof entry.verdict === 'string') { node.verdict = entry.verdict; }
        node.outcome = entry.decision === 'accept' ? 'accepted' : entry.decision === 'stop' ? 'stopped' : 'pending';
        break;
      case 'done':
        // Done with no start before it: the log lost its `node` line, so the time is unknown. An empty
        // list (`runs: 0`) truly ran nothing.
        if (node.execStart === undefined && !node.execSeen && node.outcome !== 'accepted') {
          if (entry.runs === 0) { node.execSeen = true; } else { node.execUnknown = true; }
        }
        endExecution(node, at);
        node.outcome = node.outcome === 'accepted' ? 'accepted' : 'done';
        if (active === id) { active = undefined; }
        break;
      case 'skip':
        node.outcome = 'skipped';
        break;
      case 'finish':
        endExecution(node, at);
        endWait(node, at);
        if (entry.status === 'failed') { node.outcome = 'failed'; node.error = typeof entry.error === 'string' ? entry.error : undefined; }
        if (entry.status === 'stopped') { node.outcome = 'stopped'; node.error = typeof entry.reason === 'string' ? entry.reason : undefined; }
        active = undefined;
        break;
      case 'recovered':
        endExecution(node, undefined);
        endWait(node, undefined);
        node.outcome = 'interrupted';
        node.recovered = { restored: Array.isArray(entry.restored) ? entry.restored.map(String) : [], kept: Array.isArray(entry.kept) ? entry.kept.map(String) : [] };
        break;
    }
  }
  // Nodes the log never reached, from the saved state (or the workflow), in the workflow's order.
  for (const id of [...meta.keys(), ...Object.keys(state.nodes)]) {
    if (nodes.has(id)) { continue; }
    const saved = state.nodes[id];
    const node = get(id);
    node.outcome = saved?.status === 'skipped' ? 'skipped' : saved?.status === 'failed' ? 'failed' : saved?.status === 'done' ? 'done' : 'pending';
    node.error = saved?.error;
  }
  // The saved state wins for a node it marks failed (a recovery or an error written after the log).
  for (const node of nodes.values()) {
    const saved = state.nodes[node.node];
    if (saved?.status === 'failed' && node.outcome !== 'interrupted') { node.outcome = state.interrupted?.node === node.node ? 'interrupted' : 'failed'; node.error = node.error ?? saved.error; }
    // Still open: a waiting run's wait goes on, so its length is not known yet.
    if (node.waitStart !== undefined && state.status === 'waiting' && state.waiting?.node === node.node) { node.waitingNow = true; }
    if (node.execStart !== undefined || node.waitStart !== undefined) { node.execUnknown = node.execUnknown || node.execStart !== undefined; node.waitUnknown = node.waitUnknown || node.waitStart !== undefined; }
    if (node.execUnknown) { node.executionMs = undefined; }
    if (node.waitUnknown) { node.waitingMs = undefined; }
    if (node.execSeen && !node.execUnknown && node.executionMs === undefined) { node.executionMs = 0; }
    if (node.waitSeen && !node.waitUnknown && node.waitingMs === undefined) { node.waitingMs = 0; }
  }
  const all = [...nodes.values()];
  // A total is known only when every node that has such time knows it.
  const total = (key: 'executionMs' | 'waitingMs', unknown: 'execUnknown' | 'waitUnknown') =>
    !log.length || all.some(node => node[unknown]) ? undefined : all.reduce((sum, node) => sum + (node[key] ?? 0), 0);
  const executionMs = total('executionMs', 'execUnknown');
  const waitingMs = total('waitingMs', 'waitUnknown');
  const list: TimelineNode[] = all.map(node => ({
    node: node.node, title: node.title, type: node.type, executionMs: node.executionMs, waitingMs: node.waitingMs, runs: node.runs,
    outcome: node.outcome, verdict: node.verdict, error: node.error, recovered: node.recovered, ...resultText(state.nodes[node.node]?.output),
    ...(node.waitingNow ? { waitingNow: true } : {}),
    ...(node.waitUnknown && !node.waitingNow ? { waitingUnknown: true } : {})
  }));
  return { nodes: list, hasLog: log.length > 0, executionMs, waitingMs };
}

/** The longest an activity line is: a tool's note can be long (a query, a file list). */
const ACTIVITY_CHARS = 200;

/**
 * One short line of text for a log entry that tells what a step is doing, or undefined for an entry
 * that is not activity (node, done, waiting...). The same line is shown on the Studio Chat's run card
 * and in the progress notification. Tool inputs and file contents are never shown: a tool's note is
 * the short text the tool itself reports (a file and line range, a query, a script outcome).
 */
export function activityLine(entry: RunLogEntry): { text: string; ok?: boolean } | undefined {
  const str = (value: unknown): string => typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
  const cut = (text: string) => text.length > ACTIVITY_CHARS ? `${text.slice(0, ACTIVITY_CHARS - 1)}…` : text;
  switch (entry.type) {
    case 'tool': {
      const name = str(entry.name) || 'tool';
      const note = str(entry.note);
      if (entry.ok === false) { return { text: cut(`✗ ${name} failed${note ? `: ${note}` : ''}`), ok: false }; }
      return { text: cut(note ? `${name} ${note}` : name) };
    }
    case 'model': {
      const model = str(entry.model) || str(entry.modelId) || 'model';
      const tokens = typeof entry.inputTokens === 'number' && typeof entry.outputTokens === 'number' ? ` (${entry.inputTokens} in, ${entry.outputTokens} out)` : '';
      return { text: cut(`Model ${model} answered${tokens}`) };
    }
    case 'check': {
      const passed = entry.passed === true;
      const code = typeof entry.exitCode === 'number' ? ` (exit ${entry.exitCode})` : '';
      return { text: cut(`Check ${str(entry.script) || 'script'} ${passed ? 'passed' : 'failed'}${code}`), ok: passed };
    }
    case 'branch': return { text: cut(`On branch ${str(entry.branch) || '?'}${entry.created === true ? ', created' : ''}`) };
    case 'read': return typeof entry.files === 'number' ? { text: `Read ${entry.files} file${entry.files === 1 ? '' : 's'}` } : undefined;
    case 'skills': {
      const names = (Array.isArray(entry.skills) ? entry.skills : []).map(ref => {
        const text = str(ref);
        return /\/([^/@]+)@/.exec(text)?.[1] ?? text;
      }).filter(Boolean);
      return names.length ? { text: cut(`Skills: ${names.join(', ')}`) } : undefined;
    }
    default: return undefined;
  }
}

/** A duration as people read it, or "no data". */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) { return 'no data'; }
  if (ms < 1000) { return `${Math.round(ms)} ms`; }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) { return `${seconds} s`; }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) { return `${minutes} min ${seconds % 60} s`; }
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}
