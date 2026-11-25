# Plan 17 — History actions run with untracked files present, unless they would overwrite one

Status: implemented
Date: 2026-11-24
Branch: `fix/history-actions-untracked-files`
Baseline: `main` at `4fe5d23e5d17283e1987a4ed31c452e0a5034ac9`
Target: `src/services/untrackedGuard.ts` (new), `src/services/historyRewriteService.ts`,
`src/services/historyActionService.ts`, `src/handlers/webviewMessageHandler.ts` (confirm texts),
`src/test/untrackedGuardSmoke.js` (new), `package.json`, `CHANGELOG.md`

## Goal

The user reported on 2026-11-24 that a rebase was refused because of a changed file that had to be dealt with
first. The file was untracked, so the rebase could have run and left it in place.

**Reproduced** (real Git, the compiled `HistoryRewriteService`; the script was `repro-rebase-untracked.js` in the
session's scratchpad). The setup was:

- `feature` branches from `main`, and `main` moves on;
- `notes.local` is untracked on `feature`, and neither branch has it.

The results were:

- `execute('.', <main>, 'rebase', 'feature', <head>)` returns "rebase failed: Commit, stash, or discard working
  tree changes before rewriting history.";
- `git rebase --onto <main> <merge-base>` on the same tree succeeds and keeps `notes.local` unchanged.

**Why.** Both guards ask `git status --porcelain=v1 -z --untracked-files=all` and refuse on any output, so an
untracked file counts as a change:

- `historyRewriteService.ts:98`: rebase, drop and reset;
- `historyActionService.ts:35`: cherry-pick, revert and merge.

The confirm texts say the same:

- "Working tree must be clean." (`webviewMessageHandler.ts:1009`);
- "The working tree must be clean." (`:949`).

**What Git does with an untracked file in the way** (checked in the scratchpad, Git defaults):

| Action | Untracked file at a path the action writes | Result |
| --- | --- | --- |
| `rebase`, the path is in the target tree | `could not detach HEAD` | Nothing changed, no rebase state, file kept |
| `rebase`, the path is added by a replayed commit (added, later deleted on the branch) | Stops mid-way | **Rebase in progress**, file kept |
| `merge` | Refuses | Nothing changed, no `MERGE_HEAD`, file kept |
| `cherry-pick` | Refuses | Nothing changed, no `CHERRY_PICK_HEAD`, file kept |
| `revert` (of a deletion) | Refuses | Nothing changed, no `REVERT_HEAD`, file kept |
| `reset --hard` to a commit that has the path | **Overwrites it silently** | File content lost |

Git itself is unsafe in two cases: `reset --hard` loses the file, and a rebase stops half-way. That is why the
guard cannot simply drop untracked files.

After this change:

- untracked files no longer block any of the six actions, unless the action would write to one of their paths;
- in that case nothing runs, and the message lists the files;
- staged and unstaged changes to tracked files still block, as now.

## Decisions

Decisions 1–2 were made by the user on 2026-11-24 (AskUserQuestion). Decision 3 onwards is the planner's.

1. **All six history actions follow one rule:** rebase, drop, reset, cherry-pick, revert and merge.
2. **A collision refuses and lists the files.**
   - The message is "These untracked files would be overwritten by <action>: <paths>. Move or commit them, then
     try again."
   - It lists the first 20 paths, then "and N more".
   - Rejected: offering to stash them. A stash of files the action then writes would conflict when restored, and the
     person would have to sort it out.
3. **A new module with no `vscode`: `src/services/untrackedGuard.ts`.**

   **`trackedChanges(git, cwd)`** returns whether `git status --porcelain=v1 -z --untracked-files=no` has output.
   If it does, the refusal stays as now, with the message "Commit, stash, or discard changes to tracked files
   before …". The "tracked files" wording is new.

   **`untrackedCollisions(git, cwd, writes)`** returns the sorted list of untracked paths the action would write.
   - **The untracked set.** It comes from `git ls-files --others --exclude-standard -z`. Ignored files are left out:
     Git already treats them as expendable, and the status check today does not list them either. That behaviour
     is unchanged.
   - **`writes`.** Each action describes the commits whose files it may write, as:
     - `trees: string[]` (commits whose whole tree is checked out);
     - `ranges: string[]` (commit ranges whose commits are applied).
   - **The check.** A path collides when it is in one of `trees` (`git ls-tree -r --name-only <tree> -- <paths>`), or
     touched by a commit in one of `ranges` (`git log --format= --name-only <range> -- <paths>`).
   - **Large sets.** The paths are passed in chunks of at most 200, so a large untracked set stays within
     command-line limits and asks Git only about those paths.
4. **What each action writes.** These come from the arguments the services already build:

   | Action (where) | `trees` | `ranges` |
   | --- | --- | --- |
   | Rebase (`historyRewriteService.ts:115`): onto `T` from merge-base `B` | `T` | `B..HEAD` |
   | Drop of a non-HEAD commit `C` (`:114`) | `C^` | `C..HEAD` |
   | Drop of HEAD (`:113`, `reset --hard C^`) | `C^` | none |
   | Reset `--hard` to `T` | `T` | none |
   | Reset `--soft` or `--mixed` | none, so the check is skipped; neither touches the working tree | none |
   | Merge `S` (`historyActionService.ts:50`) | `S` | `$(merge-base HEAD S)..S` |
   | Cherry-pick or revert `S`, mainline `m` | none | `S^m..S` (`S^..S` without a mainline) |

5. **Where it is checked.**
   - **In the services**, right where the status check is today (`historyRewriteService.ts:98`,
     `historyActionService.ts:35`). This check is authoritative, because it runs just before Git.
   - **In the handlers, before the confirm modal** (`handleRewriteHistoryCommit`, `handleApplyHistoryCommit`). The
     same two checks run there, so a person is not asked to confirm an action that will be refused. A refusal there
     shows the same message with `showResult(false, …)` and opens no modal.
6. **The confirm texts.**
   - "Working tree must be clean." becomes "Changes to tracked files must be committed or stashed first; untracked
     files stay as they are."
   - "The working tree must be clean. Conflicts can be resolved in Source Control." becomes "Changes to tracked
     files must be committed or stashed first; untracked files stay as they are. Conflicts can be resolved in
     Source Control."
7. **What stays.**
   - A rebase that Git still stops mid-way (a case the guard does not see, such as an untracked directory where a
     commit adds a file of the same name) goes through the existing "Continue rebase / Abort rebase" flow
     (`webviewMessageHandler.ts:1033`).
   - "Reset to origin" (`branchService.ts:183`) is a branch action, not a history action, and keeps its own check.
8. **Version: patch.**
   - It is a bug fix; the confirm flow is unchanged, and a refusal is lifted.
   - It shares `## [3.8.1]` with plans 8 and 15 if they have not shipped (one `### Fixed` entry, one version bump);
     otherwise it is the next patch.

## Scope

In:

- `src/services/untrackedGuard.ts` (new): Decision 3.
- `src/services/historyRewriteService.ts` `execute`, and `src/services/historyActionService.ts` `apply`:
  Decisions 3–5.
- `src/handlers/webviewMessageHandler.ts`: the pre-confirm check and the two texts (Decisions 5–6).
- Tests, `CHANGELOG.md`, `package.json`.

Out:

- "Reset to origin" and plan 16's checkout and fast-forward. Git's `merge --ff-only` refuses safely; plan 16 already
  reports that as `blocked`.
- Discard, stash and the natural-language undo (`naturalUndo.ts`), which have their own rules.
- Plan 14's new merge and rebase entry points. They reuse these handlers, so they inherit this rule. Plan 14 needs
  no change for it.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/services/historyRewriteService.ts:98` status guard | Change: tracked check + collisions |
| `src/services/historyRewriteService.ts:106–115` backup and Git arguments | Keep; read for `writes` |
| `src/services/historyActionService.ts:35` status guard | Change: tracked check + collisions |
| `src/services/historyActionService.ts:49–51` Git arguments | Keep; read for `writes` |
| `src/handlers/webviewMessageHandler.ts:949`, `:1009` confirm texts | Change (Decision 6) |
| `src/handlers/webviewMessageHandler.ts:925`, `:980` handlers | Change: pre-confirm check |
| `src/handlers/webviewMessageHandler.ts:1033` pending-rebase recovery | Keep |
| `src/test/historyRewriteHandlerSmoke.js`, `src/test/historyActionHandlerSmoke.js` | Keep passing |

## Tech stack and constraints

Default (`AGENTS.md`):

- no new dependency;
- Git runs through `GitCommandService`;
- tests use real temporary repositories with the developer's global Git config ignored (`GIT_CONFIG_GLOBAL=/dev/null`, as
  `pullChangesSmoke.js` does);
- the new `src/test/untrackedGuardSmoke.js` is added to the `test` script.

## Acceptance criteria

- [ ] **`node src/test/untrackedGuardSmoke.js` (new), real repositories.** Each case asserts the result, the
  message, HEAD, the absence of a pending operation, and the untracked file's content afterwards:
  - **Rebase with an unrelated untracked file** (the repro above): it succeeds, and the file is unchanged.
  - **Rebase where the target tree has the path:** it is refused with the Decision 2 message naming the path. HEAD
    is unchanged and no rebase is in progress.
  - **Rebase where a replayed commit added and later deleted the path:** it is refused before Git runs. No rebase
    is in progress.
  - **Drop of a non-HEAD commit, and drop of HEAD,** each with an unrelated untracked file (succeeds) and with a
    colliding one (refused).
  - **Reset `--hard` to a commit that has the path:** refused, and the file keeps its content. This is the case Git
    would lose. Reset `--hard` with an unrelated file succeeds.
  - **Reset `--soft` and `--mixed`** with a colliding path both succeed. They do not touch the working tree, and
    the file keeps its content.
  - **Merge, cherry-pick and revert,** each with an unrelated untracked file (succeeds) and a colliding one
    (refused with the list, nothing pending).
  - **An ignored file** at a colliding path does not refuse, as now.
  - **A staged or an unstaged change to a tracked file** still refuses every action, with the "tracked files"
    message.
  - **25 colliding files:** the message lists 20, then "and 5 more".
- [ ] **The handlers** (extend `historyRewriteHandlerSmoke.js` and `historyActionHandlerSmoke.js`):
  - with a colliding untracked file, no confirm modal is opened and the refusal is shown;
  - with an unrelated one, the modal opens and its detail carries the Decision 6 text.
- [ ] `npm run lint`, `npm test` and `npm run package` pass; CHANGELOG and version as in Decision 8.
- [ ] The commit identity check from `AGENTS.md` prints one line.

**Unverified until run in VS Code:** the confirm modal's new wording on screen (the handler tests check the text
passed to it).

## Risks

| Risk | Handling |
| --- | --- |
| The guard misses a path Git writes, and `reset --hard` loses a file | `trees` covers the whole tree checked out; the `reset --hard` case is tested; for rebase and merge Git itself refuses as a second line |
| An untracked directory against a file of the same name is not seen | Git refuses (merge, cherry-pick, revert) or stops the rebase, and the existing Continue/Abort flow handles it (Decision 7) |
| Many untracked files (build output not ignored) make the check slow | Only the untracked paths are asked about, 200 per call; Git's own speed on `ls-files --others` is unchanged from today's `status` |
| The modal check and the service check disagree because files change in between | The service check is the one that decides; the modal check only saves a confirm |

## Open questions

None.
