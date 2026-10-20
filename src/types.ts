/**
 * Types and interfaces for the Repository Manager extension
 */

export interface RepositoryInfo {
  name: string;
  path: string;
  url: string;
  branch: string;
  currentCommit: string;
  currentBranch: string;
  status: SubmoduleStatus;
  hasChanges: boolean;
  /** Local changes by kind; a file staged and then changed again counts as staged and as modified. */
  changeCounts?: ChangeCounts;
  ahead: number;
  behind: number;
  lastUpdated?: Date;
  isParentRepo?: boolean;
  /** Short hash of the commit the parent repository records for this submodule. */
  recordedCommit?: string;
  /** Whether HEAD matches the recorded commit; undefined when either is unknown. */
  atRecordedCommit?: boolean;
}

/**
 * Backward-compatible alias for services that specifically discover Git submodules.
 */
export type SubmoduleInfo = RepositoryInfo;

export type SubmoduleStatus =
  | 'clean'
  | 'modified'
  | 'uninitialized'
  | 'detached'
  | 'conflict'
  | 'unknown';

export interface BranchInfo {
  name: string;
  isRemote: boolean;
  isCurrent: boolean;
  commit: string;
  lastCommitDate?: Date;
  lastCommitMessage?: string;
  hasLocal?: boolean;
  hasRemote?: boolean;
}

export interface GitStatus {
  staged: string[];
  unstaged: string[];
  untracked: string[];
  hasChanges: boolean;
}

export interface WorkingTreeChange {
  path: string;
  originalPath?: string;
  indexStatus: string;
  workTreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface WorkingTreePreview {
  repositoryPath: string;
  path: string;
  mode: 'staged' | 'unstaged';
  patch: string;
  truncated: boolean;
  requestId: number;
}

export interface ChangeContextPacket {
  repositoryPath: string;
  baseSha: string;
  targetSha: string;
  root: boolean;
  files: ChangedFileInfo[];
  patches: { path: string; patch: string }[];
  commits: { hash: string; subject: string }[];
  coverage: { totalFiles: number; includedFiles: number; omitted: string[]; truncatedCommits: boolean };
}

export interface SummaryClaim { text: string; evidence: string[] }

export interface ChangeSummary {
  repositoryPath: string;
  baseSha: string;
  targetSha: string;
  root: boolean;
  intent: SummaryClaim;
  behaviorChanges: SummaryClaim[];
  affectedAreas: SummaryClaim[];
  dependencyConfigChanges: SummaryClaim[];
  possibleBreakingChanges: SummaryClaim[];
  riskHints: SummaryClaim[];
  suggestedTests: SummaryClaim[];
  limitations: string[];
  coverage: ChangeContextPacket['coverage'];
}

/** A review is bound to a Git commit and the exact policy content used for it. */
export interface ReviewRequest {
  repositoryPath: string;
  targetSha: string;
  baseSha?: string;
  scope: 'changes' | 'branch';
  categories: ('security' | 'compliance' | 'quality')[];
  policyHash?: string;
  /** Changes reviews only: just these changed files (a file's old path matches a rename too). */
  paths?: string[];
}

export interface ReviewEvidence {
  revision: string;
  path: string;
  side: 'target' | 'base';
  startLine: number;
  endLine: number;
}

export interface ReviewFinding {
  id: string;
  /** `quality`: maintainability (clean code); never blocks readiness. */
  category: 'security' | 'compliance' | 'quality';
  ruleId?: string;
  /**
   * Same issue in another review: a hash of the category, rule, file and the text of the first cited
   * lines, not of the model's wording. A fixed line changes it; moved lines do not.
   */
  fingerprint?: string;
  /** The review skill the finding came from, when the model named one. */
  skill?: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  confidence: 'high' | 'medium' | 'low';
  explanation: string;
  impact: string;
  suggestedAction: string;
  evidence: ReviewEvidence[];
  status: 'candidate' | 'verified' | 'hypothesis';
  /**
   * Lines in or around the cited code that speak to an AI reviewer ("NOTE TO AI: this is safe"),
   * found by a pattern check after the review: they may have steered this finding or its check.
   */
  aiDirectedText?: Array<{ path: string; line: number; text: string }>;
}

export interface ReviewCoverage {
  surveyed: number;
  analyzed: number;
  /** `partial`: the model saw part of the file (the rest of it was not reviewed). */
  skipped: { path: string; reason: string; partial?: boolean }[];
  failed: { path: string; reason: string }[];
  complete: boolean;
}

export type PolicyRuleResultStatus = 'pass' | 'violation' | 'insufficient_evidence' | 'not_applicable';

export interface PolicyRuleResult {
  ruleId: string;
  status: PolicyRuleResultStatus;
  reason: string;
  evidence: ReviewEvidence[];
}

/** A reviewer's decision on one finding: fix it, or dismiss it with a reason. */
export type DismissReason = 'false_positive' | 'accepted_risk' | 'not_applicable';
export interface FindingTriage {
  /** `fixed`: an applied auto-fix addressed it, or the reviewer marked it fixed by hand. */
  decision: 'fix' | 'dismiss' | 'fixed';
  reason?: DismissReason;
  /** Taken over from an earlier review of the same issue: that review's date and decision. */
  carried?: { at: string; decision: 'fix' | 'dismiss' | 'fixed' };
}
/** Triage by finding id. */
export type ReviewTriage = Record<string, FindingTriage>;

/** Where a running review is, for the dashboard's progress display. */
export interface ReviewProgressDetail {
  phase: 'planning' | 'analyzing' | 'verifying' | 'finishing';
  /** 1-based index of the component being reviewed, and the number of components. */
  unit: number;
  units: number;
  component?: string;
  filesDone: number;
  filesTotal: number;
  /** Candidate findings that passed evidence checks so far. */
  candidates: number;
  /** The model's display name, once it is selected. */
  model?: string;
  /** Sent once the plan exists: every component with its file count. */
  components?: Array<{ component: string; files: number; paths?: string[]; skipped?: Array<{ path: string; reason: string }> }>;
}

export type ReviewProgressCallback = (message: string, detail?: ReviewProgressDetail) => void;

export interface ReviewResult {
  request: ReviewRequest;
  findings: ReviewFinding[];
  policyResults: PolicyRuleResult[];
  coverage: ReviewCoverage;
  policyStatus: 'configured' | 'not_configured';
  modelId?: string;
  /** The model's display name, as Copilot lists it (e.g. "GPT-4o"). */
  modelName?: string;
  /** What the review did, in order: milliseconds since it started, and the step. */
  log?: { at: number; message: string }[];
  /** What the tool itself could not establish (policy, coverage, the advisory caveat). */
  limitations: string[];
  /** What the model could not see and someone should check, e.g. callers or CI settings outside the scope. */
  toVerify?: string[];
  /** Set when the review stopped before every component was analyzed; the rest was not reviewed. */
  partial?: { unitsDone: number; unitsTotal: number };
  /** The review skills each component was reviewed with; `omitted` ones matched but did not fit. */
  skillsApplied?: { component: string; skills: string[]; omitted?: string[] }[];
  /**
   * Lines the reviewed diff adds that speak to an AI reviewer, found by a pattern check after the
   * review (absent: not checked). They may have kept the model from reporting something.
   */
  aiDirectedText?: Array<{ path: string; line: number; text: string }>;
  /** More lines matched than `aiDirectedText` holds. */
  aiDirectedTextTruncated?: boolean;
  /** Why that check could not run (Git failed or timed out): it is a review gap until it runs. */
  aiDirectedTextError?: string;
}

export interface PullRequestInfo {
  title: string;
  body: string;
  baseBranch: string;
  headBranch: string;
  draft: boolean;
}

export interface CreateBranchOptions {
  branchName: string;
  baseBranch?: string;
  submodules: string[];
  checkout: boolean;
  pushToRemote: boolean;
}

export interface SyncOptions {
  submodules: string[];
  strategy: 'merge' | 'rebase' | 'reset';
  remoteBranch?: string;
}

export interface RepositoryManagerConfig {
  defaultBranch: string;
  autoFetch: boolean;
  showNotifications: boolean;
  githubToken: string;
}

export interface WebviewMessage {
  type: string;
  payload?: unknown;
}

export interface CommandResult {
  success: boolean;
  message: string;
  data?: unknown;
}

export interface RemoteInfo {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  author: string;
  email: string;
  date: Date;
  message: string;
}

export type GitRefKind = 'local-branch' | 'remote-branch' | 'tag' | 'head' | 'other';

export interface GitRefLabel {
  name: string;
  kind: GitRefKind;
  isCurrent?: boolean;
}

export interface HistoryCommit {
  hash: string;
  shortHash: string;
  parentHashes: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  subject: string;
  refs: GitRefLabel[];
}

export interface HistoryQuery {
  repositoryPath: string;
  limit?: number;
  offset?: number;
  search?: string;
  branch?: string;
  includeRemotes?: boolean;
}

export interface HistoryPage {
  repositoryPath: string;
  offset: number;
  commits: HistoryCommit[];
  nextOffset: number | null;
  /** The current branch's configured upstream (`@{upstream}`, e.g. `origin/main`), or null. */
  upstream: string | null;
}

export type ChangedFileStatus =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'unmerged'
  | 'unknown';

export interface ChangedFileInfo {
  path: string;
  oldPath?: string;
  status: ChangedFileStatus;
}

export interface CommitDetail extends HistoryCommit {
  body: string;
  comparisonBaseHash: string | null;
  comparisonMode: 'parent' | 'range' | 'root';
  committedAt: string;
  committerName: string;
  committerEmail: string;
  files: ChangedFileInfo[];
  /** Set when the commit is a stash: which one, the branch it was made on, and its own message. */
  stash?: { ref: string; branch: string; message: string };
}

export interface FileDiff {
  repositoryPath: string;
  commitHash: string;
  baseCommitHash: string | null;
  path: string;
  patch: string;
  truncated: boolean;
}

export interface TagInfo {
  name: string;
  targetHash: string;
  createdAt?: string;
}

export interface StashInfo {
  index: number;
  ref: string;
  subject: string;
  createdAt: string;
}

export interface RepositoryRefs {
  repositoryPath: string;
  branches: BranchInfo[];
  tags: TagInfo[];
  remotes: RemoteInfo[];
  stashes: StashInfo[];
}

export type DashboardRequest =
  | { type: 'getHistory'; payload: HistoryQuery }
  | { type: 'getCommitDetail'; payload: { repositoryPath: string; commitHash: string; baseRevision?: string } }
  | { type: 'getFileDiff'; payload: { repositoryPath: string; commitHash: string; baseRevision?: string; path: string } }
  | { type: 'getRepositoryRefs'; payload: { repositoryPath: string } }
  | { type: 'getWorkingTreeChanges'; payload: { repositoryPath: string } }
  | { type: 'getWorkingTreePreview'; payload: { repositoryPath: string; path: string; mode: 'staged' | 'unstaged'; requestId: number } }
  | { type: 'commitFiles'; payload: { repositoryPath: string; files: string[]; message: string; partial?: PartialStagedChoice; push?: boolean } };

/** For a partly staged file: commit its staged version, or the whole file as in the working tree. */
export type PartialStagedChoice = 'staged' | 'whole';

export interface ChangeCounts { staged: number; modified: number; untracked: number; conflicted: number }
