# Plan 5 — Undo restores a text file a script deleted

Status: approved
Date: 2026-11-18
Branch: `fix/studio-restore-script-deleted-files`
Baseline: `main` at `bfd830d801f32b90ab363baa141692586910442e`
Target: `src/agent/scriptEffects.ts`, `src/agent/types.ts`, `src/agent/agentTools.ts`, `src/agent/writeJournal.ts`, `src/studio/codeStep.ts`, `src/test/studioCodeStepSmoke.js`, `CHANGELOG.md`, `package.json`

## Goal

Issue #169. When an approved check script deletes a file whose content just before the script is known as
text — a clean tracked file (its content is in `HEAD` as checked out) or a file that was already changed (the
pre-script snapshot holds its text) — the review shows the deletion as one of the step's changes, and Retry
and Stop put the file back as it was before the step, with identical bytes (CRLF checkouts included). Today
`diffSince` (`src/agent/scriptEffects.ts`) reports every deletion as `unrecoverable: 'deleted'` ("cannot be
undone here"), although that content is known. The same `StepWorkspace` serves the Agent and Studio code
steps, so both gain it.

## Decisions

1. **Every deletion whose prior state is text** (the user's choice, 2026-11-18, wider than the issue): the
   state before the script is the snapshot's entry for a dirty path (`snapshotTree` reads every dirty path)
   or `HEAD`'s for a clean one (`headState`); when it is `kind: 'text'`, the deletion becomes a change. So a
   clean file, a file the person had changed and not committed, and a file this step had already edited all
   come back; for the last, `record` keeps the step's first `before`, so undo restores the content from
   before the step. Binary, large or linked files (`kind: 'opaque'`) stay "cannot be undone" — rejected: only
   clean files (the issue's scope), because a person's uncommitted edits are the content Git cannot give back,
   and a file the step edited would not come back although its content is known.
2. **A deletion is a `FileChange` with `after: null`**, symmetric with `before: null` for a created file;
   `ScriptEffects.changes` and `JournalEntry` take `after: string | null` — rejected: a separate list of
   deletions, because review, undo, journal and recovery would each need a second path.
3. **Undo writes the content back only when the path is still absent**: `revertChanges` restores a
   `after: null` change only if `lstat` finds nothing there (not a file, folder or link) and the editor has
   no unsaved document for it; it creates missing parent folders (inside the repository, through no link,
   checked with `plainPath` as today); otherwise it keeps the path and returns it in `kept` as today —
   rejected: overwriting whatever is there now, because the person may have recreated it.
4. **Recovery after a closed window (#140) treats `null` like any state**: `recoverJournal` accepts
   `after: null` entries; a chain whose current state is "absent" and in the chain restores the first state,
   creating parent folders under the same checks — so a step cut short after a script deleted a clean file
   gets it back on the next start.
5. **Review shows it**: `codePreview` prints `### <path> (deleted by a script)` with the removed lines
   (`lineDiff(before, '')`), and the file is no longer listed under "cannot be undone"; the script note for it
   says `deleted by a script outside the paths this step may change (undone with the step)` when outside the
   step's paths, as for other undoable script changes.
6. **Version 3.6.1** (a fix; the interaction is unchanged), CHANGELOG `### Fixed` under its own heading,
   whether or not 3.6.0 has been released by then.

## Scope

In:

- `src/agent/scriptEffects.ts` `diffSince`: Decision 1.
- `src/agent/types.ts` `FileChange.after: string | null`; `src/agent/agentTools.ts` `record`, `revertChanges`
  (Decisions 2, 3); `src/agent/writeJournal.ts` `JournalEntry`, `recoverJournal` (Decision 4);
  `src/studio/codeStep.ts` `codePreview` (Decision 5). Any other compile error from the type change is fixed
  in place, keeping behaviour for non-null `after`.
- Tests in `src/test/studioCodeStepSmoke.js` (and `src/test/studioRecoverySmoke.js` for Decision 4).
- `CHANGELOG.md`, `package.json` (`npm version 3.6.1 --no-git-tag-version`).

Out:

- Binary, large (over `MAX_TRACKED_BYTES`) or linked files a script deletes.
- Files Git ignores (never in the snapshot or `HEAD`).
- Renames: a script that moves a clean file shows a deletion (restored) and a new file (removed on undo).
- The Agent's own review page and any UI text other than `codePreview`.

## Baseline

| Existing | Keep, change, or remove |
| --- | --- |
| `src/agent/scriptEffects.ts` `snapshotTree` (every dirty path, text kept up to `MAX_TRACKED_BYTES`), `headState` (`git cat-file --filters HEAD:<path>`), `diffSince` (`now.kind === 'absent'` → unrecoverable) | Change `diffSince` only |
| `src/agent/types.ts` `FileChange { before: string \| null; after: string }` | Change `after` |
| `src/agent/agentTools.ts` `tracked` (records script changes, journals them), `record`, `revertChanges`, `plainPath` | Change `revertChanges`; keep `plainPath` |
| `src/agent/writeJournal.ts` `JournalEntry`, `recoverJournal` (skips entries whose `after` is not a string), `plainTarget`, `writeAtomically` | Change parse and restore |
| `src/studio/codeStep.ts` `codePreview` (`lineDiff(before ?? '', after)`) | Change |
| `src/test/studioCodeStepSmoke.js` ~line 200–245 (script effects through a code step: `del.txt` "cannot be undone", "a deleted file is reported, not restored"), ~line 248–296 (CRLF, link cases) | Change the `del.txt` expectations; add cases |
| `src/test/studioRecoverySmoke.js` | Add the recovery case |

## Tech stack and constraints

Default (`AGENTS.md`).

## Acceptance criteria

- [ ] A script deletes a clean tracked file inside the step's paths: the review lists `### <path> (deleted by a script)`, not "cannot be undone"; Stop and Retry restore identical bytes — `node src/test/studioCodeStepSmoke.js` (update the existing `del.txt` block for both decisions).
- [ ] CRLF: a clean file checked out with `eol=crlf` deleted by a script is restored with `\r\n` bytes — same test (extend the CRLF fixture block).
- [ ] Outside the step's paths: the deletion is still restored, and its note says it is undone with the step — same test.
- [ ] A missing parent folder (the script removed the whole folder) is recreated on undo — same test.
- [ ] Failure case: the path holds a new file, a folder or a link at undo time → nothing is written, the path is in `kept` — same test.
- [ ] A file the person had changed and not committed, deleted by a script: restored with the person's content, not `HEAD`'s — same test.
- [ ] A file the step edited with `edit_file`, then deleted by a script: undo restores the content from before the step — same test.
- [ ] An untracked text file (not ignored) the person had, deleted by a script: restored — same test.
- [ ] Failure case: a binary clean file deleted by a script stays "cannot be undone" — same test.
- [ ] Recovery: a journal holding a script deletion of a clean file restores it on the next start; a path recreated since is kept — `node src/test/studioRecoverySmoke.js`.
- [ ] Failure-first: before the `diffSince` change, the new "restored" assertion fails (report the message); with `revertChanges` ignoring `after: null`, it fails too.
- [ ] Required checks pass — `npm ci`, `npm run lint` (0 errors; 2 known warnings), `npm test`, `PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1243/chrome-linux64/chrome npm run test:ui`, `npm run package`.

## Risks

| Risk | How it is handled |
| --- | --- |
| A consumer of `FileChange.after` assumes a string and breaks on `null` | TypeScript makes every use a compile error to fix; tests cover review, undo and recovery |
| Undo overwrites something the person created at the path since | Decision 3: write only when absent; failure-case test |
| Restoring a person's file from a stale snapshot (they edited it between snapshot and script) | The snapshot is taken right before each script run, and the person's editor writes during a run are rare; a dirty editor buffer for the path keeps it (Decision 3) |
| Recreating parent folders writes through a link | `plainPath` / `plainTarget` checks before any `mkdir`; existing link tests keep passing |
| Old journals or saved Agent tasks without `null` | Unchanged entries parse as before; `null` is new and only read by the new code |
| Line-ending drift on restore | `headState` already gives the bytes as checked out; CRLF test |

## Open questions

None.
