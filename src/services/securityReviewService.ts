import * as vscode from 'vscode';
import { PolicyRuleResult, ReviewFinding, ReviewProgressCallback, ReviewProgressDetail, ReviewRequest, ReviewResult } from '../types';
import { GitCommandService } from './gitCommandService';
import { trimReviewLog } from './reviewLog';
import { findingFingerprint, validatePolicyResult, validateReviewFinding } from './reviewFindingValidation';
import { appliesToPath, component, ReviewPlan, ReviewSurveyService, ReviewWorkUnit } from './reviewSurveyService';
import { consolidateLimitations, TRUNCATION_NOTE } from './reviewLimitations';
import { PROMPT_VERSION, ReviewChatModel, SecurityReviewProvider } from './securityReviewProvider';
import { ReviewUnitCacheLike, ReviewUnitOutcome, ReviewUnitRepair, reviewUnitKey } from '../reviewUnitCache';
import { AppliedSkills, ReviewSkill, selectReviewSkills } from './reviewSkills';

/** Steps kept in a result's log; a long review keeps its first ones. */
const MAX_LOG = 400;

/**
 * The components a review covers, each with its files, for the progress list; files left out when
 * planning (binary, lockfile, symlink, budget) are listed under their component with the reason,
 * and components with only such files come last with no files to review.
 */
export function progressComponents(plan: ReviewPlan): ReviewProgressComponent[] {
  const steps: ReviewProgressComponent[] = plan.units.map(unit => ({ component: unit.component, files: unit.paths.length, paths: unit.paths }));
  for (const item of plan.coverage.skipped.slice(0, 200)) {
    const name = component(item.path);
    let step = steps.find(entry => entry.component === name);
    if (!step) { step = { component: name, files: 0, paths: [] }; steps.push(step); }
    (step.skipped = step.skipped || []).push({ path: item.path, reason: item.reason });
  }
  return steps;
}

/** A component being reviewed: what its answers established so far, and what they said about coverage. */
type UnitState = ReviewUnitRepair & Pick<ReviewUnitOutcome, 'skipped' | 'limitations' | 'analyzed'>;
type FailedChecks = { path: string; reason: string }[];

function unverifiedCount(repair: ReviewUnitRepair): number {
  return repair.candidates.filter(candidate => !repair.verdicts[candidate.id]).length;
}

/** What Retry asks for again in a component, for the progress line and the log. */
function describeRepair(repair: ReviewUnitRepair): string {
  const unverified = unverifiedCount(repair);
  return [unverified ? `${unverified} finding(s) without a verdict` : '',
    repair.invalid.length ? `${repair.invalid.length} finding(s) whose citations did not check out` : '',
    repair.recheckRules.length ? `policy rule(s) ${repair.recheckRules.join(', ')}` : ''].filter(Boolean).join(', ');
}

export interface ReviewProgressComponent {
  component: string;
  files: number;
  paths: string[];
  skipped?: Array<{ path: string; reason: string }>;
}

export class SecurityReviewService {
  private survey: ReviewSurveyService;
  constructor(git: GitCommandService, private provider = new SecurityReviewProvider(), private cache?: ReviewUnitCacheLike,
    private skills: () => { skills: ReviewSkill[]; disabled: ReadonlySet<string> } = () => ({ skills: [], disabled: new Set() })) {
    this.survey = new ReviewSurveyService(git);
  }

  async review(request: ReviewRequest, token: vscode.CancellationToken,
    progress: ReviewProgressCallback, selectedModelId?: string): Promise<ReviewResult> {
    // Every step is also kept in the result, so a review that went wrong can be read afterwards.
    const log: NonNullable<ReviewResult['log']> = [];
    const started = Date.now();
    const notify = progress;
    progress = (message, detail) => {
      log.push({ at: Date.now() - started, message: message.slice(0, 300) });
      // Keep the failures and the newest steps, so a long review still shows how it ended.
      if (log.length > MAX_LOG * 2) { log.splice(0, log.length, ...trimReviewLog(log, MAX_LOG)); }
      notify(message, detail);
    };
    const state: ReviewProgressDetail = { phase: 'planning', unit: 0, units: 0, filesDone: 0, filesTotal: 0, candidates: 0 };
    progress('Planning the review…', { ...state });
    const plan = await this.survey.plan(request);
    const { coverage, policy } = plan;
    state.units = plan.units.length;
    state.filesTotal = plan.units.reduce((total, unit) => total + unit.paths.length, 0);
    // Messages from inside a step (tool reads, verification) carry the step's position.
    const report = (message: string) => progress(message, { ...state });
    const findings = new Map<string, ReviewFinding>();
    const results = new Map<string, PolicyRuleResult[]>();
    const limitations: string[] = [];
    // What the model reports per component; merged into a short list at the end.
    const modelLimitations: string[] = [];
    if (plan.request.categories.includes('compliance') && policy.status === 'not_configured') {
      limitations.push('Compliance policy is not configured at the target revision.');
      // Nothing else to review: compliance was the only category asked for.
      if (!plan.request.categories.some(category => category !== 'compliance')) {
        coverage.complete = false;
        return { request: plan.request, findings: [], policyResults: [], coverage,
          policyStatus: policy.status, limitations };
      }
    }
    const model = await this.provider.selectModel(selectedModelId);
    const modelId = `${model.id}:${model.version}`;
    state.model = model.name || model.id;
    progress(`Planned ${plan.units.length} component(s), ${state.filesTotal} file(s)`, { ...state,
      components: progressComponents(plan) });
    // Components already reviewed at these commits with this model and these prompts are reused.
    // Skills are chosen per component by its paths; what was sent is part of the cache key.
    const available = this.skills();
    const skillsFor = (unit: ReviewWorkUnit): AppliedSkills =>
      selectReviewSkills(available.skills, unit.paths, plan.request.categories, available.disabled);
    const skillsApplied: NonNullable<ReviewResult['skillsApplied']> = [];
    const keyFor = (unit: ReviewWorkUnit, applied: AppliedSkills) => reviewUnitKey({ modelId, promptVersion: PROMPT_VERSION, instructions: applied.hash,
      targetSha: plan.request.targetSha, baseSha: plan.request.baseSha, scope: plan.request.scope,
      categories: plan.request.categories, component: unit.component, paths: unit.paths, rules: unit.rules });
    let unitsDone = 0;
    let stopped = false;
    for (const [index, unit] of plan.units.entries()) {
      if (token.isCancellationRequested) { stopped = true; break; }
      Object.assign(state, { phase: 'analyzing', unit: index + 1, component: unit.component });
      const applied = skillsFor(unit);
      const key = keyFor(unit, applied);
      let outcome = this.cache?.get(key);
      if (outcome && !outcome.repair) {
        report(`Reusing the saved result for component ${index + 1}/${plan.units.length}: ${unit.component}`);
        // Saved before findings had fingerprints: add them, so decisions on them can carry over.
        for (const finding of outcome.findings) {
          if (!finding.fingerprint) {
            const fingerprint = await findingFingerprint(finding, plan);
            if (fingerprint) { finding.fingerprint = fingerprint; }
          }
        }
      } else {
        const failed: FailedChecks = [];
        // Saved after a failed check: only what failed is asked again; what passed is kept as it was.
        const saved = outcome;
        let cacheable = true;
        try {
          if (saved?.repair) {
            report(`Asking again for what failed in component ${index + 1}/${plan.units.length}: ${unit.component} (${describeRepair(saved.repair)})`);
            outcome = await this.repairUnit(plan, unit, saved, model, token, report, state, failed, applied);
          } else {
            report(`Reviewing component ${index + 1}/${plan.units.length}: ${unit.component}`);
            ({ outcome, cacheable } = await this.reviewUnit(plan, unit, model, token, report, state, failed, applied));
          }
        } catch (error) {
          if (token.isCancellationRequested) { stopped = true; break; }
          const reason = error instanceof Error ? error.message : 'Review failed';
          if (saved) {
            // What the saved answers established still holds; its gaps are asked for next time.
            outcome = saved;
            failed.push({ path: unit.component, reason });
          } else {
            for (const path of unit.paths) { failed.push({ path, reason }); }
          }
        }
        // One entry per file and reason: several bad findings from one component are one failed check.
        const unique = failed.filter((item, index) => failed.findIndex(other => other.path === item.path && other.reason === item.reason) === index);
        failed.splice(0, failed.length, ...unique);
        coverage.failed.push(...failed);
        // One line per reason, not per file: a component that failed as a whole lists all its files.
        for (const reason of new Set(failed.map(item => item.reason))) {
          const files = failed.filter(item => item.reason === reason).length;
          report(`Component ${unit.component} failed${files > 1 ? ` (${files} files)` : ''}: ${reason}`);
        }
        // Kept with what it lacks, so the next run asks for that only. A component whose answer was
        // unusable as a whole (a failed request, too many results) is not kept and is asked again in full.
        if (outcome && cacheable) { await this.cache?.set(key, outcome).catch(() => undefined); }
      }
      if (outcome && (applied.skills.length || applied.omitted.length)) {
        skillsApplied.push({ component: unit.component, skills: applied.skills.map(skill => skill.id),
          ...(applied.omitted.length ? { omitted: applied.omitted } : {}) });
      }
      if (outcome) {
        state.candidates += outcome.candidates;
        for (const finding of outcome.findings) {
          if (!findings.has(finding.id) || finding.status === 'verified') { findings.set(finding.id, finding); }
        }
        for (const result of outcome.policyResults) {
          results.set(result.ruleId, [...(results.get(result.ruleId) || []), result]);
        }
        coverage.skipped.push(...outcome.skipped);
        modelLimitations.push(...outcome.limitations);
        coverage.analyzed += outcome.analyzed;
      }
      unitsDone = index + 1;
      state.filesDone += unit.paths.length;
    }
    // Cancelled before anything was reviewed: nothing to show or keep.
    if (stopped && unitsDone === 0) { throw new Error('Cancelled'); }
    Object.assign(state, { phase: 'finishing', component: undefined });
    report('Collecting results…');
    const policyResults: PolicyRuleResult[] = [];
    if (policy.status === 'configured') {
      for (const rule of policy.policy.rules) {
        const entries = results.get(rule.id) || [];
        if (!entries.length) {
          const selected = plan.request.scope === 'changes' ? plan.changedPaths : plan.snapshot.tree.entries.map(entry => entry.path);
          const potentiallyApplies = plan.snapshot.tree.truncated || selected.some(path => appliesToPath(rule, path));
          policyResults.push({ ruleId: rule.id,
            status: potentiallyApplies ? 'insufficient_evidence' : 'not_applicable',
            reason: potentiallyApplies ? 'Applicable files were not fully reviewed.' : 'No selected file matches this rule.',
            evidence: [] });
          continue;
        }
        const violations = entries.filter(item => item.status === 'violation');
        // not_applicable is a definitive answer for that batch; only insufficient evidence or
        // incomplete coverage leaves the rule unresolved.
        const unavailable = rule.verification !== 'ai' || entries.some(item => item.status === 'insufficient_evidence') ||
          coverage.failed.length > 0 || coverage.skipped.some(item => appliesToPath(rule, item.path));
        const allNotApplicable = entries.every(item => item.status === 'not_applicable');
        policyResults.push(rule.verification === 'ai' && violations.length
          ? { ruleId: rule.id, status: 'violation', reason: violations.map(item => item.reason).join('; ').slice(0, 1000),
            evidence: violations.flatMap(item => item.evidence).slice(0, 8) }
          : unavailable
            ? { ruleId: rule.id, status: 'insufficient_evidence',
              reason: rule.verification === 'ai' ? 'Some applicable files or checks were incomplete.' : `${rule.verification} verification has not been run.`, evidence: [] }
            : allNotApplicable
              ? { ruleId: rule.id, status: 'not_applicable', reason: entries.map(item => item.reason).join('; ').slice(0, 1000), evidence: [] }
              : { ruleId: rule.id, status: 'pass', reason: 'AI assessed all selected files covered by this rule.',
                evidence: entries.flatMap(item => item.evidence).slice(0, 8) });
      }
    }
    coverage.complete = !stopped && coverage.complete && !coverage.skipped.length && !coverage.failed.length &&
      coverage.analyzed === coverage.surveyed;
    const consolidated = consolidateLimitations(modelLimitations, { policyConfigured: policy.status === 'configured' });
    if (consolidated.truncated) { limitations.push(TRUNCATION_NOTE); }
    if (stopped) {
      limitations.push(`The review stopped after ${unitsDone} of ${plan.units.length} components; the rest was not reviewed. Run it again to continue: finished components are reused.`);
    }
    if (!coverage.complete) { limitations.push('Review coverage is incomplete; missing checks are not a pass.'); }
    limitations.push('Verified findings have source and diff citations and a second AI check; this does not prove absence of other vulnerabilities.');
    return { request: plan.request, findings: [...findings.values()], policyResults, coverage,
      policyStatus: policy.status, modelId, modelName: state.model, log: trimReviewLog(log, MAX_LOG), limitations: [...new Set(limitations)].slice(0, 40),
      toVerify: consolidated.toVerify.slice(0, 20),
      ...(skillsApplied.length ? { skillsApplied } : {}),
      ...(stopped ? { partial: { unitsDone, unitsTotal: plan.units.length } } : {}) };
  }

  /**
   * Analyzes and verifies one component. Problems that leave it incomplete go into `failed`; the
   * outcome records what is missing (`repair`). `cacheable` is false when only a whole new answer
   * can fix it.
   */
  private async reviewUnit(plan: ReviewPlan, unit: ReviewWorkUnit, model: ReviewChatModel, token: vscode.CancellationToken,
    report: (message: string) => void, state: ReviewProgressDetail, failed: FailedChecks,
    applied: AppliedSkills): Promise<{ outcome: ReviewUnitOutcome; cacheable: boolean }> {
    const raw = await this.provider.analyze(plan, unit, model, token, report, applied.skills);
    let cacheable = true;
    if (raw.findings.length > 20) {
      failed.push({ path: unit.component, reason: 'AI finding limit exceeded' });
      cacheable = false;
    }
    if (raw.policyResults.length > 200) {
      failed.push({ path: unit.component, reason: 'AI policy result limit exceeded' });
      cacheable = false;
    }
    const skipped = raw.partialPaths.map(file => ({ path: file.path, partial: true, reason: file.characters
      ? `Partly reviewed: the model saw the first ${file.characters.toLocaleString('en-US')} characters of line 1 (of ${file.total.toLocaleString('en-US')})`
      : `Partly reviewed: the model saw ${file.seen.toLocaleString('en-US')} of ${file.total.toLocaleString('en-US')} lines` }));
    const limitations = (Array.isArray(raw.limitations) ? raw.limitations.filter((item): item is string =>
      typeof item === 'string' && item.length <= 500) : []).slice(0, 10);
    // Files that could not be read were left out; the rest of the component was reviewed. Such a
    // result is not saved, so running the review again tries those files again.
    const unreadable = raw.unreadable || [];
    if (unreadable.length) { cacheable = false; }
    const left: Array<{ path: string; reason: string; partial?: boolean }> = [...skipped, ...unreadable.map(file => ({ path: file.path, reason: `not read: ${file.reason}` }))];
    const unitState: UnitState = { candidates: [], verdicts: {}, policyResults: [], invalid: [], recheckRules: [],
      skipped: left, limitations, analyzed: unit.paths.length - unreadable.length };
    await this.collect(raw.findings.slice(0, 20), raw.policyResults.slice(0, 200), unit.rules.map(rule => rule.id),
      plan, unit, applied, unitState, failed);
    await this.verifyPending(plan, unit, unitState, model, token, report, state, failed);
    return { outcome: this.finish(unit, unitState, failed), cacheable };
  }

  /**
   * Completes a component saved with a failed check, asking only for what failed: findings whose
   * citations did not check out (asked to cite real lines), rules with no usable result, and the
   * second check for findings that have no verdict. Everything else is kept as it was.
   */
  private async repairUnit(plan: ReviewPlan, unit: ReviewWorkUnit, saved: ReviewUnitOutcome, model: ReviewChatModel,
    token: vscode.CancellationToken, report: (message: string) => void, state: ReviewProgressDetail, failed: FailedChecks,
    applied: AppliedSkills): Promise<ReviewUnitOutcome> {
    const repair = JSON.parse(JSON.stringify(saved.repair)) as ReviewUnitRepair;
    const unitState: UnitState = { ...repair, recheckRules: repair.recheckRules.filter(id => unit.rules.some(rule => rule.id === id)),
      skipped: saved.skipped, limitations: saved.limitations, analyzed: saved.analyzed };
    const requestFailed = (what: string, error: unknown) => {
      if (token.isCancellationRequested) { throw error; }
      failed.push({ path: unit.component, reason: `${what} failed: ${error instanceof Error ? error.message : String(error)}` });
    };
    if (unitState.invalid.length) {
      const invalid = unitState.invalid;
      unitState.invalid = [];
      try {
        const raw = await this.provider.analyze(plan, unit, model, token, report, applied.skills, { recite: invalid });
        // Only the findings: a policy result here would answer rules nobody asked about again.
        await this.collect(raw.findings.slice(0, 20), [], [], plan, unit, applied, unitState, failed);
      } catch (error) {
        unitState.invalid = invalid;
        requestFailed('Asking again for findings with bad citations', error);
      }
    }
    if (unitState.recheckRules.length) {
      const rulesUnit = { ...unit, rules: unit.rules.filter(rule => unitState.recheckRules.includes(rule.id)) };
      const rulesPlan: ReviewPlan = { ...plan, request: { ...plan.request, categories: ['compliance'] } };
      try {
        const raw = await this.provider.analyze(rulesPlan, rulesUnit, model, token, report, [], { rulesOnly: true });
        // A rule that already has a compliance finding keeps it: the model's new wording of the same
        // violation would be a second finding, untriaged, for one issue.
        const covered = new Set(unitState.candidates.filter(candidate => candidate.category === 'compliance').map(candidate => candidate.ruleId));
        const compliance = raw.findings.filter(item => Boolean(item) && typeof item === 'object' &&
          (item as Record<string, unknown>).category === 'compliance' && !covered.has(String((item as Record<string, unknown>).ruleId))).slice(0, 20);
        await this.collect(compliance, raw.policyResults.slice(0, 200), rulesUnit.rules.map(rule => rule.id),
          rulesPlan, rulesUnit, applied, unitState, failed);
      } catch (error) {
        requestFailed('Asking again for policy results', error);
      }
    }
    await this.verifyPending(plan, unit, unitState, model, token, report, state, failed);
    return this.finish(unit, unitState, failed);
  }

  /**
   * Validates findings and policy results from one answer into the component's state. Findings
   * that fail validation are kept as written, to be asked for again. `askedRules` are the rules this
   * answer was asked about: those it gave no valid result for, or conflicting ones, are asked again.
   */
  private async collect(findings: unknown[], policyResults: unknown[], askedRules: string[], plan: ReviewPlan,
    unit: ReviewWorkUnit, applied: AppliedSkills, unitState: UnitState, failed: FailedChecks): Promise<void> {
    for (const item of findings) {
      const finding = await validateReviewFinding(item, plan, unit);
      if (!finding) {
        unitState.invalid.push(item);
        failed.push({ path: unit.component, reason: 'AI finding had invalid or ungrounded evidence' });
        continue;
      }
      // Only a skill this component was given; the model may name one it was not. A finding from a
      // clean code skill is a quality note whatever category the model gave it, so it cannot block.
      const source = finding.skill ? applied.skills.find(skill => skill.id === finding.skill) : undefined;
      if (finding.skill && !source) { delete finding.skill; }
      if (source?.category === 'quality' && finding.category !== 'quality') {
        finding.category = 'quality';
        delete finding.ruleId;
        if (finding.severity === 'critical' || finding.severity === 'high') { finding.severity = 'medium'; }
      }
      if (finding.category === 'compliance') {
        finding.severity = unit.rules.find(rule => rule.id === finding.ruleId)!.severity;
      }
      const fingerprint = await findingFingerprint(finding, plan);
      if (fingerprint) { finding.fingerprint = fingerprint; }
      if (!unitState.candidates.some(candidate => candidate.id === finding.id)) { unitState.candidates.push(finding); }
    }
    const answered = new Set<string>();
    const contested = new Set<string>();
    for (const item of policyResults) {
      const result = await validatePolicyResult(item, plan, unit);
      if (!result || answered.has(result.ruleId)) {
        failed.push({ path: unit.component, reason: 'Invalid or duplicate policy result' });
        const ruleId = result ? result.ruleId : item && typeof item === 'object' ? (item as Record<string, unknown>).ruleId : undefined;
        if (typeof ruleId === 'string' && askedRules.includes(ruleId)) { contested.add(ruleId); }
        continue;
      }
      answered.add(result.ruleId);
      unitState.policyResults = unitState.policyResults.filter(existing => existing.ruleId !== result.ruleId).concat(result);
    }
    unitState.recheckRules = unitState.recheckRules.filter(id => !askedRules.includes(id))
      .concat(askedRules.filter(id => contested.has(id) || !answered.has(id)));
  }

  /** The second check, for the findings that have no verdict yet. */
  private async verifyPending(plan: ReviewPlan, unit: ReviewWorkUnit, unitState: UnitState, model: ReviewChatModel,
    token: vscode.CancellationToken, report: (message: string) => void, state: ReviewProgressDetail, failed: FailedChecks): Promise<void> {
    const pending = unitState.candidates.filter(candidate => !unitState.verdicts[candidate.id]);
    if (!pending.length) { return; }
    state.phase = 'verifying';
    try {
      const verdicts = await this.provider.verify(plan, pending, model, token, report);
      verdicts.forEach((verdict, id) => { unitState.verdicts[id] = verdict; });
    } catch (error) {
      if (token.isCancellationRequested) { throw error; }
      failed.push({ path: unit.component, reason: `Finding verification failed: ${String(error)}` });
    }
  }

  /**
   * The component's outcome from its state: findings kept after the second check with their status,
   * policy results (a violation needs a supported finding), and, while anything is missing, `repair`.
   * Every missing part is also a failed check, so a component never looks complete while it is not.
   */
  private finish(unit: ReviewWorkUnit, unitState: UnitState, failed: FailedChecks): ReviewUnitOutcome {
    const supported = (id: string) => unitState.verdicts[id] === 'supported';
    const findings: ReviewFinding[] = [];
    for (const candidate of unitState.candidates) {
      const verdict = unitState.verdicts[candidate.id];
      if (verdict === 'rejected') { continue; }
      // A rule the policy marks manual or static cannot be verified by an AI check.
      const rule = candidate.category === 'compliance' ? unit.rules.find(item => item.id === candidate.ruleId) : undefined;
      findings.push({ ...candidate, evidence: candidate.evidence.map(evidence => ({ ...evidence })),
        status: verdict === 'supported' && (!rule || rule.verification === 'ai') ? 'verified' : 'hypothesis' });
    }
    const policyResults: PolicyRuleResult[] = unitState.policyResults.map(result =>
      result.status === 'violation' && !unitState.candidates.some(candidate => candidate.category === 'compliance' &&
        candidate.ruleId === result.ruleId && supported(candidate.id))
        ? { ...result, status: 'insufficient_evidence', reason: 'Violation has no corroborated compliance finding.' }
        : { ...result });
    for (const rule of unit.rules) {
      if (!unitState.policyResults.some(result => result.ruleId === rule.id)) {
        policyResults.push({ ruleId: rule.id, status: 'insufficient_evidence', reason: 'AI did not return a result for this scope.', evidence: [] });
        failed.push({ path: unit.component, reason: `No policy result for ${rule.id}` });
      } else if (unitState.recheckRules.includes(rule.id)) {
        failed.push({ path: unit.component, reason: 'Invalid or duplicate policy result' });
      }
    }
    if (unitState.invalid.length) { failed.push({ path: unit.component, reason: 'AI finding had invalid or ungrounded evidence' }); }
    // The second assessment must cover every candidate; a missing verdict is a gap, not a pass.
    const unverified = unverifiedCount(unitState);
    if (unverified && !failed.some(item => item.path === unit.component && item.reason.startsWith('Finding verification failed'))) {
      failed.push({ path: unit.component, reason: `No verification verdict for ${unverified} of ${unitState.candidates.length} finding(s)` });
    }
    const pending = unverified > 0 || unitState.invalid.length > 0 || unitState.recheckRules.length > 0;
    return { findings, candidates: unitState.candidates.length, policyResults, skipped: unitState.skipped,
      limitations: unitState.limitations, analyzed: unitState.analyzed,
      ...(pending ? { repair: { candidates: unitState.candidates, verdicts: unitState.verdicts, policyResults: unitState.policyResults,
        invalid: unitState.invalid, recheckRules: unitState.recheckRules } } : {}) };
  }
}
