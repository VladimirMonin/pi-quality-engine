# Pi Quality Engine

Standalone evidence-based quality assessment for Pi, developed as one small
modular extension. **K08 / `0.6.0` is independently accepted and locally released**:
qualified S1–S3 mechanics plus public packaged contribution/recombination on
Windows and Pi SDK `1.1.0`. This contributor preview is not completion of all S4,
live engineering judgment or universal provider/platform compatibility.

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
- Routes bounded expert `core.request-check` work through ordinary check admission,
  with original-source hypotheses, protected recovery and honest unresolved work.
- Exposes an acknowledged C1 registry on `quality.registry.available.v1` /
  `quality.registry.query.v1` for all eight roles, including observation and sink.
  Independent packed contributions affect real checks and lawful receivers;
  readiness, validation, generation ownership and once-only disposal stay shared.
  The four-payload example is one package, not four applications.
- Carries each admitted reviewer turn's output cap and selected profile reasoning
  through the normal SDK path. Supported serializer sampling cannot widen the
  admitted cap; a smaller supported limit is preserved. This is not a billing or
  universal provider-reasoning guarantee.

## What is deliberately unavailable

Capture/export and later bindings remain unavailable. No live model judgment or
billing guarantee, TUI/RPC parity, automatic semantic finding-clearance classifier
or cross-process fleet discovery is claimed. Static prompt proof uses explicit
public-file deployment, not reads from protected dependency directories. Installed
K08 recombination does not retroactively create an installed K06 feedback witness.
Native Windows fixtures do not certify all platforms, ACLs or power-loss durability; directory sync is best-effort.
Polza/Jev, OpenRouter/Jev and local d3-mini remain individually UNVERIFIED.

Unsigned annotated `v0.6.0` targets tested implementation
`b0873d1972e842e0bbd04a36996b22400602ac35`, not this later documentation commit.
The tested engine tar has63 payloads and SHA256
`c399590c5b20e2ca5daea1362fb5b3e3b1a58520689bee99ccfaab055f640623`.
Use the [K08 acceptance and exact release record](docs/08-development-checkpoints-and-release-checklists.md#k08).
The release used fresh tar extraction with existing pinned dependencies; no fresh
package-manager dependency-resolution claim is made. This README update neither
repacks the accepted artifact nor moves its tag; packing later docs creates a
different artifact requiring qualification.
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
npm run test:pi         # common isolated Pi set; checkpoint families selected separately
npm run test:package    # pack, clean install and load the installed artifact
```

Tests never use operator Pi settings, credentials or live model routes.
Select checkpoint files with `QE_TEST_FILES` using the platform's environment
syntax (comma-separated paths). After building, the K08 installed families are
`test/k08-role-neutrality.test.mjs` and `test/k08-output-cap.test.mjs`; they are not
part of the default common host set. K05/K06/K07 specialized host/storage/recovery
families likewise require explicit selectors and their recorded support.
Generated verification output stays under ignored `verification/` or the explicitly
owned external qualification root.

## K09 offline preparation (not a version release)

The [K09/v1 fixture guide](test/fixtures/k09/v1/README.md) links the frozen corpus,
separate labels, grouped split, candidate resources and acceptance plan. Astra347
accepted these exact offline inputs,42 labels and bounded pilot policy; they are
saved in `3ffcf3ecc0938e347f2e9f106a7753fe401d3060`. This is not model accuracy,
profile promotion, whole K09 acceptance or a new package/tag. The runtime remains
`0.6.0`; the offline family is outside the published files allowlist.

```sh
node scripts/validate-k09.mjs --plan-only
node --test test/k09-offline.test.mjs
```

These are existing standalone offline commands, not a new npm/live command.
The validator reports the frozen historical input state: proposed/unadjudicated
strings intentionally remain unchanged despite external347 admission. Do not edit
or reseal them to record approval. See the [accepted offline scope and remaining
K09 gates](docs/08-development-checkpoints-and-release-checklists.md#k09-offline-preparation).
Actual C1/SDK input and issued-reference delivery, semantic T01–T07, route/usage/cost,
per-domain promotion and D-39 usefulness remain pending. No live-study spending
or product-model execution follows from these commands or this local save.
