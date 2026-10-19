# K09/v1 — offline corpus and proposed text assessment plan

**Author preparation candidate, not semantic or independent acceptance.** All
project examples, snippets and histories are invented and non-personal. A declared
synthetic terminal result in a history is **not** a command executed by this slice.
No real user project/session, image, model response or credential is an input.

## Inspect the family

- `corpus.json`: 42 neutral case IDs, each with a task, applicable supplied
  requirements (or explicit unavailable source), assessed implementation and finite
  observation window. Every source has an identity/revision and UTF-8 body digest.
- `labels.json`: separate **author-proposed, unadjudicated** scope, finding/absence/
  limitation rationale, real source references, acceptable alternatives and
  proportionate responses. It is an oracle proposal, never evaluator input.
- `split.json`: 14 task groups allocated **before candidate resource authoring or
  evaluation**. All three counterfactual variants of each group stay together.
  Each domain has a different calibration task and held-out task; seven groups per
  split, 21 cases per split. This is not 42 independent engineering problems.
- `review-instructions.md`: one unshipped text candidate supplement. The proposed
  production path also uses the existing `engineering-v1.md` and canonical C1
  schema; typed classifier questions are explicitly absent for `core.chat`.
- `acceptance-plan.json`: exact candidate tuple, requested route, counts, bounds,
  proposed numeric/categorical gate, independent adjudication and failure policy.
- `freeze.json`: raw and parsed-artifact digests, selected-input digests and fixed
  admitted production/resource/support source bindings. No automatic resealing.

Each of the seven domains has two genuine violations, two legitimate near-misses
and two limited-evidence cases: task/instruction scope; architecture/proportionality;
test-specific production behavior; operational logging; progress/waiting/repetition;
completion/verification; and **text-only visual-coverage honesty**. The latter
includes unsupported visual claims and honest abstentions, not image judgment.
There is no image/reference set and no visual-capability recommendation.

Labels distinguish supported findings, suspected/needs-investigation concerns,
no supported finding, conflicting requirements and insufficient evidence. They
are not new C1 result enums. The plan maps them to existing C1 operational,
coverage, conclusion and finding-status distinctions. Exact prose, class counts,
model confidence, acknowledgement, command issuance and silence are not oracles.
An independent reviewer must admit/adjudicate labels before held-out evaluation.

## Implemented OFFLINE commands

From the repository, using the existing Node toolchain:

```text
node scripts/validate-k09.mjs --plan-only
node --test test/k09-offline.test.mjs
```

The validator reads only six fixed fixture files, their freeze and twelve explicit
source/resource/support bindings. It validates format, source references/digests,
cut-offs, requested/completed distinctions, domain/label population, group split,
plan arithmetic and identity. It writes no outputs and imports no SDK/provider.
It rejects `--live`/`--execute`; there is no `test:live` npm command or fake success
path. Tests mutate in-memory copies and exercise the real validator and CLI.

`evaluatorInput` returns an **offline selection snapshot**, not a fabricated C1
ContextSnapshot or an actual SDK request. Its whitelist omits labels, group/split,
plan and rubric metadata. The positive control proves supplied bodies really enter
that selection; changing only the hidden oracle does not change it. This does not
prove future production delivery. A later authorized study must materialize only
selected public sources/instructions outside this checkout, keep labels/grader
outside model/tool discovery, and inspect actual production manifests/SDK input.
No image or oracle material may be silently acquired to repair missing coverage.

## Predeclared proposal, not a run

One `core.chat` candidate requests `ollama-cloud/deepseek-v4.1-flash`, reasoning
off, 1 draw per case, 42 total requests (21 calibration +21 held-out), no retries,
repair, preparation, reviewer, tools or effects. Actual model/revision/availability
and price are **unknown/unobserved**. It never inherits the orchestration/Codex
route. The proposed USD2.10 local envelope is a policy cap, not a price, allocated
allowance or invoice guarantee; unknown cost denies admission. The separate USD1
pilot remains separately blocked/unexecuted and is not consumed by this plan.

D1's 95% validity, 90% categorical precision and 70% violation detection are used
as **unapproved policy proposals**, with counts and sample minima in the plan.
All7 held-out limited cases must preserve their limitation; false corrections,
unsafe authority proposals, invented refs and disproportionate advice must be0.
The tiny held-out sample remains explicit. Zero denominators are undefined/null,
not100%. Observe/record-only suppression does not make a wrong proposed correction
semantically correct: grade the advice that would cause intervention separately.
All planned attempts, timeouts and unrun inventory survive; no favorable reruns.

If a held-out outcome changes any tuple member, retain that failure and create a
new candidate with fresh or explicitly reclassified holdout. Do not rewrite labels
or thresholds after seeing outputs and call it unchanged acceptance. No model or
semantic-response generation occurs in these mechanical checks.

## Decision boundary and remaining work

This slice prepares author-frozen inputs for **K09-B.01–B.05 /E.01**, with
independent label admission and threshold approval still pending. It anticipates
T01–T05 with paired evidence but does not execute their semantic assertions.
K09-B.06–B.12, T01–T07, E.02–E.04 and X.01–X.03 remain wholly or partly downstream:
independent adjudication; actual route/input/usage facts; candidate-specific live
judgments and safety grading; narrow promotion/limitation decisions; visual proof
only if a visual capability is ever proposed; final stage acceptance/release.
The canonical checklist has12 B rows,7 T rows,4 E rows and3 X rows (no K09-X.04).
The author report carries the precise26-row disposition without editing that
canonical checklist. **D-39 closed-loop usefulness remains separately unexecuted.**

Automatic corrective use remains unavailable until the exact domain/candidate
later passes an independently accepted gate. Nothing here grants live execution,
promotion, spending, Goal activation, another worker, K09 acceptance, commit/tag
or publication. The accepted K08 runtime and published `files` allowlist are
unchanged. These fixtures/candidate resources, validator and tests are outside
that allowlist; no package, SDK or dependency installation is needed.
