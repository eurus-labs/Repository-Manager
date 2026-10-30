# Requirement Editor: clarification files

Status: implemented in 2.11.0. This document is the format contract for
clarification ("dou") files and records how the Requirement editor brings the
Python dou-editor into the extension.

## What it is

A clarification file is a Markdown file that records questions about
requirements: one item per `### <ID>-Q<n>` heading, with fixed field labels, the
discussion as an append-only History, and (schema v3) the acceptance criteria the
PO accepts or rejects. Markdown stays the source of truth: people review it in pull
requests and agents edit it as text.

- **Requirements** in the Repository Manager Side Bar lists the workspace's
  clarification files (Markdown whose front matter has `schema_version: 1`, `2`
  or `3`), each with how many items are still open. A click opens the file in the
  Requirement editor; a file that does not validate shows why and opens as text.
  **New Clarification File** (＋ in the section title, or a row's menu) asks for
  a folder, an ID and a title, and writes the v3 template.
- **Requirement Editor** is a custom editor for `.md` files, chosen per file
  (**Open With… › Requirement Editor**), so other Markdown keeps opening as text.
  Under the file's title, tabs switch between Clarifications (each item as a
  form), Requirements, and Markdown (the whole file as text); Alt+1, Alt+2 and
  Alt+3 do the same.

## Saving

Saving is VS Code's own: the unsaved dot, Ctrl+S, the question when closing with
unsaved edits, Revert File and hot exit (unsaved edits come back after a restart)
behave as for any file. The editor's **Save** button and **Submit** (a response)
use the same save.

Only fields you change are rewritten; untouched fields keep their exact bytes and
line endings. A save is refused when the file changed since the editor loaded it
(someone else, Git, or an agent wrote it), and your edits stay: **Download draft**
writes them to another file, **Reload** asks before discarding them. When the file
changes on disk and the editor has no unsaved edits, it reloads by itself.
Unsaved edits restored after a restart keep the version of the file they were made
on: if the file changed while VS Code was closed, Save is refused the same way. The
write is checked once more right before the file is replaced, and the replacement
is atomic. There is no automatic merge, and Git history is the backup.

Saving also checks the rules below: the artifact ID and schema version stay,
items are never removed (in every schema; the Python dou-editor checked this from
v2 on only), Created at never changes, History only grows, and each
changed item gets a new Updated at. A schema change (for example v2 to v3) is done
in a text editor or by an agent.

## Format

### Schema v1

Use the exact front matter and field names in the template. Front matter must
contain one unquoted `id` matching `[A-Z][A-Z0-9-]*` and `schema_version: 1`.
Other front matter is preserved but not interpreted as YAML by this stdlib tool.
Top-level editable sections, in order: `## Context`, `## Scope`, `## Inquiries`.
Each inquiry uses `### <artifact-id>-Q<digits>` and these labels in order:

- `**Question**`
- `**Status**`: `open`, `proposed`, or `agreed`
- `**Resolution**`
- `**Confirmed by**`
- `**Requirement impact**`

Keep IDs stable. The editor cannot change the artifact ID. Never reuse removed IDs;
for removed inquiries retain the entry with a resolution explaining withdrawal.
**+ Clarification** chooses the next number after the highest present.
Use impact actions ADD / CHANGE / REMOVE / NO_CHANGE, real requirement IDs,
and concrete proposed edits. NEW is allowed before a requirement is allocated.
Status agreed requires nonempty resolution and confirmation, not Pending.
Confirmation should name the responsible person and date or reference evidence.
The tool checks presence, not authenticity; agents must not invent approval.
Saving does not update any affected requirement automatically.

Reserved headings/field labels must not be used as ordinary prose outside fenced
code blocks. Unrecognized labels inside an inquiry are rejected rather than dropped.
Structured field edits preserve content outside their spans and normalize whitespace
inside edited fields. Source mode keeps full control over the text. UTF-8 required.
This is a constrained Markdown editor, not a general Markdown-to-HTML round-trip tool.

### Schema v2: discussion and traceability

Version 1 files remain supported without migration. Do not just change their
schema_version: version 2 requires the following full structure.

Artifact: ID, Context, Scope, and `## Discussions`. Each item keeps the stable
`<artifact-id>-Q<number>` ID and these exact field labels in order:

1. Created at
2. Updated at
3. Status (open / investigating / resolved)
4. Related requirements
5. Current understanding
6. Questions
7. Analysis / Proposal
8. References
9. History
10. Current conclusion
11. Next action

Understanding may explicitly say what is unknown. Analysis / Proposal should
cover approach, impact, risks and verification where known. Use Pending or
Not applicable with a reason; never interpret unknown impact as no impact.
Next action should include an owner when investigation remains open.

Dates are ISO 8601 with timezone (`Z` is accepted). Creation date is immutable
after first save. Updated at changes automatically on Save only for changed items.
A new item keeps the Created at it was written with (the UI fills in the current
time); it must not be in the future. Saving always sets Updated at, rounded
up to the second so it never precedes Created at. Existing IDs/items and
history must be retained.
Add a reopened event and set investigating when new evidence challenges an old
conclusion. Keep the previous conclusion in history, and update Current conclusion
to explicitly indicate that it is under review.

History and References are fenced JSON arrays embedded inside Markdown. They are
part of the single Markdown source, not separate files. Use the sample for shape.
History event: id, at, author, role, type, content, optional source. Types: question / response /
proposal / conclusion / reopened / feedback / decision (role PO only). History is append-only. PO answers are attributed
response events; an answer is not automatically the agreed conclusion. The UI
provides an Add response form with author, role, type and content. Event dates/IDs
are generated. Adding a conclusion copies its content into Current conclusion;
explicitly select resolved only when the issue has actually been settled.
The editor records attribution, but does not authenticate people or verify approval.

Reference: item_id, relation, reason. Relations: related_to / depends_on /
follows_up / supersedes. Self references and dangling references within the same
artifact are rejected. Supersedes requires resolved plus a conclusion event.
References are stored once; reverse references are computed for display.
Same-file reference links jump to the item. Cross-file links open a read-only view.
The index includes valid `.md` files directly beside the opened document (no
recursive scan or symlinks). External missing/ambiguous targets are flagged in UI,
not silently deleted or treated as validated. Reload to refresh reference views.
An unresolved depends_on is informational; it does not automatically change status.

### Schema v3: one requirement per item

**New Clarification File** starts from the v3 template;
create an item for a requirement with "+ Create clarification" in the Requirements
view, or one that is not about a requirement with "+ Clarification" (Requirement `None`).
Criteria in an item without a requirement do not count toward any Ready. The file has no
`## Context` or `## Scope`: `## Discussions` is the only level-2 heading the
editor reads (a stray `## Context` is rejected). Each item uses these exact field
labels in order. They follow the four groups the editor shows, so the raw
Markdown reads in the same order as the form:

- Created at, Updated at, Status (open / investigating / resolved): item header
- **1 · Scope & requirement**
  - Scope: this item's context, what it settles, and what it leaves out
  - Desired outcome: the functionality, feature or result wanted, stated so it can be checked
  - Requirement: the one requirement ID this item clarifies; `Pending` until known;
    `None` when the item is not about a requirement
- **2 · Analysis**
  - Questions: what is known, then each open question as `- [ ] …`, ticked
    `- [x]` when answered (click the checkbox in the form)
  - Approach: the proposed approach with its impact, risks and how to verify it
  - Proposed acceptance criteria: checkable conditions proposed for the PO to decide
  - Visual aids: wireframes, mockups or prototypes (see below)
  - References
- **3 · History**: the responses
- **4 · Next action**: `Owner: next step`; the form warns when an open item has no owner

**Status is the only state.** Responses have no type of their own. Resolved
requires every question to be ticked; Save refuses it otherwise.

Each item has a response box under History: name, role, optional source (for
example `Sprint 12 review`) and text, then Submit. Submit appends the response
and saves the whole file, including any other unsaved edits. On a resolved item
the box offers "Reopen this item" (on by default), which sets Status to
investigating: new input usually means another look. Roles are a free choice; the
editor does not check who you are, and the approval of record is the pull request
review.

```json
{"id": "EV-…", "at": "…", "author": "Lan", "role": "PO", "source": "Sprint 12 review", "content": "…"}
```

Acceptance criteria are proposals for the PO, one per line with a stable ID:
`- AC1: Given …, when …, then …`. Other lines are notes. IDs must be unique in
the item and are never reused; "+ Criterion" picks the next free one. "PO
decision…" adds a response with role PO that accepts or rejects each chosen
criterion and keeps the exact text and the Visual aids it was decided on:

```json
{"id": "EV-…", "at": "…", "author": "Lan", "role": "PO",
 "content": "AC1 accepted, AC2 rejected. …",
 "criteria": [{"id": "AC1", "decision": "accepted", "text": "Given …", "aids": "- Mockup: …"}]}
```

The latest decision per criterion counts. If a criterion's text, or the item's
Visual aids, change after the decision, it shows as "changed since decision" and
needs a new decision. A rejected criterion has to be rewritten or removed.

Visual aids take one entry per line, `- Label: target`; the label is shown and
the target appears as a tooltip. A target starting with `https://` (or `http://`)
becomes a link that opens in a new tab. An `https://` target whose path ends in
.png, .jpg, .jpeg, .gif or .webp (query strings allowed, as in Confluence
attachment links) is also previewed: your browser loads it straight from that
site, with whatever login it has there and without a referrer. If the site needs
a sign-in the browser does not send to an embedded image, the preview falls back
to the link with an explanation. A PNG, JPEG, GIF or WebP path relative to the
Markdown file is previewed by the extension; click any preview to enlarge.
Local images are read only from inside the repository (the nearest folder with
`.git`, else the file's own folder), up to 10 MB, symlinks pointing outside
included. SVG is not previewed because it can carry script. Paths with spaces are
not supported. Other text, such as `None yet`, is shown as written. A decision
records the Visual aids text, not the image itself: replacing an image at the
same path or URL is not noticed.

History is a JSON array inside the Markdown. Two branches that each add a
response to the same item would conflict in Git, so work on dou files on one
shared branch and commit in turn: pull before you open the editor, save, commit
and push, then the next person pulls. If a conflict happens anyway, keep both
entries (add the missing comma).

To convert a v2 file by hand: set `schema_version: 3`; move the useful parts of
the file-level Context and Scope into each item's Scope and delete both
sections; rename Analysis / Proposal to Approach; fold Current understanding into
Questions and turn open questions into `- [ ]` lines; replace Related
requirements with a single Requirement; add Desired outcome, Proposed acceptance
criteria and Visual aids; put the fields in the order above; delete Current
conclusion and drop `"type"` from every History entry. Saving with a changed
schema version is refused, so convert in a text editor or with an agent.

### Agent editing rules for v2 and v3

- Read Context and Scope (v3: the item's Scope and Requirement), item history, current conclusion (v2) and referenced items first.
- v3: add responses without a type; tick a question only when it is answered; never record a PO decision for the PO.
- Preserve all existing item IDs and history events. Add corrections as new events.
- Record sources and separate proposals from human confirmations. Never fabricate PO answers.
- Update timezone-aware Updated at for changed items when editing Markdown directly.
- Update requirements/design separately after an agreed conclusion; Save does not propagate edits.
- Coordinate with a human editor to avoid simultaneous external writes.

## Requirements source

Requirements usually live in their own repository. In the editor's
Requirements view, use **Set source… / Change source…**:

- **Git repository**: URL (`https://…` or `git@…`), branch or tag (usually
  `main`) and the folder with the `.rst` files (for example `docs/source`). The
  editor keeps its own shallow, sparse copy of just that folder in the
  extension's storage (VS Code's global storage for Repository Manager, under
  `requirements/`, one copy per URL, branch and folder) and fetches the branch
  when a file of the repository first
  opens and on **Sync now**. You do not
  check the repository out yourself, and Ready is judged on that branch rather
  than on whatever happens to be checked out on your computer.
- **Folder on this computer**: a path, absolute or relative to the root of this
  repository, read as it is now.

The choice is saved in `.dou-editor.json` at the root of the repository that
holds the clarification file (the same file the Python dou-editor reads); commit
it so the whole team uses the same source. The card shows the commit in use, when
it was synced, and any error.

The editor runs the `git` installed on your computer, so it signs in exactly as
your own `git clone` does: Git Credential Manager (bundled with Git for Windows)
or another credential helper for `https://`, your SSH key for `git@…`, and your
Git proxy settings. The editor never sees a password or token, and refuses URLs
that contain one. If `git ls-remote <url>` works in a terminal without asking for
a password, the editor works too; git is never left waiting for a prompt. If a
sync fails, the earlier copy is used and the card says so. Each person needs read
access to the requirement repository.

With a Git source on a GitHub-style host, each `file:line` opens that line on
the host at the synced commit.

## Requirements view

The Requirements view shows the source (where the requirements are read from),
then a card for every requirement found there, plus any ID an item names that is
not found; search by ID or text, or show only those Ready, Not ready, without a
clarification, with unresolved clarifications, or not found. Each card shows the
ID, Ready or Not ready, the title and `file:line`, and three tabs:

- **Requirement**: the requirement's text, what keeps it Not ready, and the
  **Next action**, the step that removes the first of those reasons (with a
  button for it where there is one, such as **+ Create clarification** or
  **Open** the item);
- **Clarifications**: the items that clarify it and their status;
- **Acceptance**: the criteria those items propose, with the PO's decision on each.

**"+ Create clarification"** adds a new item to the open file with that
requirement filled in; this is the usual way to start a v3 item. IDs in the form
are chips that open this view.

The folder is scanned recursively for `.rst` and `.md` files (no
symlinks, hidden folders or `node_modules`; at most 5,000 files of 2 MB each).
A requirement is found as:

- RST: a section title starting with the ID (`REQ-012: Send messages` with an
  `----` underline); its text runs to the next title of the same or higher level;
- RST: a Sphinx reference label right above a section title (`.. _REQ-030:`
  then the title `Typing indicator`); the label is the ID;
- RST: a directive with an `:id:` option, as sphinx-needs writes them
  (`.. req:: Read receipts` then `:id: REQ_020`); its text is the directive body;
- Markdown: front matter `id:`/`title:`, or a heading starting with the ID.

IDs in titles look like `REQ-012`, `REQ_012` or `REQ-AUTH-3`; an `:id:` or a v3
Requirement field may be any letters, digits, `-` and `_` with a digit, such as
`R_F4722`. Clarification files in that folder are ignored. The view is read-only
and rescans on reload. With a folder source, a requirement's `file:line`
opens that file at that line in VS Code; with a Git source on a GitHub-style
host, it opens on the host at the synced commit. Items come from the clarification files beside the opened
one; the opened file includes unsaved edits.

Each requirement shows **Ready** or **Not ready** with the reasons. Ready means:

- it exists in the requirement documents and at least one dou item clarifies it;
- every item for it is resolved (v1/v2 items count only through their status);
- no item for it has an unticked question (`- [ ]`);
- its acceptance criteria are those proposed in its items; there is at least
  one, and the PO has accepted every one on its current text and Visual aids
  (a rejected criterion must be rewritten, which needs a new decision, or removed);
- items that propose criteria have a Desired outcome;
- every accepted criterion's text appears in the requirement's own text, so Ready
  means the requirement document has actually been updated.

An item that only answers a technical question needs no criteria of its own.

## Local operation

Everything runs in the extension host; there is no server or port. The editor
reads the opened file, the clarification files beside it, the requirement files
of the configured source, and images named in Visual aids, which are read only
from inside the repository (the nearest folder with `.git`, else the file's own
folder), up to 10 MB, symlinks pointing outside included. SVG is not previewed
because it can carry script. Markdown content is shown as text, not HTML. The
page runs under a Content Security Policy that allows its own script only, and
images from the extension, `blob:` and `https:`.

Remote requests happen only for a Git requirements source (the extension runs
`git clone`/`git fetch` for the repository you set) and for https images listed
in Visual aids, which the webview loads from their site. Names, roles and
collapsed items are remembered in VS Code's global state on this machine.

## How the port was done

Decisions (made with the user): port the Python server to TypeScript rather than
spawn Python, so users need no Python; list files in a Side Bar section; open them
through a custom editor.

- `src/requirements/douDocument.ts` (parse, save rules), `requirementCatalog.ts`
  (requirement scan, image rules, Git source) and `douService.ts` (what the
  Python HTTP endpoints did) have no `vscode` dependency, so Node tests run them.
  `requirementEditorProvider.ts` is the custom editor; `requirementsView.ts` the
  Side Bar section and its commands.
- The page is the Python editor's page (`resources/requirements.js`, `.css`) with
  its `fetch` calls answered by the extension, VS Code theme colors, and VS Code's
  save, confirmation and file dialogs in place of the browser's.
- Field offsets are UTF-16 string indexes on both sides (Python used code points),
  and every pattern spells out Python's rules where JavaScript differs: only `\n`
  starts a line (JavaScript's `m` flag also breaks at `\r`, U+2028 and U+2029),
  Python's whitespace for strip(), and Python's `splitlines()` and `\w`.

Evidence: the Python package's tests are ported to
`src/test/requirementsParserSmoke.js`, with UTF-16, U+2028 and CRLF cases added.
A one-off differential run parsed 18,000 randomly mutated copies of the three
example files with both implementations: every verdict matched except one
timestamp form (`2026-10-27T09:+07:00`) that Python 3.13 accepts and the port
rejects, and every field span matched; JSON error messages keep the item and field
but use V8's wording. `src/test/requirementEditorUi.js` drives the real page in
Chromium against the real provider (editing, Save, Submit, requirements source,
new item, Markdown view, save conflict, Reload, hot exit, narrow width).

Not verified: the editor inside a running VS Code (save and revert through
VS Code's commands, Ctrl+S reaching the editor, hot exit, link handling and the
Side Bar section are exercised only against a fake `vscode` module), Windows paths,
and a Git source over a real network with credentials.

Not carried over: the command-line options (`--requirements`, `--requirements-repo`,
`--port`); the source is set in the editor and saved in `.dou-editor.json`.
