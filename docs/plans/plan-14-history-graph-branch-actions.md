# Plan 14 — Merge and rebase between branches from the graph, with a preview

Status: draft
Date: 2026-11-22
Branch: `feat/history-graph-branch-actions`
Baseline: `main` at `4fe5d23e5d17283e1987a4ed31c452e0a5034ac9`
Target: `src/webview/template.ts` (menus), `resources/webview.js` (labels, menus, drag), `resources/webview.css`, `src/handlers/webviewMessageHandler.ts`, `src/services/historyRewriteService.ts`, `src/services/historyActionService.ts`, tests, `CHANGELOG.md`, `package.json`

## Goal

The user reported on 2026-11-22 that the commit menu's **Rebase current branch onto this commit…**
(`src/webview/template.ts:510`) "is kinda misunderstanding": people rebase a branch onto another branch. Today:

- branch labels in the history can only be double-clicked to check out (`resources/webview.js:1600`);
- there is no way to merge or rebase from a branch label;
- merge exists only as **Merge into current branch…** on a commit.

After this change:

- the commit menu offers rebase and merge **per branch label on that commit**;
- each branch label has its own menu;
- dragging one branch label onto another offers the actions that make sense for the pair;
- every action shows a preview first: the commits that move or come in, and the predicted conflicts.

## Decisions

1. **Rebase is offered onto branches only** (the user's choice, 2026-11-22).
   - **Removed:** **Rebase current branch onto this commit…**.
   - **Added to the commit menu,** for each branch label on the commit (local or remote) that is not the current
     branch: **Rebase `<current>` onto `<branch>`…** and **Merge `<branch>` into `<current>`…**. They sit in a
     group like the existing **Delete Branch** items (`fillHistoryBranchItems`, `resources/webview.js:337`).
   - A commit with no branch label offers neither.
   - **Unchanged:** **Merge into current branch…** on a bare commit, Cherry Pick, Revert, Reset and Drop.
   - Rejected: also keeping a reworded commit rebase.
2. **Branch label menu.** Right-clicking a branch label, or pressing the context-menu key or Shift+F10 on it, opens
   a menu with:
   - **Checkout**;
   - **Merge `<this>` into `<current>`…**;
   - **Rebase `<current>` onto `<this>`…**;
   - **Compare with `<current>`**, using the existing comparison;
   - **Delete Branch…** (local only).

   On the current branch's own label it offers only Compare and the Delete rules as today. This menu is the
   keyboard and screen-reader path to everything drag does.
3. **Drag a label onto a label** (the user's choice, 2026-11-22: drag plus menu).
   - Branch labels are `draggable`. Dropping one on another opens a small menu at the drop point with the actions
     valid for the pair:
     - **Merge `S` into `T`**: only when the target `T` is the current branch;
     - **Rebase `S` onto `T`**: only when the source `S` is the current branch;
     - when neither is current, one disabled line: "Check out `S` or `T` first".
   - Escape or a click outside cancels. Nothing runs on drop alone.
   - Git operations run on HEAD, so every action involves the current branch.
   - Rejected: checking out automatically to make a pair valid, because a hidden checkout surprises people and can
     fail on a dirty tree.
4. **Previews reuse what exists, and gain the commits for merge.**
   - **Rebase onto a branch.** It goes through `rewriteHistoryCommit` with `action: 'rebase'` and the branch's tip.
     - The existing preview and confirm (`src/handlers/webviewMessageHandler.ts:988–1016`) already list the
       commits that move and predict conflicts.
     - `historyRewriteService.rebase` already rebases from the merge-base (`:115`).
     - The question names the branch: "Rebase `<current>` onto `<branch>`?", not a hash.
     - The request carries `ontoBranch`, re-resolved just before running. If the branch moved since the preview,
       the action stops and says so, as the HEAD check does (`:101–104`).
   - **Merge a branch.**
     - The confirm (`webviewMessageHandler.ts:946–951`) gains the incoming commits: `git log --format=… HEAD..<branch>`,
       the first 20 and the count. It says "fast-forward" when HEAD is an ancestor, and "nothing to merge" when
       `<branch>` is already in HEAD.
     - The predicted conflicts are unchanged.
     - The merge runs on the branch's name, so the merge message names it.
   - Rejected: a new preview dialog in the webview. The host's modal already shows the preview, is tested, and is
     the place for approvals (no `confirm()` in webviews).
5. **Version: the next minor** at merge. CHANGELOG:
   - `### Changed`: the rebase item;
   - `### Added`: label menus, drag, and merge preview commits.

## Scope

In:

- `src/webview/template.ts`: remove the commit-rebase item; add the branch-action group and the label menu
  container.
- `resources/webview.js`:
  - branch-action items in the commit menu;
  - the label menu (mouse and keyboard);
  - drag and drop between labels with the pair menu;
  - messages `rebaseOntoBranch` and `mergeBranch`, or the existing messages with `ontoBranch` and `branch`.
- `resources/webview.css`: drag-over target and the drop menu.
- `src/handlers/webviewMessageHandler.ts`: named-branch rebase and merge, the incoming-commits preview, and the
  moved-branch check.
- `src/services/historyRewriteService.ts` and `src/services/historyActionService.ts`: accept a branch name and
  re-resolve it.
- Tests, `CHANGELOG.md`, `package.json`.

Out:

- Merge or rebase between two branches that are not current.
- Interactive rebase.
- Drag onto commits (only onto labels).
- Graph readability (plan 13).

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/webview/template.ts:501–521` commit menu, `:510` rebase item | Change: remove `:510`; add the branch group |
| `resources/webview.js:337` `fillHistoryBranchItems`, `:346` `showHistoryContextMenu`, `:573` `contextRebase`, `:567` `contextMerge` | Change |
| `resources/webview.js:1595` `renderHistoryRefs` (double-click checkout), `:2694` body `contextmenu` | Change: label menu, `draggable`; keep double-click |
| `src/handlers/webviewMessageHandler.ts:935–960` apply (merge), `:980–1035` rewrite (rebase preview and confirm) | Change |
| `src/services/historyRewriteService.ts:25` `preview`, `:96–118` run (HEAD recheck, `--onto` from the merge-base) | Keep; accept and recheck a branch |
| `src/services/historyActionService.ts:24–50` merge | Keep; accept a branch name |
| `src/services/conflictPredictionService.ts:67` `predict` | Keep, reuse |
| `src/test/historyActionHandlerSmoke.js`, `src/test/historyRewriteHandlerSmoke.js`, `src/test/dashboardHistorySmoke.js`, `src/test/uiSnapshots.js` | Change: add cases |

## Tech stack and constraints

Default (`AGENTS.md`): no `confirm()` in the webview, and approvals stay host modals. Drag uses HTML5
`dragstart`, `dragover` and `drop`, with the label menu as the accessible path.

## Acceptance criteria

- [ ] **Commit menu.**
  - It no longer has "Rebase current branch onto this commit".
  - On a commit labelled `feature/x` (not current), it has "Rebase `main` onto `feature/x`…" and "Merge
    `feature/x` into `main`…".
  - On a commit with no label, neither appears.

  Checked by `node src/test/dashboardHistorySmoke.js` (or the menu tests) and `uiSnapshots.js`.
- [ ] **Rebase onto a branch.** In a temporary repository, rebasing `main` onto `feature/x` from the menu:
  - shows a confirm naming `feature/x`, with the commits that move and the conflict prediction;
  - when accepted, puts `main`'s own commits on top of `feature/x`'s tip.

  If `feature/x` moves between the preview and the run, nothing runs and the message says so. Checked by
  `node src/test/historyRewriteHandlerSmoke.js`.
- [ ] **Merge preview.**
  - The merge confirm for `feature/x` into `main` lists the incoming commits, the first 20 and the count.
  - It says "fast-forward" when it is one, and "nothing to merge" when `feature/x` is already in `main`, in which
    case nothing runs.

  Checked by `node src/test/historyActionHandlerSmoke.js`.
- [ ] **Label menu.**
  - Right-click and Shift+F10 on a non-current label show Checkout, Merge, Rebase, Compare and Delete (local).
  - On the current label: Compare (plus Delete as today's rules allow).

  Checked by `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui`.
- [ ] **Drag.**
  - Dropping `feature/x` on the current `main` label offers only "Merge `feature/x` into `main`".
  - Dropping `main` on `feature/x` offers only "Rebase `main` onto `feature/x`".
  - Dropping between two non-current labels shows the disabled "Check out … first".
  - Escape cancels, and nothing is posted on drop alone.

  Checked by the UI test, which posts the chosen item's message. New screenshots `0x-history-branch-menu.png` and
  `0x-history-branch-drop.png`.
- [ ] **Failure first.** With the moved-branch recheck removed, the "branch moved" case runs the rebase. The test
  fails; report the message.
- [ ] **Required checks pass:**
  - `npm ci`;
  - `npm run lint` (0 errors; 2 known warnings);
  - `npm test`;
  - `test:ui` twice;
  - `npm run package`.
- [ ] **Unverified until run in VS Code** (say so): real drag and drop in the VS Code webview, and modal previews
  on large merges.

## Risks

| Risk | How it is handled |
| --- | --- |
| A drop runs something by accident | A drop only opens a menu; every action then asks through the host modal with a preview |
| A branch moves between preview and run | Re-resolved before running; it stops if it changed, as for HEAD |
| A rebase of a published branch surprises others | The confirm already lists the commits that move; a backup branch is created for rewrites as today |
| Drag is not accessible | The label menu offers every drag action by keyboard |
| Remote labels (`origin/x`) as targets | Allowed for merge and rebase (read-only refs); Delete stays local-only |

## Open questions

None.
