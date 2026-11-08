# Changes and commit

The working tree's uncommitted changes: listed in the Side Bar's Changes, shown in the dashboard,
committed from the commit dialog, discarded or stashed.

## Sub-features
- side-bar-changes: one row per changed file; click shows its diff in the dashboard; double-click opens an editor tab; Ctrl/Shift+click selects.
- dashboard-diff: the diff of the file picked in the Side Bar, Staged and Unstaged sides, full width; right-click for the file's menu.
- commit-dialog: lists the files to commit (only the selected ones when Changes has a selection), filter, partly staged choice, Push after commit.
- write-with-copilot: Copilot drafts the message for the files the dialog will commit, following the repository's commit convention.
- discard: per file (↶), for the selection, or all; asks first; keeps a copy; undo.
- stash: the selected files only, with an optional message; Apply, Pop, Drop from the dashboard.

## How to get to it (user POV)
- Activity Bar → Repository Manager → Side Bar **Changes** → click a file (diff in the dashboard).
- Changes title bar commit icon, or the dashboard's **Commit…** → the commit dialog.
- Select files (checkbox) → selection bar **Discard…** or **Stash…**.

## Driving it
- Node, real Git repositories: `$V capture commit-handler -- node src/test/commitHandlerSmoke.js`,
  `commitMessageSmoke.js`, `discardSmoke.js`, `stashSmoke.js`, `stashActionSmoke.js`, `liveChangesSmoke.js`,
  `changeDocumentsSmoke.js` (each `node src/test/<name>` after `$V doctor`).
- Real webviews in Chromium: `$V capture ui -- npm run test:ui`; the commit dialog, Side Bar selection,
  diff-in-dashboard and context-menu flows are in `src/test/uiSnapshots.js`; screenshots `ui-snapshots/01*`, `07*`.
- Live (a person, in VS Code): install the VSIX from `$V check package`, open a repository with edits.

## Expected behavior
- With files selected in Changes, the commit dialog lists only those; **Show all files** lists the rest without re-ticking files the person unticked. [confirmed: user, 2026-11-05]
- Write with Copilot sends only the files the dialog would commit. [confirmed: user, 2026-11-05]
- Clicking a file in the Side Bar's Changes shows its diff in the dashboard at full width; it does not open a side-by-side editor tab; double-click does. [confirmed: user, 2026-11-06]
- With more changed files than the Side Bar lists (500), the dashboard shows its Changed files column again. [confirmed: test src/test/uiSnapshots.js]
- Right-clicking the dashboard diff gives that file's menu (Suggest Resolution for a conflict, Open Changes, Review, Discard). [confirmed: test src/test/uiSnapshots.js]
- Push after commit pushes only once the commit exists; a failed push keeps the commit and says only the push failed. [confirmed: test src/test/commitHandlerSmoke.js]
- Discard keeps a copy first; undo restores against the discard's original HEAD, including renames, index-only edits and recreated files. [confirmed: test src/test/discardSmoke.js]
- Stash of a selection stashes just those files, new files included, and leaves the other changes. [confirmed: spec CHANGELOG.md 2.19.0]
- Pop of a `-u` stash restores tracked edits and the new file; a conflicting Pop keeps the stash. [confirmed: test src/test/stashActionSmoke.js]
- Drop asks first; cancelling changes nothing. [confirmed: test src/test/stashActionSmoke.js]
- Git arguments are passed with execFile, never through a shell; paths stay repository-relative. [confirmed: spec docs/dashboard-backend.md]

## Suspected bugs
- None found.

## Open questions
- The usage log times a commit from the dialog's opening, so a dialog reopened later restarts the clock while a Copilot draft kept from before still counts as Copilot's (`resources/webview.js`, `commitOpenedAt`). Is the time to measure the last opening, or the first?

## Gotchas
- The Side Bar is a mirror of hidden dashboard markup: a click in the Side Bar is replayed on the dashboard (`runSidebarAction`), so tests click `side` and assert on `page`.
- `ui-snapshots/` is rewritten by every UI run and is ignored by Git.
