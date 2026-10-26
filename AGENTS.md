# AGENTS.md — Instructions for AI Agents and Harnesses

This file defines how to work in this repository. Keep it under 120 lines.
Keep product requirements and architecture in task-specific documents, not here.
Write repository documentation in English; converse in the user's language.

## Response Style

- Answer the current question directly; lead with the main conclusion.
- Scale depth to the question, complexity, and risk. Do not turn a simple answer into a post-mortem.
- Explain mechanisms and causal reasoning in plain language; define jargon when it helps.
- State assumptions and distinguish verified facts, inferences, and proposals.
- Support implementation claims with relevant code locations, logs, or test evidence. State what remains unverified.
- Quantify when measurements exist; never invent numbers or imply precision without evidence.
- Offer judgments and recommendations with reasons, rather than merely listing information.
- Be detailed enough to assess the conclusion and concise enough to keep the important point visible.

## Start Each Task

1. Read this file and any instructions scoped to the files you will touch.
2. Identify the requested outcome and any decisions already approved in the
   conversation. Do not restart discovery for settled decisions.
3. Discover the specification, design, and plan relevant to the current task.
   Start with user-provided references and `docs/` (there is no index; read
   the file names), then search by feature, component, or affected code.
   Check scope, approval status, and superseding decisions before applying a
   document. Do not select it solely because it has the newest date.
   If no applicable document exists, state that and plan at the task's scale.
4. Inspect the actual files, interfaces, dependencies, tests, and working-tree
   changes relevant to the task before proposing edits.
5. Distinguish implemented behavior, approved requirements, and proposals.
   A document describing a command or component does not prove it exists.

## Interpret References Correctly

- Documents may reference other repositories or proposed interfaces. Verify repository ownership and actual availability before using those references.
- Do not assume an external runtime, command, or configuration exists here.
- Before implementing an integration, verify its interface and resolve where the new code belongs. Do not silently copy or modify another repository.
- When working in another repository, read its applicable instructions.
- Surface material conflicts between code, documents, and current user decisions. Do not silently convert an assumption into a requirement.

## Preserve the User's Reasoning Ownership

Use Problem → Design → Predict → Build → Validate → Learn.

- Let the user own problem framing, initial design, trade-offs, and technical decisions. Critique their reasoning after they have expressed it.
- Ask targeted questions only for unresolved decisions that affect the work and need the user's judgment. Reuse answers already given; do not turn each small step into a questionnaire, a lecture or a Socratic sequence.
- Before a meaningful implementation, elicit failure predictions if they have not already been stated, then add overlooked risks. If the user has none, state the risks with how you will handle them and proceed.
- Implement authorized work, including routine code, tests, and documentation.
- Report validation evidence; leave final product acceptance to the user.
- After a meaningful experiment, compare predictions with observed outcomes and record the lesson without forcing reflection after every small edit.

## Apply Feature-Centered Rings (FCR)

- Identify the central feature and its minimum value; work on the nearest component blocking it, and widen scope only for an actual blocker (say which one it removes).
- When work is too difficult, split it, reduce scope, or change the approach. Building: verify the complete feature after integration. Studying: check the user's explanation and transfer to a changed problem, not just a finished artifact.

## Plan and Implement

- Scale the plan to the task. Use the existing approved plan when applicable; a small edit needs a short stated approach, not a new architecture document.
- Do not treat the product's runtime approval rules as instructions requiring user approval for every edit you make to this repository.
- Preserve unrelated local changes. Avoid destructive replacements without explicit authorization; prefer isolated, reviewable changes.
- Reuse verified capabilities before adding new abstractions or dependencies.
- Keep responsibilities and interfaces clear. If delegating authorized work, provide the goal, inputs, output contract, allowed scope, and acceptance checks; review returned artifacts rather than trusting completion summaries.
- Keep requirements, assumptions, decisions, and observed results distinct in the PR description (and `docs/` for lasting design). Do not rely on conversation memory as the only record.

## Validate and Report

- Use tests appropriate to the change. For features and bug fixes, include failure cases and relevant integration behavior, not only happy paths.
- Run the affected user flow when feasible. Unit tests alone do not establish that the integrated application works.
- Do not claim commands, tests, or live runs succeeded without observing them. State what was checked, what failed, and what remains unverified.
- Keep credentials out of code, documents, logs, and test fixtures. Use test doubles for unit tests that would otherwise call external model providers.
- Record reproducible commands and evidence where useful. Separate technical readiness from user acceptance and subjective quality judgments.
- Update affected documentation when behavior or a decision changes.
- Do not commit or publish merely because a plan lists a future Git step.

## Branches and Commits — Read Before Every Git Command

- Commit as the human author you are working for, never as an AI or tool identity: their name and GitHub no-reply address (`<id>+<login>@users.noreply.github.com`) for both author and committer, never a private email. Take it from the user, or from the most recent commits on `origin/main` whose author email is a no-reply address (`git log origin/main --format='%an <%ae>'`; history holds more than one name for the same address, so use the latest); never from the committer field, and never a private address, both of which older commits got wrong. Ask if it is unclear.
- Never persist `user.name` or `user.email` with `git config`. The environment may hold another identity: a global config (cloud sessions have `Claude`) or preset `GIT_AUTHOR_*` variables (cloud sessions set the account's private email). Git uses them silently, and the variables win over `-c user.email`.
- Set the identity as environment variables at the start of every command that writes a commit (commit, merge, cherry-pick, revert, amend, and each `rebase` and `rebase --continue`): `GIT_AUTHOR_NAME='<name>' GIT_AUTHOR_EMAIL='<no-reply>' GIT_COMMITTER_NAME='<name>' GIT_COMMITTER_EMAIL='<no-reply>' git commit ...`. They override every other source. Shell state does not carry over between tool calls, so an earlier `export` is gone.
- Before every push, `git log origin/main..HEAD --format='%an <%ae> | %cn <%ce>' | sort -u` must print one line, with the author's no-reply identity on both sides; if not, recommit before pushing.
- Never add AI/tool attribution, co-author/session trailers, generated-by footers, or AI session links to commits, PRs, comments, or documents. Some tools append a footer on their own: read back each PR body or comment you post and remove it; where it cannot be removed (some review replies), resolve the thread without replying.
- Never push to `claude/*`; never put `codex` or `claude` in branch names or PR titles.
- Name work branches `<type>/<area>-<outcome>` in lowercase kebab-case, with `<type>` one of `feat`, `fix`, `docs`, `refactor`, `test`, `build`, `ci`, `chore`. The name must be meaningful on its own: `<area>-<outcome>` says what the branch changes (for example `feat/review-triage-autofix`, `fix/graph-dangling-lanes`), never a vague word (`fix/stuff`, `feat/update`), a bare ticket number, or a date. No session suffixes or tool prefixes. (Conventional Commits applies to commit messages, not branch names.)
- Start work from the latest `origin/main` (this repository has no `dev` branch): fetch, then create the branch from it. If `main` advances, fetch and rebase before pushing; never push a stale base. Rebasing your own unmerged branch and pushing it with `--force-with-lease` is expected; never rewrite `main` or someone else's branch.
- Release by tagging `main` (for example `1.7.0`) and publishing a GitHub release; the Build VSIX workflow runs on the published release, not on a tag push, and attaches the VSIX. Do not cut a branch for a normal release. If you cannot create the tag or release (cloud sessions get 403), hand the user the tag, the target SHA and the release notes, and stop. A release that has no VSIX can be given one by running Build VSIX manually with `release_tag`.
- If a published version needs a fix while `main` holds unreleased work, do not tag `main`; stop and ask the user how to ship the fix.
- Never amend or rewrite a commit that is on `main` or in a merged PR; create a new commit instead.
- Follow Conventional Commits 1.0.0: lowercase type/scope, imperative subject, at most 72 characters, no trailing period; wrap body at 72 columns and explain why.
- Breaking changes require both `!` and a `BREAKING CHANGE:` footer.
- Update `CHANGELOG.md` (Keep a Changelog, under the upcoming version) before every PR; keep entries user-facing and summary-only. Parallel PRs conflict there: keep both entries under one version heading, and bump the version once.
- Set the version with `npm version <x.y.z> --no-git-tag-version`; the release tag is the version of record.
- Bump the minor version for any user-visible feature change, including removing or moving UI; bump the patch version only for bug fixes that leave the interaction unchanged.

## This Repository

- VS Code extension: TypeScript host in `src/`, bundled review skills in `resources/review-skills/`, webviews in `resources/` (dashboard: `webview.js`, `historyGraph.js`; Repository Review tab: `review.js`; Side Bar: `sidebar.js`; all use `webview.css`), HTML in `src/webview/template.ts`. The dashboard owns the repository list and mirrors it to the Side Bar (`src/repositoryManagerLauncher.ts`); `src/reviewBridge.ts` routes review messages between the dashboard, the review tab and `ReviewController`.
- Validate with `npm run lint`, `npm test` (compiles, lints, then runs the suites listed in `package.json`'s `test` script; add a new `src/test/*Smoke.js` there or it never runs), `npm run test:ui` (Playwright screenshots of the real webviews into `ui-snapshots/`; set `PLAYWRIGHT_CHROMIUM_PATH` if Chromium is not where Playwright looks), and `npm run package` (the VSIX; `.vscodeignore` decides what ships). CI (`.github/workflows/build-vsix.yml`) runs all three on every pull request.
- Review skills (`resources/review-skills/*.md`, design in `docs/security-compliance-review-engine.md`): write guidance in your own words and name the public standard in `references` (at most 300 characters; longer is cut). Keep `injection-sinks` language-neutral and APIs in one language skill, so two skills never describe the same line. Cover each glob or size change with a selection test in `src/test/reviewSkillsSmoke.js`.
- Webviews are sandboxed: do not use `alert`, `confirm` or `prompt`; ask from the host (`vscode.window.show*Message`).
- Copilot (`vscode.lm`) calls are not available outside VS Code: tests use scripted runners and models. Live model paths remain unverified until run in VS Code; say so.
- There is no `docs/roadmap.md` or commit guard script here. Verify `origin/main` and any referenced file exist before relying on them; report gaps instead of inventing them.
