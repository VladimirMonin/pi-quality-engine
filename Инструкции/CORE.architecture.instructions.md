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
  `src/scheduling.ts` own attributable views and count/periodic eligibility.
  `src/context.ts` owns canonical assembly, coverage and actual-byte budgets;
  `src/diagnostics.ts` projects bounded history, and `src/journal.ts` owns the
  bounded append-oriented session journal. `src/builtins/` uses the same path.
- The implemented subset is the explicitly enabled observation-only deterministic
  loop; `/quality stop` is an operator action. Model dispatch, feedback/actions,
  durable control checkpoints, rotation/retention and later component bindings
  remain unavailable. A working journal is not full lifecycle/recovery acceptance.
- Configuration validates before activation; cold invalid configuration remains inactive.
- The runtime owns each observed session generation, admission and effect authority.
- Trigger/policy decisions do not perform direct host effects, network calls or hidden timers.
- Concrete Pi/filesystem/model adapters implement real external boundaries. Inspect the
  pinned host types instead of guessing APIs or importing donor private internals.
- Built-ins use the same admitted path as contributions; do not hardcode privileged shortcuts.
  Bind check-owned criteria and all selected assessment resources before measurement;
  dispatch that exact normalized object without post-admission enlargement. Literal
  builtin URI/revision metadata requires the owning shipped-artifact validation,
  not prefix trust. See C1 §§9–11 and O1 §§4–6.
- No global current runtime, second scheduler, DI framework or compatibility fallback without
  an actual supported requirement. Old callbacks cannot acquire new-generation authority.
- Revoke admission first on retirement; dispose owned resources idempotently. Logical
  cancellation is not proof of physical termination or absence of a late charge.
- Functional accounting/control cannot depend on diagnostic storage or its availability.

Acquire only needed references in ignored `donors/`. Freeze exact documented commits,
verify HEAD and cleanliness, inspect license and selected code before adaptation.
A failed pin is blocked, not permission to use main. Track copied code/prompts and notices;
source-inspired original code and shipped third-party code are distinct reuse modes.
Do not enable donor plugins or change the adjacent operator Pi assembly.
