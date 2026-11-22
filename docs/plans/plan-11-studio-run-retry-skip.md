# Plan 11 — Retry or skip the step a run failed or stopped at

Status: draft
Date: 2026-11-22
Branch: `feat/studio-run-retry-skip`
Baseline: `main` at `4fe5d23e5d17283e1987a4ed31c452e0a5034ac9`
Target: `src/studio/engine.ts`, `src/studio/studioCommands.ts`, `src/studio/studioChat.ts`, `src/studio/runsView.ts`, `src/studio/runsPage.ts`, `src/studio/runsReport.ts`, `resources/studioChat.js`, tests, `docs/agent-studio.md`, `CHANGELOG.md`, `package.json`

## Goal

The user reported on 2026-11-22: "recovering is clumsy". Today a run that fails or stops can only be started again
from the beginning:

- a failed run has status `failed`, and its failed node is `failed` (`src/studio/engine.ts:468`);
- a stopped run has status `stopped`, with its stopping node left `pending` (`:477`);
- a run cut short by a closed window is marked `failed` with `interrupted` by recovery (`:108–133`);
- only a `waiting` run can be resumed (`src/studio/runsPage.ts:92`).

After this change, such a run offers two actions on the step it ended at:
- **Retry this step**: run it again, then go on.
- **Skip this step**: mark it skipped and go on.

Both keep every step already done and its output.

## Decisions

1. **Retry and skip use the run's own copy of the workflow** (the user's choice, 2026-11-22), the one `RunStore`
   saved when the run started (`loadWorkflow`).
   - A changed file does not matter. To change a step, edit the file and start a new run.
   - Rejected: using the current file.
   - Rejected: asking each time.
2. **Only the step the run ended at.**
   - For a failed run, this is the failed node.
   - For a stopped or interrupted run, it is the first node in run order (`runOrder`, `src/studio/workflow.ts:131`)
     that is not `done` or `skipped`.
   - Rejected: retrying any earlier step, because steps after it already wrote files and their outputs fed later
     steps. Undoing that chain is a different feature.
3. **Engine API**, which is pure state changes and is saved and logged.
   - **`WorkflowEngine.retry(state, workflow)`:**
     1. sets the step to `pending`;
     2. clears `state.error`;
     3. removes that step's recorded gate or effect answer from `state.approvals`, so it asks again;
     4. keeps `attempts` and `feedback`, so a code step's attempt count goes on;
     5. sets the status to `running`;
     6. logs `{ type: 'retry', node, by: 'person' }`.

     Then the caller runs `continue` as Resume does.
   - **`WorkflowEngine.skip(state, workflow)`:**
     1. sets the step to `skipped`;
     2. logs `{ type: 'skip', node, by: 'person' }`;
     3. sets the status to `running`.

     Steps whose only incoming edges come from it are then skipped by the engine's existing rule
     (`engine.ts:347–356`).
   - Both refuse, with a reason, a run that is `running`, `waiting` or `done`, and a step that is not the one in
     Decision 2.
4. **Skip is refused when a later step reads the step's output.** Using `referencesIn`
   (`src/studio/expressions.ts:58`), if any node after it in run order references `<id>.output…` in `with`,
   `forEach` or an edge `when`, skip is refused.
   - The message names those steps: "Skip is not possible: <titles> use this step's output. Retry it, or start a
     new run."
   - **Skip** is shown disabled, with that reason as its title.
   - Rejected: allowing skip and letting later steps fail, because the failure would come later and be harder to
     read.
5. **Where the actions appear.**
   - **The Studio Chat's run card** of a failed, stopped or interrupted run: **Retry <step>** and
     **Skip <step>**. The card goes live again, as in plan 3, and the chat locks while the run continues.
   - **The Runs view's run detail:** the same two buttons.
   - **The "… failed" notification:** a **Retry step** button. It is not awaited, as plan 2 requires.
   - Each goes through `StudioRuns.retry(runId)` and `StudioRuns.skip(runId)`, which load the run and its saved
     workflow, call the engine, then `drive()` with the same progress, the stop registry if plan 10 has landed,
     and the done handling as Resume.
6. **The record.** `runTimeline` shows a retried step's earlier failure and its new outcome, so the step lists
   "failed, retried, done". A skipped step reads "Skipped by you", apart from "Skipped" for an edge condition not
   met. The completion rate in the Runs view counts a run by its final status, unchanged.
7. **Version: the next minor** at merge. CHANGELOG `### Added`.

## Scope

In:

- `src/studio/engine.ts`: `retry`, `skip`, and the checks in Decisions 2 and 4.
- `src/studio/studioCommands.ts`: `StudioRuns.retry` and `skip`, and the notification button.
- `src/studio/studioChat.ts`, `resources/studioChat.js` and `resources/studioChat.css`: card buttons, and the
  `retryRun` and `skipRun` messages.
- `src/studio/runsView.ts` and `src/studio/runsPage.ts`: the detail buttons.
- `src/studio/runsReport.ts`: `retry` entries and skips by the person in the timeline.
- Tests, `docs/agent-studio.md` (Runs view and run card), `CHANGELOG.md`, `package.json`.

Out:

- Retrying an earlier step, or from an arbitrary point.
- Retrying with the current file.
- Editing a step's settings before a retry.
- Plan 10's live diagram (its stop registry is used if present, not required).

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/studio/engine.ts:286` `answer`, `:332` `continue`, `:468` `fail`, `:477` `stop`, `:108–133` recovery | Keep; add `retry` and `skip` |
| `src/studio/engine.ts:347–356` edge rule (skip when no taken edge) | Keep, reuse |
| `src/studio/expressions.ts:58` `referencesIn`, `src/studio/workflow.ts:131` `runOrder` | Keep, reuse |
| `src/studio/studioCommands.ts:278` `resume` | Keep; `retry` and `skip` follow its shape |
| `src/studio/runsPage.ts:92` (Resume button) | Change: add Retry and Skip |
| `resources/studioChat.js:219` `runCard` | Change |
| `src/studio/runsReport.ts:120` `runTimeline` | Change: retry and person-skip entries |

## Tech stack and constraints

Default (`AGENTS.md`).

## Acceptance criteria

The engine tests run with `node src/test/studioEngineSmoke.js`.

- [ ] **Retry a failed step.** In a three-step scripted workflow whose second step fails once:
  - `retry` then `continue` ends `done`;
  - the first step ran once, the second twice, the third once;
  - the first step's output is unchanged;
  - the log has `retry`.
- [ ] **Retry after a stop.**
  - Stopped at a gate (rejected): `retry` asks the gate again, because its approval was removed.
  - Stopped at a code step's review: `attempts` keeps counting.
- [ ] **Retry an interrupted run.** A run marked interrupted by recovery can be retried from its interrupted node.
- [ ] **Skip.** Skipping a failed step that no later step reads ends `done`. A step reached only through an edge
  from it is skipped too.
- [ ] **Skip refused.**
  - When a later step references `<id>.output`, skip throws with the names of those steps, and state and log are
    unchanged.
  - On a `done` or `waiting` run, both are refused.
  - For a node other than the one in Decision 2, both are refused.
- [ ] **Commands and UI.**
  - `StudioRuns.retry(runId)` drives the run to its end.
  - The failed notification offers **Retry step** without being awaited.

  Checked by `node src/test/studioCommandsSmoke.js`.
- [ ] **Chat.**
  - A failed run card gets `retryRun` and `skipRun`.
  - `retryRun` relocks the chat and updates the same card to `done`.
  - The saved chat keeps one run card, not two.

  Checked by `node src/test/studioChatSmoke.js`.
- [ ] **Timeline.** A retried step reads "failed, retried, done". A skip by the person reads "Skipped by you".
  Checked by `node src/test/studioRunsSmoke.js`.
- [ ] **Page.** The buttons on a failed card and in the Runs detail, and Skip disabled with its reason. Checked by
  `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui`, with new
  screenshots `54-studio-chat-run-failed-actions.png` and `53-studio-run-failed-actions.png` (Runs view). Other
  screenshots unchanged, or each difference explained.
- [ ] **Failure first.** With the approval removal in `retry` left out, the gate case fails. Report the message.
- [ ] **Required checks pass:**
  - `npm ci`;
  - `npm run lint` (0 errors; 2 known warnings);
  - `npm test`;
  - `test:ui` twice;
  - `npm run package`.
- [ ] **Unverified until run in VS Code** (say so): retrying a real code step after a model failure.

## Risks

| Risk | How it is handled |
| --- | --- |
| A retried `forEach` step re-runs items that already wrote files | It re-runs the whole step, as a first run would; `file.write` rewrites the same targets; the review shows code-step changes again. Said in the docs |
| Retrying a step whose effect was approved repeats it silently | Its approval is removed, so it asks again (Decision 3) |
| A skip breaks later steps | Refused when a later step reads its output (Decision 4) |
| Two retries of one run at once | `StudioRuns` refuses a run it is already driving |

## Open questions

None.
