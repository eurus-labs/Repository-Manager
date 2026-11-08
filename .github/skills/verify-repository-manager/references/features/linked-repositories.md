# Linked repositories

The parent repository and its linked repositories (submodules): the list, the recorded commits, and
Align, fetch, pull and push across them.

## Sub-features
- repository-list: parent and linked repositories, branch, drift and recorded markers, change badges.
- align: check out the commits the parent records (Sync/Align), from the dashboard or the Command Palette.
- remote: fetch (and background fetch), pull, push.

## How to get to it (user POV)
- Side Bar → Repositories; the Align icon in its title; dashboard Fetch / Pull / Push.
- Command Palette → Repository Manager: Align Linked Repositories with Recorded Commits.

## Driving it
- Node: `syncRecordedHandlerSmoke.js`, `pullChangesSmoke.js`, `backgroundFetchSmoke.js`, `autoFetchPanelSmoke.js`,
  `repositoryListSmoke.js` — `$V capture <label> -- node src/test/<name>`.
- Chromium: `src/test/uiSnapshots.js` (Side Bar, repository buttons); screenshots `ui-snapshots/01*`.

## Expected behavior
- Dismissing the Sync modal leaves the repository untouched; if the parent records a different commit meanwhile, nothing is reset. [confirmed: test src/test/syncRecordedHandlerSmoke.js]
- Sync checks out an already-fetched recorded commit without network access and reloads the moved repositories' history. [confirmed: test src/test/syncRecordedHandlerSmoke.js]
- Each Align run is recorded once in the usage log, from the dashboard or the Command Palette. [confirmed: test src/test/commitHandlerSmoke.js]

## Suspected bugs
- None found.

## Open questions
- None.

## Gotchas
- Tests build parent and linked repositories with `git submodule add` from local paths; they need `protocol.file.allow=always`, which the tests set themselves.
