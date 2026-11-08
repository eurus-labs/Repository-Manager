# Review

The security and compliance review of a branch, a commit, a comparison or local changes: a pinned
snapshot, review skills, findings with triage, Fix with Copilot, and saved history.

## Sub-features
- start: Review changes / Review branch / Review commit; consent before sending to the model.
- engine: snapshot, survey (file coverage, size limits), skills, analysis, verification of findings.
- triage: Needs fix, accepted, false positive; carried to later reviews of the same code.
- fix: Fix with Copilot proposes edits to cited files; Apply re-checks each file first.
- history: reviews saved per folder and repository; export a report.

## How to get to it (user POV)
- Dashboard → Review changes (working tree) or ⋯ → Review branch; the Repository Review tab.

## Driving it
- Node: `reviewControllerSmoke.js`, `reviewFixSmoke.js`, `reviewSnapshotSmoke.js`, `securityReviewSmoke.js`,
  `securityReviewFindingsSmoke.js`, `reviewSkillsSmoke.js`, `reviewFileCoverageSmoke.js`, `reviewRetrySmoke.js`,
  `reviewResumeSmoke.js`, `reviewHistorySmoke.js`, `reviewReportSmoke.js`, `reviewTriageCarrySmoke.js`, `reviewConsentSmoke.js`.
- Chromium: `src/test/uiSnapshots.js` (Repository Review tab); screenshots `ui-snapshots/10*`.

## Expected behavior
- Declining or dismissing consent sends nothing to the model. [confirmed: test src/test/reviewControllerSmoke.js]
- A completed review is saved; a restart reopens it with its triage; export works. [confirmed: test src/test/reviewControllerSmoke.js]
- A fix proposal applies only edits that match exactly once, in cited files; Apply re-checks the file, writes it, and never stages or commits. [confirmed: test src/test/reviewFixSmoke.js]
- A non-UTF-8 file is refused rather than re-encoded; a BOM survives. [confirmed: test src/test/reviewFixSmoke.js]
- Files over 1 MB are skipped as "larger than 1 MB (not read)" instead of failing the review. [confirmed: test src/test/reviewFileCoverageSmoke.js]
- Each skill or size change has a selection test. [confirmed: spec AGENTS.md]

## Suspected bugs
- None found.

## Open questions
- None.

## Gotchas
- Live model paths are scripted in tests; a review with Copilot is only verified in VS Code.
