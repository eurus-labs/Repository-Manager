# Changelog

All notable changes to Repository Manager will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.10.0] - 2026-10-26

### Changed

- Picking several files for Discard happens in the Side Bar's **Changes** only. The dashboard's **Changed files** list no longer repeats the same checkboxes, select-all and **Discard N…** button; it shows diffs, and its right-click menu keeps **Discard Changes…** (the file clicked) and **Discard All Changes…**.

## [2.9.0] - 2026-10-23

### Added

- **Changes** in the Repository Manager Side Bar, right under Branches: the active repository's uncommitted files. Click one to open it in VS Code's diff editor, in its own tab (HEAD ↔ the file, which you can edit there), so a long list or a large diff no longer needs the dashboard's panels resized. In the dashboard, double-click a changed file, use **Open ↗** above the diff, or **Open Changes** in its menu, for commits too.
- Discard several files at once: tick them (or Ctrl/Cmd+click, Shift+click for a range) in the Side Bar's Changes or the dashboard's files list, then **Discard…**. Each Side Bar file also has its own ↶.
- The message after a discard has **Undo**, which brings the files back from the copy kept first (as unstaged changes); a file you changed since is left as it is.
- **Repository Manager: Remove Discard Copies** in the Command Palette lets go of the copies Discard keeps for Undo (the newest 20 per repository), in the parent and its linked repositories. It asks first, with each repository's count; Undo of those discards stops working.
- A filter in the Commit dialog: **All**, **Tracked** or **Untracked** files. A commit takes the ticked files the filter shows, and the count says when ticked files are hidden.

### Changed

- Discarding feels immediate: the files leave the lists as soon as you confirm, and the discard itself waits on about a third as many Git steps in a row (about 0.5 s instead of 1.4 s until the new status, measured with 40 ms added to each Git process). The history is no longer reloaded after a discard.
- The discard question is shorter and lists the files; the message after it is one sentence instead of a `git restore` command.
- The Branches and Changes titles in the Side Bar fold their lists.

### Fixed

- Discard keeps a recreated original file when undoing a rename, including ignored files. Undo preserves newer contents after a commit or branch switch, as well as later staged edits and recreated files.
- The branch folder holding the checked-out branch can be folded like any other; folded, it shows HEAD.
- The Side Bar keeps up while the dashboard is behind another editor tab: its copy is sent without waiting for the dashboard to be drawn, and live changes keep running while the Side Bar is visible.

## [2.8.0] - 2026-10-20

### Added

- Right-click a changed file for **Review Changes in This File**: a review of just that file, for uncommitted changes, a commit or a comparison. Uncommitted files keep **Discard Changes…** and **Discard All Changes…** in the same menu.
- The detail pane of a commit or a loaded comparison (including **Compare branches**) has a **Review changes** button beside **Summarize changes**.
- Before **Cherry Pick**, **Revert**, **Merge**, **Rebase** and **Drop** run, their confirmation says which files will conflict, as Git predicts by simulating the action in memory (nothing changes until you confirm). A rebase names the first commit that will stop. Needs Git 2.40 or newer; otherwise the dialog says nothing was predicted.
- **Explain conflicts** in that confirmation, when conflicts are predicted: Copilot reads the conflicting lines and says, per file, what each side changed (named after the branch or commit, never "ours"/"theirs"), whether both changes can be kept and how, and whether to go ahead. It is shown as a suggestion beside Git's facts, then you choose. Nothing runs until you confirm.
- **Suggest Resolution** for a file in conflict: right-click it in **Uncommitted changes**, or choose it in the message when a cherry-pick, revert, merge or rebase stops. Copilot resolves each conflict, keeping both sides' changes where it can; you see the result as a diff, with a check that each side's change is still in it, before anything is written. **Apply** writes the file only: it is not staged and the operation does not continue until you do it.
- **↶ Undo…** in the dashboard toolbar: say what to undo ("undo my last 2 commits but keep the changes", "undo the rebase I just did"). Copilot picks one of the dashboard's actions (reset, revert, drop, discard or abort) with a commit or files from your repository; you see what it does, from Git (which commits leave the branch, which come back, which are already pushed), and then that action's own confirmation. Copilot never runs a Git command, and anything it names that is not in your repository is refused.

### Changed

- The **Clean code** checkbox is gone: the **Clean code** review skill is the switch. While it is on (the default), every review also adds maintainability notes, which never block; turn the skill off in the Repository Review tab's skills to stop them. Before, the checkbox was off by default.
- On a narrow dashboard (under 700 px), **Include remotes** reads **remotes**, so the toolbar keeps room for **↶ Undo…**.

### Fixed

- A long change summary no longer squeezes the changed files and diff to a sliver: the summary scrolls in the space left, and the files keep room to scroll.

## [2.7.0] - 2026-10-19

### Added

- **repositoryManager.debug.timings** (off by default) writes how long opening the dashboard takes to the **Repository Manager Timings** output: each step and every Git command with its duration, for the first 30 seconds. Turn it on when the dashboard opens slowly, to see where the time goes.

### Changed

- The dashboard opens faster, most of all on Windows. The page shows at once with the repositories known from last time, the graph is read without waiting for every repository's status, and the first background fetch waits until the graph is shown.

### Fixed

- After **Confirm & Push** on a new branch, the graph shows its `origin/<branch>` label without a reload, and the branch is pushed by name even if another branch was checked out meanwhile. A failed push now says, for each repository, why.
- Creating a branch with a field left empty or no repository selected says so in the dialog; before, nothing happened.

## [2.6.0] - 2026-10-14

### Added

- The dashboard's editor tab and the **Repository Review** tab each have an icon, so they are easy to tell apart: the repository tree of the Activity Bar, and a shield. Both follow light and dark themes.
- **Discard changes** for uncommitted changes. Right-click a changed file for **Discard Changes…** (that file) or **Discard All Changes…**; right-click the **Uncommitted changes** row for **Discard All Changes…**.
  - Staged and unstaged changes go back to HEAD, and new files are deleted (never ignored ones). It always asks first, naming what is deleted.
  - A copy of the files is kept before anything changes, and the message after gives the `git restore --source=<copy> --worktree -- <path>` command that brings them back. The newest 20 copies are kept, out of the history.
  - Linked repositories and new nested Git repositories are left alone and named; nothing runs while a merge, rebase, cherry-pick or revert is paused.

### Changed

- **Commit…** is no longer in the header of the uncommitted changes: the toolbar's **Commit** opens the same dialog, so there is one Commit button.

### Fixed

- **Summarize changes** names its model as Copilot's menu does (for example "Completed · Claude Haiku 4.5"), not by its id twice ("claude-haiku-4.5:claude-haiku-4.5").
- After a review ends or is cancelled, **Review changes** in the detail header no longer keeps the "A review is running" tooltip.

## [2.5.0] - 2026-10-13

### Added

- A stash shown in the dashboard has **Apply**, **Pop** and **Drop…** in its header. Apply and Pop bring its changes, untracked files included, back into the working tree and then show them as the uncommitted changes; Pop also removes the stash, unless they conflict. Drop asks first and says how to bring the stash back. Each acts on the stash you selected even if newer stashes have moved its `stash@{n}`.

### Changed

- The **Load more commits** button below the history is gone: older commits load as you scroll toward the end of the list, or move the keyboard focus down it. A page that fits in the view without scrolling loads the next one by itself.
- The actions on the selected commit or changes sit in the top-right of the detail header, next to the hash: **Summarize changes** (and **Cancel** while it runs), and for uncommitted changes **Commit…** and **Review changes** too. The row below the header appears only for a summary's status and result, so the changed files and diff start higher. In a narrow window the actions move to the header's second row.

### Fixed

- A stash made with untracked files (`git stash -u`) shows them: its changed files, diffs, **Summarize changes** and reviews now include the new files Git keeps apart from the stash's own changes. Nothing in the working tree, the index or the stash is changed to do this.
- Selecting a stash shows it as one entry: the header names it ("Stash stash@{0} · on main") with its own message, and the history leaves out the "index on…" and "untracked files on…" commits Git keeps inside every stash.

## [2.4.0] - 2026-10-13

### Added

- An **Open Repository Manager** button in the Repository Manager Side Bar's title bar brings the dashboard to the front and focuses it, even when it is already open behind other editor tabs.
- Pin Copilot models in the dashboard's **Model** menu: the 📌 on each model lists it first, under **Pinned**, in every workspace, without choosing it. The menu works with the keyboard: Up and Down move between models, Right and Left between a model and its pin. A pinned model that Copilot stops offering is hidden, and comes back pinned if Copilot offers it again.
- The dashboard remembers the chosen Copilot model, in every workspace, instead of going back to Default each time it opens. If Copilot does not offer that model at the moment, Default is used until it does.

### Changed

- Commit messages written with Copilot follow one layout: a summary line, a sentence or two on why, then a "- " bullet for each notable change when there is more than one. Lines are wrapped at 72 columns, with bullets indented under their text; Markdown headings and bold, a "Subject:" label and a trailing period are removed; trailers such as `Refs: #42` are kept as written, at the end. The layout is applied to the reply itself, so it holds even when the model ignores it.

### Fixed

- The note under a commit message written with Copilot reads as one plain sentence: it names the model as Copilot's menu does (for example "Claude Haiku 4.5", not "claude-haiku-4.5:claude-haiku-4.5"), lists the convention files with "and", says "in Conventional Commits style" instead of "following Conventional Commits (no convention found)" when the repository names none, and counts files too large to send in words ("1 file was…", not "1 file(s) were…").

## [2.3.1] - 2026-10-11

### Removed

- The extension no longer ships `simple-git`, a library it never used, which also carried a critical security advisory (GHSA-v5rq-49vh-5v5c). Repository Manager runs Git directly, so nothing changes in use, and the VSIX holds about 217 fewer files.

## [2.3.0] - 2026-10-09

### Added

- **Explain with Copilot** on each finding in the Repository Review tab: Copilot explains it for your code, in the language VS Code is set to, under **What the code does**, **Why it matters**, **How to fix it** (with a code sketch) and **How to confirm it**, so you can decide whether it needs a fix or is a false positive. Only the finding and the lines it cites, with a few lines around them, are sent; nothing is changed, and it works for any open review without checking anything out. Explanations come back when the tab is reopened, but are not saved with the review.
- **⚠ AI text** on a finding whose cited code (or the lines around it) speaks to an AI reviewer, such as `# NOTE TO AI: this eval is safe` or "ignore all previous instructions": text that can steer what Copilot reports, checks or explains. The opened finding lists the lines, the exported report names them, and an explanation tells Copilot they are code, not instructions, and warns that it may still follow them. Every line the reviewed changes add is checked too, since text that kept Copilot from reporting a problem leaves no finding to warn on: the review then lists the lines under its banner and in the report, and counts them as a review gap, so it never reads as "No blocking findings". It is a pattern check that the code cannot argue with, but phrasing written to evade it gets past.
- A ⚙ menu next to **Model** in the dashboard: choose when to ask before code is sent to Copilot, or open all Repository Manager settings.

### Changed

- Reviews, fixes, explanations, summaries and commit messages no longer ask before sending code to Copilot. The new `repositoryManager.copilot.askBeforeSending` setting (also in the ⚙ menu) brings the question back, once per repository or every time. It replaces `repositoryManager.review.confirmBeforeSending`, which still means "every time" while the new setting is not set.
- **Retry failed** asks Copilot again only for what failed, instead of reviewing each failed component from the start: the second check for findings that got no verdict, findings whose cited lines did not check out, and missing policy results. Findings that passed stay exactly as they were, with their triage. Only a component whose request failed as a whole is reviewed again in full.

### Fixed

- A saved review of local changes keeps the snapshot it read, so its evidence still opens weeks later: Git used to remove the snapshot in a garbage collection after about two weeks. The snapshot is kept by a ref under `refs/repository-manager/snapshots/`, outside branches and tags and out of the dashboard's history, and is let go when the review is deleted or drops out of Past reviews.

## [2.2.0] - 2026-10-08

### Changed

- **Review branch** is a split button: the button reviews the files the current branch changed since the default branch, as before, and its **▾** menu offers **Changed files** or **All files** (every file at the tip, formerly **Review all**). The choice is not remembered, so a review of every file, which sends far more code, is always chosen on purpose.
- **Review commit** on a comparison reviews what Target adds since it left Base (their merge-base), as a pull request shows it: commits only on Base are no longer read as removed by Target. A comparison where Base is an ancestor of Target, or Target is behind Base, is reviewed as chosen.

### Fixed

- Commit nodes in the history graph stay round when the graph column is narrower than the graph: the drawing is clipped instead of squeezed into ellipses. Lane changes turn as even S-curves at any row height.

## [2.1.1] - 2026-10-08

### Fixed

- The extension's repository, issues and homepage links, and the README's download link, point to eurus-labs/Repository-Manager, where the project now lives.

## [2.1.0] - 2026-10-07

### Added

- **Summarize changes** for uncommitted changes: Copilot summarizes your local changes (staged, unstaged and new files) from a snapshot, as Review changes does, without committing or staging anything.

### Changed

- **Uncommitted changes** are shown like a commit: the same header with the branch and `HEAD → working tree`, and **Commit…**, **Review changes** and **Summarize changes** in the bar below it.
- The Repository Review tab lists the files of each component while a review runs, and the files left out with the reason (binary file, lockfile, file budget), so what is reviewed can be checked against the changed files.
- Reviews leave out binary files (images, archives), which cannot be read as text, instead of failing on them. A changed dependency lockfile (`uv.lock`, `package-lock.json`, `Cargo.lock` and others) is reviewed by its changed entries only, the added or updated packages and their sources; **Review all** leaves lockfiles out.
- The **Model** list moved into the dashboard toolbar, next to the review buttons, so you can choose the Copilot model for reviews, summaries, commit messages and fixes from any view, including Uncommitted changes.
- **Compare branches** also lists tags, newest version first, so the changes since a release (for example `1.12.0` → `main`) are two picks, labelled with the tag's name. Picking the same branch or tag twice says so in the dialog instead of a pop-up.

### Removed

- The **◈ Release › Load range** button. Compare a release tag with the branch from **Compare branches** instead.

## [2.0.0] - 2026-10-07

### Added

- **Write with Copilot** in the commit dialog: Copilot writes the commit message for the selected files (the staged part, when that is what you commit), following the repository's own commit convention from AGENTS.md, CLAUDE.md, CONTRIBUTING.md or a commitlint config, or Conventional Commits when it has none. The message goes into the dialog for you to edit; a draft you had is one Undo away. It asks before sending code, and shares the review's "Always allow" per repository.
- **Uncommitted changes** in every repository's history: a row above the newest commit with its counts (staged, modified, new, conflicted). Selecting it shows each changed file with its **Staged** or **Unstaged** diff, and **Commit…** and **Review changes** for exactly those changes. With local changes and no commit picked, the dashboard opens on them instead of the newest commit.
- Local changes stay current while you edit: saving, creating or deleting files, and staging with Git, refresh the uncommitted changes and the sidebar's change counts about a second later (`repositoryManager.liveChanges`, on by default). Changes only to files Git ignores, such as build output, do not refresh.

## [1.12.0] - 2026-10-07

### Added

- **Review changes**: review your local changes before committing, staged and unstaged changes and new files (not those `.gitignore` excludes). The review reads a snapshot taken when it starts; nothing is committed, staged or changed, and the same changes reviewed again reuse the earlier review's results and decisions. Auto-fix stays for committed reviews, since it would write over files you are editing. (#59)
- **Push after commit**: a checkbox in the commit dialog pushes the branch once the commit is created, and is remembered per repository. A failed push keeps the commit and says only the push failed.
- Each repository in the sidebar shows its local changes by kind: **S** staged, **M** modified, **U** untracked, **C** conflicted, with the counts spelled out on hover.

### Changed

- A selected file that was staged and then changed again asks whether to commit **only the staged part** or **the whole file**, instead of always committing the whole file.
- The commit preview's toggle is now **Staged diff / Unstaged diff**, with both always shown; it switches the preview and never stages or unstages anything.
- Push uses the branch's own remote, and on a detached HEAD says to check out a branch instead of showing a Git error.
- At narrow widths the comparison status shortens with an ellipsis, full text on hover, instead of leaving the screen.

### Fixed

- A commit that failed (for example, rejected by a hook) left the selected files staged; your staging is now left exactly as it was.
- Committing selected files during a paused merge is refused, instead of recording an incomplete merge.
- Untracked files in a new folder are counted one by one.

## [1.11.0] - 2026-10-07

### Changed

- Reviews open in their own **Repository Review** editor tab, beside the dashboard. **Review commit**, **Review branch**, **Review all** and **Clean code** sit next to **Load range**, followed by a **Review ↗** button that opens the tab. A review keeps running when you close the tab, and the button shows its progress, then its number of blocking items. The tab follows the repository selected in the dashboard, and evidence still opens the cited line in the dashboard's diff.
- A submodule detached at the commit the parent records is shown as **pinned** (grey) and counts as aligned, since that is how `git submodule update` leaves it. **detached** and **drift** now warn only when a repository is off the recorded commit or on another branch.
- Repository badges and the review buttons explain themselves on hover; reviews say that uncommitted and untracked files are not reviewed, and the Review tab says so when the repository has uncommitted changes.
- The review header names the model that reviewed (its exact id on hover), and the report shows both.
- **Failed checks** are listed once per reason, with what to do (for example, choose a model with a larger context), and **Retry failed** runs the review again for those parts only; parts that passed are reused. A **Review log** shows each step and failure with its time, and the report lists failed checks by reason.
- A finding dismissed, or marked Needs fix, in an earlier review of the same repository keeps that decision when a new review reports it on the same code, even in other words, labelled **earlier review**. One marked Fixed and reported again on unchanged code is marked Needs fix, as **Reported again after Fixed**.

### Fixed

- The package's repository link pointed to the project's old name; it now points to Eurus7895/Repository-Manager.
- A long finding title widened its row past the panel and hid its file, line and status.
- A saved review with many skipped files could lose its failed checks; they are now kept first.

## [1.10.0] - 2026-10-06

### Added

- **Reviews continue where they stopped.** Each finished component is saved, so running the same review again asks Copilot only for the rest, after a Cancel, a closed VS Code or a model error. Cancel keeps what finished: the stopped review is shown and saved with how far it got, and **Continue review** picks it up. Saved results are reused only with the same model and review instructions, and kept for 30 days.
- **Review skills**: checklists Copilot gets with the files they match, for injection, authentication and sessions, secrets and cryptography, CI/CD, cloud and infrastructure as code, Python, JavaScript/TypeScript, C and C++ and clean code, based on public standards (CWE Top 25, OWASP ASVS, Microsoft SDL, SEI CERT, OpenSSF Scorecard, the AWS Security Pillar, Google's code review guide). They turn on by file type, can be turned off, and you can import your own from a Markdown file. The report lists the skills each component got.
- **Clean code** checkbox: reviews also report maintainability (complexity, duplication, naming, error handling, dead code, tests) in a **Code quality** section that never blocks a review.
- **To verify**: what the model could not see from the reviewed files (callers, CI settings, external services), as a short list to check by hand.

### Changed

- Findings are one line each (severity, title, file and line) and open to their details; **Expand all** opens every one. Their text and labels have stronger contrast, and `code` in them is shown as code.
- A dismissed or fixed finding stays where it was, folded with its state and an **Undo**, instead of moving to the end of the list.
- Coverage says what happened to the files: fully reviewed, partly reviewed (lockfiles, images, diagrams and test inputs counted apart), not reviewed, failed checks. Partly read files are no longer called skipped.
- The README is short: features, install, settings and development; how a review works is in `docs/security-compliance-review-engine.md`.
- Limitations no longer repeat which files were in scope, that they contain no sinks, or that a file was not read. Each note stays whole instead of being cut into sentences, and file names keep their case.

### Removed

- The repository no longer carries a stale 1.1.0 VSIX; get the VSIX from the GitHub release.

### Fixed

- Dismissing a finding that a proposed fix covered left an error box that could not be closed. Its files now leave the proposal and the rest can still be applied; when nothing is left, the proposal closes with a note you can close.

## [1.9.1] - 2026-10-05

### Changed

- Reviews are split by what they cover, so no two buttons share a name:
  - **Review commit** (the toolbar above the changed files, formerly Review changes) reviews the selected commit or the loaded comparison.
  - **Review branch** (new, at the top) reviews what the current branch adds since it left the default branch, as a pull request shows it.
  - **Review all** (at the top, formerly ◈ Release › Review branch) reviews every committed file at the tip of the current branch.
- The toolbar no longer has its own Review branch, which reviewed every file at the selected commit under the same name as the one at the top.
- Tooltips say that reviews read committed files only.
- Repositories, branches, tags, remotes and stashes moved from the dashboard tab to VS Code's Side Bar. Select the Repository Manager icon in the Activity Bar to show them; the dashboard opens next to it and uses the whole editor for history and changes. Closing the dashboard leaves the Side Bar with an **Open Repository Manager** button.

### Fixed

- Deleting a branch that also exists on origin asks in one VS Code dialog whether to delete the local branch only or origin's as well. The question used to be a browser dialog inside the dashboard, which VS Code may not show, so the remote branch could not be deleted from there.

## [1.9.0] - 2026-10-04

### Changed

- The dashboard follows the VS Code colour theme: light, dark and high-contrast themes get their own colours instead of the fixed dark palette.
- Review results separate findings from **Review gaps** (no policy, an unresolved rule, incomplete coverage): the banner counts each ("3 findings · 2 review gaps"), and the advisory note appears once, at the end.
- The Review tab has more room: the commit header and summary toolbar give way to it, and **Expand** hides the history for the whole review.
- Ctrl+click (Cmd+click) or Shift+click a history row to pick it for a comparison, as in Git Graph.
- The Model menu loads its list when you open it, so the Load models button is gone; the list ends with **Reload model list**.
- **Sync** is now **Align**, matching the "aligned" count of linked repositories and no longer reading like VS Code's Sync (pull and push).
- Switching repository or filters keeps the current history dimmed until the new one arrives, instead of flashing a loading message; scrolling to the end loads more history.
- One toolbar for what the dashboard shows: **Summarize changes**, **Review changes** and **Review branch** now sit together above the changed files and act on the selected commit or the loaded comparison. The comparison status next to the search only names the range, so it no longer pushes the search box off screen.
- **◈ Release › Load range** replaces Release › Summarize changes, which had the same name as the toolbar button but did something else. It loads the changes since the latest release tag on the current branch; summarize or review them from the toolbar.

### Added

- **Auto-fix progress**: while Copilot proposes a fix, the Review tab shows each step (checking the cited files, sending the findings and files, receiving the edits with how much has arrived, checking the edits) and the elapsed time.
- **Apply all or Apply selected**: each proposed file lists the findings it fixes and has a checkbox. Apply every file, or untick some and apply the rest; files you leave out stay proposed.
- **Fixed** findings: once its fix is applied, a finding moves to a **Fixed** section and out of "to fix" and readiness. You can also mark a finding Fixed by hand. The report and saved reviews record it.

### Fixed

- Reviews no longer lose whole components to model hiccups. A reply with text around its JSON is read anyway, and an unreadable reply gets one more try. A tool the model may not use (such as reading a diff in a branch review) is reported back to the model instead of failing every file in the component. When the model runs out of tool calls, it is asked for its result from what it has read.
- Long files are no longer listed as skipped after the first 100 lines. Each file now sends up to 400 lines at first, a file the model reads to the end counts as reviewed, and the rest say how much was read (for example "Partly reviewed: the model saw 400 of 2,315 lines").
- History search finds commits anywhere in the history. It used to look only at the newest 2,000 commits and show no result for older matches.
- The dashboard opens faster: on a repository with 20,000 commits and 8 submodules, the history appeared after about 1.5 s and now after about 0.4 s. The repository list needs 13 Git processes instead of 64, they run in parallel, and opening no longer loads the history, branches and commit details twice.
- **Load more** stays fast: each click adds its rows instead of redrawing the whole list, so it no longer gets slower with every page (at 2,000 rows, about 0.4 s instead of 1.7 s).
- A submodule that is not initialized is shown as uninitialized. It used to show the parent repository's branch, commit and changes.
- The parent repository is marked modified when its own files change or a submodule moves to another commit, but no longer when a submodule only has uncommitted edits; that submodule's own row shows them.

## [1.8.0] - 2026-10-02

### Added

- **Past reviews**: every completed review is saved with your triage, so you can check it later, even after restarting VS Code. The Review tab lists each repository's last 20 reviews with date, range, the exact commits reviewed, readiness and counts. Open one to see its findings, export it, or fix it; delete the ones you no longer need. Reviews are kept in VS Code's workspace state on this machine, never in the repository.

### Changed

- **◈ Release › Summarize changes** replaces Release › Review changes. It loads the changes since the latest release tag on the current branch into the dashboard and summarizes them with Copilot. To security-review that diff, choose **Review changes** next to the loaded range. **Review branch** still reviews every file on the current branch.

### Fixed

- The latest release tag is found by version number when tags with and without a `v` prefix are mixed. Before, `v1.9.0` was picked over a newer `1.10.0`.

## [1.7.2] - 2026-10-02

### Fixed

- When your branch is behind its configured upstream (for example `origin/<branch>`), the history graph draws them as one straight line in the first column, as Git Graph does, instead of putting the upstream's newer commits in a separate column that curves into your branch. An upstream that has diverged from your branch still gets its own column.
- The history columns settle at once when the dashboard gets narrower, for example after moving it to a new window. They used to take about a second to shrink step by step.

## [1.7.1] - 2026-10-02

### Fixed

- Review results no longer repeat the same limitation for every component reviewed. Notes that the report already gives once are left out: which files were in scope, that no policy was configured, that content was truncated, or that no flaw was found. The notes that remain are specific to the code, such as behavior that depends on callers that weren't reviewed.

## [1.7.0] - 2026-10-02

### Added

- **Fix with Copilot** after a review: mark findings **Needs fix**, and Copilot proposes edits to the files they cite. The proposed diff appears in the Review tab, and nothing is written until you choose **Apply to working tree**. Applying never stages or commits. Auto-fix needs the reviewed commit checked out and the cited files free of local or unsaved changes, and it checks this again just before writing.
- Triage review findings: mark each one **Needs fix** or **Dismiss** (false positive, accepted risk, or not applicable). Dismissed findings move to their own section and no longer count toward readiness, so a dismissed verified high stops blocking; the exported report lists them with the reason.
- Review progress: a progress bar, the component being reviewed (for example "Component 2 of 3 · Analyzing"), files done, candidate findings, elapsed time, and a checklist of every component.
- The sidebar branch list is a folder tree: `feature/a` and `feature/b` sit under **feature**. Folders collapse; the one holding the checked-out branch stays open.

### Changed

- **Review whole** is now **Review branch**; the Review tab and the report say **Branch: main**.
- A review runs in the background: switch repository, workspace folder or tab, and browse commits, while it continues. The Review tab shows its progress as a percentage, and the header names the reviewed repository when you are looking at another one. Clicking a commit shows its changes. Only starting a second review waits until the first finishes or is cancelled. Switching workspace folders no longer cancels a review.
- History graph, Git Graph style: the checked-out branch stays in the first column with a ring on HEAD, and every branch keeps one column and one colour from its tip until it merges. A branch started from another branch's commit curves into it instead of leaving a dangling line.

## [1.6.0] - 2026-09-29

### Added

- Switch the dashboard between the parent repository and linked repositories from a Repositories list that shows each repository's branch, status, ahead/behind counts, drift from the parent branch, and whether it has moved off the commit the parent records.
- Reset a single linked repository to the commit the parent records from its row in the Repositories list, after a confirmation that explains the resulting detached HEAD. It resets only the commit you confirmed and needs no network when that commit is already local.
- Show old and new file line numbers in commit and working-tree diffs.
- Fetch all repositories in the background every `repositoryManager.autoFetchInterval` minutes (default 5) while the dashboard is visible, so ahead/behind counts stay current. Background fetches never prune; only the Fetch button removes deleted remote branches. The existing `repositoryManager.autoFetch` setting, which previously had no effect, turns this on or off.
- Run a security and compliance review with GitHub Copilot from the dashboard. Every entry point has **Review changes** (the diff) and **Review whole** (every file): a Base/Target selection, a branch comparison, the history menu, and **◈ Release** (since the latest release tag, or the whole current branch). One click starts the review, with no dialog. Results open in a Review tab, headed **Diff: …** or **Whole: …**, with findings, policy results, coverage and limitations; evidence links jump to the cited line in the diff.
- Reviews report readiness: blocked (verified critical or high findings, policy violations), needs attention, or no blocking findings. Copy or save the report as Markdown.
- Consent before sending code to Copilot is asked once per repository with **Always allow for this repository**; **Repository Manager: Forget Review Permissions** undoes it for chosen repositories, and the `repositoryManager.review.confirmBeforeSending` setting asks every time.
- Add `npm run test:ui`, which renders the dashboard in headless Chromium against a fixture workspace and writes screenshots to `ui-snapshots/`.

### Changed

- Hide Git's `diff --git`, `index`, `---`, and `+++` header lines in diffs; the panel title already names the file.
- Dialogs close on Escape (an open dropdown closes first), move focus inside when they open, keep Tab within the dialog, and return focus to the button that opened them. They are announced as modal dialogs to screen readers.
- The history context menu shows Continue rebase and Abort rebase only while a rebase is paused.
- At narrow editor widths the history keeps a readable Message column (Author and Date shrink first), ref labels stay on one line and truncate, the Refresh, Fetch, Pull, Push, and Sync buttons and the Include remotes toggle stay visible, and repository badges move under the repository name in a narrow sidebar.
- Publishing a release whose tag is newer than `package.json` now packages the VSIX with the tag's version and attaches it, instead of failing and attaching nothing (this is what left 1.5.0 without a VSIX). A tag older than `package.json` is still refused.

### Removed

- Remove the unreachable repository selection bar; branch creation already selects repositories in its own dialog.
- Remove the unreachable code left from the old repository cards: the inline branch panels, the checkout-branch and checkout-commit dialogs, the rebase marker, and about 630 lines of unused CSS.

### Fixed

- Choosing another workspace folder now loads its history, branches, and repositories immediately instead of after Refresh.
- The header Sync button now reloads the history of the repositories it moved.
- Re-select all available repositories when opening New branch after creating a branch from a history commit.
- Pull refuses a detached HEAD instead of merging the remote default branch into it.
- Pull uses the branch's configured upstream, so branches tracking a differently named remote branch can be pulled.
- A pull that stops on conflicts now says a merge or rebase is in progress; diverged branches and other failures report the reason instead of fetch output.
- Ahead/behind counts compare against the branch's upstream, matching what Pull and Push use.
- The Pull, Push, and Fetch buttons always leave their busy state and keep their own label in the tooltip.

## [1.5.0] - 2026-09-25

### Added

- Right-click commit history actions to copy commit details, checkout a commit, create a branch or annotated tag, cherry-pick, revert, and merge.
- Rebase the current branch onto a selected commit, reset it (soft, mixed, or hard), or drop an unpublished commit, with confirmation, backup branches for hard reset and drop, and rebase continue/abort actions.
- Analyze large changes in bounded AI Change Summary batches with validated evidence and progress for each part.

### Fixed

- Refresh dashboard history after Git actions change commits or refs, including after resolving conflicts.
- Allow a summary with an invalid batch intent to be retried instead of caching incomplete output.

## [1.4.0] - 2026-09-25

### Added

- Select an available GitHub Copilot model when generating an AI Change Summary.
- Restore the summary for the selected model when switching between models or commits.

## [1.1.0] - 2026-09-21

### Added

- Parent repository support in the dashboard and coordinated branch workflows.
- Parent repository selection for branch creation and deletion quick actions.
- One-click **Sync Versions** action for all linked repositories.
- Multi-root workspace selection and repository refresh when switching folders.
- Searchable branch lists with local and remote indicators.
- Branch filtering by repository name, path, and branch name.
- Checkout, pull, push, branch deletion, and pull-request actions from the repository view.
- Commit checkout and comparison with the commit recorded by the parent repository.
- Rebase-state tracking to reduce accidental synchronization during rebase work.
- Repository history with paginated commit loading, branch filtering, remote inclusion, and search.
- Commit inspection with changed-file navigation and per-file patches.
- Sidebar reference browsing for branches, tags, remotes, and stashes.
- Workspace alignment cards that compare every repository with the active target branch and surface drift or conflicts.
- Resizable history/diff and changed-files/diff split panes with persisted panel sizes.
- Accessible graph-node selection for comparing any two history commits, with explicit Base/Target markers and a dedicated branch comparison workflow.
- Expandable tag, remote, and stash details in the dashboard sidebar.

### Changed

- Repositioned the extension as **Repository Manager**, with repository and branch workflow management as its primary purpose.
- Reduced submodule-specific terminology in the main product description and documentation. Git submodules remain the supported linked-repository mechanism.
- Extended branch hierarchy rules:
  - `dev` can create `feature/` and `release/` branches.
  - `feature` can create `feature/` and `task/` branches.
  - `task` can create `task/` branches.
  - Unknown branch types can use any supported prefix.
- Improved repository row and branch-list layouts for stable sizing and clearer current-branch highlighting.
- Redesigned the webview as a desktop Git dashboard with a command bar, repository sidebar, history table, commit summary, changed-file list, and diff viewer.
- Removed the duplicate Activity Bar `Repositories` and `Quick Actions` views so the editor dashboard is the only UI surface.
- Reintroduced the compact branch list inside the editor dashboard while keeping the removed Activity Bar tree views out of the extension.
- Synchronized the branch list with the history selector and highlighted the active history branch.
- Replaced the decorative single-line history graph with a continuous, topology-aware SVG graph that expands beyond five branch and merge lanes.
- Persisted branch, remote-inclusion, and search filters independently for each repository.
- Restored the active commit's parent diff whenever a comparison is cleared or reduced to one selected node.
- Hardened graph and toolbar layouts at narrow breakpoints and increased graph-node keyboard and pointer hit areas.
- Matched the dashboard command buttons to the approved HTML design with compact outlined icons, counters, spacing, and separators.
- Unified commit, merge, release, and branch comparisons around an explicit base-to-target diff range.
- Reworked the dashboard visual system from the approved design: compact branded header, repository filter, status-aware repository rows, denser history graph, commit inspector, diff styling, and branch workflow modal.
- Restored the Repository Manager Activity Bar icon as a single dashboard launcher without bringing back the removed repository and quick-action trees.
- Replaced the extension artwork with the Repository Manager graph icon and added a monochrome Activity Bar variant.
- Updated the dashboard to treat the parent and linked repositories as one repository collection, including repository-wide statistics, search, selection, and branch workflows.
- Kept submodule terminology only for Git operations that specifically initialize, update, or stage submodule pointers.
- Restored branch delete actions after an optimistic checkout changes the current branch.
- Split the extension into command, handler, service, and webview modules for easier maintenance.
- Added dedicated read services for paginated history, commit details, file diffs, branches, tags, remotes, and stashes.
- Added typed dashboard request/response contracts so the redesigned UI can lazy-load repository data.
- Replaced shell-based Git execution with argument-safe process execution and workspace path validation.
- Renamed the extension package and publisher identifiers to `repository-manager`.
- Renamed commands and settings from `submoduleManager.*` to `repositoryManager.*`.
- Renamed the Activity Bar container and contributed view IDs to the Repository Manager namespace.
- Changed the packaged artifact name to `repository-manager-1.1.0.vsix`.

### Breaking

- VS Code treats Repository Manager as a new extension identity rather than an automatic update from Submodule Manager.
- Existing settings under `submoduleManager.*` must be migrated to `repositoryManager.*`.
- Keybindings or automation invoking `submoduleManager.*` commands must use `repositoryManager.*`.

### Fixed

- Branch lists not updating after asynchronous loading.
- Base-branch delivery failures by awaiting webview messages and retrying incomplete loads.
- Inconsistent branch tags and row sizing during filtering and checkout.
- Webview interaction failures caused by inline handlers and Content Security Policy constraints.
- Empty changed-file lists and patches for merge commits by comparing against the merge commit's first parent.
- TypeScript rebuilds accidentally reading generated declaration files from `out/`.
- Added backend parser, path-boundary, and live Git integration tests.

## [1.0.2] - 2026-02-24

### Added

- Branch-name filtering in the repository search field.

### Changed

- Reworked repository rows with a consistent CSS grid layout.
- Kept branch tags focused on local and remote state while using highlighting for the current branch.
- Excluded the generated `out/` directory from TypeScript compilation inputs.

### Fixed

- Repository cards changing size while branch filters were active.
- Merge-conflict remnants in the webview stylesheet.

## [1.0.1] - 2025-01-29

### Added
- **Branch Naming Tool**: New intelligent branch creation with auto-formatting
  - Input task title (e.g., "Design and Implement XML Parser Abstraction Class")
  - Auto-converts to kebab-case branch names
  - Optional ticket ID prefix (e.g., ECPT-15474)
  - Live preview of generated branch name

- **Branch Hierarchy Rules**: Enforced branch naming conventions based on base branch
  - From `main`/`master`: Can create `bugfix/`, `release/`, `dev/` branches
  - From `dev`: Can create `feature/` branches
  - From `feature`: Can create `task/` branches
  - Dynamic prefix options update based on selected base branch

- **Base Branch Selection**: Dropdown with available branches
  - Shows all local branches from the repository
  - Current branch selected by default
  - Displays branch type hints

- **Review Step After Branch Creation**: New confirmation modal
  - Shows success/failure status for each submodule
  - Displays the generated branch name
  - Option to push to remote after confirmation

- **Push to Remote**: Integrated push functionality
  - Push newly created branches directly from the review modal
  - Also available in the quick action command palette flow

### Changed
- Release branch prefix changed from `Release/` to lowercase `release/`
  - Example: `release/HexOGen_10.54.0`
- Base branch input changed from text field to dropdown selector
- Quick action "Create Branch" command now follows the same workflow:
  - Step-by-step guided flow with prefix selection
  - Branch hierarchy enforcement
  - Push option after creation

### Branch Naming Conventions
- **bugfix/feature/task**: `{prefix}/{ticket-id}-{kebab-case-title}`
  - Example: `feature/ECPT-15474-design-and-implement-xml-parser`
- **release**: `release/{ProductName}_{version}`
  - Example: `release/HexOGen_10.54.0`
- **dev**: `dev/{kebab-case-name}`
  - Example: `dev/sprint-42`

---

## [1.0.0] - 2024-01-26

### Added
- Modern webview dashboard with real-time submodule status
- Visual status cards for each submodule showing:
  - Current branch and commit
  - Status (clean, modified, uninitialized, detached, conflict)
  - Ahead/behind remote counts
- Branch creation across multiple submodules simultaneously
- Quick actions for individual submodules:
  - Checkout branch
  - Pull changes
  - Push changes
  - Create pull request (opens GitHub)
  - Open in Explorer
  - Stage submodule changes
- Tree view sidebar with:
  - Collapsible submodule list
  - Quick actions panel
- Version synchronization to configured branches
- Search and filter submodules
- Bulk selection for batch operations
- GitHub PR integration
- Configurable settings:
  - Default branch name
  - Auto-fetch on panel open
  - Notification preferences
  - GitHub token for API access
- Keyboard shortcuts:
  - `Ctrl+Shift+G M` - Open manager panel
  - `Ctrl+Shift+G R` - Refresh submodules
- File system watcher for auto-refresh when .gitmodules changes

### Technical
- TypeScript implementation
- Webview with VS Code theme integration
- CSP-compliant security
- Efficient git operations with proper error handling
