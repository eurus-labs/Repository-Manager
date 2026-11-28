# Plan 22 — Keep a branch's colour when it is checked out, and keep the commit details compact

Status: draft
Date: 2026-11-28
Branch: `fix/history-stable-colours-compact-details`
Baseline: `main` at `4a89f99a129e1663c2cc0026491f735adc879d13` (3.13.0)
Target: `resources/historyGraph.js`, `resources/webview.js`, `resources/webview.css`, `src/test/historyGraphSmoke.js`,
`src/test/uiSnapshots.js`, `package.json`, `CHANGELOG.md`

## Goal

The user reported three things on 2026-11-28, with screenshots of 3.13.0.

1. **The colour changes on a branch switch.** Checking out another branch changes the colours: the line just checked
   out turns amber, and the branch left behind takes another colour. The user asked to keep each branch's colour.
   - **Cause.** In `resources/historyGraph.js` `buildGraphModel`, `chainColor` is 0 whenever column 0's chain holds
     HEAD. This is plan 13's rule "HEAD's chain keeps tone 0".
   - **Same cause in the details.** In `resources/webview.js`, the "Contained in" chip of the checked-out branch also
     takes tone 0.
2. **In a short details pane, "Changed files" is pushed out of view.**
   - **Cause.** Plan 21 made `.commit-header` grow to fit all of its lines. The header now holds several lines: title
     and meta, a body line, the Review/Summarize buttons on a row of their own, and "Contained in".
   - **Result.** In the user's 3.13.0 screenshot (pane about 1000 px wide), the file list needs scrolling to be seen.
3. **"Contained in" chips use the old style.** The chips still read "main origin" as text, while the history labels
   use plan 20's outlined pills with a cloud. Plan 20 deliberately left the details out of the new style.

**Minimum value:**

- A branch keeps one colour whether or not it is checked out.
- The details header is at most one line taller than before plan 19, so the file list stays in view.

## Decisions

Decision 1 is the user's (2026-11-28). Decisions 2 and 3 are the planner's. The planner proposed them in chat on
2026-11-28, and the user's approval of this plan confirms them.

1. **A branch's tone never depends on HEAD.**
   - **Tone source.** Column 0's chain takes the tone of its branch name, `toneForName(<checked-out branch>)`, like
     any other line. The name comes from the `head` ref at the HEAD commit. A detached HEAD has no name and takes tone
     0.
   - **Where HEAD's line stays.** It keeps its column (0). It is marked by plan 20's outlined tip row (`row-head`) and
     its bold label, not by a colour.
   - **Details chip.** In "Contained in", the checked-out branch's chip takes its name tone as well.
   - **Tone 0's new use.** It is now only for a detached HEAD and for unnamed lanes when no other tone is free.
     `toneForName` stays 1–7, so no branch changes colour because of this plan.
   - **Rejected:** keeping amber for HEAD. That is exactly what changes colours on every checkout.
2. **A compact details header.** The header grows by at most one line over its height before plan 19.
   - **Buttons on the title row.** Review/Summarize stay on the title row whenever the pane is at least 720 px wide.
     They wrap below only under 720 px.
   - **"Contained in" shares the ref row.** It sits on the same row as the ref labels, after them. It is one line,
     never wraps, and keeps 12 chips as the limit. When the chips do not fit the row, the last ones fold into "+N",
     using `visibleRefCount` (plan 20). The "+N" button still shows the rest in place, as today.
   - **Body.** It stays one line, truncated, as today.
   - **What stays.** Plan 21's `max-content` row stays, so nothing overlaps. The header is shorter, so the file list
     keeps its room.
3. **One label style in the details.** The ref labels and the "Contained in" chips in the details use plan 20's
   outlined pill:
   - the lane tone on the border;
   - a cloud for origin and a monitor for local;
   - no "origin" text.

   Plan 20's scoping that excluded `#dashboardCommitSummary` is removed for these elements.
4. **Version: 3.14.0.** CHANGELOG:
   - `### Changed` for Decisions 1 and 3;
   - `### Fixed` for Decision 2 (the hidden file list).

## Scope

In:

- `resources/historyGraph.js`: `buildGraphModel`'s column 0 tone, and the `headHash` name lookup.
- `resources/webview.js`:
  - the "Contained in" chip tone and markup;
  - the summary layout (refs and Contained in on one row, with folding);
  - the details ref labels.
- `resources/webview.css`:
  - the header grid;
  - the 720 px rule;
  - the summary pill styles.
- Tests, `CHANGELOG.md`, `package.json`.

Out:

- Changing `toneForName` or the palette.
- The history row look.
- Deleting merged remote branches. This is a GitHub repository setting the user can turn on; it is not the
  extension's job.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `historyGraph.js` `buildGraphModel` `chainColor` (0 for HEAD's chain), `reserved` | Change: name tone; tone 0 only when detached |
| `webview.js` Contained in chip `tone = branch.current ? 0 : …` | Change: name tone |
| `.commit-header` grid, `.commit-header-actions` (row 1 / wraps at 900 px), `.commit-summary-refs`, `.commit-summary-contained` | Change: one ref row, buttons on the title row down to 720 px |
| Plan 20's `#dashboardCommitSummary` exclusion for pills | Remove for refs and chips |
| Plan 21's `max-content` first row | Keep |

## Tech stack and constraints

Default (`AGENTS.md`):

- no new dependency;
- markup stays plain and escaped;
- the same Playwright harness.

## Acceptance criteria

- [ ] **Stable tone across a checkout** (`historyGraphSmoke.js`).
  - The same commits are modelled twice: once with HEAD on `main`, once with HEAD on `feature/x`.
  - In both, `main`'s line and `feature/x`'s line have the same tone, and neither is 0.
  - A detached HEAD's line is tone 0.
  - **Failing first:** on `4a89f99` the checked-out line is 0.
- [ ] **Stable tone in the page** (`uiSnapshots.js`).
  - The tone of `main`'s label, and of its "Contained in" chip, is the same before and after a scripted checkout
    to another branch.
  - **Failing first** on `4a89f99`.
- [ ] **Compact header.** The panes tried: 1000×560, 1440×560 and 720×560, each with a commit body, 3 refs and
  12 "Contained in" branches.
  - The header is at most one ref-row taller than a commit with no "Contained in". Measure both and report.
  - The "CHANGED FILES" title and the first file row are fully inside the pane without scrolling.
  - At 1000 px the Review/Summarize buttons are on the title row.
  - Nothing overlaps (plan 21's check stays).
  - **Failing first:** on `4a89f99` at 1000×560 the file list is not in view.
- [ ] **Folding in the details.** The chips that do not fit fold into "+N". The button shows them all, and its
  `title` names them.
- [ ] **One style.**
  - Details ref labels and chips have the lane tone on their border, a cloud with `aria-label="on origin"` for
    origin, and no "origin" text.
  - Plan 19's assertions on chip text are updated to the new markup. Name each one.
- [ ] **Screenshots.**
  - New: `65-history-details-compact.png` (1000×560).
  - New: `65b-history-checkout-colours.png`, the same history before and after a checkout, side by side or as two
    files.
  - Changed screenshots are listed.
- [ ] `npm run lint`, `npm test`, `npm run test:ui` (twice) and `npm run package` pass. CHANGELOG and version follow
  Decision 4.
- [ ] The commit identity check from `AGENTS.md` prints one line.

**Unverified until run in VS Code:** the header height in the user's real pane and font.

## Risks

| Risk | Handling |
| --- | --- |
| Without amber, the checked-out line is harder to spot | It keeps column 0, the outlined tip row and the bold label; the screenshot is checked for it |
| Two lines share a tone and one of them is HEAD's | Accepted as for any two lines (plan 13); the outline tells them apart |
| Folding "Contained in" hides branches people wanted to see | "+N" with the names in `title`; the button expands in place |
| CI fonts wider than local | No wrapping on the ref row; only folding changes, and row height is asserted |

## Open questions

None.
