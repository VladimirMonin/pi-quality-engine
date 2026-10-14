---
applyTo: "**"
name: "DOCS.CommitMessages"
description: "Use when grouping changes, preparing Git commits, choosing messages or checking a completed slice."
---

# DOCS — Commit messages

Use `<prefix>: <English description>`, followed by a blank line and concise bullets
when the change needs explanation. Prefixes: `feat`, `bugfix`, `fix`, `docs`,
`style`, `refactor`, `test`, `chore`. Group by completed behavior, not by file.

Before committing:
1. Inspect `git status` and the exact staged diff; stage explicit slice paths only.
2. Run static checks and affected tests; run build/package/host checks when that
   boundary changes. Documentation-only work checks links and instruction routing.
3. Confirm no credentials, personal data, logs, generated verification output,
   `node_modules`, build output or `donors` are staged.
4. Record honest limitations. A source slice is not an accepted checkpoint/tag.

Use the actual commands documented in README and BUILD.toolchain. Never invent a
passed gate or rely on hooks. No WIP disguised as completed work. Specific scoped
lint suppressions require a reason; blanket type suppression and `any` are not fixes.

The user authorized initial local commits. Commit each completed verified slice without
asking again. Do not amend, revert, reset, discard files or rewrite history without explicit
permission. Push/publish remains a separate explicit authorization. Accepted version tags
follow Document 08, not routine commit creation.

Adapted from WVM DOCS.commit_messages; English and the Node toolchain replace
WVM-specific Russian subjects and Python checks.
