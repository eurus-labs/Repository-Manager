# Usage metrics

## Problem

We want to know whether Repository Manager saves time, for two readers:

- the team, who need a few numbers they can trust;
- the maintainers, who need to see which features help and which do not.

"Hours saved" figures that multiply an action count by an assumed constant are not evidence. This design records measured durations and outcomes, and states what they leave out.

## What is recorded

`src/services/usageLog.ts` appends one JSON line per finished action to `usage.jsonl` in the extension's global storage. It records numbers only: no paths, commit messages or code. Nothing leaves the machine.

| Event | Fields | Recorded by |
| --- | --- | --- |
| `commit` | `durationMs` (commit dialog opened → commit created), `copilot` (Copilot's message was in the dialog when committing), `editRatio` (share of Copilot's message changed: edit distance ÷ the longer length), `files`, `lines` (added + removed, from `git show --numstat HEAD`) | `handleCommitFiles`, with timings sent by `resources/webview.js` |
| `align` | `repositories`, `failed`, `durationMs` | `handleSyncVersions` |
| `reviewFix` | `files`, `findings` closed | `ReviewController.applyFix` |

- **Rules:** A failed commit is not recorded. Values sent by the page are checked; a bad value becomes 0 or is left out.
- **Size:** Over 1 MB, the log keeps its newer half.
- **Failures:** A write that fails is ignored, so logging never blocks the action it records.
- **Turning it off:** set `repositoryManager.usage.enabled` to false. **Clear Usage Data** deletes the log.

## The report

**Show Usage Report** opens the report as a Markdown document, which can be copied as it is.

- **Summary** (for the team): the number of commits and the share with a Copilot message, the median time to commit with and without Copilot, the share of Copilot messages kept (less than 10% changed), Align runs, and review fixes.
- **Details** (for the maintainers):
  - time to commit and the share of Copilot's message changed, broken down by commit size (1 file, 2–5 files, 6+ files);
  - what the numbers leave out.

## Decisions and limits

- **Medians, not means.** A commit with the dialog open longer than 10 minutes is counted but not timed: the person was probably doing something else.
- **Timed from the last opening.** Closing the dialog and opening it again restarts the clock, so the time away is not counted; a Copilot message kept from before still counts as Copilot's.
- **No comparison under 20 commits on each side.** Until then, the report says "still collecting" and shows the counts.
- **Selection bias.** The person chooses when to use Copilot, so the two groups differ. The report compares within a size bucket and says so; it is not a controlled experiment.
- **No baseline from before the tool.** Commits made outside the dialog are not recorded.
- **Edit ratio is per character.** It rates how much was rewritten, not whether the message was right.

## Not yet measured

- Time from a task's start to its merged pull request.
- Rework, such as a revert after committing the wrong files.

Both need data outside the extension (the Git host). Decide on them after looking at the first weeks of data.
