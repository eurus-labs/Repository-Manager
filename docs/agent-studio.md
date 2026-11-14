# Agent Studio

Status: phases **1, 2a and 2b are built** (2.19.0, 3.0.0); later phases are
proposals. The "as built" sections record what the code does. Items marked *(decided)* come
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

## Phase 2b design: Studio Chat

Status: **built (3.0.0)**, from the user's decisions of 2026-11-09; the
"as built" sections for 2b-1, 2b-2 and 2b-3 say what the code does. It changes the
AI-assisted authoring above in one way: drafting happens in a chat, and a
drafted plan is a workflow that can be run at once, not only a file to edit.

### Decisions *(decided 2026-11-09)*

- **One chat, Copilot-like**, is the way in. A person types a goal; the AI
  answers with a plan. The plan *is* a workflow: each step is a node. The
  person changes it by chatting ("split step 2", "add a review before the
  write") or in the diagram, then runs it. This replaces the Agent view's
  form (goal and criteria in two input boxes); the Activity Bar's Agent icon
  becomes **Studio** and opens the chat. Parts of phase 4 move here: see the
  rounds below.
- **Only the goal is asked for.** No criteria input. The AI proposes the
  acceptance criteria with the plan; they are shown on the plan card and the
  person edits or removes them before Run. From Run on they are frozen in the
  run state, as the agent's criteria are today.
- **A model is chosen when the plan is drafted**, in the chat's input bar
  (the models `vscode.lm` offers). **Each step may choose its own model**; a
  step without one uses the plan's.
- **Skills are optional per step**, and come from GitHub repositories such as
  `eurus-labs/skills`, fetched by the extension with the person's VS Code
  GitHub sign-in.

### The chat

- A webview view in the Studio container: messages, and an input bar with
  the model picker and a skill picker (`/` lists skills).
- An AI reply that drafts or changes a plan carries a **plan card**: the
  goal, the proposed criteria (editable), and the steps. Each step shows its
  type, what it does, its effect badge (writes, runs, sends), a model
  dropdown and its skills as removable chips. Buttons: **Run**, **Open in
  diagram**, **Save as workflow**.
- A change to an existing plan is shown as a diff on the card (added,
  removed, changed steps) and applied only when the person accepts it, as
  "Shown as a change, never applied directly" above requires.
- A run's progress, its gates and its result appear in the same thread, so a
  conversation reads goal → plan → run → result. Gates keep their modal
  approval: the chat shows them, it does not replace them.
- Conversations are kept on this machine (workspace storage), like agent
  tasks. A plan is written to a file only on **Save as workflow**
  (`.repository-manager/workflows/<id>.workflow.json`) or when the person
  opens it in the diagram.

### Workflow format additions

All optional, so every 2.19.0 workflow stays valid:

```json
{
  "criteria": ["Each changed requirement has an open point or a reason why not"],
  "defaults": { "model": "copilot:gpt-5" },
  "nodes": [
    { "id": "analyze", "type": "prompt", "prompt": "analyze",
      "model": "copilot:claude-sonnet-4.5",
      "skills": ["github:eurus-labs/skills/plugins/testing/skills/write-tests@3f2a9c1"] }
  ]
}
```

- **`model`** is `<vendor>:<family>`, matched with
  `vscode.lm.selectChatModels`. A model this machine does not have is not an
  error in the file (the file is shared); at Run it is listed, and the
  person picks a replacement once for the run. The run log records the model
  that actually answered, as it does today.
- **`skills`** are references pinned to a commit. A shared workflow then
  runs with the same skill text everywhere, and a skill that changes upstream
  changes a workflow only when someone updates the pin (the skill picker
  offers it).
- **`criteria`** is the plan's frozen list. Steps that verify (code steps,
  the review step) receive it; the final summary lists each criterion with
  the evidence the run has for it, or "not shown".

### Skills from GitHub

- **Sources:** a setting, `repositoryManager.studio.skillSources`, lists
  repositories (`eurus-labs/skills` by default). The extension asks VS Code
  for a GitHub session (`repo` scope, so private repositories work), lists
  the `SKILL.md` files of the default branch through the GitHub API, and
  reads their front matter (`name`, `description`) for the picker.
- **Cache:** a skill is downloaded at its pinned commit into global storage
  (`skills/<owner>/<repo>/<sha>/…`), with its folder's `references/`. A
  cached commit is never fetched again; nothing is fetched without a
  session, and the picker says why.
- **Use:** a step that has skills gets each `SKILL.md` body as instructions,
  before its own, and may read the skill's references (code steps through
  their read tool; prompt steps get the files the skill names, within the
  input limit).
- **Limits, said plainly in the picker:**
  - scripts in a skill (`scripts/`, often Python) are **not run**; a skill
    that depends on them is marked "uses scripts: not run here";
  - a skill is instructions the model follows, so adding one is trusting its
    repository. The first use of a source asks once, per source, showing its
    URL; skills never lift the engine's gates.

### Rounds

Each round ends usable on its own. The user asked for all three before the
release, so they ship together in 3.0.0, one commit each.

1. **2b-1, Chat and plans.** The chat view, model picker, plan card with
   criteria and per-step model, follow-up changes as a diff, Run in the
   thread, Save as workflow. Plans use the existing steps (prompt, docs,
   compare, file.write, gate). The format gains `criteria`, `defaults.model`
   and `model`.
2. **2b-2, Skills.** GitHub sources, the picker, pinned references, the
   cache, per-source consent, and skills in prompt steps.
3. **2b-3, Code steps and the Agent view.** The agent's step runner becomes a
   `code` step (tools, the repository's checks, Accept / Retry); the
   Agent icon becomes Studio; existing agent tasks stay readable but new
   tasks start in the chat. This is the part of phase 4 the merge pulls in;
   the review step stays in phase 4.

### Risks and how each is handled

- **The AI uses a step type or a `${…}` reference that does not exist.** The
  draft goes through `validateWorkflow`; errors go back once (repair turn);
  a draft still invalid is shown with its problems and cannot run.
- **A follow-up silently drops steps.** Changes are applied only as a shown
  diff, and the test drives a reply that removes a node.
- **Approving a drafted plan without reading it.** Steps that write, run or
  send keep their engine gates with the exact content; the plan card shows
  each step's effect badge.
- **A shared workflow names a model or skill this machine lacks.** Listed at
  Run with one choice per item, never a silent substitute.
- **A skill changes behaviour after the fact.** Skills are pinned by commit.
- **Prompt injection through a skill or a fetched reference.** Skills are
  trusted only per source after consent; repository text stays data (the
  agent's rule) and gates still apply.
- **GitHub API limits or no sign-in.** The cache serves pinned skills
  offline; the picker shows the error instead of an empty list.
- **Scope.** Three rounds, each released and tried before the next starts.
  The usage log does not record chat use yet; whether it should is open.

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

A waiting run goes on after a restart. The run also records the file's hash and version. A cancelled run does not: Cancel ends it for good, and stopping at a gate is how to pause (decided 2026-11-09).

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

## Phase 2a as built: the visual editor

A `*.workflow.json` file opens in the Workflow Editor (`src/studio/workflowEditorProvider.ts`,
`resources/studioEditor.js`).

**One source.** The editor is a custom *text* editor: the file is a VS Code text document and
the page keeps no copy of its own.

1. The page sends an edit, such as `{ op: 'renameNode', id, to }`.
2. The host applies it to the parsed file (`workflowEdit.ts`, no `vscode`) and replaces the
   document's text.
3. Every change to the document, from the page or from the JSON editor beside it, draws the page
   again.

So Undo, Redo, Save, dirty state and hot exit are VS Code's own. The written file has a stable
key order and two-space indentation. Edits apply one after another, each to the text the one
before left, so two quick edits never undo each other. The editor is registered with or without a
folder; running a workflow needs one.

**Edits:**

- workflow fields;
- add a step (a free id, its required settings empty, a place), remove one (its edges and place go
  too), rename one;
- step title, prompt and `forEach`;
- settings: JSON when the text reads as JSON, text otherwise; quote a value to keep it text
  (text that only starts like JSON, such as `[note] hello`, is shown quoted);
- move a step (only the drop is written), add and remove edges, edge conditions;
- inputs, prompts and types;
- **Arrange** lays the steps out again in columns by depth.

A rename also renames the step in edges, positions, and every `${…}` reference that reads it.
An edit that cannot apply (invalid JSON in a schema, a name in use) is said on the page and
leaves the file alone.

**The page:**

- **Palette:** the step library, each with what it does.
- **Diagram:**
  - steps in boxes; steps that write, run or send are dashed and show "🔒 asks before it
    writes files", the engine's gate, which the page cannot remove;
  - `gate` steps show "⏸ waits for your answer", and prompt steps are marked AI;
  - conditions are shortened on the edge, whole on hover.
- **Problems:** the validator's problems, listed and shown on the steps they concern; Run is off
  while there are any.
- **Side panel:**
  - the workflow: its fields, what a run sends and asks, inputs, prompts and types;
  - or the selected step: its fields, settings, the steps after it with their conditions, and
    Delete.
- **Keyboard:** steps are reachable with Tab; Enter selects and Delete removes.
- **Open as JSON** opens the text editor. **Run** saves, then runs the file through Run Workflow….

A file that is not JSON, not a workflow, or with nodes, edges or a layout the diagram cannot draw,
is said, with its problems and only Open as JSON offered.

**Tests:**

- `src/test/workflowEditSmoke.js` covers the edits in Node.
- `src/test/studioEditorUi.js` drives the real page in Chromium against the real provider and a
  fake text document. It covers the diagram, a rename that updates references, an edit made as
  JSON, adding and connecting a step, a problem shown on its step, a drag, a refused edit, Delete,
  Open as JSON, and Run.

**Not in 2a:** AI-assisted authoring (2b).

## Phase 2b-1 as built: the Studio Chat

What the code does, including choices made while building it. Model paths are
scripted in the tests; a chat with Copilot in VS Code has not been run yet.

- **Where.** **Studio**, a container in the Secondary Side Bar (on the
  right, as Copilot's chat; `viewsContainers.secondarySidebar`, which needs
  VS Code 1.104, so the extension requires it), holds one view, **Chat** (a
  webview view). Its title bar has **New Studio Chat** and **Studio Chat
  History**. (Before 2026-11-12 it was the Agent's Activity Bar container,
  above Tasks.) With no
  folder open the chat drafts plans but cannot run or save them, and says so.
- **Planner** (`src/studio/chatPlanner.ts`, no `vscode`). One prompt per turn
  holds the rules, the step catalog (each step's description, settings and
  effect, from the registry), the format, the current plan, the last 8 turns
  and the new message. The model answers
  `{"reply": "…", "workflow": <whole plan> | null}`. The plan is normalized
  (format, id and version kept from the current plan; `layout` taken from the
  current plan for nodes that stay, never from the model) and checked with
  `validateWorkflow` plus two plan rules: at least one criterion, at most 20
  nodes. One repair turn with the problems; a plan still invalid is shown
  with them and Run is off.
- **Conversation rules** (`src/studio/chatSession.ts`). The first plan is the
  plan. A later plan is a **proposed change** with its diff (nodes added,
  removed, changed, including a changed prompt; criteria added and removed;
  title, inputs, prompts, types, defaults, edges); only the latest can be accepted;
  an earlier one is marked superseded. A plan identical to the current one is
  a plain reply. The card edits criteria, the plan's default model and a
  step's model, nothing else (the diagram does the rest).
- **Models** (`src/studio/studioModels.ts`). Selectors are
  `<vendor>:<family>` of every chat model `vscode.lm` lists (Copilot's and
  other vendors'), one per family; a model with no family (a custom endpoint)
  is named by its id. Copilot's models are asked for by vendor as well as in
  the full list, Copilot's first: the full list alone left them out in VS
  Code (reported 2026-11-13, fixed in 3.2.1). The menu is read again when VS Code says
  the models changed and when the person opens it: Copilot's models load
  after VS Code starts, and a list read once at start can stay empty
  (reported by the user, 2026-11-12). It says "Loading models…" or "No model
  yet: sign in to Copilot" while there is none.
  The composer's choice drafts; without one, the dashboard's model. In a run,
  a node uses its `model`, else the workflow's `defaults.model`, else the
  dashboard's model. Before a run, each named model this VS Code lacks is
  replaced by one the person picks; the choice is stored in the run
  (`models`) and logged, and the file is not changed.
- **Criteria.** A run copies the workflow's criteria into its state when it
  starts. The run's card in the chat lists them under "Check it against" with
  the files written; the engine does not check them itself.
- **Files.** Plans live in the conversation (workspace storage,
  `studio/chats/<id>.json`, saves one after another) until **Save as
  workflow** writes `.repository-manager/workflows/<id>.workflow.json`, asking
  before replacing a file it did not write. From then on that file is the
  plan: it is read back before each turn, edit and run, and an accepted
  change or a card edit is written to it (through the open document when
  there is one, so undo works). **Open in diagram** saves, then opens it in
  the Workflow Editor.
- **Run** goes through the same path as Run Workflow… (inputs, model
  replacements, consent, gates); the chat shows the run's status as it
  changes. While a reply is drafted or a plan runs, New Chat and Chat
  History do not switch chats (the reply or run writes to its own).
- **Tests.** `src/test/studioChatSmoke.js` (planner, rules, engine models and
  criteria, the host with a scripted `vscode.lm`), `src/test/studioChatUi.js`
  (the page in Chromium; screenshots 40–44).

**Not in 2b-1** (skills and code steps came in 2b-2 and 2b-3, below):
drafting a single node, trying a prompt step on a sample input, showing a
proposed change on the diagram, and choosing a step's model in the diagram's
side panel (the chat's plan card and the JSON do it; the diagram keeps it).

## Phase 2b-2 as built: skills

- **Format.** A step that uses a model (prompt, code) may list up to 5
  `skills`, each `github:<owner>/<repo>/<folder>@<40-character commit>`; the
  folder holds a `SKILL.md`. Anything else is a validation problem.
- **Library** (`src/studio/skills.ts`, no `vscode`). Listing a source reads
  its default branch's commit, its file tree, and every `SKILL.md` (front
  matter `name` and `description`); folders starting with `_` (templates) are
  left out; at most 200. A skill is marked "uses scripts" when its folder has
  `scripts/` or its text names a script file. Each commit's listing and each
  skill (with up to 5 files of its `references/`) are cached in global
  storage (`studio/skills/<owner>/<repo>/<commit>/`); a cached commit is never
  fetched again, so pinned skills work offline.
- **GitHub** (`src/studio/githubSkills.ts`). The REST API with the VS Code
  GitHub session (`repo` scope). A session the person already has is found
  silently; without one, repositories are read anonymously (public ones
  work). Only when GitHub refuses (401, 403, 404: a private repository or
  the anonymous rate limit) is the person asked to sign in, once; a Cancel is
  remembered for the session, and **Manage Skill Sources → Sign in to
  <server>** asks on request. (3.0.0 asked before every request, so the
  dialog came back after each Cancel: fixed in 3.1.0.)
- **GitHub Enterprise** *(asked for 2026-11-13)*. A source may be
  `<host>/<owner>/<repo>`, and a skill reference
  `github:<host>/<owner>/<repo>/<folder>@<commit>`; github.com keeps the short
  forms. A host has a dot and an owner never does, so they cannot be confused.
  Requests go to `https://<host>/api/v3`; sign-in uses VS Code's GitHub
  Enterprise account, which serves the one server in `github-enterprise.uri`.
  When a server refuses and the setting does not name it, the person is
  asked once to set it up (the question says which server it names now, if
  any; other extensions use the same setting), then to sign in; declining is
  remembered like a Cancel. (3.1.0 only told the person to set it: fixed in
  3.2.0.) An
  Enterprise source's cache is under its host. A host is kept whole (only
  `www.github.com` is github.com).
- **Sessions that change.** A token refused with 401 (signed out, or
  replaced) is not sent again: the current session is looked up silently and
  the request retried with it, or without one. VS Code's session changes for
  GitHub and GitHub Enterprise make the next request look again; a Cancel
  stays remembered.
  Sources come from `repositoryManager.studio.skillSources` (default
  `eurus-labs/skills`). Trust is asked once per source, before it is listed
  and before a run uses a skill from a source not trusted yet (a shared
  workflow).
- **Use.** The engine loads a node's skills before it runs (a skill that
  cannot be read fails the node, nothing is sent) and logs them. A prompt
  step sends them before its instructions, a code step after its rules; the
  references a skill names are included; all of it within 60,000 characters,
  and what does not fit is listed as left out. The text says skills cannot
  override the data rule or approve anything. Scripts are never run.
- **Chat.** Each step that uses a model has **+ Skill** on the plan card. It
  first asks where the skills come from *(decided 2026-11-12)*: one source,
  **All sources** (with more than one), or **Add a GitHub repository…**
  (`owner/name`, or a GitHub URL, which may go on into a branch or folder);
  an added repository is trusted first and then kept in the setting (user
  settings). **Manage Skill Sources** (chat title bar) adds or removes one; a
  removed source's pinned skills keep working from the cache. Then the
  listing of the chosen sources, pinned to the commit listed now; a
  chip per skill (⚠ when it uses scripts), removable. The planner is offered
  the skills listed before (from the cache, no request) and may attach only
  those or ones the plan already has; another is a problem and gets the
  repair turn. A newer commit of a skill is taken by adding it again.

## Phase 2b-3 as built: code steps, and the Agent view

- **`code` step** (`src/studio/codeStep.ts`, no `vscode`; registered by
  `src/studio/registry.ts`). Settings: `task`, `paths` (files, or folders
  ending with `/`, inside the workspace), `checks` (package.json script
  names). It is the agent's step runner: the agent's tools
  (`src/agent/agentTools.ts`, read tools always, `edit_file` and
  `create_file`, `run_check` only with checks), at most 25 tool calls, the
  same system rules, the workflow's title and description as the goal and the
  run's frozen criteria. It cannot loop (`forEach`).
- **Order of what is asked.** Before the run: the checks' scripts are
  approved per repository (the agent's approvals; a changed command asks
  again). Before the step: the engine's gate shows the task, paths, checks
  and branch. Code steps work on the branch the repository is on *(decided
  2026-11-12: no branch of their own)*; uncommitted changes elsewhere are
  left alone (an undo restores each file the step changed to what it was
  before the step). Only when the person asks for one does the planner set
  `branch` on the step; the first code step then creates it from the current
  branch, and only from a clean tree. A run's code steps share one branch;
  later ones must find the repository still on it.
- **Review.** After it runs, the engine waits with the result: verdict
  (passed, failed, unverified, documentation only, nothing changed), the
  model's summary, the checks with the end of a failing output, text in the
  repository that speaks to an AI, and a line diff of each file (400 lines
  shown). **Accept** keeps it; for a failed or unverified result the button
  says **Accept Anyway** or **Accept as Unverified**. **Retry** undoes the
  change and runs it again with the summary and failing output (3 runs in
  all). **Stop Run** undoes it and ends the run. Closing the dialog leaves the
  review waiting; Show Workflow Runs asks it again, even after a restart.
  A run that fails or is cancelled undoes what the step wrote; Cancel also
  stops a check that is running (its npm script), not only the model.
- **Engine.** Any step may declare a review (`StepReview`); the run keeps
  `data` its steps share (the branch), `attempts` and `feedback` per node.
- **Planner.** It is told the repository's scripts (the only checks a code
  step may name; another is a problem) and to plan code changes as code
  steps; with no folder open, a code step is a problem.
- **Agent view.** Removed *(decided 2026-11-12)*: no Activity Bar icon,
  Tasks view, task page or agent commands. Its runner, tools and script
  approvals stay: the code step uses them (`src/agent/repositoryScripts.ts`
  holds the scripts and Git helpers).
- **Not done here:** undoing a code step's changes when VS Code closes while
  it runs (the agent does this for its tasks; here the files stay as written,
  on the current branch unless the plan named one); per-file Diff buttons (the
  review shows the diff as text); the review step (phase 4).
- **Tests.** `src/test/studioCodeStepSmoke.js` (a real Git repository and
  check, scripted tool calls), `src/test/studioSkillsSmoke.js`, and
  screenshot 45 of `src/test/studioChatUi.js`.

## Agent tasks moved to Studio

*(decided 2026-11-12: move the old tasks into the Studio, and remove the
Tasks view.)* When 3.0.0 starts in a workspace, every agent task not moved
yet becomes a Studio Chat conversation (`src/studio/agentMigration.ts`, no
`vscode`; started from `src/agent/agentTasksMove.ts`), and one message says
how many moved, with **Open Chat History**:

- A task left planning or running when VS Code closed is first settled as the
  agent did: a running step's writes are undone, and the task waits again.
- The person's message is the task's goal and its criteria.
- A note says where it came from, its branch, the steps done in the Agent
  (with how each was accepted, failing checks named), and earlier retries'
  feedback.
- A step that ran and waited for review keeps its changes in the files: the
  note names them and says to keep or undo them with Git; it is not in the
  plan, so it does not run again over them.
- The steps not done yet become the plan: one code step each (`task` from
  the step's intent, its paths and checks, `branch` set to the task's
  branch), in order, with the task's criteria. The person switches to that
  branch before Run; until then the step says so.
- A task with no plan becomes the goal and a note to draft a plan; a done or
  stopped task becomes history with no plan.
- The chat keeps the task's repository: its plan runs only when that
  repository is the folder open (a multi-root workspace runs the first
  folder), and Run says which one otherwise.
- Nothing is deleted: a moved task gets `movedTo` (the conversation id) and
  keeps its file and run log; it is not moved again.
- Tested by `src/test/agentMigrationSmoke.js`, including the moved plan's
  next step running on the task's branch.

## Phases

Each phase ends with something usable on its own.

1. **Engine and workflow JSON** (format, validation, runs, gates), with prompt
   and Docs steps. It runs from a command, and its tests run in Node without
   `vscode`. The first workflow is the sample's "Analyze".
2. **Visual editor**: canvas, side panel, JSON round-trip, problems (2a), and
   **AI-assisted authoring** as the Studio Chat (2b, see its design).
3. **Sharing**: export and import with the approval list, and the Studio view
   listing workflows and runs.
4. **Review step** and the review history as a Studio view. (Code steps and
   replacing the Agent view moved to 2b-3.)
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
