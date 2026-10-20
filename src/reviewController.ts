/**
 * Runs security and compliance reviews for the dashboard (MVP 2, W6–W7): consent (remembered
 * per repository once allowed), one review at a time with progress and cancellation, Markdown
 * export, opening cited evidence, and the history of completed reviews. VS Code is reached only
 * through the injected host, so tests can drive the whole flow with a scripted review runner.
 */

import * as path from 'path';
import { ReviewProgressCallback, ReviewRequest, ReviewResult, ReviewTriage } from './types';
import { GitCommandService } from './services/gitCommandService';
import { assessReadiness, normalizeTriage, renderReviewMarkdown, ReviewKind, ReviewReportContext } from './services/reviewReport';
import { FixError, FixModel, FixProposal, FixStep, ReviewFixService } from './services/reviewFixService';
import { ExplainError, ReviewExplainService } from './services/reviewExplainService';
import { markAiDirectedText, scanReviewedChanges } from './services/aiDirectedText';
import { keepSnapshots, snapshotLocalChanges } from './services/localChangesSnapshot';
import { isStashSnapshot } from './services/stashTarget';
import { resolveDefaultBranch, resolveReleaseRange } from './services/releaseRange';
import { ReviewSkillStore } from './reviewSkillStore';
import { carryTriage } from './reviewTriageCarry';
import { ReviewHistoryStore, summarize } from './reviewHistory';

export interface CancellationLike { readonly isCancellationRequested: boolean }

export interface ReviewRunner {
  review(request: ReviewRequest, token: CancellationLike, progress: ReviewProgressCallback, modelId?: string): Promise<ReviewResult>;
}

export interface ReviewControllerHost {
  workspaceRoot(): string;
  post(message: { type: string; payload: unknown }): Promise<void>;
  /** Modal question; resolves the chosen action, or undefined when dismissed. */
  ask(message: string, detail: string, actions: string[]): Promise<string | undefined>;
  /** Ask before every request that sends code (repositoryManager.copilot.askBeforeSending is `always`). */
  alwaysConfirm(): boolean;
  /** Repositories (absolute paths) whose reviews may start without asking: all of them when the setting never asks. */
  isConsentRemembered(repositoryRoot: string): boolean;
  rememberConsent(repositoryRoot: string): Promise<void>;
  createRunner(workspaceRoot: string): ReviewRunner;
  createCancellation(): { token: CancellationLike; cancel(): void; dispose(): void };
  copyText(text: string): Promise<void>;
  /** Resolves false when the user dismissed the save dialog. */
  saveText(defaultFileName: string, text: string): Promise<boolean>;
  openText(content: string, revision: string, filePath: string, line: number): Promise<void>;
  notify(message: string, isError?: boolean): void;
  /** The model for one request about a finished review: auto-fix proposals and explanations (the Copilot model the dashboard selected). */
  createFixModel(modelId?: string): FixModel;
  /** The VS Code display language (for example `en` or `vi`): explanations are written in it. */
  language?(): string;
  /** True when an open editor has unsaved changes for this file. */
  isDirtyInEditor(absolutePath: string): boolean;
  /** Files in the working tree changed (an auto-fix was applied); refresh the dashboard. */
  workingTreeChanged(): void;
  /** Completed reviews, kept for checking later. */
  history: ReviewHistoryStore;
  /** Review skills: the bundled ones and the user's imports, each of which can be turned off. */
  skills?: ReviewSkillStore;
  /** Asks for a Markdown file to import as a skill; resolves its text, or undefined when cancelled. */
  pickSkillFile?(): Promise<string | undefined>;
}

const REVIEW_MESSAGES = new Set(['startReview', 'cancelReview', 'exportReviewReport', 'openReviewEvidence', 'setFindingTriage',
  'proposeReviewFix', 'applyReviewFix', 'discardReviewFix', 'cancelReviewFix', 'listReviewHistory', 'openStoredReview',
  'deleteStoredReview', 'listReviewSkills', 'setReviewSkillEnabled', 'importReviewSkill', 'removeReviewSkill',
  'explainReviewFinding', 'cancelReviewExplanation']);
const START = 'Start review';
const EXPLAIN = 'Explain';
const ALWAYS = 'Always allow for this repository';
/** Progress while an explanation arrives is posted at most this often (ms): each post redraws the tab. */
const EXPLAIN_PROGRESS_INTERVAL = 250;
const CATEGORIES: Array<'security' | 'compliance'> = ['security', 'compliance'];
type ReviewCategory = ReviewRequest['categories'][number];
const MAX_OPEN_REVIEWS = 10;
const MAX_REVIEW_PATHS = 200;
const FIX_STEP_MESSAGES: Record<FixStep, string> = {
  checking: 'Checking the cited files in your working tree…',
  sending: 'Sending the findings and files to Copilot…',
  receiving: 'Receiving the proposed edits…',
  validating: 'Checking the proposed edits against the files…'
};

/**
 * A finished review the dashboard has open. `workspaceRoot` is the folder it ran in: the dashboard
 * may have switched folders since, and evidence, exports and fixes must still reach the reviewed
 * repository. `historyId` is its entry in the review history, which triage keeps up to date.
 */
interface StoredReview { result: ReviewResult; context: ReviewReportContext; triage: ReviewTriage; workspaceRoot: string; historyId?: string }

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
const optionalString = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : undefined);

export class ReviewController {
  private generation = 0;
  private running?: { cancel(): void; dispose(): void };
  /** The review the dashboard is waiting on, from request until result. */
  private active?: { requestId: number; repositoryPath: string };
  private readonly reviews = new Map<number, StoredReview>();
  /** At most one auto-fix: being proposed (`running`) or waiting for Apply/Discard (`proposal`). */
  private fix?: { requestId: number; workspaceRoot: string; findingIds: string[]; running?: { cancel(): void; dispose(): void };
    proposal?: FixProposal; applied?: string[] };
  /** At most one explanation is being written: the finding it is for, and how to stop it. */
  private explaining?: { requestId: number; findingId: string; cancellation: { cancel(): void; dispose(): void } };

  constructor(private readonly host: ReviewControllerHost) {}

  handles(type: string): boolean {
    return REVIEW_MESSAGES.has(type);
  }

  async handle(message: { type: string; payload?: unknown }): Promise<void> {
    const payload = record(message.payload) || {};
    switch (message.type) {
      case 'startReview': return this.start(payload);
      case 'cancelReview': return this.cancelFromDashboard();
      case 'exportReviewReport': return this.export(payload);
      case 'openReviewEvidence': return this.openEvidence(payload);
      case 'setFindingTriage': return this.setTriage(payload);
      case 'proposeReviewFix': return this.proposeFix(payload);
      case 'applyReviewFix': return this.applyFix(payload);
      case 'discardReviewFix': return this.discardFix(payload);
      case 'cancelReviewFix': return this.cancelFix();
      case 'listReviewHistory': return this.listHistory(payload);
      case 'openStoredReview': return this.openStored(payload);
      case 'deleteStoredReview': return this.deleteStored(payload);
      case 'listReviewSkills': return this.postSkills();
      case 'setReviewSkillEnabled': return this.setSkillEnabled(payload);
      case 'importReviewSkill': return this.importSkill();
      case 'removeReviewSkill': return this.removeSkill(payload);
      case 'explainReviewFinding': return this.explain(payload);
      case 'cancelReviewExplanation': return this.cancelExplanation();
    }
  }

  private async postSkills(message?: string): Promise<void> {
    await this.host.post({ type: 'reviewSkillsLoaded', payload: { skills: this.host.skills?.list() || [], message,
      ...(this.host.skills ? { includeQuality: this.host.skills.includeQuality() } : {}) } });
  }

  private async setSkillEnabled(payload: Record<string, unknown>): Promise<void> {
    const id = optionalString(payload.id);
    if (!id || !this.host.skills) { return; }
    await this.host.skills.setEnabled(id, payload.enabled === true);
    await this.postSkills();
  }

  private async importSkill(): Promise<void> {
    if (!this.host.skills || !this.host.pickSkillFile) { return; }
    const text = await this.host.pickSkillFile();
    if (text === undefined) { return; }
    const skill = await this.host.skills.import(text);
    if (typeof skill === 'string') {
      this.host.notify(`Could not import the skill: ${skill}`, true);
      await this.postSkills();
      return;
    }
    await this.postSkills(`Imported "${skill.name}". It applies to ${skill.appliesTo.join(', ')} from the next review.`);
  }

  private async removeSkill(payload: Record<string, unknown>): Promise<void> {
    const id = optionalString(payload.id);
    if (!id || !this.host.skills) { return; }
    await this.host.skills.remove(id);
    await this.postSkills();
  }

  /** Stop a running review, e.g. when the panel closes or the workspace folder changes. */
  cancel(): void {
    this.cancelFixQuietly();
    this.cancelExplanationQuietly();
    this.generation++;
    this.running?.cancel();
    this.running?.dispose();
    this.running = undefined;
  }

  /**
   * Cancel requested in the dashboard. Unlike a superseded review, this one still reports back:
   * the engine stops after the current step and returns what it finished (shown and saved as a
   * stopped review), or the review fails as cancelled when nothing was finished yet.
   */
  private async cancelFromDashboard(): Promise<void> {
    const active = this.active;
    this.cancelFixQuietly();
    if (this.running) {
      this.running.cancel();
      if (active) { await this.host.post({ type: 'reviewProgress', payload: { ...active, message: 'Stopping after the current step…' } }); }
    } else if (active) {
      // Still waiting for consent or planning: nothing is running to stop.
      this.cancel();
      await this.host.post({ type: 'reviewFailed', payload: { ...active, cancelled: true, message: 'Review cancelled.' } });
    }
  }

  private git(workspaceRoot = this.host.workspaceRoot()): GitCommandService {
    return new GitCommandService(workspaceRoot);
  }

  private async start(payload: Record<string, unknown>): Promise<void> {
    const requestId = payload.requestId;
    const repositoryPath = optionalString(payload.repositoryPath);
    const scope = payload.scope;
    const kind: ReviewKind = payload.kind === 'release' ? 'release' : payload.kind === 'local' ? 'local' : 'review';
    let targetRevision = optionalString(payload.targetRevision);
    let baseRevision = optionalString(payload.baseRevision);
    // A current-branch review ('release') names no revisions: it covers what the current branch adds
    // ('changes') or every file at its tip ('branch'). A review of local changes ('local') names none
    // either, and is HEAD → a snapshot taken now; or both ends, to run the same snapshot again (Retry).
    // Any other review names its target.
    const localAgain = kind === 'local' && Boolean(targetRevision && baseRevision);
    if (typeof requestId !== 'number' || !repositoryPath || (scope !== 'changes' && scope !== 'branch') ||
        (kind === 'local' && scope !== 'changes') ||
        (kind === 'review' ? !targetRevision : kind === 'local' ? !localAgain && Boolean(targetRevision || baseRevision)
          : Boolean(targetRevision || baseRevision))) {
      return;
    }
    // Some changed files only (one file's Review from the dashboard): a changes review, names only.
    const paths = payload.paths === undefined ? undefined
      : Array.isArray(payload.paths) && payload.paths.length > 0 && payload.paths.length <= MAX_REVIEW_PATHS &&
        payload.paths.every(item => typeof item === 'string' && item.length > 0) ? [...new Set(payload.paths as string[])] : null;
    if (paths === null || (paths && scope !== 'changes')) {
      return;
    }
    // The review tab may start a review the dashboard asked for after the dashboard switched
    // folders: its repository path is relative to the folder it was asked in, so never run it here.
    const folder = optionalString(payload.folder);
    if (folder && folder !== this.host.workspaceRoot()) {
      await this.host.post({ type: 'reviewFailed', payload: { requestId, repositoryPath,
        message: 'The workspace folder changed before this review started. Start it again from the dashboard.' } });
      return;
    }
    this.cancel();
    const generation = this.generation;
    this.active = { requestId, repositoryPath };
    const reply = async (type: string, extra: Record<string, unknown>) => {
      if (type === 'reviewCompleted' || type === 'reviewFailed') {
        if (this.active?.requestId === requestId) { this.active = undefined; }
      }
      if (generation === this.generation) {
        await this.host.post({ type, payload: { requestId, repositoryPath, ...extra } });
      }
    };
    // Pinned for the whole review: switching workspace folders does not move it.
    const workspaceRoot = this.host.workspaceRoot();
    const git = this.git(workspaceRoot);
    const root = git.resolveRepositoryPath(repositoryPath);
    const repositoryName = path.basename(root);
    let branchBaseLabel: string | undefined;
    let localTargetLabel: string | undefined;
    if (localAgain) {
      branchBaseLabel = 'HEAD';
      localTargetLabel = 'local changes';
    } else if (kind === 'local') {
      // Staged and unstaged changes and new files, as they are now; HEAD and the index are not touched.
      let snapshot;
      try {
        snapshot = await snapshotLocalChanges(git, root);
      } catch (error) {
        await reply('reviewFailed', { message: error instanceof Error ? error.message : String(error) });
        return;
      }
      if (!snapshot) {
        await reply('reviewFailed', { message: 'Nothing to review: there are no local changes (staged, unstaged or new files).' });
        return;
      }
      baseRevision = snapshot.headSha;
      targetRevision = snapshot.snapshotSha;
      branchBaseLabel = 'HEAD';
      localTargetLabel = 'local changes';
    }
    if (kind === 'release') {
      targetRevision = (await resolveReleaseRange(git, root)).currentBranch;
      if (scope === 'changes') {
        // What the branch adds: the diff from where it left the default branch, as a pull request shows it.
        const defaultBranch = await resolveDefaultBranch(git, root);
        const forkPoint = defaultBranch
          ? await git.execGit(['merge-base', defaultBranch, targetRevision], root, 10000).catch(() => '')
          : '';
        if (!forkPoint) {
          await reply('reviewFailed', { message: defaultBranch
            ? `${targetRevision} shares no history with ${defaultBranch}: choose All files from the Review branch menu instead.`
            : 'No default branch (main or master) to compare the current branch with: choose All files from the Review branch menu instead.' });
          return;
        }
        if (forkPoint === await git.execGit(['rev-parse', `${targetRevision}^{commit}`], root, 10000)) {
          await reply('reviewFailed', { message: `Nothing to review: ${targetRevision} has no commits that ${defaultBranch} does not have. ` +
            'To review every file, choose All files from the Review branch menu.' });
          return;
        }
        baseRevision = forkPoint;
        branchBaseLabel = `${defaultBranch} (merge-base)`;
      }
    }
    const target = targetRevision as string;
    let targetSha: string;
    let baseSha: string | undefined;
    try {
      targetSha = await git.resolveRevision(repositoryPath, target);
      baseSha = scope === 'changes' && baseRevision ? await git.resolveRevision(repositoryPath, baseRevision) : undefined;
    } catch (error) {
      await reply('reviewFailed', { message: `Cannot resolve revision: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    // A comparison reviews what Target adds since it left Base, as a pull request shows it: commits
    // only on Base would otherwise read as removed by Target. Base stays as chosen when it is an
    // ancestor of Target (the merge-base is Base), when Target is behind it (a deliberate backward
    // comparison), or when they share no history.
    let comparedFromMergeBase = false;
    if (kind === 'review' && baseSha) {
      const mergeBase = await git.execGit(['merge-base', baseSha, targetSha], root, 10000).catch(() => '');
      if (mergeBase && mergeBase !== baseSha && mergeBase !== targetSha) {
        baseSha = mergeBase;
        comparedFromMergeBase = true;
      }
    }
    const chosenBaseLabel = branchBaseLabel || optionalString(payload.baseLabel) || baseRevision;
    const baseLabel = scope === 'changes' ? (comparedFromMergeBase ? `${chosenBaseLabel} (merge-base)` : chosenBaseLabel) : undefined;
    // The files reviewed follow the target's name; Retry sends that name back, so it is added once.
    const chosenTargetLabel = localTargetLabel || optionalString(payload.targetLabel) || target;
    const filesLabel = paths ? ` · ${paths.length === 1 ? paths[0] : `${paths.length} files`}` : '';
    const targetLabel = chosenTargetLabel.endsWith(filesLabel) ? chosenTargetLabel : chosenTargetLabel + filesLabel;
    const needsConsent = this.host.alwaysConfirm() || !this.host.isConsentRemembered(root);
    await reply('reviewProgress', { message: needsConsent ? 'Waiting for confirmation…' : 'Planning the review…', baseLabel, targetLabel });
    if (needsConsent) {
      const what = kind === 'local'
        ? paths ? `your local changes to ${filesLabel.slice(3)}` : 'your local changes (staged, unstaged and new files)'
        : scope === 'changes'
          ? `changes ${baseLabel || 'from the parent commit'} → ${targetLabel}`
          : `every file at ${targetLabel}`;
      // Offering "always" only makes sense when the setting does not ask every time anyway.
      const actions = this.host.alwaysConfirm() ? [START] : [START, ALWAYS];
      const answer = await this.host.ask(
        `Review ${what} in ${repositoryName} with Copilot?`,
        (kind === 'local'
          ? 'Your uncommitted code as it is now, including new files that .gitignore does not exclude, and the repository review policy, ' +
            'is sent to the selected Copilot model in several requests. The review reads a snapshot of them (taken like `git add`, ' +
            'so clean filters your Git config sets for these files run, as they do for git status); it never commits, ' +
            'and never changes your files or staging. Results are advisory.'
          : 'Source code from these revisions, and the repository review policy, is sent to the selected Copilot model ' +
            'in several requests. The review reads commits only; it never runs code or changes the repository. Results are advisory.') +
          (actions.includes(ALWAYS) ? ' "Always allow" skips this question for this repository in this workspace; ' +
            'undo it with "Repository Manager: Forget Review Permissions".' : ''),
        actions);
      if (generation !== this.generation) { return; }
      if (answer !== START && answer !== ALWAYS) {
        await reply('reviewFailed', { cancelled: true, message: 'Review cancelled.' });
        return;
      }
      if (answer === ALWAYS) { await this.host.rememberConsent(root); }
      await reply('reviewProgress', { message: 'Planning the review…' });
    }
    const cancellation = this.host.createCancellation();
    this.running = cancellation;
    // Clean code rides on security and compliance while a quality skill is on. Retry says so itself,
    // so it runs with the categories of the review it repeats (and finds its saved components).
    const includeQuality = typeof payload.includeQuality === 'boolean' ? payload.includeQuality : this.host.skills?.includeQuality() === true;
    const categories: ReviewCategory[] = includeQuality ? [...CATEGORIES, 'quality'] : [...CATEGORIES];
    const request: ReviewRequest = { repositoryPath, targetSha, baseSha, scope, categories, ...(paths ? { paths } : {}) };
    const context: ReviewReportContext = { kind, repositoryName, baseLabel, targetLabel, generatedAt: new Date() };
    try {
      const modelId = optionalString(payload.modelId);
      const result = await this.host.createRunner(workspaceRoot)
        .review(request, cancellation.token, (message, detail) => { void reply('reviewProgress', { message, detail }); }, modelId);
      if (generation !== this.generation) { return; }
      // Text in the reviewed code that speaks to an AI may have steered the model: near a finding, and
      // anywhere in the diff, where it may have kept a problem from being reported. The tab warns.
      await this.checkAiDirectedText(git, root, result, () => cancellation.token.isCancellationRequested);
      if (generation !== this.generation) { return; }
      context.generatedAt = new Date();
      const storedContext = { kind, repositoryName, baseLabel, targetLabel, generatedAt: context.generatedAt.toISOString() };
      // Saving is best effort: a full or failing workspace state must not lose the result on screen.
      // Issues already dismissed or known in an earlier review of this repository keep that decision.
      const triage = carryTriage(result.findings, this.host.history.list(root)
        .map(entry => ({ generatedAt: entry.context.generatedAt, findings: entry.result.findings, triage: entry.triage })));
      const historyId = await this.host.history.add({ repositoryRoot: root, workspaceRoot, repositoryPath, context: storedContext, result, triage })
        .then(entry => entry.id, () => undefined);
      // A saved review of local changes keeps its snapshot; one the history let go (it keeps the newest) does not.
      if (historyId) { await this.keepSnapshots(git, root); }
      this.remember(requestId, { result, context, triage, workspaceRoot, historyId });
      await reply('reviewCompleted', { result, readiness: assessReadiness(result, triage), layout: assessReadiness(result), context: storedContext, triage, historyId });
    } catch (error) {
      const cancelled = cancellation.token.isCancellationRequested;
      await reply('reviewFailed', { cancelled, message: cancelled
        ? 'Review cancelled.' : `Review failed: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (this.running === cancellation) { this.running = undefined; }
      cancellation.dispose();
    }
  }

  private async export(payload: Record<string, unknown>): Promise<void> {
    const stored = typeof payload.requestId === 'number' ? this.reviews.get(payload.requestId) : undefined;
    if (!stored) {
      this.host.notify('That review is no longer available to export. Run it again.', true);
      return;
    }
    const markdown = renderReviewMarkdown(stored.result, stored.context, stored.triage);
    if (payload.format === 'save') {
      const label = `${stored.context.baseLabel ? `${stored.context.baseLabel}-` : ''}${stored.context.targetLabel}`.replace(/[^A-Za-z0-9._-]+/g, '-');
      if (await this.host.saveText(`${stored.context.kind}-review-${label}.md`, markdown)) {
        this.host.notify('Review report saved.');
      }
    } else {
      await this.host.copyText(markdown);
      this.host.notify('Review report copied as Markdown.');
    }
  }

  /** A reviewer's decision on one finding; `decision: null` clears it. Readiness is recomputed here. */
  private async setTriage(payload: Record<string, unknown>): Promise<void> {
    const requestId = payload.requestId;
    const stored = typeof requestId === 'number' ? this.reviews.get(requestId) : undefined;
    const findingId = optionalString(payload.findingId);
    if (!stored || !findingId || !stored.result.findings.some(finding => finding.id === findingId)) { return; }
    const next = { ...stored.triage };
    if (payload.decision === null || payload.decision === undefined) { delete next[findingId]; }
    else { next[findingId] = { decision: payload.decision, reason: payload.reason } as ReviewTriage[string]; }
    stored.triage = normalizeTriage(stored.result, next);
    if (stored.historyId) { await this.host.history.setTriage(stored.historyId, stored.triage).catch(() => undefined); }
    await this.updateFixForTriage(requestId as number, stored.triage);
    await this.host.post({ type: 'reviewTriageUpdated', payload: { requestId, triage: stored.triage,
      readiness: assessReadiness(stored.result, stored.triage), layout: assessReadiness(stored.result) } });
  }

  /**
   * A proposal fixes the findings marked "Needs fix" when it was requested. When one of them is no
   * longer marked, its files leave the proposal (the rest still apply); when another finding is
   * marked, or nothing would be left, the proposal closes. Either way the dashboard says why.
   */
  private async updateFixForTriage(requestId: number, triage: ReviewTriage): Promise<void> {
    const fix = this.fix;
    if (!fix || fix.requestId !== requestId) { return; }
    const wanted = new Set(Object.entries(triage).filter(([, item]) => item.decision === 'fix').map(([id]) => id));
    const dropped = fix.findingIds.filter(id => !wanted.has(id));
    const added = [...wanted].filter(id => !fix.findingIds.includes(id));
    if (!dropped.length && !added.length) { return; }
    if (fix.proposal && !added.length) {
      const files = fix.proposal.files.filter(file => file.findingIds.some(id => wanted.has(id)));
      if (files.length) {
        const removed = fix.proposal.files.length - files.length;
        fix.findingIds = fix.findingIds.filter(id => wanted.has(id));
        fix.proposal = { ...fix.proposal, files, findingIds: fix.findingIds };
        await this.host.post({ type: 'reviewFixUpdated', payload: { requestId,
          files: files.map(file => ({ path: file.path, patch: file.patch, findingIds: file.findingIds })),
          message: removed ? `Removed ${removed} file${removed === 1 ? '' : 's'} that only fixed findings no longer marked "Needs fix".` : '' } });
        return;
      }
    }
    const wasProposed = Boolean(fix.proposal);
    this.cancelFixQuietly();
    await this.host.post({ type: 'reviewFixDiscarded', payload: { requestId, message: added.length
      ? `Another finding is marked "Needs fix", so the ${wasProposed ? 'proposed fix was closed' : 'fix being proposed was stopped'}. Propose it again to include it.`
      : `The ${wasProposed ? 'proposed fix was closed' : 'fix being proposed was stopped'}: none of its findings is marked "Needs fix" any more.` } });
  }

  private cancelFixQuietly(): void {
    this.fix?.running?.cancel();
    this.fix?.running?.dispose();
    this.fix = undefined;
  }

  private async cancelFix(): Promise<void> {
    const requestId = this.fix?.requestId;
    const wasRunning = Boolean(this.fix?.running);
    this.cancelFixQuietly();
    if (requestId !== undefined && wasRunning) {
      await this.host.post({ type: 'reviewFixFailed', payload: { requestId, cancelled: true, message: 'Auto-fix cancelled.' } });
    }
  }

  /** Asks Copilot for edits that fix the findings marked "Needs fix", for preview in the dashboard. */
  private async proposeFix(payload: Record<string, unknown>): Promise<void> {
    const requestId = payload.requestId;
    const stored = typeof requestId === 'number' ? this.reviews.get(requestId) : undefined;
    if (!stored || typeof requestId !== 'number') {
      this.host.notify('That review is no longer available. Run it again to fix its findings.', true);
      return;
    }
    this.cancelFixQuietly();
    const cancellation = this.host.createCancellation();
    const findingIds = Object.entries(stored.triage).filter(([, triage]) => triage.decision === 'fix').map(([id]) => id);
    const fix: NonNullable<ReviewController['fix']> = { requestId, workspaceRoot: stored.workspaceRoot, findingIds, running: cancellation };
    this.fix = fix;
    const reply = async (type: string, extra: Record<string, unknown>) => {
      if (this.fix === fix) { await this.host.post({ type, payload: { requestId, ...extra } }); }
    };
    const fail = (message: string, cancelled = false) => {
      const done = reply('reviewFixFailed', { message, cancelled });
      if (this.fix === fix) { this.fix = undefined; }
      return done;
    };
    try {
      const service = new ReviewFixService(this.git(stored.workspaceRoot));
      // Fail fast on the selection and the working tree before asking for consent or calling the model.
      const { root, findings } = await service.prepare({ repositoryPath: stored.result.request.repositoryPath, result: stored.result,
        findingIds, isDirtyInEditor: absolute => this.host.isDirtyInEditor(absolute) });
      if (this.host.alwaysConfirm() || !this.host.isConsentRemembered(root)) {
        const actions = this.host.alwaysConfirm() ? [START] : [START, ALWAYS];
        const answer = await this.host.ask(`Ask Copilot to fix ${findings.length} finding${findings.length === 1 ? '' : 's'} in ${path.basename(root)}?`,
          'The cited files and the findings are sent to the selected Copilot model. You see the proposed changes before anything is written, and nothing is committed.',
          actions);
        if (this.fix !== fix) { return; }
        if (answer !== START && answer !== ALWAYS) { await fail('Auto-fix cancelled.', true); return; }
        if (answer === ALWAYS) { await this.host.rememberConsent(root); }
      }
      const proposal = await service.propose({ repositoryPath: stored.result.request.repositoryPath, result: stored.result, findingIds,
        model: this.host.createFixModel(optionalString(payload.modelId)), token: cancellation.token,
        isDirtyInEditor: absolute => this.host.isDirtyInEditor(absolute),
        onProgress: detail => { void reply('reviewFixProgress', { message: FIX_STEP_MESSAGES[detail.step], detail }); } });
      if (this.fix !== fix) { return; }
      fix.running = undefined;
      fix.proposal = proposal;
      await reply('reviewFixProposed', { files: proposal.files.map(file => ({ path: file.path, patch: file.patch, findingIds: file.findingIds })),
        notes: proposal.notes, rejected: proposal.rejected, findingIds: proposal.findingIds, modelId: proposal.modelId });
    } catch (error) {
      if (cancellation.token.isCancellationRequested) { return; }
      await fail(error instanceof FixError ? error.message : `Auto-fix failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      cancellation.dispose();
    }
  }

  /** Applies the whole proposal, or only `paths` of it (Apply selected); the rest stays proposed. */
  private async applyFix(payload: Record<string, unknown>): Promise<void> {
    const fix = this.fix;
    if (!fix?.proposal || fix.requestId !== payload.requestId) { return; }
    const onlyPaths = Array.isArray(payload.paths) ? payload.paths.filter((item): item is string => typeof item === 'string') : undefined;
    try {
      const proposal = fix.proposal;
      const paths = await new ReviewFixService(this.git(fix.workspaceRoot)).apply(proposal, absolute => this.host.isDirtyInEditor(absolute), onlyPaths);
      const remaining = proposal.files.filter(file => !paths.includes(file.path));
      fix.applied = [...(fix.applied || []), ...paths];
      // A finding is fixed once every proposed file with edits for it has been applied.
      // Only findings still in the proposal: a file can also touch a finding dismissed since.
      const fixedIds = [...new Set(proposal.files.filter(file => paths.includes(file.path)).flatMap(file => file.findingIds))]
        .filter(id => fix.findingIds.includes(id) && !remaining.some(file => file.findingIds.includes(id)));
      if (remaining.length) { fix.proposal = { ...proposal, files: remaining }; } else { this.fix = undefined; }
      await this.host.post({ type: 'reviewFixApplied', payload: { requestId: fix.requestId, paths, fixedFindingIds: fixedIds,
        remaining: remaining.map(file => ({ path: file.path, patch: file.patch, findingIds: file.findingIds })) } });
      const stored = this.reviews.get(fix.requestId);
      if (stored && fixedIds.length) {
        const next = { ...stored.triage };
        fixedIds.forEach(id => { next[id] = { decision: 'fixed' }; });
        stored.triage = normalizeTriage(stored.result, next);
        if (stored.historyId) { await this.host.history.setTriage(stored.historyId, stored.triage).catch(() => undefined); }
        await this.host.post({ type: 'reviewTriageUpdated', payload: { requestId: fix.requestId, triage: stored.triage,
          readiness: assessReadiness(stored.result, stored.triage), layout: assessReadiness(stored.result) } });
      }
      this.host.notify(`Applied the fix to ${paths.length} file${paths.length === 1 ? '' : 's'}. Nothing was committed.`);
      this.host.workingTreeChanged();
    } catch (error) {
      // The proposal stays, so the user can discard it or fix the cause and apply again.
      await this.host.post({ type: 'reviewFixFailed', payload: { requestId: fix.requestId, keepProposal: true,
        message: error instanceof FixError ? error.message : `Could not apply the fix: ${error instanceof Error ? error.message : String(error)}` } });
    }
  }

  private async discardFix(payload: Record<string, unknown>): Promise<void> {
    if (this.fix && this.fix.requestId === payload.requestId) {
      this.cancelFixQuietly();
      await this.host.post({ type: 'reviewFixDiscarded', payload: { requestId: payload.requestId } });
    }
  }

  private cancelExplanationQuietly(): void {
    this.explaining?.cancellation.cancel();
    this.explaining?.cancellation.dispose();
    this.explaining = undefined;
  }

  /** Cancel in the tab: the finding goes back to what it showed before (an earlier explanation, or none). */
  private async cancelExplanation(): Promise<void> {
    const job = this.explaining;
    this.cancelExplanationQuietly();
    if (job) {
      await this.host.post({ type: 'reviewExplainFailed', payload: { requestId: job.requestId, findingId: job.findingId,
        cancelled: true, message: 'Explanation cancelled.' } });
    }
  }

  /**
   * Asks Copilot to explain one finding of an open review: its cause, risk, fix and how to confirm
   * it. Reads the cited lines at the reviewed commits, so nothing needs to be checked out, and
   * changes nothing. One explanation at a time: asking for another stops the one being written.
   */
  private async explain(payload: Record<string, unknown>): Promise<void> {
    const requestId = payload.requestId;
    const findingId = optionalString(payload.findingId);
    if (typeof requestId !== 'number' || !findingId) { return; }
    const stored = this.reviews.get(requestId);
    await this.cancelExplanation();
    if (!stored) {
      await this.host.post({ type: 'reviewExplainFailed', payload: { requestId, findingId,
        message: 'That review is no longer available. Run it again, or open it from Past reviews, to explain its findings.' } });
      return;
    }
    const cancellation = this.host.createCancellation();
    const job = { requestId, findingId, cancellation };
    this.explaining = job;
    const reply = async (type: string, extra: Record<string, unknown>) => {
      if (this.explaining === job) { await this.host.post({ type, payload: { requestId, findingId, ...extra } }); }
    };
    try {
      const service = new ReviewExplainService(this.git(stored.workspaceRoot));
      // The finding and its cited lines are read before asking, so a question is never wasted on a refusal.
      const prepared = await service.prepare({ repositoryPath: stored.result.request.repositoryPath, result: stored.result, findingId });
      // Cancelled (or replaced) while the cited lines were read: neither ask nor send.
      if (this.explaining !== job) { return; }
      if (this.host.alwaysConfirm() || !this.host.isConsentRemembered(prepared.root)) {
        await reply('reviewExplainProgress', { message: 'Waiting for confirmation…' });
        const actions = this.host.alwaysConfirm() ? [EXPLAIN] : [EXPLAIN, ALWAYS];
        const answer = await this.host.ask(`Ask Copilot to explain this finding in ${path.basename(prepared.root)}?`,
          'The finding and the lines it cites, with a few lines around them, are sent to the selected Copilot model. ' +
            'Nothing in the repository is changed, and the finding keeps its status and triage.' +
            (actions.includes(ALWAYS) ? ' "Always allow" is shared with reviews of this repository.' : ''),
          actions);
        if (this.explaining !== job) { return; }
        if (answer !== EXPLAIN && answer !== ALWAYS) {
          await reply('reviewExplainFailed', { cancelled: true, message: 'Explanation cancelled.' });
          return;
        }
        if (answer === ALWAYS) { await this.host.rememberConsent(prepared.root); }
      }
      await reply('reviewExplainProgress', { message: 'Asking Copilot…' });
      let lastProgress = 0;
      const explanation = await service.explain(prepared, { model: this.host.createFixModel(optionalString(payload.modelId)),
        token: cancellation.token, language: this.host.language?.(),
        onText: receivedCharacters => {
          const now = Date.now();
          if (now - lastProgress < EXPLAIN_PROGRESS_INTERVAL) { return; }
          lastProgress = now;
          void reply('reviewExplainProgress', { message: 'Receiving the explanation…', receivedCharacters });
        } });
      await reply('reviewExplanation', { explanation });
    } catch (error) {
      if (cancellation.token.isCancellationRequested) { return; }
      await reply('reviewExplainFailed', { message: error instanceof ExplainError
        ? error.message : `Could not explain the finding: ${error instanceof Error ? error.message : String(error)}` });
    } finally {
      if (this.explaining === job) { this.explaining = undefined; }
      cancellation.dispose();
    }
  }

  private remember(requestId: number, review: StoredReview): void {
    this.reviews.delete(requestId);
    this.reviews.set(requestId, review);
    while (this.reviews.size > MAX_OPEN_REVIEWS) { this.reviews.delete(this.reviews.keys().next().value as number); }
  }

  /** The Past reviews list for a repository of the current workspace folder. */
  private async listHistory(payload: Record<string, unknown>): Promise<void> {
    const repositoryPath = optionalString(payload.repositoryPath);
    if (!repositoryPath) { return; }
    const root = this.git().resolveRepositoryPath(repositoryPath);
    await this.host.post({ type: 'reviewHistoryLoaded', payload: { repositoryPath, listId: payload.listId,
      entries: this.host.history.list(root).map(summarize) } });
  }

  /** Reopens a saved review under the dashboard's new request id, with its triage. */
  private async openStored(payload: Record<string, unknown>): Promise<void> {
    const requestId = payload.requestId;
    const id = optionalString(payload.id);
    if (typeof requestId !== 'number' || !id) { return; }
    const entry = this.host.history.get(id);
    if (!entry) {
      await this.host.post({ type: 'reviewFailed', payload: { requestId, repositoryPath: payload.repositoryPath,
        message: 'That saved review no longer exists.' } });
      return;
    }
    // Like starting a review: the dashboard leaves the previous one, so its auto-fix and explanation are dropped.
    this.cancelFixQuietly();
    this.cancelExplanationQuietly();
    const git = this.git(entry.workspaceRoot);
    // Kept again if its ref went missing (another workspace let it go), as long as Git still has it.
    if (entry.context.kind === 'local' || await isStashSnapshot(git, entry.repositoryRoot, entry.result.request.targetSha)) {
      await this.keepSnapshots(git, entry.repositoryRoot);
    }
    // Reviews saved before the check existed get it now, while their commits can still be read, and
    // keep it: the commits may be gone by the next time.
    if (await this.checkAiDirectedText(git, git.resolveRepositoryPath(entry.repositoryPath), entry.result)) {
      await this.host.history.setResult(id, entry.result).catch(() => undefined);
    }
    const context: ReviewReportContext = { ...entry.context, generatedAt: new Date(entry.context.generatedAt) };
    this.remember(requestId, { result: entry.result, context, triage: entry.triage, workspaceRoot: entry.workspaceRoot, historyId: id });
    await this.host.post({ type: 'reviewCompleted', payload: { requestId, repositoryPath: entry.repositoryPath, result: entry.result,
      readiness: assessReadiness(entry.result, entry.triage), layout: assessReadiness(entry.result), context: entry.context, triage: entry.triage, historyId: id } });
  }

  private async deleteStored(payload: Record<string, unknown>): Promise<void> {
    const id = optionalString(payload.id);
    if (!id) { return; }
    const entry = this.host.history.get(id);
    await this.host.history.remove(id);
    if (entry) { await this.keepSnapshots(this.git(entry.workspaceRoot), entry.repositoryRoot); }
    // An open copy stays usable for this session, but no longer writes triage to the history.
    this.reviews.forEach(review => { if (review.historyId === id) { review.historyId = undefined; } });
    await this.listHistory(payload);
  }

  /**
   * Marks findings whose cited code speaks to an AI, and lists every such line the reviewed diff
   * adds (once: a result that has the list keeps it). Marking findings is best effort; a diff that
   * cannot be checked, or a check stopped by Cancel, is recorded (`aiDirectedTextError`), so the
   * review does not read as clean. Returns whether the result changed.
   */
  private async checkAiDirectedText(git: GitCommandService, root: string, result: ReviewResult,
    isCancelled?: () => boolean): Promise<boolean> {
    const marked = await markAiDirectedText(git, root, result.findings).catch(() => 0);
    if (result.aiDirectedText) { return marked > 0; }
    let scanned: Awaited<ReturnType<typeof scanReviewedChanges>>;
    try {
      scanned = await scanReviewedChanges(git, root, result.request, undefined, isCancelled);
    } catch (error) {
      // Not checked is not clean: the review shows it as a gap, and opening it again checks again.
      result.aiDirectedTextError = (error instanceof Error ? error.message : String(error)).slice(0, 300);
      return true;
    }
    delete result.aiDirectedTextError;
    result.aiDirectedText = scanned.lines;
    if (scanned.truncated) { result.aiDirectedTextTruncated = true; }
    return true;
  }

  /**
   * The snapshots this repository's saved reviews read are kept from garbage collection while the
   * reviews are saved, so their evidence and explanations still open later: those of local changes,
   * and the commit a stash with untracked files is reviewed as (stashTarget).
   * Best effort: a repository that refuses the ref only loses that guarantee.
   */
  private async keepSnapshots(git: GitCommandService, root: string): Promise<void> {
    const snapshots: string[] = [];
    for (const entry of this.host.history.list(root)) {
      const target = entry.result.request.targetSha;
      if (entry.context.kind === 'local' || await isStashSnapshot(git, root, target)) { snapshots.push(target); }
    }
    await keepSnapshots(git, root, snapshots).catch(() => undefined);
  }

  private async openEvidence(payload: Record<string, unknown>): Promise<void> {
    const repositoryPath = optionalString(payload.repositoryPath);
    const revision = optionalString(payload.revision);
    const filePath = optionalString(payload.path);
    const line = Number(payload.line);
    // Only full commit hashes the review itself returned, and plain repository-relative paths.
    if (!repositoryPath || !revision || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(revision) || !filePath ||
        filePath.startsWith('/') || filePath.startsWith('-') || filePath.split('/').includes('..') || !Number.isInteger(line) || line < 1) {
      return;
    }
    // Evidence from a stored review resolves where that review ran: its folder and its repository
    // path there. The dashboard may now show the same repository under another path (e.g. `lib`
    // reviewed from a parent folder, reopened as `.`), so its own path is not combined with that folder.
    const stored = typeof payload.requestId === 'number' ? this.reviews.get(payload.requestId) : undefined;
    const git = this.git(stored?.workspaceRoot);
    try {
      const root = git.resolveRepositoryPath(stored ? stored.result.request.repositoryPath : repositoryPath);
      const content = await git.execGitRaw(['show', `${revision}:${filePath}`], root, 10000);
      await this.host.openText(content, revision, filePath, line);
    } catch (error) {
      this.host.notify(`Cannot open ${filePath} at ${revision.slice(0, 8)}: ${error instanceof Error ? error.message : String(error)}`, true);
    }
  }
}
