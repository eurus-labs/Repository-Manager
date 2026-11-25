# Plan 8 — Model menus offer only models an extension can use; a stray model setting does not block a plan

Status: implemented
Date: 2026-11-20
Branch: `fix/studio-chat-model-choice`
Baseline: `main` at `4fe5d23e5d17283e1987a4ed31c452e0a5034ac9`
Target: `src/services/extensionModels.ts` (new), `src/studio/studioModels.ts`, `src/studio/studioChat.ts`, `src/studio/chatPlanner.ts`, `src/services/changeSummaryService.ts`, `src/services/securityReviewProvider.ts`, tests, `CHANGELOG.md`, `package.json`

## Goal

This plan fixes two bugs that the user reported from 3.8.0 on 2026-11-20, with screenshots.

1. **The model menu offers models VS Code keeps for itself.**
   - **What happens.** The Studio Chat's Model menu lists Copilot models such as `copilot-dictation-cleanup-luna` and
     `copilot-dictation-cleanup-nano`. The user chose them from the menu. Every send then failed with
     "Model copilot-dictation-cleanup-luna is only available to VS Code core."
   - **Why.** `lmModels()` (`src/studio/studioModels.ts:35`) lists everything `vscode.lm.selectChatModels` returns,
     with no filter.
   - **Other features have the same gap.** The dashboard's Model menu lists Copilot's models unfiltered too
     (`CopilotSummaryProvider.listModels`, `src/services/changeSummaryService.ts:29`). With no model chosen,
     these take the first Copilot model:
     - commit messages, summaries and conflict help (`changeSummaryService.ts:45`);
     - the review (`src/services/securityReviewProvider.ts:107`).

     If Copilot lists an internal model first, they hit the same error.
2. **A stray `model` setting blocks a whole plan.**
   - **What happens.** GPT-4o mini put `"model"` on a `docs.requirements` node. Validation reported
     `"docs.requirements" does not use a model` (`src/studio/workflow.ts:336`), and Run stayed off. The single
     repair turn (`src/studio/chatPlanner.ts:230`) did not remove it.
   - **Why it should not block.** The field has no effect on such a step.

After this change:

- a model that refused an extension once is not offered again in any menu;
- a call that did not name a model moves on to a model that works;
- a plan's `model` and `skills` on a step that uses no model are dropped instead of blocking Run.

## Decisions

1. **Models are learned as unusable from the refusal; names are not guessed.**
   - **How a refusal is recognised.** A model is unusable when a request to it fails with an error whose message
     contains `only available to VS Code core`. That is VS Code's own wording, the only signal seen.
   - **What is kept.** Its id is kept in `globalState` under `repositoryManager.unusableModels`, as
     `{ vscodeVersion, ids: string[] }`. The list is cleared when `vscode.version` changes, because a VS Code or
     Copilot update may change what extensions may use.
   - Rejected: a list of name patterns (such as `dictation`), because Copilot adds and renames internal models
     without notice.
   - Rejected: a probe request to every model when the menu opens, because each probe could cost a request and
     slow the menu.
   - **Unverified.** Whether `vscode.lm` exposes a field that marks such models (no public field is known; the
     repository's `@types/vscode` is 1.74 and predates `vscode.lm`). If the implementer finds one documented in the
     VS Code API, stop and report it rather than use it unasked.
2. **One shared module, no `vscode`: `src/services/extensionModels.ts`.**
   - `isCoreOnlyError(error)`.
   - `unusable(state, vscodeVersion): Set<string>`.
   - `markUnusable(state, vscodeVersion, id)`.
   - `usable<T extends { id: string }>(models, state, vscodeVersion): T[]`.

   Every place that lists or picks a model uses it:
   - Studio `lmModels`, and with it `listModels` and `pickModel`;
   - `CopilotSummaryProvider.listModels` and `complete`;
   - `SecurityReviewProvider`'s model pick.

   Rejected: fixing the Studio only, because the dashboard features share the cause.
3. **When the person chose the model.** Their chosen model refuses in either of these:
   - the chat's menu (`conversation.model`);
   - the dashboard's menu (`readSelectedModel`).

   Then:
   - the model is marked;
   - the choice is cleared: `conversation.model = undefined`, or the dashboard's selection is reset;
   - the person is told "<name> is kept by VS Code for its own use and cannot be used by extensions. It was removed
     from the Model menu; choose another model.";
   - the request is **not** retried on another model.
   - Rejected: silently switching to another model, because the person picked that model on purpose.
4. **When no model was named.** The fallback model (the dashboard's choice in the Studio, else the first Copilot
   model) refuses. It is marked, and the same request is retried **once** with the next usable model.
   - The answer's model name (already shown under the reply) says which model answered.
   - With no usable model left, the existing "No chat model is available…" error is shown.
5. **A plan's `model` and `skills` on a step that uses no model are dropped by `normalizePlan`.** This applies to
   a node whose type is registered and whose `StepShape.usesModel` is not true (`src/studio/workflow.ts:107`).
   - `normalizePlan` (`chatPlanner.ts:128`) deletes `model` and `skills` from such a node before validation. Both
     have no effect there.
   - A node of an unknown type is left as it is, so validation still reports the unknown type.
   - Prompt and code steps keep both fields unchanged.
   - Rejected: a second repair turn. A weaker model may fail again, and the field carries no meaning to repair.
   - Rejected: dropping them in the validator. A workflow file written by a person should still be told about them
     (`workflow.ts:336` stays). Only the planner's draft is cleaned.
6. **Version 3.8.1** (two bug fixes; the interaction is unchanged). CHANGELOG `## [3.8.1]` gets a `### Fixed`
   entry for each bug.

## Scope

In:

- `src/services/extensionModels.ts` (new, no `vscode`): Decision 1–2.
- `src/studio/studioModels.ts`: `lmModels`, `pickModel` and `studioModel().complete` (mark, retry, the chosen-model
  error), Decisions 3–4. `codeHost.ts`'s router uses `pickModel`, so a code step's model follows the same rules.
- `src/studio/studioChat.ts`: clear `conversation.model` and re-post the menu when the chosen model is marked
  (Decision 3).
- `src/services/changeSummaryService.ts`, `src/services/securityReviewProvider.ts`, and where the dashboard's choice
  is reset (`src/modelPreferences.ts`): Decisions 2–4.
- `src/studio/chatPlanner.ts` `normalizePlan`: Decision 5.
- Tests, `CHANGELOG.md`, `package.json` (`npm version 3.8.1 --no-git-tag-version`).

Out:

- Making the planner pick better step types: a weaker model chose `docs.requirements` for "create a weather
  dashboard". That is model quality, not this fix.
- Any change to the validator's messages for workflow files.
- The model menus' layout.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/studio/studioModels.ts:35` `lmModels`, `:51` `listModels`, `:84` `pickModel`, `:97` `studioModel` | Change |
| `src/studio/studioChat.ts:139, 224` menu reads, `:237` `setModel` | Change: clear and re-post on a marked choice |
| `src/studio/codeHost.ts:27` router via `pickModel` | Keep: follows `pickModel` |
| `src/services/changeSummaryService.ts:29` `listModels`, `:41–50` `complete` | Change |
| `src/services/securityReviewProvider.ts:106–107` model pick | Change |
| `src/repositoryManagerPanel.ts:177, 529, 625` (callers, the dashboard's menu) | Keep, or adjust only to pass `globalState` and the VS Code version |
| `src/modelPreferences.ts` `readSelectedModel` | Change: a way to reset the selection |
| `src/studio/chatPlanner.ts:128` `normalizePlan` | Change |
| `src/studio/workflow.ts:107` `usesModel`, `:336` validator message | Keep |

## Tech stack and constraints

Default (`AGENTS.md`):

- no new dependency;
- tests use scripted models, with errors whose message carries the VS Code wording;
- a new `src/test/*Smoke.js` is added to the `test` script.

## Acceptance criteria

- [ ] **The shared module** (`node src/test/extensionModelsSmoke.js`, new):
  - `isCoreOnlyError` is true for an error with the VS Code wording and false for other errors (a network failure,
    `Cancelled`);
  - `usable` leaves out marked ids;
  - a changed `vscodeVersion` clears the list.
- [ ] **Studio, chosen model** (`node src/test/studioChatSmoke.js`). With a scripted `vscode.lm` whose model
  `internal-a` refuses with the VS Code wording, choosing it in the chat and sending:
  - shows the Decision 3 message;
  - clears `conversation.model`;
  - leaves `internal-a` out of the next menu posted;
  - makes no second request.
- [ ] **Studio, no model named** (same test). With `internal-a` listed first and refusing, and no model chosen:
  - the send is answered by the next model;
  - `internal-a` is marked;
  - exactly two requests are made.
- [ ] **Dashboard and review** (`node src/test/summaryProviderSmoke.js` or the existing summary and review tests).
  - `CopilotSummaryProvider.listModels` leaves out a marked model.
  - `complete` with no selected model retries once past a refusing first model.
  - With the selected model refusing, it reports the Decision 3 message and does not retry.
  - The review's pick does the same.
- [ ] **Failure case.** With every model refusing, the send ends with the existing "No chat model is
  available…" error after one request per model, not in a loop. Checked by `node src/test/studioChatSmoke.js`.
- [ ] **Plan clean-up** (`node src/test/studioChatSmoke.js`, or a planner test):
  - a drafted plan with `model` and `skills` on a `docs.requirements` node has neither field after
    `normalizePlan` and no problem;
  - a `prompt` node keeps its `model` and `skills`;
  - a node of an unknown type keeps them and still reports the unknown type;
  - `validateWorkflow` on a workflow file with `model` on `docs.requirements` still reports it.
- [ ] **Failure first.** Each of these fails before the fix, and passes after it. Report the messages.
  - The chosen-model case: the model is still offered after the refusal.
  - The plan clean-up case: the problem `does not use a model` is reported.
- [ ] **Required checks pass:**
  - `npm ci`;
  - `npm run lint` (0 errors; 2 known warnings);
  - `npm test`;
  - `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui`, with
    screenshots unchanged or every difference explained;
  - `npm run package`.
- [ ] **Unverified until run in VS Code** (say so in the report):
  - the real error wording and type for a core-only model;
  - that real Copilot lists such models to extensions.

## Risks

| Risk | How it is handled |
| --- | --- |
| VS Code changes the error's wording, and models are no longer marked | The person still sees VS Code's own error, as today. The match lives in one function (`isCoreOnlyError`) |
| A model is marked by mistake (another error that quotes the same words) | Only that exact phrase marks. The list is cleared with each VS Code update |
| A retry sends the prompt (with attached files) to a second model the person did not pick | Retry happens only when no model was named, so the person had already left the choice to the extension. The reply names the model that answered |
| Dropping `skills` hides a planner mistake the person wanted to see | They had no effect on that step. The plan card shows the steps and their skills as kept |
| The dashboard's reset changes a stored preference | Only after that model refused, and the person is told |

## Open questions

None.
