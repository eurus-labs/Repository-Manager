# Plan 16 — One label per branch, with `origin` when it is on origin; checking out updates from origin

Status: draft
Date: 2026-11-23
Branch: `feat/branch-origin-labels-update`
Baseline: `main` at `4fe5d23e5d17283e1987a4ed31c452e0a5034ac9`
Target: `src/services/branchService.ts`, `src/handlers/webviewMessageHandler.ts`, `resources/webview.js`,
`resources/webview.css`, `src/test/branchCheckoutSmoke.js` (new), `src/test/uiSnapshots.js`, `package.json`,
`CHANGELOG.md`

## Goal

The user reported two problems on 2026-11-23:

- clicking a branch that is on origin does not bring its new code down;
- the local and remote copies of a branch should read as one, and a branch that exists only locally should not
  say `origin`.

**What happens now** (from the code; no run was needed):

1. **A click is a checkout and nothing else.** The click routes depend on where the branch is:
   - Side Bar branch row: a single click (`selectDashboardBranch`, `webview.js:878`);
   - graph label: a double-click (`webview.js:2746`).

   Both call `requestBranchCheckout`, which posts `checkoutBranch`. The host runs `git checkout <name>`
   (`branchService.ts:201`). Consequences:
   - **A local branch behind `origin/<name>`** stays at its old commit.
   - **No fetch runs.** A branch that exists only on origin is created from the last fetched `origin/<name>`. The
     background fetch runs at most every 5 minutes (`repositoryManager.autoFetchInterval`) and only while the
     dashboard is visible (`repositoryManagerPanel.ts:321`).
   - **The checked-out branch** never reaches the host. `requestBranchCheckout` returns early and only reloads
     the history (`webview.js:1616`).
2. **The graph shows two labels on one commit.** It shows `main` and `origin/main` when both point at it. Each
   label comes from `%D` as its own ref (`historyService.ts:27`), and `renderHistoryRefs` (`webview.js:1595`)
   draws each one.
3. **The Side Bar already lists one row per name.** It prefers the local branch, and `isRemote` marks a branch that
   is only on origin (`branchService.ts:82–100`). But the row (`webview.js:2499`) looks the same in all three cases:
   - only local;
   - local and on origin;
   - only on origin.

After this change:

- **A branch on origin is updated when clicked.** Clicking such a branch, the checked-out one included:
  1. fetches it;
  2. checks it out;
  3. fast-forwards it to origin.

  It changes nothing it cannot fast-forward, and says why.
- **The graph draws one label for both copies.** Where `x` and `origin/x` point at the same commit, the label is
  `x` with an `origin` chip.
- **Side Bar rows show where a branch lives.** A row of a branch on origin carries an `origin` chip. A branch only
  on this machine has none.

## Decisions

Decisions 1–4 were made by the user on 2026-11-23 (AskUserQuestion). Decision 5 onwards is the planner's.

1. **Where: both the graph and the Side Bar.**
2. **"Update from origin" is fetch, then fast-forward only.** A real `git pull` (which may merge or rebase by
   config) is rejected.
3. **Different commits keep two labels.**
   - Where `x` and `origin/x` point at different commits, the graph shows `x` at its commit and `origin/x` at its
     own, as now.
   - Only a pair at the same commit merges.
   - Rejected: one label with ↑↓ counts, which hides where origin is.
4. **The checked-out branch follows the same rule.** A click on it fetches and fast-forwards, then reloads the
   history.
5. **The checkout steps, on the host.** `checkoutBranch` without `replaceWithRemote` becomes `checkoutAndUpdate`.
   The remote branch is always `origin/<name>`, the same name, as the Side Bar's list and "Reset to origin" already
   assume. `name` is a branch that has, or is, `origin/<name>` (by `refs/remotes/origin/<name>` after the fetch):
   1. **Fetch.** Run `git fetch origin <name>`, with the normal credential handling of a manual Fetch (this is a
      click, not a background job).
      - A failed fetch (offline, auth) does not stop the checkout. It goes on with the last fetched
        `origin/<name>`, and the message says "Could not fetch origin; used origin/<name> as last fetched".
   2. **Check out.**
      - With no local `<name>`: `git checkout -b <name> --track origin/<name>`.
      - Otherwise `git checkout <name>`, unless it is already current.
      - A failed checkout (local changes in the way) is reported as now, and nothing else runs.
   3. **Compare and update.** Compare `<name>` with `origin/<name>` (`git rev-list --left-right --count`). The
      outcome is reported in the payload:

      | State | Action | Message | `update` |
      | --- | --- | --- | --- |
      | Equal | None | "<name> is up to date with origin" | `up-to-date` |
      | Behind only | `git merge --ff-only origin/<name>` | "Updated <name> by N commits from origin" | `fast-forwarded` |
      | Ahead only | None | "<name> has N commits not on origin" | `ahead` |
      | Diverged | None | "<name> and origin/<name> have diverged (A ahead, B behind). Use Pull or Reset to origin." | `diverged` |
      | Fast-forward refused (local changes to files it touches) | None; the branch stays checked out and the working tree is untouched | "Checked out <name>; not updated: local changes would be overwritten. Commit or stash them, then Pull." | `blocked` |

   - **A branch with no `origin/<name>`** (only local) is checked out as now. No fetch runs, and the `update` value
     is `local-only`.
   - `branchCheckoutResult` gains `update` and keeps `success` and `message`.
   - Rejected: updating the ref before checkout (`git fetch origin x:x`). It refuses the current branch, and it
     moves a branch without checking the working tree.
   - Rejected: honouring a differently named upstream (`@{upstream}`). The list and "Reset to origin" match by
     name today; a mixed rule would make the chip and the action disagree.
6. **The webview.**
   - `requestBranchCheckout` no longer returns early for the current branch. It posts the checkout, and after the
     result it reloads the history as before.
   - `pendingBranchCheckout` still prevents a second click while one runs.
   - "Reset to origin" (`replaceWithRemote`) is unchanged.
7. **The merged graph label.** `renderHistoryRefs` folds `remote-branch` `origin/x` into a `head` or
   `local-branch` `x` on the same commit:
   - **What it renders.** One `<button>` keeps the local ref's kind class, `data-branch="x"` and the text `x`. It
     appends `<span class="ref-origin">origin</span>`. Its `title` is "x and origin/x are at this commit.
     Double-click to check out x and update it from origin".
   - **What it leaves alone:**
     - an `origin/x` with no local `x` on that commit keeps its own label as now;
     - labels for other remotes (`upstream/x`) and `origin/HEAD` are unchanged;
     - tags are unchanged.
   - **The data is not changed.** `commit.refs` stays as the host sent it. History search and the graph model read
     the data, not the labels, so a search for `origin/x` still finds the commit. Only the drawing folds.
8. **The Side Bar chip.**
   - A branch row whose branch has `hasRemote` or `isRemote` gets `<small class="ref-origin">origin</small>` after
     its name. A branch only local gets none.
   - A remote-only row (`isRemote`) also gets the class `remote-only`, which mutes its name. Its `title` reads
     "x is only on origin. Click to create it here and check it out".
   - The chip uses the same colour token as `.ref-remote-branch` (`webview.css:778`). It is defined once and used in
     both views.
9. **Order relative to plans 13 and 14.** Plan 13 (label tones) and plan 14 (label menu, drag between labels) are
   drafts written against today's one-label-per-ref drawing. This plan goes first. Then:
   - **Plan 13.** The merged label takes `x`'s tone, as plan 13 already gives `origin/x` and `x` one tone.
   - **Plan 14.** The label menu and a drop on a merged label must offer both `x` and `origin/x` as targets. Its
     drafts get a "depends on plan 16" note now, and are revised before they are approved.
10. **Version.** This changes UI, so it is a **minor** bump: the next minor at merge. The CHANGELOG gets a
    `### Changed` entry (the labels and chips) and a `### Fixed` entry (checking out a branch on origin brings its
    new commits).

## Scope

In:

- `src/services/branchService.ts`: `checkoutBranch` without replace runs Decision 5. `replaceWithRemote` is
  unchanged.
- `src/handlers/webviewMessageHandler.ts:341`: passes `update` in `branchCheckoutResult`.
- `resources/webview.js`:
  - `requestBranchCheckout` (`:1613`), Decision 6;
  - `renderHistoryRefs` (`:1595`), Decision 7;
  - the branch row (`:2499`), Decision 8.
- `resources/webview.css`: `.ref-origin`, `.remote-only`.
- Tests, `CHANGELOG.md`, `package.json` (`npm version <next minor> --no-git-tag-version`).

Out:

- Remotes other than `origin`, and branches whose upstream has another name (Decision 5).
- The branch compare selects (`webview.js:1756`, "(remote)" suffix) and the create-branch base list.
- Pruning remote branches deleted on origin. That stays with the manual Fetch.
- Plan 13 and 14's own changes (Decision 9).

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/services/branchService.ts:174` `checkoutBranch`, `:182–199` replace path | Change the plain path; keep replace |
| `src/services/branchService.ts:82–100` one entry per name, `isRemote`, `hasRemote` | Keep |
| `src/handlers/webviewMessageHandler.ts:341` `handleCheckoutBranch` | Change: `update` in the result |
| `resources/webview.js:1585` `checkoutBranchFromRef`, `:1595` `renderHistoryRefs` | Change `renderHistoryRefs` |
| `resources/webview.js:1613` `requestBranchCheckout` (`:1616` early return) | Change |
| `resources/webview.js:2484–2501` Side Bar branch rows, "Reset to origin", delete | Change the row's name part only |
| `src/services/historyService.ts:27` `classifyRef` | Keep |
| `resources/webview.css:761–780` `.history-ref` kinds | Keep; add `.ref-origin` |

## Tech stack and constraints

Default (`AGENTS.md`):

- no new dependency;
- Git runs through `GitCommandService` as elsewhere;
- tests use real temporary repositories with a bare remote, as `src/test/pullChangesSmoke.js` does, and ignore
  the developer's global Git config;
- a new `src/test/*Smoke.js` is added to the `test` script.

## Acceptance criteria

- [ ] **The checkout and update** (`node src/test/branchCheckoutSmoke.js`, new). It sets up a bare `origin`, a
  `local` clone, and an `upstream` clone that pushes. Each case asserts the `update` value, the message, the branch
  checked out and its commit:
  - `x` is behind after `upstream` pushes 2 commits not yet fetched by `local`. Result `fast-forwarded`, `x` at the
    pushed commit, message says 2 commits. This proves the fetch ran.
  - No local `x`, and `origin/x` was pushed after `local`'s last fetch. `x` is created, tracks `origin/x`, and is
    at the pushed commit.
  - `x` is ahead by 1: result `ahead`, and `x` is unchanged.
  - Diverged (1 ahead, 1 behind): result `diverged`, `x` is unchanged, and the message names both counts.
  - Behind, with an uncommitted change to a file the update touches: result `blocked`. `x` is checked out and
    unchanged, and the working-tree file keeps its change.
  - Behind, with `origin`'s URL pointing at a missing path: the fetch fails. The checkout still runs against the
    last fetched `origin/x`, and the message says the fetch failed.
  - A local-only branch: result `local-only`. No `fetch` is run (record the Git argument lists through a wrapping
    `GitCommandService`).
  - The current branch, behind: result `fast-forwarded`.
  - `replaceWithRemote` still resets as before (the existing behaviour, re-asserted once).
- [ ] **The webview** (`npm run test:ui`):
  - **The graph.** The fixture gets a branch on origin at the same commit as local, and one where local is ahead.
    - The shared commit shows one `.history-ref` with the text `main` and a `.ref-origin` chip, and no separate
      `origin/main` label.
    - The ahead branch shows `x` at its commit and `origin/x` at its own.
    - A local-only branch label has no chip.
    - Searching the history for `origin/main` still finds the commit.
  - **The Side Bar.** Rows of branches on origin carry `.ref-origin`, and a remote-only row is `.remote-only`. A
    local-only row has neither.
  - **The current branch.** Clicking the current branch in the Side Bar posts `checkoutBranch`; today it posts
    nothing. Double-clicking a merged graph label posts `checkoutBranch` with `branch: "x"`.
  - **New screenshots,** numbered after plans 9–14's (53–55) to avoid a clash:
    - `56-history-origin-labels.png` and its light variant;
    - `57-sidebar-branch-origin-chip.png`.

    Existing history screenshots may change only where a pair merged; the report names each one.
- [ ] `npm run lint`, `npm test` and `npm run package` pass; CHANGELOG and version as in Decision 10.
- [ ] The commit identity check from `AGENTS.md` prints one line.

**Unverified until run in VS Code:** a fetch that needs credentials (an HTTPS remote with a credential helper, or
SSH with a passphrase) on a click.

## Risks

| Risk | Handling |
| --- | --- |
| A click moves a branch the person did not mean to update | Fast-forward only. Nothing is rewritten, ahead or diverged branches are left alone, and the message says what happened |
| A fetch hangs on a credential prompt | The same credential handling as the manual Fetch; the unverified case above |
| Dirty working tree | `merge --ff-only` refuses before touching files; the `blocked` case checks the file keeps its change |
| The checkout succeeds but the update fails, and the message hides it | Every outcome has its own `update` value and message; each one is tested |
| A merged label hides `origin/x` from plan 14's targets | Decision 9: plan 14 is revised on top of this plan before approval |

## Handoff

- Implement with `coder-handoff` (Sonnet, worktree), on this branch, after the user approves.
- Validate with `.github/skills/verify-repository-manager/SKILL.md`.
- Commit as the user's no-reply identity. Use no AI trailers.
