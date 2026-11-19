# Plan 6 — Run a skill's scripts in Studio code steps

Status: implemented
Date: 2026-11-18
Branch: `feat/studio-skill-scripts`
Baseline: `main` at `b850d050129c9c731854a87f0e3967f140a04d5b`
Target: `src/studio/skills.ts`, `src/studio/githubSkills.ts`, new `src/studio/skillScripts.ts`, `src/agent/agentTools.ts`, `src/agent/types.ts`, `src/studio/codeStep.ts`, `src/studio/codeHost.ts`, `src/studio/steps.ts`, `src/studio/runsReport.ts`, `resources/studioChat.js`, `package.json`, tests, `docs/agent-studio.md`, `CHANGELOG.md`

## Goal

Roadmap item 6 in `docs/agent-studio.md`. Today a skill's `scripts/` are never run: the picker and the plan
card say "uses scripts: not run here", and `skillsPrompt` tells the model "Scripts a skill mentions are not
available". A skill whose work is in its scripts (for example `document-codebase`, whose `scripts/pipeline.py`
drives it, or `debug-failing-test` with `scripts/detect_stack.py`) does less than in Claude Code or Copilot.
After this plan, a Studio **code** step whose skills have scripts can run them with a new tool, in a container
when Docker or Podman is available, else directly on the machine; the person approves the scripts with the
step; what a script changes in the repository is reviewed and undone like a check script's (#139, #169).

## Decisions

1. **A tool in code steps** (the user's choice, 2026-11-18): `run_skill_script` is offered to the model in a
   Studio code step only when one of the step's skills has scripts. Input: `skill` (the skill's name as listed
   in the prompt), `script` (a path relative to the skill's folder, as the SKILL.md writes it, e.g.
   `scripts/pipeline.py`; a leading `./` is dropped; `..`, absolute paths and paths not in the skill's script
   list are refused), `args` (array of strings, at most 64, each at most 4,000 characters). The working
   directory is the repository root, as the skills expect ("run every command from the repository") —
   rejected: a new `skill.script` step type the planner places (the model could not choose when or with what
   arguments), and tools in `prompt` steps (they stay toolless).
2. **Approval per script, per run** (the user's choice): the code step's existing approval (its `preview`)
   lists, for each skill with scripts: name, source, pinned short commit, the script files the tool may run,
   and how they run (container image, or "directly on this machine, not isolated: as you, with your files and
   network"). Approving the step approves those scripts for that run; calls are not asked again. Each call's
   exact command (interpreter, script, arguments), runner, exit code and duration are logged and shown in the
   step's Activity (plan 3) and in the review — rejected: a modal per call, and approval remembered across runs.
3. **Container reach** (the user's choice; closes the roadmap's open question): the repository mounted
   read-write at `/work` (the working directory), the skill's cached folder read-only at `/skill`, no network
   (`--network none`), no home folder, no environment variables passed in (only `HOME=/tmp`), a read-only root
   file system with a writable `/tmp`, the person's user and group ids (`--user <uid>:<gid>` on Linux and
   macOS, so created files are not owned by root; omitted on Windows), and limits (`--pids-limit 256`,
   `--memory 1g`) — rejected: read-only repository (scripts that generate files could not work) and network
   on (a script could send repository content out).
4. **Images: official slim images pinned by digest** (the user's choice), by the script's extension, with no
   package installation (standard library only; a missing module fails and the output says which):
   - `.py` → `python:3.12-slim-bookworm@sha256:935c3c5b12357a7e10caa9c1e6ca5692344d97cf229832ef584be2cec9fc03df`, `python3`
   - `.js`, `.mjs`, `.cjs` → `node:22-bookworm-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee`, `node`
   - `.sh` → `debian:bookworm-slim@sha256:734a72b3d6142a71993b4bc580ca01d8ca687f77a2c422d96a961d3376b179bc`, `bash`
   - any other extension is refused with the reason.
   The image is pulled before the first run that needs it, with its own 10-minute limit and an Activity line
   ("Pulling python:3.12-slim…"); a failed pull ends the call with the engine's message — rejected: our own
   image now (it comes with roadmap item 8) and installing `requirements.txt` (needs the network).
5. **Which runner**: a setting `repositoryManager.studio.skillScripts` with `auto` (default: the container
   when `docker version` or else `podman version` answers within 5 s, otherwise direct), `container` (never
   direct: no engine → the call fails saying so), `direct`, `off` (the tool is not offered; the chip says
   scripts are turned off). The choice is made when the step's preview is built and is the one approved; it
   is shown in the preview and logged.
6. **Direct runs**: `execFile` (no shell) of the interpreter (`python3`, falling back to `python` only on
   Windows; `node`; `bash`) with the cached script's absolute path and the arguments, working directory the
   repository root, environment reduced to `PATH`, `HOME`/`USERPROFILE`, `LANG`, `SystemRoot`, `TEMP`/`TMP`;
   a missing interpreter ends the call with "python3 is not installed or not on PATH" — rejected: passing the
   whole environment (credentials in variables).
7. **Script files come from the pinned commit**: `SkillLibrary` downloads every file under `<folder>/scripts/`
   at the skill's commit into its cache folder, with limits (at most 300 files, 2 MB each, 20 MB per skill);
   over a limit, the skill still loads, its scripts are marked unavailable with the reason, and the tool is not
   offered for it. `LoadedSkill` gains `scripts: string[]` (paths relative to the skill folder) and
   `scriptsUnavailable?: string`. A skill cached before this change (no `scripts` field) downloads them on next
   load. The run uses only the cached files, never the network copy.
8. **Limits and Stop**: each call has a 5-minute limit (after the image is pulled) and keeps the last 64 KB of
   combined output; timeout and Stop kill the process, and for a container also remove it (it is started with
   `--name repository-manager-<run>-<n>`, then `rm -f` by name), so no container is left running — rejected:
   killing only the CLI process (the container keeps running).
9. **Changes are tracked**: each call runs inside `StepWorkspace.tracked()`, so files it creates, changes or
   deletes in the repository are the step's changes: reviewed, undone by Retry and Stop, journaled for recovery
   (#139, #140, #169). The tool's result to the model: exit code, duration, the output (cut as above), and the
   files it changed.
10. **The text the person and the model see**:
    - `skillsPrompt`: with the tool offered, the line "Scripts a skill mentions are not available…" becomes
      "Run a skill's scripts with run_skill_script (skill, script path as its SKILL.md writes it, args); they
      run from the repository root"; without it (prompt steps, `off`, unavailable), the old line stays.
    - The skill chip's tooltip and the picker's detail: on a code step, "Uses scripts: run in this step after
      your approval (in a container | directly on this machine)"; on a prompt step, "Uses scripts: this step
      type has no tools, so they are not run here; use a code step"; with `off`, "Uses scripts: turned off in
      settings". The ⚠ sign stays only where the scripts will not run.
    - `activityLine` (`src/studio/runsReport.ts`): `skill-script` → `Ran <script> (<runner>): exit <code>`.
11. **Version 3.7.0**, CHANGELOG `### Added`; `docs/agent-studio.md` item 6 says what shipped and that the
    container's reach is decided (Decision 3).

## Scope

In:

- `src/studio/skills.ts` (`LoadedSkill.scripts`, download and limits, `skillsPrompt` line),
  `src/studio/githubSkills.ts` if the cache path or API needs it.
- New `src/studio/skillScripts.ts` (no `vscode`): runner choice, container and direct command lines, limits,
  kill and remove, interpreter by extension.
- `src/agent/types.ts` (`run_skill_script` tool name), `src/agent/agentTools.ts` (the tool in
  `StepWorkspace`, through `tracked()`), `src/studio/steps.ts` / `src/studio/codeHost.ts` (`CodeServices`
  gains what the tool needs: the runner and the setting), `src/studio/codeStep.ts` (tool offered, preview,
  log entry).
- `src/studio/runsReport.ts` (`activityLine`), `resources/studioChat.js` and the picker detail in
  `src/studio/studioChat.ts` (Decision 10).
- `package.json` (the setting, version 3.7.0), `CHANGELOG.md`, `docs/agent-studio.md`.
- Tests (Acceptance criteria).

Out:

- Tools in `prompt` steps; a `skill.script` step type.
- Installing packages, our own image, network access, a per-script network switch.
- The Agent (dashboard) task runner: the tool is offered only in Studio code steps with skills.
- PowerShell, TypeScript (`.ts`) and other interpreters.
- Remembering an approval across runs.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/studio/skills.ts` `SkillLibrary.fetchSkill` (SKILL.md and up to 5 `references/`), `usesScripts`, `skillsPrompt` | Change |
| `src/agent/agentTools.ts` `StepWorkspace` (`tools()`, `invoke`, `tracked`, `runCheck`), `revertChanges` | Change: add the tool; reuse `tracked` |
| `src/agent/repositoryScripts.ts` `runNpmScript` (timeout, kill on cancel, output) | Keep: the pattern for limits and cancel |
| `src/studio/codeStep.ts` `codeStep.preview`, `run`, `converse` (tool loop, `context.log`) | Change |
| `src/studio/codeHost.ts` `codeServices` | Change: provide the runner |
| `src/studio/runsReport.ts` `activityLine` (plan 3) | Change: one entry type |
| `resources/studioChat.js` `skillChips` (tooltip, ⚠) and the picker detail in `src/studio/studioChat.ts` (`uses scripts: not run here`) | Change |
| eurus-labs/Skills: skills keep their scripts in their own `scripts/` (shared files are copied in, per its CONTRIBUTING.md); scripts are run as `python3 scripts/<name>.py` from the repository | Rely on this layout |
| This machine: Docker 29 can run `--network none` containers from the pinned python image (checked by the planner) | Use for the container tests |

## Tech stack and constraints

Default (`AGENTS.md`). Never use a shell to run a script (`execFile` with an argument array). No new npm
dependency. Container tests run only when an engine answers `version`; otherwise they print that they were
skipped and why (CI's Ubuntu runners have Docker).

## Acceptance criteria

- [ ] A skill's `scripts/` are cached at its pinned commit with the limits; a skill over a limit loads with `scriptsUnavailable` and no tool; an old cached skill gets its scripts on next load — `node src/test/studioSkillsSmoke.js`.
- [ ] Direct run: a fixture skill with `scripts/hello.py` that prints its arguments and writes `out/hello.txt` in the repository → the tool returns exit 0, the output and the changed file; the review lists `out/hello.txt`; Stop removes it — `node src/test/studioCodeStepSmoke.js`.
- [ ] Container run (when an engine answers): the same script runs in the pinned image; the file it wrote is owned by the current user (POSIX); a script that opens a network connection fails; a script that reads a file outside the repository and the skill folder (e.g. the host's home) cannot see it; no container is left after the call (`docker ps -a --filter name=repository-manager-` is empty) — same test, or a new `src/test/studioSkillScriptsSmoke.js` added to the `test` script.
- [ ] Refusals end the call with the reason, nothing run: unknown skill; a script not in the list; `..` or an absolute path; `.ts` extension; setting `off`; `container` with no engine; direct with a missing interpreter (simulated by a PATH without it) — same tests.
- [ ] Limits: a script that sleeps past the limit (shortened in the test) is killed and reported; output over 64 KB keeps the last 64 KB and says it was cut; Stop during a container call removes the container — same tests.
- [ ] Approval: the code step's preview lists the skill, source, short commit, script files and the runner; direct mode includes the "not isolated" sentence — `node src/test/studioCodeStepSmoke.js`.
- [ ] Prompt and UI text: `skillsPrompt` with and without the tool (Decision 10); `activityLine` for `skill-script` (`node src/test/studioRunsSmoke.js`); the chip tooltip on a code step, a prompt step and with `off`, and the ⚠ only where scripts will not run (`npm run test:ui`, `src/test/studioChatUi.js`).
- [ ] Failure-first: each new test run against the unchanged code first, with its failure message reported.
- [ ] Required checks pass — `npm ci`, `npm run lint` (0 errors; 2 known warnings), `npm test`, `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui`, `npm run package`.

## Risks

| Risk | How it is handled |
| --- | --- |
| A script runs that the person did not mean to approve | Decision 2: the preview names every script file and the runner before the step runs; only cached files at the pinned commit run |
| Direct mode reaches everything the person can | Said in the preview; environment reduced (Decision 6); `auto` prefers the container |
| A container keeps running after Stop or a timeout | Decision 8: named container removed; test checks `docker ps -a` |
| Files written by a container are owned by root | Decision 3: `--user uid:gid`; test checks ownership |
| First run is slow while the image is pulled | Separate pull with its own limit and an Activity line (Decision 4) |
| A script needs a package or the network and fails | The output says why; the tool result includes it; installing is out of scope |
| Windows paths and `--user` | `--user` omitted on Windows; paths passed with `-v <host>:<container>` as the engine expects; unverified on Windows (said in the report) |
| The model passes a long or hostile argument | `execFile` with an array (no shell), argument count and size limits (Decision 1) |

## Open questions

None.
