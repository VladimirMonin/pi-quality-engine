# Pi Quality Engine

Standalone evidence-based quality assessment for Pi, developed as one small
modular extension. This repository is at checkpoint **K01 (package `0.0.1`)**:
an installable, inert foundation with safe inactive startup and initial
lifecycle metadata diagnostics.

## What this version actually does

- Registers one Pi extension entry with a read-only `/quality status` command.
- Creates one session-owned runtime generation per Pi session and retires it on
  `session_shutdown`, writing O1-shaped `quality.runtime.started`,
  `quality.runtime.retired` and (on a bad candidate) `quality.config.rejected`
  metadata records into a bounded in-memory history.
- Discovers and validates configuration from `<agent dir>/quality/config.yaml`
  (or `.json`) and, for trusted projects, `<project>/.pi/quality.yaml` (or
  `.json`).
- Keeps cold activation disabled, default mode `observe`, all spend/effect
  grants empty and every content capture category `none`.
- Makes no model request, opens no credential and performs no primary effect.

## What is deliberately unavailable

Check execution, triggers and timers, context/evidence assembly, component
registry, model evaluation, feedback or actions, journal files, functional
state persistence and session configuration patches are not implemented.
`/quality status` reports them as `unavailable`; no success-shaped placeholder
exists for them.

## Configuration

Locations:

- User file: `<Pi agent directory>/quality/config.yaml`; `config.json` with the
  same base name is the alternative. Having both formats at one location is an
  error.
- Trusted project file: `<project root>/.pi/quality.yaml`; `quality.json` is the
  alternative. An untrusted project file is not read.

The restricted authoring form rejects duplicate keys, aliases, merge usage,
custom tags, non-string keys, non-finite numbers, multiple documents, more than
1 MiB of UTF-8, more than 32 nesting levels and more than 256 entries per map.
Only schema version `1` and the implemented subset are accepted: `enabled:
false`, `mode: observe`, default empty grants and a `standard`, metadata-only
observability block with optional `recentHistory.maxEvents` / `maxBytes`. Valid
C1 values outside that subset are rejected as `config.capability-unavailable`
instead of being silently ignored. Rejections report schema paths and error
codes, never the offending key or value.

## Development commands

```sh
npm ci
npm run check          # build, unit tests, real Pi host test, package test
npm run build          # tsc
npm test                # deterministic contract/runtime tests
npm run test:pi         # real Pi loader with an isolated agent directory
npm run test:package    # pack, clean install and load the installed artifact
```

The tests never use operator Pi settings, credentials or live model routes.
Generated verification output stays under the ignored `verification/` directory.
