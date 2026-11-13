# Studio

Agent Studio: workflows defined in JSON files, run by an engine that asks a person before any step
with an effect, edited as a diagram in the Workflow Editor, and drafted from a goal in the Studio Chat.

## Sub-features
- workflow-file: the `repository-manager/workflow@1` format and its validation.
- engine: dependency order, `when`, `forEach`, gates, runs kept and resumed.
- steps: prompt, docs.requirements, requirements.compare, file.write, gate, code (reviewed after it runs).
- skills: SKILL.md folders from GitHub sources, pinned to a commit, cached, trusted once per source.
- commands: Run Workflow… (library, folder, samples, or a given file), Show Workflow Runs.
- editor: the Workflow Editor for `*.workflow.json`.
- chat: the Studio Chat view (Secondary Side Bar **Studio** → Chat, on the right): goal → plan card (criteria, steps, per-step model) → proposed changes as a diff → Run, Save as workflow, Open in diagram.

## How to get to it (user POV)
- Command Palette → Repository Manager: Run Workflow… → pick a workflow → inputs → consent → gates.
- Open any `*.workflow.json` → Workflow Editor; **Open as JSON** for the text.
- Secondary Side Bar (right) **Studio** → **Chat**: type a goal; **New Studio Chat** and **Studio Chat History** are on the view's title bar.

## Driving it
- Node: `studioEngineSmoke.js` (the sample on a real Git repository with a scripted model), `studioCommandsSmoke.js`
  (the commands with a scripted vscode), `workflowEditSmoke.js`, `studioChatSmoke.js` (planner, conversation rules, per-step
  models, and the chat host with a scripted `vscode.lm`), `studioSkillsSmoke.js` (a scripted GitHub), `studioCodeStepSmoke.js`
  (a real Git repository and check, scripted tool calls), `agentMigrationSmoke.js` (agent tasks to Studio chats) — `$V capture <label> -- node src/test/<name>`.
- Chromium: `src/test/studioEditorUi.js` (real page and provider, fake text document); screenshots `ui-snapshots/30*`–`32*`.
  `src/test/studioChatUi.js` (real chat page and provider, scripted `vscode.lm`); screenshots `ui-snapshots/40*`–`45*`.

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
- Skills come from GitHub repositories, pinned to a commit and cached; a source is trusted once before use; their scripts are never run, and skills that use scripts are marked. [confirmed: user, 2026-11-09]
- + Skill asks for the source first (one, all, or a GitHub repository added by name or URL, trusted before it is kept); Manage Skill Sources adds or removes one. [confirmed: user, 2026-11-12; test src/test/studioSkillsSmoke.js]
- Skill sources may be on a GitHub Enterprise server (URL or host/owner/name), read through its /api/v3 and signed in with VS Code's GitHub Enterprise account. [confirmed: user, 2026-11-13; test src/test/studioSkillsSmoke.js]
- GitHub sign-in is asked at most once, only when a repository refuses an anonymous read; a Cancel is not asked again. [confirmed: user bug report, 2026-11-13; test src/test/studioSkillsSmoke.js]
- The planner may attach only skills it was offered or the plan already had. [confirmed: test src/test/studioSkillsSmoke.js]
- A code step works on the current branch; it creates a branch only when the plan names one (asked for by the person), and only from a clean tree. [confirmed: user, 2026-11-12]
- A code step changes only its paths, runs only approved scripts as checks, and waits for review; Retry and Stop undo its changes. [confirmed: test src/test/studioCodeStepSmoke.js]
- A failed or unverified code step is never accepted by a plain Accept: the button says Accept Anyway or Accept as Unverified. [observed: src/studio/studioCommands.ts, drive]
- New work starts in the Studio chat, in the Secondary Side Bar on the right, as Copilot's; the Agent's Tasks view is gone. [confirmed: user, 2026-11-12]
- The chat's model menu lists every chat model VS Code offers and fills in when they load (it was empty when read only at start). [confirmed: user, 2026-11-12; test src/test/studioChatSmoke.js]
- Earlier agent tasks become Studio chats when 3.0.0 starts: remaining steps become code steps on the task's branch; a step under review keeps its changes and is named; nothing is deleted. [confirmed: user, 2026-11-12; test src/test/agentMigrationSmoke.js]
- Once saved as a workflow file, the file is the plan: edits there show in the chat, and an accepted change is written to it. [confirmed: test src/test/studioChatSmoke.js]

## Suspected bugs
- None found.

## Open questions
- None.

## Gotchas
- `docs.requirements` reads a folder chosen as an input anywhere on disk, but a path written in the file must stay in the workspace.
- Live Copilot calls are scripted in tests.
