const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { ReviewFixService, FixError, MAX_FIX_FILES } = require('../../out/services/reviewFixService.js');
const { ReviewController } = require('../../out/reviewController.js');
const { ReviewHistoryStore } = require('../../out/reviewHistory.js');
const { snapshotLocalChanges } = require('../../out/services/localChangesSnapshot.js');

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-'));
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.org', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.org' };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env }).trim();
const write = (file, content) => fs.writeFileSync(path.join(repo, file), content);
const read = file => fs.readFileSync(path.join(repo, file), 'utf8');
const never = { isCancellationRequested: false };

async function rejects(promise, pattern) {
  await assert.rejects(promise, error => error instanceof FixError && pattern.test(error.message));
}

async function main() {
  try {
    git('init', '-q', '-b', 'main');
    write('app.js', 'const input = read();\neval(input);\nmodule.exports = input;\n');
    write('util.js', 'exports.x = 1;\n');
    fs.mkdirSync(path.join(repo, 'src'));
    write('src/paths.js', "const target = 'a/paths.js';\neval(target);\n");
    fs.writeFileSync(path.join(repo, 'latin1.txt'), Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]));
    write('bom.js', '\uFEFFeval(x);\n');
    git('add', '.');
    git('commit', '-qm', 'one');
    const head = git('rev-parse', 'HEAD');
    const finding = (id, file, line) => ({ id, category: 'security', severity: 'high', confidence: 'high', status: 'verified',
      explanation: 'Input reaches eval', impact: 'Code execution', suggestedAction: 'Parse instead of eval',
      evidence: [{ revision: head, path: file, side: 'target', startLine: line, endLine: line }] });
    const result = { request: { repositoryPath: '.', targetSha: head, scope: 'branch', categories: ['security'] },
      findings: [finding('f1', 'app.js', 2), finding('f2', 'util.js', 1), finding('other', 'missing-at-target.js', 1)],
      policyResults: [], policyStatus: 'not_configured', limitations: [],
      coverage: { surveyed: 2, analyzed: 2, skipped: [], failed: [], complete: true } };
    const service = new ReviewFixService(new GitCommandService(repo));
    let response;
    let sent;
    const model = { request: async (instructions, input, token, onText) => { sent = input; if (onText) onText(JSON.stringify(response).length); return { modelId: 'fixer:1', response }; } };
    const propose = (overrides = {}) => service.propose({ repositoryPath: '.', result, findingIds: ['f1'], model, token: never,
      isDirtyInEditor: () => false, ...overrides });

    // Refusals the user can act on, before anything is sent.
    await rejects(propose({ findingIds: [] }), /Mark at least one finding/);
    // Only base-side evidence: nothing to edit. An unrelated untracked file must not turn this
    // into a "local changes" refusal (git status with no paths describes the whole repository).
    write('scratch.tmp', 'unrelated\n');
    const baseOnly = { ...result, findings: [{ ...finding('b1', 'app.js', 2),
      evidence: [{ revision: head, path: 'app.js', side: 'base', startLine: 2, endLine: 2 }] }] };
    await rejects(propose({ result: baseOnly, findingIds: ['b1'] }), /None of the marked findings cites a file/);
    fs.rmSync(path.join(repo, 'scratch.tmp'));
    sent = undefined;
    write('app.js', read('app.js') + '// local\n');
    await rejects(propose(), /app\.js changed since it was reviewed/);
    git('checkout', '--', 'app.js');
    await rejects(propose({ isDirtyInEditor: absolute => absolute.endsWith('app.js') }), /unsaved changes in an editor/);
    const many = { ...result, findings: Array.from({ length: MAX_FIX_FILES + 1 }, (_, index) => finding(`m${index}`, `f${index}.js`, 1)) };
    await rejects(propose({ result: many, findingIds: many.findings.map(item => item.id) }), /up to 8 at a time/);
    assert.equal(sent, undefined, 'files were sent to the model before the working tree was checked');

    // A proposal applies only edits that match exactly once, in cited files.
    response = { edits: [
      { path: 'app.js', findingId: 'f1', find: 'eval(input);', replace: 'JSON.parse(input);' },
      { path: 'app.js', find: 'input', replace: 'x' },
      { path: 'app.js', find: 'not in the file', replace: 'y' },
      { path: '../outside.js', find: 'a', replace: 'b' },
      { path: 'app.js', find: '', replace: 'z' }
    ], notes: ['Validate the parsed value too.'] };
    const proposal = await propose();
    assert.deepEqual(sent.files.map(file => file.path), ['app.js']);
    assert.deepEqual(sent.findings.map(item => item.id), ['f1']);
    assert.deepEqual(proposal.files.map(file => file.path), ['app.js']);
    assert.equal(proposal.files[0].after, 'const input = read();\nJSON.parse(input);\nmodule.exports = input;\n');
    assert.match(proposal.files[0].patch, /^--- a\/app\.js$/m);
    assert.match(proposal.files[0].patch, /^-eval\(input\);$/m);
    assert.match(proposal.files[0].patch, /^\+JSON\.parse\(input\);$/m);
    assert.equal(proposal.rejected.length, 4);
    assert.ok(proposal.rejected.some(item => /found more than once/.test(item)));
    assert.ok(proposal.rejected.some(item => /not found/.test(item)));
    assert.ok(proposal.rejected.some(item => /not one of the cited files/.test(item)));
    assert.deepEqual(proposal.notes, ['Validate the parsed value too.']);
    assert.equal(read('app.js').includes('eval(input)'), true, 'propose wrote the file');

    // Nothing applicable: explain instead of an empty preview.
    response = { edits: [{ path: 'app.js', find: 'nope', replace: 'x' }], notes: [] };
    await rejects(propose(), /no change that could be applied/);

    // Apply re-checks the file, writes it, and never stages or commits.
    write('app.js', read('app.js').replace('read()', 'readInput()'));
    git('commit', '-qam', 'moved on');
    await rejects(service.apply(proposal, () => false), /app\.js changed since it was reviewed/);
    git('reset', '-q', '--hard', head);
    write('app.js', read('app.js') + '// edited after the proposal\n');
    await rejects(service.apply(proposal, () => false), /changed since it was reviewed/);
    git('checkout', '--', 'app.js');
    assert.deepEqual(await service.apply(proposal, () => false), ['app.js']);
    assert.match(read('app.js'), /JSON\.parse\(input\)/);
    assert.equal(git('rev-parse', 'HEAD'), head, 'apply committed');
    assert.equal(git('diff', '--cached', '--name-only'), '', 'apply staged');
    assert.equal(git('diff', '--name-only'), 'app.js');
    git('checkout', '--', 'app.js');

    // The preview relabels only the header: content mentioning a/<name> is shown as written.
    response = { edits: [{ path: 'src/paths.js', find: 'eval(target);', replace: "require('./' + target);" },
      { path: 'src/paths.js', find: "'a/paths.js'", replace: "'b/paths.js'" }] };
    const nested = await propose({ result: { ...result, findings: [finding('n1', 'src/paths.js', 2)] }, findingIds: ['n1'] });
    const patch = nested.files[0].patch;
    assert.match(patch, /^--- a\/src\/paths\.js$/m);
    assert.match(patch, /^\+\+\+ b\/src\/paths\.js$/m);
    assert.match(patch, /^-const target = 'a\/paths\.js';$/m, 'hunk content was relabelled');
    assert.match(patch, /^\+const target = 'b\/paths\.js';$/m, 'hunk content was relabelled');

    // Encodings: a non-UTF-8 file is refused rather than silently re-encoded; a BOM survives.
    await rejects(propose({ result: { ...result, findings: [finding('l1', 'latin1.txt', 1)] }, findingIds: ['l1'] }), /not UTF-8 text/);
    response = { edits: [{ path: 'bom.js', find: 'eval(x);', replace: 'JSON.parse(x);' }] };
    const bom = await propose({ result: { ...result, findings: [finding('m1', 'bom.js', 1)] }, findingIds: ['m1'] });
    await service.apply(bom, () => false);
    assert.deepEqual([...fs.readFileSync(path.join(repo, 'bom.js')).subarray(0, 3)], [0xef, 0xbb, 0xbf], 'the BOM was lost');
    assert.equal(read('bom.js'), '\uFEFFJSON.parse(x);\n');
    git('checkout', '--', 'bom.js');

    // A review of local changes reviews a snapshot of the working tree, never HEAD, and its files
    // have uncommitted changes by definition: the fix applies while each file is still what was
    // reviewed, and is refused once it changed after the review.
    write('app.js', 'const input = readLocal();\neval(input);\nmodule.exports = input;\n');
    const local = await snapshotLocalChanges(new GitCommandService(repo), repo);
    local.sha = local.snapshotSha;
    assert.notEqual(local.sha, head);
    const localResult = { ...result, request: { ...result.request, scope: 'changes', baseSha: head, targetSha: local.sha },
      findings: [{ ...finding('lc1', 'app.js', 2), evidence: [{ revision: local.sha, path: 'app.js', side: 'target', startLine: 2, endLine: 2 }] }] };
    response = { edits: [{ path: 'app.js', find: 'eval(input);', replace: 'JSON.parse(input);' }] };
    const localFix = await propose({ result: localResult, findingIds: ['lc1'] });
    assert.equal(localFix.files[0].before, 'const input = readLocal();\neval(input);\nmodule.exports = input;\n');
    assert.deepEqual(await service.apply(localFix, () => false), ['app.js']);
    assert.equal(read('app.js'), 'const input = readLocal();\nJSON.parse(input);\nmodule.exports = input;\n');
    await rejects(propose({ result: localResult, findingIds: ['lc1'] }), /app\.js changed since it was reviewed \(it is not what [0-9a-f]{8} has\)/);
    // Checked out with CRLF (core.autocrlf on Windows), the file is still what was reviewed.
    write('app.js', 'const input = readLocal();\r\neval(input);\r\nmodule.exports = input;\r\n');
    response = { edits: [{ path: 'app.js', find: 'eval(input);', replace: 'JSON.parse(input);' }] };
    const crlf = await propose({ result: localResult, findingIds: ['lc1'] });
    assert.match(crlf.files[0].after, /JSON\.parse\(input\);\r\n/);
    git('checkout', '--', 'app.js');
    // A commit reviewed earlier: HEAD moved on, but the cited file did not change, so it still applies.
    write('other.txt', 'later\n');
    git('add', 'other.txt');
    git('commit', '-qm', 'later');
    response = { edits: [{ path: 'app.js', find: 'eval(input);', replace: 'JSON.parse(input);' }] };
    await service.apply(await propose(), () => false);
    assert.match(read('app.js'), /JSON\.parse\(input\)/);
    git('checkout', '--', 'app.js');
    git('reset', '-q', '--hard', head);

    // A folder replaced by a link to an outside folder with the same reviewed content: the fix
    // would write outside the repository, so it is refused.
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-outside-'));
    fs.cpSync(path.join(repo, 'src'), outside, { recursive: true });
    fs.renameSync(path.join(repo, 'src'), path.join(repo, 'src.real'));
    fs.symlinkSync(outside, path.join(repo, 'src'));
    response = { edits: [{ path: 'src/paths.js', find: 'eval(target);', replace: 'x;' }] };
    await rejects(propose({ result: { ...result, findings: [finding('s1', 'src/paths.js', 2)] }, findingIds: ['s1'] }), /symbolic link/);
    assert.equal(fs.readFileSync(path.join(outside, 'paths.js'), 'utf8').includes('eval(target);'), true);
    fs.rmSync(path.join(repo, 'src'));
    fs.renameSync(path.join(repo, 'src.real'), path.join(repo, 'src'));
    fs.rmSync(outside, { recursive: true, force: true });

    // A malformed entry in the edits array is rejected on its own; the valid edits still apply.
    response = { edits: [null, 7, [], { path: 'app.js', find: 'eval(input);', replace: 'JSON.parse(input);' }] };
    const tolerant = await propose();
    assert.equal(tolerant.rejected.filter(item => /not an object/.test(item)).length, 3);
    assert.match(tolerant.files[0].after, /JSON\.parse/);

    // Apply is all or nothing: when the second file cannot be replaced, the first is restored.
    response = { edits: [{ path: 'app.js', find: 'eval(input);', replace: 'JSON.parse(input);' },
      { path: 'util.js', find: 'exports.x = 1;', replace: 'exports.x = 2;' }] };
    const pair = await propose({ findingIds: ['f1', 'f2'] });
    assert.deepEqual(pair.files.map(file => file.path), ['app.js', 'util.js']);
    let renames = 0;
    const flaky = new ReviewFixService(new GitCommandService(repo), {
      writeFile: (file, data, mode) => fs.writeFileSync(file, data, mode === undefined ? undefined : { mode }),
      rename: (from, to) => { if (++renames === 2) { throw new Error('disk full'); } fs.renameSync(from, to); },
      remove: file => fs.rmSync(file, { force: true })
    });
    await rejects(flaky.apply(pair, () => false), /disk full.*nothing was changed/);
    assert.equal(read('app.js'), 'const input = read();\neval(input);\nmodule.exports = input;\n', 'the first file kept the partial fix');
    assert.equal(read('util.js'), 'exports.x = 1;\n');
    assert.equal(git('status', '--porcelain'), '', 'apply left files or temporary copies behind');
    // The same proposal still applies once the failure is gone.
    assert.deepEqual(await service.apply(pair, () => false), ['app.js', 'util.js']);
    assert.equal(git('status', '--porcelain'), 'M app.js\n M util.js'.trim());
    git('checkout', '--', 'app.js', 'util.js');
    // Each file records the findings its edits address (here: the findings citing it).
    assert.deepEqual(pair.files.map(file => file.findingIds), [['f1'], ['f2']]);
    // An edit naming a finding that does not cite its file counts for the finding that does.
    response = { edits: [{ path: 'util.js', findingId: 'f1', find: 'exports.x = 1;', replace: 'exports.x = 2;' }] };
    const misnamed = await propose({ findingIds: ['f1', 'f2'] });
    assert.deepEqual(misnamed.files.map(file => [file.path, file.findingIds]), [['util.js', ['f2']]]);
    // Apply selected writes only the chosen files.
    assert.deepEqual(await service.apply(pair, () => false, ['util.js']), ['util.js']);
    assert.equal(git('status', '--porcelain'), 'M util.js');
    await rejects(service.apply(pair, () => false, []), /Select at least one file/);
    git('checkout', '--', 'util.js');

    // Through the controller: consent, preview, apply, refresh.
    const posts = [];
    const questions = [];
    let refreshed = 0;
    let copied = '';
    let opened = null;
    // The dashboard can switch workspace folders while a review runs or after it finishes.
    let currentRoot = repo;
    const otherFolder = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fix-other-'));
    const remembered = new Set();
    const controller = new ReviewController({
      workspaceRoot: () => currentRoot,
      post: async message => { posts.push(message); },
      ask: async (message, detail, actions) => { questions.push(message); return actions[0]; },
      alwaysConfirm: () => false,
      isConsentRemembered: root => remembered.has(root),
      rememberConsent: async root => { remembered.add(root); },
      createRunner: () => ({ review: async () => result }),
      createCancellation: () => ({ token: { isCancellationRequested: false }, cancel() { this.token.isCancellationRequested = true; }, dispose() {} }),
      copyText: async text => { copied = text; }, saveText: async () => true,
      openText: async (content, revision, filePath) => { opened = { content, revision, filePath }; }, notify: () => {},
      createFixModel: () => model,
      isDirtyInEditor: () => false,
      workingTreeChanged: () => { refreshed++; },
      history: new ReviewHistoryStore(undefined)
    });
    const of = type => posts.filter(message => message.type === type);
    remembered.add(repo);
    await controller.handle({ type: 'startReview', payload: { requestId: 1, repositoryPath: '.', scope: 'branch', targetRevision: 'main' } });
    assert.equal(of('reviewCompleted').length, 1);
    // Switch the dashboard to another folder: the review stays pinned to the folder it ran in.
    currentRoot = otherFolder;
    await controller.handle({ type: 'openReviewEvidence', payload: { requestId: 1, repositoryPath: '.', revision: head, path: 'app.js', line: 2 } });
    assert.ok(opened && opened.content.includes('eval(input)'), 'evidence was looked up in the new folder');
    await controller.handle({ type: 'proposeReviewFix', payload: { requestId: 1 } });
    assert.match(of('reviewFixFailed').at(-1).payload.message, /Mark at least one finding/);
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f1', decision: 'fix' } });
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f2', decision: 'dismiss', reason: 'accepted_risk' } });
    const triaged = of('reviewTriageUpdated').at(-1).payload;
    assert.deepEqual(triaged.triage, { f1: { decision: 'fix' }, f2: { decision: 'dismiss', reason: 'accepted_risk' } });
    assert.equal(triaged.readiness.dismissed.length, 1);
    assert.equal(triaged.readiness.toFix, 1);
    response = { edits: [{ path: 'app.js', find: 'eval(input);', replace: 'JSON.parse(input);' }], notes: [] };
    remembered.clear();
    await controller.handle({ type: 'proposeReviewFix', payload: { requestId: 1 } });
    assert.match(questions.at(-1), /fix 1 finding in/);
    const proposed = of('reviewFixProposed').at(-1).payload;
    assert.deepEqual(proposed.files.map(file => file.path), ['app.js']);
    assert.deepEqual(proposed.findingIds, ['f1']);
    assert.equal(read('app.js').includes('eval(input)'), true);
    // A finding no longer marked "Needs fix" takes its files out; with none left, the proposal closes
    // and says why (a note the dashboard can close), and Apply then does nothing.
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f1', decision: null } });
    assert.match(of('reviewFixDiscarded').at(-1).payload.message, /none of its findings is marked "Needs fix"/);
    await controller.handle({ type: 'applyReviewFix', payload: { requestId: 1 } });
    assert.equal(of('reviewFixApplied').length, 0, 'applied a fix for a finding no longer marked Needs fix');
    assert.equal(read('app.js').includes('eval(input)'), true);
    // Marking another finding Needs fix also makes a proposal stale.
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f1', decision: 'fix' } });
    await controller.handle({ type: 'proposeReviewFix', payload: { requestId: 1 } });
    assert.equal(of('reviewFixProposed').length, 2);
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'other', decision: 'fix' } });
    assert.match(of('reviewFixDiscarded').at(-1).payload.message, /Another finding is marked "Needs fix"/);
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'other', decision: null } });
    await controller.handle({ type: 'proposeReviewFix', payload: { requestId: 1 } });
    await controller.handle({ type: 'applyReviewFix', payload: { requestId: 1 } });
    assert.deepEqual(of('reviewFixApplied').at(-1).payload.paths, ['app.js']);
    assert.equal(refreshed, 1);
    assert.match(read('app.js'), /JSON\.parse/);
    // A second Apply has no proposal left, and changes nothing.
    await controller.handle({ type: 'applyReviewFix', payload: { requestId: 1 } });
    assert.equal(of('reviewFixApplied').length, 1);
    // The exported report records the triage.
    await controller.handle({ type: 'exportReviewReport', payload: { requestId: 1, format: 'copy' } });
    // Progress went through every step, in order.
    const steps = of('reviewFixProgress').map(message => message.payload.detail && message.payload.detail.step);
    assert.deepEqual([...new Set(steps)].slice(-4), ['checking', 'sending', 'receiving', 'validating']);
    assert.ok(of('reviewFixProgress').some(message => message.payload.detail.receivedCharacters > 0), 'no reply size was reported');
    // The applied fix marked its finding fixed: out of "to fix", into Fixed, and in the report.
    assert.deepEqual(of('reviewFixApplied').at(-1).payload.fixedFindingIds, ['f1']);
    const afterFix = of('reviewTriageUpdated').at(-1).payload;
    assert.deepEqual(afterFix.triage.f1, { decision: 'fixed' });
    assert.deepEqual([afterFix.readiness.toFix, afterFix.readiness.fixed.length], [0, 1]);
    assert.match(copied, /Triage: 0 marked to fix, 1 fixed, 1 dismissed, 1 not triaged\./);
    assert.match(copied, /## Fixed\n\n- \*\*HIGH security\*\* · verified · confidence high · fixed/);
    assert.match(copied, /## Dismissed by reviewer\n\n- \*\*HIGH security\*\* · verified · confidence high · dismissed: accepted risk/);
    // Apply selected through the controller: the rest stays proposed, and only fully fixed findings are marked.
    git('checkout', '--', 'app.js');
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f1', decision: 'fix' } });
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f2', decision: 'fix' } });
    response = { edits: [{ path: 'app.js', findingId: 'f1', find: 'eval(input);', replace: 'JSON.parse(input);' },
      { path: 'util.js', findingId: 'f2', find: 'exports.x = 1;', replace: 'exports.x = 2;' }] };
    await controller.handle({ type: 'proposeReviewFix', payload: { requestId: 1 } });
    assert.deepEqual(of('reviewFixProposed').at(-1).payload.files.map(file => [file.path, file.findingIds]), [['app.js', ['f1']], ['util.js', ['f2']]]);
    await controller.handle({ type: 'applyReviewFix', payload: { requestId: 1, paths: ['util.js'] } });
    const partial = of('reviewFixApplied').at(-1).payload;
    assert.deepEqual([partial.paths, partial.fixedFindingIds, partial.remaining.map(file => file.path)], [['util.js'], ['f2'], ['app.js']]);
    assert.deepEqual(of('reviewTriageUpdated').at(-1).payload.triage, { f1: { decision: 'fix' }, f2: { decision: 'fixed' } });
    assert.equal(read('app.js').includes('eval(input)'), true, 'an unselected file was written');
    await controller.handle({ type: 'applyReviewFix', payload: { requestId: 1 } });
    assert.deepEqual(of('reviewFixApplied').at(-1).payload.paths, ['app.js']);
    assert.deepEqual(of('reviewTriageUpdated').at(-1).payload.triage, { f1: { decision: 'fixed' }, f2: { decision: 'fixed' } });
    // Marking a finding fixed by hand is a triage decision like the others.
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f1', decision: null } });
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f1', decision: 'fixed' } });
    assert.deepEqual(of('reviewTriageUpdated').at(-1).payload.triage.f1, { decision: 'fixed' });
    // Dismissing one of two findings in a proposal takes only its file out; the rest still applies,
    // and the dismissed finding stays dismissed.
    git('checkout', '--', 'app.js', 'util.js');
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f1', decision: 'fix' } });
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f2', decision: 'fix' } });
    await controller.handle({ type: 'proposeReviewFix', payload: { requestId: 1 } });
    assert.equal(of('reviewFixProposed').at(-1).payload.files.length, 2);
    await controller.handle({ type: 'setFindingTriage', payload: { requestId: 1, findingId: 'f2', decision: 'dismiss', reason: 'false_positive' } });
    const pruned = of('reviewFixUpdated').at(-1).payload;
    assert.deepEqual(pruned.files.map(file => file.path), ['app.js']);
    assert.match(pruned.message, /Removed 1 file that only fixed findings no longer marked "Needs fix"/);
    await controller.handle({ type: 'applyReviewFix', payload: { requestId: 1 } });
    assert.deepEqual(of('reviewFixApplied').at(-1).payload.paths, ['app.js']);
    assert.equal(read('util.js').includes('exports.x = 1;'), true, 'the dismissed finding\'s file was written');
    assert.deepEqual(of('reviewTriageUpdated').at(-1).payload.triage, { f1: { decision: 'fixed' }, f2: { decision: 'dismiss', reason: 'false_positive' } });
    fs.rmSync(otherFolder, { recursive: true, force: true });
    console.log('Review fix smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
