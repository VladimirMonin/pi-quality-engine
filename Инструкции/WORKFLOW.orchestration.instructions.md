---
applyTo: "**"
name: "WORKFLOW.Orchestration"
description: "Use when assigning medium Pi slices, reviewing acceptance, resuming repairs, escalating architectural blockers or reporting orchestration state."
---

# WORKFLOW — Medium slices and acceptance ownership

This is the operator-authorized development workflow, not a product runtime
controller. Canonical authority remains subject-based under
[AGENTS.md](../AGENTS.md#canonical-documentation-and-authority); checkpoint gates
remain in [Document 08](../docs/08-development-checkpoints-and-release-checklists.md).

## Roles and routes

- **Hermes is a thin upper-level orchestrator.** It assigns coherent medium
  slices, relays bounded handoffs and receives verified outcomes. It does not
  read source, implement, review code or commit.
- **Pi implementer:** native Pi, `ollama-cloud/deepseek-v4.1-flash`, thinking
  `max`. One implementer owns the slice's code and tests. It does not commit or
  maintain acceptance-owned project instructions.
- **Pi acceptance owner:** native Pi, `openai-codex/gpt-6.1-sol`, thinking
  `xhigh`. Independently inspect actual bytes, SDK declarations and Git state;
  run proportionate required checks; own local English commits and necessary
  instruction synchronization under
  [DOCS.commit_messages](DOCS.commit_messages.instructions.md) and
  [DOCS.instructions_style](DOCS.instructions_style.instructions.md).
- **Pi oracle:** `openai-codex/gpt-6-astra`, thinking `xhigh`, for serious
  unresolved blockers or architectural dilemmas. Supply original architectural
  references, concrete doubts, alternatives and actual failing evidence. An
  ordinary reproducible implementation defect goes back to the implementer,
  not to an oracle by default.

Each Pi worker owns its internal subagents and their completion. Hermes does not
track or manage those children. Keep one production writer per slice; independent
review is read-only. Do not replace the specified native Pi route with an external
CLI or another model without an explicit decision.

## Bounded delivery and repair

1. Assign one coherent medium behavior or repair slice with its owning contracts,
   actual starting state, protected boundaries, required evidence and stop condition.
   Do not assign the entire roadmap or demand later checkpoint features.
2. Preserve saved Pi session identities. A rejected slice resumes the **same
   implementer session** with exact failed boundaries, reproducers, expected
   results and owned repair paths; do not start a competing implementation.
3. Continue through recoverable refusal or failure using the same session and
   established context. Real permission, access, credential or route blockers
   must be explicit; recovery is not permission to bypass a restriction.
4. Distinguish actual activity, legitimate waiting and abandonment. Silence or a
   timer alone never authorizes automatic killing, replacement or restarting.
   Inspect concrete state and communicate before changing lifecycle ownership.
5. Freeze candidate code, tests and packaged resources during independent review.
   Treat implementer reports as claims. Block genuine required correctness,
   privacy, authority, lifecycle, integration or evidence defects—not preferences,
   speculative future-proofing or optional abstractions.
6. Return `NEEDS_CHANGES` with a concise actionable review, `ORACLE_REQUIRED` with
   a concrete oracle brief, or `ACCEPTED` bound to actual required evidence and
   the exact tested commit/artifact. Do not count skipped or missing gates as passed.
7. Commit accepted implementation as a logical slice with explicit staged paths.
   Keep authorized instruction maintenance separate from the tested candidate;
   do not move an accepted tag onto later documentation changes. Record only
   evidenced checkboxes, truthful limits and the next medium slice.

Local acceptance commits and required instruction maintenance are authorized.
Remote push, publication, history rewriting, paid product evaluations and changes
to personal configuration or adjacent projects remain outside that authority.
