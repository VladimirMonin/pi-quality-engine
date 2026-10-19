---
applyTo: "src/**/*.ts"
name: "CORE.Architecture"
description: "Use when placing modules, defining dependencies, composing session ownership, activating resources or adapting donor mechanisms."
---

# CORE — Architecture and ownership

Read Documents 01, 02 and the affected Document 05 sections. C1 has exactly eight
roles: observation, trigger, context, prompt, evaluator, policy, action, sink.
Roles are boundaries, not mandatory classes or folders. Create only exercised modules.

- `src/index.ts` is the Pi entry/composition root. Module import does not start work.
- `src/contracts.ts` contains inert public declarations, not host instances or files.
- `src/configuration.ts` owns cold resolution; `src/runtime.ts` owns observed
  generations, shared check admission/runs, operator control and read-only status.
  `src/registry.ts` owns acknowledged contributions; `src/observation.ts` and
  `src/scheduling.ts` own attributable views and initial observable C1 eligibility.
  `src/checkpoint.ts` owns bounded protected control, request-intent and ledger
  persistence independently of diagnostics. `src/context.ts` owns canonical
  assembly, coverage and actual-byte budgets; `src/evidence.ts` owns original
  acquisition/custody and `src/git-evidence.ts` read-only episode-relative Git.
  `src/models.ts` owns common model preflight, attempts and accounting;
  `src/adapters/pi-models.ts` supplies the pinned public SDK boundary and fresh
  reviewer host. `src/builtins/pi-reviewer.ts` owns the bounded reviewer execution
  contract, tool/result authority and once-owned lifecycle; the ordinary
  `core.pi-session` evaluator uses the run-bound review service in `src/runtime.ts`.
  Carry the exact admitted turn's output cap and selected profile reasoning through
  the composition root/public SDK boundary; never fall back to ambient primary/SDK
  defaults. Supported OpenAI-compatible sampling is bounded on request-local copies,
  preserving smaller limits and the unchanged model catalog.
  `src/feedback.ts` owns bounded issue/effect state, receipt reconciliation and
  note rendering; `src/builtins/actions.ts` uses the ordinary admitted action path.
  `src/adapters/pi-feedback.ts` is the narrow current-generation Pi boundary courier,
  composed in `src/index.ts`, not another scheduler. `src/diagnostics.ts` projects
  bounded history, and `src/journal.ts` owns the bounded append-oriented session
  journal. `src/builtins/` uses the same path.
- The accepted S1 foundation is the explicitly enabled observation-only deterministic
  loop with bounded lifecycle/admission, protected Stop/authorization control and
  initial metadata journal rotation/retention; `/quality stop` is an operator action.
  Count, periodic, inactivity/no-progress, known-wait, history-evidence and actionable
  completion causes use the common path. Public `core.evidence-change` supports
  only `core.history`; unsupported scopes are rejected before dispatch.
  K04 adds original source/Git evidence, approved direct chat/classifier assessment
  and protected owned accounting through that same path. Validate represented input
  capabilities on the selected actual model in common preflight before attempt,
  reservation, durable intent or transport. No ambient-route fallback is allowed.
  Clean Pi-session review uses that same managed admission/accounting path with
  explicit isolated resources, granted reads, owner-issued evidence and observed
  selections. Reviewer aggregates do not add another charge. Tool admission,
  denied terminal events, executed failures and acquired evidence keep their
  actual operation identity and disposition. K06 adds opt-in `core.engineering`
  proposals and `core.feedback`: scope, Stop/abort, approved registration/effects,
  material dependencies, actual final text bytes and reserved episode limits are
  checked by runtime-owned facets and again at queue adoption. Natural-idle wake
  requires both grants and current supported work. Context preparation is not
  provider inclusion; native receipts stay at their evidenced strength. Bounded
  protected intent/tombstones preserve unknown effects rather than evicting them.
  Expert `core.request-check` uses ordinary child-check admission with protected
  functional recovery and preserved uncertainty. Capture/export and later bindings
  stay unavailable. Scripted support is not live quality/billing,
  observed installed K06 feedback or universal platform/TUI/RPC/ACL/power-loss
  certification. Read the current [qualified checkpoint scope](../docs/08-development-checkpoints-and-release-checklists.md#k08).
- Configuration validates before activation; cold invalid configuration remains inactive.
- The runtime owns each observed session generation, admission and effect authority.
- Trigger/policy decisions do not perform direct host effects, network calls or hidden timers.
- Concrete Pi/filesystem/model adapters implement real external boundaries. Inspect the
  pinned host types instead of guessing APIs or importing donor private internals.
- All eight contribution roles use current-owner validation, acknowledged readiness
  and generation-bound disposal. Supported observation labels do not create another
  scheduler or billing scope; reviewer-origin work never advances primary cadence.
- Built-ins use the same admitted path as contributions; do not hardcode privileged shortcuts.
  Bind check-owned criteria and all selected assessment resources before measurement;
  dispatch that exact normalized object without post-admission enlargement. Literal
  builtin URI/revision metadata requires the owning shipped-artifact validation,
  not prefix trust. See C1 §§9–11 and O1 §§4–6.
- No global current runtime, second scheduler, DI framework or compatibility fallback without
  an actual supported requirement. Old callbacks cannot acquire new-generation authority.
- Revoke admission first on retirement; dispose owned resources idempotently. Retain
  physically unsettled capacity and storage ownership until actual settlement; a
  bounded logical close timeout does not authorize a replacement writer. Generation
  issuance cannot depend on a reusable PID. Logical cancellation is not proof of
  physical termination or absence of a late charge.
- Functional accounting/control cannot depend on diagnostic storage or its availability.

Acquire only needed references in ignored `donors/`. Freeze exact documented commits,
verify HEAD and cleanliness, inspect license and selected code before adaptation.
A failed pin is blocked, not permission to use main. Track copied code/prompts and notices;
source-inspired original code and shipped third-party code are distinct reuse modes.
Do not enable donor plugins or change the adjacent operator Pi assembly.
