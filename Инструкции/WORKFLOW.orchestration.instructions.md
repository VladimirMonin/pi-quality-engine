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
- **Pi implementer — Sol:** native Pi, `openai-codex/gpt-6.1-sol`,
  thinking `max`. The same saved implementer owns code/tests and author evidence;
  it does not commit or maintain release-owned project instructions.
- **Pi final independent accepting owner — Astra:** native Pi,
  `openai-codex/gpt-6-astra`, thinking `xhigh`. Inspect the actual frozen candidate
  and required evidence; issue a candidate-bound acceptance/rejection and release.
  A bounded oracle consultation uses Astra/xhigh under a separate explicit
  read-only assignment; it is not acceptance or runtime ownership.
- **Pi checker/control/docs/local-release owner — Sol:** native Pi,
  `openai-codex/gpt-6.1-sol`, thinking `medium`. Consolidate canonical evidence and,
  only after actual independent acceptance/release, qualify committed/EOL/artifact
  agreement and own authorized local English commits/tags and necessary separate
  instruction synchronization under
  [DOCS.commit_messages](DOCS.commit_messages.instructions.md) and
  [DOCS.instructions_style](DOCS.instructions_style.instructions.md).
  Control/readback is not a second accepting-owner verdict or implementation lane.
- Ordinary reproducible defects return to the same implementer. A serious unresolved
  architectural dilemma receives the original references, concrete alternatives
  and actual failing evidence; consultation does not replace the final gate.

The latest direct operator assignment overrides these defaults. Preserve exact
saved role/session identities; never substitute a retired historical implementer
or retroactively relabel an earlier run's actual model/thinking level.

These roles do not themselves authorize new workers or internal readers. When
explicitly authorized, each Pi worker owns its internal children and completion;
Hermes does not manage those children. Keep one production writer per slice; independent
review is read-only. Do not replace the specified native Pi route with an external
CLI or another model without an explicit decision.

## Bounded delivery and repair

1. Assign one coherent medium behavior or repair slice with its owning contracts,
   actual starting state, protected boundaries, required evidence and stop condition.
   Do not assign the entire roadmap or demand later checkpoint features.
2. Preserve saved Pi session identities by default. A rejected slice resumes the
   **same implementer session** with exact failed boundaries, reproducers, expected
   results and owned repair paths; do not start a competing implementation.
   If a bounded attempt at supported recovery establishes that continuation is
   unusable, the operator-authorized exception permits a fresh native Pi session
   with the same provider, model, role and thinking level. Preserve the old history
   in place, uncommitted work, current handoff and results; verify the prior host's
   actual terminal status and absence of its writer before replacement. Keep any
   abnormal exit explicit, not relabeled as success. The successor first compares
   the transfer baseline with current files, inherits the same worktree, scope,
   access/spending limits and Stop protections, and continues rather than restarting
   the project. Do not edit old history or use this exception to bypass restrictions.
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
   the exact tested candidate/artifact. Working-source acceptance alone does not
   establish committed/EOL/package identity. Do not count skipped or missing gates as passed.
7. Commit accepted implementation as a logical slice with explicit staged paths.
   Keep authorized instruction maintenance separate from the tested candidate;
   do not move an accepted tag onto later documentation changes. Record only
   evidenced checkboxes, truthful limits and the next medium slice.

Local acceptance commits and required instruction maintenance are authorized.
Remote push, publication, history rewriting, paid product evaluations and changes
to personal configuration or adjacent projects remain outside that authority.
