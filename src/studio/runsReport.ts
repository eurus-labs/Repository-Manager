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
  for (const entry of log) {
    const id = typeof entry.node === 'string' && entry.node ? entry.node : undefined;
    if (!id) { continue; }
    const node = get(id);
    const at = time(entry);
    switch (entry.type) {
      case 'node':
        node.runs++; node.execSeen = true; node.outcome = 'running';
        node.execStart = at ?? Number.NaN;
        break;
      case 'waiting':
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
        endExecution(node, at);
        node.outcome = node.outcome === 'accepted' ? 'accepted' : 'done';
        break;
      case 'skip':
        node.outcome = 'skipped';
        break;
      case 'finish':
        endExecution(node, at);
        endWait(node, at);
        if (entry.status === 'failed') { node.outcome = 'failed'; node.error = typeof entry.error === 'string' ? entry.error : undefined; }
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
    outcome: node.outcome, verdict: node.verdict, error: node.error, recovered: node.recovered, ...(node.waitingNow ? { waitingNow: true } : {}),
    ...(node.waitUnknown && !node.waitingNow ? { waitingUnknown: true } : {})
  }));
  return { nodes: list, hasLog: log.length > 0, executionMs, waitingMs };
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
