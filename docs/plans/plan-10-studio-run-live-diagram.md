# Plan 10 — See a run live in the workflow diagram and the Runs view

Status: draft
Date: 2026-11-22
Branch: `feat/studio-run-live-diagram`
Baseline: `main` at `4fe5d23e5d17283e1987a4ed31c452e0a5034ac9`
Target: `src/studio/studioCommands.ts`, `src/studio/workflowEditorProvider.ts`, `resources/studioEditor.js`, `resources/studioEditor.css`, `src/studio/runsView.ts`, `src/studio/runsPage.ts`, tests, `docs/agent-studio.md`, `CHANGELOG.md`, `package.json`

## Goal

The user reported on 2026-11-22: "can't see where it is". Only the Studio Chat's run card is live today (plan 3).

- **The Workflow Editor's diagram is static during a run.** Plan 3 left this out of scope: "Highlighting the
  running node in the workflow diagram".
- **The Runs view reads its runs only when it is shown** (`src/studio/runsView.ts:36`).

After this change:

- An open diagram of a running workflow marks each step as running, waiting, done, failed, skipped or not
  started, with a word as well as a colour.
- The diagram shows which run it is and the step count, and lets the person stop it.
- The Runs view updates while a run goes on, whether it was started from the chat, the editor, Run Workflow…
  or Resume.

## Decisions

1. **The run log stays the one source.** Both views subscribe to `RunStore.onLog`, as the chat does since plan 3.
   Step states come from `runTimeline` (`src/studio/runsReport.ts:120`), so the three views agree.
   - Rejected: a separate progress channel, because it would be a second definition of a step's state.
2. **Which run a diagram shows.** A diagram shows the newest run of this workspace that is running or waiting and
   whose `workflow.id` equals the open file's `id`.
   - When the file's hash differs from the run's `workflow.hash`, the banner says "Running an earlier version of
     this file". Steps whose ids are no longer in the file are listed in the banner, not drawn.
   - With no such run, nothing changes in the diagram.
   - Rejected: following runs by file path, because chat and library runs do not record a path.
3. **What the diagram shows.**
   - Each node gets a class (`run-running`, `run-waiting`, `run-done`, `run-failed`, `run-skipped`,
     `run-pending`) and a short word under its title: "Running · 0:42", "Waiting for you", "Done", "Failed",
     "Skipped". Elapsed time ticks on the page, as on the chat card.
   - A banner above the canvas reads: `<title> · Step k of n · started hh:mm`, with **Stop** while running and
     **Open in Runs**.
   - A failed node's error shows in its tooltip and in the side panel when the node is selected.
   - Editing stays possible during a run. The banner says the run uses the copy it started with.
   - Rejected: locking the editor during a run, because the run never reads the file again.
4. **Stop from anywhere.**
   - `StudioRuns` keeps each run that `drive()` is driving, with a cancel function, and exposes
     `stop(runId): boolean`.
   - The diagram's **Stop** and a new **Stop** on a running run in the Runs view call it.
   - It cancels the same signal as the notification's Cancel and the chat's Stop. The code step's undo is
     unchanged.
   - Rejected: Stop only where the run started, because the person may be looking at the diagram.
5. **Throttling.**
   - Each view posts at most every 250 ms, with a trailing post, as the chat does.
   - The Runs view refreshes only while visible, and on becoming visible.
   - The diagram's subscription lives as long as its panel.
   - Subscriptions are disposed with their view.
6. **Accessibility.** Run state is words, never colour alone. A visually hidden `role="status"` line in the editor
   changes only when a step starts or ends, as in the chat (plan 3 Decision 9).
7. **Version: the next minor** at merge. CHANGELOG `### Added`.

## Scope

In:

- `src/studio/studioCommands.ts`: the active-run registry, `stop(runId)`, and a way for views to get the store and
  the runs (`runs()` already returns the store).
- `src/studio/workflowEditorProvider.ts`: subscribe, compute `runTimeline` for the matched run, post `runState`,
  and handle `stopRun` and `openRuns`.
- `resources/studioEditor.js` and `resources/studioEditor.css`: node states, banner, ticking time, status line.
- `src/studio/runsView.ts` and `src/studio/runsPage.ts`: live refresh while visible, and **Stop** on a running run.
- Tests, `docs/agent-studio.md` (Visual editor and Runs view sections), `CHANGELOG.md`, `package.json`.

Out:

- Streaming model text (plan 12).
- Retry and skip (plan 11).
- Changing the log format or `runTimeline` (only bugs a test shows).

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/studio/engine.ts:200` `RunStore.onLog` | Keep, reuse |
| `src/studio/runsReport.ts:120` `runTimeline` | Keep, reuse |
| `src/studio/studioCommands.ts:37–51` `StudioRuns`, the `drive()` cancel (`:192–196`) | Change: registry, `stop` |
| `src/studio/workflowEditorProvider.ts:60–106` | Change |
| `resources/studioEditor.js:112` node rendering | Change: run classes and words |
| `src/studio/runsView.ts:32–77`, `src/studio/runsPage.ts:92` (Resume button) | Change |
| `src/test/studioEditorUi.js`, `src/test/studioRunsUi.js`, `src/test/studioCommandsSmoke.js` | Change: add cases |

## Tech stack and constraints

Default (`AGENTS.md`); webview pages stay plain browser JavaScript.

## Acceptance criteria

- [ ] **Diagram updates live.** With the editor open on a workflow file and a scripted run of the same id that logs
  `node`, `tool`, `done`, `node`, `waiting`, the posted `runState` steps go pending → running → done for the first
  node and running → waiting for the second. A run of another id posts nothing. Checked by a new case in
  `node src/test/studioCommandsSmoke.js`, or a new `src/test/studioEditorLiveSmoke.js` added to `npm test`.
- [ ] **Earlier version.** When the file's hash differs from the run's, the banner says "earlier version", and a
  step missing from the file is listed in the banner. Checked by the same test.
- [ ] **Stop from anywhere.**
  - `stop(runId)` on a running scripted run ends it `stopped` and returns true.
  - Called again, or on an unknown id, it returns false.
  - The diagram's `stopRun` message calls it.

  Checked by `node src/test/studioCommandsSmoke.js`.
- [ ] **Runs view live.**
  - While visible, appending log entries refreshes the view within 300 ms, at most once per 250 ms window.
  - While hidden, nothing is posted, and it refreshes on becoming visible.
  - A running run has **Stop**.

  Checked by `node src/test/studioRunsSmoke.js` (or a new smoke test) and `studioRunsUi.js`.
- [ ] **Subscriptions end.** Closing the editor panel or the view disposes its subscription: a later entry posts
  nothing and throws nothing. Checked by the same tests.
- [ ] **Page.**
  - Node words and classes for each state.
  - The banner with Stop and Open in Runs.
  - The ticking time.
  - The status line changes only on a step change.

  Checked by
  `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui`, with new
  screenshots `33-studio-editor-run-live.png` (dark) and `34-studio-editor-run-live-light.png`. Existing
  screenshots 30–32 and 50–52 are unchanged, or every difference is explained.
- [ ] **Failure first.** With the editor's subscription removed, the "diagram updates live" case fails. Report the
  message, then restore.
- [ ] **Required checks pass:**
  - `npm ci`;
  - `npm run lint` (0 errors; 2 known warnings);
  - `npm test`;
  - `test:ui` twice;
  - `npm run package`.
- [ ] **Unverified until run in VS Code** (say so): a real run seen in the diagram while it runs, and Stop from the
  diagram during a real model call.

## Risks

| Risk | How it is handled |
| --- | --- |
| A busy run floods the webviews | 250 ms throttle; posts carry step states and the last activity line only |
| Two runs of one workflow at once | The newest running or waiting one is shown; the banner names it, and Open in Runs lists all |
| Stop while a modal approval is open | The signal is checked at approval boundaries already (plan 3); the modal's own answer still applies |
| A leaked subscription posts to a disposed webview | Disposed with the panel or view; test with an entry after close |

## Open questions

None.
