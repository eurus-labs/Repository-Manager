# AI support for history actions

Status: approved design; phase 1 implemented, phases 2–3 proposed.

The commit menu already runs cherry-pick, revert, merge, rebase, reset (soft, mixed, hard) and drop
(`HistoryActionService`, `HistoryRewriteService`), each behind a confirmation dialog. This adds
prediction and AI help around those operations. It adds no new Git operation.

## Decisions

- **Predict, list the issues, then the user decides.** Before an action runs, the system says what
  it will run into. For each issue the user resolves it themselves or asks AI for a suggestion.
  There is no mode in which AI carries an action through on its own: a resolution that keeps the
  text of both sides can still combine them wrongly, and no check here can see that. The extension
  cannot build or test an arbitrary repository either.
- **AI never guesses what Git can compute.** Conflicts, affected commits and published commits are
  facts from Git, shown as facts. AI only explains them or proposes resolutions, and what it says is
  labelled as a suggestion.
- **Nothing continues by itself.** Applying a suggested resolution writes the file. Staging it and
  running `--continue` stay with the user, so a wrong merge sits in the working tree where it can be
  seen, not in a new commit.
- **Sides are named, never "ours" and "theirs".** Their meaning flips in a rebase (`ours` is the
  upstream, `theirs` is the user's own commit), the easiest way to drop the user's own change.

## Phase 1: prediction (implemented)

`ConflictPredictionService` (`src/services/conflictPredictionService.ts`) runs the action's merges
in memory with `git merge-tree --write-tree`:

| Action | Simulated as |
|---|---|
| merge X | `merge-tree HEAD X` |
| cherry-pick X | `merge-tree --merge-base=X^ HEAD X` (`X^n` with a mainline) |
| revert X | `merge-tree --merge-base=X HEAD X^` |
| rebase onto T, drop X | each commit replayed in turn onto T (or `X^`); a clean step becomes an unreferenced commit (`commit-tree`) for the next |

A rebase stops being predicted at its first conflicting commit, since the rest depends on how that
conflict is resolved; the dialog says so. Reset never conflicts and predicts nothing. The working
tree, index and refs are not touched; the unreferenced commits are pruned by Git like any
unreachable object. `--merge-base` needs Git 2.40 or newer. On older Git, for a root commit, over
200 commits, or when the simulation fails, the dialog says nothing was predicted, and the action
still runs. `src/test/conflictPredictionSmoke.js` checks each prediction against the real
operation's result.

## Phase 2: AI resolution of a conflict (proposed)

When an action stops on conflicts, each conflicted file can be resolved by hand (Source Control) or
with **Suggest resolution**. The model gets the base, both sides (named after their commits or
branches) and the commits' messages. The suggestion is shown as a diff against the conflicted file.
Before it is offered, code checks that each side's changes since the base are still in it, and names
the side whose change is missing. Applying writes the file only.

## Phase 3: plain-language undo (proposed)

A request such as "undo my last 2 commits but keep the changes" is answered by the model with one
existing action and its arguments only (here: reset, soft, to `HEAD~2`), never with a Git command.
That action then goes through the same preview, prediction and confirmation as a click in the menu.

## Open questions

- Whether to record predictions against outcomes per repository, and show how often AI suggestions
  were accepted unchanged. It would only be shown, never used to skip a confirmation.
