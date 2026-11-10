# Agent

The Agent view: tasks with a goal and criteria, a plan of steps the person approves, each step run
with limited tools and checked by the repository's scripts.

## Sub-features
- tasks: create, plan, approve plan, run step, accept / retry / skip / stop.
- router: Copilot through a JSON tool protocol, with one repair turn.
- tools: read, list, search, edit, create, run_check, limited to the step's paths.
- checks: repository scripts approved once per repository.

## How to get to it (user POV)
- Activity Bar → Studio → Tasks → New task (the container was named Agent before 2.20.0).

## Driving it
- Node: `$V capture agent -- node src/test/agentHarnessSmoke.js`.
- Live: VS Code with Copilot only.

## Expected behavior
- A reply that is not the protocol is asked again once. [confirmed: test src/test/agentHarnessSmoke.js]
- A conversation too big for the model is refused before sending. [confirmed: test src/test/agentHarnessSmoke.js]
- A link inside an allowed folder that leads to `.git` or to a file the step may not change is refused. [confirmed: test src/test/agentHarnessSmoke.js]
- A step that changed code without running a check cannot be plainly accepted; Accept as unverified asks first; a documentation-only step is accepted. [confirmed: spec CHANGELOG.md 2.19.0]
- Each step runs only after a person approves it. [confirmed: spec docs/agent-harness.md]

## Suspected bugs
- None found.

## Open questions
- docs/agent-studio.md plans to replace the Agent view with Studio steps (phase 4); until then both exist.

## Gotchas
- Tasks and run logs live in the extension's workspace storage, not in the repository.
