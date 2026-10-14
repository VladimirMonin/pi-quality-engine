# Pi Quality Engine — Development Contract

This file is the project router. Read all relevant subsystem instructions before
editing; this file does not replace them. Documentation and commits are in English.

## Development philosophy

Build a small standalone modular Pi extension for evidence-based assessment and
bounded feedback. Improve engineering outcomes, not review volume or apparent activity.
Existing project documents remain the requirements; assessment resources do not replace them.

- Simple is better than complicated; complicated is better than tangled. Readability
  matters. Keep complexity controlled and choose the smallest correct solution.
- Prefer one obvious implementation path and ordinary functions with explicit data.
  Use small stateful objects where state actually exists, not a class per diagram box.
- Every layer must protect a current owner, lifecycle, integration or extension boundary.
  Do not add speculative factories, managers, retries, fallback chains or configuration.
- SOLID, DRY and patterns are tools, not goals. Reject architectural ornament.
- Understand → investigate enough → implement → verify → commit → stop.
  Plans and analysis alone are not deliverables. Do not expand local fixes into cleanup.
- Production serves the product contract, never the tests. No fixture-aware results,
  test-mode branches, public test-only APIs or successful unimplemented adapters.
- Test real behavior through meaningful boundaries. Tests and implementation both answer
  to the requirements; do not weaken correct expectations to accommodate broken code.
- Verify proportionately: affected tests first, relevant regressions before commit,
  broad gates at stage acceptance. Reuse unchanged evidence rather than repeating rituals.
- Activity, progress, legitimate waiting and permission to continue are distinct.
  A timer is a reason to investigate, not proof of abandonment or authority to restart.
- Assessment is judgment, not authorization. A reviewer can confirm, narrow or reject
  a hypothesis; it is not expected to defend the first assessor's conclusion.
- Delegation serves independent bounded work, not recursive bureaucracy. One writer
  owns a slice; the parent verifies actual results instead of repeating self-reports.
- Ordinary reversible local work needs no repeated permission. Paid requests,
  destructive actions, publication and remote pushes need explicit authorization.
- Stop after the requested increment is implemented and reasonably verified.
  Report changes, actual checks, limitations and blockers. Answer status questions promptly.

## Product boundaries

- Bare Pi and this package must suffice for the eventual core feedback loop. Donor
  observer/subagent plugins are not runtime prerequisites.
- Cold activation is disabled; default mode is observe. Never inherit a model route
  merely because the primary has credentials. Spending and effect grants are explicit.
- One session-owned runtime and one managed check path. No global current session,
  second scheduler, hidden donor controller or generic workflow framework.
- C1 component roles remain observation, trigger, context, prompt, evaluator, policy,
  action and sink. Roles are boundaries, not mandatory classes or packages.
- Components are replaceable; admission, authority, accounting and receipt semantics
  remain coherent. Built-ins must obey the same execution contracts as contributions.
- Timers, reload, observer resume and late callbacks cannot clear operator Stop or
  acquire new-generation authority. Logical cancellation is not physical termination.
- Unknown usage/cost stays unknown, not zero. Functional control and accounting do not
  depend on logging, verbosity, rotation, retention or sink availability.
- Standard diagnostics contain approved metadata, not task/source/prompt bodies,
  commands, tool-result bodies, model prose, credentials or raw exceptions.
  Debug/Trace does not authorize capture; every capture category defaults to none.
- Unsupported functionality remains unavailable, never a success-shaped placeholder.
  Source inspection, mechanical tests, host integration, live judgment and usefulness
  are separate claims requiring their own evidence.

## Repository and execution discipline

- Work in this checkout. Download needed reference repositories into ignored root
  donors/. Exclude donors from observed fixture sources and published packages.
  Verify exact documented pins and licenses; track material actually copied.
- WVM is an instructions donor only. Do not modify WVM or the adjacent Pi assembly.
- Use project-local Node/TypeScript dependencies and one npm lockfile. No unrelated
  Python virtual environment or global package changes. Use Vite only if a real
  browser surface needs a frontend build; the extension itself uses TypeScript compilation.
- Inspect actual pinned SDK declarations; do not guess imports, fields or library APIs.
  Pi-supplied packages are peers, not bundled second runtimes.
- Tests use disposable projects/configuration and a deliberate environment allowlist.
  Never use operator credentials, personal Pi settings or live user data as fixtures.
- Commit completed verified logical slices with explicit staged paths. Exclude secrets,
  donors, logs, caches, generated verification output and unrelated work.
  No push/publication without a separate explicit request; no destructive Git shortcuts.
- Use only implemented development commands. A proposed command in a design document
  is not proof that the repository supplies it. Failed required checks block acceptance.

## Complete instruction routing

Read every matching instruction for cross-cutting work, not just the first plausible file.

| Instruction | Read when |
| --- | --- |
| [DOCS.commit_messages](Инструкции/DOCS.commit_messages.instructions.md) | Grouping, verifying or creating commits. |
| [DOCS.instructions_style](Инструкции/DOCS.instructions_style.instructions.md) | Creating, updating, splitting or routing instructions; accepted-stage synchronization. |
| [CORE.architecture](Инструкции/CORE.architecture.instructions.md) | Source placement, imports, ownership, activation, retirement or donor reuse. |
| [BUILD.toolchain](Инструкции/BUILD.toolchain.instructions.md) | Dependencies, local environment, compiler, build or packaging. |
| [TEST.testing](Инструкции/TEST.testing.instructions.md) | Behavioral tests, host probes, experiments, evidence or acceptance. |
| [CORE.logging](Инструкции/CORE.logging.instructions.md) | Diagnostics, persistence, errors, privacy, usage or recovery. |
| [WORKFLOW.orchestration](Инструкции/WORKFLOW.orchestration.instructions.md) | Assigning medium Pi slices, acceptance ownership, same-session repairs, oracle escalation or orchestration state. |

If ownership is unclear, start with the document catalog and implementation map.
Maintain this complete routing table whenever an instruction is added or removed.

## Update instructions after accepted major stages

Instructions are part of the development contract. After actual acceptance of a major
stage/checkpoint, review affected instructions against the accepted implementation and
update them where necessary. The owner explicitly authorizes this ongoing synchronization.

1. Establish actual acceptance, its tested candidate and declared scope. Completing
   a plan or writing a report does not establish acceptance.
2. Reconcile owners, boundaries, active commands, workflows, restrictions and quality
   rules with accepted code and evidence. Remove stale names and broken links.
3. Update affected instructions and necessary navigation only. Link canonical contracts
   rather than duplicating them. Keep the development philosophy in this file.
4. Do not silently change C1 fields, O1 privacy, permission ceilings or acceptance gates.
   Substantive contract changes need an explicit decision in the owning document.
5. Check frontmatter, scope, links, routing completeness and consistency before committing
   the completed maintenance slice. Briefly report substantive rule changes.
6. Keep a later documentation commit distinct from the tested candidate. Never move an
   accepted tag onto untested instruction or evidence changes.

Outside accepted-stage synchronization or an explicit editing request, instruction review
is read-only. Report suspected drift instead of opportunistically rewriting policy.

## Canonical documentation and authority

Start with [00 — Document Catalog](docs/00-document-catalog-and-reading-guide.md).
Initial onboarding reads the whole set; later tasks use the relevant owning sections.

| Document | Authority |
| --- | --- |
| [01 Architecture](docs/01-architecture-and-decisions.md) | Scope, invariants, owners and frozen sources. |
| [02 Contracts](docs/02-component-contracts-and-configuration.md) | Exact C1 public types, configuration and operations. |
| [03 Observability](docs/03-observability-and-data-policy.md) | O1 payloads, privacy, accounting and storage. |
| [04 Acceptance](docs/04-implementation-testing-and-acceptance.md) | D1 stages and behavioral proof obligations. |
| [05 Implementation Map](docs/05-implementation-map-and-dependency-rules.md) | Source responsibility and dependency direction within 01–03. |
| [06 Handoff and Probes](docs/06-implementation-handoff-and-integration-probes.md) | Practical work order and real-boundary probes. |
| [07 Philosophy](docs/07-project-philosophy.md) | Intent and feature-fit reasoning. |
| [08 Checkpoints](docs/08-development-checkpoints-and-release-checklists.md) | K01–K13 candidate-specific gates and tags. |
| [09 Testing Philosophy](docs/09-testing-philosophy-and-behavioral-evidence.md) | Meaningful finite semantic and integration experiments. |

Authority follows subject, not document number or recency. Resolve contradictions
explicitly. Do not weaken a contract for a convenient library or green fixture.
Plans, versions and unchecked checklists are not runtime evidence.

## Provenance

Development philosophy and instruction conventions are adapted from WVM AGENTS.md,
DOCS.commit_messages and DOCS.instructions_style. WVM-specific Python/Qt architecture,
application release rules, agent-team settings and Goal controls are not inherited.
