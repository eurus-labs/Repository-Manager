# Agent harness (proposal)

Status: **proposed, not implemented.** Decisions already made by the user are
marked *(decided)*; the rest are proposals awaiting their review. Nothing here
describes shipped behavior.

## Goal

Turn the Review area into an agent that people give work to, not only a
reviewer. A developer or a PO assigns a task; the agent proposes a plan as a
list of steps; each step runs only after a person approves it; the result is
checked by deterministic code before the next step. The extension replaces
Copilot Chat for this work *(decided)*: the agent lives in the extension and
knows what Copilot Chat does not (linked repositories, requirements and their
accepted criteria, the review engine).

## Decisions

- Option (a): the harness is written in TypeScript inside the extension, not a
  front end for the Python Musubi harness *(decided)*. Musubi
  (`eurus-labs/Musubi`) is the reference for its concepts and its model
  configuration.
- Who assigns: developers and POs *(decided)*.
- Autonomy: the agent drafts a list of steps; a person approves each step
  before it runs *(decided)*.
- Models: Copilot through `vscode.lm` first *(decided)*; external models later,
  configured the way Musubi does (below).

## Concepts (from Musubi, adapted)

- **Task**: a goal, who assigned it, the repository or repositories it may
  touch, and its acceptance criteria.
- **Frozen contract**: when the plan is approved, the goal and the acceptance
  criteria are fixed for the run. A step may not change them; changing them
  means a new plan, approved again. (Musubi: "freeze acceptance contract".)
- **Plan**: an ordered list of steps. Each step states what it will do, the
  tools it needs, the paths it expects to change, and how it will be checked.
- **Step approval**: before a step runs, the person sees that statement and
  chooses Run, Edit (change the step's text), Skip, or Stop. After it runs they
  see its diff, its tool calls and its checks, and choose Accept (go on) or
  Retry (bounded, with the same criteria) or Stop.
- **Verification is deterministic**: a step passes on its checks (commands the
  repository already has, such as its lint and tests, and the review engine),
  never on the model saying it is done.
- **Run log**: an append-only record of each model call (tokens), tool call,
  approval and check result, kept per run. It is what the run view shows.
- **Bounded retries**: a failed check can be retried a fixed number of times;
  each retry keeps the frozen criteria.

## Architecture

- `LmRouter` (TypeScript): one call, `call(messages, tools) → { stopReason,
  content, usage }`, with Anthropic-shaped messages and tools, the same
  boundary as Musubi's `LMRouter` (`musubi/agent/vendors/base.py`). Each
  vendor converts to its own wire format.
  - `CopilotRouter` first: `vscode.lm`. Where the installed VS Code offers the
    language model tool-calling API, it uses it; otherwise it uses the JSON
    tool protocol the review engine already uses
    (`src/services/securityReviewProvider.ts`). The minimum VS Code version for
    native tool calling is **not verified** yet (the extension declares
    1.74; Copilot features need 1.91).
  - Later: Anthropic, OpenAI, Azure, Ollama and an OpenAI-compatible gateway,
    read from Musubi's `.musubi/llm.json` (family-keyed profiles, a `default`,
    and `api_key_env` naming an environment variable, never the key itself),
    so one configuration serves both tools. VS Code SecretStorage as an
    alternative to environment variables.
- **Tool surface** (workspace-scoped, each step lists the subset it may use):
  `read_file`, `search_code`, `list_files`, `edit_file` (exact replacement, as
  Fix with Copilot does), `create_file`, `run_check` (only commands the user
  allowed for the repository, such as `npm test`), and Git actions through the
  existing services (create a branch; commit only as an approved step). No
  push, no arbitrary shell, no file outside the task's repositories.
- **Safety already in the extension, reused**: the consent setting before code
  is sent to a model (`copilot.askBeforeSending`); refusing to edit a file with
  unsaved changes in an editor (`reviewFixService`); flagging text in the
  repository that speaks to an AI (`aiDirectedText.ts`), shown on the step
  that read it.
- **Where work happens**: each task runs on its own branch, created as the
  first approved step, so the user's branch is never edited directly.

## Interface

The rail's Review icon becomes **Agent**.

- Side bar: **Tasks** grouped by state (Waiting for you, Running, To do, Done),
  then **Past reviews** (a review is a task type), **Skills** and **Model**.
- Editor, one task: its goal and frozen criteria; the plan as a step list with
  each step's state; the current step's card with its intent, tools and
  expected paths and the Run / Edit / Skip / Stop buttons; after it runs, the
  diff, the checks and Accept / Retry / Stop; the run log.
- Status bar: the task waiting for approval, if any.

## Open questions (for the user)

1. The first three task types. Proposed: implement an accepted acceptance
   criterion of a requirement; fix review findings; a free-form task typed by a
   developer.
2. Where assigned tasks live so a PO and a developer share them. Proposed: as
   files in the repository (docs-as-code), for example
   `.repository-manager/tasks/TASK-012.md`, reviewed in pull requests like
   clarification files. The alternative, local to one machine, cannot carry a
   PO's assignment to a developer.
3. Where run logs live. Proposed: the extension's storage on the machine that
   ran the task (they hold model output and tool results), with a summary
   written into the task file when it is done.
4. Which commands a step may run. Proposed: the repository's own scripts,
   approved once per repository, like the consent for sending code.

## Phases

1. Harness core: `LmRouter` + `CopilotRouter`, the tool surface, plan and step
   approval, the run log, free-form tasks, the Agent area UI.
2. The review engine as the verifier; Fix review findings as a task type.
3. Tasks assigned from Requirements (an accepted criterion becomes a task).
4. External models from `.musubi/llm.json`.

## Risks

- Model quality through Copilot varies by the chosen model; plans and edits
  may need several retries. The run log makes cost and retries visible.
- A step that runs commands can do damage; only allowed commands, per step,
  after approval.
- Repository text can try to steer the model; the AI-directed text check
  marks it, but cannot prove its absence.
- Concurrent edits: the user editing the same files while a step runs. The
  step refuses files with unsaved editor changes and re-checks before writing.
