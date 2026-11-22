# Plan 12 — Show the model's answer as it is written, and tokens per step

Status: draft
Date: 2026-11-22
Branch: `feat/studio-run-model-stream`
Baseline: `main` at `4fe5d23e5d17283e1987a4ed31c452e0a5034ac9`
Target: `src/studio/engine.ts` (`RunStore`), `src/studio/steps.ts`, `src/studio/studioModels.ts`, `src/agent/lmRouter.ts`, `src/studio/codeStep.ts`, `src/studio/studioCommands.ts`, `src/studio/studioChat.ts`, `src/studio/runsReport.ts`, `resources/studioChat.js`, `resources/studioChat.css`, tests, `docs/agent-studio.md`, `CHANGELOG.md`, `package.json`

## Goal

The user reported on 2026-11-22 that runs are "slow or opaque". A model call can take a minute, and nothing on the
run card moves until it ends:

- a prompt step logs `model` only after the reply (`src/studio/steps.ts:168`);
- the code step's router reads the reply to its end before returning (`src/agent/lmRouter.ts:104`).

Prompt steps report no token counts, while code steps do (`RouterResponse.usage`).

After this change, the running step on the chat card shows:

- "Model answering… N characters";
- a **Live output** section, collapsed by default, holding the latest text as it arrives;
- each step its tokens (in/out) when done, summed over its calls, with a total for the run.

## Decisions

1. **Streamed text is transient, never logged.**
   - `RunStore` gains `stream(runId, node, text)` and `onStream(listener)`, beside `log` and `onLog`.
   - The text goes only to listeners: it is not written to `log.jsonl` or saved in the chat.
   - Each fragment is sent as it arrives, with no batching in the store.
   - Rejected: logging fragments, which would grow the log by the whole reply each call and slow the Runs view.
2. **Hooks into the model calls.**
   - `StudioModel.complete(prompt, signal, model, onText?)`. `studioModels.ts` calls `onText` with each
     fragment.
   - `LmRouter.call(system, messages, tools, token, onText?)`, an optional fifth parameter. `CopilotRouter` calls
     it per fragment and with `''` at the start of each repair attempt, so the page can clear.
   - `StepContext` gains `stream?(text)`. The engine wires it to `store.stream(runId, node, text)`.
   - The prompt step and the code step pass it on.
   - The agent (`agentRunner`) passes nothing, so it is unchanged.
3. **Tokens for prompt steps.** `StudioModel.complete` returns `usage: { inputTokens, outputTokens }`.
   - Input is the count already taken before the call (`studioModels.ts:106`). Output is one `countTokens` on the
     reply.
   - The prompt step logs them on its `model` entry, as the code step does.
   - Counts come from `countTokens` (the model's own tokenizer through VS Code), not from billing. The page marks
     them "≈".
4. **What the card shows.**
   - **Live line.** Under the running step: "Model answering… 1,240 characters".
   - **Live output.** A `<details>`, collapsed by default, holding the last 2,000 characters as plain text. The
     replies are mostly JSON (a prompt step's answer, a code step's tool call). It is shown as it is, in a
     monospace block, never as HTML.
   - **Done steps.** "≈ 3.1k in · 0.4k out". The run's header shows the total.
   - **Throttle.** The host forwards stream text to the page at most every 250 ms, with the existing post
     throttle (plan 3).
   - **When a step ends.** Its stream text is dropped from the page. A new attempt or call clears it.
   - **Accessibility.** The live output is `aria-live="off"`, as the activity list is.
5. **Runs view and report.** `runTimeline` sums each node's `model` tokens, so the Runs view's timeline shows
   tokens per step and per run from the log.
   - The diagram (plan 10) may show the live line later; it is not part of this plan.
6. **Version: the next minor** at merge. CHANGELOG `### Added`.

## Scope

In:

- `src/studio/engine.ts`: `RunStore.stream` and `onStream`, and `StepContext.stream` wiring.
- `src/studio/steps.ts`: the `StudioModel` signature, and the prompt step passing `stream` and logging tokens.
- `src/studio/studioModels.ts`: `onText` and `usage`.
- `src/agent/lmRouter.ts`: `onText` in `LmRouter.call` and `CopilotRouter`.
- `src/studio/codeStep.ts`: pass `stream`.
- `src/studio/studioCommands.ts`: forward `onStream` for the run through `RunOptions`, as `onLog` is.
- `src/studio/studioChat.ts`, `resources/studioChat.js` and `resources/studioChat.css`: the live line, Live
  output, and tokens.
- `src/studio/runsReport.ts`: token sums.
- Tests, `docs/agent-studio.md`, `CHANGELOG.md`, `package.json`.

Out:

- Streaming in the diagram and the Runs view.
- Streaming the Studio Chat's planning reply.
- Cost in money.
- The agent view.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/studio/engine.ts:184` `RunStore.log`, `:200` `onLog` | Keep; add `stream` and `onStream` beside them |
| `src/studio/steps.ts:22` `StudioModel`, `:74` `StepContext`, `:168` prompt step model log | Change |
| `src/studio/studioModels.ts:97–123` `studioModel().complete` | Change |
| `src/agent/lmRouter.ts:43` `LmRouter`, `:82` `CopilotRouter`, `:104` stream loop | Change: optional `onText` |
| `src/studio/codeStep.ts:140–160` router call and model log | Change: pass `stream` |
| `src/studio/studioCommands.ts:174–185` `onLog` forwarding | Change: `onStream` too |
| `src/studio/runsReport.ts` `activityLine` (tokens already printed when present), `runTimeline` | Change: sums |

## Tech stack and constraints

Default (`AGENTS.md`). Scripted models in tests stream their reply in fragments.

## Acceptance criteria

- [ ] **Store.** `RunStore.onStream` gives fragments in order for any run. `log.jsonl` is unchanged by streaming,
  and a listener stops after `dispose()`. Checked by `node src/test/studioEngineSmoke.js`.
- [ ] **Prompt step.** With a scripted model streaming `{"a":` then `1}`, the listener gets both fragments in order
  and the step's output is `{a:1}`. The `model` log entry has `inputTokens` and `outputTokens`. Checked by the
  same test.
- [ ] **Code step.** With a scripted Copilot model streaming a tool call in three fragments, the router's `onText`
  gets them. A repair attempt starts with `''`. Checked by `node src/test/studioCodeStepSmoke.js` (or
  `agentHarnessSmoke.js` for the router).
- [ ] **Agent unaffected.** The agent's runner, calling without `onText`, behaves as before: `agentHarnessSmoke.js`
  passes unchanged.
- [ ] **Chat.**
  - While a scripted step streams 40 fragments, posted states carry the running step's character count and
    stream tail, at most once per 250 ms window plus a trailing post.
  - When the step ends, the tail is gone.
  - The saved conversation has no stream text.
  - Done steps show tokens.

  Checked by `node src/test/studioChatSmoke.js`.
- [ ] **Timeline.** Tokens summed per node and per run; old logs without tokens show none. Checked by
  `node src/test/studioRunsSmoke.js`.
- [ ] **Page.**
  - The live line and the collapsed Live output.
  - Opening it shows the plain text tail.
  - A tail holding `<script>` text shows as text.
  - "≈" token labels.

  Checked by `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui`, with
  new screenshot `55-studio-chat-run-streaming.png`. Other screenshots unchanged, or each difference explained.
- [ ] **Failure first.** With `stream` not wired in the engine, the prompt-step stream case fails. Report the
  message.
- [ ] **Required checks pass:**
  - `npm ci`;
  - `npm run lint` (0 errors; 2 known warnings);
  - `npm test`;
  - `test:ui` twice;
  - `npm run package`.
- [ ] **Unverified until run in VS Code** (say so): real Copilot streaming rates and token counts.

## Risks

| Risk | How it is handled |
| --- | --- |
| Streaming floods the page | 250 ms throttle; only the last 2,000 characters are sent |
| Model output carries markup or instructions | Shown as plain text in a `<pre>`, never as HTML; nothing acts on it |
| `countTokens` costs time or fails | One extra call per reply; a failure leaves tokens out, never fails the step |
| A changed `LmRouter.call` breaks the agent | Optional parameter; agent tests unchanged |

## Open questions

None.
