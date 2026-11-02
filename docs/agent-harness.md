# Agent harness

Status: **phase 1 implemented (2.16.0)**; phases 2-4 are proposals. Decisions
made by the user are marked *(decided)*. "Phase 1 as built" below records what
the code does, including choices made while building it; the model paths have
not been run against Copilot in VS Code yet.

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
- Rail *(decided)*: one Activity Bar icon, **Agent**, added with phase 1.
  Review does not get an icon and is not listed in it; reviews stay in the
  dashboard and the Review tab.

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
- **Where work happens**: each task runs on its own branch, created when the
  plan is approved, so the user's branch is never edited directly.

## Interface

Today the Activity Bar holds Repository Manager and Requirements; the Agent
icon is the third. Container id `repository-manager-agent`, view
`repositoryManager.agent.tasks`.

- Side bar: **Tasks** grouped by what each waits for (Waiting for you,
  Running, To do, Done); New Agent Task in the view title; Delete in a task's
  context menu. The view's badge counts the tasks waiting for you, which is
  the reason for an icon of its own: a step waiting for approval is visible
  from any other area.
- Editor, one task: its goal and criteria (marked frozen once approved); the
  plan as a step list with each step's state; the current step with what it
  may change, its tools and its checks, and Run / Edit / Skip / Stop; after
  it runs, its summary, changed files (Diff opens VS Code's diff against the
  content before the step), check results, text that speaks to an AI, its
  tool calls, and Accept / Retry / Stop (and Accept anyway when a check
  failed); the run log with tokens.
- Status bar: the task waiting for you, or how many, when any is.

## Phase 1 as built

Code: `src/agent/` (`lmRouter.ts`, `agentTools.ts`, `agentRunner.ts`,
`taskStore.ts`, `agentPage.ts`, `agentView.ts`); tests:
`src/test/agentHarnessSmoke.js` (scripted models on a real Git repository).

- Router: `CopilotRouter` uses the JSON tool protocol only (`{"tool": …}` /
  `{"final": …}`, one repair request for a malformed reply). Native tool
  calling is not used yet; the minimum VS Code for it remains unverified.
  The model is the one chosen in the dashboard's model menu.
- Sending code asks according to `repositoryManager.copilot.askBeforeSending`,
  sharing the per-repository "Always allow" with reviews.
- A task's repository is a workspace folder's Git repository. Repositories
  nested inside a folder (the dashboard's linked repositories) cannot be
  chosen yet.
- Planning may only read (`read_file`, `list_files`, `search_code`), with at
  most 15 tool calls. The plan is checked: at most 10 steps; unknown tools,
  paths leaving the repository and scripts the repository does not have are
  dropped.
- Approving the plan requires: every check script approved, and no
  uncommitted changes to tracked files. It then creates `agent/<title>-<id>`
  from the current branch and freezes the goal and criteria.
- Scripts are the `package.json` scripts, run with `npm run`. They are approved
  once per repository **per script, with its command**: a script whose command
  changes asks again, and approving `test` never approves `deploy`. Only
  scripts a plan uses are asked about. Other build systems are not supported
  yet.
- A step's run: at most 25 tool calls; reading is always allowed; edits only
  to the paths the step lists (a folder covers what is under it), never into
  `.git`, never through a link out of the repository, never to a file with
  unsaved editor changes, at most 200 KB per file. The repository must be on
  the task's branch.
- Every change keeps the content from before the step. A failed run, Retry,
  and Stop on a step under review put it back; a file changed since the step
  is left as it is and named. The task is saved after every tool call, so a
  window closed mid-step is undone on the next start.
- Accept is refused while a check failed. **Accept anyway** *(decided)*
  keeps the step after a confirmation, for a check that failed before the
  task too; the step is marked with its failing checks, on the page and in
  the run log (`acceptAnyway`). A step runs at most 3 times. Retry sends the
  failed checks' output with the next run.
- The agent does not commit *(decided)*: accepted steps stay as uncommitted
  changes on the task's branch, and the developer writes the commits from the
  dashboard.
- Tasks and run logs: JSON files and JSON Lines in the extension's workspace
  storage (`storageUri/agent`), never in the repository.

## Phases

1. *(Done in 2.16.0)* Harness core: `LmRouter` + `CopilotRouter`, the tool surface, plan and step
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
