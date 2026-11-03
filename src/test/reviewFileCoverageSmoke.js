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
const { progressComponents } = require('../../out/services/securityReviewService.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { ReviewSurveyService, binaryPathsFromNumstat, changedTargetRanges, isLockfile } = require('../../out/services/reviewSurveyService.js');
Module._load = originalLoad;

const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'review-coverage-'));
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
function write(file, data) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), data);
}
function commit(message) { git('add', '-A'); git('-c', 'user.name=Test', '-c', 'user.email=test@example.org', 'commit', '-qm', message); return git('rev-parse', 'HEAD'); }
// A uv.lock-like file: one [[package]] block of 5 lines per package.
const lockfile = versions => versions.map((version, index) =>
  `[[package]]\nname = "pkg-${index}"\nversion = "${version}"\nsource = { registry = "https://pypi.org/simple" }\n`).join('\n');
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]);

async function main() {
  try {
    // Units: which names are lockfiles, binary rows of --numstat -z, and the target lines of hunks.
    for (const file of ['uv.lock', 'web/package-lock.json', 'Cargo.lock', 'go.sum', 'a/b/pnpm-lock.yaml', 'Gemfile.lock']) {
      assert.equal(isLockfile(file), true, file);
    }
    for (const file of ['lock.py', 'src/uv.lock.md', 'package.json', 'Cargo.toml']) assert.equal(isLockfile(file), false, file);
    assert.deepEqual([...binaryPathsFromNumstat('3\t1\tsrc/a.js\0-\t-\tdocs/logo.png\0-\t-\tname with\ttab.bin\0')],
      ['docs/logo.png', 'name with\ttab.bin']);
    assert.deepEqual(changedTargetRanges('@@ -1,3 +1,4 @@\n x\n@@ -20,2 +21,0 @@\n-y\n@@ -30 +30 @@\n@@ -40,3 +34,3 @@\n'),
      [[1, 4], [30, 30], [34, 36]], 'pure deletions add nothing; a missing count is one line');
    assert.deepEqual(changedTargetRanges('@@ -1,3 +1,3 @@\n@@ -4,3 +4,3 @@\n'), [[1, 6]], 'touching hunks merge');

    git('init', '-q');
    write('src/app.js', 'const x = 1;\n');
    write('uv.lock', lockfile(Array.from({ length: 40 }, () => '1.0.0')));
    write('docs/logo.png', png);
    const base = commit('base');
    write('src/app.js', 'const x = input;\neval(x);\n');
    const versions = Array.from({ length: 40 }, () => '1.0.0');
    versions[25] = '2.0.0';
    write('uv.lock', lockfile(versions));
    write('docs/logo.png', Buffer.concat([png, Buffer.from([1, 2, 3])]));
    write('assets/icons/new.png', png);
    const target = commit('change');
    const survey = new ReviewSurveyService(new GitCommandService(repo));

    // A diff: binary files are left out, by name and reason; a changed lockfile is reviewed.
    const plan = await survey.plan({ repositoryPath: '.', targetSha: target, baseSha: base, scope: 'changes', categories: ['security'] });
    assert.deepEqual(plan.units.flatMap(unit => unit.paths).sort(), ['src/app.js', 'uv.lock']);
    assert.deepEqual(plan.coverage.skipped.map(item => [item.path, item.reason]).sort(),
      [['assets/icons/new.png', 'binary file'], ['docs/logo.png', 'binary file']]);
    // The progress list: each component with its files; skipped files under their component.
    assert.deepEqual(progressComponents(plan), [
      { component: 'src', files: 1, paths: ['src/app.js'] },
      { component: 'uv.lock', files: 1, paths: ['uv.lock'] },
      { component: 'assets/icons', files: 0, paths: [], skipped: [{ path: 'assets/icons/new.png', reason: 'binary file' }] },
      { component: 'docs', files: 0, paths: [], skipped: [{ path: 'docs/logo.png', reason: 'binary file' }] }]);

    // Every file at a commit: lockfiles and binary files are left out.
    const all = await survey.plan({ repositoryPath: '.', targetSha: target, scope: 'branch', categories: ['security'] });
    assert.deepEqual(all.units.flatMap(unit => unit.paths), ['src/app.js']);
    assert.deepEqual(all.coverage.skipped.map(item => [item.path, item.reason]).sort(), [['assets/icons/new.png', 'binary file'],
      ['docs/logo.png', 'binary file'], ['uv.lock', 'lockfile (reviewed only when it changes)']]);

    // The reviewer sees only the changed entries of the lockfile, at their real line numbers, and
    // the rest of it is not reported as a gap.
    const packets = [];
    const model = { id: 'mock', version: '1', name: 'Mock', maxInputTokens: 100000, countTokens: async value => Math.ceil(value.length / 4),
      async sendRequest(messages) {
        packets.push(JSON.parse(messages[1]));
        const response = { schemaVersion: 1, targetSha: JSON.parse(messages[1]).request.targetSha, findings: [], policyResults: [], limitations: [] };
        return { text: (async function* () { yield JSON.stringify(response); })() };
      } };
    const provider = new SecurityReviewProvider({ lm: { selectChatModels: async () => [model] }, LanguageModelChatMessage: { User: value => value } });
    const lockUnit = plan.units.find(unit => unit.paths.includes('uv.lock'));
    const raw = await provider.analyze(plan, lockUnit, model, { isCancellationRequested: false }, () => {});
    const sent = packets[0].files.filter(file => file.path === 'uv.lock');
    // pkg-25's version is on line 25 * 5 + 3 = 128; the hunk keeps 3 lines of context around it.
    assert.deepEqual(sent.map(file => [file.startLine, file.endLine]), [[125, 131]]);
    assert.match(sent[0].content, /version = "2\.0\.0"/);
    assert.match(sent[0].excerpt, /only the changed entries/);
    assert.equal(sent[0].content.split('\n').length, 7);
    assert.deepEqual(raw.partialPaths, [], 'the unchanged lockfile entries were reported as not reviewed');

    // A file larger than 1 MB (generated output, data) is left out when the review is planned, as
    // a skipped file, not a failed check: the small files beside it in its component are reviewed.
    const big = Array.from({ length: 30000 }, (_, index) => `LINE ${index} ${'x'.repeat(30)}`).join('\n') + '\n';
    write('out/target_CPY.TXT', big);
    write('out/constants.py', 'TIMEOUT = 5\n');
    const withBig = commit('generated output');
    const bigPlan = await survey.plan({ repositoryPath: '.', targetSha: withBig, baseSha: target, scope: 'changes', categories: ['security'] });
    assert.deepEqual(bigPlan.units.flatMap(unit => unit.paths), ['out/constants.py']);
    assert.deepEqual(bigPlan.coverage.skipped.map(item => [item.path, item.reason]), [['out/target_CPY.TXT', 'larger than 1 MB (not read)']]);
    assert.ok(big.length > 1024 * 1024);

    // A file that cannot be read while the component is analysed is left out of that component
    // only; the other files are still sent and reviewed.
    packets.length = 0;
    const brokenPlan = { ...bigPlan, snapshot: Object.create(bigPlan.snapshot, { readFile: { value: async (file, ...rest) => {
      if (file === 'out/gone.py') { throw new Error('File exceeds snapshot read budget'); }
      return bigPlan.snapshot.readFile(file, ...rest);
    } }, fileExists: { value: file => file === 'out/gone.py' || bigPlan.snapshot.fileExists(file) } }) };
    const twoFiles = { component: 'out', paths: ['out/constants.py', 'out/gone.py'], rules: [] };
    const partial = await provider.analyze(brokenPlan, twoFiles, model, { isCancellationRequested: false }, () => {});
    assert.deepEqual(packets[0].files.map(file => file.path), ['out/constants.py']);
    assert.deepEqual(partial.unreadable, [{ path: 'out/gone.py', reason: 'File exceeds snapshot read budget' }]);
    // When no file of the component can be read, the component fails as before.
    await assert.rejects(provider.analyze(brokenPlan, { component: 'out', paths: ['out/gone.py'], rules: [] }, model,
      { isCancellationRequested: false }, () => {}), /read budget/);
    console.log('Review file coverage smoke passed');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
