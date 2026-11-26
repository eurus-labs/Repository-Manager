# Plan 18 — Switch branches in half a second: check out first, update from origin after

Status: implemented
Date: 2026-11-26
Branch: `feat/branch-switch-fast-checkout`
Baseline: `main` at `3fdaa631d2d159fa3fb9a9840e3c786d88263836` (3.9.0, released)
Target: `src/services/branchService.ts`, `src/handlers/webviewMessageHandler.ts`, `src/repositoryManagerPanel.ts`,
`src/openTimings.ts`, `resources/webview.js`, `src/test/branchCheckoutSmoke.js`, `src/test/branchSwitchLatencySmoke.js`
(new), `src/test/autoFetchPanelSmoke.js`, `src/test/uiSnapshots.js`, `package.json`, `CHANGELOG.md`

Supersedes plan 16's Decision 5 order (fetch before checkout) for branches that already exist locally, and
Decision 6's lock duration (the click stays locked until the update is done). Plan 16's outcomes, messages and the
three fixes from its review (no path checkout, full ref names, `--no-autostash`) are kept.

## Goal

The user asked on 2026-11-26 to bring switching a branch down to 0.5 s. They see 1–3 s today on Windows.

**What happens now.** Measured on 2026-11-26 with `main` at `3fdaa63`. The script ran the handler's real order on a
parent repository with two linked repositories, 300 commits and a bare `origin`:

| Step, in order | Git processes | 0 ms per process (Linux) | 100 ms per process (Windows-like) |
| --- | --- | --- | --- |
| `checkoutBranch`: rev-parse ×2, fetch, symbolic-ref, checkout, rev-list | 6, one after another | 61 ms | 665 ms |
| `ctx.refresh()`: every repository's status, **before** the result is posted | 8 | 30 ms | 533 ms |
| Webview asks for history and refs; they run together | 7 | 16 ms | 129 ms |
| **New history drawn** | 21 | 107 ms | **1 327 ms** |

- **The network fetch is on top of that.** On this machine, close to GitHub, `git fetch origin <branch>` alone took
  262–302 ms against `github.com`. A real Windows machine is slower.
- **A click can also wait for a background fetch.** Every action that is not read-only waits for a running
  auto-fetch (`_handleMessage`, `repositoryManagerPanel.ts:553`). Auto-fetch starts when the dashboard becomes
  visible (`onDidChangeViewState`, `:257`) and runs `fetch --all --prune` for each repository in turn. So the first
  click after switching to the dashboard can wait for a whole network fetch.
- **The 100 ms per process is an assumption.** It stands in for a Windows process start with a virus scanner. It was
  not measured on Windows.

**The minimum value.** A click on a branch that exists locally draws that branch's history within 0.5 s. Bringing new
commits from origin, as plan 16 does, happens afterwards and is reported when it is done.

## Decisions

Decision 1 was made by the user on 2026-11-26 (AskUserQuestion). The rest are the planner's.

1. **Check out first, update from origin after.** The click checks out the local branch and the new history is
   drawn. Then fetch, compare and fast-forward run in the background, against the copy origin has now.
   - Rejected: skipping the fetch when origin was fetched recently. That only meets 0.5 s when a fetch happened to
     run just before.
   - Rejected: keeping fetch first and only trimming local work. The network time stays in the wait.
2. **What the 0.5 s measures.**
   - **Start:** the click is posted (`checkoutBranch`).
   - **End:** the page has drawn the new branch's history.
   - **Branches covered:** branches that already exist locally, including the current one. A remote-only branch is
     covered by Decision 4.
   - **Proxy check.** The budget is checked with an injected cost of 100 ms per Git process:
     - at most 2 Git processes run one after another before the result is posted;
     - then one level of processes running together for the history and the refs;
     - no `fetch` before the result;
     - no wait for auto-fetch.
   - **Real check:** the user's own Windows measurement, through the timings output (Decision 8).
3. **The critical path, on the host.** For a branch that exists locally, `handleCheckoutBranch`:
   1. **Reads** in one Git process what it needs: whether `refs/heads/<name>` exists, the current branch, and whether
      an operation is pending.
   2. **Checks out** with `git checkout <name> --`, in one process, unless the branch is already current. A failed
      checkout is reported as now, and nothing else runs.
   3. **Posts** `branchCheckoutResult` (`success`, `message`, `update: 'pending'`) at once. It does not wait for
      `ctx.refresh()`.
   4. **Then, without the page waiting:** it starts `ctx.refresh()` and the background update (Decision 5).
4. **A remote-only branch keeps fetch first.** A click on an `isRemote` row creates the branch, so it still runs plan
   16's order: fetch, then `checkout -b <name> --track refs/remotes/origin/<name>`, then compare.
   - **Why:** creating the branch from a stale, or deleted, `origin/<name>` and correcting it afterwards would leave a
     wrong branch behind for a moment, or for good when origin has deleted it.
   - **Cost:** it is a rare action. It is the only click that waits for the network, and it is outside the 0.5 s
     target.
5. **The background update.** It runs after the result is posted. For a branch with `refs/remotes/origin/<name>`, the
   rule is plan 16's:
   1. **Wait for auto-fetch, then fetch.** If an auto-fetch is running, wait for it to finish; its fetch is used
      instead of a second one. Otherwise run `git fetch origin +refs/heads/<name>:refs/remotes/origin/<name>`.
      - If the fetch fails, the update goes on with the last fetched copy, and the message says so.
      - If origin no longer has the branch, that one stale tracking ref is deleted and the outcome is `local-only`.
   2. **Compare** `refs/heads/<name>...refs/remotes/origin/<name>`.
   3. **Fast-forward** with `merge --ff-only --no-autostash refs/remotes/origin/<name>` when the branch is only
      behind.

   **Guards before the fast-forward.** These are the new part. The fast-forward runs only if all of these hold:
   - **No newer click.** No later checkout started in this repository. Each checkout takes a new per-repository
     number, and an update whose number is no longer the latest stops after its fetch.
   - **HEAD still on the branch.** `HEAD` is still `refs/heads/<name>`, checked right before `merge`, not before the
     fetch.
   - **No Git operation pending,** such as a merge, rebase, cherry-pick or revert.

   If a guard fails, the update ends without a fast-forward, and its result is not shown as a failure; the newer
   click reports its own. Without these guards, clicking `x` and then `main` while `x`'s fetch is running would
   fast-forward `main` onto `origin/x` when `x` descends from `main`.

   The outcome is posted as a new message, `branchUpdateResult`, with `repositoryPath`, `branch`, `update` and
   `message`. The `update` values are plan 16's: `up-to-date`, `fast-forwarded`, `ahead`, `diverged`, `blocked` or
   `local-only`.
6. **The webview.**
   - **The lock.** `pendingBranchCheckout` is released when `branchCheckoutResult` arrives, as now. That result now
     comes before the fetch, so the lock lasts only for the checkout.
   - **The current branch.** A click on it still reloads its history at once, as plan 16 made it. When the result
     says nothing was checked out (`unchanged: true`), the page does not ask for the history a second time.
   - **On `branchUpdateResult` with `fast-forwarded`,** for the active repository and the branch it still shows, the
     page reloads the history and the refs with `preserveViewport`.
   - **Other outcomes** change no data and reload nothing.
7. **What the person is told.** Today `showResult` shows a notification for every checkout. With two steps that would
   be two notifications per click. Instead:
   - **The checkout:** nothing on success, because the graph and the Side Bar change at once. A failure is an error,
     as now.
   - **The update:**
     - `fast-forwarded`: an information message, "Updated x by N commits from origin".
     - `diverged`, `blocked`, or a failed fetch: a warning, with plan 16's text.
     - `up-to-date`, `ahead`, `local-only`: nothing.
8. **Timings.** `repositoryManager.debug.timings` already writes the steps of opening the dashboard to the
   **Repository Manager Timings** output (`src/openTimings.ts`). Extend it to branch switches:
   - one line when the click arrives;
   - one when the checkout is done;
   - one when the result is posted;
   - one when the page has drawn the new history: the page posts a mark, as it does for opening;
   - one when the update ends, with its outcome;
   - every Git process, with its duration, as for opening.

   The user then reads the real Windows time in VS Code.
9. **Version.** The click now updates from origin after the checkout instead of before it, and the notifications
   change. That is a user-visible change, so it is a **minor** bump: 3.10.0. The CHANGELOG gets `### Changed`.

## Scope

In:

- `src/services/branchService.ts`:
  - split `checkoutAndUpdate` into a checkout step (Decisions 3 and 4) and an update step (Decision 5);
  - keep the three fixes from plan 16's review.
- `src/handlers/webviewMessageHandler.ts`, `handleCheckoutBranch`: post the result before refreshing, start the
  update, post `branchUpdateResult`, and send the notifications of Decision 7.
- `src/repositoryManagerPanel.ts`:
  - `checkoutBranch` does not wait for a running auto-fetch;
  - the update step waits for it;
  - the per-repository click number;
  - timing marks.
- `src/openTimings.ts`: branch-switch marks (Decision 8).
- `resources/webview.js`: `requestBranchCheckout` and the `branchCheckoutResult` handler; the new
  `branchUpdateResult` handler; the "history drawn" mark for a switch.
- Tests, `CHANGELOG.md`, `package.json` (`npm version 3.10.0 --no-git-tag-version`).

Out:

- "Reset to origin" (`replaceWithRemote`). It keeps its confirmation and runs as now.
- Making `ctx.refresh()` or the history and refs queries cheaper. They are off the critical path or already run
  together; widen scope only if the budget test shows they block it.
- Auto-fetch's own schedule and its `fetch --all --prune`.
- Plan 16's labels and chips.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/services/branchService.ts` `checkoutAndUpdate` (fetch → checkout → compare → fast-forward) | Change: split into checkout and update; remote-only rows keep the order |
| `src/handlers/webviewMessageHandler.ts:341` `handleCheckoutBranch` (awaits checkout, then `ctx.refresh()`, then posts) | Change: post first, then refresh and update |
| `src/handlers/handlerSupport.ts:44` `showResult` | Keep; the checkout handler calls it per Decision 7 |
| `src/repositoryManagerPanel.ts:547` `_handleMessage`: actions wait for `_autoFetchRun` | Change for `checkoutBranch` only; other actions keep waiting |
| `src/repositoryManagerPanel.ts:333` `_autoFetchIfDue` | Keep |
| `src/openTimings.ts` `OpenTimings` (steps of opening, every Git process) | Change: branch-switch marks |
| `resources/webview.js:1624` `requestBranchCheckout`, `:3085` `branchCheckoutResult` handler | Change |
| `src/test/branchCheckoutSmoke.js` (plan 16 outcomes and the review fixes) | Change: drive checkout, then update; same outcomes |

## Tech stack and constraints

Default (`AGENTS.md`):

- no new dependency;
- Git runs through `GitCommandService`;
- tests use real temporary repositories with a bare `origin` and ignore the developer's global Git config;
- a new `src/test/*Smoke.js` is added to the `test` script.

## Acceptance criteria

- [ ] **The budget** (`node src/test/branchSwitchLatencySmoke.js`, new).
  - **Fixture:** a parent with two linked repositories, 300 commits, and a bare `origin` that is one commit ahead
    on `x`.
  - **Injected cost:** every `GitCommandService` process waits 100 ms before running.
  - **The test** runs the real `handleCheckoutBranch` with a recording context, and answers the page's history and
    refs requests as the panel does. It asserts:
  - from the call to `branchCheckoutResult` posted: at most 2 Git processes in series, under 300 ms, no `fetch`
    among them, and `ctx.refresh()` not started yet;
  - from the call to history and refs for `x` returned: under 500 ms;
  - `branchUpdateResult` then arrives with `fast-forwarded`, and `x` is at origin's commit;
  - **failing first:** on `main` at `3fdaa63` this test fails. Record the measured times in the PR.
- [ ] **Two clicks** (in the same file). Make `x`'s fetch slow by delaying only `fetch`.
  - Click `x` while `origin/x` is ahead, then click `main` before that fetch ends.
  - Neither `main` nor `x` is fast-forwarded by `x`'s update, and `origin/x` is still updated.
  - `x`'s update posts no warning.
  - **Failing first,** against an update with no guards.
- [ ] **Plan 16's outcomes still hold** (`src/test/branchCheckoutSmoke.js`). Each case drives the checkout, then the
  update, and asserts the same `update` value, message, branch and commit as before:
  - `fast-forwarded`, `up-to-date`, `ahead`, `diverged`, `blocked`;
  - a failed fetch;
  - deleted on origin;
  - local-only (no `fetch`);
  - the current branch;
  - the three review cases: the path-named branch, the tag of the same name, `merge.autoStash`.

  A remote-only row still fetches first (Decision 4). List in the PR each case whose steps changed.
- [ ] **A guard per condition.** Before the `merge`:
  - HEAD moved to another branch (a direct `git checkout` in the test): no fast-forward;
  - a merge in progress: no fast-forward.
- [ ] **Auto-fetch** (`src/test/autoFetchPanelSmoke.js`). While a held auto-fetch is running:
  - `checkoutBranch` posts its result without waiting for it;
  - the update step waits for it and runs no second fetch when that fetch covered `origin/<name>`.
- [ ] **Notifications** (Decision 7). Through the recording context:
  - a checkout followed by `up-to-date` shows no message;
  - `fast-forwarded` shows one information message;
  - `diverged` shows one warning;
  - a failed checkout shows one error.
- [ ] **The webview** (`npm run test:ui`):
  - the click lock is released on `branchCheckoutResult`, before any `branchUpdateResult`;
  - a click on the current branch asks for its history once;
  - `branchUpdateResult` with `fast-forwarded` reloads the history and the refs, and other outcomes do not;
  - an update result for a branch no longer shown changes nothing.
- [ ] **Timings.** With `repositoryManager.debug.timings` on, a switch writes the marks of Decision 8 in order.
  Assert it through the recording writer.
- [ ] `npm run lint`, `npm test`, `npm run test:ui` and `npm run package` pass. CHANGELOG and version follow
  Decision 9.
- [ ] The commit identity check from `AGENTS.md` prints one line.

**Unverified until run in VS Code on Windows:** the real time from click to drawn history. The user reads it in the
Timings output (Decision 8). The 100 ms per process in the test is an assumption.

## Risks

| Risk | Handling |
| --- | --- |
| The background update moves a branch the person has left | Decision 5's guards (click number, HEAD rechecked right before `merge`, no pending operation); the two-click test |
| A short window between the HEAD check and `merge` | It lasts milliseconds, with no network in it. `merge --ff-only` itself refuses anything but a fast-forward of the current branch. Accepted |
| The page shows the branch before origin's new commits arrive, and the person acts on stale history | The update reloads the history when it fast-forwards and says so (Decisions 6 and 7). Until then the branch is exactly what plan 16 showed when origin could not be reached |
| A checkout no longer waits for auto-fetch, and the two race for a lock | The checkout writes `HEAD` and the index; the fetch writes `refs/remotes/*` and `FETCH_HEAD`. The update, which writes `refs/heads/<name>`, still waits for it (Decision 5) |
| The 100 ms per process does not match the user's Windows machine | The budget counts processes in series, not only milliseconds. The user measures the real time through Timings (Decision 8) |
| The repository list (ahead/behind, status) lags the switched branch for a moment | `ctx.refresh()` still runs right after the result; only the page no longer waits for it |
| Fewer notifications hide an outcome | Each outcome that needs action (`diverged`, `blocked`, a failed fetch) is still a warning; a quiet outcome leaves the branch as it was |

## Open questions

None.
