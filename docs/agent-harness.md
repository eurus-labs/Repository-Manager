# Agent harness (proposal)

Status: **proposed, not implemented.** Decisions already made by the user are
marked *(decided)*; the rest are proposals awaiting their review. Nothing here
describes shipped behavior.

## Goal

Turn the Review area into an agent that people give work to, not only a
reviewer. A developer gives it a task; the agent proposes a plan as a
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
- Who gives work: POs at the requirement level, developers at the
  implementation level (see Tasks have levels) *(decided)*.
- Autonomy: the agent drafts a list of steps; a person approves each step
  before it runs *(decided)*.
- Models: Copilot through `vscode.lm` first *(decided)*; external models later,
  configured the way Musubi does (below).
- First task types *(decided)*: implement an accepted criterion of a
  requirement; fix review findings; a free-form task typed by a developer.
- Tasks have levels *(decided)*. A PO works at the requirement level: the
  requirement and its accepted criteria, already shared as docs-as-code
  clarification files, are what a PO hands over. Implementation tasks are
  created by the developer who does them, not assigned by a PO, and are kept
  on that developer's machine (extension storage), not in the repository. So
  no shared task file is needed: the shared record stays the requirement.
- Run logs are kept on the machine that ran the task *(decided)*, in the
  extension's storage (they hold model output and tool results). A short
  summary (outcome, checks, branch) may be written into the task when it is
  done; it stays local like the task.
- Commands a step may run *(decided)*: only the repository's own scripts (for
  example `npm test`, `npm run lint`), approved once per repository, the way
  the consent for sending code is asked once.
- Rail *(proposed by the user, shape below awaits confirmation)*: the agent
  and Review get their own Activity Bar icon.

## Concepts (from Musubi, adapted)

- **Task**: a goal, who created it, the repository or repositories it may
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

Today the Activity Bar holds two icons from this extension, Repository Manager
and Requirements; Review has no icon (it is an editor tab opened from the
dashboard's ⋯ menu). The proposal adds **one** icon, not one for Review and
another for the agent, because a review is a task type of the agent and two
icons would show the same past reviews twice.

- Container id `repository-manager-agent`, views `repositoryManager.agent.*`,
  fixed from the first release. VS Code remembers where a user moved a view
  by its id, so the ids must not change when the title does. The title is
  **Review** while only reviews exist and becomes **Agent** in phase 1.
- Why an icon of its own instead of a view inside Repository Manager: the
  icon's badge. A step waiting for approval must be visible while the user is
  in another area; the badge shows the number waiting for them. Before
  phase 1 the badge counts blocking findings still to fix in the newest
  review of each repository.
- Phase 0 content: **Past reviews** from the existing review history
  (`ReviewHistoryStore`, workspace state), grouped by repository, each row
  with its target, readiness and finding counts; title buttons Review local
  changes, Review branch and Open Review tab. Opening a row opens the Review
  tab on that review.
- Side bar from phase 1: **Tasks** grouped by state (Waiting for you, Running,
  To do, Done), then **Past reviews**, **Skills** and **Model**.
- Editor, one task: its goal and frozen criteria; the plan as a step list with
  each step's state; the current step's card with its intent, tools and
  expected paths and the Run / Edit / Skip / Stop buttons; after it runs, the
  diff, the checks and Accept / Retry / Stop; the run log.
- Status bar: the task waiting for approval, if any.

## Open questions (for the user)

1. The rail shape above: one icon titled Review now and Agent later, with
   past reviews in phase 0. The alternative is to wait and add the icon only
   with phase 1. (Earlier feedback said there are already too many side bars;
   a third icon is the cost.)

## Phases

0. The rail icon with Past reviews and the review commands (no agent yet).
1. Harness core: `LmRouter` + `CopilotRouter`, the tool surface, plan and step
   approval, the run log, free-form tasks, the Agent area UI, local task storage.
2. The review engine as the verifier; Fix review findings as a task type.
3. Tasks from Requirements: the developer creates an implementation task
   from an accepted criterion.
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
