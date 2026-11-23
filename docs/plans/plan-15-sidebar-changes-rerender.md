# Plan 15 — Picking a file in the Side Bar's Changes no longer rebuilds the Side Bar

Status: draft
Date: 2026-11-23
Branch: `fix/sidebar-changes-rerender`
Baseline: `main` at `4fe5d23e5d17283e1987a4ed31c452e0a5034ac9`
Target: `resources/sidebar.js`, `resources/webview.js` (`publishSidebar` only), `src/test/uiSnapshots.js`,
`CHANGELOG.md`, `package.json`

## Goal

The user reported on 2026-11-23 that in Changes, every time a changed file is selected, the whole list renders
again.

**Reproduced** (Playwright against the real `webview.js` and `sidebar.js`, 120 changed files; the script was
`repro-sidebar.js` in the session's scratchpad):

- one plain click on a Changes row makes the dashboard send **1** `sidebarSnapshot`;
- the Side Bar then holds **896 of 896** nodes that are new: every repository, branch, change row and button is
  replaced, not only the row whose state changed.

**Not shown by the repro:** a lost scroll position. The list's `scrollTop` went from 1500 to 1490. Focus is put
back on the clicked row (`sidebar.js:19–22`), and that scrolls it back into view. Do not claim a scroll reset.

**Why it happens.** The Side Bar is a copy that the dashboard renders:

1. The click reaches the dashboard (`sidebarAction`, `webview.js:2800`), and `showWorkingFile` runs.
2. `markShownWorkingFile` (`webview.js:2428`) moves the `shown` class and `aria-current` to the new row.
3. The `MutationObserver` (`webview.js:2794`) sees the attribute change. `publishSidebar` (`:2776`) then sends
   the whole of `dashboardSidebar.innerHTML`.
4. `sidebar.js` `render` (`:14`) does `root.innerHTML = html`.

The same happens whenever anything in the mirrored list changes. It also happens when nothing visible changes:

- every status refresh rebuilds the hidden list with `list.innerHTML = …` (`webview.js:2237`), even when the
  changes are the same;
- live changes after a save, and the auto-fetch's refresh, both trigger it.

A Changes list holds up to 500 rows (`SIDEBAR_CHANGES_SHOWN`), so each of these rebuilds every row and every
branch row. Hover state, any running transition and the focus ring are lost and redrawn.

After this change:

- a snapshot changes in the Side Bar only the nodes that differ from what it already shows;
- a snapshot identical to the last one sent is not sent.

## Decisions

1. **The Side Bar patches its DOM instead of replacing it.** `sidebar.js` `render(html)`:
   - parses `html` into a `<template>`;
   - patches `root`'s children towards the template's children with a small recursive patcher written in
     `sidebar.js`. There is no new dependency, and `sidebar.js` stays a single classic script.

   **The patcher's rules:**
   - **Same node.** Two element nodes are the same when they have the same `tagName` and the same key.
     - The key is `id` if present, else `data-mirror-key`, else none.
     - Unkeyed nodes match by position among the unkeyed siblings with the same tag.
     - A key used twice under one parent (it can happen: `mirrorKey` is built from an element's data) makes both
       nodes unkeyed.
   - **A matched element.** Its attributes are set, changed or removed to equal the new element's, then its
     children are patched.
   - **Text and comment nodes** update `nodeValue`.
   - **An unmatched new node** is imported (`document.importNode`). Leftover old nodes are removed. Keyed nodes
     are moved with `insertBefore` to the new order.
   - The root's scroll restore and the focus restore stay, as a fallback for a focused node that was removed.

   **Rejected options:**
   - A message that moves only the `shown` class. It fixes this click, but not the next change of the same kind
     (a checkbox, a branch's pending state, a count).
   - A virtual DOM library, for one view of buttons and text.
   - Skipping the rebuild in each `render…` function in `webview.js`. There are many, and the Side Bar would still
     replace everything on any real change.
2. **The dashboard does not resend an identical snapshot.**
   - `publishSidebar` remembers the last `html` and `changes` it posted, and posts only when either differs.
   - The host's `publishSidebar` request (`webview.js:3139`, sent when a Side Bar view is created or recreated)
     always posts, because the new view starts empty.

   This makes an identical status refresh cost no message at all. The `MutationObserver` still fires for the
   hidden list's rebuild, which is cheap and not on screen.
3. **The patcher must give the same DOM as `innerHTML` would.** That is the invariant the tests check. Form
   controls are not a concern: the mirrored block (`template.ts:269–290`) holds buttons, spans and divs, and no
   `input`, `select`, `textarea` or `details`. If the implementer finds one, stop and report, because its live
   value is a property, not an attribute.
4. **Version.**
   - **Patch** (a bug fix; the interaction is unchanged).
   - If plan 8 (3.8.1) has not shipped when this merges, this plan's `### Fixed` entry goes under the same
     `## [3.8.1]` heading and the version is bumped once.
   - Otherwise it ships as the next patch after the one released.

## Scope

In:

- `resources/sidebar.js`: the patcher, `render` uses it (Decisions 1, 3).
- `resources/webview.js`: `publishSidebar` skips an identical snapshot; the `publishSidebar` message forces one
  (Decision 2).
- `src/test/uiSnapshots.js`: the acceptance checks below.
- `CHANGELOG.md` `### Fixed`; `package.json` via `npm version <x.y.z> --no-git-tag-version`.

Out:

- The dashboard's own lists. Their selection only toggles classes (`selectChangedFile`, `webview.js:817`), so they
  do not rebuild on a click.
- `renderWorkingTreeDetail` asking for the shown file's diff again after an identical status refresh
  (`webview.js:2397–2404`). The diff stays on screen while it loads (`:834`); it is a separate, smaller cost.
- The Side Bar's layout, wording and tooltips.
- Branch rows and the origin labels. That is a separate plan.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `resources/sidebar.js:14` `render` (`root.innerHTML = html`) | Change: patch (Decision 1) |
| `resources/sidebar.js:19–22` focus restore, `:16–18` root scroll restore | Keep as fallback |
| `resources/webview.js:2776` `publishSidebar`, `:2789` `scheduleSidebarPublish`, `:2794` observer | Change only `publishSidebar` (Decision 2) |
| `resources/webview.js:2773` `mirrorKey`, `:2800` `runSidebarAction` | Keep: keys and clicks work as now |
| `resources/webview.js:3139` `publishSidebar` message | Change: forces a post |
| `src/repositoryManagerLauncher.ts:59` `update`, `:90–98` `sidebarReady` | Keep |
| `src/test/uiSnapshots.js:357` `openSidebar`, `:516–590` Changes tests | Keep; add checks |
| `src/test/sidebarViewSmoke.js` | Keep: the host relay does not change |

## Tech stack and constraints

Default (`AGENTS.md`):

- no new dependency;
- no `alert`, `confirm` or `prompt`;
- UI tests use the pre-installed Chromium (`PLAYWRIGHT_CHROMIUM_PATH`), never `playwright install`.

## Acceptance criteria

All checks are in `npm run test:ui`, on the Side Bar page that `openSidebar` connects to a dashboard.

- [ ] **A plain click.** Before the click, every node under `#sidebarRoot` is marked (for example
  `node.__old = true`). After a plain click on a Changes row, and once its diff name shows in the dashboard:
  - no node under `#sidebarRoot` is new;
  - the clicked row has `shown` and `aria-current="true"`;
  - the row shown before has neither;
  - `document.activeElement` is the same node that was clicked.
- [ ] **An identical refresh.** A status refresh whose changes are the same sends no `sidebarSnapshot`, and no
  node under `#sidebarRoot` is new. Use the harness's `refresh` or a repeated `workingTreeChangesLoaded`, and count
  in the `__postToHost` hook.
- [ ] **The patcher equals `innerHTML`.** After every snapshot in the run, the Side Bar's `#sidebarRoot.innerHTML`
  equals the snapshot's HTML parsed and serialized the same way (`template.innerHTML`). Check it in `openSidebar`'s
  relay, so every existing test exercises it. Include at least:
  - a file added at the top of Changes;
  - a file removed from the middle;
  - a branch added and one deleted;
  - the dashboard closed and reopened (`sidebarClosed`, then a snapshot).
- [ ] **A seeded shuffle.** At least 50 snapshots, posted to the Side Bar page directly. Each one reorders,
  inserts, removes and edits attributes and text of keyed and unkeyed rows. Two rows share a key in at least one.
  After each, the equality above holds.
- [ ] **A recreated view.** `sidebarReady` after the dashboard has already published still gets a full snapshot
  (Decision 2).
- [ ] **Existing behaviour.** These pass unchanged, with no visible change to their screenshots:
  - the double-click open (`uiSnapshots.js:548`);
  - Ctrl+click and checkbox selection (`:574–583`);
  - the short Side Bar fit (`:557–570`);
  - `01f-sidebar-changes`, `01f-sidebar-changes-short` and `01h-sidebar-selected-changes`.
- [ ] `npm run lint`, `npm test` and `npm run package` pass; CHANGELOG and version as in Decision 4.
- [ ] The commit identity check from `AGENTS.md` prints one line.

**Unverified until run in VS Code:** whether the flicker the user saw is gone. In a real webview the snapshot
crosses the extension host; the harness relays it directly.

## Risks

| Risk | Handling |
| --- | --- |
| The patcher leaves the DOM different from the snapshot (a stale attribute, a wrong order), so a click runs the wrong item | The equality check after every snapshot, and the seeded shuffle |
| A key collision moves the wrong node | Duplicate keys under one parent fall back to unkeyed (Decision 1); one shuffle case covers it |
| Skipping identical snapshots leaves a new Side Bar view empty | `publishSidebar` from the host always posts; acceptance case "A recreated view" |
| A removed focused node loses focus | The existing focus restore by `data-mirror-key` stays as a fallback |

## Open questions

None.
