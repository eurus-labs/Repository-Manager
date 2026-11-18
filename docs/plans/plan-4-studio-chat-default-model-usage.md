# Plan 4 — "Steps use" says which steps it applies to

Status: implemented
Date: 2026-11-18
Branch: `fix/studio-chat-default-model-usage`
Baseline: `main` at `cc5574d31b3e0445744cbdd892c3fedcf853c7b2`
Target: `resources/studioChat.js`, `resources/studioChat.css`, `src/test/studioChatUi.js`, `CHANGELOG.md`, `package.json`

## Goal

Issue #179. On a Studio Chat plan card, **Steps use** sets the plan's default model (`defaults.model`). The
engine uses it only for a step that uses a model and names none (`node.model ?? workflow.defaults?.model`,
then the dashboard's model: `src/studio/engine.ts:426`). Today the card shows **Steps use** whenever any step
uses a model (`resources/studioChat.js:158`), even when every such step names its own model; the choice then
changes nothing and nothing says so. After this change the person can see how many steps the default applies
to, and cannot change it when it applies to none.

## Decisions

1. **Say how many steps use it, beside the menu**: a visible note after the select — `used by 1 step` /
   `used by N steps` — counting steps with `usesModel` and no `model` of their own (from `planView`) —
   rejected: hiding **Steps use** when no step would use it (the user's choice, 2026-11-18), because the menu
   would vanish and reappear as the person changes a step's model, which reads as a bug.
2. **When no step uses it, disable the menu and say why in the visible note**: `used by no step: each step
   that uses a model names its own`, the select `disabled`, its current value still shown — rejected: the
   reason only as a `title` tooltip, because a disabled control gets no hover or focus in some webviews, so the
   reason would be unseen.
3. **The note is part of the label's accessible description**: the select gets `aria-describedby` pointing at
   the note, so a screen reader reads "Default model for the plan's steps … used by 2 steps".
4. **Page only**: the count comes from the `view.steps` the host already sends (`usesModel`, `model`); no host,
   engine or workflow format change — rejected: computing it in `planView`, because the page has every input
   and the host would only duplicate it.
5. **Version 3.6.0** (the control's interaction changes: it can be disabled), CHANGELOG `### Changed`.

## Scope

In:

- `resources/studioChat.js` `planCard`: the count, the note, `disabled` at 0, `aria-describedby`.
- `resources/studioChat.css`: the note's style (muted, same size as the label; a `disabled` select stays
  readable in both themes).
- `src/test/studioChatUi.js`: the cases in the Acceptance criteria; one new screenshot of the 0 case.
- `CHANGELOG.md`, `package.json` (`npm version 3.6.0 --no-git-tag-version`).

Out:

- The step model menus (their "Plan default (X)" label stays).
- Whether **Steps use** shows on non-editable cards (it does not today; unchanged).
- The engine's model resolution, the workflow format, the planner's prompt.
- Moving the default into each step's menu (raised in the conversation, not chosen).

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `resources/studioChat.js:158–163` (`defaults` label and select) | Change |
| `resources/studioChat.js` `modelOptions`, `stepsBlock` (step menus, "Plan default (…)") | Keep |
| `src/studio/chatSession.ts:120–138` `planView` (`usesModel`, `model`, `defaultModel`) | Keep: inputs of the count |
| `src/studio/engine.ts:426` model resolution | Keep: the rule the count mirrors |
| `src/test/studioChatUi.js` plan card part (~line 150–240; `41-studio-chat-plan`, a step model set at ~210) | Change: add the cases |

## Tech stack and constraints

Default (`AGENTS.md`): plain browser JavaScript in the webview; no `alert`/`confirm`/`prompt`.

## Acceptance criteria

- [ ] Some steps on the plan default: the card shows `used by N steps` with the right N (2 and 1 checked; singular for 1), the select enabled — `npm run test:ui` (`src/test/studioChatUi.js`).
- [ ] Every model-using step names its own model: the note reads `used by no step: each step that uses a model names its own`, the select is `disabled` and still shows the current default — same test; new screenshot `48-studio-chat-default-unused.png`.
- [ ] Failure case: setting a step back to "Plan default" re-enables the select and the count goes 0 → 1 after the host's update — same test.
- [ ] A plan with no model-using step shows no **Steps use** (unchanged) — same test.
- [ ] The select's `aria-describedby` names the note's id, and the note's text is the count — same test.
- [ ] Failure-first: with the count ignoring `step.model` (counting every model-using step), the new 0-case assertion fails (report the message); restored, it passes.
- [ ] Existing screenshots 40–47 are byte-identical to `main` except `41-studio-chat-plan` (it gains the note); the report names any other difference.
- [ ] Required checks pass — `npm ci`, `npm run lint` (0 errors; 2 known warnings), `npm test`, `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui` twice, `npm run package`.

## Risks

| Risk | How it is handled |
| --- | --- |
| The count drifts from the engine's rule | Decision 4 mirrors `node.model ?? defaults.model`; a comment in the page names `engine.ts` |
| A disabled select is unreadable in a theme | Check `48-*` in dark, and the light screenshot of the card if one is taken; contrast of the disabled text against its background noted in the report |
| The note makes the card wrap badly at narrow widths | The UI test's narrow viewport (as the existing card shots) shows no overlap |

## Open questions

None.
