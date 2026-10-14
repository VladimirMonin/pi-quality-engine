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
Use descriptor-only admission: missing/accessor mandatory C1 fields are invalid,
not empty/default success; explicit valid empty arrays remain valid. Do not serialize
arbitrary getters/toJSON/cycles. Measure UTF-8 bytes including LF. Resource, criterion,
evidence and attempt references must resolve at their actual owning boundary before
any history, UI, journal or future sink projection.

Only already-projected records reach recent history, file destinations or contributed
sinks. History/queues are bounded by count and bytes; zero history count or byte allowance
means retain none, never unlimited. Observability is user-owned: a trusted project
cannot override it, even by narrowing (C1 §2.2 / O1 §24.8). Sink failure does not
rerun work or recursively log forever. The current `src/journal.ts` path writes
projected O1 records beneath the permitted user agent directory and exposes bounded
queue/loss/health state. Verify physical bytes through final close, separately from
memory history. The accepted native S1 journal includes bounded record delivery,
size and monotonic elapsed rotation, gzip and eligible closure-based retention.
Known loss remains partial even after a successful final sync; partial native
writes are completed exactly or reported as loss, never acknowledged as a full
record. Preserve damaged/foreign/live/unrelated evidence and uncertain age.
`src/checkpoint.ts` separately owns bounded Stop/authorization/control metadata;
logging choices cannot reset it. Directory pressure is a cleanup target, not a
quota that permits deleting active/checkpoint data. Native Windows file sync and
best-effort directory sync do not establish universal or power-loss durability.

One logical journal belongs to each observed session including owned reviewers.
Logical retirement is not remote termination; queued is not included; written is
not power-loss durability. Unknown usage/cost remains null/unknown. Primary/external
billing is excluded from owned totals. Accounting and Stop live independently of logs.

Persistent storage must establish a permitted root and writer ownership before first
write. Tests use fresh disposable state, never operator journals/configuration. Read
O1 storage/rotation/recovery sections before adding writes, cleanup or restoration;
no deletion or live-state migration as a side effect of diagnostics startup.
