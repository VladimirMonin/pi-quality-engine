# Pi Quality Engine

Standalone evidence-based quality assessment for Pi, developed as one small
modular extension. This repository is at checkpoint **K03 (package `0.1.0`), S1 complete**:
a local observation-only deterministic preview with bounded lifecycle,
protected control state, metadata journals and acknowledged C1 contributions.

## What this version actually does

- Registers one Pi extension entry with `/quality status` and `/quality stop`.
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
- Assembles bounded context evidence (`core.task`, `core.history`,
  `core.waits`) with provenance, coverage and manifest metadata, runs the
  deterministic `core.repeated-tools` evaluator and the `core.record-only`
  policy, and settles every run with O1 metadata.
- Writes projected O1 journals beneath `<agent dir>/quality/logs/`, using an
  active session-key JSONL file and ordinal closed segments. Bounded queues,
  history, size/elapsed rotation, gzip and eligible retention expose loss and
  degradation through physical close. Directory pressure is a cleanup target,
  never permission to delete active, checkpoint or unrelated files.
- Persists bounded owner/Stop/authorization metadata beneath
  `<agent dir>/quality/state/`, separately from diagnostics. Pause/resume/reload
  cannot clear Stop; control failure suspends dependent unsafe admission.
  Logical retirement does not free a physically unsettled operation.
- Exposes an acknowledged C1 registry on `quality.registry.available.v1` /
  `quality.registry.query.v1`; independently loaded extensions can register
  triggers, context providers, prompts, evaluators and policies, wait for
  acknowledged readiness, and dispose cleanly.

## What is deliberately unavailable

Model requests, paid evaluation/accounting, primary feedback or actions,
original source/Git collection, model-profile configuration, capture/export and
session configuration patches remain unavailable. No success-shaped placeholder
exists. Native Windows fixture acceptance does not certify all platforms,
TUI/RPC modes, ACLs or power-loss durability; directory sync is best-effort.

The local unsigned annotated `v0.1.0` identifies the exact tested implementation;
this README is later authorized documentation maintenance, not a repack or moved
release tag. See [K03/S1 acceptance](docs/08-development-checkpoints-and-release-checklists.md#k03).
No push, publication, live-provider usefulness or paid trial is implied.

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
npm run test:pi         # real Pi loader with isolated agent directories
npm run test:package    # pack, clean install and load the installed artifact
```

Tests never use operator Pi settings, credentials or live model routes.
Generated verification output stays under the ignored `verification/` directory.
