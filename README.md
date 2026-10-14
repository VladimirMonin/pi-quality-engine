# Pi Quality Engine

Standalone evidence-based quality assessment for Pi, developed as one small
modular extension. This repository is at checkpoint **K02 (package `0.0.2`)**:
an observation-only deterministic loop with count and time triggers, a real
session journal, and an acknowledged C1 contribution registry.

## What this version actually does

- Registers one Pi extension entry with `/quality status` and `/quality stop`.
- Resolves the C1 configuration subset: enabled flags, permissions ceiling,
  runtime limits, observability, prompts, contexts, evaluators, policies and
  checks. Cold configuration stays inactive; the default mode is `observe`.
- Observes the real primary session through the pinned Pi adapter: operator
  input, operator stop, top-level tool completions and cycles. Completions are
  counted once per operation identity; nested, duplicate and non-primary
  activity never advances the primary counter.
- Owns exactly one monotonic clock and one timer. `core.every-tools` and
  `core.periodic` propose intents through the same bounded `check.run`
  admission path with coalescing, cooldown, capacity limits and trigger-spin
  containment.
- Assembles bounded context evidence (`core.task`, `core.history`,
  `core.waits`) with provenance, coverage and manifest metadata, runs the
  deterministic `core.repeated-tools` evaluator and the `core.record-only`
  policy, and settles every run with O1 metadata.
- Writes an append-oriented session journal under
  `<agent dir>/quality/logs/<session>.ndjson` when the engine is enabled, and
  keeps a bounded in-memory history. A full or failed journal degrades visibly
  (`quality.sink.health`, journal status) without stopping checks or hiding
  loss.
- Exposes an acknowledged C1 registry on `quality.registry.available.v1` /
  `quality.registry.query.v1`; independently loaded extensions can register
  triggers, context providers, prompts, evaluators and policies, wait for
  acknowledged readiness, and dispose cleanly.

## What is deliberately unavailable

Model requests, paid evaluation, primary feedback or actions, functional
checkpoint persistence and recovery, journal rotation/compression/retention,
source and model-profile configuration, additional triggers such as inactivity
or no-progress, export, and session configuration patches. `/quality status`
reports them as `unavailable`; no success-shaped placeholder exists.

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
npm ci
npm run check          # build, unit tests, real Pi host tests, package test
npm run build          # tsc
npm test                # deterministic contract/runtime/loop tests
npm run test:pi         # real Pi loader with isolated agent directories
npm run test:package    # pack, clean install and load the installed artifact
```

Tests never use operator Pi settings, credentials or live model routes.
Generated verification output stays under the ignored `verification/` directory.
