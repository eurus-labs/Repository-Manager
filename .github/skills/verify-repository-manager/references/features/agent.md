# Agent

The agent harness under the Studio's code steps: the Copilot router, the step tools limited to a
step's paths, and the repository's scripts as checks, approved per repository. Its own view, tasks
and task pages were removed in 3.0.0; earlier tasks become Studio chats on start.

## Sub-features
- runner: the task loop (plan, steps, accept / retry), kept for its tests; no UI drives it now.
- move: earlier tasks become Studio chats (see studio.md).
- router: Copilot through a JSON tool protocol, with one repair turn.
- tools: read, list, search, edit, create, run_check, limited to the step's paths.
- checks: repository scripts approved once per repository.

## How to get to it (user POV)
- No view of its own: a Studio plan's code step uses it (Studio → Chat, in the Secondary Side Bar).

## Driving it
- Node: `$V capture agent -- node src/test/agentHarnessSmoke.js`; the move: `agentMigrationSmoke.js`.
- Live: VS Code with Copilot only.

## Expected behavior
- A reply that is not the protocol is asked again once. [confirmed: test src/test/agentHarnessSmoke.js]
- A conversation too big for the model is refused before sending. [confirmed: test src/test/agentHarnessSmoke.js]
- A link inside an allowed folder that leads to `.git` or to a file the step may not change is refused. [confirmed: test src/test/agentHarnessSmoke.js]
- A step that changed code without running a check cannot be plainly accepted; Accept as unverified asks first; a documentation-only step is accepted. [confirmed: spec CHANGELOG.md 2.19.0]
- Each step runs only after a person approves it. [confirmed: spec docs/agent-harness.md]
- The Agent view is removed; earlier tasks become Studio chats on start, nothing deleted. [confirmed: user, 2026-11-12]

## Suspected bugs
- None found.

## Open questions
- None.

## Gotchas
- Tasks and run logs live in the extension's workspace storage, not in the repository.
