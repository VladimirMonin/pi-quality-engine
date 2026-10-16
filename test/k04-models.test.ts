import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngineSession } from "../src/runtime.js";
import { ModelService, normalizeUsage } from "../src/models.js";
import type { ChatTransportResult, ClassifierTransportResult, ModelRegistryPort } from "../src/models.js";
import type { AssessmentResult, AssessmentResources, PackageDefinition, PromptDefinition } from "../src/contracts.js";

const MODELS = { provider: "fixture", id: "scripted-1", revision: "rev-1" };

interface ScriptedPort extends ModelRegistryPort {
  chatCalls: number;
  classifierCalls: number;
  lastMessages: string;
}

function scriptedPort(overrides: {
  chatText?: string;
  chatTexts?: string[];
  classification?: Record<string, unknown>;
  usage?: Record<string, unknown> | null;
  errorCode?: string | null;
} = {}): ScriptedPort {
  const port: ScriptedPort = {
    chatCalls: 0,
    classifierCalls: 0,
    lastMessages: "",
    findChat: () => ({ provider: MODELS.provider, model: MODELS.id, thinkingLevels: ["off"] }),
    findClassifier: () => ({ provider: MODELS.provider, model: MODELS.id }),
    hasConfiguredAuth: () => true,
    async completeChat(model, messages): Promise<ChatTransportResult> {
      port.chatCalls += 1;
      port.lastMessages = messages.map(message => message.content).join("\n");
      const index = port.chatCalls - 1;
      return {
        text: overrides.chatTexts?.[index] ?? overrides.chatText ?? JSON.stringify(noFinding()),
        model: MODELS,
        usage: overrides.usage === undefined ? { input: 100, output: 50, cacheRead: 80, cacheWrite: 0, totalTokens: 150, reasoning: 20 } : overrides.usage,
        stopReason: overrides.errorCode == null ? "stop" : "error",
        errorCode: overrides.errorCode ?? null,
      };
    },
    async classify(): Promise<ClassifierTransportResult> {
      port.classifierCalls += 1;
      return {
        answers: overrides.classification ?? { progress: { type: "choice", choice: "progressing", probabilities: {}, confidence: 0.9 } },
        model: MODELS,
        usage: { input: 40, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 45 },
        stopReason: "stop",
        errorMessage: null,
      };
    },
  };
  return port;
}

function noFinding(): AssessmentResult {
  return {
    operational: "completed",
    coverage: { state: "complete", scopeDescription: "Scripted direct assessment.", issues: [] },
    conclusion: "no-supported-finding",
    findings: [],
    scores: [],
    additionalEvidence: [],
    dependencies: [],
    usageAttemptIds: [],
  };
}

async function startModelSession(options: {
  root: string;
  port: ModelRegistryPort;
  evaluatorUse: "core.chat" | "core.classifier";
  runtime?: object;
  checkCount?: number;
  contextProviders?: object[];
  promptBinding?: object;
  promptComponents?: PromptDefinition[];
  evaluatorOptions?: object;
  checks?: object;
}): Promise<{ session: EngineSession; captured: { questions: AssessmentResources["questions"] } }> {
  const agentDir = join(options.root, "agent");
  const projectRoot = join(options.root, "project");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(join(projectRoot, ".pi"), { recursive: true });
  // The source is declared in the user configuration file, so its relative
  // path resolves against the declaring directory (agent quality dir).
  await writeFile(join(agentDir, "quality", "evidence.md"), "direct-marker-evidence\n", "utf8");
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "observe",
    runtime: options.runtime ?? {},
    sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
    modelProfiles: { scripted: { provider: "fixture", model: "scripted-1", price: "unknown" } },
    permissions: { modelProfiles: ["scripted"] },
    prompts: options.promptBinding ?? { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: options.contextProviders ?? [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
    evaluators: { direct: { use: options.evaluatorUse, modelProfile: "scripted", ...(options.evaluatorOptions === undefined ? {} : { options: options.evaluatorOptions }) } },
    policies: { record: { use: "core.record-only" } },
    checks: options.checks ?? {
      direct: {
        triggers: [{ id: "due", use: "core.every-tools", options: { count: options.checkCount ?? 1 } }],
        context: "work",
        prompt: options.promptBinding === undefined ? "repetition" : "questions",
        evaluator: "direct",
        policy: "record",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
        workStates: ["work-expected"],
        maxRunsPerEpisode: 4,
      },
    },
  }), "utf8");
  const captured = { questions: null as AssessmentResources["questions"] };
  const session = await EngineSession.start({
    observedSessionId: `sess-${Date.now()}-${Math.round(performance.now())}`,
    branchId: "unresolved",
    agentDir,
    projectRoot,
    projectConfigDir: join(projectRoot, ".pi"),
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: join(process.cwd(), "resources"),
    hostIdleAtStart: true,
    modelRegistry: options.port,
  });
  if (options.promptComponents !== undefined) {
    const definition: PackageDefinition = { id: "fixture.questions-pkg", version: "0.1.0", baseUri: "fixture:questions", components: options.promptComponents, resources: {} };
    const registered = session.endpoint.register(definition);
    assert.equal(registered.ok, true);
    if (registered.ok) await registered.value.ready;
  }
  return { session, captured };
}

function drive(session: EngineSession, id = "t1"): void {
  session.handlePrimaryEvent({ type: "operator-input", text: "assess", source: "interactive", occurredAt: new Date().toISOString() });
  session.handlePrimaryEvent({ type: "tool-started", operationId: id, toolName: "read", parentOperationId: null, occurredAt: new Date().toISOString() });
  session.handlePrimaryEvent({ type: "tool-completed", operationId: id, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: new Date().toISOString() });
}

async function settle(ms = 150): Promise<void> {
  await new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

test("K04-T05/T07 core.chat dispatches through the owned service and normalizes usage without double counting", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-chat-"));
  const port = scriptedPort();
  const { session } = await startModelSession({ root, port, evaluatorUse: "core.chat" });
  try {
    drive(session);
    await settle();
    assert.equal(port.chatCalls, 1, "one dispatched owned attempt");
    assert.ok(port.lastMessages.includes("direct-marker-evidence"), "the selected evidence reached the transport boundary");
    const status = session.status(true);
    assert.equal(status.checks.runs, 1);
    const settled = status.diagnostics.recentEvents.find(record => record.event === "quality.model.settled")?.fields.data as Record<string, unknown> | undefined;
    assert.ok(settled !== undefined, "settlement is projected");
    const settledUsage = settled["usage"] as Record<string, unknown> | null;
    const settledCost = settled["cost"] as Record<string, unknown> | null;
    assert.equal(settledUsage?.["totalTokens"], 150);
    assert.equal(settledUsage?.["coverage"], "complete");
    assert.equal(settledCost?.["amount"] ?? null, null, "unknown price stays unknown, not zero");
    assert.equal(settledCost?.["basis"], "unknown");
    assert.equal(status.accounting?.ownedRequestCount, 1);
    assert.equal(status.accounting?.usageKnownCount, 1);
    assert.equal(status.accounting?.normalizedTokens.total, 150, "cache tokens are not added to the inclusive input total again");
    assert.equal(status.accounting?.costByCurrency.length, 0, "unknown-cost attempts are not reported as a zero charge");
  } finally {
    await session.retire("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-T05 a denied budget makes zero provider calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-budget-"));
  const port = scriptedPort();
  const { session } = await startModelSession({ root, port, evaluatorUse: "core.chat", runtime: { maxRequestsPerSession: 1 } });
  try {
    drive(session, "t1");
    await settle();
    assert.equal(port.chatCalls, 1);
    // A second admitted run cannot dispatch because the request allowance is spent.
    drive(session, "t2");
    await settle();
    assert.equal(port.chatCalls, 1, "no provider call follows a budget denial");
    const events = session.status(true).diagnostics.recentEvents;
    const denied = events.some(record => record.event === "quality.budget.denied")
      || events.some(record => record.event === "quality.check.settled"
        && record.fields.reasonCodes.includes("core.budget-requests-exhausted"));
    assert.ok(denied, "the denial is observable as budget or settlement evidence");
  } finally {
    await session.retire("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-T05 core.classifier maps typed answers and keeps suspicions unconfirmed", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-classifier-"));
  const port = scriptedPort({ classification: { progress: { type: "choice", choice: "repeating", probabilities: { repeating: 0.8 }, confidence: 0.8 } } });
  const questionsPrompt: PromptDefinition = {
    id: "fixture.questions",
    apiMajor: 1,
    kind: "prompt",
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: [],
    async build(_options, ctx) {
      return {
        ok: true,
        value: {
          resourceRevision: "questions-v1",
          instructions: [{
            id: "fixture.instructions",
            role: "reference",
            required: true,
            content: [{ type: "text", text: "Classify the supplied progress evidence." }],
            provenance: { sourceId: "fixture.questions", uri: "fixture:instructions", revision: "questions-v1", acquiredAt: new Date().toISOString(), selection: { kind: "full" }, changedDuringRead: false },
            bytes: 40,
            tokenEstimate: null,
          }],
          questions: {
            progress: { type: "choice", instructions: "Is progress visible?", criteria: { progressing: "yes", repeating: "no", waiting: "waiting", unclear: "unknown" } },
          },
          resultSchema: true,
          criteria: [...ctx.run ? ["efficiency.repetition"] : []],
        },
      };
    },
  };
  const { session } = await startModelSession({
    root,
    port,
    evaluatorUse: "core.classifier",
    promptBinding: { questions: { use: "fixture.questions", options: {} } },
    promptComponents: [questionsPrompt],
  });
  try {
    drive(session);
    await settle();
    assert.equal(port.classifierCalls, 1);
    const result = session.status(true).diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data as Record<string, unknown> | undefined;
    assert.ok(result !== undefined);
    assert.equal(result["conclusion"], "findings");
    const findings = result["findings"] as Array<Record<string, unknown>>;
    assert.equal(findings[0]?.["status"], "suspected");
    assert.equal(findings[0]?.["defectCode"], "efficiency.progress");
  } finally {
    await session.retire("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-T07 late usage reconciles an unresolved attempt exactly once", async () => {
  const never: ModelRegistryPort = {
    findChat: () => ({ provider: "fixture", model: "scripted-1" }),
    findClassifier: () => null,
    hasConfiguredAuth: () => true,
    completeChat: () => new Promise<ChatTransportResult>(() => undefined),
    classify: () => new Promise<ClassifierTransportResult>(() => undefined),
  };
  const service = new ModelService({
    profiles: { scripted: { provider: "fixture", model: "scripted-1", reasoning: "off", requestTimeoutMs: 5_000, maxAttempts: 1, retryDelayMs: 0, maxOutputTokens: 1_024, price: "unknown", requiredInputs: ["text"] } },
    approved: ["scripted"],
    registry: never,
    budget: { maxRequestsPerSession: 10, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  const controller = new AbortController();
  const first = await service.dispatch({ runId: "run-1", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: controller.signal });
  assert.equal(first.ok, false);
  const attemptId = service.attempts[0]?.attemptId ?? "";
  assert.equal(service.attempt(attemptId)?.state, "unresolved");
  assert.equal(service.reconcile(attemptId, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, "final"), true);
  assert.equal(service.reconcile(attemptId, { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15 }, "final"), true);
  const attempt = service.attempt(attemptId);
  assert.equal(attempt?.state, "settled");
  assert.equal(attempt?.usageRevision, 2, "each admissible reconciliation advances the revision once");
  assert.equal(attempt?.usage?.totalTokens, 15);
  const normalized = normalizeUsage({ input: 100, output: 50, cacheRead: 80, cacheWrite: 0, totalTokens: 150, reasoning: 20 }, 1, "final");
  assert.equal(normalized.uncachedInputTokens, 20);
  assert.equal(normalized.outputTokens, 50);
  assert.equal(normalized.reasoningTokens, 20);
  assert.equal(normalized.outputIncludesReasoning, true);
});

test("K04-T06 a configured repair is a separately accounted attempt on the same route", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-repair-"));
  const port = scriptedPort({ chatTexts: ["not-json", JSON.stringify(noFinding())] });
  const { session } = await startModelSession({ root, port, evaluatorUse: "core.chat", evaluatorOptions: { repairAttempts: 1 } });
  try {
    drive(session);
    await settle();
    assert.equal(port.chatCalls, 2, "the malformed result triggered exactly one repair dispatch");
    assert.ok(port.lastMessages.includes("previous response was not valid structured output"), "the repair request is bounded and identified");
    const status = session.status(true);
    assert.equal(status.accounting?.ownedRequestCount, 2);
    assert.equal(status.accounting?.byPurpose["repair"], 1, "the repair attempt is separately accounted");
    const settled = status.diagnostics.recentEvents.filter(record => record.event === "quality.check.settled");
    assert.equal(settled.length, 1);
    assert.equal(status.checks.runs, 1);
  } finally {
    await session.retire("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-T06 an invented evidence reference stays invalid while usage is accounted", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-invalid-"));
  const invented: AssessmentResult = {
    ...noFinding(),
    conclusion: "findings",
    findings: [{
      id: "invented-1",
      criterion: "efficiency.repetition",
      status: "supported",
      severity: "concern",
      requirementRefs: [],
      evidenceIds: ["evidence-does-not-exist"],
      affectedItems: [],
      defectCode: "architecture.invented",
      explanation: "Cited evidence that was never issued.",
      proposedCorrection: null,
      limitations: [],
    }],
  };
  const port = scriptedPort({ chatText: JSON.stringify(invented) });
  const { session } = await startModelSession({ root, port, evaluatorUse: "core.chat" });
  try {
    drive(session);
    await settle();
    assert.equal(port.chatCalls, 1);
    const status = session.status(true);
    assert.equal(status.accounting?.ownedRequestCount, 1, "the invalid attempt is still billed");
    const result = status.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data as Record<string, unknown> | undefined;
    assert.ok(result !== undefined);
    assert.notEqual(result["conclusion"], "findings", "an invented reference cannot become a supported finding");
  } finally {
    await session.retire("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-T06/T09 transport errors are operational failures and error sentinels stay out of diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-error-"));
  const sentinel = "QE_PRIVATE_MODEL_ERROR_CANARY";
  const port = scriptedPort({ errorCode: `core.model-provider-error` });
  const original = port.completeChat.bind(port);
  port.completeChat = async (model, messages, options, signal) => {
    const result = await original(model, messages, options, signal);
    return { ...result, text: `provider failed ${sentinel}` };
  };
  const { session } = await startModelSession({ root, port, evaluatorUse: "core.chat" });
  try {
    drive(session);
    await settle();
    const status = session.status(true);
    assert.equal(status.accounting?.ownedRequestCount, 1, "a failed request still has an owned attempt");
    const surface = JSON.stringify(status);
    assert.equal(surface.includes(sentinel), false, "raw provider error text is not projected");
    const result = status.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data as Record<string, unknown> | undefined;
    assert.ok(result !== undefined);
    assert.equal(result["operational"], "failed");
    assert.equal(result["conclusion"], "undetermined");
  } finally {
    await session.retire("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-T08 competing checks share one reservation allowance", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-shared-"));
  const port = scriptedPort();
  const { session } = await startModelSession({
    root,
    port,
    evaluatorUse: "core.chat",
    runtime: { maxRequestsPerSession: 1 },
    contextProviders: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }],
    checks: {
      first: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 },
      second: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 },
    },
  });
  try {
    drive(session, "shared-1");
    await settle();
    assert.equal(port.chatCalls, 1, "the shared allowance admits only one competing dispatch");
    const status = session.status(true);
    assert.equal(status.accounting?.ownedRequestCount, 1);
    const denied = status.diagnostics.recentEvents.some(record => record.event === "quality.budget.denied")
      || status.diagnostics.recentEvents.some(record => record.event === "quality.check.settled" && record.fields.reasonCodes.includes("core.budget-requests-exhausted"));
    // The bounded status window can legitimately evict the denial once repeated
    // per-segment descriptors fill it; the physical journal is the complete
    // receipt oracle for the same explicit-denial predicate.
    let journalDenied = false;
    if (!denied) {
      const logs = join(root, "agent", "quality", "logs");
      try {
        const { readdir, readFile } = await import("node:fs/promises");
        for (const name of (await readdir(logs)).filter(entry => entry.endsWith(".jsonl"))) {
          const text = await readFile(join(logs, name), "utf8");
          for (const line of text.split(String.fromCharCode(10))) {
            if (line.trim().length === 0) continue;
            const record = JSON.parse(line) as { event?: string; fields?: { reasonCodes?: string[] } };
            if (record.event === "quality.budget.denied"
              || (record.event === "quality.check.settled" && (record.fields?.reasonCodes ?? []).includes("core.budget-requests-exhausted"))) journalDenied = true;
          }
        }
      } catch {
        journalDenied = false;
      }
    }
    assert.ok(denied || journalDenied, "the competing admission observes an explicit denial");
  } finally {
    await session.retire("quit");
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-B.10 actual selected-kind input capability is admitted before dispatch", async () => {
  const compatibleCalls = { count: 0 };
  const compatible = servicePort({ calls: compatibleCalls });
  const deniedCalls = { count: 0 };
  const incompatible = servicePort({ calls: deniedCalls });
  const originalFindChat = incompatible.findChat.bind(incompatible);
  incompatible.findChat = () => ({ ...(originalFindChat("fixture", "scripted-1") ?? {}), input: ["image"] });

  const deniedService = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: incompatible,
    budget: { maxRequestsPerSession: 10, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  const deniedResult = await deniedService.dispatch({ runId: "r1", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  assert.equal(deniedResult.ok, false);
  if (!deniedResult.ok) assert.equal(deniedResult.error.code, "core.model-input-unsupported");
  assert.equal(deniedCalls.count, 0, "incompatible actual route input must not reach provider dispatch");
  assert.equal(deniedService.attempts.length, 0, "no dispatched owned attempt or lingering reservation");

  const supportedService = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: compatible,
    budget: { maxRequestsPerSession: 10, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  const supportedResult = await supportedService.dispatch({ runId: "r2", profileId: "scripted", kind: "chat", messages: [{ role: "user", content: "useful text input" }], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  assert.equal(supportedResult.ok, true);
  assert.equal(compatibleCalls.count, 1, "a genuinely supported actual input still dispatches exactly one useful request");
});

function servicePort(overrides: { calls: { count: number }; cost?: Record<string, number>; reasoning?: boolean; contextWindow?: number; maxTokens?: number; usage?: Record<string, unknown>; stopReason?: string; errorCode?: string | null } = { calls: { count: 0 } }): ModelRegistryPort {
  return {
    findChat: () => ({ provider: "fixture", model: "scripted-1", reasoning: overrides.reasoning ?? true, thinkingLevels: overrides.reasoning === false ? null : ["off", "high"], cost: overrides.cost ?? { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 }, ...(overrides.contextWindow === undefined ? {} : { contextWindow: overrides.contextWindow }), ...(overrides.maxTokens === undefined ? {} : { maxTokens: overrides.maxTokens }) }),
    findClassifier: () => null,
    hasConfiguredAuth: () => true,
    async completeChat(): Promise<ChatTransportResult> {
      overrides.calls.count += 1;
      return { text: JSON.stringify(noFinding()), model: MODELS, usage: overrides.usage ?? { input: 100, output: 125, cacheRead: 80, cacheWrite: 0, totalTokens: 225, reasoning: 25 }, stopReason: overrides.stopReason ?? "stop", errorCode: overrides.errorCode ?? null };
    },
    async classify(): Promise<ClassifierTransportResult> {
      overrides.calls.count += 1;
      return { answers: {}, model: MODELS, usage: null, stopReason: "stop", errorMessage: null };
    },
  };
}

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "fixture", model: "scripted-1", reasoning: "off", requestTimeoutMs: 30_000,
    maxAttempts: 1, retryDelayMs: 0, maxOutputTokens: 4_096,
    price: { currency: "USD", revision: "oracle-1", inputPerMillion: "3.0", outputPerMillion: "1.20", cacheReadPerMillion: "0.25", cacheWritePerMillion: "0" },
    requiredInputs: ["text"], ...overrides,
  };
}

test("K04-R6/R7 unsupported reasoning and a known USD cap deny before provider dispatch", async () => {
  const noReasoning = servicePort({ calls: { count: 0 }, reasoning: false });
  const refusing = new ModelService({
    profiles: { scripted: profile({ reasoning: "high" }) as never },
    approved: ["scripted"], registry: noReasoning,
    budget: { maxRequestsPerSession: 10, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  const denied = await refusing.dispatch({ runId: "r1", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "core.model-reasoning-unsupported");
  assert.equal(noReasoning.findChat !== undefined && refusing.attempts.length, 0);
  assert.equal((noReasoning as { completeChat: unknown }) !== undefined, true);

  const calls = { count: 0 };
  const capped = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 10, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: { currency: "USD", amount: "0.000001" } },
  });
  const capDenied = await capped.dispatch({ runId: "r2", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 4_096, estimatedInputTokens: 50, signal: new AbortController().signal });
  assert.equal(capDenied.ok, false);
  if (!capDenied.ok) assert.equal(capDenied.error.code, "core.budget-cost-exceeded");
  assert.equal(calls.count, 0, "no provider call follows a pre-dispatch money denial");
});

test("K04-T07/R8 literal accounting oracle, partitions, revisions and protected restore", async () => {
  const calls = { count: 0 };
  const service = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 1, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  const first = await service.dispatch({ runId: "run-1", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  assert.equal(first.ok, true);
  const attempt = service.attempts[0];
  assert.ok(attempt !== undefined);
  assert.equal(attempt?.usage?.totalTokens, 225);
  assert.equal(attempt?.usage?.uncachedInputTokens, 20, "cache counters are subsets, never added twice");
  assert.equal(attempt?.usage?.reasoningTokens, 25, "reasoning is an informational subset of output");
  assert.equal(attempt?.cost?.amount, "0.00023", "literal 225-token USD oracle: 20x3.00 + 80x0.25 + 125x1.20 per million = 0.000230");
  assert.equal(attempt?.cost?.currency, "USD");

  // A new service restores the protected financial facts and may only constrain.
  const restored = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 1, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  restored.restore(service.financialSnapshot());
  assert.equal(restored.summary().ownedRequestCount, 1, "restored owned request total survives");
  const second = await restored.dispatch({ runId: "run-2", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  assert.equal(second.ok, false);
  if (!second.ok) assert.equal(second.error.code, "core.budget-requests-exhausted");
  assert.equal(calls.count, 1, "restoration cannot refund the spent allowance");

  // Revision replacement: provisional then final replaces once; duplicates are ignored.
  assert.equal(service.reconcile(attempt?.attemptId ?? "", { input: 100, output: 125, cacheRead: 80, cacheWrite: 0, totalTokens: 225, reasoning: 25 }, "final"), true);
  const afterFinal = service.attempt(attempt?.attemptId ?? "");
  assert.equal(afterFinal?.usageRevision, 2);
  assert.equal(afterFinal?.usage?.totalTokens, 225);
});

test("K04-R8a protected intent is committed before any transport arrival", async () => {
  const calls = { count: 0 };
  const service = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  let observedAttemptAtIntent = false;
  const denied = await service.dispatch({
    runId: "r-intent", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50,
    signal: new AbortController().signal,
    onIntent: attempt => {
      observedAttemptAtIntent = attempt.state === "dispatched" && attempt.reservedTokens > 0;
      return false;
    },
  });
  assert.equal(observedAttemptAtIntent, true, "the reserved attempt exists at the intent boundary");
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "core.financial-intent-unsafe");
  assert.equal(calls.count, 0, "unsafe persistence must suspend the dependent request");
  assert.equal(service.summary().ownedRequestCount, 0, "an un-dispatched reservation is released, never free spending");

  const allowed = await service.dispatch({
    runId: "r-intent-ok", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50,
    signal: new AbortController().signal,
    onIntent: () => true,
  });
  assert.equal(allowed.ok, true);
  assert.equal(calls.count, 1);
});

test("K04-R8b a restored attempt identity is never reused and prior totals are preserved", async () => {
  const calls = { count: 0 };
  const first = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  await first.dispatch({ runId: "run-a", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  const restored = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  restored.restore(first.financialSnapshot());
  const second = await restored.dispatch({ runId: "run-b", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  assert.equal(second.ok, true);
  const ids = restored.attempts.map(attempt => attempt.attemptId);
  assert.equal(new Set(ids).size, ids.length, "restored and new attempts keep distinct identities");
  assert.equal(restored.summary().ownedRequestCount, 2);
  assert.equal(restored.summary().normalizedTokens.total, 450, "two requests total twice the per-request usage, never one request");
  assert.equal(restored.attempt("attempt-1")?.usage?.totalTokens, 225, "the restored receipt is not overwritten");
});

test("K04-R7b an unmatched-currency tariff with unknownCost deny is denied before dispatch", async () => {
  const calls = { count: 0 };
  const eur = profile({ price: { currency: "EUR", revision: "eur-1", inputPerMillion: "1", outputPerMillion: "2", cacheReadPerMillion: "0.25", cacheWritePerMillion: "0" } }) as never;
  const service = new ModelService({
    profiles: { scripted: eur },
    approved: ["scripted"], registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "deny", maxOwnedCost: { currency: "USD", amount: "0.000001" } },
  });
  const result = await service.dispatch({ runId: "run-eur", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "core.budget-unknown-cost-denied");
  assert.equal(calls.count, 0, "no invented FX conversion or zero-cost admission");
});

test("K04-R6b actual context/output ceilings are enforced before dispatch", async () => {
  const calls = { count: 0 };
  const overflow = new ModelService({
    profiles: { scripted: profile({ maxOutputTokens: 128 }) as never },
    approved: ["scripted"], registry: servicePort({ calls, contextWindow: 64, maxTokens: 8192 }),
    budget: { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  const denied = await overflow.dispatch({ runId: "run-ctx", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 128, estimatedInputTokens: 8, signal: new AbortController().signal });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "core.model-context-overflow");
  assert.equal(calls.count, 0, "an overflowing request never reaches the provider");

  const fits = new ModelService({
    profiles: { scripted: profile({ maxOutputTokens: 128 }) as never },
    approved: ["scripted"], registry: servicePort({ calls, contextWindow: 4_096, maxTokens: 8_192 }),
    budget: { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  const allowed = await fits.dispatch({ runId: "run-fit", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 128, estimatedInputTokens: 8, signal: new AbortController().signal });
  assert.equal(allowed.ok, true);
});

test("K04-R8c accepted revocation after awaited intent prevents transport and releases the un-dispatched reservation", async () => {
  const calls = { count: 0 };
  const service = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  let revokedNow = false;
  const result = await service.dispatch({
    runId: "r-revoked", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50,
    signal: new AbortController().signal,
    onIntent: () => { revokedNow = true; return true; },
    revoked: () => revokedNow,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "core.run-revoked");
  assert.equal(calls.count, 0, "an accepted revocation after the awaited intent prevents new provider arrival");
  assert.equal(service.summary().ownedRequestCount, 0, "a proven un-dispatched reservation is released, not billed");
  assert.equal(service.attempts[0]?.state, "released");
});

test("K04-R8d restored session aggregates retain all known tokens beyond bounded receipt details", async () => {
  const calls = { count: 0 };
  const first = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 64, maxOwnedTokensPerSession: 1_000_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  for (let n = 0; n < 33; n += 1) {
    const outcome = await first.dispatch({ runId: `run-${n}`, profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
    assert.equal(outcome.ok, true);
  }
  const snapshot = first.financialSnapshot();
  assert.equal(snapshot.attempts.length, 32, "receipt details stay bounded");
  assert.equal(snapshot.aggregate?.knownTokens, 7_425);
  const restored = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 64, maxOwnedTokensPerSession: 1_000_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  restored.restore(snapshot);
  assert.equal(restored.summary().ownedRequestCount, 33);
  assert.equal(restored.summary().normalizedTokens.total, 7_425, "bounded receipt detail cannot discard prior known token totals");
});

test("K04-R8e late usage from a retired generation reconciles into the current session-owned accounting", async () => {
  const calls = { count: 0 };
  let release!: () => void;
  const gate = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const port = servicePort({ calls });
  const original = port.completeChat.bind(port);
  port.completeChat = async (model, messages, options, signal) => {
    await gate;
    return original(model, messages, options, signal);
  };
  const scope = "unit-r8e-session";
  const retired = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: port, scope,
    budget: { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  const pending = retired.dispatch({ runId: "run-late", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  const restored = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: servicePort({ calls: { count: 0 } }), scope,
    budget: { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  restored.restore(retired.financialSnapshot());
  assert.equal(restored.summary().ownedRequestCount, 1, "the pending reservation survives the generation change");
  assert.equal(restored.summary().normalizedTokens.total, 0);
  release();
  assert.equal((await pending).ok, true);
  assert.equal(restored.summary().normalizedTokens.total, 225, "late actual usage must reconcile into current session-owned state");
});

test("K04-R9 zero-filled provider error usage is uncertain, not a genuine free complete request", async () => {
  const calls = { count: 0 };
  const service = new ModelService({
    profiles: { scripted: profile() as never },
    approved: ["scripted"], registry: servicePort({ calls, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 }, stopReason: "error", errorCode: "core.provider-failure" }),
    budget: { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  const result = await service.dispatch({ runId: "run-error", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  assert.equal(result.ok, false, "a provider failure is not a clean engineering verdict");
  const summary = service.summary();
  assert.ok(summary.usageUnknownCount + summary.usagePartialCount >= 1, "synthetic zero fill is unknown usage provenance");
  assert.equal(summary.normalizedTokens.coverage, "unknown");
});

test("K04-R10 an admissible receipt correction replaces the functional aggregate before the next admission", async () => {
  const calls = { count: 0 };
  const service = new ModelService({
    profiles: {
      scripted: profile({
        price: { currency: "USD", revision: "oracle-1", inputPerMillion: "1", outputPerMillion: "2", cacheReadPerMillion: "0.25", cacheWritePerMillion: "0" },
      }) as never,
    },
    approved: ["scripted"], registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 4, maxOwnedTokensPerSession: 10_000, unknownCost: "deny", maxOwnedCost: { currency: "USD", amount: "0.0003" } },
  });
  const first = await service.dispatch({ runId: "r10-a", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 1, estimatedInputTokens: 1, signal: new AbortController().signal });
  assert.equal(first.ok, true);
  assert.equal(service.reconcile(first.ok ? (first.value.attemptIds[0] ?? "") : "", { input: 120, output: 130, cacheRead: 0, cacheWrite: 0, totalTokens: 250 }, "final"), true);
  assert.equal(service.summary().costByCurrency[0]?.knownAmount, "0.00038");
  assert.equal(service.financialSnapshot().knownCostByCurrency["USD"], "0.00038");
  const second = await service.dispatch({ runId: "r10-b", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 1, estimatedInputTokens: 1, signal: new AbortController().signal });
  assert.equal(second.ok, false, "the corrected aggregate must constrain the next admission");
  if (!second.ok) assert.equal(second.error.code, "core.budget-cost-exceeded");
  assert.equal(calls.count, 1, "no stale aggregate may admit another actual request");
});

test("K04-R10b captured tariff survives restore and constrains the next admission", async () => {
  const calls = { count: 0 };
  const price = { currency: "USD", revision: "oracle-1", inputPerMillion: "1", outputPerMillion: "2", cacheReadPerMillion: "0.25", cacheWritePerMillion: "0" };
  const options = () => ({
    profiles: { scripted: profile({ price }) as never },
    approved: ["scripted"],
    registry: servicePort({ calls }),
    budget: { maxRequestsPerSession: 4, maxOwnedTokensPerSession: 10_000, unknownCost: "deny" as const, maxOwnedCost: { currency: "USD", amount: "0.0003" } },
  });
  const before = new ModelService(options());
  const first = await before.dispatch({ runId: "r10b-a", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 1, estimatedInputTokens: 1, signal: new AbortController().signal });
  assert.equal(first.ok, true);
  const current = new ModelService(options());
  current.restore(before.financialSnapshot());
  assert.equal(current.reconcile(first.ok ? (first.value.attemptIds[0] ?? "") : "", { input: 120, output: 130, cacheRead: 0, cacheWrite: 0, totalTokens: 250 }, "final"), true);
  assert.equal(current.summary().costByCurrency[0]?.knownAmount, "0.00038", "restored receipt must keep its immutable captured tariff");
  assert.equal(current.financialSnapshot().knownCostByCurrency["USD"], "0.00038");
  const second = await current.dispatch({ runId: "r10b-b", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 1, estimatedInputTokens: 1, signal: new AbortController().signal });
  assert.equal(second.ok, false, "the corrected protected amount must constrain the next admission");
  assert.equal(calls.count, 1);
});

test("K04-R8f a material late receipt notifies the current owner for protected persistence", async () => {
  const calls = { count: 0 };
  let release!: () => void;
  const gate = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const port = servicePort({ calls });
  const original = port.completeChat.bind(port);
  port.completeChat = async (model, messages, optionsIn, signal) => {
    await gate;
    return original(model, messages, optionsIn, signal);
  };
  const scope = "unit-r8f-session";
  const budget = { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits" as const, maxOwnedCost: null };
  const retired = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: port, budget, scope });
  const pending = retired.dispatch({ runId: "r8f-late", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  let persisted = 0;
  const current = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: servicePort({ calls: { count: 0 } }), budget, scope, onReceipt: () => { persisted += 1; } });
  current.restore(retired.financialSnapshot());
  release();
  assert.equal((await pending).ok, true);
  const snapshot = current.financialSnapshot();
  assert.ok(persisted >= 1, "the current owner is asked to persist the material receipt");
  assert.equal(snapshot.aggregate?.knownTokens, 225);
  assert.equal(snapshot.knownCostByCurrency["USD"], retired.financialSnapshot().knownCostByCurrency["USD"], "the captured tariff-derived cost is preserved with the receipt");
  assert.notEqual(snapshot.knownCostByCurrency["USD"], "0");
});

test("K04-R8g feed pressure never evicts a physically pending session owner", async () => {
  const calls = { count: 0 };
  let release!: () => void;
  const gate = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const port = servicePort({ calls });
  const original = port.completeChat.bind(port);
  port.completeChat = async (model, messages, optionsIn, signal) => {
    await gate;
    return original(model, messages, optionsIn, signal);
  };
  const scope = "unit-r8g-held";
  const budget = { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits" as const, maxOwnedCost: null };
  const held = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: port, budget, scope });
  const pending = held.dispatch({ runId: "r8g-held", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  const pressure: ModelService[] = [];
  for (let n = 0; n < 20; n += 1) {
    pressure.push(new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: servicePort({ calls: { count: 0 } }), budget, scope: `unit-r8g-other-${n}` }));
  }
  assert.equal(pressure.length, 20);
  const current = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: servicePort({ calls: { count: 0 } }), budget, scope });
  current.restore(held.financialSnapshot());
  release();
  assert.equal((await pending).ok, true);
  assert.equal(current.financialSnapshot().aggregate?.knownTokens, 225, "LRU pressure must not orphan a physically pending session-owned receipt");
});

test("K04-R10c a restored correction never reprices under a changed live tariff", async () => {
  const calls = { count: 0 };
  const captured = { currency: "USD", revision: "oracle-1", inputPerMillion: "1", outputPerMillion: "2", cacheReadPerMillion: "0.25", cacheWritePerMillion: "0" };
  const zero = { currency: "USD", revision: "later-zero-tariff", inputPerMillion: "0", outputPerMillion: "0", cacheReadPerMillion: "0", cacheWritePerMillion: "0" };
  const budget = { maxRequestsPerSession: 4, maxOwnedTokensPerSession: 10_000, unknownCost: "deny" as const, maxOwnedCost: { currency: "USD", amount: "0.0003" } };
  const prior = new ModelService({ profiles: { scripted: profile({ price: captured }) as never }, approved: ["scripted"], registry: servicePort({ calls }), budget });
  const first = await prior.dispatch({ runId: "r10c-a", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 1, estimatedInputTokens: 1, signal: new AbortController().signal });
  assert.equal(first.ok, true);
  const changed = new ModelService({ profiles: { scripted: profile({ price: zero }) as never }, approved: ["scripted"], registry: servicePort({ calls }), budget });
  changed.restore(prior.financialSnapshot());
  assert.equal(changed.reconcile(first.ok ? (first.value.attemptIds[0] ?? "") : "", { input: 120, output: 130, cacheRead: 0, cacheWrite: 0, totalTokens: 250 }, "final"), true);
  assert.equal(changed.summary().costByCurrency[0]?.knownAmount, "0.00038", "the immutable request-captured tariff governs the correction");
  assert.equal(changed.financialSnapshot().knownCostByCurrency["USD"], "0.00038");
  const second = await changed.dispatch({ runId: "r10c-b", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 1, estimatedInputTokens: 1, signal: new AbortController().signal });
  assert.equal(second.ok, false);
  assert.equal(calls.count, 1, "no zero-tariff reprice may admit another actual request");
});

test("K04-R8h the current owner receives a material late receipt without inspection", async () => {
  const calls = { count: 0 };
  let release!: () => void;
  const gate = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const port = servicePort({ calls });
  const original = port.completeChat.bind(port);
  port.completeChat = async (model, messages, optionsIn, signal) => {
    await gate;
    return original(model, messages, optionsIn, signal);
  };
  const scope = "unit-r8h-session";
  const budget = { maxRequestsPerSession: 5, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits" as const, maxOwnedCost: null };
  const retired = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: port, budget, scope });
  const pending = retired.dispatch({ runId: "r8h-late", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  let persisted = 0;
  const current = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: servicePort({ calls: { count: 0 } }), budget, scope, onReceipt: () => { persisted += 1; } });
  current.restore(retired.financialSnapshot());
  release();
  assert.equal((await pending).ok, true);
  assert.ok(persisted >= 1, "the active late receipt notifies the current owner without any status or inspection call");
  assert.equal(current.financialSnapshot().aggregate?.knownTokens, 225);
});

test("K04-R8i a first pending receipt survives detail compaction while later rows settle", async () => {
  const calls = { count: 0 };
  let release!: () => void;
  const gate = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const heldPort = servicePort({ calls });
  const original = heldPort.completeChat.bind(heldPort);
  heldPort.completeChat = async (model, messages, optionsIn, signal) => {
    await gate;
    return original(model, messages, optionsIn, signal);
  };
  const scope = "unit-r8i-session";
  const budget = { maxRequestsPerSession: 80, maxOwnedTokensPerSession: 1_000_000, unknownCost: "allow-with-token-limits" as const, maxOwnedCost: null };
  const retired = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: heldPort, budget, scope });
  const pending = retired.dispatch({ runId: "r8i-first", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  const current = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: servicePort({ calls: { count: 0 } }), budget, scope });
  current.restore(retired.financialSnapshot());
  for (let n = 0; n < 33; n += 1) {
    const outcome = await current.dispatch({ runId: `r8i-${n}`, profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
    assert.equal(outcome.ok, true);
  }
  release();
  assert.equal((await pending).ok, true);
  assert.equal(current.summary().normalizedTokens.total, 7_650, "the first pending receipt reconciles exactly once beyond bounded detail");
  assert.equal(current.summary().unresolvedCount, 0);
  const snapshot = current.financialSnapshot();
  assert.equal(snapshot.aggregate?.knownTokens, 7_650);
  assert.equal(snapshot.attempts.some(row => row.attemptId === "attempt-1" && row.state === "settled"), true, "the pending identity is retained in bounded protected detail");
});

test("K04-R8k active session feeds keep their own receipts under pressure and release when served", async () => {
  const makeHeld = () => {
    let release!: () => void;
    const gate = new Promise<void>(resolvePromise => { release = resolvePromise; });
    const calls = { count: 0 };
    const port = servicePort({ calls });
    const original = port.completeChat.bind(port);
    port.completeChat = async (model, messages, optionsIn, signal) => {
      await gate;
      return original(model, messages, optionsIn, signal);
    };
    return { release, port };
  };
  const budget = { maxRequestsPerSession: 80, maxOwnedTokensPerSession: 1_000_000, unknownCost: "allow-with-token-limits" as const, maxOwnedCost: null };
  const scopeA = "unit-r8k-a";
  const scopeB = "unit-r8k-b";
  const heldA = makeHeld();
  const heldB = makeHeld();
  const retiredA = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: heldA.port, budget, scope: scopeA });
  const pendingA = retiredA.dispatch({ runId: "a", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  const retiredB = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: heldB.port, budget, scope: scopeB });
  const pendingB = retiredB.dispatch({ runId: "b", profileId: "scripted", kind: "chat", messages: [], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  const currentA = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: servicePort({ calls: { count: 0 } }), budget, scope: scopeA });
  const currentB = new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: servicePort({ calls: { count: 0 } }), budget, scope: scopeB });
  currentA.restore(retiredA.financialSnapshot());
  currentB.restore(retiredB.financialSnapshot());
  const pressure: ModelService[] = [];
  for (let n = 0; n < 18; n += 1) {
    pressure.push(new ModelService({ profiles: { scripted: profile() as never }, approved: ["scripted"], registry: servicePort({ calls: { count: 0 } }), budget, scope: `unit-r8k-pressure-${n}` }));
  }
  assert.equal(pressure.length, 18);
  heldA.release();
  heldB.release();
  assert.equal((await pendingA).ok, true);
  assert.equal((await pendingB).ok, true);
  assert.equal(currentA.financialSnapshot().aggregate?.knownTokens, 225, "session A keeps exactly its own receipt");
  assert.equal(currentB.financialSnapshot().aggregate?.knownTokens, 225, "session B keeps exactly its own receipt");
});
