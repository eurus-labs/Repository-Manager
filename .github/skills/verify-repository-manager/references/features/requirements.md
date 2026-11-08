# Requirements

The Requirements area of the Activity Bar (requirements by documentation navigation, clarification
files under them) and the Requirement Editor for clarification (DoU) files.

## Sub-features
- requirements-view: requirements grouped by the docs' toctree navigation; clarifications under the requirement they concern.
- clarifications-view: one row per clarification file, items under it, status filter.
- editor: form and Markdown modes for schema v1–v3, Save / Revert / hot exit, create a clarification or acceptance criteria for a requirement.
- source: requirements from a folder or a Git repository and ref.

## How to get to it (user POV)
- Activity Bar → Requirements; open a clarification `.md` → Reopen With → Requirement Editor.

## Driving it
- Node: `requirementsParserSmoke.js`, `requirementsViewSmoke.js` — `$V capture <label> -- node src/test/<name>`.
- Chromium: `src/test/requirementEditorUi.js`, fixtures in `src/test/fixtures/requirements/`; screenshots `ui-snapshots/20*`–`25*`.

## Expected behavior
- Only Markdown files whose front matter names a schema version are listed as clarification files. [confirmed: test src/test/requirementsViewSmoke.js]
- Requirements come first in the area, Clarifications under it. [confirmed: test src/test/requirementsViewSmoke.js]
- A broken clarification file opens as text and says why. [confirmed: test src/test/requirementsViewSmoke.js]
- Requirements nest by the documentation's toctree navigation, as the built site's side bar shows them. [confirmed: spec docs/requirement-clarification-editor.md]
- History in a clarification item is append-only; Created at never changes after the first save. [confirmed: spec docs/requirement-clarification-editor.md]

## Suspected bugs
- None found.

## Open questions
- None.

## Gotchas
- The editor runs under a strict CSP; the UI test fails on any CSP violation in the console.
