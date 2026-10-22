import assert from "node:assert/strict";
import test from "node:test";
import { readFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fixture, progress, questions, criteria } from "./k09-typed-baseline.js";
import { EngineSession } from "../src/runtime.js";
import { ModelService } from "../src/models.js";
import type { ModelRegistryPort } from "../src/models.js";
import type { AssessmentResult, DecisionQuestion, ContextItem, EvaluatorDefinition } from "../src/contracts.js";

test("376 representation/digest changes with body, questions and instructions; O1 excludes bodies", async () => {
  const runs = [await fixture(), await fixture({ body: "IMPLEMENTATION_CHANGED_376_LONGER" }), await fixture({ questionSet: { progress: { ...questions.progress!, instructions: "CHANGED_QUESTION_376_LONGER" } } }), await fixture({ instruction: "CHANGED_INSTRUCTION_376_LONGER" })];
  const digests = new Set<string>();
  for (const f of runs) {
    assert.equal(f.calls.length, 1);
    const dispatch = f.records.find(e => e.event === "quality.model.dispatched")!.fields.data;
    digests.add(dispatch["inputSerializedDigest"] as string);
    assert.equal(dispatch["classifierQuestionCount"], 1); assert.equal(dispatch["outputTokenLimitApplicable"], false);
    const sent = JSON.stringify({ state: f.calls[0]!.state, questions: f.calls[0]!.questions });
    const manifest = f.records.find(e => e.event === "quality.context.manifest" && e.fields.data["boundary"] === "sdk-input")!.fields.data;
    assert.equal((manifest["sizes"] as Array<{ utf8Bytes: number }>)[0]!.utf8Bytes, Buffer.byteLength(sent));
    assert.ok(Object.isFrozen(f.calls[0]!.state)); assert.ok(!sent.includes("Canonical C1 assessment result"));
    assert.equal(await readFile(join(f.root, "agent/quality/oracle.txt"), "utf8"), "EXCLUDED_GRADER_376");
    const logged = JSON.stringify(f.records);
    for (const marker of ["IMPLEMENTATION_BODY_376", "TASK_BODY_376", "INSTRUCTION_BODY_376", "QUESTION_BODY_376"]) assert.ok(!logged.includes(marker));
  }
  assert.equal(digests.size, 4);
});
function extra(content: ContextItem["content"]): ContextItem {
  return { id: "owned-extra-376", role: "evidence", required: true, content, provenance: { sourceId: "fixture.extra", uri: "fixture:extra", revision: "extra-v1", acquiredAt: new Date().toISOString(), selection: { kind: "full" }, changedDuringRead: false }, bytes: Buffer.byteLength(JSON.stringify(content)), tokenEstimate: null };
}
test("376 JSON is submitted; actual image block refuses before attempt despite requiredInputs=text", async () => {
  const json = await fixture({ extraItems: [extra([{ type: "json", value: { marker: "JSON_CONTENT_376", n: 3 } }])] });
  assert.ok(JSON.stringify(json.calls[0]?.state).includes("JSON_CONTENT_376"));
  const image = await fixture({ extraItems: [extra([{ type: "image", artifactId: "owned-image-376", mimeType: "image/png", width: 1, height: 1 }])] });
  assert.equal(image.calls.length, 0); assert.equal(image.status.accounting?.ownedRequestCount, 0); assert.equal(image.captured[0]?.operational, "failed");
});
test("376 final escaped SDK overflow refuses before attempt, fitting counterpart works", async () => {
  const fit = await fixture({ plan: { maxBytes: 2000 }, body: "FITTING_376" }); assert.equal(fit.calls.length, 1);
  const overflow = await fixture({ plan: { maxBytes: 2000 }, body: '"'.repeat(500) });
  assert.equal(overflow.calls.length, 0); assert.equal(overflow.status.accounting?.ownedRequestCount, 0); assert.equal(overflow.captured[0]?.operational, "failed");
});
for (const [label, answers] of Object.entries({
  "missing": {}, "null": { progress: null }, "wrong type": { progress: { type: "bool", probability: 1 } }, "unknown choice": progress("unknown"),
  "sparse": { progress: { type: "choice", choice: "repeating", probabilities: { repeating: .8 }, confidence: .8 } },
  "out of range": { progress: { type: "choice", choice: "progressing", probabilities: { progressing: 2, repeating: 0, waiting: 0, unclear: -1 }, confidence: .8 } },
  "wrong sum": { progress: { type: "choice", choice: "progressing", probabilities: { progressing: .2, repeating: .2, waiting: .2, unclear: .2 }, confidence: .8 } },
  "extra key": { progress: { type: "choice", choice: "progressing", probabilities: { progressing: 1, repeating: 0, waiting: 0, unclear: 0, injected: 0 }, confidence: .8 } },
  "nonfinite": { progress: { ...progress().progress, confidence: Infinity } },
})) test(`376 normalized ${label} answer fails; received usage stays owned`, async () => {
  const f = await fixture({ answers }); assert.equal(f.calls.length, 1); assert.equal(f.captured[0]?.operational, "failed"); assert.equal(f.captured[0]?.conclusion, "undetermined"); assert.equal(f.status.accounting?.normalizedTokens.total, 60);
  assert.ok(f.records.some(e => e.event === "quality.assessment.result" && e.fields.reasonCodes.includes("core.assessment.typed-answer")));
});
test("376 normalized answer accessor is never invoked", async () => {
  let invoked = 0; const answers = Object.defineProperty({}, "progress", { enumerable: true, get() { invoked++; return progress().progress; } });
  const f = await fixture({ answers }); assert.equal(invoked, 0); assert.equal(f.captured[0]?.operational, "failed");
});
for (const choice of Object.keys(criteria)) test(`376 progress ${choice}: explicit mapping, retained distinct confidence`, async () => {
  const f = await fixture({ answers: progress(choice), includeHistory: true }); const r = f.captured[0]!;
  assert.equal(r.operational, "completed"); assert.equal(r.conclusion, choice === "repeating" ? "findings" : choice === "unclear" ? "undetermined" : "no-supported-finding");
  const meta = r.extensions?.["core.progress-v1"] as Record<string, unknown>;
  assert.equal(meta.choice, choice); assert.equal(meta.nativeConfidence, .61); assert.deepEqual({ ...(meta.unfinished as object) }, { state: "not-asked" }); assert.ok(Object.isFrozen(meta.unfinished)); assert.equal(r.workInterpretation, undefined);
  if (choice === "repeating") { assert.equal(r.findings[0]?.status, "suspected"); assert.ok((r.findings[0]?.evidenceIds.length ?? 0) > 0); assert.equal(r.findings[0]?.proposedCorrection, null); }
});
test("376 two-question default and explicit mapping retain unfinished probability, not completion; aggregate usage once", async () => {
  const qs = JSON.parse(await readFile(join(process.cwd(), "resources/prompts/progress-v1.questions.json"), "utf8")) as Record<string, DecisionQuestion>;
  const f = await fixture({ questionSet: qs, answers: { ...progress(), unfinished: { type: "bool", probability: .12 } }, evaluatorOptions: { mapping: "progress-v1", repairAttempts: 0 } });
  assert.equal(f.calls.length, 1); assert.equal(f.captured[0]?.operational, "completed");
  const meta = f.captured[0]?.extensions?.["core.progress-v1"] as Record<string, unknown>;
  assert.deepEqual({ ...(meta.unfinished as object) }, { state: "asked", probability: .12 }); assert.equal(f.captured[0]?.scores[1]?.value, .12); assert.equal(f.captured[0]?.workInterpretation, undefined); assert.equal(f.status.accounting?.normalizedTokens.total, 60);
  const missing = await fixture({ questionSet: qs, answers: progress() }); assert.equal(missing.captured[0]?.operational, "failed");
  const malformed = await fixture({ questionSet: qs, answers: { ...progress(), unfinished: { type: "bool", probability: 1.01 } } }); assert.equal(malformed.captured[0]?.operational, "failed");
});
test("376 incompatible set, unsupported mapping/score and classifier repair1 refuse before provider", async () => {
  for (const opts of [{ evaluatorOptions: { mapping: "unregistered" } }, { evaluatorOptions: { repairAttempts: 1 } }, { questionSet: { other: questions.progress! } }, { questionSet: { progress: { type: "score" as const, instructions: "unsupported mapping", criteria: ["a", "b"] } } }]) {
    const f = await fixture(opts); assert.equal(f.calls.length, 0); assert.equal(f.status.accounting?.ownedRequestCount, 0);
  }
});
const qualityChoices = ["concern", "not-established", "conflict", "insufficient"];
for (const choice of qualityChoices) test(`376 separate quality ${choice}: bounded scope mapping`, async () => {
  const qs = JSON.parse(await readFile(join(process.cwd(), "resources/prompts/quality-decision-v1.questions.json"), "utf8")) as Record<string, DecisionQuestion>;
  const answers = { quality: { type: "choice", choice, probabilities: Object.fromEntries(qualityChoices.map(k => [k, k === choice ? 1 : 0])), confidence: .51 } };
  const f = await fixture({ evaluator: "core.quality-decision", questionSet: qs, answers, evaluatorOptions: { mapping: "quality-decision-v1" } });
  assert.equal(f.calls.length, 1); const r = f.captured[0]!;
  assert.equal(r.operational, "completed"); assert.equal(r.conclusion, choice === "concern" ? "findings" : choice === "conflict" ? "conflicting-requirements" : choice === "insufficient" ? "undetermined" : "no-supported-finding");
  assert.equal((r.extensions?.["core.quality-decision-v1"] as Record<string, unknown>).scopeReferenceBasis, "adapter-supplied-scope");
  if (choice === "concern") { assert.equal(r.findings[0]?.status, "suspected"); assert.equal(r.findings[0]?.criterion, "task.instructions"); assert.equal(r.findings[0]?.proposedCorrection, null); assert.deepEqual(r.findings[0]?.affectedItems, []); assert.ok((r.findings[0]?.requirementRefs.length ?? 0) > 0); }
});
function complete(): AssessmentResult { return { operational: "completed", coverage: { state: "complete", scopeDescription: "Synthetic supplied scope", issues: [] }, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] }; }
function extensionEvaluator(value: AssessmentResult["extensions"], schema: EvaluatorDefinition["resultExtensions"]): EvaluatorDefinition {
  return { id: "fixture.extension", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["text", "json"], optionsSchema: { type: "object" }, requiredCapabilities: [], diagnosticCodes: [], ...(schema === undefined ? {} : { resultExtensions: schema }), evaluate: async () => ({ ...complete(), ...(value === undefined ? {} : { extensions: value }) }) };
}
test("376 declared extension retained in policy, not O1; unknown/invalid/accessor/mutated declarations reject", async () => {
  const schema = { "fixture.meta": { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } };
  const positive = await fixture({ evaluatorDefinition: extensionEvaluator({ "fixture.meta": { value: "PRIVATE_EXTENSION_376" } }, schema) });
  assert.equal((positive.captured[0]?.extensions?.["fixture.meta"] as Record<string, unknown>).value, "PRIVATE_EXTENSION_376"); assert.ok(!JSON.stringify(positive.records).includes("PRIVATE_EXTENSION_376"));
  for (const extensions of [{ "fixture.other": { value: "PRIVATE_EXTENSION_376" } }, { "fixture.meta": { value: 7 } }]) { const f = await fixture({ evaluatorDefinition: extensionEvaluator(extensions, schema) }); assert.equal(f.captured[0]?.operational, "failed"); assert.ok(f.records.some(e => e.fields.reasonCodes.includes("core.assessment.extension"))); }
  let invoked = 0; const body = Object.defineProperty({}, "value", { enumerable: true, get() { invoked++; return "PRIVATE_EXTENSION_376"; } });
  const accessor = await fixture({ evaluatorDefinition: extensionEvaluator({ "fixture.meta": body }, schema) }); assert.equal(accessor.captured[0]?.operational, "failed"); assert.equal(invoked, 0);
  const mutable = { "fixture.meta": { type: "object", properties: { value: { type: "integer", maximum: 1 } }, required: ["value"], additionalProperties: false } };
  const mutated = await fixture({ evaluatorDefinition: extensionEvaluator({ "fixture.meta": { value: 2 } }, mutable), afterRegister: () => { mutable["fixture.meta"].properties.value.maximum = 999; } }); assert.equal(mutated.captured[0]?.operational, "failed");
});
test("376 declaration accessor is rejected at registration without invoking it", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-declaration-376-")); await mkdir(join(root, "project"));
  const session = await EngineSession.start({ observedSessionId: "declaration-376", hostIdleAtStart: true, branchId: "unresolved", agentDir: join(root, "agent"), projectRoot: join(root, "project"), projectConfigDir: join(root, "project/.pi"), projectTrusted: true, hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: join(process.cwd(), "resources") });
  try { let invoked = 0; const def = Object.defineProperty(extensionEvaluator({}, undefined), "resultExtensions", { get() { invoked++; return {}; } }); const reg = session.endpoint.register({ id: "fixture.bad-extension", version: "1", baseUri: "fixture:bad", resources: {}, components: [def] }); assert.equal(reg.ok, false); assert.equal(invoked, 0); } finally { await session.retire("quit"); }
});
test("376 fixed chat reasons are body-free; a legitimate limited result stays completed", async () => {
  const finding = { id: "one", criterion: "task.instructions", status: "supported", severity: "concern", requirementRefs: [], evidenceIds: ["UNISSUED_PRIVATE_REFERENCE_376"], affectedItems: [], defectCode: "fixture.defect", explanation: "PRIVATE_RESULT_376", proposedCorrection: null, limitations: [] };
  const cases: Array<[string, unknown]> = [["parse", "not-json-PRIVATE_RESULT_376"], ["non-object", []], ["structure", { ...complete(), unexpected: 1 }], ["consistency", { ...complete(), operational: "failed" }], ["reference", { ...complete(), conclusion: "findings", findings: [finding] }], ["criterion", { ...complete(), conclusion: "findings", findings: [{ ...finding, criterion: "undeclared.criterion" }] }], ["score", { ...complete(), scores: [{ criterion: "task.instructions", kind: "numeric", value: 2, minimum: 0, maximum: 1, interpretation: "PRIVATE_RESULT_376", calibrationRef: null }] }]];
  for (const [reason, value] of cases) { const f = await fixture({ evaluator: "core.chat", chatOutput: typeof value === "string" ? value : JSON.stringify(value) }); assert.ok(f.records.some(e => e.event === "quality.assessment.result" && e.fields.reasonCodes.includes(`core.assessment.${reason}`)), reason); const log = JSON.stringify(f.records); assert.ok(!log.includes("UNISSUED_PRIVATE_REFERENCE_376") && !log.includes("PRIVATE_RESULT_376")); }
  const f = await fixture({ evaluator: "core.chat", chatOutput: JSON.stringify({ ...complete(), coverage: { state: "partial", scopeDescription: "honest limit", issues: [] }, conclusion: "undetermined" }) }); assert.equal(f.captured[0]?.operational, "completed"); assert.equal(f.captured[0]?.conclusion, "undetermined"); assert.ok(!f.records.some(e => e.fields.reasonCodes.includes("core.assessment.parse")));
});

function service(registry: ModelRegistryPort, overrides: { capacity?: number; deny?: boolean; timeoutMs?: number } = {}) {
  return new ModelService({ profiles: { typed: { provider: "fixture", model: "typed", price: "unknown", reasoning: "off", requiredInputs: ["text"], requestTimeoutMs: overrides.timeoutMs ?? 1000, maxAttempts: 1, retryDelayMs: 0, maxOutputTokens: 4096 } }, approved: ["typed"], registry, budget: { maxRequestsPerSession: 3, maxOwnedTokensPerSession: 20000, maxOwnedCost: null, unknownCost: overrides.deny ? "deny" : "allow-with-token-limits" } });
}
test("376 true classifier capacity/unknown policy; post-intent body/question mutation cannot enlarge dispatch", async () => {
  const received: string[] = [];
  const registry: ModelRegistryPort = { findChat: () => null, findClassifier: () => ({ type: "classifier", contextWindow: 1000, input: ["text"] }), hasConfiguredAuth: () => true, completeChat: async () => { throw Error("unused"); }, classify: async (_m, state, qs, options) => { received.push(JSON.stringify({ state, qs, options })); return { answers: progress(), model: { provider: "fixture", id: "typed", revision: null }, usage: { input: 17, output: 0, totalTokens: 17 }, stopReason: "stop", errorMessage: null }; } };
  const state = { body: "PRE_INTENT_BODY_376" }, qs = structuredClone(questions); const owned = service(registry); let reservedAtDispatch = 0;
  const result = await owned.dispatch({ runId: "typed-run", profileId: "typed", kind: "classifier", classifierState: state, classifierQuestions: qs, maxOutputTokens: 4096, estimatedInputTokens: 0, signal: new AbortController().signal, onDispatched: attempt => { reservedAtDispatch = attempt.reservedTokens; }, onIntent: async () => { state.body = "POST_INTENT_MUTATION_376".repeat(200); qs.progress!.instructions = "POST_QUESTION_376"; return true; } });
  assert.equal(result.ok, true); assert.equal(received.length, 1); assert.ok(received[0]!.includes("PRE_INTENT_BODY_376") && !received[0]!.includes("POST_INTENT")); assert.ok(!received[0]!.includes("maxOutputTokens")); assert.equal(owned.attempts[0]?.effectiveMaxOutputTokens, 0); assert.ok(reservedAtDispatch > 0); assert.equal(owned.attempts[0]?.cost?.amount, null);
  for (const reg of [{ ...registry, findClassifier: () => ({ type: "classifier", input: ["text"] }) }, { ...registry, findClassifier: () => ({ type: "classifier", contextWindow: 1, input: ["text"] }) }]) { const s = service(reg); const r = await s.dispatch({ runId: "denied", profileId: "typed", kind: "classifier", classifierState: {}, classifierQuestions: questions, maxOutputTokens: 4096, estimatedInputTokens: 0, signal: new AbortController().signal }); assert.equal(r.ok, false); assert.equal(s.summary().ownedRequestCount, 0); }
  const deny = service(registry, { deny: true }); assert.equal((await deny.dispatch({ runId: "deny-price", profileId: "typed", kind: "classifier", classifierState: {}, classifierQuestions: questions, maxOutputTokens: 4096, estimatedInputTokens: 0, signal: new AbortController().signal })).ok, false); assert.equal(received.length, 1);
  const stopped = service(registry); let revoked = false; const no = await stopped.dispatch({ runId: "revoked", profileId: "typed", kind: "classifier", classifierState: {}, classifierQuestions: questions, maxOutputTokens: 4096, estimatedInputTokens: 0, signal: new AbortController().signal, onIntent: async () => { revoked = true; return true; }, revoked: () => revoked }); assert.equal(no.ok, false); assert.equal(received.length, 1);
});

test("376 stable identity: each changed body/question/instruction changes complete admitted digest and exact bytes", async () => {
  const snapshots: string[] = [];
  const port: ModelRegistryPort = { findChat: () => null, findClassifier: () => ({ type: "classifier", contextWindow: 64000, input: ["text"] }), hasConfiguredAuth: () => true, completeChat: async () => { throw Error("unused"); }, classify: async (_m, state, questions) => { snapshots.push(JSON.stringify({ state, questions })); return { answers: progress(), model: { provider: "fixture", id: "typed", revision: null }, usage: null, stopReason: "stop", errorMessage: null }; } };
  const base = { revision: "stable", instructions: [{ text: "INSTRUCTION_376" }], items: [{ id: "stable-evidence", role: "evidence", body: "BODY_376" }] };
  const variants = [{ state: structuredClone(base), q: structuredClone(questions) }, { state: { ...structuredClone(base), items: [{ ...base.items[0]!, body: "CHANGED_BODY_376_LONGER" }] }, q: structuredClone(questions) }, { state: structuredClone(base), q: { progress: { ...questions.progress!, instructions: "CHANGED_QUESTION_376_LONGER" } } }, { state: { ...structuredClone(base), instructions: [{ text: "CHANGED_INSTRUCTION_376_LONGER" }] }, q: structuredClone(questions) }];
  for (const v of variants) { const owned = service(port); const r = await owned.dispatch({ runId: "stable-input", profileId: "typed", kind: "classifier", classifierState: v.state, classifierQuestions: v.q, maxOutputTokens: 4096, estimatedInputTokens: 0, signal: new AbortController().signal }); assert.equal(r.ok, true); assert.equal(snapshots.at(-1), JSON.stringify({ state: v.state, questions: v.q })); assert.equal(owned.attempts[0]?.inputSerializedDigest, createHash("sha256").update(snapshots.at(-1)!).digest("hex")); }
  for (const s of snapshots.slice(1)) assert.notEqual(Buffer.byteLength(s), Buffer.byteLength(snapshots[0]!)); assert.equal(new Set(snapshots).size, 4);
});
test("376 ties and a high unfinished probability are retained without renormalization or completion", async () => {
  const qs = JSON.parse(await readFile(join(process.cwd(), "resources/prompts/progress-v1.questions.json"), "utf8"));
  const answers = { progress: { type: "choice", choice: "progressing", probabilities: { progressing: .5, repeating: .5, waiting: 0, unclear: 0 }, confidence: .91 }, unfinished: { type: "bool", probability: .88 } };
  const f = await fixture({ questionSet: qs, answers }); const r = f.captured[0]!; assert.equal(r.operational, "completed"); assert.equal(r.workInterpretation, undefined);
  const meta = r.extensions?.["core.progress-v1"] as Record<string, unknown>; assert.equal(meta.nativeConfidence, .91); assert.equal((meta.probabilities as Record<string, unknown>).progressing, .5); assert.equal((meta.probabilities as Record<string, unknown>).repeating, .5); assert.equal((meta.unfinished as Record<string, unknown>).probability, .88);
});
test("376 quality does not call partial coverage clean and refuses overlarge scope rather than inventing a classified subset", async () => {
  const qs = JSON.parse(await readFile(join(process.cwd(), "resources/prompts/quality-decision-v1.questions.json"), "utf8"));
  const answers = { quality: { type: "choice", choice: "not-established", probabilities: { concern: 0, "not-established": 1, conflict: 0, insufficient: 0 }, confidence: .8 } };
  const limited = await fixture({ evaluator: "core.quality-decision", questionSet: qs, answers, extraItems: [extra([{ type: "text", text: "partially observed extra" }])], extraCoverage: "partial", plan: { requiredCoverage: "partial" } });
  assert.equal(limited.calls[0]?.state.coverage && (limited.calls[0].state.coverage as { state: string }).state, "partial"); assert.equal(limited.captured[0]?.operational, "completed"); assert.equal(limited.captured[0]?.conclusion, "undetermined");
  const many = Array.from({ length: 33 }, (_, n) => ({ ...extra([{ type: "text" as const, text: "Scoped extra evidence" }]), id: `owned-extra-${n}` }));
  const bounded = await fixture({ evaluator: "core.quality-decision", questionSet: qs, answers, extraItems: many }); assert.equal(bounded.calls.length, 0); assert.equal(bounded.status.accounting?.ownedRequestCount, 0); assert.equal(bounded.captured[0]?.operational, "failed");
});
test("376 chat transport gets selected engineering semantics, full shared C1 and literal issued inventory; added bytes measured", async () => {
  const instruction = await readFile(join(process.cwd(), "resources/prompts/engineering-v1.md"), "utf8"), resultSchema = JSON.parse(await readFile(join(process.cwd(), "resources/prompts/evaluation-v1.schema.json"), "utf8"));
  const f = await fixture({ evaluator: "core.chat", instruction, resultSchema, chatOutput: JSON.stringify(complete()) });
  assert.equal(f.chatCalls.length, 1); const delivered = f.chatCalls[0]!.messages as Array<{ role: string; content: string }>, text = delivered.map(x => x.content).join("\n");
  assert.ok(text.includes(instruction)); assert.ok(text.includes(JSON.stringify(resultSchema))); assert.ok(text.includes("literal issued reference inventory")); assert.ok(text.includes("Copy complete IDs literally"));
  for (const prefix of ["source:rules:", "source:code:", "source:task:"]) assert.ok(text.includes(prefix));
  const dispatched = f.records.find(e => e.event === "quality.model.dispatched")!; assert.equal(dispatched.fields.data.operationKind, "chat");
  const manifest = f.records.find(e => e.event === "quality.context.manifest" && e.fields.data.boundary === "sdk-input")!; assert.equal((manifest.fields.data.sizes as Array<{ utf8Bytes: number }>)[0]!.utf8Bytes, Buffer.byteLength(JSON.stringify(delivered.map(message => ({ role: message.role, content: [{ type: "text", text: message.content }] })))));
  assert.ok(!JSON.stringify(f.records).includes("Operational status describes execution"));
});
