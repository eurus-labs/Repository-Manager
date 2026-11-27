# Plan 21 — Close the gaps between the history and its design

Status: draft
Date: 2026-11-27
Branch: `fix/history-design-gaps`
Baseline: `main` at `71493464e6f56ddf39b71272f04f1c1c54030d5a` (plans 19 and 20 merged, version 3.12.0)
Target: `resources/webview.css`, `resources/webview.js` (row markup, label fold, author cell), `resources/historyGraph.js`
(only if a helper moves there), `src/test/uiSnapshots.js`, `package.json`, `CHANGELOG.md`

## Goal

On 2026-11-27 the user compared the shipped history with the design on the canvas "History graph redesign", using
the four PNG states sent in chat. They sent a screenshot of the real dashboard and said it does not look like the
design.

**Gaps.** Read from the user's screenshot and the code at `7149346`:

| # | Design | Today | Cause |
| --- | --- | --- | --- |
| 1 | Every row clearly tinted with its line's tone | Not visible on a VS Code dark theme | `.history-row.row-tint` is 5% (`webview.css` ~1680) |
| 2 | Labels show the whole branch name | Cut at 170 px, e.g. "feat/history-graph-conta…" | `max-width: 170px` (`webview.css` ~1815 and ~2310) and `HISTORY_REF_MAX_WIDTH = 170` (`webview.js`) |
| 3 | The author shown as an initials avatar | The name as text | Plan 20 kept the author cell |
| 4 | Pointing at a row shows nothing | Every row shows the native tooltip "Ctrl+click or Shift+click to compare" | `title` on `.history-row` (`webview.js` ~2429) |
| 5 | — | **Bug:** the commit details' "Contained in" chip overlaps the "CHANGED FILES" header below it | Plan 19 added a line to `.commit-summary` and the header does not grow to fit it |

**Minimum value.** The history reads like the design, and the details never overlap.

## Decisions

The user decided 1 and 2 on 2026-11-27 (AskUserQuestion). The rest are the planner's.

1. **The author is shown as avatar plus name.**
   - The author cell gets an 18 px initials circle before the name. The initials come from plan 20's
     `authorInitials`.
   - The circle's colour comes from `toneForName(authorName)` at 85%, so one person keeps one colour.
   - The email stays in the cell's `title`.
   - Rejected: an avatar alone. Two people can share initials.
2. **The COMMIT (hash) column stays.**
3. **A visible tint.**
   - Rows: lane tone at 9%.
   - Hovered row: 14%.
   - Selected row: 22%.
   - The checked-out tip keeps its outline.
   - High contrast still gets no tint.
   - The light theme uses the same percentages. In the light theme, the text over a 22% tint must keep at least
     4.5:1 contrast; the test measures it.
4. **Labels show their whole name** up to 320 px, at both 170 px places and in `HISTORY_REF_MAX_WIDTH`.
   - Past 320 px a label still truncates with an ellipsis, and its `title` gives the full name.
   - Folding into "+N" (plan 20, with Codex's fix) still decides how many labels show. With wider labels, fewer of
     them fit before the chip, which is intended.
5. **No tooltip on rows.**
   - The row's `title` is removed.
   - The compare hint moves to the GRAPH column header's `title`: "Click a node, or Ctrl+click or Shift+click a row,
     to compare".
   - The node keeps its own `<title>`.
6. **"Contained in" never overlaps.**
   - The commit header grows to fit the line at every width. Find why it does not: a fixed height, a grid row
     template, or an absolutely placed files header.
   - Fix it there, without a hard-coded height for the new line.
   - Check the widths of 1440, 1100 (the user's screenshot) and 820 px, with 1 and with 12 chips.
7. **Version.** If 3.12.0 has not been released when this merges, the entries go under 3.12.0 and the version stays.
   Otherwise this is 3.13.0. CHANGELOG:
   - `### Changed` for 1–5;
   - `### Fixed` for 6.

## Scope

In:

- `resources/webview.css`:
  - tint percentages;
  - label max-width;
  - the author avatar;
  - the commit header growing.
- `resources/webview.js`:
  - the author cell markup;
  - the row `title` removed;
  - `HISTORY_REF_MAX_WIDTH`;
  - the GRAPH header `title`.
- `src/test/uiSnapshots.js`, `CHANGELOG.md`, `package.json`.

Out:

- New behaviour: a hover card. The user said on 2026-11-27 that it adds little.
- Node size or lane geometry.
- Removing the hash column (Decision 2).

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `.history-row.row-tint` 5/10/20% | Change: 9/14/22% |
| `.history-ref` `max-width: 170px` (two rules), `HISTORY_REF_MAX_WIDTH` | Change: 320 |
| `.history-author` text cell | Change: avatar + name |
| `.history-row` `title="Ctrl+click or Shift+click to compare"` | Remove; the hint moves to the GRAPH header |
| `.commit-summary` / `.commit-summary-contained` grid (plan 19) | Change: the header grows |
| `authorInitials`, `toneForName` | Keep, reuse |

## Tech stack and constraints

Default (`AGENTS.md`):

- no new dependency;
- markup stays plain and escaped;
- tests and screenshots go through the existing Playwright harness.

## Acceptance criteria

- [ ] **Tint.** A tinted row's computed background has an alpha of 0.09 or more over the lane tone, and a selected
  row has 0.22. In the light theme, text over a selected row is at least 4.5:1. Failing first: on `7149346` the
  alpha is 0.05.
- [ ] **Labels.** A label named `feature/history-graph-contained-in` (34 characters) shows in full at 1440 px, and a
  400 px name is cut with its full name in `title`. Failing first: on `7149346` the first one is cut.
- [ ] **Author.**
  - Each row's author cell has an `.author-avatar` with the author's initials, then the name.
  - Two rows by the same author share the avatar colour.
  - The email is in `title`.
- [ ] **No row tooltip.**
  - No `.history-row` has a `title`.
  - The GRAPH header has the compare hint.
  - Ctrl+click and Shift+click still compare: the existing assertions pass.
- [ ] **No overlap.**
  - At 1440, 1100 and 820 px, with 1 and with 12 "Contained in" chips, the bounding box of
    `.commit-summary-contained` does not intersect the files header ("CHANGED FILES") or the file list.
  - Failing first: on `7149346` at 1100 px this intersects. Report the measured boxes.
- [ ] **Screenshots.**
  - New: `64-history-design-match.png`, built from a fixture with at least three lanes and a long branch name, at
    1440 px.
  - Changed history screenshots are listed.
  - The reviewer compares `64` with the design PNG `2-click-commit.png` side by side.
- [ ] `npm run lint`, `npm test`, `npm run test:ui` (twice) and `npm run package` pass. CHANGELOG and version follow
  Decision 7.
- [ ] The commit identity check from `AGENTS.md` prints one line.

**Unverified until run in VS Code:** the tint's strength in the user's own theme.

## Risks

| Risk | Handling |
| --- | --- |
| A stronger tint hurts text contrast in the light theme | Measured per lane at 22% (selected) in the light theme; lower it there if any lane fails |
| Wider labels fold more often | Intended. The fold keeps at least the first label and gives the rest in "+N" |
| The overlap's cause is not the summary grid (e.g. a fixed-height pane) | Decision 6 asks for the cause before the fix. The test checks three widths and two chip counts |
| A CI font wider than local (plan 13's lesson) | Row height is still fixed at 30 px, and labels never wrap; only width changes |

## Open questions

None.
