---
applyTo: "test/**,scripts/**"
name: "TEST.Testing"
description: "Use when writing behavior tests, designing Pi/package probes, running acceptance or planning model experiments."
---

# TEST — Behavioral evidence

Read Documents 04, 06, 08 and 09 for the affected claim. Write one failing behavior
test first, observe its failure, implement the minimal real path, then rerun it.
The oracle comes from the product contract, not the current implementation.

Use node:test and strict assertions against compiled production code. Temporary
files, controlled clocks/promises and scripted provider I/O are appropriate real
boundaries. No fake replacement engine, fake AgentSession, production test flag,
fixture-name detection or canned success from a missing capability.

Run the smallest affected tests during development, then the relevant static,
build and regression checks before commit. No coverage target or repeated unchanged
checks for their own sake. Include a meaningful negative control for absence/safety
claims: inject a harmless sentinel for privacy and actionable work for Stop.

Keep claims separate:
- Source inspection proves what the pinned source declares.
- Actual Pi loading/tools/lifecycle prove host integration.
- Packed installation proves packaging outside the source tree.
- Synthetic history plus a live assessor proves bounded semantic judgment.
- Bounded live closed-loop work is needed to claim practical improvement.

Ordinary tests run offline without billable credentials. Never silently replay a
stored answer on a failed live route. Paid experiments require explicit approval,
exact route, inputs, request/spend/time limits and actual termination conditions.
Do not activate donor plugins to supply a missing core capability.

Use isolated Pi settings and projects, an environment allowlist and fixture-specific
output directories. Do not inherit personal skills, providers, extensions or user data.
Bound waits and cleanup; no unowned background processes. Report discovered/executed,
passed/failed/skipped/TODO tests and limitations, not just a green process exit.

Accepted checkpoints/tags require all named cases for one exact commit/artifact,
not a sum of earlier green runs. Store generated evidence under ignored verification/;
small sanitized factual summaries may be deliberate documentation deliverables.
