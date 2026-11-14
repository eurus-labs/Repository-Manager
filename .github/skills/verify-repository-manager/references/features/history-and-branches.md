# History and branches

The commit graph and history list, commit detail and comparisons, branches and tags, and the
history actions (cherry-pick, revert, reset, rebase) with conflict prediction, AI help and undo.

## Sub-features
- history: graph, search, filters, load more, upstream.
- commit-detail: changed files and diffs of a commit or of a comparison between two commits.
- branches: create (from HEAD or a commit), check out, delete local (and origin when it exists).
- history-actions: predicted conflicts before running; explanation; suggested resolution of a conflicted file.
- undo: undo in plain language, limited to existing actions.
- change-summary: Copilot summary of a commit, comparison or the working tree.

## How to get to it (user POV)
- Dashboard → history; click a commit; Ctrl+click a second commit to compare.
- Side Bar → Branches → right-click a local branch → Delete Branch….
- Right-click a commit → Cherry-pick / Revert / Reset…; dashboard ⋯ → Undo….

## Driving it
- Node: `historyActionHandlerSmoke.js`, `historyRewriteHandlerSmoke.js`, `conflictPredictionSmoke.js`,
  `conflictExplanationSmoke.js`, `conflictResolutionSmoke.js`, `naturalUndoSmoke.js`, `historySearchSmoke.js`,
  `historyUpstreamSmoke.js`, `branchDeleteHandlerSmoke.js`, `pushCreatedBranchesSmoke.js`, `summaryProviderSmoke.js`,
  `summaryWebviewSmoke.js` — `$V capture <label> -- node src/test/<name>`.
- Chromium: `src/test/uiSnapshots.js` (history, comparison, context menus); screenshots `ui-snapshots/02*`–`06*`.

## Expected behavior
- Deleting a branch asks in one modal VS Code dialog; with a remote branch it offers local only or local and origin; dismissing deletes nothing. [confirmed: test src/test/branchDeleteHandlerSmoke.js]
- Whether origin has the branch comes from Git, not from the page. [confirmed: test src/test/branchDeleteHandlerSmoke.js]
- Undo in plain language only picks an existing action with a commit or files the model was given; a made-up commit runs nothing; declining sends or runs nothing. [confirmed: test src/test/naturalUndoSmoke.js]
- A revert is committed with the user's own identity. [confirmed: test src/test/naturalUndoSmoke.js]
- Conflicts are predicted before a history action runs, and explaining them asks before sending. [confirmed: spec docs/history-actions-ai.md]
- Revisions are verified with `git rev-parse --verify <rev>^{commit}`; history commands time out at 15 s; patches over 1 MiB are truncated and marked. [confirmed: spec docs/dashboard-backend.md]

## Suspected bugs
- None found.

## Open questions
- docs/history-actions-ai.md asks whether to record predictions against outcomes; undecided.

## Gotchas
- Graph lanes depend on commit order; compare screenshots, not only text, after graph changes.
