# Plan 1 — Move the dashboard History state out of webview.js

Status: draft
Date: 2026-11-17
Branch: `refactor/dashboard-history-state`
Baseline: `main` at `f5c24bbe131c87b476844983e99cde42edd27762`
Target: `resources/webview.js`, new `resources/dashboardHistory.js`, `src/webview/dashboardScripts.ts`, tests

## Goal

The dashboard History's loading state has one owner, a new script `resources/dashboardHistory.js`, as
Uncommitted changes (#173) and the Commit dialog (#174) already have. `webview.js` keeps the rendering, the
graph, the layout and the message routing, and calls the module. Nothing changes for the person using the
dashboard. This is roadmap item 4 in `docs/agent-studio.md` ("Plan from 2026-11-15"), next feature after the
Commit dialog.

## Decisions

1. **Move the state and its pure logic only**: which commits are loaded, the upstream, the request id, the
   next offset, whether a Load more page is on its way, the viewport to restore for a request, and the
   per-repository filters — rejected: moving `renderHistoryPage` and the graph drawing too, because they
   read and write the comparison, the uncommitted row, the column layout and the graph geometry, which have
   no owner yet; one PR would mix four features.
2. **Follow the shape of `resources/dashboardWorkingTree.js`**: a UMD script publishing
   `RepositoryDashboardHistory = Object.freeze({ createHistoryState })`, a factory with no module-level state,
   loaded through `DASHBOARD_SCRIPTS` before `webview.js` — rejected: a singleton object, because two
   instances must not share state and the module test needs fresh ones.
3. **Keep the saved-state key `dashboardHistoryState` and its shape** (`{ [repositoryPath]: { branch,
   includeRemotes, search } }`): the module takes the restored value and returns it for `saveState` —
   rejected: a new key or shape, because it would drop every person's saved filters on update.
4. **Leave out** `repositoryRefs` (branches, tags, remotes, stashes: the Branches feature),
   `pendingBranchCheckout`, `historySearchTimer` (a DOM debounce), the column widths, panel height and graph
   geometry (`historyColumnWidths`, `historyColumnMinimums`, `historyGraphWidth`, `loadedHistoryGraphModel`,
   `historyGraphGeometry*`), `historyDrawnReported` and `activeHeadSignature` — rejected: moving them now,
   because each belongs to another feature or to rendering (Decision 1).
5. **Tests at both levels, and one slow-host run.** A module smoke test, plus a page-level check in
   `src/test/uiSnapshots.js` that a `historyLoaded` reply for an older request or another repository does
   not replace the rows, run once with the host's `getHistory` reply delayed — rejected: module tests only
   (in #174 breaking a rule failed no page test) and a single timing (in #175 a page test passed locally and
   failed on CI because a real reply landed a few milliseconds after the injected one).

## Scope

In:

- New `resources/dashboardHistory.js` with `createHistoryState({ savedFilters })` owning, from
  `resources/webview.js`: `loadedHistoryCommits`, `loadedHistoryUpstream`, `historyRequestId`,
  `historyNextOffset`, `historyAppendPending`, `pendingHistoryViewport`, `dashboardHistoryState`.
- The logic around them that needs no DOM:
  - starting a load: a fresh load gets a new request id and supersedes a page on its way; an append keeps
    the id;
  - accepting a page: wrong repository or older id is ignored; offset 0 replaces the commits and the
    upstream; an append adds only commits not already loaded and returns them; next offset; pending cleared;
  - a failed append clears the pending flag;
  - whether Load more may start (`historyNextOffset !== null && !historyAppendPending`);
  - finding a loaded commit by hash and the first commit;
  - the viewport kept for a request and handed back only for the same request and repository;
  - filters per repository through `normalizeHistoryFilters` (from `historyGraph.js`, passed in or read
    from the global), set the revision, set the filters read from the page, clear all
    (`workspaceFolderChanged`), and the snapshot for `saveState`;
  - reset on a repository switch (commits and next offset; filters stay per repository).
- `resources/webview.js` calls the module; none of the moved names is declared there afterwards. Thin
  wrappers are allowed; the coder lists them.
- `src/webview/dashboardScripts.ts`: add `dashboardHistory.js` after `dashboardCommitDialog.js`, before
  `webview.js`.
- Tests: new `src/test/dashboardHistorySmoke.js` (added to the `test` script in `package.json` after
  `dashboardCommitDialogSmoke.js`); `src/test/dashboardScriptsSmoke.js` asserts the new script loads before
  `webview.js`; the page-level check of Decision 5 in `src/test/uiSnapshots.js`.
- `docs/dashboard-backend.md`: the History row of "Module and state ownership" and the "Next extractions"
  note. `docs/agent-studio.md` roadmap item 4: what moved.

Out:

- `renderHistoryPage`, the graph, the column layout, Load more's DOM, the search debounce.
- Branches and refs (`repositoryRefs`), commit detail and comparison, history actions and rewrites.
- Host handlers (`src/handlers/**`, `src/services/historyService.ts`).
- Any behavior, text or style change; no CHANGELOG entry (nothing user-visible).
- The fixed sleeps already in the History part of `uiSnapshots.js` (around lines 2040–2160): leave them,
  but do not add new ones.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `resources/webview.js` lines ~18–38 (declarations), `getDashboardFilters` / `setHistoryRevision` / `captureDashboardFilters` (~1797–1819), `activateDashboardRepository` reset (~1852–1853), `requestDashboardHistory` (~1910–1934), `loadHistoryNearEnd` (~2076), `renderHistoryPage` accept and append part (~2080–2098, ~2134–2143), append failure (~2658–2659), `workspaceFolderChanged` (~3029–3037), `saveState` (~509), uses of `loadedHistoryCommits` (~353, 2061, 2067, 2154, 2338, 2382) | Change: call the module; re-grep the names before finishing |
| `resources/dashboardWorkingTree.js`, `src/test/dashboardWorkingTreeSmoke.js` | Keep: the pattern to copy |
| `resources/historyGraph.js` `normalizeHistoryFilters` | Keep: used by the module |
| `src/webview/dashboardScripts.ts`, `src/test/dashboardScripts.js` (`loadDashboard`) | Change the list; keep the helper |
| `src/test/summaryWebviewSmoke.js` (~133, sends a `historyLoaded`) | Keep passing unchanged |
| `src/test/uiSnapshots.js` History part (~2040–2320: Load more, stale dimming on repository switch) | Keep passing; add the Decision 5 check |

## Tech stack and constraints

Default (`AGENTS.md`): webview scripts are plain browser JavaScript with no build step and no dependency;
commits as the human author with the no-reply address, no AI trailers; checks below.

## Acceptance criteria

- [ ] None of the moved names is declared in `webview.js` — checked by `grep -nE "^\s*(let|const) (loadedHistoryCommits|loadedHistoryUpstream|historyRequestId|historyNextOffset|historyAppendPending|pendingHistoryViewport|dashboardHistoryState)\b" resources/webview.js` printing nothing.
- [ ] The module behaves as the old code: `node src/test/dashboardHistorySmoke.js` prints `dashboardHistorySmoke ok`, covering: an older request id and another repository are ignored; offset 0 replaces commits and upstream; an append adds only new hashes and returns them; a fresh load supersedes a pending append; a failed append clears pending; Load more is refused while pending or at the end; the viewport comes back only for its request and repository; filters per repository, unknown values normalized, cleared by clear-all, kept across a reset; two instances share nothing.
- [ ] Failure case, module: with the request-id check removed from the module, `node src/test/dashboardHistorySmoke.js` fails (report the assertion message), and passes again when restored.
- [ ] Failure case, page: with the same check removed, `npm run test:ui` fails at the new Decision 5 check in `uiSnapshots.js` (report the message), and passes when restored.
- [ ] Slow host: with the host's `getHistory` reply delayed by 40 ms and by 300 ms (a temporary change in the harness, not committed), `npm run test:ui` passes both times.
- [ ] Saved filters survive: a saved `dashboardHistoryState` from before the change is restored (covered in the module test with a literal of the old shape).
- [ ] The repository's required checks pass — checked by `npm ci`, `npm run lint` (0 errors; the 2 known warnings in `src/studio/studioCommands.ts`), `npm test`, `PLAYWRIGHT_CHROMIUM_PATH=<chromium> npm run test:ui` twice, `npm run package` with `unzip -l` listing `extension/resources/dashboardHistory.js`.
- [ ] History screenshots (`01-*`, `03*`, the Load more and repository switch shots) are byte-identical to `main` or differ only where two `main` runs also differ; the report names any other difference.

## Risks

| Risk | How it is handled |
| --- | --- |
| A use of a moved name is missed (about 50 references) | Acceptance grep; the coder re-greps every name before finishing |
| Order of steps changes in `renderHistoryPage` (pending cleared before or after the accept check) | The module keeps the old order; the smoke test covers a page for an older id arriving while an append is pending |
| Saved filters lost on update | Decision 3; module test with the old shape |
| A page test that passes only at one timing | Decision 5 slow-host runs; no new fixed sleeps |
| `normalizeHistoryFilters` read from the global before `historyGraph.js` loads | `historyGraph.js` is first in `DASHBOARD_SCRIPTS`; the module reads it when called, not at load |

## Open questions

None.
