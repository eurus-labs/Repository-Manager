---
name: verify-repository-manager
description: Verify behavior of the Repository Manager VS Code extension after a change or for a regression sweep — compile fresh, run its checks (compile, lint, the Node suites, the Playwright UI tests, VSIX packaging, commit identity), drive the affected feature areas, capture evidence, and review it against the goal. Use after implementing or fixing anything in this repository, and before pushing.
---

# Verify Repository Manager

This skill is kept in one place, `.github/skills/verify-repository-manager/`, which GitHub Copilot
reads. This file lets Claude Code find it.

Read `.github/skills/verify-repository-manager/SKILL.md` and follow it exactly. Its CLI is
`.github/skills/verify-repository-manager/scripts/verify` and its feature map is
`.github/skills/verify-repository-manager/references/features/`.
