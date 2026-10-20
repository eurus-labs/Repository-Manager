# AI support for history actions

Status: approved design; phases 1–3 implemented, phase 4 proposed.

The commit menu already runs cherry-pick, revert, merge, rebase, reset (soft, mixed, hard) and drop
(`HistoryActionService`, `HistoryRewriteService`), each behind a confirmation dialog. This adds
prediction and AI help around those operations. It adds no new Git operation.

## Decisions

- **Predict, list the issues, then the user decides.** Before an action runs, the system says what
  it will run into, and AI can explain it, so the user decides whether to run the action at all.
  Once it stops on a conflict, the user resolves each file themselves or asks AI for a suggestion.
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

Git's kind of conflict is kept per path from `merge-tree`'s messages (`parseMergeTree`): only the
type (`contents`, `modify/delete`, …), never the message, which names the sides by the hashes passed
to `merge-tree`. The dialog names the kind when it is not about lines, e.g. `gone.txt (modify/delete)`.

## Phase 2: explaining predicted conflicts before running (implemented)

When Git predicts conflicts and Copilot is available, the confirmation also offers **Explain
conflicts** (`confirmHistoryAction` in `handlers/webviewMessageHandler.ts`, `services/conflictExplanation.ts`):

1. Consent, as reviews and commit messages ask it (`repositoryManager.copilot.askBeforeSending`,
   sharing their per-repository "Always allow"). Declining sends nothing and runs nothing.
2. The first conflicting commit's conflicted files are read from the simulated tree, which
   `merge-tree` writes with diff3 markers (`-c merge.conflictStyle=diff3`): each conflict with three
   lines around it, up to 24 KB, markers relabelled `A`, `BASE`, `B`. A file with no lines to show
   (deleted on one side, binary) is sent as Git's kind of conflict only.
3. The prompt names A and B (`describeSides`: the current branch, the commit picked, the commit
   rebased onto, your commit being replayed), never "ours" and "theirs"; treats code and subjects
   as untrusted; and asks per file what each side changed, whether both can be kept, and how, plus
   `proceed`, `reconsider` or `unclear`. Written in VS Code's display language.
4. The reply must be that JSON; files it invents are dropped and files it skips are listed as not
   explained. The same question is asked again with Git's facts first and Copilot's reading after,
   labelled a suggestion with the model's name, and only the action's own button.

The model is the toolbar's **Model**. A failed explanation never blocks the action: the second
question says Copilot could not explain, and still offers it. Declining the consent question or
cancelling the explanation closes the dialog and runs nothing; the action can be started again. Copilot is only reachable in VS
Code, so `src/test/conflictExplanationSmoke.js` drives this with a scripted model.

## Phase 3: suggesting a resolution for a conflicted file (implemented)

When an operation has stopped on conflicts, each conflicted file can be resolved by hand (Source
Control) or with **Suggest resolution** (`services/conflictResolution.ts`,
`handleSuggestConflictResolution`). It is offered in the message shown when a cherry-pick, revert,
merge or rebase stops (it then goes through the conflicted files one by one, until the user stops),
and on a conflicted file's right-click menu in **Uncommitted changes**, which also covers conflicts
from a terminal or a stash.

1. The file is rebuilt from the index's three versions (`:1:` base, `:2:` A, `:3:` B) with `git
   merge-file -p --diff3 -L A -L BASE -L B` on temporary copies, so the markers do not depend on the
   user's `merge.conflictStyle` or on edits already made. A file deleted on one side, a binary file,
   one over 60 KB per version or with more than 40 conflicts is refused with the reason.
2. The sides are named from the pending operation: for a rebase, A is the commit rebased onto with
   the commits already replayed (`HEAD`) and B is the user's commit (`REBASE_HEAD`); for a pick,
   revert or merge, A is the current branch and B the picked commit, the undoing of the reverted
   one, or the merged one; otherwise (a stash) B is "the change being applied".
3. Consent as in phase 2. The model gets each block's A, BASE and B lines and the whole file for
   context, and returns **one replacement per block**; code splices them in, so lines outside the
   conflicts cannot change. A reply that skips a block or leaves a marker is refused.
4. **The check is code, not the model** (`checkResolution`). Lines are compared as tokens (words,
   numbers, symbols), since a correct combination of two edits to one line usually contains neither
   line: `max(round(a * 0.02, 2), 1.0)` from `max(a * 0.02, 1.0)` and `round(a * 0.02, 2)`. For each
   token, a side's change is its count minus the base's; an addition is kept when the result has at
   least the base's count plus it (less what the other side removed), a removal when the result has at
   most the base's count less it (plus what the other side added); both sides adding the same token
   need it once. Symbols are reported only when no word or number is affected. The check finds a
   side's change dropped or undone; it cannot find a wrong combination of both (`round(max(…), 2)`
   passes as well), and the question says so.
5. The suggestion opens as a diff (read-only documents: the file now ↔ suggested), and the question
   gives the check per side (✓, or ⚠ with the tokens) and the model's notes. **Apply** writes the file
   in its own line endings, only if it has not changed since it was read, and nothing else: the file
   stays unmerged and the operation stays paused, so the user checks it, stages it and continues.

## Phase 4: plain-language undo (proposed)

A request such as "undo my last 2 commits but keep the changes" is answered by the model with one
existing action and its arguments only (here: reset, soft, to `HEAD~2`), never with a Git command.
That action then goes through the same preview, prediction and confirmation as a click in the menu.

## Open questions

- Whether to record predictions against outcomes per repository, and show how often AI suggestions
  were accepted unchanged. It would only be shown, never used to skip a confirmation.
