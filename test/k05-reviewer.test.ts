// K05 reviewer admission — focused behavior checks on the shared ModelService
// owner. These are author mechanical checks, not independent acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { ModelService } from "../src/models.js";
import type { ModelRegistryPort } from "../src/models.js";
import type { ModelProfileDefinition } from "../src/contracts.js";
import { runReviewerSession } from "../src/builtins/pi-reviewer.js";
import type { ReviewerHost, ReviewerRunInput, ReviewerSession, ReviewerSessionHooks } from "../src/builtins/pi-reviewer.js";
import type { ChatTransportResult, ClassifierTransportResult } from "../src/models.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROFILE: ModelProfileDefinition = {
  provider: "fixture",
  model: "scripted-1",
  reasoning: "off",
  requestTimeoutMs: 5_000,
  maxAttempts: 1,
  retryDelayMs: 0,
  maxOutputTokens: 1_024,
  requiredInputs: ["text"],
  price: {
    currency: "USD",
    revision: "synthetic-price-1",
    inputPerMillion: "1",
    outputPerMillion: "2",
    cacheReadPerMillion: "0.25",
    cacheWritePerMillion: "0",
  },
};

interface FakePort extends ModelRegistryPort {
  chatCalls: number;
}

function fakePort(): FakePort {
  const port: FakePort = {
    chatCalls: 0,
    findChat: () => ({
      provider: "fixture",
      id: "scripted-1",
      model: "scripted-1",
      revision: "rev-1",
      reasoning: false,
      thinkingLevels: null,
      input: ["text"],
      contextWindow: 32_768,
      maxTokens: 8_192,
      cost: { input: 1, output: 2, cacheRead: 0.25, cacheWrite: 0 },
    }),
    findClassifier: () => null,
    hasConfiguredAuth: () => true,
    completeChat: async (): Promise<ChatTransportResult> => {
      port.chatCalls += 1;
      return { text: "{}", model: { provider: "fixture", id: "scripted-1", revision: "rev-1" }, usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }, stopReason: "stop", errorCode: null };
    },
    classify: async (): Promise<ClassifierTransportResult> => ({ answers: {}, model: { provider: "fixture", id: "scripted-1", revision: "rev-1" }, usage: null, stopReason: "stop", errorMessage: null }),
  };
  return port;
}

function service(port: FakePort, maxRequestsPerSession = 10): ModelService {
  return new ModelService({
    profiles: { scripted: PROFILE },
    approved: ["scripted"],
    registry: port,
    budget: { maxRequestsPerSession, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

test("K05 reviewer turn is denied before any transport when the shared budget is exhausted", async () => {
  const port = fakePort();
  const owner = service(port, 0);
  let transportCalls = 0;
  const outcome = await owner.dispatchReviewTurn(
    { runId: "run-1", profileId: "scripted", estimatedInputTokens: 50, maxOutputTokens: 100, signal: new AbortController().signal },
    async () => { transportCalls += 1; throw new Error("transport must not be reached"); },
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, "core.budget-requests-exhausted");
  assert.equal(transportCalls, 0, "a denied reviewer turn never reaches the provider transport");
  assert.equal(owner.attempts.length, 0, "no dispatched owned attempt is created for a denied turn");
});

test("K05 admitted reviewer turn awaits protected intent, streams once and settles the same attempt", async () => {
  const port = fakePort();
  const owner = service(port);
  const order: string[] = [];
  const completion = deferred<{ usage: Record<string, unknown> | null; stopReason?: string | null; errorCode?: string | null }>();
  const stream = { kind: "reviewer-stream" };
  const admitted = await owner.dispatchReviewTurn(
    {
      runId: "run-2",
      profileId: "scripted",
      estimatedInputTokens: 50,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
      onIntent: async () => { order.push("intent"); return true; },
    },
    async () => {
      order.push("transport");
      return { ok: true, value: { stream, completion: completion.promise } };
    },
  );
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.equal(admitted.value.stream, stream, "the native stream is delivered to the caller");
  assert.deepEqual(order, ["intent", "transport"], "protected intent precedes the actual transport");
  assert.equal(port.chatCalls, 0, "the reviewer turn uses its own native stream boundary, not completeChat");
  const attempt = owner.attempts[0];
  assert.equal(attempt?.purpose, "reviewer");
  assert.equal(attempt?.state, "dispatched");
  assert.equal(attempt?.reservedTokens, 150, "the shared reservation is held while the turn is pending");

  completion.resolve({ usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }, stopReason: "stop", errorCode: null });
  await new Promise(resolve => setTimeout(resolve, 0));

  const settled = owner.attempts[0];
  assert.equal(settled?.state, "settled");
  assert.equal(settled?.purpose, "reviewer");
  assert.equal(settled?.reservedTokens, 0, "the reservation is released exactly once at settlement");
  assert.equal(settled?.usage?.totalTokens, 150);
  assert.equal(settled?.usage?.coverage, "complete");
  assert.equal(owner.summary().normalizedTokens.total, 150, "reviewer usage settles through the same shared ledger");
  assert.equal(owner.summary().ownedRequestCount, 1);
});

test("K05 a non-owned external executor receipt is rejected by the real owner and cannot change owned totals", async () => {
  const port = fakePort();
  const owner = service(port);
  const dispatchOwned = async (runId: string): Promise<void> => {
    const admitted = await owner.dispatchReviewTurn(
      { runId, profileId: "scripted", estimatedInputTokens: 50, maxOutputTokens: 100, signal: new AbortController().signal },
      async () => ({
        ok: true,
        value: {
          stream: { kind: "owner-external-negative-stream" },
          completion: Promise.resolve({ usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }, stopReason: "stop", errorCode: null }),
        },
      }),
    );
    assert.equal(admitted.ok, true, "the owned reviewer turn is admitted for the external-report negative baseline");
  };
  await dispatchOwned("run-ext-1");
  await dispatchOwned("run-ext-2");
  await new Promise(resolve => setTimeout(resolve, 0));
  const baseline = owner.summary();
  assert.equal(baseline.ownedRequestCount, 2, "two real owned reviewer receipts are the exact baseline");
  assert.equal(baseline.normalizedTokens.total, 300, "the owned ledger reads exactly 300 tokens before the external stimulus");
  assert.equal(baseline.settledCount, 2, "both owned receipts are settled before the external stimulus");
  assert.equal(baseline.unresolvedCount, 0, "the owned baseline owns no unresolved reservation");
  const ownedCostBefore = JSON.stringify(baseline.costByCurrency);
  const ownedRevisionBeforeExternal = baseline.ledgerRevision;

  // The deliberately NON-ZERO external executor report is submitted through the real owner
  // boundary under an identity the owner never issued; it must be refused before normalization
  // or revision and must not change any owned fact.
  const externalReport = { input: 5000, output: 4000, cacheRead: 0, cacheWrite: 0, totalTokens: 9000 };
  assert.equal(owner.reconcile("external-executor-report-1", externalReport, "final"), false, "the owner rejects a receipt for an attempt identity it never issued");
  const afterExternal = owner.summary();
  assert.equal(afterExternal.ownedRequestCount, baseline.ownedRequestCount, "the external report cannot enlarge the owned request count");
  assert.equal(afterExternal.normalizedTokens.total, baseline.normalizedTokens.total, "the external report cannot enlarge the owned token total");
  assert.equal(afterExternal.settledCount, baseline.settledCount, "the external report cannot settle or replace an owned receipt");
  assert.equal(afterExternal.unresolvedCount, baseline.unresolvedCount, "the external report cannot alter owned unresolved ownership");
  assert.equal(JSON.stringify(afterExternal.costByCurrency), ownedCostBefore, "the external report cannot change owned cost or reservations");
  assert.equal(afterExternal.ledgerRevision, ownedRevisionBeforeExternal, "the rejected external receipt does not revise the owned ledger");

  // Known-owned positive through the SAME method: a connected issued identity is revised, so an
  // unconditional or disconnected refusal cannot satisfy this control.
  const ownedAttempt = owner.attempts[0];
  assert.notEqual(ownedAttempt, undefined, "an issued owned attempt identity is available");
  assert.equal(ownedAttempt?.state, "settled", "the owned baseline attempt settled through its own completion");
  assert.equal(owner.reconcile(ownedAttempt?.attemptId ?? "", { input: 130, output: 40, cacheRead: 0, cacheWrite: 0, totalTokens: 170 }, "final"), true, "the same owner method accepts a receipt for its own issued identity");
  const afterOwnedRevision = owner.summary();
  assert.equal(afterOwnedRevision.ownedRequestCount, 2, "the owned revision creates no new owned request");
  assert.equal(afterOwnedRevision.normalizedTokens.total, 320, "the owned revision replaces exactly one representation (300 - 150 + 170)");
  assert.equal(afterOwnedRevision.ledgerRevision, ownedRevisionBeforeExternal + 1, "the accepted owned revision advances the owned ledger revision exactly once");

  // The external receipt remains rejected after the owned revision and changes nothing further.
  assert.equal(owner.reconcile("external-executor-report-1", externalReport, "final"), false, "the non-owned external receipt remains rejected after an owned revision");
  const finalSummary = owner.summary();
  assert.equal(finalSummary.normalizedTokens.total, 320, "the external report still cannot change the revised owned total");
  assert.equal(finalSummary.ownedRequestCount, 2, "the external report still cannot change the owned request count");
  assert.equal(finalSummary.ledgerRevision, afterOwnedRevision.ledgerRevision, "the rejected external receipt still does not revise the owned ledger");
});

test("K05 reviewer turn revoked after intent never reaches transport and releases its reservation", async () => {
  const port = fakePort();
  const owner = service(port);
  let transportCalls = 0;
  const outcome = await owner.dispatchReviewTurn(
    {
      runId: "run-3",
      profileId: "scripted",
      estimatedInputTokens: 50,
      maxOutputTokens: 100,
      signal: new AbortController().signal,
      onIntent: async () => true,
      revoked: () => true,
    },
    async () => { transportCalls += 1; throw new Error("revoked transport must not run"); },
  );
  assert.equal(outcome.ok, false);
  if (!outcome.ok) assert.equal(outcome.error.code, "core.run-revoked");
  assert.equal(transportCalls, 0);
  assert.equal(owner.attempts[0]?.state, "released");
  assert.equal(owner.attempts[0]?.reservedTokens, 0);
});

// --- Fresh Pi reviewer runner limits and lifecycle (host contract) ---

function runnerHost(script: (hooks: ReviewerSessionHooks) => Promise<void>, options: { abortThrows?: boolean } = {}): { host: ReviewerHost; log: { disposes: number; aborts: number } } {
  const log = { disposes: 0, aborts: 0 };
  let hooks: ReviewerSessionHooks | null = null;
  const host: ReviewerHost = {
    async createSession(input): Promise<ReviewerSession> {
      hooks = input.hooks;
      return { dispose: () => { log.disposes += 1; } };
    },
    async prompt(): Promise<void> {
      assert.ok(hooks !== null);
      await script(hooks);
    },
    async abort(): Promise<void> {
      log.aborts += 1;
      if (options.abortThrows === true) throw new Error("non-cooperative reviewer");
    },
  };
  return { host, log };
}

function runnerInput(overrides: Partial<ReviewerRunInput> = {}): ReviewerRunInput {
  return {
    runId: "run-reviewer-1",
    cwd: "C:/owned/project",
    agentDir: "C:/owned/agent",
    promptText: "review the project",
    tools: ["read"],
    maxModelRequests: 4,
    maxToolCalls: 8,
    maxAdditionalReadBytes: 262_144,
    timeoutMs: 5_000,
    repairAttempts: 0,
    signal: new AbortController().signal,
    streamTurn: async () => ({ ok: true, value: { stream: { kind: "native-stream" } } }),
    validate: payload => (payload === "canonical" ? { valid: true, reason: "core.review-result-valid" } : { valid: false, reason: "core.review-result-invalid" }),
    ...overrides,
  };
}

test("K05 reviewer runner denies the turn beyond maxModelRequests without a transport call", async () => {
  let transports = 0;
  const { host, log } = runnerHost(async hooks => {
    const first = await hooks.beginTurn({ native: 1 }, {});
    assert.equal(first.ok, true);
    const second = await hooks.beginTurn({ native: 2 }, {});
    assert.equal(second.ok, false);
  });
  const outcome = await runReviewerSession(runnerInput({
    maxModelRequests: 1,
    streamTurn: async () => { transports += 1; return { ok: true, value: { stream: {} } }; },
  }), host);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(transports, 1);
  assert.equal(outcome.value.modelRequests, 1);
  assert.equal(outcome.value.terminalReason, "core.review-request-limit");
  assert.equal(log.disposes, 1);
  assert.equal(log.aborts, 1);
});

test("K05 reviewer runner enforces tool-call and additional-read-byte caps", async () => {
  const { host } = runnerHost(async hooks => {
    assert.equal(hooks.allowToolCall("read"), true);
    hooks.noteToolResult("read", 200_000);
    assert.equal(hooks.allowToolCall("read"), true);
    hooks.noteToolResult("read", 100_000);
    assert.equal(hooks.allowToolCall("read"), false, "the next call after the byte cap is denied");
  });
  const outcome = await runReviewerSession(runnerInput(), host);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.additionalReadBytes, 300_000);
  assert.equal(outcome.value.toolCalls, 2);
  assert.equal(outcome.value.terminalReason, "core.review-read-bytes-limit");

  const { host: toolHost } = runnerHost(async hooks => {
    assert.equal(hooks.allowToolCall("read"), true);
    assert.equal(hooks.allowToolCall("read"), false, "the call beyond maxToolCalls is denied");
    assert.equal(hooks.allowToolCall("bash"), false, "an ungranted tool is denied");
  });
  const toolOutcome = await runReviewerSession(runnerInput({ maxToolCalls: 1 }), toolHost);
  assert.equal(toolOutcome.ok, true);
  if (!toolOutcome.ok) return;
  assert.equal(toolOutcome.value.toolCalls, 1);
  assert.equal(toolOutcome.value.terminalReason, "core.review-tool-limit");
});

test("K05 reviewer runner returns a valid canonical submission and disposes once", async () => {
  const { host, log } = runnerHost(async hooks => {
    hooks.submit("canonical");
    assert.equal(hooks.shouldEndTurn(), true, "a valid submission ends the turn");
    assert.equal(hooks.allowToolCall("submit_result"), true, "the result tool is always permitted inside the cap");
  });
  const outcome = await runReviewerSession(runnerInput(), host);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.validation, "valid");
  assert.equal(outcome.value.terminalReason, "core.review-submitted");
  assert.equal(outcome.value.output, "canonical");
  assert.equal(log.disposes, 1);

  const { host: invalidHost } = runnerHost(async hooks => { hooks.submit({ not: "canonical" }); });
  const invalid = await runReviewerSession(runnerInput(), invalidHost);
  assert.equal(invalid.ok, true);
  if (!invalid.ok) return;
  assert.equal(invalid.value.validation, "invalid");
  assert.equal(invalid.value.terminalReason, "core.review-result-invalid");
});

test("K05 reviewer runner keeps late physical ownership when the reviewer ignores abort", async () => {
  const { host, log } = runnerHost(async () => { /* no result: the session ends without submitting */ }, { abortThrows: true });
  const outcome = await runReviewerSession(runnerInput({ timeoutMs: 50 }), host);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.value.validation, "invalid");
  assert.equal(log.aborts, 1, "the bounded abort is attempted once");
  assert.equal(log.disposes, 1, "disposal runs exactly once even when abort fails");
});

// --- T05 shared allowance: direct and reviewer paths spend the same budget ---

function budgeted(port: FakePort, budget: { maxRequestsPerSession: number; maxOwnedTokensPerSession: number; unknownCost: "allow-with-token-limits" | "deny"; maxOwnedCost: { currency: string; amount: string } | null }): ModelService {
  return new ModelService({ profiles: { scripted: PROFILE }, approved: ["scripted"], registry: port, budget });
}

test("K05 T05 the reviewer turn competes with the direct path for the same shared allowance", async () => {
  const port = fakePort();
  const owner = budgeted(port, { maxRequestsPerSession: 1, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null });
  const direct = await owner.dispatch({ runId: "run-direct", profileId: "scripted", kind: "chat", messages: [{ role: "user", content: "direct" }], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  assert.equal(direct.ok, true);
  assert.equal(port.chatCalls, 1);
  let reviewerArrivals = 0;
  const reviewed = await owner.dispatchReviewTurn(
    { runId: "run-review", profileId: "scripted", estimatedInputTokens: 50, maxOutputTokens: 100, signal: new AbortController().signal },
    async () => { reviewerArrivals += 1; throw new Error("a denied reviewer turn must not reach the transport"); },
  );
  assert.equal(reviewed.ok, false);
  if (!reviewed.ok) assert.equal(reviewed.error.code, "core.budget-requests-exhausted", "the direct path already consumed the single shared request");
  assert.equal(reviewerArrivals, 0, "the disallowed reviewer turn produced zero provider arrivals");
  assert.equal(owner.attempts.length, 1, "no fictitious reviewer attempt was created");
  assert.equal(owner.summary().ownedRequestCount, 1);
});

test("K05 T05 shared token and USD allowances admit or deny both paths through one ledger", async () => {
  const tokensPort = fakePort();
  const tokenOwner = budgeted(tokensPort, { maxRequestsPerSession: 10, maxOwnedTokensPerSession: 1_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null });
  const firstReview = await tokenOwner.dispatchReviewTurn(
    { runId: "run-r1", profileId: "scripted", estimatedInputTokens: 50, maxOutputTokens: 2_000, signal: new AbortController().signal },
    async () => { throw new Error("a token-denied reviewer turn must not reach the transport"); },
  );
  assert.equal(firstReview.ok, false);
  if (!firstReview.ok) assert.equal(firstReview.error.code, "core.budget-tokens-exceeded", "the shared token ceiling denies the reviewer before dispatch");
  assert.equal(tokenOwner.attempts.length, 0, "no undispatched attempt or residual reservation is kept for a denied reviewer turn");

  const usdPort = fakePort();
  const usdOwner = budgeted(usdPort, { maxRequestsPerSession: 10, maxOwnedTokensPerSession: 100_000, unknownCost: "allow-with-token-limits", maxOwnedCost: { currency: "USD", amount: "0.000001" } });
  const direct = await usdOwner.dispatch({ runId: "run-usd", profileId: "scripted", kind: "chat", messages: [{ role: "user", content: "direct" }], maxOutputTokens: 100, estimatedInputTokens: 50, signal: new AbortController().signal });
  assert.equal(direct.ok, false);
  if (!direct.ok) assert.equal(direct.error.code, "core.budget-cost-exceeded", "the shared USD ceiling denies the direct path before dispatch");
  assert.equal(usdPort.chatCalls, 0);
  let reviewerArrivals = 0;
  const reviewed = await usdOwner.dispatchReviewTurn(
    { runId: "run-usd-r", profileId: "scripted", estimatedInputTokens: 50, maxOutputTokens: 100, signal: new AbortController().signal },
    async () => { reviewerArrivals += 1; throw new Error("USD-denied reviewer turn must not reach the transport"); },
  );
  assert.equal(reviewed.ok, false);
  if (!reviewed.ok) assert.equal(reviewed.error.code, "core.budget-cost-exceeded");
  assert.equal(reviewerArrivals, 0);
  assert.equal(usdOwner.attempts.length, 0, "neither denied path created an owned attempt or residual reservation");
});

// Owner-level checks for the canonical evaluator boundary. These exercise the
// real exported piSessionEvaluator with a missing or capturing review service;
// they do NOT qualify the native runtime capability ablation (that stays
// unqualified for independent adjudication).

test("K05 owner-level: the pi-session evaluator reports core.review-unavailable when no review service exists", async () => {
  const { piSessionEvaluator } = await import("../src/builtins/evaluators.js");
  const input = {
    run: "run-owner-1",
    context: { items: [] },
    assessment: {},
    modelProfileId: "scripted",
  } as never;
  const ctx = { services: {}, signal: new AbortController().signal } as never;
  const result = await piSessionEvaluator.evaluate({}, input, ctx);
  assert.equal(result.operational, "unavailable", "a missing review capability is unavailable, never a fabricated success");
  assert.equal(result.conclusion, "undetermined", "no conclusion is invented without the capability");
  assert.equal(result.findings.length, 0, "no findings are fabricated without the capability");
  assert.equal(result.coverage.issues[0]?.reason, "core.review-unavailable", "the exact owner diagnostic code is reported");
});

test("K05 owner-level: the pi-session evaluator sends the unchanged canonical C1 defaults when no options are configured", async () => {
  const { piSessionEvaluator } = await import("../src/builtins/evaluators.js");
  const captured: Record<string, unknown>[] = [];
  const RESULT = {
    operational: "completed",
    coverage: { state: "complete", scopeDescription: "synthetic", issues: [] },
    conclusion: "no-supported-finding",
    findings: [],
    scores: [],
    additionalEvidence: [],
    dependencies: [],
    usageAttemptIds: [],
  };
  const input = {
    run: "run-owner-2",
    context: { items: [] },
    assessment: {},
    modelProfileId: "scripted",
  } as never;
  const ctx = {
    signal: new AbortController().signal,
    services: {
      review: async (request: Record<string, unknown>) => {
        captured.push(request);
        return {
          ok: true,
          value: {
            output: RESULT,
            validation: "valid",
            terminalReason: "core.review-submitted",
            modelRequests: 1,
            toolCalls: 0,
            additionalReadBytes: 0,
            evidenceRefs: [],
          },
        };
      },
    },
  } as never;
  const result = await piSessionEvaluator.evaluate({}, input, ctx);
  assert.equal(captured.length, 1, "exactly one review request is issued without options");
  const request = captured[0]!;
  assert.deepEqual(request["tools"], ["read", "grep", "find", "ls"], "default investigative tools are the canonical set");
  assert.deepEqual(request["readSources"], [], "no read sources are granted by default");
  assert.equal(request["allowProjectReads"], true, "project reads are allowed by the canonical default");
  assert.equal(request["maxModelRequests"], 4, "default request ceiling is unchanged");
  assert.equal(request["maxToolCalls"], 8, "default investigative attempt ceiling is unchanged");
  assert.equal(request["timeoutMs"], 120_000, "default review deadline is unchanged");
  assert.equal(request["maxOutputTokens"], 4_096, "default output ceiling is unchanged");
  assert.equal(request["maxAdditionalReadBytes"], 262_144, "default aggregate additional-byte ceiling is unchanged");
  assert.equal(request["compaction"], "disabled", "compaction is disabled by default");
  assert.deepEqual(request["extensions"], [], "no extensions are granted by default");
  assert.deepEqual(request["skills"], [], "no skills are granted by default");
  assert.equal(request["resultMode"], "structured", "structured result mode is the default");
  assert.equal(request["repairAttempts"], 0, "no repair attempt is configured by default");
  assert.equal(request["profileId"], "scripted", "the selected profile is carried unchanged");
  assert.equal(result.operational, "completed", "the valid captured result flows through unchanged");
});

// F01 custody/binding owner-level regression: adopted acquisitions produce real
// owned operation references and each turn forwards its actual-input binding.
test("K05 reviewer custody registers adopted acquisitions and forwards per-turn input binding", async () => {
  const captured: Record<string, unknown>[] = [];
  const host = {
    async createSession({ hooks }: { hooks: ReviewerSessionHooks }) {
      hooks.noteToolResult("read", 120, { toolCallId: "call-read-1", path: "notes.md" });
      const bound = await hooks.beginTurn({ messages: [] }, {}, { inputManifestRef: "review-turn:msgs=1:blocks=1:digest=abcd", inputSerializedDigest: "d".repeat(64) });
      assert.equal(bound.ok, true);
      hooks.submit({
        operational: "completed",
        coverage: { state: "complete", scopeDescription: "synthetic", issues: [] },
        conclusion: "no-supported-finding",
        findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
      });
      return { dispose: () => undefined } as unknown as ReviewerSession;
    },
    async prompt() { return undefined; },
    async abort() { return undefined; },
  } as unknown as ReviewerHost;
  const outcome = await runReviewerSession({
    runId: "run-custody-1",
    cwd: process.cwd(),
    agentDir: process.cwd(),
    promptText: "bounded review",
    tools: ["read"],
    maxModelRequests: 2,
    maxToolCalls: 4,
    maxAdditionalReadBytes: 4096,
    timeoutMs: 5_000,
    repairAttempts: 0,
    signal: new AbortController().signal,
    streamTurn: async (request) => {
      captured.push(request as unknown as Record<string, unknown>);
      return { ok: true, value: { stream: {} } };
    },
    validate: () => ({ valid: true, reason: "ok" }),
  }, host);
  assert.equal(outcome.ok, true);
  const adopted = (outcome as { value: { adoptedAcquisitions?: readonly { toolName: string; toolCallId?: string; path?: string; bytes: number }[] } }).value.adoptedAcquisitions ?? [];
  assert.equal(adopted.some(entry => entry.toolCallId === "call-read-1" && entry.path === "notes.md" && entry.bytes === 120), true, `the runner returns the real adopted-acquisition descriptor for the run owner to mint refs (${JSON.stringify(adopted)})`);
  assert.equal(captured[0]?.["inputManifestRef"], "review-turn:msgs=1:blocks=1:digest=abcd", "the per-turn actual-input manifest reaches the shared dispatch owner");
  assert.equal(captured[0]?.["inputSerializedDigest"], "d".repeat(64), "the per-turn actual-input digest reaches the shared dispatch owner");
});

// Astra63 §5 completion controls: synchronous throw, rejected completion,
// preparation abort, late session creation after the logical deadline, and a
// never-draining prompt that settles boundedly. Owner-level evidence only.
test("K05 completion controls: throw, rejection, preparation abort, late creation and never-draining prompt", async () => {
  const scenario = async (kind: string) => {
    const events: string[] = [];
    let disposeCount = 0;
    let promptCount = 0;
    let holdPhysicalSeen = false;
    const controller = new AbortController();
    const host = {
      async createSession({ holdPhysical }: { holdPhysical?: () => () => void }) {
        holdPhysicalSeen = typeof holdPhysical === "function";
        events.push("createSession");
        if (kind === "throw") throw new Error("fixture: synchronous createSession failure");
        const session = { dispose: () => { disposeCount += 1; events.push("dispose"); } };
        if (kind === "late") {
          await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
          return session;
        }
        if (kind === "abortDuringPreparation") {
          controller.abort();
          return session;
        }
        return session;
      },
      async prompt() {
        promptCount += 1;
        events.push("prompt");
        if (kind === "reject") throw new Error("fixture: prompt rejection");
        if (kind === "never") await new Promise(() => undefined);
      },
      async abort() { events.push("abort"); },
    };
    const outcome = await runReviewerSession({
      runId: `run-${kind}`,
      cwd: process.cwd(),
      agentDir: process.cwd(),
      promptText: "bounded review",
      tools: ["read"],
      maxModelRequests: 2,
      maxToolCalls: 4,
      maxAdditionalReadBytes: 4096,
      timeoutMs: kind === "late" ? 50 : 300,
      repairAttempts: 0,
      signal: controller.signal,
      holdPhysical: () => () => undefined,
      streamTurn: async () => ({ ok: true, value: { stream: {} } }),
      validate: () => ({ valid: true, reason: "ok" }),
    } as never, host as never);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    return { outcome, disposeCount, promptCount, holdPhysicalSeen, events };
  };

  const thrown = await scenario("throw");
  assert.equal(thrown.outcome.ok, false, "a synchronous createSession throw is a bounded failure");
  assert.equal(thrown.disposeCount, 0, "no session existed to dispose after the throw");
  assert.equal(thrown.holdPhysicalSeen, true, "the physical-lifetime bridge reaches the real session construction");

  const rejected = await scenario("reject");
  assert.equal(rejected.promptCount >= 1, true, "the rejected completion actually reached the prompt");
  assert.equal(rejected.disposeCount, 1, "a rejected completion still disposes exactly once");
  assert.equal(rejected.events.filter(entry => entry === "dispose").length, 1, "no repeated cleanup after rejection");

  const aborted = await scenario("abortDuringPreparation");
  assert.equal(aborted.outcome.ok, true, "a preparation abort yields a bounded outcome");
  assert.equal(aborted.disposeCount, 1, "the session created during preparation abort is disposed exactly once");

  const late = await scenario("late");
  assert.equal(late.promptCount, 0, "a session created after the logical deadline is never prompted");
  assert.equal(late.disposeCount, 1, "the late session is cleaned exactly once without regaining authority");

  const never = await scenario("never");
  assert.equal(never.outcome.ok, true, "a never-draining prompt settles boundedly at the deadline");
  assert.equal((never.outcome as { value?: { terminalReason?: string } }).value?.terminalReason, "core.review-timeout", "the bounded outcome records the review deadline");
  assert.equal(never.disposeCount, 1, "the never-draining session is disposed exactly once");
  assert.equal(never.holdPhysicalSeen, true, "the physical bridge was present for the never-draining path");
});

test("K05 boundary: the effective deadline is authority without any timer callback", async () => {
  let hooks: ReviewerSessionHooks | null = null;
  let resolveReady: (() => void) | null = null;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  let revoked = false;            // advanced manually; NO timer or poll callback is ever delivered
  const log = { aborts: 0, disposes: 0, prompts: 0 };
  const host: ReviewerHost = {
    async createSession(input): Promise<ReviewerSession> {
      hooks = input.hooks;
      resolveReady?.();
      return { dispose: () => { log.disposes += 1; } } as unknown as ReviewerSession;
    },
    async prompt(): Promise<void> { log.prompts += 1; },
    async abort(): Promise<void> { log.aborts += 1; },
  };
  const input = {
    runId: "k05-boundary-no-poll",
    cwd: process.cwd(),
    agentDir: process.cwd(),
    promptText: "boundary",
    tools: ["read"] as readonly string[],
    maxModelRequests: 4,
    maxToolCalls: 4,
    maxAdditionalReadBytes: 4096,
    timeoutMs: 60_000,
    repairAttempts: 0,
    signal: new AbortController().signal,
    streamTurn: async () => ({ ok: true, value: { stream: { async *[Symbol.asyncIterator]() { /* no events */ } } } }),
    validate: () => ({ valid: true, reason: "ok" }),
    isRevoked: () => revoked,
  } as unknown as ReviewerRunInput;
  const outcomePromise = runReviewerSession(input, host);
  await ready;
  const admitted = await hooks!.beginTurn({}, {});
  assert.equal(admitted.ok, true, "the first turn is admitted while the review is live");
  revoked = true;                 // the absolute deadline has passed; no callback has run
  const granted = hooks!.allowToolCall("read", { path: "notes.md" });
  assert.equal(granted, false, "an expired review must deny a later tool admission at the boundary");
  const later = await hooks!.beginTurn({}, {});
  assert.equal(later.ok, false, "no later provider turn may be admitted after expiry");
  hooks!.noteToolResult("read", 16, { toolCallId: "late-1", path: "notes.md" });
  const outcome = await outcomePromise;
  assert.equal(outcome.ok, true, "the run settles boundedly");
  if (outcome.ok) {
    assert.equal(outcome.value.validation, "invalid", "expired work never returns a valid success");
    assert.equal(typeof outcome.value.terminalReason === "string" && outcome.value.terminalReason.length > 0, true, "the bounded terminal reason is latched, not null");
  }
  assert.equal(log.aborts, 1, "the once-owned abort is requested exactly once");
});

test("K05 boundary: an admitted tool start is refused after the owned deadline expires without any timer callback", async () => {
  const base = await mkdtemp(join(tmpdir(), "qe-k05-unconf-"));
  const cwd = join(base, "project");
  const agentDir = join(cwd, "agent-state");
  await mkdir(agentDir, { recursive: true });
  let hooks: ReviewerSessionHooks | null = null;
  let ready: (() => void) | null = null;
  const readyPromise = new Promise<void>(resolve => { ready = resolve; });
  let revoked = false;            // advanced manually - NO timer or poll callback is ever delivered
  const log = { aborts: 0, disposes: 0 };
  const host: ReviewerHost = {
    async createSession(input): Promise<ReviewerSession> {
      hooks = input.hooks;
      ready?.();
      return { dispose: () => { log.disposes += 1; } } as unknown as ReviewerSession;
    },
    async prompt(): Promise<void> { /* no turns are driven by the host in this control */ },
    async abort(): Promise<void> { log.aborts += 1; },
  };
  const input = {
    runId: "k05-unconfounded-boundary",
    cwd,
    agentDir,
    promptText: "boundary",
    tools: ["read"] as readonly string[],
    maxModelRequests: 4,
    maxToolCalls: 8,
    maxAdditionalReadBytes: 4096,
    timeoutMs: 60_000,
    repairAttempts: 0,
    signal: new AbortController().signal,
    streamTurn: async () => ({ ok: true, value: { stream: { async *[Symbol.asyncIterator]() { /* no events */ } } } }),
    validate: () => ({ valid: false, reason: "not a submission" }),
    isRevoked: () => revoked,
  } as unknown as ReviewerRunInput;
  const outcomePromise = runReviewerSession(input, host);
  await readyPromise;
  // 1. PROOF OF ADMISSIBILITY: with the same path policy in force, the operation is admitted while live.
  const admittedBefore = hooks!.allowToolCall("read", { path: "notes.md" });
  assert.equal(admittedBefore, true, "the candidate tool start is admissible while the review is live (path policy admits it)");
  // 2. Expire the owned predicate manually, with no timer/poll callback and NO beginTurn call in between,
  //    so a latched terminal from another guard cannot mask the boundary under test.
  revoked = true;
  const refusedAfter = hooks!.allowToolCall("read", { path: "notes.md" });
  assert.equal(refusedAfter, false, "after the owned deadline expires (no timer delivered) the same tool start must be refused");
  // 3. A later provider turn is refused as well.
  const later = await hooks!.beginTurn({}, {});
  assert.equal(later.ok, false, "no later provider turn may be admitted after expiry");
  const outcome = await outcomePromise;
  assert.equal(outcome.ok, true, "the run settles boundedly");
  if (outcome.ok) {
    assert.equal(outcome.value.validation, "invalid", "expired work never returns a valid success");
    assert.equal(typeof outcome.value.terminalReason === "string" && outcome.value.terminalReason.length > 0, true, "the bounded terminal reason is latched");
  }
  assert.equal(log.aborts, 1, "the once-owned abort is requested exactly once");
  await rm(base, { recursive: true, force: true });
});

async function boundaryFixture() {
  const base = await mkdtemp(join(tmpdir(), "qe-k05-b95-"));
  const cwd = join(base, "project");
  const agentDir = join(cwd, "agent-state");
  await mkdir(agentDir, { recursive: true });
  const state = { revoked: false, hooks: null as ReviewerSessionHooks | null, log: { aborts: 0, disposes: 0 } };
  let ready: (() => void) | null = null;
  const readyPromise = new Promise<void>(resolve => { ready = resolve; });
  const host: ReviewerHost = {
    async createSession(input): Promise<ReviewerSession> {
      state.hooks = input.hooks;
      ready?.();
      return { dispose: () => { state.log.disposes += 1; } } as unknown as ReviewerSession;
    },
    async prompt(): Promise<void> { /* the control drives the hooks directly */ },
    async abort(): Promise<void> { state.log.aborts += 1; },
  };
  const input = {
    runId: "k05-b95", cwd, agentDir, promptText: "boundary", tools: ["read"] as readonly string[],
    maxModelRequests: 4, maxToolCalls: 8, maxAdditionalReadBytes: 4096, timeoutMs: 60_000, repairAttempts: 0,
    signal: new AbortController().signal,
    streamTurn: async () => ({ ok: true, value: { stream: { async *[Symbol.asyncIterator]() { /* no events */ } } } }),
    validate: () => ({ valid: false, reason: "not a submission" }),
    isRevoked: () => state.revoked,
  } as unknown as ReviewerRunInput;
  const outcomePromise = runReviewerSession(input, host);
  await readyPromise;
  return { base, state, outcomePromise };
}

test("K05 S2: expired noteToolResult is never adopted while the live one is accounted", async () => {
  const fixture = await boundaryFixture();
  try {
    const admitted = await fixture.state.hooks!.beginTurn({}, {});
    assert.equal(admitted.ok, true, "the first turn is admitted while live");
    fixture.state.hooks!.noteToolResult("read", 64, { toolCallId: "live-1", path: "notes.md" });
    fixture.state.revoked = true;              // expire manually; no timer or poll callback is delivered
    fixture.state.hooks!.noteToolResult("read", 64, { toolCallId: "late-1", path: "notes.md" });
    const outcome = await fixture.outcomePromise;
    assert.equal(outcome.ok, true, "the run settles boundedly");
    if (outcome.ok) {
      assert.equal(outcome.value.additionalReadBytes, 64, "only the live note is adopted; the expired note is refused");
      assert.equal(outcome.value.validation, "invalid", "expired content never yields a valid success");
      assert.equal(outcome.value.terminalReason, "core.run-revoked", "the expiry is latched as the bounded terminal");
    }
    assert.equal(fixture.state.log.aborts, 1, "the once-owned abort is requested exactly once");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("K05 S3: an expired beginTurn fails without any earlier tool denial", async () => {
  const fixture = await boundaryFixture();
  try {
    fixture.state.revoked = true;              // expiry first: no allowToolCall, no other latch has run
    const refused = await fixture.state.hooks!.beginTurn({}, {});
    assert.equal(refused.ok, false, "an expired beginTurn is refused on its own authority");
    const outcome = await fixture.outcomePromise;
    assert.equal(outcome.ok, true, "the run settles boundedly");
    if (outcome.ok) assert.equal(outcome.value.validation, "invalid", "no valid success after admission refusal");
  } finally {
    await rm(fixture.base, { recursive: true, force: true });
  }
});

async function submitFixture(validate: (payload: unknown) => { valid: boolean; reason: string }) {
  const base = await mkdtemp(join(tmpdir(), "qe-k05-s98-"));
  const cwd = join(base, "project");
  const agentDir = join(cwd, "agent-state");
  await mkdir(agentDir, { recursive: true });
  const promptEntered = deferred<void>();
  const promptRelease = deferred<void>();
  const cleanupEntered = deferred<void>();
  const cleanupRelease = deferred<void>();
  const state = { revoked: false, hooks: null as ReviewerSessionHooks | null, aborts: 0, disposes: 0 };
  const validationCalls = { count: 0 };
  const host: ReviewerHost = {
    async createSession(input): Promise<ReviewerSession> {
      state.hooks = input.hooks;
      return { dispose: () => { state.disposes += 1; } } as unknown as ReviewerSession;
    },
    async prompt(): Promise<void> { promptEntered.resolve(); await promptRelease.promise; },
    async abort(): Promise<void> { state.aborts += 1; cleanupEntered.resolve(); await cleanupRelease.promise; },
  };
  const input = {
    runId: "k05-s98", cwd, agentDir, promptText: "submit", tools: ["read"] as readonly string[],
    maxModelRequests: 4, maxToolCalls: 8, maxAdditionalReadBytes: 4096, timeoutMs: 60_000, repairAttempts: 0,
    signal: new AbortController().signal,
    streamTurn: async () => ({ ok: true, value: { stream: { async *[Symbol.asyncIterator]() { /* no events */ } } } }),
    validate: (payload: unknown) => { validationCalls.count += 1; return validate(payload); },
    isRevoked: () => state.revoked,
  } as unknown as ReviewerRunInput;
  const outcomePromise = runReviewerSession(input, host);
  return { base, state, validationCalls, outcomePromise, promptEntered: promptEntered.promise, promptRelease: promptRelease.resolve,
    cleanupEntered: cleanupEntered.promise, cleanupRelease: cleanupRelease.resolve };
}

const bounded = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([promise, new Promise<T>((_, reject) => { setTimeout(() => reject(new Error("bound elapsed: " + label)), ms); })]);

test("K05 S1: a valid submission after expiry is never accepted (no earlier latch)", async () => {
  const approved = { conclusion: "no-supported-finding", findings: [] };
  const fixture = await submitFixture(payload => (payload === approved ? { valid: true, reason: "approved" } : { valid: false, reason: "unapproved" }));
  try {
    fixture.state.revoked = true;                 // expiry first: no beginTurn, no tool denial, no timer
    fixture.state.hooks!.submit(approved);        // otherwise validator-approved payload
    fixture.promptRelease();
    await bounded(fixture.cleanupEntered, 8000, "cleanup entry (negative)");
    fixture.cleanupRelease();
    const outcome = await bounded(fixture.outcomePromise, 10_000, "runner settlement (negative)");
    assert.equal(fixture.validationCalls.count, 0, "an expired submission is never validated");
    assert.equal(outcome.ok, true, "the run settles boundedly");
    if (outcome.ok) {
      assert.equal(outcome.value.validation, "invalid", "an expired submission is never accepted");
      assert.equal(outcome.value.output, null, "no expired payload becomes adopted output");
      assert.equal(outcome.value.terminalReason, "core.run-revoked", "the expiry is latched as the bounded terminal");
    }
    assert.equal(fixture.state.aborts, 1, "the once-owned abort is requested exactly once");
    assert.equal(fixture.state.disposes, 1, "the session is disposed exactly once");
  } finally {
    fixture.promptRelease(); fixture.cleanupRelease();
    await bounded(fixture.outcomePromise, 10_000, "final settlement (negative)");
    await rm(fixture.base, { recursive: true, force: true });
  }
});

test("K05 S2: a timely valid submission stays accepted while cleanup is held, and a late expired submission cannot reopen it", async () => {
  const firstApprovedPayload = { conclusion: "no-supported-finding", findings: [] };
  const otherApprovedPayload = { conclusion: "findings", findings: [{ id: "late" }] };
  const fixture = await submitFixture(payload =>
    (payload === firstApprovedPayload || payload === otherApprovedPayload) ? { valid: true, reason: "approved" } : { valid: false, reason: "unapproved" });
  try {
    await bounded(fixture.promptEntered, 8000, "prompt entry");      // real prompt ENTRY, not a generic ready
    assert.equal((await fixture.state.hooks!.beginTurn({}, {})).ok, true, "the first turn is admitted while live");
    fixture.state.hooks!.submit(firstApprovedPayload);
    assert.equal(fixture.validationCalls.count, 1, "the timely payload is validated exactly once");
    fixture.promptRelease();                                        // authority STILL live
    await bounded(fixture.cleanupEntered, 8000, "cleanup entry (positive)");
    assert.equal(fixture.state.revoked, false, "authority is still live at cleanup entry");
    const settledWhileHeld = await Promise.race([fixture.outcomePromise.then(() => true), new Promise<boolean>(resolve => { setTimeout(() => resolve(false), 60); })]);
    assert.equal(settledWhileHeld, false, "the terminal-return decision has not settled while cleanup is held");
    fixture.state.revoked = true;
    fixture.state.hooks!.submit(otherApprovedPayload);               // must not acquire fresh result authority
    assert.equal(fixture.validationCalls.count, 1, "the late expired submission is not validated");
    fixture.cleanupRelease();
    const outcome = await bounded(fixture.outcomePromise, 10_000, "runner settlement (positive)");
    assert.equal(outcome.ok, true, "the run settles boundedly");
    if (outcome.ok) {
      assert.equal(outcome.value.validation, "valid", "the timely committed result stays valid");
      assert.equal(outcome.value.terminalReason, "core.review-submitted", "the accepted decision stays sticky");
      assert.deepEqual(outcome.value.output, firstApprovedPayload, "the first approved payload is preserved exactly");
    }
    assert.equal(fixture.state.aborts, 1, "the once-owned abort is requested exactly once");
    assert.equal(fixture.state.disposes, 1, "the session is disposed exactly once");
  } finally {
    fixture.promptRelease(); fixture.cleanupRelease();
    await bounded(fixture.outcomePromise, 10_000, "final settlement (positive)");
    await rm(fixture.base, { recursive: true, force: true });
  }
});
