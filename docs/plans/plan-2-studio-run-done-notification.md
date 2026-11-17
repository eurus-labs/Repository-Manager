# Plan 2 — A finished Studio run no longer locks the Studio Chat

Status: approved
Date: 2026-11-17
Branch: `fix/studio-run-done-notification`
Baseline: `main` at `3b5490e3016544e6f3c857cda4da9d556d860449`
Target: `src/studio/studioCommands.ts` (`drive`), `src/test/studioCommandsSmoke.js`, `src/test/studioChatSmoke.js`, `CHANGELOG.md`, `package.json`

## Goal

When a run started from the Studio Chat finishes, the chat unlocks at once, whether or not the person ever
touches the "…: done." notification. Today `drive()` awaits that non-modal notification
(`src/studio/studioCommands.ts:189`); the chat stays `busy = 'running'` until `run()` returns
(`src/studio/studioChat.ts:280–283`), so the run card says Done while the composer, + and History stay locked
("Wait for the current reply or run to finish, or stop it."). Reproduced with a scripted `vscode` whose
non-modal `showInformationMessage` never settles: the chat saw `done`, `run()` stayed pending, the file was
written. Shipped as 3.4.1.

## Decisions

1. **Fix it in `drive()`, not in the chat**: `drive()` returns as soon as the run is done; the "done."
   notification is shown without awaiting it, and its Open Result button still opens the last written file
   when clicked later — rejected: unlocking the chat on the `done` update, because `drive()` also serves
   Run from the workflow editor, Run Workflow… and Resume from the Runs view, which would stay pending too.
2. **Open Result opens the file of the run that showed the notification**: the path is taken when the
   notification is shown, not when it is clicked — rejected: reading the latest run when clicked, because
   a second run may have finished in between.
3. **Release as 3.4.1 from `main`** (the user's decision, 2026-11-17): `main` holds only refactors, tests and
   docs since 3.4.0 (#172–#181), nothing a person sees, so tagging `main` ships only this fix. Version and
   CHANGELOG are set in this branch.
4. **Failure-first tests at two levels**: the command level (`drive` through `runs.run`) and the chat level
   (busy cleared after a run whose notification never settles) — rejected: the command level only, because
   the symptom the person saw is the chat's lock.

## Scope

In:

- `src/studio/studioCommands.ts` `drive()`: the done notification is not awaited; a rejected or dismissed
  notification is ignored (no unhandled rejection).
- `src/test/studioCommandsSmoke.js`: a run whose non-modal notification never settles returns `done`.
- `src/test/studioChatSmoke.js`: with a `runs.run` that resolves while a notification would still be open,
  the chat's `busy` is `null` after the run and Send/+ work (no "Wait for the current reply" notice).
- `CHANGELOG.md`: `## [3.4.1] - <merge date>` with a `### Fixed` entry; `npm version 3.4.1 --no-git-tag-version`.

Out:

- Progress, step status, Stop in the chat (plan 3).
- The failed and stopped notifications (already not awaited).
- Modal dialogs (consent, gates, reviews): they must still be awaited.
- Tagging and publishing the release (the user does it after merge; this session gets 403).

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/studio/studioCommands.ts:185–191` (done notification awaited) | Change (Decision 1, 2) |
| `src/studio/studioCommands.ts:192–196` (failed/stopped, `void`) | Keep |
| `src/studio/studioChat.ts:252–287` (`run()`, busy cleared in `finally`) | Keep |
| `src/test/studioCommandsSmoke.js` (scripted `vscode`, `answers.info`) | Change: add the never-settling case |
| `src/test/studioChatSmoke.js` (~258–330, scripted `runs`) | Change: add the chat-level case |
| Scratch repro (not in the repository): stub whose non-modal `showInformationMessage` returns `new Promise(() => {})` | Copy its idea into the tests |

## Tech stack and constraints

Default (`AGENTS.md`).

## Acceptance criteria

- [ ] A finished run returns while its notification is still open — checked by `node src/test/studioCommandsSmoke.js` (new case: non-modal info never settles; `runs.run(...)` resolves with `status: 'done'` within the test).
- [ ] Open Result still works after `drive()` returned — checked by the same test: the notification's promise resolves to `Open Result` after `run()` returned, and `showTextDocument` is called with the written file of that run.
- [ ] The chat unlocks — checked by `node src/test/studioChatSmoke.js` (new case: after the run, the state posted has `busy: null`, and `newChat` posts no "Wait for the current reply" notice).
- [ ] Failure case: with the `await` put back in `drive()`, the new `studioCommandsSmoke.js` case fails (report the message), and passes when removed again.
- [ ] Modal questions are still awaited: the existing gate/consent cases in `studioCommandsSmoke.js` pass unchanged.
- [ ] `package.json` version is `3.4.1`; `CHANGELOG.md` has `## [3.4.1]` with the Fixed entry under it and `## [Unreleased]` above it.
- [ ] Required checks pass — `npm ci`, `npm run lint` (0 errors; 2 known warnings), `npm test`, `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui`, `npm run package`.

## Risks

| Risk | How it is handled |
| --- | --- |
| Open Result clicked after a newer run finished opens the wrong file | Decision 2; covered by the second acceptance criterion |
| An unhandled promise rejection from the un-awaited notification | `.then(…, () => undefined)`; lint (`no-floating-promises` if enabled) |
| The real VS Code keeps the promise pending differently from the stub | Unverified outside VS Code; the user checks once in VS Code after install: Run a plan, leave the notification, type in the chat |
| `main` moves before merge | Rebase; the version stays 3.4.1 unless something user-visible lands first (then stop and ask) |

## Open questions

None.
