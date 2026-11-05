const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { UsageLog, editRatio, median, usageReport, MIN_SAMPLES, IDLE_LIMIT_MS } = require('../../out/services/usageLog.js');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-manager-usage-'));
try {
  // Recording: one JSON line per action; damaged lines are skipped; off records nothing.
  const file = path.join(base, 'nested', 'usage.jsonl');
  const log = new UsageLog(file);
  log.record({ kind: 'align', repositories: 3, failed: 0, durationMs: 900 }, new Date('2026-11-01T10:00:00Z'));
  fs.appendFileSync(file, '{not json\n{"kind":"other","at":"x"}\n');
  log.record({ kind: 'reviewFix', files: 2, findings: 1 }, new Date('2026-11-02T10:00:00Z'));
  assert.deepEqual(log.read().map(entry => entry.kind), ['align', 'reviewFix']);
  let enabled = false;
  const off = new UsageLog(path.join(base, 'off.jsonl'), () => enabled);
  off.record({ kind: 'reviewFix', files: 1, findings: 1 });
  assert.equal(fs.existsSync(off.file), false, 'recorded while turned off');
  enabled = true;
  off.record({ kind: 'reviewFix', files: 1, findings: 1 });
  assert.equal(off.read().length, 1);
  // A log that cannot be written never throws into the action.
  const blocked = new UsageLog(path.join(file, 'under-a-file.jsonl'));
  assert.doesNotThrow(() => blocked.record({ kind: 'reviewFix', files: 1, findings: 1 }));
  // Over its size the log keeps its newer half.
  const small = new UsageLog(path.join(base, 'small.jsonl'), () => true, 2000);
  for (let i = 0; i < 60; i++) small.record({ kind: 'align', repositories: i, failed: 0, durationMs: 1 });
  const kept = small.read();
  assert.ok(fs.statSync(small.file).size <= 2000 + 200 && kept.length < 60 && kept.at(-1).repositories === 59, 'trimmed the wrong end');
  log.clear();
  assert.deepEqual(log.read(), []);

  // Edit ratio and median.
  assert.equal(editRatio('fix: a', 'fix: a'), 0);
  assert.equal(editRatio('abcd', 'wxyz'), 1);
  assert.equal(editRatio('feat: add x', 'feat: add y'), 1 / 11);
  assert.equal(editRatio('', ''), 0);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), undefined);

  // The report: nothing yet; then a comparison held back until each side has enough commits.
  assert.match(usageReport([]), /Nothing recorded yet/);
  const at = '2026-11-03T09:00:00Z';
  const commit = (copilot, durationMs, files = 1, ratio) => ({ at, kind: 'commit', copilot, durationMs, files, editRatio: ratio });
  const few = [commit(true, 30000, 1, 0), commit(false, 90000), { at, kind: 'align', repositories: 4, failed: 1, durationMs: 2000 }];
  let report = usageReport(few, '/tmp/usage.jsonl');
  assert.match(report, /still collecting \(20 of each needed\): with Copilot 30s \(n=1\) · typed 1\.5 min \(n=1\)/);
  assert.match(report, /Copilot messages kept.*100% of 1/);
  assert.match(report, /\*\*Align:\*\* 1 run, 4 repositories in all, median 4 per run, 2s each/);
  assert.match(report, /1 Align run had failures/);
  assert.match(report, /no paths, messages or code/);
  const many = [];
  for (let i = 0; i < MIN_SAMPLES; i++) {
    many.push(commit(true, 40000, 3, 0.5), commit(false, 95000, 3));
  }
  many.push(commit(true, IDLE_LIMIT_MS + 1)); // left open: counted, not timed
  report = usageReport(many);
  assert.match(report, /\*\*Time to commit:\*\* with Copilot 40s \(n=20\) · typed 1\.6 min \(n=20\)\./);
  assert.match(report, /\| 2–5 files \| 40s \(n=20\) \| 1\.6 min \(n=20\) \| yes \|/);
  assert.match(report, /\| 1 file \| — \(n=0\) \| — \(n=0\) \| not yet \|/);
  assert.match(report, /\| 2–5 files \| 50% \| 0% \| 20 \|/);
  assert.match(report, /- 1 commit with the dialog open longer than 10 minutes/);
  console.log('usage log smoke passed');
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
