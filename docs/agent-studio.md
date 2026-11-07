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
2. Prepare the DoU (Discussion of Understanding: the open points the
   developers need the PO to clarify), discuss it with the PO, and record the
   answers.
3. Review the requirement analysis against the goals the customer set: find
   requirements that do not serve them. If the analysis holds, create an
   initiative, then epics, then tasks in Jira.
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

### Earlier decisions this changes *(decided: replace them)*

These came from `docs/agent-harness.md`; the user agreed to replace them, and
that document will be updated when phase 1 lands:

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
| 1. Analyze | New requirements (this repository) and the old ones (RST in a separate repository) | Read both sets (Docs) · match requirements by ID · LLM: classify each as added, changed, removed or unchanged, and find gaps and conflicts · Gate | Analysis (see I/O) |
| 2. Prepare DoU | Analysis | LLM: turn the open questions into DoU points · write the clarification file (Docs) · Gate | DoU: clarification file (schema v3), points `open` |
| — Discuss with PO | DoU | People. The PO's answers go into the DoU as response and decision events, as the Requirement Editor does today | Points `resolved` |
| 3. Review analysis | Analysis, resolved DoU, customer goals | Review with goal-alignment skills: does each requirement serve a customer goal, and does each goal have requirements (Review) · Condition: blocking findings? · Gate | Review report; stop, or continue to 4 |
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

## I/O between stages

Phase 2 fixes these shapes; Jira itself comes later *(decided: design the I/O
first)*. Every file is Markdown with fenced JSON where structure is needed, so
people read it and steps parse it, as clarification files already do.

**Inputs of stage 1**

- `new`: requirement documents in this repository (RST or MyST, as the
  Requirements view reads them).
- `old`: a second repository with the previous requirements as RST
  *(decided)*. The workflow names its location and revision (`repository`,
  `ref`); the run records the commit it read.
- `goals`: the customer's goals, needed by stage 3 *(open: where they live)*.

**Analysis** (`analysis/<scope>.md`), one entry per requirement:

```json
{ "id": "REQ-123", "change": "added|changed|removed|unchanged",
  "old": { "ref": "<commit>", "text": "…" }, "new": { "ref": "<commit>", "text": "…" },
  "summary": "what changed and why it matters", "impact": ["…"],
  "openPoints": ["question the PO must answer"], "goals": ["G-2"] }
```

Matching is by requirement ID. An ID found on one side only is `added` or
`removed`. A requirement whose ID changed with the same text is reported as a
possible rename, never merged silently.

**DoU**: the existing clarification file, schema v3, one item per open point,
`Related requirements` set to the requirement's ID. Nothing new.

**Review report**: the review engine's report. Each finding names a
requirement and a goal:

- *not serving any goal*;
- *goal not covered*;
- *conflicts with goal*.

**Plan** (`plan/<scope>.md`), the input of stage 4, independent of Jira:

```json
{ "initiative": { "title": "…", "goals": ["G-2"] },
  "epics": [ { "key": null, "title": "…", "requirements": ["REQ-123"],
    "tasks": [ { "key": null, "title": "…", "criteria": ["REQ-123-AC1"], "description": "…" } ] } ] }
```

`key` is empty until an issue exists. Stage 4 fills it in, and stage 5 starts
from one task of this file.

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

## Answered

- DoU is the Discussion of Understanding: the open points developers need the
  PO to clarify. It is the clarification file.
- The old requirements are RST files in a separate repository.
- Jira: design the I/O first. The Plan file is the hand-over, and the server
  and issue types are chosen later.
- Stage 3 reviews the requirement analysis against the customer's goals.
- The earlier agent-harness decisions are replaced.

## Open questions

1. Where are the customer's goals written, and do they have IDs? Stage 3
   needs them as an input.
2. Which goal-alignment findings block stage 4: any requirement serving no
   goal, or only a conflict with a goal?
