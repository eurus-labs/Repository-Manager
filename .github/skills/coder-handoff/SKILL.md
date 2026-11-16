---
name: coder-handoff
description: Split work in this repository between a planning session and a coding session (for example Opus plans, Sonnet codes). Use when the user asks to hand implementation to another model or session, or when you are the coding session and received a plan. The coder implements a written plan and never opens or merges a pull request.
---

# Coder Handoff

Three roles. Each owns its decisions; none takes another's.

| Role | Who | Owns | Never |
| ---- | --- | ---- | ----- |
| User | the person | problem framing, product decisions, scope, merge | — |
| Planner | the planning session (e.g. Opus) | the plan, the brief, review of the coder's diff, pushing, the PR, triage of review bots, reports to the user | merges without the user's ask; trusts a summary without reading the diff |
| Coder | the coding session (e.g. Sonnet) | implementation, tests, local checks, local commits | creates a PR, merges, pushes, replies on GitHub, changes scope or makes a product decision |

The planner writes the plan with `design-solution` and the coder works with `implement`, both from the
`development` plugin of [eurus-labs/Skills](https://github.com/eurus-labs/Skills); this file adds the
handoff rules they do not cover. Where they differ, this file and AGENTS.md win.

## Planner: write the plan

Write one plan per branch, in the brief itself (the PR description later carries it as the record).
A plan the coder cannot act on without guessing is not finished.

```
Goal:            one sentence, the user-visible outcome
Issue / context: links, files to read first, decisions already made by the user
Branch:          <type>/<area>-<outcome> from the latest origin/main (AGENTS.md)
Steps:           numbered, each naming the files and the behavior
Tests:           the test that must fail without the change, and where it is listed
Out of scope:    what not to touch, and known gaps to leave as they are
Stop and ask if: the decisions the coder must bring back instead of taking
Report:          commit SHAs, root cause, what changed, checks observed, what is unverified
```

Always include: the commit identity from AGENTS.md as environment variables on every commit
command, no AI trailers or footers, `npm ci` before the checks, and
`PLAYWRIGHT_CHROMIUM_PATH` for the UI tests when Chromium is not where Playwright looks.

## Coder: implement the plan

1. Read AGENTS.md, the plan, and every file the plan names. Do not restart discovery for decisions
   the plan records.
2. Work on the plan's branch. Implement the steps in order; keep the change to what they ask.
3. Write the test first or prove it fails without the change (undo the change in `out/`, run it, restore).
4. Run the checks of `.github/skills/verify-repository-manager/SKILL.md`: compile, lint, `npm test`,
   `npm run test:ui`, `npm run package`. Report each as observed, never assumed.
5. Commit locally with the identity from AGENTS.md. Do not push, open a PR, merge or comment on GitHub.
6. Stop and report when a step is ambiguous, contradicts the code, or needs a product decision:
   the options, what each costs, and a recommendation. Do not pick one silently.
7. Report in the plan's format. Name what you did not verify and any flaky test with its evidence.

## Planner: after the coder reports

1. Read the diff and the new tests yourself; look for paths the tests miss.
2. Re-run anything the report claims that conflicts with what you know (for example a flaky test
   when CI on `main` is green).
3. Push the branch and open the PR (PR description: requirements, decisions, observed results).
4. For review-bot findings: verify each against the code, then send the real ones back to the coder as
   a follow-up plan. Reply on threads yourself; a reply that cannot be posted without a tool footer is
   deleted and the thread only resolved (AGENTS.md).
5. Report to the user: what changed, evidence, gaps found, and the decisions that are theirs.
   Merge only when the user asks.
