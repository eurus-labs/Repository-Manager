# Agent Studio

Status: **proposal**. Nothing here is built. Items marked *(decided)* come
from the user. Items marked *(proposed)* wait for the user's decision.
Items marked *(open)* need an answer before the phase that depends on them.

## Problem

The extension has five places that call Copilot: commit message, change
summary, review and fix, the agent, and conflict and undo help. Each place
asks for consent, picks a model and logs in its own way. Review and the agent
also overlap: Fix with Copilot is a restricted agent step, and an agent step
never reviews its own diff.

The user's real work is a chain that starts long before code:

1. Analyze a requirement, and compare a new version with the old one.
2. Prepare the discussion with the PO, hold it, and reach a DoU
   (*(open)*: confirm the term, presumably Definition of Understanding).
3. Review the requirement. If it is good enough, create an initiative, then
   epics, then tasks in Jira.
4. Implement code task by task.

No single feature covers this chain, and the chain is not only coding
*(decided)*.

## Goal

A **Studio**: a place in VS Code where a person sets up a workflow once, with
little or no code, runs it, and sees each run. It replaces the Agent view and
takes Review in as one of its steps *(decided: review moves into the agent)*.
A workflow that is set up can later be packaged as a container and run
outside VS Code *(decided)*.

Out of scope for now:

- a web app;
- running a workflow without any person for steps that write or send (see
  Safety).

## Decisions so far

- VS Code extension first *(decided)*.
- Not limited to coding *(decided)*: the engine knows nothing about Git;
  code is one pack of steps among others.
- A workflow can be packaged as a container *(decided)*. Because of that:
  - the engine must run without `vscode`;
  - models must be reachable without Copilot.
- Connectors come from MCP servers, not built one by one *(proposed)*.
  - Jira, Confluence and Slack each become one generic "MCP tool" step, picking
    a server and a tool.
  - Studio orchestrates, gates and logs; the MCP ecosystem connects.
- Low-code first *(proposed)*.
  - A workflow is a file in the repository, edited through forms in the
    Studio and shown as a read-only diagram.
  - A free canvas comes later, only if real workflows need branching the forms
    cannot express.

### Earlier decisions this changes

These come from `docs/agent-harness.md` and need the user's confirmation
before they are replaced:

- **Review.** The earlier decision was: "Review does not get an icon and is not
  listed in it." Review becomes a Studio step, and its history a Studio view.
- **Implementation tasks.** These were "created by the developer who does them
  ... kept on that developer's machine". In the new chain, tasks come from Jira:
  Jira becomes the shared record of tasks. Local task state stays only for the
  run itself.

## The chain as workflows

One workflow per stage, not one flow for the whole chain *(proposed)*.
The stages take days and depend on meetings. Each stage ends with a file
committed to the repository, which the next stage starts from. This makes
every hand-over reviewable in Git, lets a stage be rerun alone, and lets a
container run any stage given the repository.

| Stage | Starts from | Steps (packs) | Ends with |
| --- | --- | --- | --- |
| 1. Analyze | Requirement docs at two revisions | Read docs (Docs) · diff of the two revisions (Code) · LLM: classify changes, find gaps and conflicts · Gate | `analysis/<req>.md`: what changed, impact, open questions |
| 2. Prepare PO discussion | Analysis | LLM: turn the open questions into clarification items · write the clarification file (Docs) · Gate | Clarification file (schema v3), items `open` |
| — PO discussion | — | People. The PO's answers go into the clarification file as response and decision events, as the Requirement Editor does today | Items `resolved`, DoU reached |
| 3. Review requirement | Resolved clarifications | Review with requirement skills (Review) · Condition: blocking findings? · Gate | Review report; stop, or continue to 4 |
| 4. Plan in Jira | Reviewed requirement | LLM: draft initiative → epics → tasks, each task linked to accepted criteria · Gate with preview · MCP tool: create issues (Jira) | Jira keys written back into the requirement's clarification items |
| 5. Implement | One Jira task | Agent: plan → (agent step → check → **review** → Gate) × n · commit · MCP: move the task | Branch and commits; task updated |

Pieces that already exist and become steps:

- **Requirements parser and navigation:** the Docs pack.
- **Clarification files (v2/v3):** the record of the PO discussion and of the DoU.
- **Review engine and skills:** the Review step. Requirement review needs its
  own skills, for example ambiguity, testability and conflicts.
- **Agent harness:** the plan, step, check and gate steps, the run log, and
  script approvals.
- **Write commit message:** the Commit step.

## Engine

**Workflow file** *(proposed)*: `.repository-manager/workflows/<name>.json`,
versioned in Git. It holds:

- `trigger`: manual, or a file changed;
- `inputs`;
- `steps`, an ordered list, each with:
  - `id`, `type`, `with` (its settings, which may reference earlier outputs as
    `${steps.<id>.output.<field>}`);
  - an optional `when` (a condition);
  - an optional `forEach` (a loop over a list).

That gives sequence, condition and loop. These are what the five stages need.
There are no arbitrary graph edges in phase 1.

**Items, not code types.** Steps pass `{ text?, files?, fields? }`. A step
declares what it reads and writes, so the form editor can offer only outputs
that fit.

**Runs** are persisted:

- state and run log as JSONL;
- a paused run resumes after a restart, which a gate waiting on a person needs;
- a run records the workflow file's commit, so it can be explained later.

**Models** go through `LmRouter` (`src/agent/lmRouter.ts`, already
Anthropic-shaped):

- Copilot in VS Code;
- an API provider (Anthropic, OpenAI-compatible) in a container, with a
  per-step model setting as in Musubi.

**Without `vscode`.** The engine and the packs import no `vscode`, following
the existing rule for testable services. The extension supplies the host:

- models;
- file access;
- gates shown as editor UI.

The container supplies another host:

- API models;
- the mounted repository;
- gates answered over HTTP or the CLI.

## Safety

Every step type declares its effect, and the engine, not the workflow author,
places the gates:

| Effect | Examples | Rule |
| --- | --- | --- |
| Read | read files, LLM, MCP read tools | runs freely |
| Write local | edit files in the workspace | a gate with the diff; in Code steps, on the task's branch only |
| Run command | scripts, checks | approved per command, as `ScriptApprovals` does today |
| **External** | create Jira issues, post, send | **always a gate showing exactly what will be sent; a workflow cannot remove it** |

A person may allow one specific tool of one MCP server without a gate, for
example "add a comment". That permission is stored per repository, logged on
each use, and never covers create or delete tools *(proposed)*.

**In a container, no person is present.** So a packaged workflow:

- runs Read steps;
- runs Write steps on a branch;
- stops at an External gate and waits for approval through the HTTP endpoint or
  the CLI.

Fully unattended external effects stay out of scope until the user decides
otherwise.

## Packaging as a container

`repository-manager workflow pack <name>` builds an image *(proposed)* with:

- the engine CLI (Node);
- the workflow file at its commit;
- the packs it uses;
- the MCP servers it names.

At run time the image takes:

- the repository (mounted or cloned);
- model and MCP credentials as secrets, never baked into the image;
- an approvals endpoint.

What does not move:

- Copilot (no `vscode.lm` outside VS Code);
- VS Code-only MCP configuration (it must be stated in the workflow).

## Studio in VS Code

One Activity Bar icon, **Studio**, replacing Agent. It lists:

- workflows, from the repository's files;
- runs, grouped as now: waiting, running, to do, done;
- reviews, the existing history.

A workflow opens in an editor with:

- one form per step;
- a read-only diagram of the steps with their conditions and loops;
- **Run** and **Dry run**. A dry run executes Read steps only and shows what
  each gate would ask.

## Phases

Each phase ends with something usable on its own.

1. **Review inside the agent.** A Review check after an agent step, and the
   existing Review tab opened from the Agent view. No new engine. This is the
   minimum value of the user's first request.
2. **Engine and Docs pack**, run from a command, with stages 1–2 as the first
   workflows. This proves the engine is not about code. The engine runs in
   Node without `vscode`, which its tests show.
3. **Studio view and form editor.** Runs, gates and the run log in the editor.
4. **Jira through MCP**, stage 4, with the External gate.
5. **Code pack on the engine**, stage 5. The agent harness becomes steps, and
   the old Agent view is replaced.
6. **Container packaging.** CLI host, API models, an approvals endpoint.

## Risks

- **Scope.** This turns a Git tool into a workflow platform. Mitigation: each
  phase must be used on the user's real chain before the next one starts; usage
  metrics (`docs/usage-metrics.md`) show whether it is.
- **A generic engine that fits nothing well.** Mitigation: only add step
  types, conditions and loops that the five stages use.
- **LLM output feeding external systems.** Mitigation: the External gate with
  an exact preview, and Jira keys written back to the requirement so every
  issue traces to its source.
- **Two hosts drift apart.** Mitigation: one engine test suite run against both
  hosts with scripted models, as the existing tests do.
- **MCP availability.** The Jira MCP server the user's organisation allows is
  not known yet *(open)*.

## Open questions

1. What does DoU stand for, and what makes it reached? For example: every
   clarification item resolved, and a PO decision event on each.
2. Is the old revision for "compare new and old" a Git revision of the
   requirement docs, a released baseline, or something else?
3. Which Jira MCP server, and which issue types: does the Jira project have an
   Initiative type?
4. Requirement review: which criteria count as blocking? These become the
   requirement review skills.
5. Should the earlier agent-harness decisions listed above be replaced?
