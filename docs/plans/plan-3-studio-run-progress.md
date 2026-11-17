# Plan 3 — Show a Studio run's progress and activity in the chat, and stop it there

Status: draft
Date: 2026-11-17
Branch: `feat/studio-run-progress`
Baseline: `main` at `3b5490e3016544e6f3c857cda4da9d556d860449` — rebase onto `main` after plan 2 (3.4.1) merges; both change `drive()` and `CHANGELOG.md`
Target: `src/studio/engine.ts` (`RunStore`), `src/studio/studioCommands.ts`, `src/studio/studioChat.ts`, `src/studio/chatStore.ts`, `resources/studioChat.js`, `resources/studioChat.css`, tests, `docs/agent-studio.md`

## Goal

While a plan runs from the Studio Chat, the person sees which step is running, for how long, what it is doing
inside (model calls, tool calls such as files read and edited, checks), which steps are done, skipped, waiting
or failed, and can stop the run from the chat. Today the run card says only "Running…", the progress
notification shows only the workflow's title, and the only Stop is the notification's Cancel. This is option 3
chosen by the user on 2026-11-17 (step list + inner activity). Shipped as 3.5.0.

## Decisions

1. **The run log is the one source of progress.** `RunStore` notifies listeners of each entry it appends,
   exactly as written (with its `at`): `onLog(listener: (runId, entry: RunLogEntry) => void): { dispose() }`.
   The engine and the steps already log every fact needed (`node`, `skills`, `model`, `tool`, `check`,
   `branch`, `read`, `waiting`, `approval`, `review`, `done`, `skip`, `finish`) — rejected: new progress
   callbacks through the engine and every step, and a persisted `running` node status, because the first
   duplicates the log and the second changes what recovery after a closed window (#140) reads.
2. **Step status comes from `runTimeline()`** (`src/studio/runsReport.ts:120`) over the run's state and the
   entries seen so far, with the plan for titles — rejected: a second fold of the log in the chat, because
   two definitions of running, waiting and done would drift from the Runs view.
3. **`StudioRuns.run` takes options**: `run(workflow, hash, onUpdate?, options?: { onLog?(entry), signal? })`.
   `drive()` subscribes to the store for that run's id only, forwards entries to `onLog`, and disposes the
   subscription when it returns (also on error). `resume` and the editor's Run pass nothing and behave as
   today, except for Decision 4.
4. **The progress notification names the step**: `progress.report({ message })` with
   `Step <k>/<n>: <title>` and, when there is one, the latest activity line (Decision 5); `n` counts the
   nodes in run order, skipped ones included. This applies to every run `drive()` runs.
5. **Activity lines are short text made from log entries**, the same function for the card and the
   notification, in `src/studio/runsReport.ts` (pure, no `vscode`): `tool` → `<name> <note>` (✗ and "failed"
   when `ok` is false), `model` → `Model <model> answered` (with tokens in/out when present), `check` →
   `Check <script> passed|failed (exit <code>)`, `branch` → `On branch <name>` (`, created` when new),
   `read` → `Read <files> files`, `skills` → `Skills: <names>`. Other entry types make no line. Tool input
   and file contents are never shown — rejected: showing tool inputs or diffs, because the review dialog
   already shows the diff and inputs can be long or hold text from files.
6. **The run card shows**: each step in run order with an icon and a word (Done, Running · m:ss, Waiting for
   you, Skipped, Failed, Stopped, Not started — never colour alone); under the running step its last 5
   activity lines; a collapsed "Activity (N)" with every kept line of the run. The elapsed time ticks on the
   page once a second from the step's start `at`; the host sends nothing per tick.
7. **Stop in the chat**: while a run is running, Send reads Stop (as it does while drafting) and sends
   `cancel`; the chat passes a signal that is cancelled by it or by the notification's Cancel. A step stops
   where it already checks the signal (code steps poll every 200 ms; prompt steps between calls) —
   rejected: Stop on the notification only, because the person is looking at the chat. Whether Stop asks
   first is an open question below.
8. **Throttle and persist sparingly**: the host posts to the page at most every 250 ms (with a trailing
   post); it saves the conversation when a step starts or ends and when the run ends, not per activity line.
   `ChatRun` gains `steps?: Array<{ id, title?, outcome, executionMs?, error? }>` and
   `activity?: Array<{ at, node, text, ok? }>`; the card keeps up to 200 lines while running, the saved chat
   the last 50. Chats saved before this render as today.
9. **The page keeps the reader's place**: re-rendering scrolls to the bottom only when the thread was
   already at the bottom; the activity lists are `aria-live="off"`, and one visually hidden `role="status"`
   line changes only when a step starts or ends ("Step 2 of 6, Phân tích thay đổi: running").
10. **Version 3.5.0** (user-visible feature, after 3.4.1), CHANGELOG `### Added`; `docs/agent-studio.md`
    describes the run card and Stop.

## Scope

In:

- `src/studio/engine.ts`: `RunStore.onLog` (Decision 1).
- `src/studio/runsReport.ts`: `activityLine(entry)` (Decision 5); `runTimeline` reused unchanged.
- `src/studio/studioCommands.ts`: `StudioRuns.run` options, subscription in `drive()`, progress messages,
  combined cancel signal (Decisions 3, 4, 7).
- `src/studio/studioChat.ts`: keeps the entries of the current run, computes steps with `runTimeline`,
  throttled posts, saves on step changes, `cancel` while running (Decisions 2, 7, 8).
- `src/studio/chatStore.ts`: `ChatRun.steps`, `ChatRun.activity`.
- `resources/studioChat.js`, `resources/studioChat.css`: the run card, the ticking time, Stop, scroll and
  status line (Decisions 6, 7, 9).
- Tests (Acceptance criteria), `CHANGELOG.md`, `package.json` 3.5.0, `docs/agent-studio.md`.

Out:

- Live refresh of the Runs view (it can subscribe to `onLog` later).
- Streaming the model's text as it is written; showing tool inputs or diffs.
- Highlighting the running node in the workflow diagram.
- Changing what steps log, the log format, or recovery (#140).
- The "done." notification (plan 2).

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/studio/engine.ts:175` `RunStore.log` (appends `{ at, ...entry }`) | Change: notify listeners after the append |
| `src/studio/engine.ts:382, 434` (`node` entry; steps log through `context.log`) | Keep |
| `src/studio/codeStep.ts:140, 154, 224–228, 261` (`model`, `tool`, `branch`, `check` entries) | Keep |
| `src/agent/agentTools.ts` tool notes (`file:1-40`, `"query" (n)`, edited file, `script: passed`) | Keep: they are the activity text |
| `src/studio/runsReport.ts:120` `runTimeline` | Keep, reuse |
| `src/studio/studioCommands.ts:37` `StudioRuns.run`, `:147–198` `drive()`, `:154` `withProgress` | Change |
| `src/studio/studioChat.ts:252–287` `run()`, `:177` `cancel` (drafting only), `:427` `post()` | Change |
| `src/studio/chatStore.ts:22` `ChatRun` | Change: two optional fields |
| `resources/studioChat.js:154` `runCard`, `:191–193` Send/Stop | Change |
| `src/test/studioChatSmoke.js`, `src/test/studioChatUi.js` (scripted `runs.run`), `src/test/studioCommandsSmoke.js`, `src/test/studioEngineSmoke.js` | Change: add cases |

## Tech stack and constraints

Default (`AGENTS.md`): webview script stays plain browser JavaScript; no `alert`/`confirm`/`prompt` in the page.

## Acceptance criteria

- [ ] `RunStore.onLog` gives each appended entry with its `at`, for any run, and stops after `dispose()` — `node src/test/studioEngineSmoke.js`.
- [ ] `drive()` forwards only its run's entries and unsubscribes when it returns or throws; progress messages read `Step 1/2: <title>` then include an activity line — `node src/test/studioCommandsSmoke.js` (record `progress.report` calls).
- [ ] `activityLine` gives the Decision 5 text for each entry type, and nothing for others — `node src/test/studioRunsSmoke.js` (or the existing runs report test).
- [ ] The chat posts steps and activity while running: a scripted `runs.run` emitting `node`, `tool`, `check`, `done` entries yields posted `run.steps` going pending → running → done, and `run.activity` lines in order — `node src/test/studioChatSmoke.js`.
- [ ] Stop: a `cancel` message while running cancels the signal given to `runs.run`; the scripted run ends `stopped` and the chat unlocks — `node src/test/studioChatSmoke.js`.
- [ ] Saves are sparse: 20 `tool` entries inside one step cause no more saves than step changes + run end (count `ChatStore.save` calls) — `node src/test/studioChatSmoke.js`.
- [ ] Failure case: with the `onLog` forwarding removed from `drive()`, the chat and commands tests fail (report messages); restored, they pass.
- [ ] Failure case: an entry of another run id arriving during the run changes nothing on the card — `node src/test/studioChatSmoke.js`.
- [ ] Old chats: a saved `ChatRun` without `steps`/`activity` renders as before — `src/test/studioChatUi.js` (existing `43-studio-chat-run` byte-identical to `main`, or differences explained).
- [ ] Page: a running card shows the steps with words, the running step's time and last 5 lines, "Activity (N)", Stop instead of Send; the thread does not jump when scrolled up; the status line changes only on a step change — `npm run test:ui` with new screenshots `46-studio-chat-run-progress` (dark) and `47-studio-chat-run-progress-light`.
- [ ] Required checks pass — `npm ci`, `npm run lint` (0 errors; 2 known warnings), `npm test`, `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui` twice, `npm run package`.
- [ ] Unverified until run in VS Code (say so in the report): real Copilot code steps producing the activity, and Stop during a real model call.

## Risks

| Risk | How it is handled |
| --- | --- |
| Many tool calls flood the page and the disk | Decision 8 throttle and caps; save-count test |
| A listener leaks after a run (or after an error) and later runs post to an old card | Dispose in `finally`; filter by run id; test with another run's entry |
| Screen readers announce every re-render of the thread | Decision 9: activity `aria-live="off"`, one status line |
| Stop during a code step undoes that step's changes (the existing Cancel behaviour) | Open question 1; the button's title says what is lost |
| `runTimeline` treats a run still in progress differently from a finished one | Test the running state explicitly; change `runTimeline` only if a test shows it wrong, and say so |
| Plan 2 lands first and conflicts in `drive()` and `CHANGELOG.md` | Rebase onto `main` after plan 2 merges; version 3.5.0 under its own heading |

## Open questions

1. Does Stop in the chat ask first ("Stop the run? The running step's changes are undone.", asked from the
   host), or stop at once like the notification's Cancel and the drafting Stop? The planner recommends
   stopping at once with the consequence in the button's title, for one consistent Stop; the user decides
   before approval.
