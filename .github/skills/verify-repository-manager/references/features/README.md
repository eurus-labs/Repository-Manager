# Feature map: Repository Manager

The VS Code extension's feature areas, at the level a user meets them. Each area names the source
paths it owns, so `verify affected` can map a change to the areas it touches.

## Index

- [changes-and-commit](changes-and-commit.md) — owns: `src/services/commitService.ts`, `src/services/commitMessage.ts`, `src/commitMessageController.ts`, `src/services/discardService.ts`, `src/commands/discardCommands.ts`, `src/services/stashActionService.ts`, `src/services/stashTarget.ts`, `src/services/diffService.ts`, `src/services/localChangesSnapshot.ts`, `src/services/ignoredPaths.ts`, `src/changeDocuments.ts`, `src/liveChanges.ts`, `src/handlers/**`, `resources/webview.js`, `resources/sidebar.js` — Side Bar Changes, the dashboard diff, the commit dialog, Write with Copilot, Discard and Stash.
- [history-and-branches](history-and-branches.md) — owns: `src/services/historyService.ts`, `src/services/historyActionService.ts`, `src/services/historyRewriteService.ts`, `src/services/branchService.ts`, `src/services/referenceService.ts`, `src/services/conflict*.ts`, `src/services/naturalUndo.ts`, `src/services/releaseRange.ts`, `src/services/changeSummary*.ts`, `src/services/changeContextService.ts`, `src/commands/createBranchCommand.ts`, `src/prManager.ts`, `src/handlers/**`, `resources/historyGraph.js`, `resources/webview.js` — the history graph, commit detail and comparison, branches and tags, history actions with conflict prediction, undo, change summaries.
- [linked-repositories](linked-repositories.md) — owns: `src/services/submoduleService.ts`, `src/services/gitCommandService.ts`, `src/services/index.ts`, `src/gitOperations.ts`, `src/commands/submoduleCommands.ts`, `src/commands/index.ts`, `src/repositoryTreeProvider.ts` — linked repositories (submodules): the repository list, Align, fetch, pull and push.
- [dashboard-shell](dashboard-shell.md) — owns: `src/extension.ts`, `src/repositoryManagerPanel.ts`, `src/repositoryManagerLauncher.ts`, `src/webview/**`, `src/types.ts`, `src/openTimings.ts`, `resources/webview.css`, `resources/tab-icons/**`, `resources/*icon*`, `package.json`, `.vscodeignore` — activation, commands, the dashboard tab and the Side Bar mirror, packaging.
- [review](review.md) — owns: `src/review*.ts`, `src/services/review*.ts`, `src/services/securityReview*.ts`, `src/services/aiDirectedText.ts`, `src/services/modelJson.ts`, `src/commands/reviewCommands.ts`, `src/copilotSettings.ts`, `src/modelPreferences.ts`, `resources/review.js`, `resources/review-skills/**` — the security and compliance review: snapshot, skills, findings, triage, Fix with Copilot, history.
- [requirements](requirements.md) — owns: `src/requirements/**`, `resources/requirements.js`, `resources/requirements.css`, `resources/requirements/**`, `resources/requirements-icon.svg` — the Requirements view and the Requirement Editor for clarification (DoU) files.
- [agent](agent.md) — owns: `src/agent/**`, `resources/agent-icon.svg` — the agent harness under code steps: router, tools, script approvals; earlier tasks moved to Studio chats.
- [studio](studio.md) — owns: `src/studio/**`, `resources/studioEditor.js`, `resources/studioEditor.css`, `resources/studioChat.js`, `resources/studioChat.css`, `resources/studio/**` — Agent Studio: workflow files, the engine and its gates, Run Workflow…, the Workflow Editor, the Studio Chat.
- [usage](usage.md) — owns: `src/services/usageLog.ts` — the usage log and Show Usage Report.

Docs (`docs/**`, `README.md`, `CHANGELOG.md`, `AGENTS.md`) and tests (`src/test/**`) belong to no
area: `affected` lists them as `unmapped:`. A change to them needs the checks, not a feature flow.

## Baseline preconditions

- `npm ci` has run; Node 22 (CI) or 20+.
- `$V doctor` passes. It compiles whenever the working tree differs from the last build.
- For the `ui` check and every UI flow: Chromium (set `PLAYWRIGHT_CHROMIUM_PATH` if Playwright
  does not find it; in cloud sessions it is `/opt/pw-browsers/chromium`).
- Tests make their own Git repositories in the system temporary folder; they need `git` and do not
  touch the working tree, except `ui-snapshots/` (ignored by Git) and `.verify/`.

## Full sweep order

1. `$V check` (every check).
2. dashboard-shell, linked-repositories, history-and-branches, changes-and-commit (the UI test
   `src/test/uiSnapshots.js` drives them in this order).
3. review, requirements, agent, studio, usage.

## Entry contract

Every feature file has exactly these sections, in this order: one-sentence summary, `## Sub-features`,
`## How to get to it (user POV)`, `## Driving it`, `## Expected behavior`, `## Suspected bugs`,
`## Open questions`, `## Gotchas`. Only `[confirmed: …]` entries are pass criteria; `[observed]`
entries describe what the code does without a stronger source.
