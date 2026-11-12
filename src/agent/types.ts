/**
 * The agent's data: a task, its plan of steps, and what each step did. Kept on this machine only
 * (docs/agent-harness.md): implementation tasks are created by the developer who does them.
 */

export type AgentToolName = 'read_file' | 'list_files' | 'search_code' | 'edit_file' | 'create_file' | 'run_check';

/** Tools that only read: every step may use them. */
export const READ_TOOLS: readonly AgentToolName[] = ['read_file', 'list_files', 'search_code'];
/** Tools that change the repository or run a command: only when the step lists them. */
export const WRITE_TOOLS: readonly AgentToolName[] = ['edit_file', 'create_file', 'run_check'];
export const ALL_TOOLS: readonly AgentToolName[] = [...READ_TOOLS, ...WRITE_TOOLS];

/**
 * new: created, no plan yet. planning: the model drafts the plan. planReview: the plan waits for
 * approval. stepReady: the current step waits for Run. stepRunning. stepReview: the step ran and
 * waits for Accept or Retry. done, stopped: finished.
 */
export type TaskStatus = 'new' | 'planning' | 'planReview' | 'stepReady' | 'stepRunning' | 'stepReview' | 'done' | 'stopped';

export type StepState = 'pending' | 'done' | 'skipped';
export type StepVerification = 'passed' | 'failed' | 'unverified' | 'docsOnly' | 'noChanges';

export interface FileChange {
  /** Relative to the task's repository, with forward slashes. */
  path: string;
  /** The content before the step (null: the step created the file). */
  before: string | null;
  after: string;
}

export interface CheckResult {
  script: string;
  passed: boolean;
  exitCode: number | null;
  /** The end of the combined output. */
  output: string;
  durationMs: number;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  ok: boolean;
  /** The error, or a short description of the result. */
  note: string;
}

export interface AiTextWarning { path: string; line: number; text: string }

export interface StepResult {
  summary: string;
  changes: FileChange[];
  toolCalls: ToolCallRecord[];
  checks: CheckResult[];
  aiText: AiTextWarning[];
  /** Set when the run ended without a summary from the model (an error, or cancelled). */
  error?: string;
}

export interface PlanStep {
  title: string;
  /** What the step will do, in the model's words (the person may edit it before Run). */
  intent: string;
  /** Write tools the step may use; read tools are always allowed. */
  tools: AgentToolName[];
  /** Files or folders the step may change (relative paths; a folder ends with "/"). */
  paths: string[];
  /** Repository scripts run after the step; the step passes only if all of them pass. */
  checks: string[];
  state: StepState;
  /** Runs so far (a Retry starts another). */
  attempts: number;
  result?: StepResult;
  /** Checks that were failing when the person chose Accept anyway. */
  acceptedDespite?: string[];
  /** Check names the model proposed that are not scripts of the repository: the plan waits until they are fixed. */
  unknownChecks?: string[];
  /**
   * How an accepted step was verified: its checks all passed, it was accepted with failing checks,
   * it changed files and no check ran (accepted as unverified), it changed documentation only and ran
   * no check, or it changed nothing and ran none.
   */
  verification?: StepVerification;
  /** Results of earlier attempts that were retried: what failed, sent with the next run. */
  feedback?: string;
}

export interface AgentTask {
  id: string;
  title: string;
  goal: string;
  criteria: string[];
  /** Absolute root of the Git repository the task may change. */
  repositoryRoot: string;
  createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  /** The last error, shown on the task until the next action. */
  error?: string;
  plan?: PlanStep[];
  /** When the plan was approved: from then on the goal and criteria are frozen. */
  frozenAt?: string;
  /** The branch the task works on, created when the plan was approved. */
  branch?: string;
  /** The step the task is at. */
  current: number;
  /** The model the last call used. */
  modelId?: string;
  /** The Studio Chat conversation the task was moved to: no longer listed here, kept on disk. */
  movedTo?: string;
}

/** One line of a task's run log (append-only, on this machine). */
export type RunLogEvent =
  | { type: 'model'; purpose: 'plan' | 'step'; step?: number; modelId: string; inputTokens: number; outputTokens: number }
  | { type: 'tool'; step: number; name: string; input: unknown; ok: boolean; note: string }
  | { type: 'approval'; action: string; step?: number; detail?: string }
  | { type: 'check'; step: number; script: string; passed: boolean; exitCode: number | null; durationMs: number }
  | { type: 'status'; status: TaskStatus; error?: string };

export type RunLogEntry = RunLogEvent & { at: string };

/** Which tree group a task is listed under. */
export type TaskGroup = 'waiting' | 'running' | 'todo' | 'done';

export function taskGroup(task: Pick<AgentTask, 'status'>): TaskGroup {
  switch (task.status) {
    case 'planReview': case 'stepReady': case 'stepReview': return 'waiting';
    case 'planning': case 'stepRunning': return 'running';
    case 'new': return 'todo';
    default: return 'done';
  }
}
