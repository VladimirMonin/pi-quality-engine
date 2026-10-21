import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { compileOptionsSchema } from "../src/registry.js";
import { CANONICAL_RESULT_SCHEMA, createPromptFilesProvider } from "../src/builtins/prompts.js";
import { EngineSession } from "../src/runtime.js";
import type { ModelRegistryPort } from "../src/models.js";
import type { PromptContext } from "../src/contracts.js";

const emptyResult = () => ({
  operational: "completed", coverage: { state: "complete", scopeDescription: "Synthetic assessed scope", issues: [] },
  conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
});
const findingResult = (ref = "source:evidence:issued") => ({
  ...emptyResult(), conclusion: "findings", findings: [{
    id: "local-finding", criterion: "correctness.requirements", status: "supported", severity: "concern",
    requirementRefs: [], evidenceIds: [ref], affectedItems: [ref], defectCode: "correctness.synthetic-defect",
    explanation: "PRIVATE_RESULT_358_PROSE", proposedCorrection: null, limitations: [],
  }],
});
async function declaredValidator(): Promise<(value: unknown) => boolean> {
  const schema: unknown = JSON.parse(await readFile(join(process.cwd(), "resources/prompts/evaluation-v1.schema.json"), "utf8"));
  const compiled = compileOptionsSchema(schema);
  assert.equal(compiled.ok, true); if (!compiled.ok) throw new Error("schema-not-supported");
  return compiled.value;
}

test("K09 declared result schema rejects unsupported C1 operational values", async () => {
  const check = await declaredValidator();
  assert.equal(check(emptyResult()), true);
  assert.equal(check({ ...emptyResult(), operational: "An arbitrary prose verdict" }), false);
});

test("K09 shipped, explicit and omitted schemas share the canonical boundary contract", async () => {
  const shipped: unknown = JSON.parse(await readFile(join(process.cwd(), "resources/prompts/evaluation-v1.schema.json"), "utf8"));
  assert.deepEqual(shipped, CANONICAL_RESULT_SCHEMA);
  const provider = createPromptFilesProvider(join(process.cwd(), "resources"));
  const ctx = { signal: new AbortController().signal } as PromptContext;
  const omitted = await provider.build({ instructions: ["builtin:engineering-v1.md"] }, ctx);
  const explicit = await provider.build({ instructions: ["builtin:engineering-v1.md"], resultSchema: "builtin:evaluation-v1.schema.json" }, ctx);
  assert.ok(omitted.ok && explicit.ok); if (!omitted.ok || !explicit.ok) return;
  assert.deepEqual(omitted.value.resultSchema, shipped); assert.deepEqual(explicit.value.resultSchema, shipped);
  // A caller receives data, never the shared validator's mutable schema object.
  assert.notEqual(omitted.value.resultSchema, CANONICAL_RESULT_SCHEMA);
});

const malformed: Array<[string, () => unknown]> = [
  ["conclusion enum", () => ({ ...emptyResult(), conclusion: "Looks acceptable" })],
  ["coverage state", () => ({ ...emptyResult(), coverage: { state: "all", scopeDescription: "x", issues: [] } })],
  ["coverage mandatory scope", () => ({ ...emptyResult(), coverage: { state: "complete", issues: [] } })],
  ["coverage issue shape", () => ({ ...emptyResult(), coverage: { state: "partial", scopeDescription: "x", issues: ["missing"] } })],
  ["finding required fields", () => ({ ...emptyResult(), conclusion: "findings", findings: [{ sourceReferences: ["a"] }] })],
  ["finding status", () => { const r = findingResult(); r.findings[0]!.status = "certain"; return r; }],
  ["finding severity", () => { const r = findingResult(); r.findings[0]!.severity = "warning"; return r; }],
  ["reference array shape", () => ({ ...findingResult(), findings: [{ ...findingResult().findings[0], evidenceIds: "source:evidence:issued" }] })],
  ["reference element type", () => ({ ...findingResult(), findings: [{ ...findingResult().findings[0], evidenceIds: [7] }] })],
  ["reference syntax", () => findingResult("an invented reference with spaces")],
  ["unknown finding field", () => ({ ...findingResult(), findings: [{ ...findingResult().findings[0], sourceReferences: [] }] })],
  ["unknown root field", () => ({ ...emptyResult(), verdict: "fine" })],
  ["wrong limitation element", () => ({ ...findingResult(), findings: [{ ...findingResult().findings[0], limitations: [true] }] })],
  ["findings empty contradiction", () => ({ ...emptyResult(), conclusion: "findings" })],
  ["no-finding contradiction", () => ({ ...findingResult(), conclusion: "no-supported-finding" })],
  ["failed successful conclusion", () => ({ ...emptyResult(), operational: "failed" })],
  ["dependency shape", () => ({ ...emptyResult(), dependencies: [{ evidenceId: "source:evidence:issued" }] })],
  ["usage reference shape", () => ({ ...emptyResult(), usageAttemptIds: [{}] })],
  ["score shape", () => ({ ...emptyResult(), scores: [{ criterion: "correctness.requirements", value: 1 }] })],
  ["excessive findings", () => ({ ...findingResult(), findings: Array.from({ length: 65 }, () => findingResult().findings[0]) })],
  ["optional error shape", () => ({ ...emptyResult(), error: { code: "test.failure" } })],
  ["optional work interpretation shape", () => ({ ...emptyResult(), workInterpretation: { proposedState: "done" } })],
];
for (const [name, value] of malformed) test(`K09 declared structure rejects ${name}`, async () => {
  assert.equal((await declaredValidator())(value()), false);
});

test("K09 structural validation is descriptor-only, including nested enums and array entries", async () => {
  const check = await declaredValidator(); let getters = 0;
  for (const field of ["operational", "coverage"]) {
    const value = emptyResult(); Object.defineProperty(value, field, { enumerable: true, get() { getters++; return "completed"; } });
    assert.equal(check(value), false);
  }
  const nested = findingResult(); Object.defineProperty(nested.findings[0], "status", { enumerable: true, get() { getters++; return "supported"; } });
  assert.equal(check(nested), false);
  const sparse = findingResult(); Object.defineProperty(sparse.findings, "0", { get() { getters++; return findingResult().findings[0]; } });
  assert.equal(check(sparse), false); assert.equal(getters, 0);
});

test("K09 C1 unions, optional fields and explicit empty arrays remain structurally usable", async () => {
  const check = await declaredValidator();
  for (const operational of ["unavailable", "failed", "cancelled"]) assert.equal(check({ ...emptyResult(), operational, conclusion: "undetermined", error: { code: "fixture.unavailable", retryable: false } }), true);
  assert.equal(check({ ...emptyResult(), extensions: {}, workInterpretation: { proposedState: "unknown", outstandingWork: "unknown", evidenceIds: [], rationale: "No new authority" } }), true);
  const content = [{ type: "text", text: "synthetic" }, { type: "json", value: { x: null } }, { type: "image", artifactId: "synthetic-image", mimeType: "image/png", width: 1, height: 1 }];
  assert.equal(check({ ...emptyResult(), additionalEvidence: [{ id: "additional", role: "reference", required: false, content, provenance: { sourceId: "synthetic", uri: "fixture:additional", revision: "r1", acquiredAt: "2026-01-01T00:00:00Z", selection: { kind: "full" }, changedDuringRead: false }, bytes: 1, tokenEstimate: null }] }), true);
});

// Real EngineSession -> common ModelService -> ordinary core.chat -> canonical
// validation. Only the provider I/O is scripted; there is no replacement session
// or alternate public validator. Test environments are supplied before SDK imports.
async function managed(result: (ref: string) => unknown, rawText = false): Promise<{ validation: unknown; operational: unknown }> {
  const root = await mkdtemp(join(tmpdir(), "qe-c1-contract-")), agent = join(root, "agent"), project = join(root, "project");
  await mkdir(join(agent, "quality"), { recursive: true }); await mkdir(project);
  await writeFile(join(agent, "quality/evidence.md"), "VISIBLE_SYNTHETIC_358_BODY\n");
  await writeFile(join(agent, "quality/config.json"), JSON.stringify({
    schemaVersion: 1, enabled: true, mode: "observe", sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
    modelProfiles: { scripted: { provider: "fixture", model: "c1-contract", price: "unknown" } }, permissions: { modelProfiles: ["scripted"] },
    contexts: { c: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }] } },
    prompts: { p: { use: "core.prompt-files", options: { instructions: ["builtin:engineering-v1.md"], resultSchema: "builtin:evaluation-v1.schema.json" } } },
    evaluators: { e: { use: "core.chat", modelProfile: "scripted", options: { repairAttempts: 0 } } }, policies: { p: { use: "core.record-only" } },
    checks: { c: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "c", prompt: "p", evaluator: "e", policy: "p", criteria: ["correctness.requirements"], workStates: ["work-expected"], maxRunsPerEpisode: 1 } },
  }));
  let calls = 0;
  const port: ModelRegistryPort = {
    findChat: () => ({ provider: "fixture", id: "c1-contract", thinkingLevels: ["off"] }), findClassifier: () => null, hasConfiguredAuth: () => true,
    async completeChat(_model, messages) {
      calls++; const text = messages.map(m => m.content).join("\n");
      const ref = /## evidence (\S+)\n/.exec(text)?.[1]; assert.ok(ref); assert.ok(text.includes("VISIBLE_SYNTHETIC_358_BODY"));
      assert.ok(text.includes(JSON.stringify(CANONICAL_RESULT_SCHEMA)));
      const output = result(ref);
      return { text: rawText ? String(output) : JSON.stringify(output), model: { provider: "fixture", id: "c1-contract", revision: null }, usage: { input: 10, output: 10, totalTokens: 20 }, stopReason: "stop", errorCode: null };
    }, async classify() { throw new Error("unexpected classifier"); },
  };
  const session = await EngineSession.start({ observedSessionId: "contract-fixture", branchId: "unresolved", agentDir: agent, projectRoot: project, projectConfigDir: join(project, ".pi"), projectTrusted: true, hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: join(process.cwd(), "resources"), hostIdleAtStart: true, modelRegistry: port });
  try {
    assert.equal(session.status(true).configuration.rejection, null);
    const occurredAt = new Date().toISOString();
    session.handlePrimaryEvent({ type: "operator-input", text: "Assess supplied synthetic scope", source: "interactive", occurredAt });
    session.handlePrimaryEvent({ type: "tool-started", operationId: "one", toolName: "read", parentOperationId: null, occurredAt });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "one", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt });
    let record;
    for (let i = 0; i < 200; i++) { record = session.status(true).diagnostics.recentEvents.find(r => r.event === "quality.assessment.result"); if (record) break; await new Promise(r => setTimeout(r, 10)); }
    assert.ok(record); assert.equal(calls, 1);
    const diagnostics = session.status(true).diagnostics.recentEvents;
    assert.equal(diagnostics.filter(r => r.event === "quality.action.dispatched").length, 0);
    assert.ok(!JSON.stringify(diagnostics).includes("PRIVATE_RESULT_358_PROSE"));
    return { validation: record.fields.data["validationState"], operational: record.fields.data["operational"] };
  } finally {
    await session.retire("quit");
    const accounting = session.status(true).accounting; assert.ok(accounting); assert.equal(accounting.unresolvedCount, 0);
    await rm(root, { recursive: true, force: true });
  }
}

test("K09 ordinary core.chat accepts a contract-derived finding with actual issued references", async () => {
  assert.deepEqual(await managed(ref => findingResult(ref)), { validation: "valid", operational: "completed" });
});
test("K09 a structurally correct but nonexistent reference still fails contextual C1 validation", async () => {
  assert.equal((await declaredValidator())(findingResult("source:evidence:nonexistent")), true);
  assert.deepEqual(await managed(() => findingResult("source:evidence:nonexistent")), { validation: "invalid", operational: "failed" });
});
test("K09 structural failure stays failed, not a coerced clean result", async () => {
  assert.deepEqual(await managed(() => ({ ...emptyResult(), coverage: { state: "complete" } })), { validation: "invalid", operational: "failed" });
});
test("K09 contextual criterion and score-range checks remain stricter than structural syntax", async () => {
  const wrongCriterion = () => ({ ...findingResult(), findings: [{ ...findingResult().findings[0], criterion: "undeclared.criterion" }] });
  assert.equal((await declaredValidator())(wrongCriterion()), true);
  assert.deepEqual(await managed(wrongCriterion), { validation: "invalid", operational: "failed" });
  const score = { criterion: "correctness.requirements", kind: "numeric", value: 2, minimum: 0, maximum: 1, interpretation: "not a calibrated probability", calibrationRef: null };
  assert.equal((await declaredValidator())({ ...emptyResult(), scores: [score] }), true);
  assert.deepEqual(await managed(() => ({ ...emptyResult(), scores: [score] })), { validation: "invalid", operational: "failed" });
});
test("K09 ordinary core.chat preserves valid empty/optional and operational-limited states", async () => {
  assert.deepEqual(await managed(() => ({ ...emptyResult(), extensions: {}, workInterpretation: { proposedState: "unknown", outstandingWork: "unknown", evidenceIds: [], rationale: "No authority" } })), { validation: "valid", operational: "completed" });
  assert.deepEqual(await managed(() => ({ ...emptyResult(), operational: "unavailable", conclusion: "undetermined", error: { code: "fixture.unavailable", retryable: false } })), { validation: "valid", operational: "unavailable" });
});
test("K09 parsing does not extract convenient JSON from unrelated prose", async () => {
  // core.chat emits a valid operational-failure envelope for unparsable model
  // text; that is not acceptance of the enclosed JSON as a clean assessment.
  assert.deepEqual(await managed(() => "```json\n" + JSON.stringify(emptyResult()) + "\n```", true), { validation: "valid", operational: "failed" });
});
