const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { execFileSync } = require('node:child_process');

const originalLoad = Module._load;
Module._load = function (name, parent, isMain) {
  if (name === 'vscode') return {};
  return originalLoad.call(this, name, parent, isMain);
};
const { SecurityReviewProvider } = require('../../out/services/securityReviewProvider.js');
const { SecurityReviewService } = require('../../out/services/securityReviewService.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { ReviewSurveyService, matchesReviewPattern } = require('../../out/services/reviewSurveyService.js');
const { changedLines, validateReviewFinding } = require('../../out/services/reviewFindingValidation.js');
Module._load = originalLoad;

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-engine-'));
function git(...args) { return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim(); }
function write(file, data) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), data);
}
function commit(message) { git('add', '-A'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); }

async function main() {
  try {
    git('init', '-q');
    write('src/app.js', 'const x = input;\n');
    const base = commit('base');
    write('src/app.js', 'const x = input;\neval(x);\n');
    write('.repository-manager/review-policy.json', JSON.stringify({ version: 1, rules: [
      { id: 'TEAM-01', description: 'Do not execute untrusted input', scope: { include: ['src/**'] },
        severity: 'high', verification: 'ai', requiredEvidence: 'Trace input to execution' },
      { id: 'TEAM-MANUAL', description: 'Obtain review approval', scope: { include: ['src/**'] },
        severity: 'medium', verification: 'manual', requiredEvidence: 'Approved review record' }
    ] }));
    const target = commit('add eval');
    git('checkout', '-q', base);
    write('src/app.js', 'safe working tree\n');
    assert.equal(matchesReviewPattern('src/**', 'src/app.js'), true);
    assert.equal(matchesReviewPattern('**/*.js', 'app.js'), true);
    assert.deepEqual([...changedLines('@@ -1 +1,2 @@\n a\n+eval(x);', 'target')], [2]);

    let searchCalls = 0;
    const analyzePrompts = [];
    let invalidEvidence = false;
    let verdictDecision = 'supported';
    const model = { id: 'mock', version: '1', name: 'Mock', maxInputTokens: 100000,
      countTokens: async value => Math.ceil(value.length / 4),
      async sendRequest(messages) {
        let response;
        if (messages[0].startsWith('Independently')) {
          const ids = JSON.parse(messages[1]).evidence.map(item => item.finding.id);
          response = { verdicts: ids.map(id => ({ id, decision: verdictDecision, reason: 'Checked cited line' })) };
        } else {
          const packet = JSON.parse(messages[1]);
          const includesCode = packet.files.some(file => file.path === 'src/app.js');
          if (includesCode && messages.length === 2) {
            response = { toolCall: { name: 'search_code', args: { query: 'eval(', prefix: 'src' } } };
          } else {
            if (includesCode) {
              const search = JSON.parse(messages[2]).result;
              assert.deepEqual(search.matches.map(match => match.line), [2]);
              searchCalls++;
            }
            const evidence = [{ revision: target, path: 'src/app.js', side: 'target',
              startLine: invalidEvidence ? 1 : 2, endLine: invalidEvidence ? 1 : 2 }];
            const candidate = category => ({ category, ruleId: category === 'compliance' ? 'TEAM-01' : undefined,
              severity: 'high', confidence: 'high', explanation: 'User input is executed by eval',
              impact: 'Untrusted code may run', suggestedAction: 'Remove eval', evidence });
            response = { schemaVersion: 1, targetSha: target,
              findings: includesCode ? [candidate('security'), candidate('compliance')] : [],
              policyResults: includesCode ? [{ ruleId: 'TEAM-01', status: 'violation', reason: 'Untrusted execution', evidence },
                { ruleId: 'TEAM-MANUAL', status: 'insufficient_evidence', reason: 'Needs external approval', evidence: [] }] : [],
              // Every component repeats a scope note and the same real gap.
              limitations: ['Review was limited to the requested files.', 'Whether input reaches eval depends on callers that were not supplied.'] };
            analyzePrompts.push(messages[0]);
          }
        }
        return { text: (async function* () { yield JSON.stringify(response); })() };
      }
    };
    const provider = new SecurityReviewProvider({ lm: { selectChatModels: async () => [model] },
      LanguageModelChatMessage: { User: value => value } });
    const service = new SecurityReviewService(new GitCommandService(repo), provider);
    const token = { isCancellationRequested: false };
    const request = { repositoryPath: '.', targetSha: target, baseSha: base,
      scope: 'changes', categories: ['security', 'compliance'] };
    const survey = await new ReviewSurveyService(new GitCommandService(repo)).plan(request);
    assert.equal(survey.request.targetSha, target);
    assert.deepEqual(survey.changedPaths.sort(), ['.repository-manager/review-policy.json', 'src/app.js']);
    const rootPlan = await new ReviewSurveyService(new GitCommandService(repo)).plan({
      repositoryPath: '.', targetSha: base, scope: 'changes', categories: ['security'] });
    assert.deepEqual(rootPlan.changedPaths, ['src/app.js']);
    const updates = [];
    analyzePrompts.length = 0;
    const result = await service.review(request, token, (message, detail) => updates.push({ message, detail }));
    // Limitations: the real gap once, however many components repeat it; scope notes dropped.
    assert.ok(analyzePrompts.length >= 1 && analyzePrompts.every(prompt => /do not restate which files were in scope/.test(prompt)));
    assert.equal(result.toVerify.filter(item => item === 'Whether input reaches eval depends on callers that were not supplied.').length, 1);
    assert.ok(!result.toVerify.concat(result.limitations).some(item => /limited to the requested files/.test(item)), 'scope notes were kept');
    // Progress: planning first, then the plan with every component, steps in order, then finishing.
    const details = updates.map(update => update.detail).filter(Boolean);
    assert.equal(details[0].phase, 'planning');
    const planned = details.find(detail => detail.components);
    assert.ok(planned && planned.components.length === planned.units && planned.units > 0);
    assert.equal(planned.components.reduce((sum, item) => sum + item.files, 0), planned.filesTotal);
    const steps = details.filter(detail => detail.phase === 'analyzing').map(detail => detail.unit);
    assert.deepEqual(steps, [...steps].sort((a, b) => a - b), 'components reported out of order');
    assert.equal(details.at(-1).phase, 'finishing');
    assert.equal(details.at(-1).filesDone, details.at(-1).filesTotal);
    assert.equal(searchCalls, 1);
    assert.equal(result.policyStatus, 'configured');
    assert.equal(result.coverage.complete, true);
    assert.equal(result.coverage.analyzed, 2);
    assert.equal(result.findings.length, 2);
    assert.ok(result.findings.every(item => item.status === 'verified' && item.evidence[0].startLine === 2));
    assert.equal(result.policyResults.find(item => item.ruleId === 'TEAM-01').status, 'violation');
    assert.equal(result.policyResults.find(item => item.ruleId === 'TEAM-MANUAL').status, 'insufficient_evidence');

    verdictDecision = 'uncertain';
    const uncertain = await service.review(request, token, () => {});
    assert.ok(uncertain.findings.every(item => item.status === 'hypothesis'));
    assert.equal(uncertain.policyResults.find(item => item.ruleId === 'TEAM-01').status, 'insufficient_evidence');
    verdictDecision = 'supported';

    invalidEvidence = true;
    const invalid = await service.review(request, token, () => {});
    assert.equal(invalid.findings.length, 0);
    assert.equal(invalid.coverage.complete, false);
    assert.equal(invalid.policyResults.find(item => item.ruleId === 'TEAM-01').status, 'insufficient_evidence');
    const unconfigured = await service.review({ repositoryPath: '.', targetSha: base,
      scope: 'branch', categories: ['compliance'] }, token, () => {});
    assert.equal(unconfigured.policyStatus, 'not_configured');
    assert.equal(unconfigured.coverage.complete, false);

    git('checkout', '-q', '-f', target);
    git('mv', 'src/app.js', 'src/runner.js');
    const renamed = commit('rename source');
    const renamePlan = await new ReviewSurveyService(new GitCommandService(repo)).plan({
      repositoryPath: '.', baseSha: target, targetSha: renamed, scope: 'changes', categories: ['security'] });
    assert.equal(renamePlan.oldPaths['src/runner.js'], 'src/app.js');
    const oldEvidence = [{ revision: target, path: 'src/app.js', side: 'base', startLine: 2, endLine: 2 }];
    const candidate = { category: 'security', severity: 'high', confidence: 'medium',
      explanation: 'Previously unsafe source is moved', impact: 'Execution risk',
      suggestedAction: 'Remove eval', evidence: oldEvidence };
    assert.ok(await validateReviewFinding(candidate, renamePlan, renamePlan.units.find(unit => unit.paths.includes('src/runner.js'))));

    // One file's review: only that changed file is planned; a rename is found by either path.
    const fileSurvey = new ReviewSurveyService(new GitCommandService(repo));
    const onePlan = await fileSurvey.plan({ repositoryPath: '.', baseSha: base, targetSha: target, scope: 'changes',
      categories: ['security'], paths: ['src/app.js'] });
    assert.deepEqual(onePlan.changedPaths, ['src/app.js'], 'the policy file changed too, but was not asked for');
    assert.deepEqual(onePlan.units.flatMap(unit => unit.paths), ['src/app.js']);
    assert.deepEqual(onePlan.request.paths, ['src/app.js'], 'the planned request lost its files (Retry and history need them)');
    for (const wanted of ['src/runner.js', 'src/app.js']) {
      const plan = await fileSurvey.plan({ repositoryPath: '.', baseSha: target, targetSha: renamed, scope: 'changes', categories: ['security'], paths: [wanted] });
      assert.deepEqual(plan.changedPaths, ['src/runner.js'], `the rename was not found by ${wanted}`);
    }
    await assert.rejects(fileSurvey.plan({ repositoryPath: '.', baseSha: target, targetSha: renamed, scope: 'changes', categories: ['security'],
      paths: ['.repository-manager/review-policy.json'] }), /Nothing to review: \.repository-manager\/review-policy\.json did not change here/);
    await assert.rejects(fileSurvey.plan({ repositoryPath: '.', targetSha: renamed, scope: 'branch', categories: ['security'], paths: ['src/runner.js'] }),
      /Only a changes review/);

    git('rm', 'src/runner.js');
    const deleted = commit('delete source');
    const deletePlan = await new ReviewSurveyService(new GitCommandService(repo)).plan({
      repositoryPath: '.', baseSha: renamed, targetSha: deleted, scope: 'changes', categories: ['security'] });
    assert.ok(await validateReviewFinding({ ...candidate, evidence: [
      { revision: renamed, path: 'src/runner.js', side: 'base', startLine: 2, endLine: 2 }
    ] }, deletePlan, deletePlan.units.find(unit => unit.paths.includes('src/runner.js'))));
    console.log('Security and compliance review engine smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
