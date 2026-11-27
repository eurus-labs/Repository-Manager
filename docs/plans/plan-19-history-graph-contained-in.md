# Plan 19 — Light a line only on its commit node, and show which branches contain a selected commit

Status: approved
Date: 2026-11-27
Branch: `feat/history-graph-contained-in`
Baseline: `main` at `cbc08844d8d6826c1139752c029d522adb744e42` (3.11.0 content: plans 13 and 14 merged)
Target: `resources/webview.js` (highlight trigger, commit summary), `resources/webview.css`,
`src/services/historyService.ts` (or a new `src/services/containingBranches.ts`), `src/handlers/webviewMessageHandler.ts`,
`src/test/containingBranchesSmoke.js` (new), `src/test/uiSnapshots.js`, `package.json`, `CHANGELOG.md`

## Goal

The user reported on 2026-11-27 that plan 13's highlight is annoying. Moving the pointer over the history dims every
other line, because every row and label is a highlight target. What they want is to see **which branch a commit belongs
to** when they point at that commit. Pointing at the graph in general should keep every line visible.

The design is on the canvas "History graph redesign" (2026-11-27), with four PNG states sent in chat. The user chose,
on 2026-11-27 (in chat):

- the card opens **on click, not on hover**;
- **option 2**: no floating card. "Contained in" goes in the commit details, which a click on a row already opens.
  A click on a graph node keeps its current meaning (choose Base/Target for a comparison).

**What happens now** (`main` at `cbc0884`, read from the code):

- `resources/webview.js` `historySegmentOf` takes the segment from any `#dashboardHistory [data-segment]`. Rows,
  labels, nodes and edges all carry `data-segment` (`renderHistoryGraph`, the row markup), and `mouseover` and
  `focusin` on `document.body` call `setHistoryHighlight`. So any row under the pointer dims all other lines.
- `.graph-dim` is `opacity: .22` (`resources/webview.css`).
- The commit summary (`#dashboardCommitSummary`) shows the refs **at** the commit (`.commit-summary-refs`). Nothing
  shows the branches that **contain** it.

**Minimum value:** moving over rows and the graph never dims anything. Pointing at a node lights that line. Selecting
a commit lists the branches that contain it.

## Decisions

Decisions 1 to 3 are the user's (2026-11-27). The rest are the planner's.

1. **Only a commit node lights its line.**
   - The trigger is the pointer over a node (`.graph-node-control`), or keyboard focus on it.
   - Rows, labels, edges and empty graph area are not triggers. Moving over them clears any highlight.
   - `historySegmentOf` looks only for `.graph-node-control[data-segment]`. The other elements keep `data-segment`
     because the highlight still marks them.
2. **Fade other lines to 40%** (`.graph-dim { opacity: .4 }`), not 22%, so the graph stays readable while a line is
   lit.
3. **"Contained in" lives in the commit details,** not in a popover.
   - A row click already selects a commit and fills `#dashboardCommitSummary`. Under its existing ref chips, a new
     line reads "Contained in N branches", followed by one chip per branch.
   - A click on a node keeps its meaning (Base/Target).
4. **One Git process, off the details' critical path.**
   - A new message `getCommitBranches` carries `{ repositoryPath, commitHash, requestId }` and is answered with
     `commitBranchesLoaded`. It is posted alongside `getCommitDetail`, so the details are never delayed.
   - The host runs `git for-each-ref --contains <sha> --format=%(refname) refs/heads refs/remotes`. The listing
     reads both local and remote branches in one process.
   - **Left out:**
     - `refs/remotes/*/HEAD`;
     - the review snapshot and Discard refs (`SNAPSHOT_REF_PREFIX`, `DISCARD_REF_PREFIX`), which are not under
       heads or remotes but are excluded explicitly anyway;
     - stash refs.
   - **Timeout:** 10 s. On a timeout or an error, the line reads "Could not list the branches" and the details stay
     as they are.
   - **The sha** is validated as a full or short hex object name and resolved with `resolveRevision` before use, so
     the payload never reaches Git as an option.
5. **How the branches are shown.**
   - **Folding (plan 16's rule).** If both `x` and `origin/x` contain the commit, they show as one chip `x` with the
     origin cloud. A branch only on origin shows as `origin/x`. Remotes other than `origin` show by full name.
   - **Order:** the checked-out branch first, then other local branches A to Z, then remote-only branches A to Z.
   - **Tone:** each chip's tone is the graph's `toneForName` (plan 13). The checked-out branch takes HEAD's tone 0.
   - **Limit:** at most 12 chips, then a "+N more" button that shows the rest in place.
   - **None:** with no branch (a stash's internal commit, or an unreachable commit), the line reads "Not on any
     branch".
   - **While loading:** the line reads "Finding branches…".
   - Every name is escaped. Chips are plain markup, with no `on*` attributes.
6. **Stale answers and a cache.**
   - The webview ignores a `commitBranchesLoaded` whose `requestId` is not the latest for the shown commit.
   - Answers are cached per repository and sha in the webview, so reselecting a commit runs no Git process.
   - The cache is cleared on `repositoryRefsLoaded`, which follows a fetch, a checkout, a merge or a branch change.
7. **Comparison mode** (Base and Target selected): the line is shown for the Target commit. The working-changes row
   gets none.
8. **Version: 3.12.0** (3.11.0 is released). Plan 20 may share it; the second to
   merge keeps one heading. CHANGELOG:
   - `### Changed`: the highlight rule;
   - `### Added`: Contained in.

## Scope

In:

- `resources/webview.js`:
  - `historySegmentOf` (Decision 1);
  - the commit-summary render (Decisions 3, 5 and 7);
  - the `commitBranchesLoaded` handler and cache (Decision 6).
- `resources/webview.css`: `.graph-dim` at .4, and the "Contained in" line and chips.
- **Host:**
  - a `listContainingBranches(repositoryPath, sha)` service function;
  - the `getCommitBranches` handler, registered in `messageHandlers` and in `READ_ONLY_MESSAGES` (it writes
    nothing).
- Tests, `CHANGELOG.md`, `package.json`.

Out:

- The compact row look (plan 20).
- A floating card. It was rejected by the user's choice of option 2.
- Changing what a node click does.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `resources/webview.js` `historySegmentOf`, `setHistoryHighlight`, body `mouseover`/`focusin` listeners | Change: nodes only |
| `resources/webview.js` `.graph-node-control` (Base/Target toggle) | Keep |
| `resources/webview.js` commit summary render into `#dashboardCommitSummary` (`.commit-summary-refs`) | Change: add the Contained in line |
| `src/handlers/webviewMessageHandler.ts` `handleGetCommitDetail` | Keep; the new handler sits beside it |
| `src/repositoryManagerPanel.ts` `READ_ONLY_MESSAGES` | Change: add `getCommitBranches` |
| `resources/historyGraph.js` `toneForName` | Keep, reuse |

## Tech stack and constraints

Default (`AGENTS.md`):

- no new dependency;
- Git runs through `GitCommandService`;
- tests use real temporary repositories with a bare `origin` and ignore the global Git config;
- a new `src/test/*Smoke.js` is added to the `test` script.

## Acceptance criteria

- [ ] **The listing** (`node src/test/containingBranchesSmoke.js`, new). In a temporary repository with a bare origin:
  - a commit on `main`, `feature/a` and `origin/main` returns `main` (folded with origin), then `feature/a`;
  - a branch only on origin that contains the commit returns `origin/x`;
  - `origin/HEAD` is never listed;
  - a stash's internal commit returns none;
  - a short sha works, and `--upload-pack=x` or a name starting with `-` is refused before Git runs;
  - exactly one `for-each-ref` process runs, recorded through a wrapping `GitCommandService`.
- [ ] **The handler.**
  - `getCommitBranches` answers with `commitBranchesLoaded` carrying the same `requestId`.
  - An error answers with an error flag, and the details are not affected.
  - It is listed in `READ_ONLY_MESSAGES`, so it never waits for auto-fetch.
- [ ] **The highlight** (`npm run test:ui`):
  - the pointer over a row, a label or empty graph area leaves no `graph-dim` anywhere;
  - over a node, its segment gets `graph-lane-active` and the others `graph-dim`;
  - Tab to a node does the same;
  - leaving clears it;
  - `.graph-dim` computes to opacity 0.4;
  - **failing first:** on `cbc0884`, the row case fails.
- [ ] **Contained in** (`npm run test:ui`, with a scripted host answer):
  - selecting a commit shows "Finding branches…", then the chips in Decision 5's order, with the checked-out branch
    first in HEAD's tone;
  - a 15-branch answer shows 12 chips and "+3 more", and the button shows all 15;
  - a stale answer (an older `requestId`) changes nothing;
  - reselecting the same commit posts no second `getCommitBranches`;
  - after `repositoryRefsLoaded` it posts again;
  - "Not on any branch" and the error text show for their cases;
  - a node click still toggles Base/Target and opens no branch list;
  - **new screenshot:** `62-history-contained-in.png`.
- [ ] `npm run lint`, `npm test`, `npm run test:ui` (twice) and `npm run package` pass. CHANGELOG and version follow
  Decision 8.
- [ ] The commit identity check from `AGENTS.md` prints one line.

**Unverified until run in VS Code:** the listing's time on a large repository with many branches.

## Risks

| Risk | Handling |
| --- | --- |
| `for-each-ref --contains` is slow on a big repository with many branches | It runs only on a selection, off the details' path, has a 10 s timeout, and is cached per sha until refs change |
| A quick run of selections floods Git | The webview posts only for the shown commit; stale answers are dropped. A request already in flight for the same sha is reused, not posted again |
| Odd ref names (plan 14's lesson: a local branch named `origin/topic`, a tag named like a branch, `origin/HEAD`) | Read full ref names (`refs/heads/…`, `refs/remotes/…`). Fold only `refs/remotes/origin/x` with `refs/heads/x`. Never read tags. Test a local `origin/topic` next to the remote one: both are listed, as two chips |
| Users miss the old row-hover highlight | Pointing at the node keeps it, and Tab reaches nodes; the CHANGELOG says so |
| A long branch list pushes the details down | 12 chips and "+N more"; chips wrap within the summary width |

## Open questions

None.
