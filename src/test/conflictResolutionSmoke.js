// Suggest resolution for a conflicted file: the model only replaces conflict blocks, code checks each
// side's change token by token, and Apply writes the file only (never stages it or continues), and
// only when the file did not change meanwhile.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const warnings = [];
let answers = [];
const fakeVscode = {
  window: {
    async showWarningMessage(message, options, ...buttons) {
      warnings.push({ message, detail: options && options.detail, buttons: options && typeof options === 'object' ? buttons : [options, ...buttons] });
      return typeof answers[0] === 'function' ? answers.shift()() : answers.shift();
    },
    async withProgress(options, work) { return work({ report() {} }, { isCancellationRequested: false }); },
    showInformationMessage(message) { infos.push(message); }, showErrorMessage(message) { errors.push(message); }
  },
  ProgressLocation: { Notification: 15 }
};
const infos = [];
const errors = [];
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return fakeVscode;
  return originalLoad.call(this, request, parent, isMain);
};
const { handleSuggestConflictResolution, handleApplyHistoryCommit } = require('../../out/handlers/webviewMessageHandler.js');
const { GitCommandService } = require('../../out/services/gitCommandService.js');
const { HistoryActionService } = require('../../out/services/historyActionService.js');
const { checkResolution, conflictBlocks, parseResolutions, readConflictedFile, spliceResolutions } =
  require('../../out/services/conflictResolution.js');
Module._load = originalLoad;

const root = mkdtempSync(path.join(tmpdir(), 'repository-manager-resolve-'));
const env = { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@example.com', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitMayFail = (...args) => { try { git(...args); return true; } catch { return false; } };
const write = (file, text) => writeFileSync(path.join(root, file), text);
const read = file => readFileSync(path.join(root, file), 'utf8');
const commit = (file, text, message) => { write(file, text); git('add', '-A'); git('commit', '-qm', message); return git('rev-parse', 'HEAD'); };

async function main() {
  try {
    // 1. Blocks, splicing and the reply: lines outside the conflicts never change.
    const merged = ['top', '<<<<<<< A', 'a1', '||||||| BASE', 'base1', '=======', 'b1', '>>>>>>> B', 'middle', '<<<<<<< A', 'a2', '=======', 'b2', '>>>>>>> B', 'end'].join('\n');
    const blocks = conflictBlocks(merged);
    assert.deepEqual(blocks.map(block => [block.start, block.end, block.a, block.base, block.b]),
      [[1, 7, ['a1'], ['base1'], ['b1']], [9, 13, ['a2'], [], ['b2']]]);
    assert.equal(spliceResolutions(merged, blocks, [{ lines: ['x', 'y'], note: '' }, { lines: [], note: '' }]), 'top\nx\ny\nmiddle\nend');
    assert.throws(() => spliceResolutions(merged, blocks, [{ lines: [], note: '' }]), /One resolution per conflict/);
    const reply = resolutions => JSON.stringify({ summary: 's', resolutions });
    assert.deepEqual(parseResolutions('Here: ' + reply([{ index: 1, lines: 'b2', note: 'n' }, { index: 0, lines: 'a1\r\nb1' }]), blocks).resolutions,
      [{ lines: ['a1', 'b1'], note: '' }, { lines: ['b2'], note: 'n' }]);
    assert.throws(() => parseResolutions(reply([{ index: 0, lines: 'a1' }]), blocks), /left conflict 2 of 2 unresolved/);
    assert.throws(() => parseResolutions(reply([{ index: 0, lines: 'a1\n=======\nb1' }, { index: 1, lines: '' }]), blocks), /left conflict markers in conflict 1/);
    assert.throws(() => parseResolutions('no json', blocks), /expected form/);

    // 2. The check: each side's added and removed tokens, whatever the layout.
    const fee = [{ start: 0, end: 0, a: ['  return max(a * 0.02, 1.0)'], base: ['  return a * 0.02'], b: ['  return round(a * 0.02, 2)'] }];
    const checked = line => checkResolution(fee, [{ lines: [line], note: '' }]);
    assert.deepEqual(checked('  return max(round(a * 0.02, 2), 1.0)'), { a: { missing: [], restored: [] }, b: { missing: [], restored: [] } });
    assert.deepEqual(checked('  return round(a * 0.02, 2)').a.missing, ['max', '1.0']);
    // Only symbols changed: they are what is reported.
    assert.deepEqual(checkResolution([{ start: 0, end: 0, a: ['x = 1;'], base: ['x = 1'], b: ['x = 2'] }], [{ lines: ['x = 2'], note: '' }]).a.missing, [';']);
    assert.deepEqual(checked('  return max(\n    a * 0.02,\n    1.0)').b.missing, ['round', '2']);
    // A side's removal brought back: A deleted the debug line, the result still has it.
    const removal = [{ start: 0, end: 0, a: ['run()'], base: ['debug()', 'run()'], b: ['debug()', 'run(fast)'] }];
    assert.deepEqual(checkResolution(removal, [{ lines: ['debug()', 'run(fast)'], note: '' }]).a, { missing: [], restored: ['debug'] });
    assert.deepEqual(checkResolution(removal, [{ lines: ['run(fast)'], note: '' }]), { a: { missing: [], restored: [] }, b: { missing: [], restored: [] } });
    // Both sides adding the same thing need it once.
    const same = [{ start: 0, end: 0, a: ['import os', 'x = 1'], base: [], b: ['import os', 'y = 2'] }];
    assert.deepEqual(checkResolution(same, [{ lines: ['import os', 'x = 1', 'y = 2'], note: '' }]), { a: { missing: [], restored: [] }, b: { missing: [], restored: [] } });

    // 3. A real conflict: a cherry-pick stops on fee.py; its sides are named, its markers relabelled.
    git('init', '-q', '-b', 'main');
    commit('fee.py', 'def fee(a):\n    return a * 0.02\n\n\ndef other():\n    return 1\n', 'base');
    commit('gone.txt', 'keep\n', 'add gone.txt');
    git('checkout', '-qb', 'feature');
    const pick = commit('fee.py', 'def fee(a):\n    return round(a * 0.02, 2)\n\n\ndef other():\n    return 1\n', 'round the fee');
    write('gone.txt', 'changed on feature\n');
    git('commit', '-qam', 'edit gone.txt');
    const editGone = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    commit('fee.py', 'def fee(a):\n    return max(a * 0.02, 1.0)\n\n\ndef other():\n    return 1\n', 'minimum fee');
    git('rm', '-q', 'gone.txt');
    git('commit', '-qm', 'remove gone.txt');
    const service = new GitCommandService(root);
    await assert.rejects(readConflictedFile(service, '.', 'fee.py'), /not in conflict/);
    assert.equal(gitMayFail('cherry-pick', pick), false);
    const file = await readConflictedFile(service, '.', 'fee.py');
    assert.equal(file.operation, 'cherry-pick');
    assert.deepEqual(file.sides, { a: 'main as it is now', b: `commit ${pick.slice(0, 7)} "round the fee", being picked` });
    assert.equal(file.blocks.length, 1);
    assert.match(file.merged, /^def fee\(a\):\n<<<<<<< A\n {4}return max\(a \* 0\.02, 1\.0\)\n\|\|\|\|\|\|\| BASE\n {4}return a \* 0\.02\n=======\n {4}return round\(a \* 0\.02, 2\)\n>>>>>>> B\n/);
    assert.equal(file.current, read('fee.py'));
    git('cherry-pick', '--abort');
    assert.equal(gitMayFail('cherry-pick', editGone), false);
    await assert.rejects(readConflictedFile(service, '.', 'gone.txt'), /One side deleted gone\.txt and the other changed it/);
    git('cherry-pick', '--abort');

    // 4. The handler: the diff is shown, the check is in the question, and Apply writes the file only.
    const sent = [];
    let modelReply = reply([{ index: 0, lines: '    return max(round(a * 0.02, 2), 1.0)', note: 'Kept the minimum and the rounding.' }]);
    let consent;
    let remembered = false;
    const copilot = {
      ask: async (message, detail, actions) => { warnings.push({ message, detail, buttons: actions }); return consent; },
      alwaysConfirm: () => false, isConsentRemembered: () => remembered, rememberConsent: async () => { remembered = true; },
      complete: async (prompt) => { sent.push(prompt); return { text: modelReply, model: 'Scripted' }; },
      language: () => 'vi'
    };
    const shown = [];
    let refreshed = 0;
    const actions = new HistoryActionService(service);
    const ctx = { workspaceRoot: root, conflictExplainer: copilot, async refresh() { refreshed++; }, async reloadDashboardHistory() {},
      showProposedFile: async (filePath, current, proposed) => { shown.push({ filePath, current, proposed }); },
      gitOps: { describeHistoryCommit: (...args) => actions.describe(...args), applyHistoryCommit: (...args) => actions.apply(...args),
        abortHistoryAction: (...args) => actions.abort(...args) } };
    assert.equal(gitMayFail('cherry-pick', pick), false);
    const conflicted = read('fee.py');
    // Declining the question sends nothing.
    consent = undefined;
    assert.equal(await handleSuggestConflictResolution(ctx, { repositoryPath: '.', path: 'fee.py' }), false);
    assert.equal(sent.length, 0);
    consent = 'Always allow for this repository';
    answers = ['Apply suggestion'];
    warnings.length = 0;
    assert.equal(await handleSuggestConflictResolution(ctx, { repositoryPath: '.', path: 'fee.py' }), true);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /"language":"vi"/);
    assert.doesNotMatch(sent[0].slice(sent[0].indexOf('{')), /ours|theirs/);
    assert.deepEqual([shown[0].filePath, shown[0].current], ['fee.py', conflicted]);
    assert.equal(shown[0].proposed, 'def fee(a):\n    return max(round(a * 0.02, 2), 1.0)\n\n\ndef other():\n    return 1\n');
    const question = warnings.find(item => item.message === 'Apply the suggested resolution to fee.py?');
    assert.deepEqual(question.buttons, ['Apply suggestion']);
    assert.match(question.detail, /^Suggested by Scripted: s\n/);
    assert.match(question.detail, /A = main as it is now\n {2}✓ its change is in the result\.\nB = commit [0-9a-f]{7} "round the fee", being picked\n {2}✓ its change is in the result\./);
    assert.match(question.detail, /cannot tell whether both changes are combined correctly/);
    assert.match(question.detail, /It is not staged, and the operation does not continue/);
    assert.equal(read('fee.py'), shown[0].proposed);
    assert.match(infos.at(-1), /^Wrote the suggested resolution to fee\.py\. It is not staged/);
    // Still in conflict, and still cherry-picking: staging and continuing stay with the user.
    assert.equal(git('diff', '--name-only', '--diff-filter=U'), 'fee.py');
    assert.equal(await actions.pendingOperation('.'), 'cherry-pick');
    assert.equal(refreshed, 1);

    // A suggestion that drops one side says which, and declining writes nothing.
    git('checkout', '--conflict=diff3', '--', 'fee.py');
    const before = read('fee.py');
    modelReply = reply([{ index: 0, lines: '    return round(a * 0.02, 2)' }]);
    answers = [undefined];
    warnings.length = 0;
    await handleSuggestConflictResolution(ctx, { repositoryPath: '.', path: 'fee.py' });
    assert.match(warnings.at(-1).detail, /A = main as it is now\n {2}⚠ its added `max`, `1\.0` are not in the result: its change may be lost\./);
    assert.equal(read('fee.py'), before);
    // The file edited while the suggestion was open: not written over.
    answers = [() => { write('fee.py', before + '# my own edit\n'); return 'Apply suggestion'; }];
    await handleSuggestConflictResolution(ctx, { repositoryPath: '.', path: 'fee.py' });
    assert.match(errors.at(-1), /fee\.py changed while the suggestion was open, so it was not written/);
    assert.equal(read('fee.py'), before + '# my own edit\n');
    // A CRLF working file keeps CRLF.
    write('fee.py', before.replace(/\n/g, '\r\n'));
    modelReply = reply([{ index: 0, lines: '    return max(round(a * 0.02, 2), 1.0)' }]);
    answers = ['Apply suggestion'];
    await handleSuggestConflictResolution(ctx, { repositoryPath: '.', path: 'fee.py' });
    assert.equal(read('fee.py'), 'def fee(a):\r\n    return max(round(a * 0.02, 2), 1.0)\r\n\r\n\r\ndef other():\r\n    return 1\r\n');
    git('cherry-pick', '--abort');

    // 5. From the message when a cherry-pick stops: Suggest resolution goes through the conflicted files.
    warnings.length = 0;
    shown.length = 0;
    answers = ['Cherry pick', 'Suggest resolution', undefined];
    await handleApplyHistoryCommit(ctx, { repositoryPath: '.', commit: pick, operation: 'cherry-pick' });
    assert.deepEqual(warnings[1].buttons, ['Suggest resolution', 'Abort operation']);
    assert.deepEqual(shown.map(item => item.filePath), ['fee.py']);
    assert.equal(await actions.pendingOperation('.'), 'cherry-pick', 'declining the suggestion aborted or continued');
    git('cherry-pick', '--abort');
    // Without Copilot, the stop message offers only what it did before.
    warnings.length = 0;
    answers = ['Cherry pick', undefined];
    await handleApplyHistoryCommit({ ...ctx, conflictExplainer: undefined }, { repositoryPath: '.', commit: pick, operation: 'cherry-pick' });
    assert.deepEqual(warnings[1].buttons, ['Abort operation']);
    git('cherry-pick', '--abort');
    console.log('Conflict resolution smoke passed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
