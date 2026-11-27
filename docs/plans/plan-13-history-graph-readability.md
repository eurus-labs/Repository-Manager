# Plan 13 — A git graph that is easier to read

Status: implemented
Date: 2026-11-22
Branch: `feat/history-graph-readability`
Baseline: `main` at `1c8ecc4fdac80b5ce8887fc4c123fd39e32461ac` (3.10.0). Revised 2026-11-27 on top of plans 16 and 18,
both merged. Line numbers below were taken at `4fe5d23` and have moved; find the code by the function names given.
Target: `resources/historyGraph.js`, `resources/webview.js` (graph rendering and history menu), `resources/dashboardHistory.js` (saved filters), `resources/webview.css`, `src/services/historyService.ts`, `src/webview/template.ts`, tests, `CHANGELOG.md`, `package.json`

## Goal

The user asked on 2026-11-22 for a stronger git graph, starting with readability. Today:

- **Colours shift.** Lanes take their colour in the order their branches appear on the loaded page
  (`nextColor++`, `resources/historyGraph.js:76`), from 8 tones (`resources/webview.js:1992`). A branch's colour
  therefore changes when Load more, a refresh or a filter changes what is above it.
- **No legend.** Nothing ties a colour to a branch name.
- **No branch highlight.** There is no way to see one branch's line among many.
- **No main-line view.** There is no way to see only the main line with merges as single commits.

After this change:

- a branch keeps its colour across pages and refreshes;
- branch labels carry their colour;
- pointing at or focusing a commit or a label highlights that branch's whole line;
- a **First-parent only** option shows the current line with each merge as one commit.

## Decisions

1. **Stable colours by branch name.**
   - A lane that starts at a commit with a branch label takes the tone of a hash of the first such label's name,
     mod 8. Local branches come before remote ones, and `origin/x` and `x` share a tone.
   - HEAD's chain keeps tone 0, as today.
   - **Merged labels (plan 16).** A label that plan 16 folds (`x` with an `origin` chip) takes `x`'s tone. A separate
     `origin/x` label at another commit takes the same tone as `x`. `origin/HEAD` is a pointer, not a branch: it gets
     no tone and stays neutral.
   - A lane with no label (an unnamed merge line) takes the next tone not used by a neighbouring lane.
   - Rejected: keeping order-based colours. They are the reason colours change.
   - Rejected: a colour per lane index, which is also unstable.
2. **The legend is the labels.** Each branch label in the history gets a small dot in its lane's tone, before its
   name. Nothing is added beside the graph. The `origin` chip of a merged label keeps its own colour
   (`--ref-origin`), after the name. Tags get no dot.
   - Rejected: a separate legend panel, which takes width the table needs.
3. **Highlight a branch's line.**
   - Hovering or focusing a commit row, its node, or one of its branch labels marks that lane's segment: from the
     row where the lane starts down to where it merges or ends, within the loaded rows. The class
     `graph-lane-active` goes on its paths, and other lanes are dimmed with `graph-dim`. Leaving clears it.
   - The model gains a per-row `segment` id, so the page finds the segment without walking the graph again.
   - Keyboard focus does the same, so the highlight is not mouse-only.
   - Rejected: highlighting all ancestors, which on a merge-heavy history lights up nearly everything.
4. **First-parent only.**
   - A new item in the history's ⋯ menu, beside **Include remote branches**: **First-parent only**, a
     `menuitemcheckbox`.
   - When on, `historyService.getHistory` adds `--first-parent` and the graph shows one column.
   - **It shows one line, not every ref's first-parent chain.** With **Include remote branches** on, `--all
     --first-parent` still lists every branch tip, and the lines are not one column. Added after implementation
     review, 2026-11-27.
     - While First-parent only is on, the log starts from the selected revision (the branch filter), or from HEAD
       when none is selected. It never uses `--all`.
     - **Include remote branches** stays checked as saved, but it is disabled (`aria-disabled="true"`) with the
       title "Not used while First-parent only is on".
   - **Merge badges.** A merge commit shows a "merge" badge with the number of commits it brought in, from
     `git rev-list --count <merge>^1..<merge>^2`.
     - Counts are read for at most 50 merges per page.
     - **At most 4 count processes run at a time.** 50 Git processes at once is what plan 18 measured as the cost on
       Windows.
   - It is saved per repository with the other filters, as a new optional field `firstParent` in the existing
     `dashboardHistoryState` shape (plan 1 kept the shape; older saved states read as off).
   - This replaces "collapse merged branches". Folding one merge at a time is out of scope.
5. **Unchanged:** HEAD and upstream placement (`findUpstreamTip`), compare selection, and the context menu.
6. **Version: 3.11.0.** Plan 14 is built at the same time and also targets 3.11.0. Whichever merges second keeps
   both entries under one `## [3.11.0]` heading and does not bump again. CHANGELOG `### Added` for First-parent
   only, and `### Changed` for stable colours and the highlight.
7. **Plan 18's reloads keep the view.** A branch update that fast-forwards, or moves `origin/<branch>`, reloads the
   history. The tones then stay the same, because they come from names, not from order. A highlight under the
   pointer is redrawn on the next hover; nothing else is kept.

## Scope

In:

- `resources/historyGraph.js`: tone by branch name, `segment` ids, and the first-parent model when one column.
- `resources/webview.js` (`renderHistoryGraph`, `renderHistoryRefs`, and the history menu):
  label tones, the hover and focus highlight, and the menu item.
- `resources/dashboardHistory.js`: the `firstParent` filter.
- `src/services/historyService.ts`: `--first-parent`, and merge counts.
- `src/webview/template.ts`: the menu item.
- `resources/webview.css`: label tones, `graph-lane-active`, `graph-dim`, and the merge badge.
- Tests, `CHANGELOG.md`, `package.json`.

Out:

- Folding a single merge.
- Graph actions (plan 14).
- Virtual scrolling.
- Changing the page size or load-more behaviour.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `resources/historyGraph.js:47` `buildGraphModel` (colours at `:59–76`), `findUpstreamTip` | Change: tone by name, segments; keep the HEAD and upstream rules |
| `resources/webview.js:1980` `renderHistoryGraph`, `:1992` `tone` (8 tones) | Change |
| `resources/webview.js:1595` `renderHistoryRefs` | Change: tone dot |
| `resources/dashboardHistory.js` filters (`dashboardHistoryState`) | Change: optional `firstParent` |
| `src/services/historyService.ts:90–126` `getHistory` | Change |
| `src/webview/template.ts:536` Include remote branches item | Keep; add First-parent only beside it |
| `src/test/dashboardHistorySmoke.js`, `src/test/uiSnapshots.js` | Change: add cases |

## Tech stack and constraints

Default (`AGENTS.md`); the graph scripts stay UMD with no module state, as `historyGraph.js` is.

## Acceptance criteria

- [ ] **Stable colours.** `buildGraphModel` (or the tone helper it uses) gives a branch `feature/x` the same tone:
  - on two pages that load different commits above it;
  - after another branch is added above it;
  - for `origin/feature/x` and `feature/x`.

  HEAD's chain is tone 0. A merged `x` label (plan 16) has `x`'s tone dot and keeps its `origin` chip, and an
  `origin/HEAD` label has no dot. Checked by a new `src/test/historyGraphSmoke.js`, added to `npm test`, and by
  `uiSnapshots.js` for the labels.
- [ ] **Segments.** Rows of one branch line share a `segment` id from its start to where it merges or ends.
  Another line has another id. Checked by the same test.
- [ ] **First-parent.** `getHistory` with `firstParent` passes `--first-parent`, and returns merge counts for
  merge commits (at most 50 per page). With `firstParent` off, the args are byte-identical to today's. Checked by
  `node src/test/dashboardHistorySmoke.js` and the history service tests (a temporary repository with one merge
  of 3 commits gives a count of 3).
- [ ] **One line with remotes on.** A temporary repository has `topic` (3 commits) merged into `main`, with `topic` kept.
  `getHistory` with `includeRemotes: true, firstParent: true` returns only `main`'s first-parent commits: the merge and
  `main`'s own commits, none of `topic`'s. The args contain no `--all`. With a branch filter, the log starts from that
  branch. Checked by `historyFirstParentSmoke.js`. **Failing first:** on `61e51ef` this case fails.
- [ ] **Concurrency.** With 55 merges, at most 4 `rev-list --count` processes are ever running at once, and exactly
  50 run in total. Checked by `historyFirstParentSmoke.js`.
- [ ] **Saved filter.** `firstParent` is kept per repository. A saved state without it reads as off. Checked by
  `node src/test/dashboardHistorySmoke.js`.
- [ ] **Page.**
  - Hovering a row adds `graph-lane-active` to its segment's paths, and `graph-dim` to the others.
  - Focus with Tab does the same.
  - Leaving clears both.
  - Labels show their tone.
  - The menu item toggles and reloads.

  Checked by `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui`, with
  new screenshots `58-history-graph-highlight.png` and `59-history-first-parent.png`. Numbers 53–55 are kept for
  plans 9–12, 56–57 are plan 16's, and 60–61 are plan 14's. Existing history screenshots may differ only in tones and label dots; the report names each.
- [ ] **Failure first.** With tones back to order-based, the stable-colour case fails. Report the message.
- [ ] **Required checks pass:**
  - `npm ci`;
  - `npm run lint` (0 errors; 2 known warnings);
  - `npm test`;
  - `test:ui` twice;
  - `npm run package`.
- [ ] **Unverified until run in VS Code** (say so): highlight speed on a large repository.

## Risks

| Risk | How it is handled |
| --- | --- |
| Two neighbouring branches hash to the same tone | Unnamed lanes avoid neighbours' tones; a clash of named ones is accepted; the label names it |
| Merge counts slow a page | At most 50 `rev-list --count` per page, at most 4 at a time, only while First-parent only is on; skipped with no badge on error |
| The highlight is costly on many rows | Class toggles on paths with one `data-segment` selector; no re-render |
| A changed saved-state shape drops filters | The field is optional and read as off; test with an old state |

## Open questions

None.
