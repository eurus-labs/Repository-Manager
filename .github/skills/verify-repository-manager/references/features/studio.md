# Studio

Agent Studio: workflows defined in JSON files, run by an engine that asks a person before any step
with an effect, edited as a diagram in the Workflow Editor, and drafted from a goal in the Studio Chat.

## Sub-features
- workflow-file: the `repository-manager/workflow@1` format and its validation.
- engine: dependency order, `when`, `forEach`, gates, runs kept and resumed.
- steps: prompt, docs.requirements, requirements.compare, file.write, gate.
- commands: Run Workflow… (library, folder, samples, or a given file), Show Workflow Runs.
- editor: the Workflow Editor for `*.workflow.json`.
- chat: the Studio Chat view (Activity Bar **Studio** → Chat): goal → plan card (criteria, steps, per-step model) → proposed changes as a diff → Run, Save as workflow, Open in diagram.

## How to get to it (user POV)
- Command Palette → Repository Manager: Run Workflow… → pick a workflow → inputs → consent → gates.
- Open any `*.workflow.json` → Workflow Editor; **Open as JSON** for the text.
- Activity Bar **Studio** → **Chat**: type a goal; **New Studio Chat** and **Studio Chat History** are on the view's title bar.

## Driving it
- Node: `studioEngineSmoke.js` (the sample on a real Git repository with a scripted model), `studioCommandsSmoke.js`
  (the commands with a scripted vscode), `workflowEditSmoke.js`, `studioChatSmoke.js` (planner, conversation rules, per-step
  models, and the chat host with a scripted `vscode.lm`) — `$V capture <label> -- node src/test/<name>`.
- Chromium: `src/test/studioEditorUi.js` (real page and provider, fake text document); screenshots `ui-snapshots/30*`–`32*`.
  `src/test/studioChatUi.js` (real chat page and provider, scripted `vscode.lm`); screenshots `ui-snapshots/40*`–`44*`.

## Expected behavior
- Workflows are user-defined, declarative and shared as one JSON file; the visual editor writes that file. [confirmed: user, 2026-11-07]
- The engine asks before any step that writes, runs a command or sends, showing exactly what will happen; a workflow, an imported workflow or the AI cannot remove that gate. [confirmed: spec docs/agent-studio.md]
- Nothing is written before approval; a rejection stops the run. [confirmed: test src/test/studioEngineSmoke.js]
- `file.write` refuses paths outside the workspace, by text or through a symbolic link. [confirmed: test src/test/studioEngineSmoke.js]
- `${…}` references and conditions are parsed, never evaluated as JavaScript, and cannot read the prototype. [confirmed: test src/test/studioEngineSmoke.js]
- A waiting run resumes after a restart, from Show Workflow Runs. [confirmed: test src/test/studioCommandsSmoke.js]
- Comparing requirements refuses a catalog with unread documents. [confirmed: test src/test/studioEngineSmoke.js]
- The editor's edits go through the text document (undo, save) and two quick edits never undo each other. [confirmed: test src/test/studioEditorUi.js]
- Run from the editor saves first and does not run when the save fails. [confirmed: test src/test/studioEditorUi.js]
- Cancel ends a run for good; only a waiting run continues. To pause, stop at a gate. [confirmed: user, 2026-11-09]
- CI runs `studioEditorUi.js` with the other UI tests. [confirmed: user, 2026-11-09]
- The chat asks only for the goal; the AI proposes the criteria, which the person edits on the plan card before Run; a run freezes them. [confirmed: user, 2026-11-09]
- A model is chosen for drafting in the composer, and per step on the plan card; a model the file names that this VS Code lacks is replaced for the run only, after asking. [confirmed: user, 2026-11-09]
- A change the AI proposes to an existing plan is shown as a diff and changes nothing until Accept; a dropped step shows as removed. [confirmed: test src/test/studioChatSmoke.js]
- A plan with problems (no criteria, unknown step, broken reference) cannot run; the planner gets one repair turn. [confirmed: test src/test/studioChatSmoke.js]
- Once saved as a workflow file, the file is the plan: edits there show in the chat, and an accepted change is written to it. [confirmed: test src/test/studioChatSmoke.js]

## Suspected bugs
- None found.

## Open questions
- None.

## Gotchas
- `docs.requirements` reads a folder chosen as an input anywhere on disk, but a path written in the file must stay in the workspace.
- Live Copilot calls are scripted in tests.
