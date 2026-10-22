import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EngineSession } from "../src/runtime.js";
import type { AssessmentResult, DecisionQuestion, PromptDefinition, DiagnosticRecordV1, ContextItem, EvaluatorDefinition } from "../src/contracts.js";
import type { ModelRegistryPort } from "../src/models.js";

export const criteria = { progressing: "Relevant progress", repeating: "Ineffective repetition", waiting: "Known operation", unclear: "Insufficient evidence" };
export const questions: Record<string, DecisionQuestion> = { progress: { type: "choice", instructions: "QUESTION_BODY_376", criteria } };
export const progress = (choice = "progressing") => ({ progress: { type: "choice", choice, probabilities: Object.fromEntries(Object.keys(criteria).map(k => [k, k === choice ? 1 : 0])), confidence: 0.61 } });

export async function fixture(options: { answers?: Record<string, unknown>; body?: string; questionSet?: Record<string, DecisionQuestion>; evaluator?: string; evaluatorOptions?: object; extraItems?: ContextItem[]; evaluatorDefinition?: EvaluatorDefinition; plan?: object; instruction?: string; chatOutput?: string; registry?: ModelRegistryPort; includeHistory?: boolean; afterRegister?: () => void; resultSchema?: import("../src/contracts.js").AssessmentResources["resultSchema"]; extraCoverage?: "complete" | "partial" } = {}) {
  const root = await mkdtemp(join(tmpdir(), "qe-typed-376-"));
  const agentDir = join(root, "agent"), projectRoot = join(root, "project");
  await mkdir(join(agentDir, "quality"), { recursive: true }); await mkdir(projectRoot);
  for (const [name, body] of Object.entries({ "task.md": "TASK_BODY_376", "rules.md": "REQUIREMENT_BODY_376", "code.txt": options.body ?? "IMPLEMENTATION_BODY_376", "oracle.txt": "EXCLUDED_GRADER_376" })) await writeFile(join(agentDir, "quality", name), body);
  await writeFile(join(agentDir, "quality/config.json"), JSON.stringify({ schemaVersion: 1, enabled: true, mode: "observe", runtime: { unknownCost: "allow-with-token-limits" },
    sources: { task: { uris: ["task.md"], role: "evidence", required: true }, rules: { uris: ["rules.md"], role: "requirement", required: true }, code: { uris: ["code.txt"], role: "evidence", required: true }, oracle: { uris: ["oracle.txt"], role: "reference" } },
    modelProfiles: { typed: { provider: "fixture", model: "typed", price: "unknown" } }, permissions: { modelProfiles: ["typed"] },
    prompts: { typed: { use: "fixture.typed-prompt" } }, contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["task", "rules", "code"] } }, ...(options.extraItems === undefined ? [] : [{ id: "extra", use: "fixture.extra" }]), ...(options.includeHistory ? [{ id: "history", use: "core.history", options: { limit: 8 } }] : [])], maxEstimatedTokens: 8000, reserveOutputTokens: 0, ...(options.plan ?? {}) } },
    evaluators: { typed: { use: options.evaluatorDefinition?.id ?? options.evaluator ?? "core.classifier", ...(options.evaluatorDefinition?.mechanism === "deterministic" ? {} : { modelProfile: "typed" }), options: options.evaluatorOptions ?? {} } }, policies: { record: { use: "fixture.capture" } },
    checks: { typed: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "typed", evaluator: "typed", policy: "record", criteria: ["task.instructions"], cooldownMs: 0, workStates: ["work-expected"] } } }));
  const calls: Array<{ state: Record<string, unknown>; questions: Record<string, unknown>; options: Record<string, unknown>; signal: AbortSignal }> = [];
  const chatCalls: Array<{ messages: unknown; options: unknown }> = [];
  const port: ModelRegistryPort = { findChat: () => ({ provider: "fixture", id: "typed", input: ["text"], contextWindow: 64000, maxTokens: 8192 }), findClassifier: () => ({ type: "classifier", provider: "fixture", id: "typed", input: ["text"], contextWindow: 64000 }), hasConfiguredAuth: () => true,
    completeChat: async (_model, messages, requestOptions) => { chatCalls.push({ messages, options: requestOptions }); return { text: options.chatOutput ?? "invalid", model: { provider: "fixture", id: "typed", revision: null }, usage: { input: 60, output: 30, totalTokens: 90 }, stopReason: "stop", errorCode: null }; }, classify: async (_model, state, qs, opts, signal) => { calls.push({ state, questions: qs, options: opts, signal }); return { answers: options.answers ?? progress(), model: { provider: "fixture", id: "typed", revision: null }, usage: { input: 60, output: 0, totalTokens: 60 }, stopReason: "stop", errorMessage: null }; } };
  const captured: AssessmentResult[] = [];
  const session = await EngineSession.start({ observedSessionId: `typed-${Date.now()}-${Math.random().toString(16).slice(2)}`, branchId: "unresolved", agentDir, projectRoot, projectConfigDir: join(projectRoot, ".pi"), projectTrusted: true, hostVersion: "1.1.0", hostMode: "rpc", hostIdleAtStart: true, resourcesDir: join(process.cwd(), "resources"), modelRegistry: options.registry ?? port });
  const prompt: PromptDefinition = { id: "fixture.typed-prompt", apiMajor: 1, kind: "prompt", optionsSchema: { type: "object" }, requiredCapabilities: [], diagnosticCodes: [], build: async () => ({ ok: true, value: { resourceRevision: "typed-fixture-v1", instructions: [{ id: "instruction-376", role: "requirement", required: true, content: [{ type: "text", text: options.instruction ?? "INSTRUCTION_BODY_376" }], provenance: { sourceId: "fixture.prompt", uri: "fixture:typed", revision: "revision-376", acquiredAt: new Date().toISOString(), selection: { kind: "full" }, changedDuringRead: false }, bytes: 20, tokenEstimate: null }], questions: options.questionSet ?? questions, resultSchema: options.resultSchema ?? { type: "object" }, criteria: ["task.instructions"] } }) };
  const registration = session.endpoint.register({ id: "fixture.typed-package", version: "1", baseUri: "fixture:typed", resources: {}, components: [...(options.evaluatorDefinition === undefined ? [] : [options.evaluatorDefinition]), ...(options.extraItems === undefined ? [] : [{ id: "fixture.extra", apiMajor: 1 as const, kind: "context" as const, produces: ["text", "json", "image"] as const, optionsSchema: { type: "object" }, requiredCapabilities: [], diagnosticCodes: [], collect: async () => ({ ok: true as const, value: { items: options.extraItems ?? [], coverage: { state: options.extraCoverage ?? "complete" as const, scopeDescription: "Owned synthetic data", issues: options.extraCoverage === "partial" ? [{ sourceId: "fixture.extra", reason: "core.context-partial", required: true, evidenceIds: [] }] : [] }, dependencies: [] } }) }]), prompt, { id: "fixture.capture", apiMajor: 1, kind: "policy", optionsSchema: { type: "object" }, requiredCapabilities: [], diagnosticCodes: [], decide: (_o, input) => { captured.push(input.result); return { outcome: "no-action", reasonCode: "record-only", actions: [] }; } }] });
  assert.ok(registration.ok); if (registration.ok) await registration.value.ready;
  options.afterRegister?.();
  session.handlePrimaryEvent({ type: "operator-input", text: "synthetic scoped task", source: "interactive", occurredAt: new Date().toISOString() });
  session.handlePrimaryEvent({ type: "tool-started", operationId: "read-1", toolName: "read", parentOperationId: null, occurredAt: new Date().toISOString() });
  session.handlePrimaryEvent({ type: "tool-completed", operationId: "read-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: new Date().toISOString() });
  for (let i = 0; i < 200 && captured.length === 0 && session.status(true).configuration.rejection === null; i++) await new Promise(r => setTimeout(r, 10));
  await writeFile(join(root, "fixture-status.json"), JSON.stringify(session.status(true)));
  const status = session.status(true);
  await session.retire("quit");
  const records: DiagnosticRecordV1[] = [];
  for (const file of await readdir(join(agentDir, "quality/logs")).catch((error: unknown) => { if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return []; throw error; })) if (file.endsWith(".jsonl")) for (const line of (await readFile(join(agentDir, "quality/logs", file), "utf8")).trim().split("\n")) if (line) records.push(JSON.parse(line) as DiagnosticRecordV1);
  return { root, session, calls, chatCalls, captured, records, status };
}

test("376 F1 actual selected bodies/instructions/questions reach ordinary classify", async () => {
  const f = await fixture(); try { assert.equal(f.calls.length, 1); const sent = JSON.stringify(f.calls[0]); for (const marker of ["TASK_BODY_376", "REQUIREMENT_BODY_376", "IMPLEMENTATION_BODY_376", "INSTRUCTION_BODY_376", "QUESTION_BODY_376"]) assert.ok(sent.includes(marker), `missing ${marker}`); assert.ok(!sent.includes("EXCLUDED_GRADER_376")); } finally { await f.session.retire("quit"); }
});
test("376 F2 complete SDK context is measured, no fictitious classifier output allowance", async () => {
  const f = await fixture(); try { assert.equal(f.calls.length, 1); const dispatch = f.records.find(e => e.event === "quality.model.dispatched")?.fields.data; assert.ok(dispatch); assert.equal(dispatch["maxOutputTokens"], 0); const manifest = f.records.find(e => e.event === "quality.context.manifest" && e.fields.data["boundary"] === "sdk-input")?.fields.data; assert.ok(manifest); const sizes = manifest["sizes"] as Array<{ utf8Bytes: number }>; assert.equal(sizes[0]?.utf8Bytes, Buffer.byteLength(JSON.stringify({ state: f.calls[0]?.state, questions: f.calls[0]?.questions }))); assert.ok((sizes[0]?.utf8Bytes ?? 0) > 0); } finally { await f.session.retire("quit"); }
});
test("376 F3 empty normalized answers never become a clean negative", async () => {
  const f = await fixture({ answers: {} }); try { assert.equal(f.calls.length, 1); assert.equal(f.captured[0]?.operational, "failed"); assert.equal(f.captured[0]?.conclusion, "undetermined"); assert.equal(f.status.accounting?.ownedRequestCount, 1); } finally { await f.session.retire("quit"); }
});
