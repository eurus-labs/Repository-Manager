/**
 * Git operations module for submodule management
 *
 * This class acts as a facade for the underlying services:
 * - GitCommandService: Base git command execution
 * - BranchService: Branch-related operations
 * - SubmoduleService: Submodule-specific operations
 * - CommitService: Commit-related operations
 */

import {
  GitCommandService,
  BranchService,
  SubmoduleService,
  CommitService,
  HistoryService,
  DiffService,
  ReferenceService
} from './services';
import { HistoryAction, HistoryActionService } from './services/historyActionService';
import { StashActionService, StashOperation } from './services/stashActionService';
import { DiscardPlan, DiscardService } from './services/discardService';
import { StashEntry } from './services/stashTarget';
import { HistoryRewriteAction, HistoryRewritePreview, HistoryRewriteService, ResetMode } from './services/historyRewriteService';

import {
  SubmoduleInfo,
  BranchInfo,
  GitStatus,
  CommitInfo,
  RemoteInfo,
  CommandResult,
  CommitDetail,
  FileDiff,
  HistoryPage,
  HistoryQuery,
  RepositoryRefs,
  WorkingTreeChange,
  WorkingTreePreview,
  PartialStagedChoice
} from './types';

export class GitOperations {
  private gitCmd: GitCommandService;
  private branchService: BranchService;
  private submoduleService: SubmoduleService;
  private commitService: CommitService;
  private historyService: HistoryService;
  private diffService: DiffService;
  private referenceService: ReferenceService;
  private historyActionService: HistoryActionService;
  private stashActionService: StashActionService;
  private discardService: DiscardService;
  private historyRewriteService: HistoryRewriteService;

  constructor(workspaceRoot: string) {
    this.gitCmd = new GitCommandService(workspaceRoot);
    this.branchService = new BranchService(this.gitCmd);
    this.submoduleService = new SubmoduleService(this.gitCmd);
    this.commitService = new CommitService(this.gitCmd);
    this.historyService = new HistoryService(this.gitCmd);
    this.diffService = new DiffService(this.gitCmd);
    this.referenceService = new ReferenceService(this.gitCmd, this.branchService, this.commitService);
    this.historyActionService = new HistoryActionService(this.gitCmd);
    this.stashActionService = new StashActionService(this.gitCmd);
    this.discardService = new DiscardService(this.gitCmd);
    this.historyRewriteService = new HistoryRewriteService(this.gitCmd);
  }

  // ==================== Git Command Methods ====================

  /**
   * Check if the workspace is a git repository
   */
  async isGitRepository(): Promise<boolean> {
    return this.gitCmd.isGitRepository();
  }

  // ==================== Submodule Methods ====================

  /**
   * Get information about the parent (main) repository
   */
  async getParentRepoInfo(): Promise<SubmoduleInfo | null> {
    return this.submoduleService.getParentRepoInfo();
  }

  /**
   * Get list of all submodules
   */
  async getSubmodules(): Promise<SubmoduleInfo[]> {
    return this.submoduleService.getSubmodules();
  }

  /**
   * Get detailed information about a specific submodule
   */
  async getSubmoduleInfo(name: string, submodulePath: string): Promise<SubmoduleInfo> {
    return this.submoduleService.getSubmoduleInfo(name, submodulePath);
  }

  /**
   * Initialize all submodules
   */
  async initSubmodules(): Promise<CommandResult> {
    return this.submoduleService.initSubmodules();
  }

  /**
   * Update all submodules
   */
  async updateSubmodules(): Promise<CommandResult> {
    return this.submoduleService.updateSubmodules();
  }

  /**
   * Get git status for a submodule
   */
  async getStatus(submodulePath: string): Promise<GitStatus> {
    return this.submoduleService.getStatus(submodulePath);
  }

  /**
   * Stage submodule changes in parent repo
   */
  async stageSubmodule(submodulePath: string): Promise<CommandResult> {
    return this.submoduleService.stageSubmodule(submodulePath);
  }

  /**
   * Sync submodule to a specific commit or branch
   */
  async syncSubmodule(submodulePath: string, target: string): Promise<CommandResult> {
    return this.submoduleService.syncSubmodule(submodulePath, target);
  }

  /**
   * Sync submodules to their recorded commits in the parent repository
   */
  async syncAllSubmodules(submodulePaths?: string[]): Promise<Map<string, CommandResult>> {
    return this.submoduleService.syncAllSubmodules(submodulePaths);
  }

  /**
   * Get the commit hash recorded in the parent repository for a submodule
   */
  async getRecordedCommit(submodulePath: string): Promise<string> {
    return this.submoduleService.getRecordedCommit(submodulePath);
  }

  /**
   * Get the current HEAD commit of a submodule
   */
  async getCurrentCommit(submodulePath: string): Promise<string> {
    return this.submoduleService.getCurrentCommit(submodulePath);
  }

  /**
   * Update a submodule to the commit recorded in the parent repository
   */
  async updateToRecordedCommit(submodulePath: string): Promise<CommandResult> {
    return this.submoduleService.updateToRecordedCommit(submodulePath);
  }

  /**
   * Update submodules to their recorded commits (not remote)
   */
  async updateSubmodulesToRecorded(): Promise<CommandResult> {
    return this.submoduleService.updateSubmodulesToRecorded();
  }

  /**
   * Record a specific commit for a submodule in the parent repository
   */
  async recordSubmoduleCommit(submodulePath: string, commit?: string): Promise<CommandResult> {
    return this.submoduleService.recordSubmoduleCommit(submodulePath, commit);
  }

  // ==================== Branch Methods ====================

  /**
   * Get branches for a submodule
   */
  async getBranches(submodulePath: string): Promise<BranchInfo[]> {
    return this.branchService.getBranches(submodulePath);
  }

  /**
   * Create a branch in the specified submodule
   */
  async createBranch(
    submodulePath: string,
    branchName: string,
    baseBranch?: string,
    checkout: boolean = true
  ): Promise<CommandResult> {
    return this.branchService.createBranch(submodulePath, branchName, baseBranch, checkout);
  }

  /**
   * Create a branch across multiple submodules
   */
  async createBranchAcrossSubmodules(
    submodulePaths: string[],
    branchName: string,
    baseBranch?: string,
    checkout: boolean = true
  ): Promise<Map<string, CommandResult>> {
    return this.branchService.createBranchAcrossSubmodules(submodulePaths, branchName, baseBranch, checkout);
  }

  /**
   * Delete a branch in a submodule
   */
  async deleteBranch(
    submodulePath: string,
    branchName: string,
    deleteRemote: boolean = false
  ): Promise<CommandResult> {
    return this.branchService.deleteBranch(submodulePath, branchName, deleteRemote);
  }

  /**
   * Delete a branch across multiple submodules
   */
  async deleteBranchAcrossSubmodules(
    submodulePaths: string[],
    branchName: string,
    deleteRemote: boolean = false
  ): Promise<Map<string, CommandResult>> {
    return this.branchService.deleteBranchAcrossSubmodules(submodulePaths, branchName, deleteRemote);
  }

  /**
   * Checkout a branch in a submodule
   */
  async checkoutBranch(
    submodulePath: string,
    branchName: string,
    replaceWithRemote: boolean = false
  ): Promise<CommandResult> {
    return this.branchService.checkoutBranch(submodulePath, branchName, replaceWithRemote);
  }

  /**
   * Pull changes for a submodule
   */
  async pullChanges(submodulePath: string, branch?: string): Promise<CommandResult> {
    return this.branchService.pullChanges(submodulePath, branch);
  }

  /**
   * Push changes for a submodule
   */
  async pushChanges(submodulePath: string, branch?: string): Promise<CommandResult> {
    return this.branchService.pushChanges(submodulePath, branch);
  }

  /**
   * Fetch updates for a submodule
   */
  async fetchUpdates(submodulePath: string): Promise<CommandResult> {
    return this.branchService.fetchUpdates(submodulePath);
  }

  async fetchInBackground(submodulePath: string): Promise<void> {
    return this.branchService.fetchInBackground(submodulePath);
  }

  // ==================== Commit Methods ====================

  async getWorkingTreeChanges(repositoryPath: string): Promise<WorkingTreeChange[]> {
    return this.commitService.getWorkingTreeChanges(repositoryPath);
  }

  async getWorkingTreePreview(
    repositoryPath: string, filePath: string, mode: 'staged' | 'unstaged', requestId: number
  ): Promise<WorkingTreePreview> {
    return this.commitService.getWorkingTreePreview(repositoryPath, filePath, mode, requestId);
  }

  /** The absolute root of a repository path ('.' or a linked repository's relative path). */
  resolveRepositoryPath(repositoryPath: string): string {
    return this.gitCmd.resolveRepositoryPath(repositoryPath);
  }

  async commitFiles(repositoryPath: string, filePaths: string[], message: string, partial?: PartialStagedChoice): Promise<CommandResult> {
    return this.commitService.commitFiles(repositoryPath, filePaths, message, partial);
  }

  /**
   * Get recent commits for a submodule
   */
  async getRecentCommits(submodulePath: string, count: number = 10): Promise<CommitInfo[]> {
    return this.commitService.getRecentCommits(submodulePath, count);
  }

  /**
   * Checkout a specific commit in a submodule
   */
  async checkoutCommit(submodulePath: string, commit: string, fromHistory = false): Promise<CommandResult> {
    return this.commitService.checkoutCommit(submodulePath, commit, fromHistory);
  }

  async createBranchFromCommit(repositoryPath: string, branchName: string, commit: string, checkout: boolean): Promise<CommandResult> {
    return this.branchService.createBranchFromCommit(repositoryPath, branchName, commit, checkout);
  }

  /**
   * Get remote information for a submodule
   */
  async getRemotes(submodulePath: string): Promise<RemoteInfo[]> {
    return this.commitService.getRemotes(submodulePath);
  }

  /**
   * Get GitHub repository info from remote URL
   */
  parseGitHubUrl(url: string): { owner: string; repo: string } | null {
    return this.commitService.parseGitHubUrl(url);
  }

  // ==================== Dashboard Read Methods ====================

  async getHistory(query: HistoryQuery): Promise<HistoryPage> {
    return this.historyService.getHistory(query);
  }

  async getCommitDetail(repositoryPath: string, commitHash: string, baseRevision?: string): Promise<CommitDetail> {
    return this.diffService.getCommitDetail(repositoryPath, commitHash, baseRevision);
  }

  async getFileDiff(repositoryPath: string, commitHash: string, filePath: string, baseRevision?: string): Promise<FileDiff> {
    return this.diffService.getFileDiff(repositoryPath, commitHash, filePath, baseRevision);
  }

  async getRepositoryRefs(repositoryPath: string): Promise<RepositoryRefs> {
    return this.referenceService.getRepositoryRefs(repositoryPath);
  }

  async createAnnotatedTag(repositoryPath: string, name: string, message: string, commit: string): Promise<CommandResult> {
    return this.referenceService.createAnnotatedTag(repositoryPath, name, message, commit);
  }

  async describeHistoryCommit(repositoryPath: string, commit: string): Promise<{ sha: string; branch: string; parents: string[] }> {
    return this.historyActionService.describe(repositoryPath, commit);
  }

  async applyHistoryCommit(repositoryPath: string, commit: string, operation: HistoryAction, mainline?: number, expectedBranch?: string): Promise<CommandResult> {
    return this.historyActionService.apply(repositoryPath, commit, operation, mainline, expectedBranch);
  }

  async abortHistoryAction(repositoryPath: string, operation: HistoryAction): Promise<CommandResult> {
    return this.historyActionService.abort(repositoryPath, operation);
  }

  /** The stash whose commit is `hash`; throws when it no longer exists. */
  async describeStash(repositoryPath: string, hash: string): Promise<StashEntry> {
    return this.stashActionService.describe(repositoryPath, hash);
  }

  async runStashAction(repositoryPath: string, hash: string, operation: StashOperation): Promise<CommandResult> {
    return this.stashActionService.run(repositoryPath, hash, operation);
  }

  /** What discarding these uncommitted changes (all of them when `paths` is undefined) would do. */
  async planDiscard(repositoryPath: string, paths?: string[]): Promise<DiscardPlan> {
    return this.discardService.plan(repositoryPath, paths);
  }

  async discardChanges(repositoryPath: string, paths?: string[]): Promise<CommandResult> {
    return this.discardService.discard(repositoryPath, paths);
  }

  /** The copies earlier discards kept (refs under refs/repository-manager/discarded/). */
  async listDiscardCopies(repositoryPath: string): Promise<string[]> {
    return this.discardService.listCopies(repositoryPath);
  }

  async removeDiscardCopies(repositoryPath: string, refs: string[]): Promise<number> {
    return this.discardService.removeCopies(repositoryPath, refs);
  }

  /** Undo a discard: `paths` back from the copy it kept, unless they changed since. */
  async restoreDiscarded(repositoryPath: string, backup: string, paths: string[]): Promise<CommandResult> {
    return this.discardService.restore(repositoryPath, backup, paths);
  }

  /** The Git operation paused in the repository (rebase, merge, cherry-pick, ...), if any. */
  async getPendingOperation(repositoryPath: string): Promise<string | undefined> {
    return this.historyActionService.pendingOperation(repositoryPath);
  }

  async previewHistoryRewrite(repositoryPath: string, commit: string, action: HistoryRewriteAction): Promise<HistoryRewritePreview> {
    return this.historyRewriteService.preview(repositoryPath, commit, action);
  }

  async executeHistoryRewrite(repositoryPath: string, target: string, action: HistoryRewriteAction,
    expectedBranch: string, expectedHead: string, mode?: ResetMode): Promise<CommandResult> {
    return this.historyRewriteService.execute(repositoryPath, target, action, expectedBranch, expectedHead, mode);
  }

  async resolveHistoryRebase(repositoryPath: string, command: 'continue' | 'abort'): Promise<CommandResult> {
    return this.historyRewriteService.resolveRebase(repositoryPath, command);
  }
}
