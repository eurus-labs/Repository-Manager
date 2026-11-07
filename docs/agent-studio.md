# Agent Studio

Status: **proposal**. Nothing here is built. Items marked *(decided)* come
from the user. Items marked *(proposed)* wait for the user's decision.
Items marked *(open)* need an answer before the phase that depends on them.

## Problem

The extension has five places that call Copilot:

- commit message;
- change summary;
- review and fix;
- the agent;
- conflict and undo help.

Each asks for consent, picks a model and logs in its own way. Each also does
one fixed job: a person cannot combine them into the way their team works.

Review and the agent overlap. Fix with Copilot is a restricted agent step, and
an agent step never reviews its own diff.

## Goal

A **Studio**: a place in VS Code where people define their own workflows,
see them as a diagram, run them, and share them as JSON. A workflow is any
chain of steps, not only coding *(decided)*.

## Decisions

- **Workflows are user-defined** *(decided)*. The Studio is not built around
  one process. The requirement-to-code chain below is a sample workflow and
  the first test of the engine.
- **Customization is declarative** *(decided)*. People define:
  - workflows;
  - prompt steps;
  - data schemas;
  - field mappings.

  They do not write code for a new step. A code plugin API waits until a real
  need is not met by prompt, MCP and script steps.
- **Workflows are shared as JSON files, with anyone** *(decided)*. A workflow
  is not tied to a project repository: it is one file that people pass around
  and import. A repository may also keep workflows of its own.
- **People define nodes and workflows with AI help** *(decided)*. Copilot, or
  another model, drafts from a description; the person reviews and edits the
  draft (see AI-assisted authoring).
- **Sub-workflows come later** *(decided)*.
- **Setup is visual** *(decided)*: a diagram editor. The JSON is the source of
  truth; the diagram reads it and writes it.
- **VS Code extension first** *(decided)*. A workflow can later be packaged as
  a container *(decided)*. Because of that:
  - the engine imports no `vscode`;
  - models are reachable without Copilot.
- **Review becomes a step** and its history a Studio view. Agent tasks come
  from wherever the workflow takes them, Jira for example. Both replace
  earlier decisions in `docs/agent-harness.md` *(decided)*.
- **Connectors are MCP servers**, not built one by one *(proposed)*.

## Three layers

### 1. Engine (fixed, not customizable)

The engine:

- runs steps along the workflow's edges, with conditions (`when`) and loops
  (`forEach`);
- pauses at a gate and resumes after a restart;
- persists each run (state, and a run log as JSONL);
- records the version of the workflow that ran;
- places gates by effect (see Safety). This is the safety boundary, so no
  workflow can change it.

The engine knows nothing about Git, requirements or Jira.

### 2. What users define

| Users define | How |
| --- | --- |
| A workflow | nodes and edges in the diagram editor, saved as JSON |
| A step of their own | a **prompt step**: instructions, typed inputs and an output schema, written in Markdown like a review skill |
| Data between steps | JSON Schemas they name, such as `Analysis` or `Plan` |
| A call to another system | an **MCP step**: pick a server and a tool, map the fields |
| A command | a **script step**: a repository script, approved per command |
| Extra approval | a **gate** anywhere. Gates can be added, never removed |

### 3. Built-in step library

Built-in steps are the features the extension has today, wrapped as steps:

- **Docs:** read requirement documents (RST or MyST), read and write
  clarification files.
- **Review:** run review skills on files or a diff, with triage.
- **Code:** agent step, check, Git diff, commit with a written message,
  branch.
- **Control:** condition, loop, gate, sub-workflow.

Each built-in step declares:

- its inputs and outputs (schemas);
- its effect: read, write local, run command, or external.

## Workflow JSON

One file per workflow, `<id>.workflow.json`, is the unit of sharing. The
Studio finds workflows in two places:

- **Library:** workflows the person imported or created, kept in the
  extension's global storage and available in every folder.
- **Repository:** `.repository-manager/workflows/*.workflow.json` in the open
  folder, if any.

Import takes a file or a URL. Export writes one file. Both work the same
whichever place the workflow came from.

```json
{
  "schema": "repository-manager/workflow@1",
  "id": "requirement-to-plan",
  "version": "1.2.0",
  "title": "Requirement to plan",
  "inputs": { "oldRequirements": { "type": "repository" }, "goals": { "type": "file" } },
  "types": { "Analysis": { "$schema": "…", "type": "object", "properties": { } } },
  "prompts": { "analyze": { "instructions": "…", "input": "…", "output": "Analysis" } },
  "connections": { "jira": { "mcpServer": "jira", "tools": ["create_issue"] } },
  "nodes": [
    { "id": "read-old", "type": "docs.read", "with": { "from": "${inputs.oldRequirements}" } },
    { "id": "analyze", "type": "prompt", "prompt": "analyze", "with": { "old": "${read-old.output}" } },
    { "id": "review", "type": "review.run", "with": { "skills": ["goal-alignment"] } },
    { "id": "approve", "type": "gate", "with": { "show": "${review.output}" } }
  ],
  "edges": [
    { "from": "read-old", "to": "analyze" },
    { "from": "analyze", "to": "review" },
    { "from": "review", "to": "approve", "when": "${review.output.blocking} == 0" }
  ],
  "layout": { "read-old": [0, 0], "analyze": [240, 0] }
}
```

- **Self-contained.** Prompt steps and schemas live in the file, so one file is
  the whole workflow. A larger team may move them to separate files and
  reference them; the exporter inlines them again *(proposed)*.
- **No secrets and no machine paths.** MCP servers are referenced by name.
  Credentials and local paths come from the machine that runs the workflow;
  import lists what that machine still has to provide.
- **`layout`** holds only the diagram positions. Removing it changes nothing in
  how the workflow runs.
- **Versioned.**
  - `schema` versions the format, which the engine migrates.
  - `version` versions the workflow.
  - A run records both, and the commit when the file is in a repository.
- **Validated** on load and on import:
  - edges point to existing nodes;
  - mapped fields fit their schemas;
  - loops have an end;
  - every node with an effect sits behind the gate the engine requires.

## Visual editor

The Studio opens a workflow in a webview editor:

- **Canvas:** nodes from the step library and the workflow's own prompt steps;
  edges, conditions and loops drawn as such.
- **Side panel:** the form for the selected node, with its inputs offered from
  earlier outputs whose schema fits.
- **Gates.** The gates the engine adds are drawn in, locked: the author sees
  where approval will be asked.
- **Problems** from validation, on the nodes they concern.
- **JSON.** "Open as JSON" opens the same file in the text editor; edits on
  either side show on the other.
- **Run, Dry run, Export, Import.** A dry run executes Read steps only and
  shows what each gate would ask.

## AI-assisted authoring

People describe what they want, and the AI drafts it. Drafting comes in three
forms:

- **New workflow.** "Every Monday, read the requirements changed last week,
  compare them with release 3, and draft open points for the PO" becomes a
  workflow JSON: nodes, edges, prompt steps and schemas.
- **New node.** "A step that extracts acceptance criteria from a requirement"
  becomes a prompt step with its instructions, input and output schema.
- **Change.** "Add a review before the gate" or "loop over each epic" is
  applied to the open workflow.

How it works:

- **Context.** The model gets the step library, with each step's inputs,
  outputs and effect, the workflow JSON schema, the open workflow, and the MCP
  tools this machine has. It only uses steps that exist.
- **Shown as a change, never applied directly.** The draft runs through the
  same validator as an imported workflow. It is shown on the canvas as a diff:
  added nodes, removed nodes, changed fields. The person applies it, edits it
  or discards it.
- **Repair.** When validation fails, the errors go back to the model once, as
  the review engine's repair turn does. If it still fails, the draft is shown
  with its problems rather than dropped.
- **Try it.** A drafted prompt step can be run on a sample input in its side
  panel before it is used.
- **The engine's gates still apply.** The AI cannot remove them, and a draft
  that tries to is invalid. A drafted workflow imported by someone else gets
  the same first-run approval as any import.
- **Consent and model.** This uses the one consent and model setting the
  Studio shares with other Copilot features. Nothing is sent without the
  consent.

## Safety

The engine places gates by each step's declared effect. A workflow cannot
remove them, including one imported from someone else.

| Effect | Examples | Rule |
| --- | --- | --- |
| Read | read files, LLM, MCP read tools | runs freely |
| Write local | edit files in the workspace | a gate with the diff; code steps write on a branch only |
| Run command | scripts, checks | approved per command, as `ScriptApprovals` does today |
| **External** | create issues, post, send | **always a gate showing exactly what will be sent** |

Imported workflows add one more rule. On first run, the engine lists every
effect, MCP tool and script the workflow uses, and the person approves them
for this repository. A changed `version` asks again for anything new
*(proposed)*.

**In a container, no person is present.** A packaged workflow runs Read steps
and Write steps on a branch, then stops at an External gate until it is
approved over HTTP or the CLI.

## Packaging as a container

`repository-manager workflow pack <file>` builds an image *(proposed)* with:

- the engine CLI (Node);
- the workflow JSON;
- the built-in steps it uses.

At run time it takes:

- the repository;
- model and MCP credentials as secrets;
- an approvals endpoint.

Copilot does not move: models go through `LmRouter` with an API provider.

## Sample workflow: requirement to code

The user's own chain, built from the layers above. It is split into
workflows that hand over files committed to the repository, because the chain
takes days and includes a meeting.

| Workflow | Starts from | Ends with |
| --- | --- | --- |
| Analyze | new requirements (this repository), old ones (RST in a separate repository) | `Analysis`: per requirement, added, changed, removed or unchanged; impact; open points |
| Review against goals | `Analysis`, customer goals | findings: requirement serving no goal; goal not covered; conflict with a goal |
| Prepare DoU | `Analysis`, findings | DoU (Discussion of Understanding): a clarification file (schema v3), one item per open point or finding |
| *(PO discussion, people)* | DoU | answers recorded as response and decision events |
| Plan | resolved DoU | `Plan`: initiative → epics → tasks, `key` empty |
| Create in Jira | `Plan` | issues created (External gate); keys written back to `Plan` |
| Implement | one task of `Plan` | branch and commits; task updated |

The schemas (`Analysis`, `Plan`), the prompt steps and the goal-alignment
review skill belong to this sample, not to the engine.

Its open points:

- where the customer's goals are written, and whether they have IDs;
- which findings block the Plan;
- which Jira MCP server to use (later: the I/O comes first *(decided)*).

## Phase 1 as built

Code lives in `src/studio/`. Everything except `studioCommands.ts` runs in Node without `vscode`;
`src/test/studioEngineSmoke.js` covers it.

**Workflow file** (`workflow.ts`). The format is `repository-manager/workflow@1`, as in the
example above. Validation reports every problem it finds, with where it is:

- the file: its format, required fields, node ids (unique, lowercase; `inputs`, `item` and
  `index` are reserved);
- steps: each type exists, its settings are known and the required ones are there, and a prompt
  node names a prompt of the file;
- types and prompts: schemas are well formed, and a prompt's `output` names a type;
- the graph: edges point to nodes, and there is no cycle (repeat with `forEach`);
- references: each one reads a declared input, the loop item (only with `forEach`), or
  `<node>.output` of a node that runs before it.

A path written literally in the file (`file.write` `path`, `docs.requirements` `from`) must be
relative and stay inside the workspace. A path chosen by the person as an input may be anywhere
for reading. `file.write` checks its target again when it runs. It refuses a target that is a
symbolic link, or whose nearest existing folder resolves outside the workspace.

**References** (`expressions.ts`):

- `${inputs.x}`, `${node.output.a[0].b}`, `${item}`, `${index}`. Only own data is read, plus
  `length` of a list or text.
- A string that is only `${…}` keeps the value's type; text around references makes text.
- Conditions: `==`, `!=`, `>`, `>=`, `<`, `<=`, `!`, or a value alone, where an empty list is
  false.
- Nothing is evaluated as JavaScript.

**Running** (`engine.ts`):

- Nodes run one at a time in dependency order, ties in file order.
- A node with incoming edges runs when at least one of them is taken (its source is done and its
  `when` holds); otherwise it is skipped.
- `forEach` runs the step once per item, and its output is the list of results. A loop whose
  reference gives no list fails the node; an empty list runs nothing and asks nothing.

**Gates.** Before a step with an effect, and at every `gate` node, the run waits with a preview
of exactly what will happen (for `file.write`: create or replace, the path and all of the
content; the dialog shortens it, and Show in Editor shows it whole).
The person approves or stops the run. A workflow cannot turn these gates off.

**Each run is kept** in the extension's workspace storage:

- `state.json`, written whole after each node;
- `log.jsonl`: start, nodes, model calls, waits, approvals and the finish;
- `workflow.json`, the workflow as it started.

A waiting run goes on after a restart. The run also records the file's hash and version.

**Steps:**

| Type | Effect | What it does |
| --- | --- | --- |
| `prompt` | read, uses the model | Sends `input` as data with the prompt's instructions and output schema. The reply must be one JSON object that fits the schema; one repair turn, then the node fails with the schema problems. Input over 120,000 characters fails: loop with `forEach` |
| `docs.requirements` | read | Requirements in the `.rst` and `.md` files of a folder, as the Requirements view reads them; with `ref`, at that Git revision (`git ls-tree` and `git show`), with the commit it read. A folder below the repository root is read as that folder |
| `requirements.compare` | read | Refuses a list with unread documents (`skipped`), since their requirements would look added or removed. Matches two lists by ID: `added`, `removed`, `changed` (title or text differ), `unchanged`, and counts. Same text under another ID is a `possibleRename`, never merged |
| `file.write` | write | Text, JSON, or Markdown with fenced JSON (`markdown-json`), inside the workspace |
| `gate` | — | Waits for the person, showing `show` |

**In VS Code** (`studioCommands.ts`):

- **Run Workflow…** lists the workflows in `.repository-manager/workflows/`, the library (global
  storage) and the samples (`resources/studio/samples/`).
- It asks the inputs: a folder, or a repository folder and a revision, or text.
- Before starting, one dialog says what the run sends to Copilot (the selected model, as the other
  Copilot features use it), what it will ask before doing, and where it stops for an answer.
- Each gate is a modal with the preview, **Show in Editor** for the whole of it, **Approve** (or
  **Continue**) and **Stop Run**. Closing it leaves the run waiting.
- **Show Workflow Runs** lists runs: a waiting one goes on, any other opens its state and log.

**Sample.** `analyze-requirements.workflow.json` (stage 1 of the sample above): read the new
requirements and the previous ones at a revision, compare them by ID, analyze each change with
the model (`forEach`), and write `analysis/requirement-changes.md` after approval. With no change,
analysis and writing are skipped.

**Not in phase 1:**

- the Studio view and the visual editor;
- AI authoring, import and export, and the first-run approval of an imported workflow;
- MCP, script and code steps;
- containers.

Live Copilot calls are not verified outside VS Code: the tests use a scripted model.

## Phases

Each phase ends with something usable on its own.

1. **Engine and workflow JSON** (format, validation, runs, gates), with prompt
   and Docs steps. It runs from a command, and its tests run in Node without
   `vscode`. The first workflow is the sample's "Analyze".
2. **Visual editor**: canvas, side panel, JSON round-trip, problems, and
   **AI-assisted authoring** of workflows and prompt steps.
3. **Sharing**: export and import with the approval list, and the Studio view
   listing workflows and runs.
4. **Review and Code steps.** The agent harness becomes steps, Review joins
   it, and the old Agent view is replaced.
5. **MCP steps**, starting with the sample's Jira workflow.
6. **Container packaging.**

## Risks

- **A generic engine that fits nothing well.** Mitigation: phase 1 is checked
  against the sample workflow, and step types are added when a real workflow
  needs them.
- **Imported workflows doing more than the importer expects.** Mitigation:
  - effects are declared and approved on first run;
  - the engine's gates cannot be removed;
  - no code runs from a workflow.
- **A diagram and JSON that disagree.** Mitigation: the JSON is the only
  source, the diagram is rendered from it, and the round-trip is tested.
- **Scope.** Mitigation: usage metrics (`docs/usage-metrics.md`) show whether
  each phase is used before the next one starts.

## Open questions

None for phase 1. The sample workflow keeps its own open points (above).
