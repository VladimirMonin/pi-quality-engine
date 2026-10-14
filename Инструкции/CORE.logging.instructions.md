---
applyTo: "src/**/*.ts"
name: "CORE.Logging"
description: "Use when emitting events, handling errors, writing journals, adding sinks, capturing content or reporting usage and recovery."
---

# CORE — Diagnostics and data policy

Document 03 owns the exact O1 envelope, closed event payloads and storage semantics;
Document 02 owns configuration. Do not invent a parallel logger schema or control.

Project functional data explicitly into approved diagnostic metadata. Never spread
raw context, arguments, results, model prose or errors into records. Standard excludes
task/source/prompt bodies, commands, search strings, tool results, responses,
exception messages/stacks, credentials and environment dumps. Debug/Trace do not
change capture permission; all capture categories start at none.

Use engine-issued or bounded validated identities and enum/error codes. Arbitrary
strings are not safe merely because the field is named ID or metadata. Invalid
configuration reports safe schema paths and codes, not offending values or raw keys.
Do not serialize arbitrary getters/toJSON/cycles. Measure UTF-8 bytes including LF.

Only already-projected records reach recent history, file destinations or contributed
sinks. History/queues are bounded by count and bytes; zero history count or byte allowance
means retain none, never unlimited. Observability is user-owned: a trusted project
cannot override it, even by narrowing (C1 §2.2 / O1 §24.8). Sink failure does not
rerun work or recursively log forever. If persistence is not implemented, report that honestly
and do not claim journal/storage acceptance from an in-memory collector.

One logical journal belongs to each observed session including owned reviewers.
Logical retirement is not remote termination; queued is not included; written is
not power-loss durability. Unknown usage/cost remains null/unknown. Primary/external
billing is excluded from owned totals. Accounting and Stop live independently of logs.

Persistent storage must establish a permitted root and writer ownership before first
write. Tests use fresh disposable state, never operator journals/configuration. Read
O1 storage/rotation/recovery sections before adding writes, cleanup or restoration;
no deletion or live-state migration as a side effect of diagnostics startup.
