# Usage

The local usage log (commits from the dialog, Align runs, applied review fixes) and Show Usage Report.

## Sub-features
- log: one JSON line per finished action, numbers only, on this machine.
- report: Summary and Details in a Markdown document; Clear Usage Data.

## How to get to it (user POV)
- Command Palette → Repository Manager: Show Usage Report / Clear Usage Data; setting `repositoryManager.usage.enabled`.

## Driving it
- Node: `$V capture usage -- node src/test/usageLogSmoke.js`; commit and Align recording in `commitHandlerSmoke.js`.

## Expected behavior
- No paths, messages or code are recorded; the log stays on the machine. [confirmed: spec docs/usage-metrics.md]
- A comparison waits for 20 commits on each side; dialogs open over 10 minutes are counted but not timed. [confirmed: test src/test/usageLogSmoke.js]
- A log that cannot be written never stops the action it records. [confirmed: test src/test/usageLogSmoke.js]
- Turned off, nothing is recorded. [confirmed: test src/test/usageLogSmoke.js]

## Suspected bugs
- None found.

## Open questions
- None.

## Gotchas
- The log lives in the extension's global storage, not in the repository.
