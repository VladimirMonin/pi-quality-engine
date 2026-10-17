# Pi Quality Engine

Standalone evidence-based quality assessment for Pi, developed as one small
modular extension. **K06 / `0.4.0` is independently accepted and locally released**:
S1/S2 footing plus opt-in bounded feedback on the tested native SDK print route.
K07 / `0.5.0` is the next existing roadmap slice; general escalation/recovery is
not claimed complete.

## What this version actually does

- Registers one Pi extension entry with `/quality status`, `stop`, `pause`,
  `resume` and `reload`; observer controls never clear primary Stop.
- Resolves the C1 configuration subset: enabled flags, permissions ceiling,
  runtime limits, observability, prompts, contexts, evaluators, policies and
  checks. Cold configuration stays inactive; the default mode is `observe`.
- Observes the real primary session through the pinned Pi adapter: operator
  input, operator stop, top-level tool completions and cycles. Completions are
  counted once per operation identity; nested, duplicate and non-primary
  activity never advances the primary counter.
- Owns one monotonic scheduler/timer and one bounded `check.run` admission
  path. Count, periodic, inactivity/no-progress, known-wait, history-evidence
  and actionable completion causes preserve coalescing, cooldown, fairness
  and physically unsettled capacity across replacement. Public evidence-change
  selection supports `core.history`; other named scopes are honestly unavailable.
- Assembles bounded task/history/wait and approved original source/Git evidence
  with provenance, coverage and manifests. Deterministic, explicit direct
  chat/classifier and clean tool-assisted Pi reviewer paths share admission,
  cancellation and owned accounting. Scripted mechanics do not certify live judgment.
- Adds pure `core.engineering` proposals and the ordinary `core.feedback` action.
  Effective advise mode and explicit action grants are required. Scope, material
  freshness, actual final text bytes, approved effects, Stop and finite allowances
  are rechecked at owned effect/boundary facets. Default feedback cap is2048 UTF-8
  bytes; natural-idle continuation additionally requires policy/operator grants.
  Native MAIN input is independently observed; queued/dispatched receipts are not
  promoted to inclusion merely from context preparation.
- Writes projected O1 journals beneath `<agent dir>/quality/logs/`, using an
  active session-key JSONL file and ordinal closed segments. Bounded queues,
  history, size/elapsed rotation, gzip and eligible retention expose loss and
  degradation through physical close. Directory pressure is a cleanup target,
  never permission to delete active, checkpoint or unrelated files.
- Persists bounded owner/Stop/authorization, owned finance and effect-intent/
  deduplication metadata beneath `<agent dir>/quality/state/`, separately
  from diagnostics. Unresolved action identity survives uncertainty; capacity
  refusal does not evict it. Pause/resume/reload cannot clear Stop; control failure
  suspends dependent unsafe admission. Logical retirement is not physical drain.
- Exposes an acknowledged C1 registry on `quality.registry.available.v1` /
  `quality.registry.query.v1`; independently loaded extensions can register
  triggers, context providers, prompts, evaluators, policies and actions, wait for
  acknowledged readiness, and dispose cleanly.

## What is deliberately unavailable

`core.request-check` expert escalation and complete S3 recovery remain K07 work;
capture/export and later bindings remain unavailable. No actual installed K06
feedback observation, live model judgment/billing, TUI/RPC parity or automatic
semantic finding-clearance classifier is claimed. Native Windows fixtures do not
certify all platforms, ACLs or power-loss durability; directory sync is best-effort.
Polza/Jev, OpenRouter/Jev and local d3-mini remain individually UNVERIFIED.

Unsigned annotated `v0.4.0` targets tested implementation
`40bcce3e0f2d2f3b62f1d3ca2a6873670957a7c1`. This later README maintenance does not
repack that artifact or move the tag. Use the qualified
[K06 decision/release record](docs/08-development-checkpoints-and-release-checklists.md#k06),
including separate retained T05c proof and the exact tar/native-input equivalence.
Installed loading/K05 consumer evidence is not an installed K06 feedback claim.
Remote Git delivery is recorded separately; no package/Release publication or
live-provider spending follows from the tag.

## Configuration

Locations:

- User file: `<Pi agent directory>/quality/config.yaml`; `config.json` with the
  same base name is the alternative. Having both formats at one location is an
  error.
- Trusted project file: `<project root>/.pi/quality.yaml`; `quality.json` is the
  alternative. An untrusted project file is not read, and a project file can
  never override user-owned observability or runtime policy.

The restricted authoring form rejects duplicate keys, aliases, custom tags,
non-string keys, non-finite numbers, multiple documents, more than 1 MiB, more
than 32 nesting levels and more than 256 entries per map. Unknown core keys and
unresolved references are errors; valid C1 values outside the implemented
subset are reported as unavailable instead of being ignored. Rejections report
schema paths and error codes, never the offending key or value.

## Development commands

```sh
npm ci --ignore-scripts
npm run check          # build, unit, evidence routing, real Pi host, package test
npm run build          # tsc
npm test                # deterministic contract/runtime/loop tests
npm run test:pi         # common isolated Pi set; excludes K05/K06 host files
npm run test:package    # pack, clean install and load the installed artifact
```

Tests never use operator Pi settings, credentials or live model routes.
Select K06 host coverage with `QE_TEST_FILES=test/k06-host.test.mjs` using the
platform's environment syntax; it is not part of the default aggregate host set.
Generated verification output stays under ignored `verification/` or the explicitly
owned external qualification root.
