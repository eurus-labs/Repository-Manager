# Plan 9 — The Studio planner picks the right steps and writes checkable criteria

Status: draft
Date: 2026-11-22
Branch: `feat/studio-planner-step-choice`
Baseline: `main` at `4fe5d23e5d17283e1987a4ed31c452e0a5034ac9`
Target: `src/studio/chatPlanner.ts`, `src/studio/steps.ts` and `src/studio/codeStep.ts` (step descriptions), tests, `docs/agent-studio.md`, `CHANGELOG.md`, `package.json`

## Goal

The user reported this on 2026-11-22. GPT-4o mini, asked "i need to create a weather dashboard" with a folder open,
planned one `docs.requirements` step called "Define Requirements". That step only *reads* requirement files with
IDs. The criteria were "Requirements are defined" and "Data sources are identified", which nobody can check.

After this change:

- **A goal that changes code gets `code` steps.** Each code step lists paths and checks.
- **Every step type is used for what it does.**
- **Criteria are things a person can check.** Examples: "`npm test` passes", "`src/weather/` holds the
  dashboard component", "the page shows today's temperature for a city".
- **A plan that breaks the first or third rule** gets the existing repair turn with the reason.
- **Unchanged:** one model call per turn, plus at most one repair.

## Decisions

1. **The catalog says when to use each step and when not to** (the user's choice, 2026-11-22: catalog,
   examples, checks).
   - **What each step type gets.** `stepCatalog` (`src/studio/chatPlanner.ts:66`) prints a new optional field
     on `StepDefinition`, `planning?: { use: string; avoid: string }`. It sits beside `description`.
   - **Example, `docs.requirements`:**
     - use: "read existing requirement files that carry IDs (RST or Markdown)";
     - avoid: "writing or defining new requirements; use a prompt step and file.write, or a code step".
   - **Example, `code`:**
     - use: "any goal that creates or changes source files in the open repository: features, fixes, UI,
       config";
     - avoid: "reading or summarising only".
   - Every built-in step type gets both lines.
   - Rejected: longer free-text descriptions. The palette shows `description`, and a short description reads
     better there.
2. **Worked examples go in the system prompt.** There are four short examples, each a goal and a plan sketch
   (step types, ids and criteria; not full JSON). Each stays under about 600 characters:
   - (a) "add a weather dashboard page" → one or two `code` steps with paths and checks. Criteria: checks pass,
     named files exist, visible behaviour.
   - (b) "analyse what changed in the requirements since v1.2" → `docs.requirements` twice,
     `requirements.compare`, a `prompt` step, `file.write`.
   - (c) "write release notes from the last tag" → a `prompt` step, then `file.write`.
   - (d) "fix the failing test in src/x" → one `code` step with `checks: ["test"]`.

   When no folder is open, example (a) is replaced by a note that code steps need an open folder.
   - Rejected: few-shot full JSON plans. They triple the prompt, and weaker models copy them literally.
3. **Two new checks trigger the repair turn.** They are added in `planProblems` (`chatPlanner.ts:141`), applied
   only to drafts from the chat, never to workflow files.
   - **A coding goal with no code step.**
     - When it applies: a folder is open (`request.scripts !== undefined`), the person's message asks to change
       code, and the plan has no `code` node.
     - The test: `asksForCode(message)`, a pure function. It looks for build/change verbs (create, add, build,
       implement, fix, refactor, rename, make, update) together with a software noun (page, component,
       dashboard, app, endpoint, API, function, test, bug, UI, feature, file). Vietnamese equivalents are
       included (tạo, thêm, sửa, xây, làm; trang, giao diện, ứng dụng, chức năng, lỗi).
     - The reason given: "The request asks to change code; plan it with code steps (paths and checks)."
   - **A criterion that cannot be checked.**
     - It fires when a criterion is one of these, or a close variant: "requirements are defined", "data sources
       are identified", "the task is done", "everything works", "it is complete". The test is a small list of
       empty patterns, case-insensitive.
     - It also fires when a criterion is shorter than 4 words.
     - The reason given: "Criterion N cannot be checked; say what a person would look at (a file, a command's
       result, a visible behaviour)."
   - **What they share.** Both are problems that go into the existing single repair turn
     (`chatPlanner.ts:230`). A draft that still has them after the repair is shown with them listed and Run on.
     They are warnings, not blockers: a `Problem` gains `severity?: 'warning'`. Warnings do not turn off Run,
     and the card lists them under "Check before running".
   - Rejected: blocking Run. The word test can misfire, for example on "make a summary of the code".
4. **No change to how many calls a turn makes:** one, plus at most one repair. Rejected: two-stage planning (the
   user's choice).
5. **Version: the next minor** at merge (3.9.0 if it merges first after 3.8.x). CHANGELOG `### Changed`.

## Scope

In:

- `src/studio/steps.ts`: `StepDefinition.planning`, plus `use`/`avoid` for `prompt`, `docs.requirements`,
  `requirements.compare`, `file.write` and `gate`.
- `src/studio/codeStep.ts`: `planning` for `code`.
- `src/studio/chatPlanner.ts`:
  - the catalog lines;
  - the examples in `SYSTEM`;
  - `asksForCode`;
  - the vague-criteria check;
  - `severity: 'warning'` handling in `planProblems` and `draftPlan`.
- `src/studio/workflow.ts`: `Problem.severity?` (optional; validator output unchanged).
- `resources/studioChat.js` and `resources/studioChat.css`: warnings listed apart, with Run left on.
- Tests, `docs/agent-studio.md` (the planner section), `CHANGELOG.md`, `package.json`.

Out:

- Two-stage planning, templates.
- Changing which model drafts.
- Plan 8's stray `model` and `skills` clean-up. It is a separate fix, and this plan must not depend on it.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/studio/chatPlanner.ts:66` `stepCatalog`, `:87` `SYSTEM`, `:100` `buildPrompt` | Change |
| `src/studio/chatPlanner.ts:141` `planProblems`, `:196` `draftPlan` (one repair at `:230`) | Change: warnings, two checks |
| `src/studio/steps.ts:94` `StepDefinition`, the built-in steps (`:140`, `:218`, `:268`, `:314`, `:343`) | Change: `planning` |
| `src/studio/codeStep.ts:268` code step | Change: `planning` |
| `src/studio/workflow.ts` `Problem` | Change: optional `severity` |
| `resources/studioChat.js` plan card problems | Change: warnings apart, Run on |
| `src/test/studioChatSmoke.js` (scripted model records prompts) | Change: add cases |

## Tech stack and constraints

Default (`AGENTS.md`).

## Acceptance criteria

- [ ] **Catalog and prompt.** The prompt holds a `use:`/`avoid:` line for every built-in step type. Example (a) is
  present with a folder open and replaced without one. Checked by `node src/test/studioChatSmoke.js`, with a
  scripted model that records the prompt.
- [ ] **Coding goal repaired.** For "i need to create a weather dashboard", with a folder open, a scripted first
  reply plans one `docs.requirements` step. The second request (the repair) contains "The request asks to change
  code". When the scripted second reply has a code step, the draft has no warning. Checked by the same test.
- [ ] **Still a warning after the repair.** A second reply without a code step is shown with the warning, and Run
  stays on. The card shows "Check before running". Checked by the same test and by
  `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui` (new screenshot
  `53-studio-chat-plan-warning.png`).
- [ ] **No false repair.**
  - "summarise the open issues in docs/" gives no coding-goal warning.
  - "analyse requirement changes since v1.2" gives none.
  - Without a folder open, the coding check never fires.

  Checked by the same test, through a table of 12 messages (6 coding, 6 not, both languages) and
  `asksForCode`.
- [ ] **Vague criteria.** "Requirements are defined" and "done" get the warning. "`npm test` passes" and "the
  page shows today's temperature" do not. Checked by the same test.
- [ ] **Workflow files are unaffected.** `validateWorkflow` output for a workflow file is unchanged:
  `studioEngineSmoke.js` and `workflowEditSmoke.js` pass as before.
- [ ] **Failure first.** With `asksForCode` returning false, the "coding goal repaired" case fails. Report the
  message, then restore.
- [ ] **Required checks pass:**
  - `npm ci`;
  - `npm run lint` (0 errors; 2 known warnings);
  - `npm test`;
  - `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui`, with other
    screenshots unchanged or each difference explained;
  - `npm run package`.
- [ ] **Unverified until run in VS Code** (say so): how much a real weak model (GPT-4o mini) improves.

## Risks

| Risk | How it is handled |
| --- | --- |
| The word test misfires | A warning only, never a blocker; a table test in both languages |
| The prompt grows and costs more | Examples are sketches under about 600 characters each, about 2.4K total; the catalog lines are one line per step |
| A weak model still ignores the catalog | The repair turn names the exact reason; the warning tells the person before Run |
| Warnings hide real problems | Errors still block Run as today; warnings are listed apart |

## Open questions

None.
