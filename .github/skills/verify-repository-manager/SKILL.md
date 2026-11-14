---
name: verify-repository-manager
description: Verify behavior of the Repository Manager VS Code extension after a change or for a regression sweep — map the diff to feature areas, compile fresh, run the repository's checks (compile, lint, the Node smoke suites, the Playwright UI tests of the real webviews, VSIX packaging, commit identity), drive the affected areas through those harnesses, capture evidence, and review it against the goal. Use after implementing or fixing anything in this repository, and before pushing.
---

# Verify Repository Manager

The extension runs inside VS Code, which an agent cannot start here. Its behavior is driven through
the harnesses the repository already has:

- **Node smoke suites** (`src/test/*Smoke.js`) run the real host code against real Git repositories in
  the system temporary folder, with a scripted `vscode` and scripted models.
- **Playwright UI tests** (`uiSnapshots.js`, `requirementEditorUi.js`, `studioEditorUi.js`, `studioChatUi.js`) load the real
  webview pages under their Content Security Policy in Chromium, against the real providers.

A live run in VS Code with Copilot is a person's step; this skill names it but cannot do it.

The CLI is `scripts/verify` (Node, standard library). It runs the repository's own npm scripts and
`git`. It writes `.verify/` (evidence; add it to `.gitignore`, see the setup proposals) and
`ui-snapshots/` (through the UI tests). It starts no server and reaches no network.

## Checks

| Check | Kind | Command | Applies when | Required | Passes when |
| ----- | ---- | ------- | ------------ | -------- | ----------- |
| compile | build | `npm run compile` | always | yes (CI: `npm test` compiles) | exit 0 |
| lint | lint | `npm run lint` | `src/**/*.ts`, `.eslintrc.json`, `package.json` changed | yes (CI: `npm test` lints) | exit 0, no ESLint error |
| static-analysis | static analysis | — (CodeQL runs only in GitHub; strict TypeScript is the compile check) | always | no | read the pull request's CodeQL and Analyze results; locally `not run` |
| unit | tests | `npm test` | always | yes (CI gate) | exit 0: every suite in package.json `test` passed |
| ui | tests | `npm run test:ui` (needs Chromium) | `resources/**`, `src/webview/**`, `src/handlers/**`, the panel, launcher, requirements, studio and review host files, the UI tests, `package.json` | yes (CI gate) | exit 0 and every UI test in `test:ui` prints "passed" |
| package | build | `npm run package` | `package.json`, `package-lock.json`, `.vscodeignore`, `resources/**`, `src/**`, `CHANGELOG.md`, `README.md` | yes (CI gate) | exit 0 and `DONE  Packaged: <file>.vsix` with the file present |
| commits | conventions | (built into `check`) | commits since the base | yes (AGENTS.md) | one identity, a GitHub no-reply address for author and committer, no AI trailer, footer or session link |

Baseline on `main` (2026-11-08): every check passes; `unit` reports 55 suites passing.

## Procedure

Run everything from the repository root, with `V=.github/skills/verify-repository-manager/scripts/verify`.

1. `node $V doctor` — stop on any failure; it starts a new run and compiles if the tree changed since the last build.
2. `node $V affected [<base>]` — read every listed feature file. Report `unmapped:` source paths as a map gap
   (docs and tests are unmapped by design).
3. `node $V check --affected [<base>]` — every applicable check, each ending `passed`, `failed`,
   `not applicable` (with the reason) or `not run` (with the blocker).
4. `node $V start` — prints that nothing is started (the extension runs in VS Code).
5. For each affected area, run the smoke suites and UI tests its feature file names under **Driving it**,
   each through `node $V capture <label> -- node src/test/<name>`. Cover the success, cancel, error and
   empty paths those suites cover; when the change adds behavior, the change must add the test that
   drives it, and that test must fail without the change.
6. `node $V stop`, then `node $V report`.
7. Review against the goal (below).

## Driving it

- **Host code:** `node src/test/<name>Smoke.js` after `doctor` (they read `out/`). Each prints
  `… passed` or `…: ok` and exits non-zero on the first failed assertion.
- **Webviews:** `npm run test:ui`, or one test: `PLAYWRIGHT_CHROMIUM_PATH=<chromium> node src/test/<name>.js`
  after `doctor`. Screenshots go to `ui-snapshots/`; open the ones the change affects and look at them.
  Tests wait with `waitForFunction` and locators, never fixed sleeps; do the same in new tests.
- **Proving a test can fail:** edit the compiled file in `out/` (or the page in `resources/`) to undo the
  change, run the test, see it fail, restore the file (`node $V doctor` recompiles from source).
- **Live VS Code** (a person): `node $V check package`, then `code --install-extension <vsix>` and Reload Window.
  Needed for anything a scripted `vscode` cannot show: real `CustomTextEditor` undo, Copilot replies, menus.

## Review against the goal

Build one table. Rows are each required check that applies, each acceptance criterion of the change, then
each `[confirmed: …]` entry in the affected feature files. For each row, cite the capture that proves it.

| Goal | Source | Evidence | Verdict |
| ---- | ------ | -------- | ------- |
| The commit dialog lists only the selected files | confirmed: user, 2026-11-05 | `.verify/<run>/ui.out` — "UI snapshots written" | met |

Verdicts: `met`, `not met`, `not run` (with the blocker), `conflicts with observed` (reported, neither pass
nor fail), `touches suspected bug` (name it). The change is verified only when every row is `met` — a
required check that is `not run` leaves it unverified, however much else passed. A row proved only in a
scripted `vscode` says so; a live VS Code check that was not done is `not run (needs VS Code)`.
Name any path that cannot be reached, what blocks it, and the closest path that was covered.

## Feature map

`references/features/README.md` is the index, the owned paths, the baseline preconditions and the
full-sweep order.
