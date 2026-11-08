# Dashboard shell

Activation, the commands VS Code shows, the dashboard tab, the Side Bar view that mirrors it, and
the packaged VSIX.

## Sub-features
- activation: every declared command registered, with or without a folder; a failing part does not take the others down.
- dashboard: one tab per window, opened from the Activity Bar or Ctrl+Shift+G M.
- side-bar-mirror: the Side Bar shows the dashboard's markup and sends clicks back.
- packaging: what `.vscodeignore` ships in the VSIX.

## How to get to it (user POV)
- Activity Bar → Repository Manager; Command Palette → "Repository Manager: …".

## Driving it
- Node: `$V capture activation -- node src/test/activationSmoke.js`, `dashboardOpenSmoke.js`, `sidebarViewSmoke.js`.
- Package: `$V check package`; list the VSIX with `unzip -l <file>.vsix` if `unzip` exists.

## Expected behavior
- With a folder, every command declared in package.json is registered; without one, every command is still registered and the Git ones explain that a folder is needed. [confirmed: test src/test/activationSmoke.js]
- Without a folder, the Requirement Editor and the Workflow Editor are still registered. [confirmed: test src/test/activationSmoke.js]
- A failure in one part (Requirements, Git) is logged and the other parts stay registered. [confirmed: test src/test/activationSmoke.js]
- Webviews are sandboxed: no alert, confirm or prompt; questions come from the host. [confirmed: spec AGENTS.md]

## Suspected bugs
- None found.

## Open questions
- None.

## Gotchas
- After a change to `package.json` contributions, VS Code needs Reload Window before new views or commands exist.
