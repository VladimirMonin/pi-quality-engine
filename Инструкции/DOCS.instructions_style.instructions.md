---
applyTo: "Инструкции/*.instructions.md"
name: "DOCS.InstructionsStyle"
description: "Use when authoring, splitting, renaming, auditing or updating project instructions and the AGENTS router."
---

# DOCS — Instruction maintenance

Use `PREFIX.topic.instructions.md`, with YAML frontmatter `applyTo`, `name`, and
`description`; name is `PREFIX.Topic`. Description says when to load the file,
not merely what it summarizes. Write in English. One responsibility per file.

Keep instructions concise. 600 physical lines is a ceiling, not a target.
Use relevant prefixes such as CORE, BUILD, TEST, DOCS, APP, INFRA, DATA or WORKFLOW.
Link to exact canonical contracts rather than copying large specifications.
Distinguish active commands and implemented owners from proposed design.
Do not claim missing capabilities exist or create instruction files for speculative modules.

Before an authorized update, inspect current code, paths and existing instructions.
Check scope, terminology, relative links, line count and duplicated authority.
Add/remove the corresponding AGENTS.md routing row in the same logical change.
No release history, postmortem or generic advice in subsystem instructions.

Read-only instruction review does not permit editing. If drift is found outside
an explicit maintenance request, report it and propose the specific correction.

For persistent/live state rules, name the protected source of truth, first write,
preflight, disposable-fixture isolation, bounded retention and restore evidence.
Never test against operator credentials, configuration, data or live journals.

Adapted from WVM DOCS.instructions_style; the root Инструкции directory is the
explicit project location and replaces the donor's .github/instructions path.
