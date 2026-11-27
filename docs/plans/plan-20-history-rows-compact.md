# Plan 20 — Compact history rows: one line per commit, initials nodes, tinted rows, icon labels

Status: draft
Date: 2026-11-27
Branch: `feat/history-rows-compact`
Baseline: `main` at `cbc08844d8d6826c1139752c029d522adb744e42` (plans 13 and 14 merged)
Target: `resources/webview.js` (`renderHistoryPage` row markup, `renderHistoryRefs`, `renderHistoryGraph` nodes),
`resources/webview.css`, `src/test/uiSnapshots.js`, `package.json`, `CHANGELOG.md`

## Goal

On 2026-11-27 the user sent a screenshot of another Git graph and asked for the history to look like it. The design
on the canvas "History graph redesign", and the four PNG states sent in chat, show the target:

- one line per commit;
- labels sit before the subject on the same line;
- nodes are filled circles in the line's tone, with the author's initials;
- each row is lightly tinted with its line's tone, and the checked-out row is outlined;
- labels are outlined pills with icons: a cloud when the branch is on origin, a monitor when it is on this machine.
  The current branch's pill also shows ↑/↓ counts.

This is the look only. The highlight rule and "Contained in" are plan 19.

**What happens now** (`main` at `cbc0884`, read from the code):

- A row (`renderHistoryPage`, `.history-row`) is a grid. Its message cell is `.history-message`, which puts
  `.history-refs` above `.history-subject`, so a labelled commit takes two lines.
- Rows are `min-height: 27px`, and the narrow test allows up to 80 px.
- Nodes are `.graph-node` circles with no content.
- Labels are filled pills. Plan 13 adds a 3 px tone bar and plan 16 an "origin" text chip.

**Minimum value:** every commit is one line at the default width, and a label's tone, origin and local state can be read
at a glance.

## Decisions

All planner's. The user approved the look through the canvas and the PNGs (2026-11-27).

1. **One line per commit.**
   - Inside `.history-message`, `.history-refs` and `.history-subject` become one flex row, labels first, with no
     wrap.
   - Rows are 30 px. The labels may take at most 55% of the message width. Past that, the last labels fold into a
     "+N" chip, and its `title` lists the folded names.
   - The subject takes the rest and truncates with an ellipsis.
   - **Narrow widths:** at a message width under 360 px, only the first label shows, plus "+N".
2. **Nodes with initials.**
   - Each commit node is a filled circle, 18 px, in its line's tone at 85% opacity, holding the author's initials
     (8.5 px, 600 weight, dark text).
   - **Initials:** the first letters of the first two words of `authorName`; one letter for a single word; "?" when
     there is no name.
   - No avatar images are fetched: there is no network call, and no email goes to an avatar service.
   - **Merge commits** use the same circle. The working-changes row keeps its dashed ring.
   - **Hit area:** `.graph-node-control` keeps its 12 px hit circle and the B/T markers. The marker shows on top of
     the initials when selected.
3. **Lines** are drawn at 2.5 px instead of 2 px. Plan 13's active line stays wider, at 3.5 px.
4. **Tinted rows.**
   - Each row's background is its line's tone at 5%: `color-mix(in srgb, var(--lane-color) 5%, transparent)`, with
     `--lane-color` set per row from the graph model.
   - The selected row is 20%. The checked-out branch's tip row (the `head` ref) gets an inset 1 px border in its
     tone.
   - **High contrast:** no tint, as today.
5. **Labels as outlined pills with icons.** A branch label is a pill: 1 px border and text in its tone, a fill at 12%.
   - **Origin.** When the branch is on origin (plan 16's merged `x [origin]`, or an `origin/x` label), the label
     starts with a cloud icon. The icon replaces the "origin" text chip: it is an inline SVG with `role="img"` and
     `aria-label="on origin"`, and keeps the class `ref-origin`.
   - **Local.** A local branch also gets a monitor icon (`aria-label="on this machine"`).
   - **Counts.** The current branch's pill ends with "↑n" and/or "↓n" from the repository's ahead and behind, the
     same numbers as the repository badges. Other branches show no counts: their numbers would need a Git process
     per branch.
   - **Tags** keep their purple pill, with no icon. `origin/HEAD` stays plain.
   - **Plan 13's edge bar is removed.** The pill's border now carries the tone, and two tone marks on one pill are
     noise. `.ref-dot` is removed. Plan 13's test that a tone takes no width now checks that the border colour
     equals the lane tone.
   - **Plan 14's drag and menus are unchanged:** the same `<button>`, `data-target` and `data-kind`.
6. **Light theme.**
   - Tones come from the existing `--lane-color` per lane.
   - Pill text uses the tone darkened with `color-mix(in srgb, var(--lane-color) 70%, var(--text-primary))` in a light
     theme, so it passes 4.5:1. The UI test measures that.
7. **Version: the next minor,** 3.12.0 if 3.11.0 has been released, shared with plan 19 if both land before a
   release. CHANGELOG `### Changed`.

## Scope

In:

- `resources/webview.js`:
  - the row markup in `renderHistoryPage`;
  - `renderHistoryRefs` (pill, icons, counts, "+N");
  - node markup in `renderHistoryGraph` (initials);
  - an `authorInitials(name)` helper.
- `resources/webview.css`:
  - one-line rows, row tint, the head outline;
  - pills and icons;
  - node fill and initials;
  - line width;
  - removal of `.ref-dot`.
- `src/test/uiSnapshots.js`, `CHANGELOG.md`, `package.json`.

Out:

- Highlight and Contained in (plan 19).
- Avatar images.
- Ahead/behind for branches other than the current one.
- The Side Bar's branch list. It keeps plan 16's chip; a follow-up can align it.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `.history-row` grid and `.history-message` (refs above subject) | Change: one line |
| `renderHistoryRefs` (merged origin chip, `.ref-dot`, drag attributes) | Change: pill with icons; keep drag attributes |
| `renderHistoryGraph` `.graph-node`, `.graph-node-control` (B/T) | Change: fill and initials; keep the control |
| `.graph-lane-0…7` tones (plan 13) | Keep, reuse |
| Narrow-width test (`tallestRow <= 80`) | Change: `<= 32` |

## Tech stack and constraints

Default (`AGENTS.md`):

- no new dependency;
- icons are inline stroke SVG;
- webview markup stays plain: no `on*` attributes, with every name escaped.

## Acceptance criteria

- [ ] **One line** (`npm run test:ui`). At 1280 px and at 600 px, every history row is 30 px tall, give or take 1 px.
  A labelled row's first label and its subject overlap vertically. Failing first: on `cbc0884` the labelled row is
  taller than 40 px.
- [ ] **Folding.** A commit with 6 labels at 600 px shows 1 label and "+5", and the "+5" `title` names the other five.
  At 1280 px it shows as many as fit in 55%.
- [ ] **Nodes.** A commit by "Thanh Hoang" shows "TH" in its node, and a one-word name shows one letter. B/T selection
  still toggles from the node and shows its marker.
- [ ] **Labels.**
  - `main [origin]` has a cloud with `aria-label="on origin"` and a monitor, and no "origin" text.
  - `origin/feature/ahead` has a cloud and no monitor.
  - The current branch's pill shows "↑1" when the fixture is 1 ahead.
  - Every pill's border colour equals its lane tone.
  - In the light theme, pill text contrast is at least 4.5.
  - Plan 14's label menu and drop still post the same messages: its existing assertions pass unchanged.
- [ ] **Rows.** A row's background contains its lane tone. The checked-out tip row has an inset border, and the
  selected row is stronger.
- [ ] **Screenshots.**
  - New: `63-history-compact-rows.png` (dark) and `63-history-compact-rows-light.png`.
  - Every existing history screenshot changes. The report lists them.
- [ ] `npm run lint`, `npm test`, `npm run test:ui` (twice) and `npm run package` pass. CHANGELOG and version follow
  Decision 7.
- [ ] The commit identity check from `AGENTS.md` prints one line.

**Unverified until run in VS Code:** the look in the user's own themes, and fonts other than the fixture's.

## Risks

| Risk | Handling |
| --- | --- |
| CI fonts are wider than local (plan 13's lesson: a narrow row grew a line) | Labels never wrap: they fold into "+N" at 55% width, so the row height cannot grow with font width. The test asserts 30 px at 600 px |
| Dropping the "origin" text hurts screen readers | The cloud is `role="img"` with `aria-label="on origin"`, and the label's `title` keeps the full text |
| Initials collide (two "TH") | The author column still shows the full name. Initials are a visual cue only |
| Plan 19 and this plan both change `renderHistoryRefs`/row markup | Plan 19 touches the summary and the highlight trigger only. If both are open together, the second to merge resolves; the planner does that |
| Many screenshots change at once | The report lists each one; the reviewer checks one dark and one light screenshot by eye |

## Open questions

None.
