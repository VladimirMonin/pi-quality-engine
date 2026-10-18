// K07 recovery/unsettled family: a real child process is killed inside one of
// three controlled windows (intent before dispatch, dispatch before receipt,
// receipt before restart). The parent then restores the same observed session
// from the actual protected checkpoint and proves the strongest retained state,
// no duplicate action/expert recreation and no blind resend.
//
// This is the offline Windows fixture the assignment allows: the child is a real
// Node process using only the public EngineSession surface; no production crash
// flag, private map access or fixture-aware product behavior.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { EngineSession, SessionPhysicalState } from "../dist/runtime.js";
import { createPiReviewerHost, piModelRegistryPort } from "../dist/adapters/pi-models.js";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

// Fixture-local scripted-provider helpers (the T02 stream protocol mirror).
function assistantMessage(model, content, stopReason) {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}
function eventStream(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...message, content: [] } };
      yield { type: "done", reason: message.stopReason, message };
    },
    async result() { return message; },
  };
}
import { ModelService } from "../dist/models.js";
import { parseFinancialSnapshot } from "../dist/checkpoint.js";

const REPO = resolve(".");
const RESOURCES_DIR = join(REPO, "resources");
const CHILD = join(REPO, "test", "fixtures", "k07-recovery-child.mjs");

function config() {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: {
      boundaryWaitMs: 0, maxFeedbackPerEpisode: 9, maxAutonomousFollowUpsPerEpisode: 1,
      maxEscalationsPerEpisode: 2, maxEscalationDepth: 1, maxRetiredUnsettledOperations: 1, restore: "reconcile-only",
    },
    permissions: { actions: ["fixture.blocking"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: { repeat: { use: "core.repeated-tools", options: { minimumRepeats: 1 } } },
    policies: { fixture: { use: "fixture.blocking-policy" } },
    checks: {
      blocking: {
        triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }],
        context: "recent-work", prompt: "repetition", evaluator: "repeat", policy: "fixture",
        cooldownMs: 0, criteria: ["efficiency.repetition"],
      },
    },
    observability: {},
  };
}

/** The fixture policy that proposes the blocking action without findings. */
function fixturePolicyModule() {
  return {
    id: "fixture.blocking-policy",
    apiMajor: 1,
    kind: "policy",
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.blocking-proposed"],
    decide: () => ({
      outcome: "propose",
      reasonCode: "supported-concern",
      actions: [{
        localId: "blocking-1",
        action: "fixture.blocking",
        options: { delivery: "steer" },
        findingIds: [],
        evidenceIds: [],
        reasonCode: "fixture.blocking-proposed",
      }],
    }),
  };
}

async function waitForFile(path, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  throw new Error(`fixture deadline: ${label}`);
}

async function readCheckpointActions(agentDir) {
  const stateDirectory = join(agentDir, "quality", "state");
  for (const name of await readdir(stateDirectory).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(await readFile(join(stateDirectory, name), "utf8"));
    if (Array.isArray(parsed["actions"])) return parsed["actions"];
  }
  return [];
}

async function runWindow(mode) {
  const root = await mkdtemp(join(tmpdir(), `qe-k07-rec-${mode}-`));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-rec-${mode}-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(config()), "utf8");
  const child = spawn(process.execPath, [CHILD, root, mode, sessionId], {
    cwd: REPO,
    env: { QE_K07_REPO: REPO, PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? tmpdir(), TMP: process.env.TMP ?? tmpdir() },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += String(chunk); });
  const marker = join(root, `marker-${mode}.txt`);
  try {
    try {
      await waitForFile(marker, 30_000, `child ${mode} marker`);
    } catch (error) {
      let journalTail = "";
      try {
        for (const name of await readdir(join(agentDir, "quality", "logs"))) {
          if (name.endsWith(".jsonl")) journalTail += await readFile(join(agentDir, "quality", "logs", name), "utf8");
        }
      } catch { /* no journal */ }
      const events = journalTail.split(String.fromCharCode(10)).filter(Boolean).map(line => {
        try { const r = JSON.parse(line); return `${r.event}:${JSON.stringify(r.fields?.data ?? {}).slice(0, 160)}`; } catch { return "?"; }
      });
      throw new Error(`${error.message}; child stderr: ${stderr.slice(0, 500)}; child events: ${events.slice(-8).join(" | ")}`);
    }
    const actionId = (await readFile(marker, "utf8")).trim();
    assert.notEqual(actionId.length, 0);
    // Real process kill inside the controlled window; no graceful retirement.
    child.kill("SIGKILL");
    await new Promise(resolvePromise => child.once("exit", resolvePromise));
    assert.equal(child.signalCode, "SIGKILL", `the child was actually killed (${mode})`);
    // The durable intent names the same action.
    const beforeActions = await readCheckpointActions(agentDir);
    const intent = beforeActions.find(entry => entry.actionId === actionId);
    assert.ok(intent, `the durable intent names the admitted action (${mode})`);
    assert.equal(["queued", "dispatched", "unknown"].includes(intent.state), true, `intent state is unresolved (${mode}: ${intent.state})`);
    assert.equal(JSON.stringify(beforeActions).includes("[quality-advice"), false, "no note body in the checkpoint");
    const acceptedBefore = (await readFile(join(root, "accepted.txt"), "utf8").catch(() => "")).split(String.fromCharCode(10)).filter(Boolean);
    if (mode === "intent") assert.equal(acceptedBefore.length, 0, "no receiver call before dispatch");
    else assert.equal(acceptedBefore.length, 1, "the real receiver accepted once before the kill");
    // Restore the same observed session from the actual checkpoint.
    const parentCalls = [];
    const session = await EngineSession.start({
      observedSessionId: sessionId,
      branchId: "unresolved",
      agentDir,
      projectConfigDir,
      projectTrusted: true,
      hostVersion: "1.1.0",
      hostMode: "rpc",
      resourcesDir: RESOURCES_DIR,
      hostIdleAtStart: true,
      feedbackHost: {
        capabilities: () => new Set(["host.feedback.steer"]),
        deliver: async request => {
          parentCalls.push(request.actionId);
          return { actionId: request.actionId, state: "queued", destinationId: "fixture.parent", evidenceIds: [] };
        },
        reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
      },
    });
    try {
      const readyDeadline = Date.now() + 10_000;
      while (session.status(true).checks.total === 0 && Date.now() < readyDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      }
      await session.retire("fixture-complete");
      const afterActions = await readCheckpointActions(agentDir);
      const retained = afterActions.find(entry => entry.actionId === actionId);
      assert.ok(retained, `the restored generation keeps the same action identity (${mode})`);
      assert.equal(afterActions.filter(entry => entry.state !== "included").length >= 1, true, "the uncertain identity is retained, not evicted");
      assert.equal(parentCalls.length, 0, "the restored generation never resends the uncertain note");
      assert.equal(afterActions.some(entry => entry.actionId !== actionId && entry.state === "queued"), false, "no fabricated second action id is created by the restore");
    } finally {
      await session.retire("fixture-complete");
    }
    return { mode, actionId, acceptedBefore: acceptedBefore.length, stderr };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
}

test("K07-B.05/B.07/T.03: a killed child leaves the same uncertain identity and the restore resends nothing", { timeout: 180_000 }, async () => {
  for (const mode of ["intent", "dispatch", "receipt"]) {
    const result = await runWindow(mode);
    assert.equal(result.acceptedBefore <= 1, true, `receiver acceptance bounded in ${mode}`);
  }
});

// ---------------------------------------------------------------------------
// K07 229-B: one real held model transport across retirement/restore, the
// canonical retired-unsettled bound, and late same-attempt reconciliation at
// the original immutable price A.
// ---------------------------------------------------------------------------

function noFindingResult() {
  return {
    operational: "completed",
    coverage: { state: "complete", scopeDescription: "synthetic direct assessment", issues: [] },
    conclusion: "no-supported-finding",
    findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
  };
}

function heldPort(state) {
  return {
    findChat: () => ({ provider: "fixture", model: "scripted-1" }),
    findClassifier: () => ({ provider: "fixture", model: "scripted-1" }),
    hasConfiguredAuth: () => true,
    async completeChat() {
      state.entered += 1;
      state.active += 1;
      try {
        await state.latch;
      } finally {
        state.active -= 1;
        state.settled += 1;
      }
      return {
        text: JSON.stringify(noFindingResult()),
        model: { provider: "fixture", id: "scripted-1", revision: null },
        usage: state.usage,
        stopReason: "stop",
        errorCode: null,
      };
    },
    async classify() { throw new Error("fixture classifier is not used"); },
  };
}

function modelConfig(priceRevision) {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: {
      maxConcurrentEvaluations: 2,
      maxRetiredUnsettledOperations: 1,
      restore: "reconcile-only",
      boundaryWaitMs: 0,
    },
    modelProfiles: {
      scripted: {
        provider: "fixture",
        model: "scripted-1",
        maxAttempts: 1,
        price: {
          currency: "USD",
          revision: priceRevision,
          inputPerMillion: "0.20",
          outputPerMillion: "0.80",
          cacheReadPerMillion: "0.02",
          cacheWritePerMillion: "0",
        },
      },
    },
    permissions: { modelProfiles: ["scripted"] },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { direct: { use: "core.chat", modelProfile: "scripted", options: {} } },
    policies: { record: { use: "core.record-only" } },
    checks: {
      direct: {
        triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }],
        context: "work", prompt: "repetition", evaluator: "direct", policy: "record",
        cooldownMs: 0, criteria: ["efficiency.repetition"],
      },
    },
    observability: {},
  };
}

/**
 * Reads the actual protected checkpoint and returns the full financial projection
 * (scalar attempt rows: usageRevision/totalTokens/usageCoverage/cost/price/
 * reservations), never an in-memory `usage` blob the checkpoint does not have.
 */
async function protectedCheckpoint(agentDir, observedSessionId) {
  const stateDirectory = join(agentDir, "quality", "state");
  for (const name of await readdir(stateDirectory).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(await readFile(join(stateDirectory, name), "utf8"));
    if (parsed["observedSessionId"] === observedSessionId && parsed["financial"]?.attempts !== undefined) {
      return { checkpoint: parsed, financial: parsed["financial"], attempts: parsed["financial"].attempts };
    }
  }
  return null;
}

test("K07-B.04/T.09/X.02: a held transport survives retirement, blocks dependent work and reconciles once at price A", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-held-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-held-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(modelConfig("price-A")), "utf8");
  let release = null;
  const latch = new Promise(resolvePromise => { release = resolvePromise; });
  const state = {
    entered: 0,
    active: 0,
    settled: 0,
    latch,
    usage: { input: 10000, cacheRead: 8000, cacheWrite: 0, output: 600, reasoning: 200, totalTokens: 10600 },
  };
  const inputFor = port => ({
    observedSessionId: sessionId,
    branchId: "unresolved",
    agentDir,
    projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: RESOURCES_DIR,
    hostIdleAtStart: true,
    modelRegistry: port,
  });
  const sessionA = await EngineSession.start(inputFor(heldPort(state)));
  let sessionC;
  try {
    const readyA = Date.now() + 10_000;
    while (sessionA.status(true).checks.active === 0 && Date.now() < readyA) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    const at = new Date().toISOString();
    sessionA.handlePrimaryEvent({ type: "operator-input", text: "held model work", source: "interactive", occurredAt: at });
    sessionA.handlePrimaryEvent({ type: "tool-started", operationId: "held-1", toolName: "read", parentOperationId: null, occurredAt: at });
    sessionA.handlePrimaryEvent({ type: "tool-completed", operationId: "held-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
    const enteredDeadline = Date.now() + 20_000;
    while (state.entered === 0 && Date.now() < enteredDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    assert.equal(state.entered, 1, "the owned model transport was actually entered");
    assert.equal(state.active, 1, "the transport is physically held");
    assert.equal(state.settled, 0, "the transport is not settled");
    const accounting = sessionA.status(true).accounting;
    assert.equal(accounting?.ownedRequestCount ?? accounting?.requests, 1, "one owned model request");
    const before = await protectedCheckpoint(agentDir, sessionId);
    assert.ok(before !== null, "the protected checkpoint is readable");
    assert.equal(before.financial.ownedRequestCount, 1, "the checkpoint owns one request");
    assert.equal(before.attempts.length, 1, "the protected checkpoint carries one attempt row");
    const attempt = before.attempts[0];
    const originalAttemptId = attempt.attemptId;
    assert.equal(attempt.totalTokens, null, "the held attempt has no known tokens");
    assert.equal(attempt.usageCoverage, "unknown", "the held attempt usage coverage is unknown");
    assert.equal(attempt.usageRevision, 0, "the held attempt has no usage revision yet");
    assert.equal(attempt.costAmount ?? null, null, "the held attempt has no cost yet");
    assert.equal(["dispatched", "unresolved", "reserved"].includes(attempt.state), true, `the attempt is unresolved (${attempt.state})`);
    assert.equal(Number(attempt.reservedTokens) > 0, true, "a nonzero token reservation is retained");
    // Retire A while the raw transport ignores cancellation; the gate stays closed.
    await sessionA.retire("replaced");
    const childPortState = { entered: 0, settled: 0 };
    const childPort = {
      findChat: () => ({ provider: "fixture", model: "scripted-1" }),
      findClassifier: () => ({ provider: "fixture", model: "scripted-1" }),
      hasConfiguredAuth: () => true,
      async completeChat() {
        childPortState.entered += 1;
        return { text: JSON.stringify(noFindingResult()), model: { provider: "fixture", id: "scripted-1", revision: null }, usage: null, stopReason: "stop", errorCode: null };
      },
      async classify() { throw new Error("unused"); },
    };
    sessionC = await EngineSession.start(inputFor(childPort));
    const readyC = Date.now() + 10_000;
    while (sessionC.status(true).checks.active === 0 && Date.now() < readyC) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    // Spare total evaluation capacity (2) and a valid grant, but the retired
    // unsettled operation keeps dependent work denied.
    const atC = new Date().toISOString();
    sessionC.handlePrimaryEvent({ type: "operator-input", text: "dependent work after restore", source: "interactive", occurredAt: atC });
    sessionC.handlePrimaryEvent({ type: "tool-started", operationId: "held-2", toolName: "read", parentOperationId: null, occurredAt: atC });
    sessionC.handlePrimaryEvent({ type: "tool-completed", operationId: "held-2", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: atC });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    assert.equal(childPortState.entered, 0, "no dependent model transport runs while the retired operation is unsettled");
    const denied = sessionC.status(true).diagnostics.recentEvents
      .filter(record => record.event === "quality.check.admission")
      .map(record => record.fields.data)
      .filter(entry => entry.outcome === "denied")
      .flatMap(entry => entry.reasonCodes ?? []);
    assert.equal(denied.includes("core.retired-unsettled-limit"), true, `the retired-unsettled bound denies dependent work (${denied.join(",") || "nothing"})`);
    // Release the original transport: the late usage settles the SAME attempt.
    release();
    const settleDeadline = Date.now() + 20_000;
    while (state.settled === 0 && Date.now() < settleDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    assert.equal(state.settled, 1, "the original transport settled exactly once");
    // The late receipt must reach the CURRENT generation's protected state. Read
    // the checkpoint directly (no status()/syncOwnedReceipts) so an explicit sync
    // cannot mask whether the active notification path persisted it.
    let after = null;
    let settledRow = null;
    const persistDeadline = Date.now() + 20_000;
    while (Date.now() < persistDeadline) {
      after = await protectedCheckpoint(agentDir, sessionId);
      const row = after?.attempts.find(entry => entry.attemptId === originalAttemptId) ?? null;
      if (row !== null && row.state === "settled" && row.usageRevision >= 1) { settledRow = row; break; }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
    assert.ok(settledRow, `the same attempt identity settles in the current protected state (${JSON.stringify(after?.attempts ?? [])})`);
    assert.equal(settledRow.state, "settled", "the original attempt is settled");
    assert.equal(settledRow.usageRevision, 1, "the material usage revision advanced once");
    assert.equal(settledRow.totalTokens, 10600, "the late usage total is the reported 10600, not a doubled sum");
    assert.equal(["complete", "partial"].includes(settledRow.usageCoverage), true, `usage coverage is honestly reported (${settledRow.usageCoverage})`);
    assert.equal(settledRow.costAmount, "0.00104", "the original price A produced the exact charge");
    assert.equal(settledRow.costCurrency, "USD");
    assert.equal(JSON.stringify(settledRow.price).includes("price-A") || settledRow.priceRevision === "price-A", true, "the original price revision is unchanged");
    assert.equal(after.financial.ownedRequestCount, 1, "the owned request count did not grow on late settlement");
    const totals = sessionC.status(true).accounting;
    assert.equal(totals?.ownedRequestCount ?? totals?.requests, 1, "the owned request count stays one in status");
    // After genuine drain, one explicitly new request on the current generation.
    const atD = new Date().toISOString();
    sessionC.handlePrimaryEvent({ type: "operator-input", text: "new work after drain", source: "interactive", occurredAt: atD });
    sessionC.handlePrimaryEvent({ type: "tool-started", operationId: "held-3", toolName: "read", parentOperationId: null, occurredAt: atD });
    sessionC.handlePrimaryEvent({ type: "tool-completed", operationId: "held-3", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: atD });
    const newDeadline = Date.now() + 20_000;
    while (childPortState.entered === 0 && Date.now() < newDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    assert.equal(childPortState.entered, 1, "after drain the dependent route admits one genuinely new request");
  } finally {
    release?.();
    await sessionA.retire("fixture-complete").catch(() => undefined);
    await sessionC?.retire("fixture-complete").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// K07 233-B.4 timeout schedule: the dispatch timeout returns the attempt
// logically while the raw transport is still physically running. The shared
// physical state keeps the operation owned, dependent same-route work stays
// denied with spare capacity, and only actual drain releases it.
test("K07-B.04/T.09/X.02 timeout: logical return keeps the raw transport owned until actual drain", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-timeout-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-timeout-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  const config = modelConfig("price-A");
  config.modelProfiles.scripted.requestTimeoutMs = 1_000;
  config.runtime.defaultRunTimeoutMs = 30_000;
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(config), "utf8");
  let release = null;
  const latch = new Promise(resolvePromise => { release = resolvePromise; });
  const state = {
    entered: 0,
    returned: 0,
    active: 0,
    settled: 0,
    latch,
    usage: { input: 10000, cacheRead: 8000, cacheWrite: 0, output: 600, reasoning: 200, totalTokens: 10600 },
  };
  const port = {
    findChat: () => ({ provider: "fixture", model: "scripted-1" }),
    findClassifier: () => ({ provider: "fixture", model: "scripted-1" }),
    hasConfiguredAuth: () => true,
    async completeChat() {
      state.entered += 1;
      state.active += 1;
      try {
        await state.latch;
        state.returned += 1;
      } finally {
        state.active -= 1;
        state.settled += 1;
      }
      return {
        text: JSON.stringify(noFindingResult()),
        model: { provider: "fixture", id: "scripted-1", revision: null },
        usage: state.usage,
        stopReason: "stop",
        errorCode: null,
      };
    },
    async classify() { throw new Error("fixture classifier is not used"); },
  };
  const physicalState = new SessionPhysicalState();
  const session = await EngineSession.start({
    observedSessionId: sessionId,
    branchId: "unresolved",
    agentDir,
    projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: RESOURCES_DIR,
    hostIdleAtStart: true,
    modelRegistry: port,
    physicalState,
  });
  let driveSerial = 0;
  const driveOnce = () => {
    driveSerial += 1;
    const at = new Date().toISOString();
    const operationId = `timeout-op-${driveSerial}`;
    session.handlePrimaryEvent({ type: "operator-input", text: `timeout work ${driveSerial}`, source: "interactive", occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-started", operationId, toolName: "read", parentOperationId: null, occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-completed", operationId, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
  };
  try {
    const readyDeadline = Date.now() + 10_000;
    while (session.status(true).checks.active === 0 && Date.now() < readyDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    assert.equal(session.status(true).configuration.rejection, null, `the timeout configuration applies (${JSON.stringify(session.status(true).configuration.rejection)})`);
    driveOnce();
    const enteredDeadline = Date.now() + 20_000;
    while (state.entered === 0 && Date.now() < enteredDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    assert.equal(state.entered, 1, `the owned raw transport was entered (${JSON.stringify({ checks: session.status(true).checks, events: session.status(true).diagnostics.recentEvents.map(record => record.event).slice(-10) })})`);
    // The request timeout (1000 ms) returns the attempt logically while the raw
    // transport ignores its signal and stays physically active.
    const logicalDeadline = Date.now() + 20_000;
    let runSettled = false;
    while (!runSettled && Date.now() < logicalDeadline) {
      runSettled = session.status(true).diagnostics.recentEvents
        .some(record => record.event === "quality.check.settled");
      if (!runSettled) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
    assert.equal(runSettled, true, "the evaluator/logical attempt returned after the request timeout");
    assert.equal(state.entered, 1, "no second transport arrived");
    assert.equal(state.returned, 0, "the raw transport has not returned yet");
    assert.equal(state.active, 1, "the raw transport remains physically active");
    const during = await protectedCheckpoint(agentDir, sessionId);
    assert.ok(during !== null, "the protected checkpoint is readable during the timeout");
    assert.equal(during.attempts.length, 1, "one physical attempt is retained");
    // The timeout race keeps the physical operation unresolved (reservations
    // retained); depending on the exact phase boundary the row is still
    // `dispatched` or already `unresolved`. Both are physically unsettled.
    assert.equal(["dispatched", "unresolved"].includes(during.attempts[0].state), true, `the attempt stays physically unsettled after the logical return (${during.attempts[0].state})`);
    assert.equal(during.attempts[0].totalTokens, null, "no usage is known while the transport is held");
    assert.equal(Number(during.attempts[0].reservedTokens) > 0, true, "the reservation is retained");
    // Dependent same-route work with spare total capacity (2) and a valid grant.
    driveOnce();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 700));
    assert.equal(state.entered, 1, "dependent work does not reach the provider while the raw transport is unsettled");
    const denied = session.status(true).diagnostics.recentEvents
      .filter(record => record.event === "quality.check.admission")
      .map(record => record.fields.data)
      .filter(entry => entry.outcome === "denied")
      .flatMap(entry => entry.reasonCodes ?? []);
    assert.equal(denied.includes("core.unsettled-operation-limit"), true, `the live unsettled operation denies dependent work (${denied.join(",") || "nothing"})`);
    // Release once; await actual physical exit and the persisted receipt.
    release();
    const returnedDeadline = Date.now() + 20_000;
    while (state.returned === 0 && Date.now() < returnedDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    // The original transport returned; a retained dependent cause may also wake
    // and return its own (new) attempt after the physical release.
    assert.equal(state.returned >= 1, true, `the original raw transport actually returned (returns ${state.returned})`);
    let settledRow = null;
    const persistDeadline = Date.now() + 20_000;
    while (Date.now() < persistDeadline) {
      const after = await protectedCheckpoint(agentDir, sessionId);
      const row = after?.attempts.find(entry => entry.attemptId === during.attempts[0].attemptId) ?? null;
      if (row !== null && row.state === "settled" && row.usageRevision >= 1) { settledRow = row; break; }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
    assert.ok(settledRow, "the same attempt settles after actual drain");
    assert.equal(settledRow.totalTokens, 10600, "the late usage total is recorded once");
    assert.equal(settledRow.costAmount, "0.00104", "the original price A charge is recorded");
    // Only after actual drain a useful new request is admitted.
    driveOnce();
    const newDeadline = Date.now() + 20_000;
    while (state.entered === 1 && Date.now() < newDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    // The denied dependent cause is retained and may legitimately auto-launch on
    // the physical-release wake; the explicit post-drain drive adds another. Both
    // are genuinely new attempts after drain (233 phase-control note).
    assert.equal(state.entered >= 2, true, `the dependent route admits a genuinely new request only after drain (arrivals ${state.entered})`);
  } finally {
    release?.();
    await session.retire("fixture-complete").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// K07 233 B.1–B.3/B.5/B.6 composed schedule: A holds a real raw transport at
// price-A, retires, a REAL fresh child reopens the actual unknown-model checkpoint
// and exits before C, C shares A's physical state with tariff-B, the old receipt
// is persisted automatically before any status/sync/new request, an authentic
// settled snapshot replays without duplication, and a genuinely new price-B
// request is admitted only after genuine drain.
test("K07-B.01/B.02/B.03/B.05/B.06: held price-A retirement, fresh-child restore, automatic current persistence, replay and price-B request", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-composed-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-composed-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(modelConfig("price-A")), "utf8");
  let release = null;
  const latch = new Promise(resolvePromise => { release = resolvePromise; });
  const state = { entered: 0, returned: 0, active: 0, settled: 0, latch, usage: { input: 10000, cacheRead: 8000, cacheWrite: 0, output: 600, reasoning: 200, totalTokens: 10600 } };
  const port = {
    findChat: () => ({ provider: "fixture", model: "scripted-1" }),
    findClassifier: () => ({ provider: "fixture", model: "scripted-1" }),
    hasConfiguredAuth: () => true,
    async completeChat() {
      state.entered += 1;
      state.active += 1;
      try {
        await state.latch;
        state.returned += 1;
      } finally {
        state.active -= 1;
        state.settled += 1;
      }
      return { text: JSON.stringify(noFindingResult()), model: { provider: "fixture", id: "scripted-1", revision: null }, usage: state.usage, stopReason: "stop", errorCode: null };
    },
    async classify() { throw new Error("unused"); },
  };
  const physicalState = new SessionPhysicalState();
  const baseInput = {
    observedSessionId: sessionId,
    branchId: "unresolved",
    agentDir,
    projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: RESOURCES_DIR,
    hostIdleAtStart: true,
  };
  const sessionA = await EngineSession.start({ ...baseInput, modelRegistry: port, physicalState });
  let sessionC;
  try {
    const readyA = Date.now() + 10_000;
    while (sessionA.status(true).checks.active === 0 && Date.now() < readyA) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    const atA = new Date().toISOString();
    sessionA.handlePrimaryEvent({ type: "operator-input", text: "held price-A work", source: "interactive", occurredAt: atA });
    sessionA.handlePrimaryEvent({ type: "tool-started", operationId: "comp-1", toolName: "read", parentOperationId: null, occurredAt: atA });
    sessionA.handlePrimaryEvent({ type: "tool-completed", operationId: "comp-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: atA });
    const enteredDeadline = Date.now() + 20_000;
    while (state.entered === 0 && Date.now() < enteredDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    assert.equal(state.entered, 1, "A holds one raw transport");
    const before = await protectedCheckpoint(agentDir, sessionId);
    assert.ok(before !== null, "A's protected checkpoint is readable");
    const original = before.attempts[0];
    assert.equal(original.state, "dispatched", "A's attempt is dispatched before retirement");
    assert.equal(original.totalTokens, null, "A has no usage yet");
    assert.equal(Number(original.reservedTokens) > 0, true, "A retains a token reservation");
    await sessionA.retire("replaced");
    // Real fresh child reopens the actual checkpoint, witnesses the same unknown
    // identity/reservations and the dependent denial, then exits before C opens.
    const child = spawn(process.execPath, [CHILD, root, "model-unknown", sessionId], {
      cwd: REPO,
      env: { QE_K07_REPO: REPO, PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "", TEMP: process.env.TEMP ?? tmpdir(), TMP: process.env.TMP ?? tmpdir() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const childExited = new Promise(resolvePromise => child.once("exit", (code, signal) => resolvePromise({ code, signal })));
    const childDeadline = Date.now() + 60_000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < childDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    const childResult = await childExited;
    assert.equal(childResult.code, 0, `the fresh child restored the checkpoint and exited natively (${JSON.stringify(childResult)})`);
    const childReceipt = JSON.parse(await readFile(join(root, "child-model-receipt.json"), "utf8"));
    assert.equal(childReceipt.attemptId, original.attemptId, "the child saw the same attempt identity");
    assert.equal(childReceipt.arrivals, 0, "the child launched no model transport");
    assert.equal(childReceipt.denialReasons.includes("core.retired-unsettled-limit"), true, `the child's useful work was denied by the retired bound (${childReceipt.denialReasons.join(",")})`);
    assert.equal(Number(childReceipt.reservedTokens) > 0, true, "the child saw the retained reservation");
    // Generation C: same physical state, genuinely distinct tariff B.
    const configB = modelConfig("price-B");
    configB.modelProfiles.scripted.price.inputPerMillion = "0.50";
    configB.modelProfiles.scripted.price.outputPerMillion = "2.00";
    configB.modelProfiles.scripted.price.cacheReadPerMillion = "0.05";
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configB), "utf8");
    const cState = { entered: 0 };
    const cPort = {
      findChat: () => ({ provider: "fixture", model: "scripted-1" }),
      findClassifier: () => ({ provider: "fixture", model: "scripted-1" }),
      hasConfiguredAuth: () => true,
      async completeChat() {
        cState.entered += 1;
        return { text: JSON.stringify(noFindingResult()), model: { provider: "fixture", id: "scripted-1", revision: null }, usage: { input: 1000, cacheRead: 0, cacheWrite: 0, output: 100, totalTokens: 1100 }, stopReason: "stop", errorCode: null };
      },
      async classify() { throw new Error("unused"); },
    };
    sessionC = await EngineSession.start({ ...baseInput, modelRegistry: cPort, physicalState });
    const readyC = Date.now() + 10_000;
    while (sessionC.status(true).checks.active === 0 && Date.now() < readyC) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    const atC = new Date().toISOString();
    sessionC.handlePrimaryEvent({ type: "operator-input", text: "C dependent work", source: "interactive", occurredAt: atC });
    sessionC.handlePrimaryEvent({ type: "tool-started", operationId: "comp-2", toolName: "read", parentOperationId: null, occurredAt: atC });
    sessionC.handlePrimaryEvent({ type: "tool-completed", operationId: "comp-2", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: atC });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 700));
    assert.equal(cState.entered, 0, "C's valid same-route work stays denied while A is unsettled");
    const deniedC = sessionC.status(true).diagnostics.recentEvents
      .filter(record => record.event === "quality.check.admission")
      .map(record => record.fields.data)
      .filter(entry => entry.outcome === "denied")
      .flatMap(entry => entry.reasonCodes ?? []);
    assert.equal(deniedC.includes("core.retired-unsettled-limit"), true, `C sees the retired bound (${deniedC.join(",") || "nothing"})`);
    // Accepted phase control: disable the check so a retained cause cannot
    // auto-launch during the old-receipt assertions.
    const disabled = modelConfig("price-B");
    disabled.modelProfiles.scripted.price.inputPerMillion = "0.50";
    disabled.modelProfiles.scripted.price.outputPerMillion = "2.00";
    disabled.modelProfiles.scripted.price.cacheReadPerMillion = "0.05";
    disabled.checks.direct.enabled = false;
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(disabled), "utf8");
    assert.equal((await sessionC.reloadConfiguration()).ok, true, "the phase-control disable reload applies");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    // Release A once; observe actual transport return and automatic disk-first
    // persistence of the scalar row before any status/sync/new request.
    release();
    const returnedDeadline = Date.now() + 20_000;
    while (state.returned === 0 && Date.now() < returnedDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    assert.equal(state.returned, 1, "A's raw transport actually returned");
    let settled = null;
    const persistDeadline = Date.now() + 20_000;
    while (Date.now() < persistDeadline) {
      const after = await protectedCheckpoint(agentDir, sessionId);
      const row = after?.attempts.find(entry => entry.attemptId === original.attemptId) ?? null;
      if (row !== null && row.state === "settled" && row.usageRevision >= 1) { settled = { row, financial: after.financial }; break; }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
    assert.ok(settled, "the late receipt was automatically persisted in the current protected state");
    assert.equal(settled.row.totalTokens, 10600, "price-A usage total persisted once");
    assert.equal(settled.row.costAmount, "0.00104", "price-A original charge persisted");
    assert.equal(JSON.stringify(settled.row.price).includes("price-A"), true, "the original price revision is unchanged");
    assert.equal(settled.financial.ownedRequestCount, 1, "owned request count stays one");
    // Authentic settled snapshot replay through the public model restore owner.
    const replayService = new ModelService({
      profiles: configB.modelProfiles,
      approved: ["scripted"],
      registry: cPort,
      budget: { maxRequestsPerSession: 200, maxOwnedTokensPerSession: 400_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
      scope: `replay-${sessionId}`,
    });
    const appliedOnce = replayService.restore(settled.financial);
    const afterOne = replayService.financialSnapshot();
    const appliedTwice = replayService.restore(settled.financial);
    const afterTwo = replayService.financialSnapshot();
    assert.equal(afterTwo.ownedRequestCount, afterOne.ownedRequestCount, "replaying the authentic snapshot adds no request");
    assert.equal(afterTwo.ledgerRevision, afterOne.ledgerRevision, "replaying the authentic snapshot adds no financial ledger revision");
    assert.equal(JSON.stringify(afterTwo.attempts) === JSON.stringify(afterOne.attempts), true, "replaying the authentic snapshot materializes no duplicate row");
    assert.equal(appliedOnce >= 1, true);
    // Re-enable the check and admit a genuinely new price-B request.
    const enabledB = modelConfig("price-B");
    enabledB.modelProfiles.scripted.price.inputPerMillion = "0.50";
    enabledB.modelProfiles.scripted.price.outputPerMillion = "2.00";
    enabledB.modelProfiles.scripted.price.cacheReadPerMillion = "0.05";
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(enabledB), "utf8");
    assert.equal((await sessionC.reloadConfiguration()).ok, true, "the re-enable reload applies");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    const atD = new Date().toISOString();
    sessionC.handlePrimaryEvent({ type: "operator-input", text: "C new price-B work", source: "interactive", occurredAt: atD });
    sessionC.handlePrimaryEvent({ type: "tool-started", operationId: "comp-3", toolName: "read", parentOperationId: null, occurredAt: atD });
    sessionC.handlePrimaryEvent({ type: "tool-completed", operationId: "comp-3", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: atD });
    const newDeadline = Date.now() + 20_000;
    while (cState.entered === 0 && Date.now() < newDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    assert.equal(cState.entered, 1, "after drain C admits exactly one genuinely new request");
    let final = null;
    const finalDeadline = Date.now() + 20_000;
    while (Date.now() < finalDeadline) {
      final = await protectedCheckpoint(agentDir, sessionId);
      const bRow = final?.attempts.find(entry => entry.attemptId !== original.attemptId && entry.state === "settled" && entry.totalTokens === 1100);
      if (bRow !== undefined) break;
      final = null;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
    assert.ok(final, "the new price-B attempt settled with its own usage");
    const bRow = final.attempts.find(entry => entry.attemptId !== original.attemptId);
    assert.equal(JSON.stringify(bRow.price).includes("price-B"), true, "the new attempt uses the distinct price-B revision");
    assert.equal(bRow.costAmount, "0.0007", "the new attempt is priced at B rates (1000×0.50 + 100×2.00 per million = 0.0007)");
    const aRow = final.attempts.find(entry => entry.attemptId === original.attemptId);
    assert.equal(aRow.state, "settled", "A's row is unchanged");
    assert.equal(aRow.costAmount, "0.00104", "A's charge is not repriced by B");
    assert.equal(final.financial.ownedRequestCount, 2, "the new request increments the aggregate only on its own arrival");
  } finally {
    release?.();
    await sessionA.retire("fixture-complete").catch(() => undefined);
    await sessionC?.retire("fixture-complete").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// K07 233-B.05/B.06 effects: a matched live-vs-retired supported-finding control.
// The live run must reach the actual admitted bounded-note receiver; an
// otherwise-identical retired/stale run must produce zero stale effect even
// though its late financial settlement is authentic. Receiver counts and the
// exact run identity are the predicates, not policy prose.
// ---------------------------------------------------------------------------

test("K07-B.05/T.06: a supported finding reaches the receiver live and produces zero effect when retired", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-effects-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-effects-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { boundaryWaitMs: 0, maxFeedbackPerEpisode: 9, maxAutonomousFollowUpsPerEpisode: 1, maxEscalationsPerEpisode: 2, maxEscalationDepth: 1, maxRetiredUnsettledOperations: 1, restore: "reconcile-only" },
    permissions: { actions: ["core.feedback"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: { supported: { use: "fixture.supported", options: {} } },
    policies: { engineering: { use: "core.engineering", options: {} } },
    checks: {
      supported: {
        triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }],
        context: "recent-work", prompt: "repetition", evaluator: "supported", policy: "engineering",
        cooldownMs: 0, criteria: ["efficiency.repetition"],
      },
    },
    observability: {},
  }), "utf8");
  const control = { hold: null, entered: 0 };
  const supportedEvaluator = {
    id: "fixture.supported",
    apiMajor: 1,
    kind: "evaluator",
    mechanism: "deterministic",
    accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.supported-evidence"],
    evaluate: async (_options, input) => {
      control.entered += 1;
      if (control.hold !== null) await control.hold;
      const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
      return {
        operational: "completed",
        coverage: input.context.coverage,
        conclusion: items.length > 0 ? "findings" : "no-supported-finding",
        findings: items.map(item => ({
          id: `${input.run.runId}:finding-1`,
          criterion: "efficiency.repetition",
          status: "supported",
          severity: "concern",
          requirementRefs: [],
          evidenceIds: [item.id],
          affectedItems: [],
          defectCode: "fixture.supported-drift",
          explanation: "supported finding over observed work",
          proposedCorrection: "apply the smallest correction",
          limitations: [],
        })),
        scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [],
      };
    },
  };
  const delivered = [];
  const session = await EngineSession.start({
    observedSessionId: sessionId,
    branchId: "unresolved",
    agentDir,
    projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: RESOURCES_DIR,
    hostIdleAtStart: true,
    feedbackHost: {
      capabilities: () => new Set(["host.feedback.steer"]),
      deliver: async request => {
        delivered.push({ actionId: request.actionId, bytes: Buffer.byteLength(request.text, "utf8") });
        return { actionId: request.actionId, state: "queued", destinationId: "fixture.receiver", evidenceIds: [] };
      },
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
  });
  try {
    const registered = session.endpoint.register({ id: "fixture.k07-effects", version: "0.1.0", baseUri: "fixture:effects", components: [supportedEvaluator], resources: {} });
    assert.equal(registered.ok, true);
    if (registered.ok) await registered.value.ready;
    assert.equal((await session.reloadConfiguration()).ok, true);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    const ready = Date.now() + 10_000;
    while (session.status(true).checks.active === 0 && Date.now() < ready) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    const drive = serial => {
      const at = new Date().toISOString();
      session.handlePrimaryEvent({ type: "operator-input", text: `effects work ${serial}`, source: "interactive", occurredAt: at });
      session.handlePrimaryEvent({ type: "tool-started", operationId: `fx-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
      session.handlePrimaryEvent({ type: "tool-completed", operationId: `fx-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
    };
    // Live control: the supported finding really reaches the admitted receiver.
    drive(1);
    const liveDeadline = Date.now() + 20_000;
    while (delivered.length === 0 && Date.now() < liveDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    assert.equal(delivered.length, 1, "the live supported finding produced one admitted bounded-note receiver effect");
    assert.equal(delivered[0].bytes > 0 && delivered[0].bytes <= 2048, true, "the receiver received a bounded note");
    // Retired counterpart: hold the evaluation, retire the session, then release.
    let release = null;
    control.hold = new Promise(resolvePromise => { release = resolvePromise; });
    const enteredBefore = control.entered;
    drive(2);
    const enteredDeadline = Date.now() + 20_000;
    while (control.entered === enteredBefore && Date.now() < enteredDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    assert.equal(control.entered > enteredBefore, true, "the retired counterpart really started its held evaluation");
    const retiredRunId = `run-${control.entered}`;
    await session.retire("replaced");
    release();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 700));
    assert.equal(delivered.length, 1, "the retired/stale run produced zero additional receiver effect");
    let journal = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    const records = journal.split(String.fromCharCode(10)).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
    const admittedForRetired = records.filter(record => record.event === "quality.action.admission"
      && record.fields?.data?.outcome === "admitted"
      && (record.fields?.correlation?.runId === retiredRunId || record.fields?.data?.actionId !== delivered[0].actionId));
    assert.equal(admittedForRetired.length, 0, `no admitted action is attributed to the retired run (${JSON.stringify(admittedForRetired.map(record => record.fields?.correlation?.runId ?? null))})`);
    const liveAdmissions = records.filter(record => record.event === "quality.action.admission" && record.fields?.data?.outcome === "admitted");
    assert.equal(liveAdmissions.length, 1, "exactly the live run's one admission exists");
    assert.equal(JSON.stringify(liveAdmissions[0].fields?.data?.actionId), JSON.stringify(delivered[0].actionId), "the admission and the receiver effect are the same operation");
  } finally {
    control.hold = null;
    await session.retire("fixture-complete").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// K07 233-B.04/C1 attribution: one physical/uncertain operation is counted once
// across representations; older compatible rows stay honestly unknown and
// conservatively blocking; a confirmed completion with unknown tariff is not
// physically unresolved work.
// ---------------------------------------------------------------------------

test("K07-B.04 attribution: one operation counts once, legacy unknowns block conservatively, unknown-tariff completion does not", () => {
  const row = overrides => ({
    attemptId: "attempt-7",
    state: "unresolved",
    purpose: "direct",
    profileId: "scripted",
    price: { currency: "USD", revision: "price-A", inputPerMillion: "0.20", outputPerMillion: "0.80", cacheReadPerMillion: "0.02", cacheWritePerMillion: "0" },
    usageRevision: 0,
    totalTokens: null,
    usageCoverage: "unknown",
    costAmount: null,
    costCurrency: null,
    reservedTokens: 1234,
    reservedCostAmount: null,
    reservedCostCurrency: null,
    ...overrides,
  });
  const snapshot = attempts => ({
    ledgerRevision: 3,
    ownedRequestCount: 1,
    reservedTokens: 1234,
    knownCostByCurrency: {},
    reservedCostByCurrency: {},
    unresolvedCount: 1,
    attempts,
  });
  const service = options => new ModelService({
    profiles: {},
    approved: [],
    registry: {},
    budget: { maxRequestsPerSession: 200, maxOwnedTokensPerSession: 400_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
    ...options,
  });
  // One operation once, across a repeated authentic restore.
  const single = service({ scope: "attr-single" });
  single.restore(snapshot([row({})]));
  assert.equal(single.physicalUnsettledCount(), 1, "one unresolved row is one physical operation");
  single.restore(snapshot([row({})]));
  assert.equal(single.physicalUnsettledCount(), 1, "re-applying the same authentic snapshot does not double-count the operation");
  // Older compatible rows without origin/price detail stay conservatively blocking.
  const legacy = service({ scope: "attr-legacy" });
  legacy.restore(snapshot([{ attemptId: "attempt-3", state: "unresolved", purpose: "direct", usageRevision: 0, totalTokens: null, usageCoverage: "unknown", costAmount: null, costCurrency: null, reservedTokens: 99 }]));
  assert.equal(legacy.physicalUnsettledCount(), 1, "an older unresolved row without origin detail still blocks dependent work");
  const legacySnapshot = legacy.financialSnapshot();
  assert.equal(legacySnapshot.attempts[0].price ?? null, null, "the older row's price remains honestly unknown, not invented");
  // A confirmed completion with unknown tariff is not physically unresolved work.
  const completed = service({ scope: "attr-completed" });
  completed.restore(snapshot([row({ state: "settled", totalTokens: null, costAmount: null, usageCoverage: "unknown" })]));
  assert.equal(completed.physicalUnsettledCount(), 0, "a settled row with unknown tariff does not block as live work");
  const completedSnapshot = completed.financialSnapshot();
  assert.equal(completedSnapshot.attempts.length, 1, "the completed row is retained, not trimmed");
  assert.equal(completedSnapshot.attempts[0].costAmount ?? null, null, "its unknown tariff stays unknown");
});

// K07 239-B.4 route/origin witness: known origin and genuinely different routes
// survive the protected checkpoint, current ordinary active work is not treated
// as retired, and only the affected route's dependent work is blocked.
test("K07-B04-route: known origin/route survive restore and only the affected route is blocked", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-route-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-route-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  const config = {
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { maxConcurrentEvaluations: 2, maxRetiredUnsettledOperations: 1, restore: "reconcile-only", boundaryWaitMs: 0, defaultRunTimeoutMs: 30_000 },
    modelProfiles: {
      "route-a": { provider: "fixture-a", model: "a-1", maxAttempts: 1, price: { currency: "USD", revision: "price-A", inputPerMillion: "0.20", outputPerMillion: "0.80", cacheReadPerMillion: "0.02", cacheWritePerMillion: "0" } },
      "route-b": { provider: "fixture-b", model: "b-1", maxAttempts: 1, price: { currency: "USD", revision: "price-B", inputPerMillion: "0.50", outputPerMillion: "2.00", cacheReadPerMillion: "0.05", cacheWritePerMillion: "0" } },
    },
    permissions: { modelProfiles: ["route-a", "route-b"] },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: {
      "chat-a": { use: "core.chat", modelProfile: "route-a", options: {} },
      "chat-b": { use: "core.chat", modelProfile: "route-b", options: {} },
      short: { use: "core.repeated-tools", options: { minimumRepeats: 1 } },
    },
    policies: { record: { use: "core.record-only" } },
    checks: {
      "route-a": { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-a", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      "route-b": { enabled: false, triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-b", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      short: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "short", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  };
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(config), "utf8");
  let release = null;
  const latch = new Promise(resolvePromise => { release = resolvePromise; });
  const state = { aEntered: 0, aReturned: 0, aActive: 0, bEntered: 0 };
  const port = {
    findChat: (provider) => ({ provider, model: provider === "fixture-a" ? "a-1" : "b-1" }),
    findClassifier: () => null,
    hasConfiguredAuth: () => true,
    async completeChat(model) {
      const provider = typeof model?.["provider"] === "string" ? model["provider"] : "";
      if (provider === "fixture-a") {
        state.aEntered += 1;
        state.aActive += 1;
        try {
          await latch;
          state.aReturned += 1;
        } finally {
          state.aActive -= 1;
        }
      } else {
        state.bEntered += 1;
      }
      return { text: JSON.stringify(noFindingResult()), model: { provider, id: provider === "fixture-a" ? "a-1" : "b-1", revision: null }, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, totalTokens: 110 }, stopReason: "stop", errorCode: null };
    },
    async classify() { throw new Error("unused"); },
  };
  const physicalState = new SessionPhysicalState();
  const base = {
    observedSessionId: sessionId, branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
  };
  const session = await EngineSession.start({ ...base, modelRegistry: port, physicalState });
  let sessionC;
  const drive = (sessionInstance, serial) => {
    const at = new Date().toISOString();
    sessionInstance.handlePrimaryEvent({ type: "operator-input", text: `route work ${serial}`, source: "interactive", occurredAt: at });
    sessionInstance.handlePrimaryEvent({ type: "tool-started", operationId: `rt-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
    sessionInstance.handlePrimaryEvent({ type: "tool-completed", operationId: `rt-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
  };
  try {
    const ready = Date.now() + 10_000;
    while (session.status(true).checks.active < 2 && Date.now() < ready) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    drive(session, "a");
    const enteredDeadline = Date.now() + 20_000;
    while (state.aEntered === 0 && Date.now() < enteredDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    assert.equal(state.aEntered, 1, "route A's raw transport is entered");
    assert.equal(state.aActive, 1, "route A is physically active");
    const before = await protectedCheckpoint(agentDir, sessionId);
    assert.ok(before !== null, "the protected checkpoint is readable");
    const rowA = before.attempts.find(entry => entry.profileId === "route-a") ?? null;
    assert.ok(rowA, "road A's attempt row exists");
    // Known origin and the actually selected route must survive the projection.
    assert.equal(typeof rowA.originRunId === "string" && rowA.originRunId.length > 0, true, `the known origin run is retained (${JSON.stringify(rowA.originRunId ?? null)})`);
    assert.equal(JSON.stringify(rowA.actualRoute ?? null).includes("fixture-a"), true, `the actual route is retained (${JSON.stringify(rowA.actualRoute ?? null)})`);
    assert.equal(rowA.totalTokens, null, "the held attempt has no usage");
    // Ordinary-active phase: AFTER A's actual transport entry a useful short
    // no-model check must be admitted and settle while A is still non-retired.
    const shortRunsA = () => session.status(true).checks.detail.find(entry => entry.checkId === "short")?.runs ?? 0;
    const shortBeforeA = shortRunsA();
    drive(session, "short-a");
    const shortADeadline = Date.now() + 20_000;
    while (shortRunsA() === shortBeforeA && Date.now() < shortADeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    assert.equal(shortRunsA() > shortBeforeA, true, `the short check runs after A's entry while A is ordinary active (${shortBeforeA} -> ${shortRunsA()})`);
    assert.equal(state.aActive, 1, "A's transport is still physically active during the short phase");
    // Retire A while it is held; C restores the same session/physical state.
    await session.retire("replaced");
    sessionC = await EngineSession.start({ ...base, modelRegistry: port, physicalState });
    const readyC = Date.now() + 10_000;
    while (sessionC.status(true).checks.active < 2 && Date.now() < readyC) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    // A's affected route (R_A) is blocked; the known unrelated route (R_B) passes.
    drive(sessionC, "a2");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 700));
    assert.equal(state.aEntered, 1, "R_A dependent work does not reach the provider while A is unsettled");
    const denied = sessionC.status(true).diagnostics.recentEvents
      .filter(record => record.event === "quality.check.admission")
      .map(record => record.fields.data)
      .filter(entry => entry.outcome === "denied")
      .flatMap(entry => entry.reasonCodes ?? []);
    assert.equal(denied.some(code => code === "core.retired-unsettled-limit" || code === "core.unsettled-operation-limit"), true, `R_A is denied by the unsettled bound (${denied.join(",") || "nothing"})`);
    // The short no-model check fits the spare evaluation slot while A's one
    // uncertain operation is the only occupant; it must not be classified as
    // retired work. Then let it drain before the unrelated route enters.
    const shortDetail = () => sessionC.status(true).checks.detail.find(entry => entry.checkId === "short");
    assert.equal((shortDetail()?.runs ?? 0) >= 1, true, "the short no-model check ran while A's uncertainty was the only unsettled operation");
    const shortDenied = sessionC.status(true).diagnostics.recentEvents
      .filter(record => record.event === "quality.check.admission" && record.fields.data.checkId === "short")
      .map(record => record.fields.data)
      .filter(entry => entry.outcome === "denied")
      .flatMap(entry => entry.reasonCodes ?? []);
    assert.equal(shortDenied.some(code => code === "core.retired-unsettled-limit" || code === "core.unsettled-operation-limit"), false,
      `the short no-model check was not classified as retired work (${shortDenied.join(",") || "no denial"})`);
    // Bounded drain of the short run before the next admission decision.
    const drainDeadline = Date.now() + 20_000;
    while ((sessionC.status(true).checks.detail.find(entry => entry.checkId === "short")?.pendingIntent ?? false) && Date.now() < drainDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, 500));

    // Accepted phase control: the unrelated route is enabled only now, so its
    // earlier opportunistic triggers cannot mask the admission decision.
    const enabledB = JSON.parse(JSON.stringify(config));
    enabledB.checks["route-b"].enabled = true;
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(enabledB), "utf8");
    assert.equal((await sessionC.reloadConfiguration()).ok, true, "the route-B enable reload applies");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    const readyB = Date.now() + 10_000;
    while (sessionC.status(true).checks.active < 3 && Date.now() < readyB) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    const bBefore = state.bEntered;
    const bRuns = () => sessionC.status(true).checks.detail.find(entry => entry.checkId === "route-b")?.runs ?? 0;
    const bRunsBefore = bRuns();
    drive(sessionC, "b");
    const bDeadline = Date.now() + 20_000;
    while (state.bEntered === bBefore && Date.now() < bDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    {
      // Bounded diagnostic: the actual per-check disposition/capacity at the
      // exact failing phase, printed only when the R_B arrival predicate fails.
      const statusR = sessionC.status(true);
      const journalText = (() => { try { return ""; } catch { return ""; } })();
      const events = statusR.diagnostics.recentEvents
        .filter(record => String(record.event).startsWith("quality.check.")
          || String(record.event).startsWith("quality.trigger.")
          || String(record.event).startsWith("quality.model."))
        .map(record => [record.event, record.fields.data.checkId ?? record.fields.data.attemptId ?? null, record.fields.data.outcome ?? null, record.fields.data.reasonCodes ?? null]);
      let fileEvents = [];
      try {
        let journal = "";
        for (const name of await readdir(join(agentDir, "quality", "logs"))) {
          if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
        }
        fileEvents = journal.split(String.fromCharCode(10)).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
          .filter(record => String(record.event).startsWith("quality.check.") || String(record.event).startsWith("quality.trigger.") || String(record.event).startsWith("quality.model."))
          .map(record => [record.event, record.fields?.data?.checkId ?? record.fields?.data?.attemptId ?? null, record.fields?.data?.outcome ?? null, record.fields?.data?.reasonCodes ?? null]);
      } catch { fileEvents = []; }
      console.error("K07-RB-DIAG", JSON.stringify({ checks: statusR.checks, recent: events, journalTail: fileEvents.slice(-14), aActive: state.aActive, aEntered: state.aEntered, bEntered: state.bEntered }));
    }
    assert.equal(state.bEntered, bBefore + 1, `the known unrelated route R_B is admitted and enters exactly once (${bBefore} -> ${state.bEntered})`);
    const bSettleDeadline = Date.now() + 20_000;
    while (bRuns() === bRunsBefore && Date.now() < bSettleDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    assert.equal(bRuns() > bRunsBefore, true, "the unrelated R_B run actually settled");
    assert.equal(state.aActive, 1, "A's transport stayed physically active throughout the R_B phase");
  } finally {
    release?.();
    await session.retire("fixture-complete").catch(() => undefined);
    await sessionC?.retire("fixture-complete").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// K07 239-A.1/A.2 native held expert: one real SDK reviewer session created
// through the declared reviewHostFactory, held on its first provider turn,
// with an equivalent cause coalescing onto the same immutable expert run.
test("K07-T02 native: one held expert SDK session coalesces an equivalent cause", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-held-expert-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionId = `sess-k07-expert-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.md"), "# Expert material\nowner notes\n", "utf8");
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { maxConcurrentEvaluations: 2, maxConcurrentReviewers: 1, maxEscalationsPerEpisode: 2, maxEscalationDepth: 1, restore: "reconcile-only", boundaryWaitMs: 0 },
    modelProfiles: { scripted: { provider: "qe-k07-expert", model: "scripted-1", price: "unknown", requiredInputs: ["text"], maxAttempts: 1 } },
    permissions: { actions: ["core.request-check"], modelProfiles: ["scripted"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { suspected: { use: "fixture.suspected", options: {} }, expert: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
    policies: {
      engineering: { use: "core.engineering", options: { escalateTo: "expert" } },
      "expert-engineering": { use: "core.engineering", options: {} },
    },
    checks: {
      suspicion: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "suspected", policy: "engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      expert: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }], context: "work", prompt: "repetition", evaluator: "expert", policy: "expert-engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  }), "utf8");
  const latch = (() => { let release; const promise = new Promise(resolvePromise => { release = resolvePromise; }); return { promise, release }; })();
  const counts = { creates: 0, expertEntries: 0, primaryEntries: 0, expertTurns: 0 };
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  models.registerProvider("qe-k07-expert", {
    name: "K07 scripted expert provider",
    api: "qe-k07-api",
    apiKey: "fixture-not-credential",
    baseUrl: "http://127.0.0.1:9/not-used",
    streamSimple: (model, context) => {
      const transcript = JSON.stringify(context.messages ?? []);
      if (transcript.includes("Bounded review of check expert")) {
        counts.expertEntries += 1;
        counts.expertTurns = counts.expertEntries;
        if (counts.expertEntries === 1) {
          // First expert turn: return the stream immediately; one shared final
          // message resolves on release and serves both iterator and result().
          const finalMessage = (async () => {
            await latch.promise;
            return assistantMessage(model, [{ type: "toolCall", id: "expert-read-1", name: "read", arguments: { path: "notes.md" } }], "toolUse");
          })();
          return {
            async *[Symbol.asyncIterator]() {
              const message = await finalMessage;
              yield { type: "start", partial: { ...message, content: [] } };
              yield { type: "done", reason: message.stopReason, message };
            },
            async result() { return finalMessage; },
          };
        }
        // Every later expert turn must have really received the permitted read body.
        if (counts.expertEntries === 2) {
          counts.secondInputHasReadBody = transcript.includes("owner notes")
            && transcript.includes("expert-read-1");
        }
        const submit = assistantMessage(model, [{ type: "toolCall", id: "expert-submit-1", name: "submit_result", arguments: {
          operational: "completed",
          coverage: { state: "complete", scopeDescription: "held expert reviewed the material", issues: [] },
          conclusion: "no-supported-finding",
          findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
        } }], "toolUse");
        return eventStream(submit);
      }
      counts.primaryEntries += 1;
      return eventStream(assistantMessage(model, [{ type: "text", text: "primary continues" }], "endTurn"));
    },
    models: [{ id: "scripted-1", name: "scripted", api: "qe-k07-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65_536, maxTokens: 8_192 }],
  });
  const modelRegistry = new ModelRegistry(models);
  const port = piModelRegistryPort(modelRegistry);
  const session = await EngineSession.start({
    observedSessionId: sessionId,
    branchId: "unresolved",
    agentDir,
    projectConfigDir: join(project, ".pi"),
    projectRoot: project,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: RESOURCES_DIR,
    hostIdleAtStart: true,
    modelRegistry: port,
    reviewHostFactory: async model => {
      const host = await createPiReviewerHost(modelRegistry, { model });
      // Transparent delegation; the counter reflects an actual created SDK session.
      return {
        createSession: async input => {
          const created = await host.createSession(input);
          counts.creates += 1;
          return created;
        },
        prompt: (sessionHandle, text) => host.prompt(sessionHandle, text),
        abort: sessionHandle => host.abort(sessionHandle),
        validate: payload => host.validate(payload),
      };
    },
  });
  try {
    const registered = session.endpoint.register({ id: "fixture.k07-suspected", version: "0.1.0", baseUri: "fixture:k07", components: [{
      id: "fixture.suspected", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
      optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.suspected-evidence"],
      evaluate: async (_options, input) => {
        let items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
        if (items.length === 0) items = input.context.items.slice(0, 1);
        const suspicionSerial = (input.run.runId.match(/\d+/u)?.[0] ?? "0");
        return {
          operational: "completed", coverage: input.context.coverage,
          conclusion: items.length > 0 ? "findings" : "no-supported-finding",
          findings: items.map(item => ({
            id: `${input.run.runId}:finding-1`, criterion: "efficiency.repetition", status: "suspected", severity: "concern",
            requirementRefs: [], evidenceIds: [item.id], affectedItems: [], defectCode: `fixture.suspected-drift-${suspicionSerial}`,
            explanation: "preliminary suspicion for the expert", proposedCorrection: null, limitations: ["preliminary"],
          })),
          scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [],
        };
      },
    }], resources: {} });
    assert.equal(registered.ok, true);
    if (registered.ok) await registered.value.ready;
    assert.equal((await session.reloadConfiguration()).ok, true);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    const drive = serial => {
      const at = new Date().toISOString();
      session.handlePrimaryEvent({ type: "operator-input", text: `expert work ${serial}`, source: "interactive", occurredAt: at });
      session.handlePrimaryEvent({ type: "tool-started", operationId: `ex-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
      session.handlePrimaryEvent({ type: "tool-completed", operationId: `ex-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
    };
    const driveEvidence = serial => {
      const at = new Date().toISOString();
      session.handlePrimaryEvent({ type: "tool-started", operationId: `ex-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
      session.handlePrimaryEvent({ type: "tool-completed", operationId: `ex-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
    };
    drive(1);
    const enteredDeadline = Date.now() + 25_000;
    while (counts.expertEntries === 0 && Date.now() < enteredDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    assert.equal(counts.creates, 1, "exactly one real SDK reviewer session was created");
    assert.equal(counts.expertEntries, 1, "exactly one real expert provider turn entered and is held");
    const expertStarted = () => session.status(true).diagnostics.recentEvents
      .filter(record => record.event === "quality.check.started" && record.fields.data.checkId === "expert").length;
    assert.equal(expertStarted(), 1, "one immutable expert run was admitted (started event, not a completed-run count)");
    let journalForIdentity = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) journalForIdentity += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    const expertStartRecord = journalForIdentity.split(String.fromCharCode(10)).filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
      .find(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    const expertRunId = expertStartRecord?.fields?.correlation?.runId ?? null;
    assert.equal(typeof expertRunId, "string", "the expert run identity is captured from its started record");
    // A same-authority tool event supplies the equivalent second cause; a new
    // interactive input would legitimately advance authorization.
    driveEvidence(2);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 600));
    // Durable journal, not the 16-record status window: both request receipts.
    let expertJournal = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) expertJournal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    const receipts = expertJournal.split(String.fromCharCode(10)).filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
      .filter(record => record.event === "quality.action.receipt")
      .map(record => record.fields?.data ?? {})
      .filter(entry => typeof entry.destinationRef === "string" && entry.destinationRef.startsWith("run-"));
    {
      const diag = expertJournal.split(String.fromCharCode(10)).filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
        .filter(record => record.event === "quality.policy.decided" || record.event === "quality.action.admission" || record.event === "quality.check.admission" || record.event === "quality.action.receipt")
        .map(record => [record.event, record.fields?.data?.actionId ?? record.fields?.data?.checkId ?? record.fields?.data?.policyId ?? null, record.fields?.data?.outcome ?? record.fields?.data?.state ?? record.fields?.data?.disposition ?? null, record.fields?.data?.reasonCodes ?? null, record.fields?.correlation?.runId ?? null]);
      console.error("K07-T02-DIAG", JSON.stringify({ counts, diag: diag.slice(-16) }));
    }
    assert.equal(receipts.length >= 2, true, `both escalation requests produced receipts (got ${receipts.length})`);
    const destinations = [...new Set(receipts.map(entry => entry.destinationRef))];
    assert.equal(destinations.length, 1, `equivalent causes reuse one immutable expert run (${destinations.join(",")})`);
    assert.equal(counts.creates, 1, "the equivalent cause creates no second SDK session");
    assert.equal(counts.expertEntries, 1, "the equivalent cause starts no second expert provider turn");
    // Release exactly once: the read→submit script completes the same expert run.
    latch.release();
    const turnDeadline = Date.now() + 25_000;
    while (counts.expertEntries < 2 && Date.now() < turnDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    if (counts.expertEntries < 2) {
      let diagJournal = "";
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (name.endsWith(".jsonl")) diagJournal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
      }
      const tail = diagJournal.split(String.fromCharCode(10)).filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
        .filter(record => String(record.event).startsWith("quality.reviewer") || String(record.event).startsWith("quality.model") || String(record.event).startsWith("quality.check") || String(record.event) === "quality.component.note")
        .map(record => [record.event, record.fields?.data?.outcome ?? record.fields?.data?.state ?? null, record.fields?.data?.reasonCode ?? record.fields?.data?.terminalReason ?? record.fields?.data?.toolName ?? null]);
      console.error("K07-T02-POST-DIAG", JSON.stringify({ counts, tail: tail.slice(-18) }));
    }
    assert.equal(counts.expertEntries, 2, "the released expert used exactly its two scripted turns");
    const settleDeadline = Date.now() + 25_000;
    let expertSettlements = [];
    while (expertSettlements.length === 0 && Date.now() < settleDeadline) {
      let journalSettled = "";
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (name.endsWith(".jsonl")) journalSettled += await readFile(join(agentDir, "quality", "logs", name), "utf8");
      }
      expertSettlements = journalSettled.split(String.fromCharCode(10)).filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
        .filter(record => record.event === "quality.check.settled"
          && record.fields?.correlation?.runId === expertRunId
          && record.fields?.data?.operational === "completed"
          && record.fields?.data?.terminalReason === "evaluated");
      if (expertSettlements.length === 0) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
    }
    assert.equal(expertSettlements.length, 1, "exactly one canonical accepted expert settlement for that identity");
    assert.equal(counts.creates, 1, "no second expert was created after drain");
    assert.equal(counts.secondInputHasReadBody, true, "the permitted read body and its tool-call join reach the second expert input");
  } finally {
    latch.release();
    await session.retire("fixture-complete").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

// K07 239 §4 A.4: the real-SDK expert budget pack. One useful two-turn expert
// positive (read → submit through the accepted createPiReviewerHost adapter and
// an explicit synthetic decimal tariff) establishes the admitted reservation;
// three restored-generation cases then exhaust the request, token-reservation
// and known-cost allowances at the next paid turn, each with zero forbidden
// provider arrivals and no fabricated attempt.
test("K07-A4-budget: the real two-turn expert fits, and the measured request/token/cost limits deny the next paid turn", { timeout: 180_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-budget-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionId = `sess-k07-budget-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.md"), "# Expert material\nowner notes for the budget pack\n", "utf8");
  const { readFileSync } = await import("node:fs");
  const PRICE = { currency: "USD", revision: "price-budget", inputPerMillion: "1.00", outputPerMillion: "10.00", cacheReadPerMillion: "0", cacheWritePerMillion: "0" };
  const configFor = caps => ({
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { boundaryWaitMs: 0, maxConcurrentEvaluations: 2, maxConcurrentReviewers: 1, maxEscalationsPerEpisode: 2, maxEscalationDepth: 1, restore: "reconcile-only", defaultRunTimeoutMs: 40_000, maxRunTimeoutMs: 60_000, ...caps },
    modelProfiles: { scripted: { provider: "qe-k07-budget", model: "scripted-1", price: PRICE, requiredInputs: ["text"], maxAttempts: 1 } },
    permissions: { actions: ["core.request-check"], modelProfiles: ["scripted"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { suspected: { use: "fixture.suspected", options: {} }, expert: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
    policies: {
      engineering: { use: "core.engineering", options: { escalateTo: "expert" } },
      "expert-engineering": { use: "core.engineering", options: {} },
    },
    checks: {
      suspicion: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "suspected", policy: "engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      expert: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }], context: "work", prompt: "repetition", evaluator: "expert", policy: "expert-engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  });
  const arrivals = { expert: 0, primary: 0, unclassified: 0 };
  let preTransport = null;
  let genArrivals = 0;
  let genPreTransport = null;
  const checkpointSync = () => {
    const stateDirectory = join(agentDir, "quality", "state");
    for (const name of readdirSyncSafe(stateDirectory)) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(stateDirectory, name), "utf8"));
        if (parsed["observedSessionId"] === sessionId && parsed["financial"]?.attempts !== undefined) return parsed;
      } catch { /* unreadable transient state is not a claim */ }
    }
    return null;
  };
  function readdirSyncSafe(directory) {
    try { return readdirSync(directory); } catch { return []; }
  }
  const { readdirSync } = await import("node:fs");
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  models.registerProvider("qe-k07-budget", {
    name: "K07 budget scripted expert provider",
    api: "qe-k07-budget-api",
    apiKey: "fixture-not-credential",
    baseUrl: "http://127.0.0.1:9/not-used",
    streamSimple: (model, context) => {
      const transcript = JSON.stringify(context.messages ?? []);
      if (transcript.includes("Bounded review of check expert")) {
        arrivals.expert += 1;
        genArrivals += 1;
        if (arrivals.expert === 1) preTransport = checkpointSync();
        if (genArrivals === 1) genPreTransport = checkpointSync();
        if (!transcript.includes("owner notes")) {
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: "expert-read-1", name: "read", arguments: { path: "notes.md" } }], "toolUse"));
        }
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "expert-submit-1", name: "submit_result", arguments: {
          operational: "completed",
          coverage: { state: "complete", scopeDescription: "budget pack expert reviewed the material", issues: [] },
          conclusion: "no-supported-finding",
          findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
        } }], "toolUse"));
      }
      if (transcript.includes("Bounded review")) arrivals.unclassified += 1;
      else arrivals.primary += 1;
      return eventStream(assistantMessage(model, [{ type: "text", text: "primary continues" }], "endTurn"));
    },
    models: [{ id: "scripted-1", name: "scripted", api: "qe-k07-budget-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65_536, maxTokens: 8_192 }],
  });
  const modelRegistry = new ModelRegistry(models);
  const port = piModelRegistryPort(modelRegistry);
  const sessions = [];
  const retired = new Set();
  const cleanupErrors = [];
  const journalCount = async () => (await readJournal()).length;
  const readJournal = async () => {
    let journal = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    return journal.split(String.fromCharCode(10)).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  };
  const financialRows = async () => {
    const stateDirectory = join(agentDir, "quality", "state");
    for (const name of await readdir(stateDirectory).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const parsed = JSON.parse(await readFile(join(stateDirectory, name), "utf8"));
      if (parsed["observedSessionId"] === sessionId && parsed["financial"]?.attempts !== undefined) {
        return { revision: parsed["revision"], financial: parsed["financial"] };
      }
    }
    return null;
  };
  let firstFailure = null;
  const start = async caps => {
    genArrivals = 0;
    genPreTransport = null;
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configFor(caps)), "utf8");
    const serialBox = { value: 0 };
    const session = await EngineSession.start({
      observedSessionId: sessionId, branchId: "unresolved", agentDir,
      projectConfigDir: join(project, ".pi"), projectRoot: project, projectTrusted: true,
      hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
      modelRegistry: port,
      reviewHostFactory: async model => {
        const host = await createPiReviewerHost(modelRegistry, { model });
        return {
          createSession: async input => host.createSession(input),
          prompt: (sessionHandle, text) => host.prompt(sessionHandle, text),
          abort: sessionHandle => host.abort(sessionHandle),
          validate: payload => host.validate(payload),
        };
      },
    });
    sessions.push(session);
    const registered = session.endpoint.register({ id: "fixture.k07-budget", version: "0.1.0", baseUri: "fixture:budget", components: [{
      id: "fixture.suspected", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
      optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.suspected-budget"],
      evaluate: async (_options, input) => {
        const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
        serialBox.value += 1;
        return {
          operational: "completed", coverage: input.context.coverage,
          conclusion: items.length > 0 ? "findings" : "no-supported-finding",
          findings: items.map(item => ({
            id: `${input.run.runId}:finding-1`, criterion: "efficiency.repetition", status: "suspected", severity: "concern",
            requirementRefs: [], evidenceIds: [item.id], affectedItems: [], defectCode: `fixture.suspected-budget-${serialBox.value}`,
            explanation: "preliminary suspicion", proposedCorrection: null, limitations: [],
          })),
          scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [],
        };
      },
    }], resources: {} });
    if (registered.ok) await registered.value.ready;
    const reloaded = await session.reloadConfiguration();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    return { session, reloaded };
  };
  const drive = (session, serial) => {
    const at = new Date().toISOString();
    session.handlePrimaryEvent({ type: "operator-input", text: `budget work ${serial}`, source: "interactive", occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-started", operationId: `bg-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: `bg-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
  };
  const rowsById = financial => new Map((financial?.attempts ?? []).map(row => [row.attemptId, row]));
  const idSet = financial => new Set((financial?.attempts ?? []).map(row => row.attemptId)).size;
  try {
    // ---- Useful positive: real two-turn expert at the explicit tariff -------
    const first = await start({ maxRequestsPerSession: 40, maxOwnedTokensPerSession: 400_000, maxOwnedCost: { currency: "USD", amount: "1.00" } });
    assert.equal(first.reloaded.ok, true, "the budget configuration applies");
    assert.equal(first.session.status(true).configuration.rejection, null, "the budget configuration is accepted");
    drive(first.session, 1);
    const arrivalsDeadline = Date.now() + 25_000;
    while (arrivals.expert < 2 && arrivals.primary === 0 && Date.now() < arrivalsDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    assert.equal(arrivals.expert, 2, `exactly two real expert provider turns (${arrivals.expert})`);
    assert.equal(arrivals.primary, 0, "the primary made no provider request in the expert fixture");
    assert.equal(arrivals.unclassified, 0, "no unclassified provider arrival");
    const journalBefore = await readJournal();
    const expertStart = journalBefore.find(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    const expertRunId = expertStart?.fields?.correlation?.["runId"] ?? null;
    assert.equal(typeof expertRunId, "string", "the expert run identity is captured");
    const settleDeadline = Date.now() + 20_000;
    let expertSettled = null;
    while (expertSettled === null && Date.now() < settleDeadline) {
      expertSettled = (await readJournal()).find(record => record.event === "quality.check.settled"
        && record.fields?.correlation?.["runId"] === expertRunId
        && record.fields?.data?.operational === "completed"
        && record.fields?.data?.terminalReason === "evaluated") ?? null;
      if (expertSettled === null) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
    assert.ok(expertSettled, "the expert run reached its canonical accepted settlement");
    assert.equal(expertSettled.fields.data.conclusion, "no-supported-finding");
    // Pre-completion intent/reservation captured at the real port boundary.
    assert.ok(preTransport, "the pre-completion protected intent was captured at the port");
    const preRows = preTransport.financial.attempts;
    assert.equal(preRows.length >= 1, true, "the positive carried at least one protected attempt row");
    const pendingRow = preRows.find(row => row.state === "dispatched" || row.state === "reserved") ?? null;
    assert.ok(pendingRow, `a pre-completion pending attempt row is captured (${JSON.stringify(preRows.map(row => row.state))})`);
    assert.equal(pendingRow.totalTokens ?? null, null, "the pre-completion row has unknown usage (not zero)");
    assert.equal(pendingRow.usageRevision, 0, "the pre-completion row has no usage revision");
    assert.equal(Number(pendingRow.reservedTokens) > 0, true, "the pre-completion row retains a token reservation");
    assert.equal(typeof pendingRow.reservedCostAmount === "string", true, "the explicit tariff produced a reserved cost");
    const preRetirement = await financialRows();
    assert.ok(preRetirement, "the pre-retirement checkpoint is readable");
    await first.session.retire("fixture-positive-complete");
    retired.add(first.session);
    const postRetirement = await financialRows();
    assert.ok(postRetirement, "the post-retirement checkpoint is readable");
    const settledRows = postRetirement.financial.attempts.filter(row => row.state === "settled" && row.usageRevision >= 1);
    assert.equal(settledRows.length >= 1, true, "post-retirement persistence keeps the settled attempt rows");
    assert.equal(settledRows.some(row => row.totalTokens !== null && row.totalTokens > 0), true, "the actual terminal usage is known after retirement");
    // ---- Measured denial rows ---------------------------------------------
    const N = postRetirement.financial.ownedRequestCount;
    const R = Math.max(...preRows.map(row => Number(row.reservedTokens ?? 0)).filter(value => value > 0));
    const priorCost = Number(postRetirement.financial.knownCostByCurrency?.USD ?? "0");
    const E = Math.max(...preRows.map(row => Number(row.reservedCostAmount ?? "0")).filter(value => value > 0));
    assert.equal(R > 1_000, true, `the measured reservation exceeds the configuration minimum (${R})`);
    const micro = value => Math.round(value * 1_000_000);
    const costCap = (micro(priorCost) + micro(E) - 1) / 1_000_000;
    const cases = [
      { label: "requests", caps: { maxRequestsPerSession: N, maxOwnedTokensPerSession: 400_000, maxOwnedCost: { currency: "USD", amount: "1.00" } }, code: "core.budget-requests-exhausted" },
      { label: "tokens", caps: { maxRequestsPerSession: 40, maxOwnedTokensPerSession: Math.max(1_000, R - 1), maxOwnedCost: { currency: "USD", amount: "1.00" } }, code: "core.budget-tokens-exceeded" },
      { label: "cost", caps: { maxRequestsPerSession: 40, maxOwnedTokensPerSession: 400_000, maxOwnedCost: { currency: "USD", amount: costCap.toFixed(6) } }, code: "core.budget-cost-exceeded" },
    ];
    const baselineIds = idSet(postRetirement.financial);
    const baselineRows = rowsById(postRetirement.financial);
    for (const entry of cases) {
      const arrivalsBefore = arrivals.expert;
      const recordsBefore = await journalCount();
      const run = await start(entry.caps);
      assert.equal(run.reloaded.ok, true, `${entry.label}: narrowed configuration applies`);
      assert.equal(run.session.status(true).configuration.rejection, null, `${entry.label}: configuration accepted`);
      drive(run.session, `cap-${entry.label}`);
      const denialDeadline = Date.now() + 20_000;
      let denial = null;
      while (denial === null && Date.now() < denialDeadline) {
        const records = (await readJournal()).slice(recordsBefore);
        denial = records.find(record => JSON.stringify(record).includes(entry.code)) ?? null;
        if (denial === null) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      }
      if (denial === null) {
        const records = (await readJournal()).slice(recordsBefore);
        const trace = records
          .filter(record => String(record.event).startsWith("quality.check") || String(record.event).startsWith("quality.model") || String(record.event).startsWith("quality.action") || String(record.event) === "quality.assessment.result")
          .map(record => [record.event, record.fields?.data?.checkId ?? record.fields?.data?.attemptId ?? record.fields?.data?.componentId ?? null, record.fields?.data?.outcome ?? record.fields?.data?.state ?? record.fields?.data?.terminalReason ?? record.fields?.data?.errorCode ?? null, record.fields?.correlation?.["runId"] ?? null]);
        const pre = genPreTransport?.financial ?? null;
        console.error("K07-BUDGET-DIAG", JSON.stringify({
          label: entry.label,
          caps: entry.caps,
          checkpointOwned: pre?.ownedRequestCount ?? null,
          checkpointRows: (pre?.attempts ?? []).map(row => [row.attemptId, row.state, row.usageRevision, row.totalTokens]),
          trace: trace.slice(-16),
        }));
      }
      assert.ok(denial, `${entry.label}: the next paid turn is denied with ${entry.code}`);
      assert.equal(arrivals.expert, arrivalsBefore, `${entry.label}: zero forbidden expert provider arrivals`);
      const after = await financialRows();
      assert.equal(idSet(after.financial), baselineIds, `${entry.label}: no new attempt identity is allocated`);
      assert.equal(after.financial.ownedRequestCount, N, `${entry.label}: the owned request count is not refunded`);
      const afterRows = rowsById(after.financial);
      for (const [attemptId, before] of baselineRows) {
        const now = afterRows.get(attemptId);
        assert.equal(now?.usageRevision ?? 0, before.usageRevision ?? 0, `${entry.label}: prior usage revision is conservative`);
        assert.equal(now?.totalTokens ?? null, before.totalTokens ?? null, `${entry.label}: prior usage is conservative`);
        assert.equal(now?.costAmount ?? null, before.costAmount ?? null, `${entry.label}: prior cost is conservative`);
      }
      await run.session.retire(`fixture-denial-${entry.label}-complete`);
      retired.add(run.session);
    }
  } catch (error) {
    firstFailure = error;
    throw error;
  } finally {
    const cleanupDeadline = Date.now() + 20_000;
    for (const session of sessions) {
      if (retired.has(session)) continue;
      try {
        if (Date.now() < cleanupDeadline) await session.retire("fixture-cleanup");
        else cleanupErrors.push("cleanup deadline elapsed before retirement");
      } catch (error) {
        cleanupErrors.push(`retire failed: ${String(error)}`);
      }
    }
    const failed = firstFailure !== null || cleanupErrors.length > 0;
    if (!failed) await rm(root, { recursive: true, force: true });
    else console.error("K07-A4-CLEANUP", JSON.stringify({ firstFailure: firstFailure === null ? null : String(firstFailure), cleanupErrors }));
    if (cleanupErrors.length > 0 && firstFailure === null) assert.fail(`cleanup unresolved: ${cleanupErrors.join("; ")}`);
  }
});
test("K07-A4-slot: a request-check admission must not spend the single primary.feedback message slot", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-slot-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionId = `sess-k07-slot-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.md"), "# Expert material\nowner notes for the slot row\n", "utf8");
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { boundaryWaitMs: 0, maxConcurrentEvaluations: 2, maxConcurrentReviewers: 1, maxEscalationsPerEpisode: 2, maxEscalationDepth: 1, maxFeedbackPerEpisode: 1, restore: "reconcile-only" },
    modelProfiles: { scripted: { provider: "qe-k07-slot", model: "scripted-1", price: "unknown", requiredInputs: ["text"], maxAttempts: 1 } },
    permissions: { actions: ["core.request-check", "core.feedback"], modelProfiles: ["scripted"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { suspected: { use: "fixture.suspected", options: {} }, expert: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
    policies: { engineering: { use: "core.engineering", options: { escalateTo: "expert" } }, "expert-engineering": { use: "core.engineering", options: {} } },
    checks: {
      suspicion: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "suspected", policy: "engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      expert: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }], context: "work", prompt: "repetition", evaluator: "expert", policy: "expert-engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  }), "utf8");
  const arrivals = { expert: 0 };
  const latch = (() => { let release; const promise = new Promise(resolvePromise => { release = resolvePromise; }); return { promise, release }; })();
  let releaseRef = latch.release;
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  models.registerProvider("qe-k07-slot", {
    name: "K07 slot scripted expert provider",
    api: "qe-k07-slot-api",
    apiKey: "fixture-not-credential",
    baseUrl: "http://127.0.0.1:9/not-used",
    streamSimple: (model, context) => {
      const transcript = JSON.stringify(context.messages ?? []);
      if (!transcript.includes("Bounded review of check expert")) {
        return eventStream(assistantMessage(model, [{ type: "text", text: "primary continues" }], "endTurn"));
      }
      arrivals.expert += 1;
      const turn = arrivals.expert;
      if (turn === 1) {
        const finalMessage = (async () => {
          await latch.promise;
          return assistantMessage(model, [{ type: "toolCall", id: "expert-read-1", name: "read", arguments: { path: "notes.md" } }], "toolUse");
        })();
        return {
          async *[Symbol.asyncIterator]() {
            const message = await finalMessage;
            yield { type: "start", partial: { ...message, content: [] } };
            yield { type: "done", reason: message.stopReason, message };
          },
          async result() { return finalMessage; },
        };
      }
      return eventStream(assistantMessage(model, [{ type: "toolCall", id: "expert-submit-1", name: "submit_result", arguments: {
        operational: "completed",
        coverage: { state: "complete", scopeDescription: "expert reviewed the permitted material", issues: [] },
        conclusion: "findings",
        findings: [{
          id: "expert-finding-1",
          criterion: "efficiency.repetition",
          status: "supported",
          severity: "concern",
          requirementRefs: [],
          evidenceIds: [],
          affectedItems: [],
          defectCode: "k07.slot-confirmed",
          explanation: "the expert confirmed the concern over the permitted material",
          proposedCorrection: "apply the smallest correction to the named location",
          limitations: [],
        }],
        scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
      } }], "toolUse"));
    },
    models: [{ id: "scripted-1", name: "scripted", api: "qe-k07-slot-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65_536, maxTokens: 8_192 }],
  });
  const modelRegistry = new ModelRegistry(models);
  const port = piModelRegistryPort(modelRegistry);
  const receiver = { calls: [] };
  const session = await EngineSession.start({
    observedSessionId: sessionId, branchId: "unresolved", agentDir,
    projectConfigDir: join(project, ".pi"), projectRoot: project, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
    modelRegistry: port,
    feedbackHost: {
      capabilities: () => new Set(["host.feedback.steer"]),
      deliver: async request => {
        receiver.calls.push({ actionId: request.actionId, bytes: Buffer.byteLength(request.text, "utf8") });
        return { actionId: request.actionId, state: "queued", destinationId: "fixture.primary", evidenceIds: [] };
      },
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
    reviewHostFactory: async model => {
      const host = await createPiReviewerHost(modelRegistry, { model });
      return {
        createSession: async input => host.createSession(input),
        prompt: (sessionHandle, text) => host.prompt(sessionHandle, text),
        abort: sessionHandle => host.abort(sessionHandle),
        validate: payload => host.validate(payload),
      };
    },
  });
  const fixture = { root, agentDir, projectConfigDir: join(project, ".pi"), session };
  const readJournal = async () => {
    let journal = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    return journal.split(String.fromCharCode(10)).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  };
  const pause = async (ms = 120) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  let firstFailure = null;
  try {
    const registered = session.endpoint.register({ id: "fixture.k07-slot", version: "0.1.0", baseUri: "fixture:slot", components: [{
      id: "fixture.suspected", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
      optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.suspected-slot"],
      evaluate: async (_options, input) => {
        const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
        const serial = input.run.runId;
        return {
          operational: "completed", coverage: input.context.coverage,
          conclusion: items.length > 0 ? "findings" : "no-supported-finding",
          findings: items.map(item => ({
            id: `${input.run.runId}:finding-1`, criterion: "efficiency.repetition", status: "suspected", severity: "concern",
            requirementRefs: [], evidenceIds: [item.id], affectedItems: [], defectCode: `fixture.suspected-slot-${serial}`,
            explanation: "preliminary suspicion", proposedCorrection: null, limitations: [],
          })),
          scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [],
        };
      },
    }], resources: {} });
    assert.equal(registered.ok, true);
    if (registered.ok) await registered.value.ready;
    assert.equal((await session.reloadConfiguration()).ok, true);
    await pause();
    const drive = serial => {
      const at = new Date().toISOString();
      session.handlePrimaryEvent({ type: "operator-input", text: `slot work ${serial}`, source: "interactive", occurredAt: at });
      session.handlePrimaryEvent({ type: "tool-started", operationId: `slot-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
      session.handlePrimaryEvent({ type: "tool-completed", operationId: `slot-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
    };
    drive(1);
    const enteredDeadline = Date.now() + 20_000;
    while (arrivals.expert === 0 && Date.now() < enteredDeadline) await pause();
    assert.equal(arrivals.expert, 1, "the expert turn is held");
    // A real primary operation remains active through the steering boundary.
    const heldAt = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "primary-held-1", toolName: "read", parentOperationId: null, occurredAt: heldAt });
    // A second genuinely distinct compatible cause reuses the held expert.
    drive(2);
    await pause(300);
    let journal = await readJournal();
    const receipts = journal.filter(record => record.event === "quality.action.receipt")
      .map(record => record.fields?.data ?? {})
      .filter(entry => typeof entry.destinationRef === "string" && entry.destinationRef.startsWith("run-"));
    assert.equal(receipts.length >= 2, true, "two distinct causes were admitted as requests");
    assert.equal(new Set(receipts.map(entry => entry.destinationRef)).size, 1, "both causes reuse one expert run");
    assert.equal(arrivals.expert, 1, "the compatible reuse launched no extra expert turn");
    // Release: the expert submits a supported finding; the engineering policy
    // proposes the bounded feedback that must use the single message slot.
    releaseRef();
    const feedbackDeadline = Date.now() + 25_000;
    let receiverDelivered = false;
    while (!receiverDelivered && Date.now() < feedbackDeadline) {
      receiverDelivered = receiver.calls.length > 0;
      if (!receiverDelivered) await pause();
    }
    journal = await readJournal();
    const admittedFeedback = journal.filter(record => record.event === "quality.action.admission")
      .map(record => record.fields?.data ?? {})
      .filter(entry => entry.outcome === "admitted" && entry.componentId === "core.feedback");
    const limitRejections = journal.filter(record => record.event === "quality.action.admission")
      .map(record => record.fields?.data ?? {})
      .filter(entry => entry.outcome === "rejected")
      .flatMap(entry => (Array.isArray(entry.reasonCodes) ? entry.reasonCodes : []));
    assert.equal(limitRejections.includes("core.feedback-limit"), false, `the request admissions did not spend the message slot (${limitRejections.join(",") || "no rejection"})`);
    assert.equal(admittedFeedback.length, 1, "the otherwise eligible supported feedback is admitted");
    assert.equal(receiver.calls.length, 1, "the receiver delivered exactly one bounded note");
    assert.equal(receiver.calls[0].bytes > 0 && receiver.calls[0].bytes <= 2048, true, "the delivered note is bounded");
    assert.equal(new Set(receipts.map(entry => entry.destinationRef)).size, 1, "no second expert identity appeared");
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "primary-held-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: new Date().toISOString() });
  } catch (error) {
    firstFailure = error;
    throw error;
  } finally {
    releaseRef();
    try {
      await session.retire("fixture-slot-complete");
    } catch (error) {
      console.error("K07-SLOT-CLEANUP", JSON.stringify({ firstFailure: firstFailure === null ? null : String(firstFailure), cleanup: String(error) }));
    }
    if (firstFailure === null) await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// K07 259 §2: independently selectable shared-budget rows. Each row is a fixed
// configuration for the same real read→submit expert; a fitting calibration of
// the SAME fixture measures the actual turn-2 reservation/estimated cost, then
// the row's cap is derived from those measured facts. A transparent wrapper of
// the public ModelService.dispatch records the proposed turn and its own result,
// so the denial is joined to the actual call rather than a journal substring.
// ---------------------------------------------------------------------------
const BUDGET_PRICE = { currency: "USD", revision: "price-budget", inputPerMillion: "1.00", outputPerMillion: "10.00", cacheReadPerMillion: "0", cacheWritePerMillion: "0" };

function expertBudgetConfig(agentDirRoot, caps) {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { boundaryWaitMs: 0, maxConcurrentEvaluations: 2, maxConcurrentReviewers: 1, maxEscalationsPerEpisode: 2, maxEscalationDepth: 1, restore: "reconcile-only", defaultRunTimeoutMs: 40_000, maxRunTimeoutMs: 60_000, ...caps },
    modelProfiles: { scripted: { provider: "qe-k07-budget", model: "scripted-1", price: BUDGET_PRICE, requiredInputs: ["text"], maxAttempts: 1 } },
    permissions: { actions: ["core.request-check"], modelProfiles: ["scripted"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { suspected: { use: "fixture.suspected", options: {} }, expert: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
    policies: {
      engineering: { use: "core.engineering", options: { escalateTo: "expert" } },
      "expert-engineering": { use: "core.engineering", options: {} },
    },
    checks: {
      suspicion: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "suspected", policy: "engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      expert: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }], context: "work", prompt: "repetition", evaluator: "expert", policy: "expert-engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  };
}

async function runExpertBudgetRow(label, expectedCode, deriveCaps) {
  const { readFileSync, readdirSync } = await import("node:fs");
  const root = await mkdtemp(join(tmpdir(), `qe-k07-${label}-`));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  let sessionId = `sess-k07-${label}-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.md"), "# Expert material\nowner notes for the budget row\n", "utf8");
  const arrivals = { expert: 0, primary: 0 };
  const checkpointSync = () => {
    const stateDirectory = join(agentDir, "quality", "state");
    for (const name of (() => { try { return readdirSync(stateDirectory); } catch { return []; } })()) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(join(stateDirectory, name), "utf8"));
        if (parsed["observedSessionId"] === sessionId && parsed["financial"]?.attempts !== undefined) return parsed["financial"];
      } catch { /* transient write is not a claim */ }
    }
    return null;
  };
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  models.registerProvider("qe-k07-budget", {
    name: "K07 budget scripted expert provider",
    api: "qe-k07-budget-api",
    apiKey: "fixture-not-credential",
    baseUrl: "http://127.0.0.1:9/not-used",
    streamSimple: (model, context) => {
      const transcript = JSON.stringify(context.messages ?? []);
      if (!transcript.includes("Bounded review of check expert")) {
        arrivals.primary += 1;
        return eventStream(assistantMessage(model, [{ type: "text", text: "primary continues" }], "endTurn"));
      }
      arrivals.expert += 1;
      if (!transcript.includes("owner notes")) {
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "expert-read-1", name: "read", arguments: { path: "notes.md" } }], "toolUse"));
      }
      return eventStream(assistantMessage(model, [{ type: "toolCall", id: "expert-submit-1", name: "submit_result", arguments: {
        operational: "completed",
        coverage: { state: "complete", scopeDescription: "budget expert reviewed the material", issues: [] },
        conclusion: "no-supported-finding",
        findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
      } }], "toolUse"));
    },
    models: [{ id: "scripted-1", name: "scripted", api: "qe-k07-budget-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65_536, maxTokens: 8_192 }],
  });
  const modelRegistry = new ModelRegistry(models);
  const port = piModelRegistryPort(modelRegistry);
  const calls = [];
  const sessions = [];
  const start = async caps => {
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(expertBudgetConfig(agentDir, caps)), "utf8");
    const serialBox = { value: 0 };
    const session = await EngineSession.start({
      observedSessionId: sessionId, branchId: "unresolved", agentDir,
      projectConfigDir: join(project, ".pi"), projectRoot: project, projectTrusted: true,
      hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
      modelRegistry: port,
      reviewHostFactory: async model => {
        const host = await createPiReviewerHost(modelRegistry, { model });
        return {
          createSession: async input => host.createSession(input),
          prompt: (sessionHandle, text) => host.prompt(sessionHandle, text),
          abort: sessionHandle => host.abort(sessionHandle),
          validate: payload => host.validate(payload),
        };
      },
    });
    sessions.push(session);
    const registered = session.endpoint.register({ id: "fixture.k07-budgetrow", version: "0.1.0", baseUri: "fixture:budgetrow", components: [{
      id: "fixture.suspected", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
      optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.suspected-budgetrow"],
      evaluate: async (_options, input) => {
        const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
        serialBox.value += 1;
        return {
          operational: "completed", coverage: input.context.coverage,
          conclusion: items.length > 0 ? "findings" : "no-supported-finding",
          findings: items.map(item => ({
            id: `${input.run.runId}:finding-1`, criterion: "efficiency.repetition", status: "suspected", severity: "concern",
            requirementRefs: [], evidenceIds: [item.id], affectedItems: [], defectCode: `fixture.suspected-budgetrow-${serialBox.value}`,
            explanation: "preliminary suspicion", proposedCorrection: null, limitations: [],
          })),
          scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [],
        };
      },
    }], resources: {} });
    if (registered.ok) await registered.value.ready;
    const reloaded = await session.reloadConfiguration();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    return { session, reloaded };
  };
  const drive = (session, serial) => {
    const at = new Date().toISOString();
    session.handlePrimaryEvent({ type: "operator-input", text: `budget row ${serial}`, source: "interactive", occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-started", operationId: `br-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: `br-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
  };
  // Transparent public dispatch observer (delegates with the original receiver).
  const { ModelService } = await import("../dist/models.js");
  const originalDispatch = ModelService.prototype.dispatch;
  const observe = () => {
    ModelService.prototype.dispatch = async function (input) {
      const result = await originalDispatch.call(this, input);
      // The attempt (and its reservation) is allocated inside dispatch, so the
      // pending row is read after the call; for a denied turn it does not exist.
      const pendingAfter = checkpointSync();
      calls.push({
        runId: input.runId,
        purpose: input.purpose ?? null,
        estimatedInputTokens: input.estimatedInputTokens,
        maxOutputTokens: input.maxOutputTokens,
        ok: result.ok,
        code: result.ok ? null : result.error.code,
        pendingRow: (pendingAfter?.attempts ?? [])
          .filter(row => row.state === "dispatched" || row.state === "reserved")
          .sort((left, right) => Number(left.attemptId.replace(/\D+/gu, "")) - Number(right.attemptId.replace(/\D+/gu, "")))
          .at(-1) ?? null,
      });
      return result;
    };
  };
  let firstFailure = null;
  try {
    // ---- Fitting calibration of the SAME fixture: measure turn-2 facts -------
    observe();
    const calibration = await start({ maxRequestsPerSession: 40, maxOwnedTokensPerSession: 400_000, maxOwnedCost: { currency: "USD", amount: "1.00" } });
    assert.equal(calibration.reloaded.ok, true, `${label}: calibration configuration applies`);
    assert.equal(calibration.session.status(true).configuration.rejection, null, `${label}: calibration accepted`);
    drive(calibration.session, "calibration");
    const calibrationDeadline = Date.now() + 25_000;
    while (calls.length < 2 && Date.now() < calibrationDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    assert.equal(calls.length >= 2, true, `${label}: the fitting calibration admitted both expert turns`);
    assert.equal(calls[0].ok, true, `${label}: turn 1 was admitted`);
    assert.equal(calls[1].ok, true, `${label}: turn 2 was admitted in the fitting calibration`);
    const turn2 = calls[1];
    assert.ok(turn2.pendingRow, `${label}: turn 2's actual pre-completion reservation is observable`);
    const R2 = Number(turn2.pendingRow.reservedTokens ?? 0);
    const E2 = Number(turn2.pendingRow.reservedCostAmount ?? "0");
    assert.equal(R2 > 0, true, `${label}: turn 2 reserved tokens are measured (${R2})`);
    assert.equal(E2 > 0, true, `${label}: turn 2 estimated cost is measured (${E2})`);
    await calibration.session.retire("fixture-calibration-complete");
    // Prior known USD cost from the calibration's settled turn 1.
    const calibrationFinancial = checkpointSync();
    // Turn 1's own settled cost (the aggregate carries both calibration turns).
    const settledCosts = (calibrationFinancial?.attempts ?? [])
      .filter(row => row.state === "settled" && typeof row.costAmount === "string")
      .map(row => Number(row.costAmount))
      .sort((left, right) => left - right);
    const turn1Cost = settledCosts[0] ?? 0;
    assert.equal(turn1Cost > 0, true, `${label}: turn 1's known USD cost is measured (${turn1Cost})`);
    ModelService.prototype.dispatch = originalDispatch;
    calls.length = 0;
    arrivals.expert = 0;
    // The row is a fresh same-owner session: a restored calibration spend would
    // otherwise consume the row's own cap before its genuine turn 1.
    sessionId = `sess-k07-${label}-row-${process.pid}-${Date.now()}`;
    await rm(join(agentDir, "quality", "state"), { recursive: true, force: true });
    await rm(join(agentDir, "quality", "logs"), { recursive: true, force: true });
    // ---- The row: fixed cap, genuine turn 1, denied turn 2 ------------------
    const caps = deriveCaps({ R2, E2, turn1Cost });
    const row = await start(caps);
    assert.equal(row.reloaded.ok, true, `${label}: row configuration applies (${JSON.stringify(caps)})`);
    assert.equal(row.session.status(true).configuration.rejection, null, `${label}: row configuration accepted`);
    observe();
    drive(row.session, "row");
    const rowDeadline = Date.now() + 25_000;
    while (calls.length < 2 && Date.now() < rowDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    assert.equal(calls.length, 2, `${label}: the row proposed exactly two paid turns (${calls.length})`);
    assert.equal(calls[0].ok, true, `${label}: the row's genuine turn 1 was admitted`);
    assert.equal(calls[0].pendingRow !== null, true, `${label}: turn 1 carried a real reservation`);
    assert.equal(calls[1].ok, false, `${label}: the proposed turn 2 was denied`);
    assert.equal(calls[1].code, expectedCode, `${label}: the denial is the responsible owner code (${calls[1].code})`);
    assert.equal(arrivals.expert, 1, `${label}: exactly the genuine turn 1 reached the provider`);
    assert.equal(arrivals.primary, 0, `${label}: no primary provider request`);
    // No additional attempt identity was allocated by the denied turn.
    const afterRows = (checkpointSync()?.attempts ?? []).map(entry => entry.attemptId);
    const turn1Attempt = calls[0].pendingRow?.attemptId ?? null;
    assert.equal(turn1Attempt !== null, true, `${label}: turn 1's attempt identity is known`);
    assert.equal(afterRows.includes(turn1Attempt), true, `${label}: turn 1's attempt remains in the protected state`);
    assert.equal(afterRows.length, 1, `${label}: no additional attempt was allocated by the denied turn (${afterRows.join(",")})`);
    await row.session.retire("fixture-row-complete");
  } catch (error) {
    firstFailure = error;
    throw error;
  } finally {
    ModelService.prototype.dispatch = originalDispatch;
    for (const session of sessions) {
      try { await session.retire("fixture-budget-cleanup"); } catch (error) { console.error("K07-BUDGET-CLEANUP", String(error)); }
    }
    if (firstFailure === null) await rm(root, { recursive: true, force: true });
    else console.error("K07-BUDGET-ROW", JSON.stringify({ label, firstFailure: String(firstFailure), calls: calls.map(call => ({ ok: call.ok, code: call.code, estimate: call.estimatedInputTokens, out: call.maxOutputTokens })) }));
  }
}

test("K07-A4-budget-requests: capped requests deny the second paid turn with the shared-owner reason", { timeout: 90_000 }, async () => {
  await runExpertBudgetRow("requests", "core.budget-requests-exhausted", () => ({ maxRequestsPerSession: 1, maxOwnedTokensPerSession: 400_000, maxOwnedCost: { currency: "USD", amount: "1.00" } }));
});

test("K07-A4-budget-tokens: the measured turn-2 reservation edge denies the second paid turn", { timeout: 90_000 }, async () => {
  await runExpertBudgetRow("tokens", "core.budget-tokens-exceeded", ({ R2 }) => ({ maxRequestsPerSession: 40, maxOwnedTokensPerSession: Math.max(1_000, R2 - 1), maxOwnedCost: { currency: "USD", amount: "1.00" } }));
});

test("K07-A4-budget-cost: the measured turn-1 known cost plus turn-2 estimate edge denies the second paid turn", { timeout: 90_000 }, async () => {
  await runExpertBudgetRow("cost", "core.budget-cost-exceeded", ({ E2, turn1Cost }) => {
    const micro = value => Math.round(value * 1_000_000);
    return { maxRequestsPerSession: 40, maxOwnedTokensPerSession: 400_000, maxOwnedCost: { currency: "USD", amount: ((micro(turn1Cost) + micro(E2) - 1) / 1_000_000).toFixed(6) } };
  });
});

test("K07-A4-restore-boundary: the restored generation's financial state and request cap are joined at the real open→restore→dispatch chain", { timeout: 90_000 }, async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { ControlCheckpoint } = await import("../dist/checkpoint.js");
  const { ModelService } = await import("../dist/models.js");
  const root = await mkdtemp(join(tmpdir(), "qe-k07-restore-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionId = `sess-k07-restore-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  const PRICE = { currency: "USD", revision: "price-restore", inputPerMillion: "1.00", outputPerMillion: "10.00", cacheReadPerMillion: "0", cacheWritePerMillion: "0" };
  const configFor = caps => ({
    schemaVersion: 1, enabled: true, mode: "advise",
    runtime: { boundaryWaitMs: 0, maxConcurrentEvaluations: 2, restore: "reconcile-only", ...caps },
    modelProfiles: { scripted: { provider: "qe-k07-restore", model: "scripted-1", price: PRICE, requiredInputs: ["text"], maxAttempts: 1 } },
    permissions: { modelProfiles: ["scripted"], actions: [], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { direct: { use: "core.chat", modelProfile: "scripted", options: {} } },
    policies: { record: { use: "core.record-only" } },
    checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
    observability: {},
  });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configFor({})), "utf8");
  const port = {
    findChat: () => ({ provider: "qe-k07-restore", model: "scripted-1" }),
    findClassifier: () => null,
    hasConfiguredAuth: () => true,
    async completeChat() {
      return {
        text: JSON.stringify({ operational: "completed", coverage: { state: "complete", scopeDescription: "restore fixture", issues: [] }, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] }),
        model: { provider: "qe-k07-restore", id: "scripted-1", revision: null },
        usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
        stopReason: "stop", errorCode: null,
      };
    },
    async classify() { throw new Error("unused"); },
  };
  const stateDirectory = join(agentDir, "quality", "state");
  const checkpointPathOf = () => {
    for (const name of (() => { try { return readdirSync(stateDirectory); } catch { return []; } })()) {
      if (name.endsWith(".json")) return join(stateDirectory, name);
    }
    return null;
  };
  const rawRead = () => {
    const path = checkpointPathOf();
    if (path === null) return { path: null, error: "no-json-file", parsed: null };
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      return { path, error: null, parsed };
    } catch (error) {
      return { path, error: String(error), parsed: null };
    }
  };
  const sessions = [];
  const retireAll = [];
  const restored = [];
  const opened = [];
  const originalOpen = ControlCheckpoint.open;
  const originalRestore = ModelService.prototype.restore;
  const wrap = () => {
    ControlCheckpoint.open = async function (options) {
      const result = await originalOpen.call(this, options);
      opened.push({ sessionId: options.observedSessionId, owned: result.owned, restored: result.restored, degraded: result.degraded, errorCode: result.errorCode, financial: result.financial === null ? null : { ownedRequestCount: result.financial.ownedRequestCount, ids: result.financial.attempts.map(row => row.attemptId) } });
      return result;
    };
    ModelService.prototype.restore = function (snapshot) {
      const applied = originalRestore.call(this, snapshot);
      restored.push({ applied, snapshot: snapshot === null ? null : { ownedRequestCount: snapshot.ownedRequestCount, ids: snapshot.attempts.map(row => row.attemptId) }, serviceIds: this.financialSnapshot().attempts.map(row => row.attemptId), ownedAfter: this.financialSnapshot().ownedRequestCount });
      return applied;
    };
  };
  const drive = (session, serial) => {
    const at = new Date().toISOString();
    session.handlePrimaryEvent({ type: "operator-input", text: `restore work ${serial}`, source: "interactive", occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-started", operationId: `rs-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: `rs-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
  };
  const settle = async (ms = 120) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  let firstFailure = null;
  try {
    // ---- Authentic positive: one settled owned model attempt ---------------
    const sessionA = await EngineSession.start({ observedSessionId: sessionId, branchId: "unresolved", agentDir, projectConfigDir: join(project, ".pi"), projectTrusted: true, hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true, modelRegistry: port });
    sessions.push(sessionA);
    await settle(200);
    drive(sessionA, "a");
    const settledDeadline = Date.now() + 20_000;
    let settledA = false;
    while (!settledA && Date.now() < settledDeadline) {
      settledA = (await (async () => {
        let journal = "";
        for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
          if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
        }
        return journal;
      })()).includes("quality.check.settled");
      if (!settledA) await settle();
    }
    assert.equal(settledA, true, "the positive run settled");
    await settle(300);
    const beforeRetire = rawRead();
    assert.ok(beforeRetire.parsed, `the positive checkpoint is readable (${beforeRetire.error})`);
    const positiveFinancial = beforeRetire.parsed.financial;
    assert.ok(positiveFinancial, "the positive checkpoint carries financial state");
    assert.equal(positiveFinancial.ownedRequestCount >= 1, true, "the positive consumed an owned request");
    const positiveIds = positiveFinancial.attempts.map(row => row.attemptId);
    assert.equal(positiveIds.length >= 1, true, "the positive attempt identity is recorded");
    await sessionA.retire("fixture-positive-complete");
    const afterRetire = rawRead();
    assert.ok(afterRetire.parsed, "the post-retirement checkpoint is readable");
    assert.deepEqual(afterRetire.parsed.financial.attempts.map(row => row.attemptId), positiveIds, "the retired checkpoint retains the same attempt identities");
    // ---- Restored generation: raw disk first, then the real open/restore chain
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configFor({ maxRequestsPerSession: positiveFinancial.ownedRequestCount })), "utf8");
    wrap();
    const sessionB = await EngineSession.start({ observedSessionId: sessionId, branchId: "unresolved", agentDir, projectConfigDir: join(project, ".pi"), projectTrusted: true, hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true, modelRegistry: port });
    sessions.push(sessionB);
    const immediate = rawRead();
    const statusB = sessionB.status(true);
    const observed = {
      filePath: immediate.path,
      rawError: immediate.error,
      financialKeys: immediate.parsed?.financial === undefined ? null : Object.keys(immediate.parsed.financial),
      owned: immediate.parsed?.financial?.ownedRequestCount ?? null,
      ids: (immediate.parsed?.financial?.attempts ?? []).map(row => row.attemptId),
      generation: statusB.runtime.generation,
      restored: statusB.runtime.restored,
      control: statusB.runtime.control,
      configRejection: statusB.configuration.rejection,
      configRevision: statusB.configuration.revision,
      opened,
      restoredCalls: restored,
    };
    assert.equal(statusB.configuration.rejection, null, `the restored configuration is accepted (${JSON.stringify(observed)})`);
    assert.equal(opened.length >= 1, true, "the real ControlCheckpoint.open was observed");
    const openRecord = opened[opened.length - 1];
    assert.equal(openRecord.sessionId, sessionId, "the checkpoint open used the same observed session");
    assert.equal(openRecord.financial !== null, true, "the checkpoint open returned financial state");
    assert.equal(openRecord.restored, true, "the checkpoint reported itself restored");
    assert.equal(openRecord.financial.ids.join(","), positiveIds.join(","), "the opened snapshot carries the positive attempt identities");
    assert.equal(restored.length >= 1, true, "the real ModelService.restore was observed");
    const restoreRecord = restored[restored.length - 1];
    assert.equal(restoreRecord.snapshot !== null, true, "restore received the authentic snapshot");
    assert.equal(restoreRecord.serviceIds.join(","), positiveIds.join(","), "the receiving service holds the restored attempt identities");
    assert.equal(restoreRecord.ownedAfter, positiveFinancial.ownedRequestCount, "the receiving service holds the restored owned-request count");
    // The restored spend must constrain the next paid turn in this generation.
    drive(sessionB, "b");
    const denialDeadline = Date.now() + 20_000;
    let denied = false;
    while (!denied && Date.now() < denialDeadline) {
      const journal = await (async () => {
        let text = "";
        for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
          if (name.endsWith(".jsonl")) text += await readFile(join(agentDir, "quality", "logs", name), "utf8");
        }
        return text;
      })();
      denied = journal.includes("core.budget-requests-exhausted");
      if (!denied) await settle();
    }
    assert.equal(denied, true, `the restored owned-request spend denies the next paid turn (${JSON.stringify(observed)})`);
  } catch (error) {
    firstFailure = error;
    throw error;
  } finally {
    ControlCheckpoint.open = originalOpen;
    ModelService.prototype.restore = originalRestore;
    for (const session of sessions) {
      try { await session.retire("fixture-restore-cleanup"); } catch (error) { console.error("K07-RESTORE-CLEANUP", String(error)); }
    }
    if (firstFailure === null) await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// K07 239 §4 A.2: shared real-SDK held-expert fixture (createSession call-through,
// real read→submit, held first turn). Three independently selectable cases below.
// ---------------------------------------------------------------------------
const a2Pause = async (ms = 120) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };

async function readA2Journal(agentDir) {
  let journal = "";
  for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
    if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
  }
  return journal.split(String.fromCharCode(10)).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}

async function readA2Checkpoint(agentDir, sessionId) {
  const stateDirectory = join(agentDir, "quality", "state");
  for (const name of await readdir(stateDirectory).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const parsed = JSON.parse(await readFile(join(stateDirectory, name), "utf8"));
    if (parsed["observedSessionId"] === sessionId && parsed["financial"]?.attempts !== undefined) return parsed["financial"];
  }
  return null;
}

function a2Work(fixture) {
  fixture.session.handlePrimaryEvent({ type: "operator-input", text: `a2 work ${Date.now()}`, source: "interactive", occurredAt: new Date().toISOString() });
}

async function startA2Fixture({ expertCount, suspicionCount, material = false, materialPair = false, materialMany = 0, materialSplit = 0, expertTrigger = "every", blockerCount = 0 }) {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-a2-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  const sessionId = `sess-k07-a2-${process.pid}-${Date.now()}-${Math.round(performance.now())}`;
  if (material) await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.md"), "# Expert material\nowner notes for the A.2 fixture\n", "utf8");
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { boundaryWaitMs: 0, maxConcurrentEvaluations: 2, maxConcurrentReviewers: 1, maxEscalationsPerEpisode: 2, maxEscalationDepth: 1, restore: "reconcile-only" },
    modelProfiles: { scripted: { provider: "qe-k07-a2", model: "scripted-1", price: "unknown", requiredInputs: ["text"], maxAttempts: 1 } },
    permissions: { actions: ["core.request-check"], modelProfiles: ["scripted"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    // The preliminary check owns a current history-based suspicion. The target
    // expert independently requires the declared original material, so losing
    // that old expert window does not erase the new preliminary cause itself.
    ...((material || materialPair || materialMany > 0 || materialSplit > 0) ? {
      sources: materialSplit > 0
        ? {
          materialA: { uris: Array.from({ length: materialSplit }, (_, index) => `a${index + 1}.md`), role: "evidence", required: true, maxFiles: materialSplit },
          materialB: { uris: Array.from({ length: materialSplit }, (_, index) => `b${index + 1}.md`), role: "evidence", required: true, maxFiles: materialSplit },
        }
        : { material: { uris: materialPair ? ["a.md", "b.md"] : materialMany > 0 ? Array.from({ length: materialMany }, (_, index) => `f${index + 1}.md`) : ["material.md"], role: "evidence", required: true, ...(materialMany > 0 ? { maxFiles: materialMany } : {}) } },
      contexts: {
        work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 },
        "expert-material": { providers: [{ id: "files", use: "core.files", options: { sourceIds: materialSplit > 0 ? ["materialA", "materialB"] : ["material"] } }], maxEstimatedTokens: 8000 },
      },
    } : {}),
    evaluators: { suspected: { use: "fixture.a2-suspected", options: {} }, expert: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
    policies: { engineering: { use: "core.engineering", options: { escalateTo: "expert" } }, "expert-engineering": { use: "core.engineering", options: {} }, ...(blockerCount > 0 ? { "blocker-record": { use: "core.record-only" } } : {}) },
    checks: {
      suspicion: { triggers: [{ id: "due", use: "core.every-tools", options: { count: suspicionCount } }], context: "work", prompt: "repetition", evaluator: "suspected", policy: "engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      ...(blockerCount > 0 ? { blocker: { triggers: [{ id: "due", use: "core.every-tools", options: { count: blockerCount } }], context: "work", prompt: "repetition", evaluator: "expert", policy: "blocker-record", cooldownMs: 60_000, criteria: ["efficiency.repetition"] } } : {}),
      expert: { triggers: expertTrigger === "none" ? [] : [{ id: "due", use: "core.every-tools", options: { count: expertCount } }], context: (material || materialPair || materialMany > 0) ? "expert-material" : "work", prompt: "repetition", evaluator: "expert", policy: "expert-engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  }), "utf8");
  const latch = (() => { let release; const promise = new Promise(resolvePromise => { release = resolvePromise; }); return { promise, release }; })();
  const counts = { creates: 0, transportsActive: 0, transportsSettled: 0, promptsActive: 0, promptsSettled: 0 };
  if (material) await writeFile(join(agentDir, "quality", "material.md"), "material-v1 owner evidence", "utf8");
  if (materialPair) {
    await writeFile(join(agentDir, "quality", "a.md"), "stable-required-A", "utf8");
    await writeFile(join(agentDir, "quality", "b.md"), "original-required-B", "utf8");
  }
  if (materialMany > 0) {
    for (let index = 1; index <= materialMany; index += 1) {
      await writeFile(join(agentDir, "quality", `f${index}.md`), `required-file-${index}`, "utf8");
    }
  }
  if (materialSplit > 0) {
    for (let index = 1; index <= materialSplit; index += 1) {
      await writeFile(join(agentDir, "quality", `a${index}.md`), `split-A-${index}`, "utf8");
      await writeFile(join(agentDir, "quality", `b${index}.md`), `split-B-${index}`, "utf8");
    }
  }
  const arrivals = { expert: 0, blocker: 0, primary: 0 };
  const transcripts = [];
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  models.registerProvider("qe-k07-a2", {
    name: "K07 A.2 scripted expert provider",
    api: "qe-k07-a2-api",
    apiKey: "fixture-not-credential",
    baseUrl: "http://127.0.0.1:9/not-used",
    streamSimple: (model, context) => {
      const transcript = JSON.stringify(context.messages ?? []);
      if (transcript.includes("Bounded review of check blocker")) {
        arrivals.blocker += 1;
        counts.transportsActive += 1;
        const blockerMessage = (async () => {
          try {
            await latch.promise;
            return assistantMessage(model, [{ type: "text", text: "blocker released" }], "endTurn");
          } finally {
            counts.transportsActive -= 1;
            counts.transportsSettled += 1;
          }
        })();
        return {
          async *[Symbol.asyncIterator]() {
            const message = await blockerMessage;
            yield { type: "start", partial: { ...message, content: [] } };
            yield { type: "done", reason: message.stopReason, message };
          },
          async result() { return blockerMessage; },
        };
      }
      if (!transcript.includes("Bounded review of check expert")) {
        arrivals.primary += 1;
        return eventStream(assistantMessage(model, [{ type: "text", text: "primary continues" }], "endTurn"));
      }
      arrivals.expert += 1;
      transcripts.push(transcript);
      if (arrivals.expert === 1) {
        counts.transportsActive += 1;
        const finalMessage = (async () => {
          try {
            await latch.promise;
            return assistantMessage(model, [{ type: "toolCall", id: "a2-read-1", name: "read", arguments: { path: "notes.md" } }], "toolUse");
          } finally {
            counts.transportsActive -= 1;
            counts.transportsSettled += 1;
          }
        })();
        return {
          async *[Symbol.asyncIterator]() {
            const message = await finalMessage;
            yield { type: "start", partial: { ...message, content: [] } };
            yield { type: "done", reason: message.stopReason, message };
          },
          async result() { return finalMessage; },
        };
      }
      return eventStream(assistantMessage(model, [{ type: "toolCall", id: "a2-submit-1", name: "submit_result", arguments: {
        operational: "completed",
        coverage: { state: "complete", scopeDescription: "A.2 expert reviewed the permitted material", issues: [] },
        conclusion: "no-supported-finding",
        findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
      } }], "toolUse"));
    },
    models: [{ id: "scripted-1", name: "scripted", api: "qe-k07-a2-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65_536, maxTokens: 8_192 }],
  });
  const modelRegistry = new ModelRegistry(models);
  const port = piModelRegistryPort(modelRegistry);
  let serial = 0;
  const session = await EngineSession.start({
    observedSessionId: sessionId, branchId: "unresolved", agentDir,
    projectConfigDir: join(project, ".pi"), projectRoot: project, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
    modelRegistry: port,
    feedbackHost: {
      capabilities: () => new Set(),
      deliver: async request => ({ actionId: request.actionId, state: "rejected", destinationId: null, evidenceIds: [], error: { code: "core.feedback-unsupported", retryable: false } }),
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
    reviewHostFactory: async model => {
      const host = await createPiReviewerHost(modelRegistry, { model });
      return {
        createSession: async input => {
          const created = await host.createSession(input);
          counts.creates += 1;
          return created;
        },
        prompt: async (sessionHandle, text) => {
          counts.promptsActive += 1;
          try { return await host.prompt(sessionHandle, text); }
          finally { counts.promptsActive -= 1; counts.promptsSettled += 1; }
        },
        abort: sessionHandle => host.abort(sessionHandle),
        validate: payload => host.validate(payload),
      };
    },
  });
  const registered = session.endpoint.register({ id: "fixture.k07-a2", version: "0.1.0", baseUri: "fixture:a2", components: [{
    id: "fixture.a2-suspected", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.a2-suspected"],
    evaluate: async (_options, input) => {
      const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
      serial += 1;
      return {
        operational: "completed", coverage: input.context.coverage,
        conclusion: items.length > 0 ? "findings" : "no-supported-finding",
        findings: items.map(item => ({
          id: `${input.run.runId}:finding-1`, criterion: "efficiency.repetition", status: "suspected", severity: "concern",
          requirementRefs: [], evidenceIds: [item.id], affectedItems: [], defectCode: `fixture.a2-suspected-${serial}`,
          explanation: `preliminary suspicion for the expert cause-${serial}`, proposedCorrection: null, limitations: [],
        })),
        scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [],
      };
    },
  }], resources: {} });
  if (registered.ok) await registered.value.ready;
  await session.reloadConfiguration();
  await a2Pause(250);
  const fixture = { root, project, agentDir, sessionId, session, latch, arrivals, counts, transcripts, firstFailureRef: { value: null } };
  return fixture;
}

test("K07-A2-scheduled-first: a scheduled expert keeps its root identity when a later policy cause reuses it", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 1, suspicionCount: 2 });
  const { session, latch, arrivals, counts, agentDir, sessionId, firstFailureRef } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const firstTool = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2-1", toolName: "read", parentOperationId: null, occurredAt: firstTool });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: firstTool });
    const heldDeadline = Date.now() + 20_000;
    while (arrivals.expert === 0 && Date.now() < heldDeadline) await a2Pause();
    assert.equal(arrivals.expert, 1, "the scheduled expert entered and is held");
    assert.equal(counts.creates, 1, "exactly one real SDK session was created");
    const started = (await journal()).filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    assert.equal(started.length, 1, "one scheduled expert run started");
    const scheduledRun = started[0]?.fields?.correlation?.["runId"] ?? null;
    assert.equal(typeof scheduledRun, "string", "the scheduled run identity is captured");
    // The later equivalent policy cause reuses that exact run (no reparenting).
    const secondTool = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2-2", toolName: "read", parentOperationId: null, occurredAt: secondTool });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2-2", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: secondTool });
    const reuseDeadline = Date.now() + 10_000;
    let receipt = null;
    while (receipt === null && Date.now() < reuseDeadline) {
      receipt = (await journal()).find(record => record.event === "quality.action.receipt"
        && record.fields?.data?.state === "queued"
        && typeof record.fields?.data?.destinationRef === "string") ?? null;
      if (receipt === null) await a2Pause();
    }
    assert.ok(receipt, "the policy cause produced a request receipt");
    assert.equal(receipt.fields.data.destinationRef, scheduledRun, "the policy cause names the scheduled run, not a new child");
    assert.equal(counts.creates, 1, "the policy cause created no second SDK session");
    assert.equal((await journal()).filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert").length, 1, "no new expert run was allocated");
    // The held prompt was already built: the later cause cannot be delivered retroactively.
    const heldPrompt = fixture.transcripts[0] ?? "";
    // Original declared instruction material reaches the scheduled expert input.
    const instructionText = (await readFile(join(RESOURCES_DIR, "prompts", "repetition-v1.md"), "utf8")).split(String.fromCharCode(10))[0]?.trim() ?? "";
    assert.equal(instructionText.length > 0, true, "the declared instruction body exists");
    assert.equal(heldPrompt.includes(instructionText), true, "the scheduled expert input carries the original instruction material");
    // The later policy cause was NOT delivered retroactively to the held input.
    assert.equal(heldPrompt.includes("cause-2"), false, "the later cause's hypothesis is absent from the already-built input");
    // Accepted phase control: stop further scheduler triggers before release so
    // the held run is the only expert execution in this case.
    const configPath = join(agentDir, "quality", "config.json");
    const quietConfig = JSON.parse(await readFile(configPath, "utf8"));
    quietConfig.checks.expert.enabled = false;
    await writeFile(configPath, JSON.stringify(quietConfig), "utf8");
    await session.reloadConfiguration();
    latch.release();
    const turnDeadline = Date.now() + 20_000;
    while (arrivals.expert < 2 && Date.now() < turnDeadline) await a2Pause();
    assert.equal(arrivals.expert, 2, "the released scheduled expert used its two turns");
    const settleDeadline = Date.now() + 20_000;
    let settled = false;
    while (!settled && Date.now() < settleDeadline) {
      settled = (await journal()).some(record => record.event === "quality.check.settled"
        && record.fields?.correlation?.["runId"] === scheduledRun
        && record.fields?.data?.operational === "completed");
      if (!settled) await a2Pause();
    }
    assert.equal(settled, true, "the scheduled run settled exactly once under its own identity");
    assert.equal(counts.creates, 1, "no second expert was created after drain");
    const rows = await readA2Checkpoint(agentDir, sessionId);
    const attempt = (rows?.attempts ?? [])[0];
    assert.equal(attempt?.originRunId ?? null, scheduledRun, "the model attempt is attributed to the scheduled run root");
  } catch (error) {
    firstFailureRef.value = error;
    throw error;
  } finally {
    latch.release();
    try { await session.retire("fixture-a2-complete"); } catch (error) { console.error("K07-A2-CLEANUP", String(error)); }
    if (fixture.firstFailureRef.value === null) await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K07-A2-scheduler-cause: an equivalent scheduler cause while the expert is held coalesces onto the policy child", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 2, suspicionCount: 1 });
  const { session, latch, arrivals, counts, agentDir } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const tool1 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2-11", toolName: "read", parentOperationId: null, occurredAt: tool1 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2-11", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool1 });
    const heldDeadline = Date.now() + 20_000;
    while (arrivals.expert === 0 && Date.now() < heldDeadline) await a2Pause();
    assert.equal(arrivals.expert, 1, "the policy-first expert is held");
    assert.equal(counts.creates, 1, "one real SDK session was created");
    const started = (await journal()).filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    assert.equal(started.length, 1, "one policy child run started");
    const childRun = started[0]?.fields?.correlation?.["runId"] ?? null;
    assert.equal(typeof childRun, "string", "the policy child identity is captured");
    // A second tool completes the expert check's own every-tools trigger while held.
    const tool2 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2-12", toolName: "read", parentOperationId: null, occurredAt: tool2 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2-12", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool2 });
    const coalesceDeadline = Date.now() + 10_000;
    let coalesced = null;
    while (coalesced === null && Date.now() < coalesceDeadline) {
      coalesced = (await journal()).find(record => record.event === "quality.check.admission"
        && record.fields?.data?.checkId === "expert"
        && record.fields?.data?.outcome === "coalesced"
        && record.fields?.data?.mergedIntoRunId === childRun) ?? null;
      if (coalesced === null) await a2Pause();
    }
    assert.ok(coalesced, "the equivalent scheduler cause really coalesced onto the held policy child");
    assert.equal(counts.creates, 1, "the scheduler cause created no second SDK session");
    assert.equal(arrivals.expert, 1, "the scheduler cause started no second expert turn");
    // Accepted phase control: stop further scheduler triggers before release so
    // the held run is the only expert execution in this case.
    const configPath = join(agentDir, "quality", "config.json");
    const quietConfig = JSON.parse(await readFile(configPath, "utf8"));
    quietConfig.checks.expert.enabled = false;
    await writeFile(configPath, JSON.stringify(quietConfig), "utf8");
    await session.reloadConfiguration();
    latch.release();
    const turnDeadline = Date.now() + 20_000;
    while (arrivals.expert < 2 && Date.now() < turnDeadline) await a2Pause();
    assert.equal(arrivals.expert, 2, "the held child used its two turns after release");
    const settleDeadline = Date.now() + 20_000;
    let settled = false;
    while (!settled && Date.now() < settleDeadline) {
      settled = (await journal()).some(record => record.event === "quality.check.settled"
        && record.fields?.correlation?.["runId"] === childRun
        && record.fields?.data?.operational === "completed");
      if (!settled) await a2Pause();
    }
    assert.equal(settled, true, "the held child settled exactly once");
    assert.equal(counts.creates, 1, "no second expert was created after drain");
  } catch (error) {
    fixture.firstFailureRef.value = error;
    throw error;
  } finally {
    latch.release();
    try { await session.retire("fixture-a2-complete"); } catch (error) { console.error("K07-A2-CLEANUP", String(error)); }
    if (fixture.firstFailureRef.value === null) await rm(fixture.root, { recursive: true, force: true });
  }
});

// Join the current cause's actual terminal request receipt, not an absence
// poll for a desired code or a receipt from the first/another generation.
async function observeA2MaterialReceipt(fixture) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const rows = (await readA2Journal(fixture.agentDir)).filter(record => record.fields?.scope?.observedSessionId === fixture.sessionId);
    const requests = rows.filter(record => record.event === "quality.action.admission"
      && record.fields?.data?.componentId === "core.request-check" && record.fields?.data?.outcome === "admitted");
    const request = requests[1];
    const receipt = request === undefined ? undefined : rows.find(record => record.event === "quality.action.receipt"
      && record.fields?.scope?.runtimeGeneration === request.fields.scope.runtimeGeneration
      && record.fields?.correlation?.runId === request.fields.correlation.runId
      && record.fields?.data?.actionId === request.fields.data.actionId);
    if (receipt !== undefined) {
      const assessment = rows.find(record => record.event === "quality.assessment.result"
        && record.fields?.scope?.runtimeGeneration === request.fields.scope.runtimeGeneration
        && record.fields?.correlation?.runId === request.fields.correlation.runId);
      assert.equal(assessment?.fields.data.operational, "completed", "the current preliminary assessment completed");
      assert.equal(assessment?.fields.data.coverage, "complete", "the current preliminary cause has complete declared coverage");
      assert.equal(assessment?.fields.data.conclusion, "findings", "the current cause contains an actual fixture suspicion");
      console.log("K07-A2-CURRENT-CAUSE", JSON.stringify({ scope: receipt.fields.scope,
        runId: receipt.fields.correlation.runId, request: request.fields.data, receipt: receipt.fields.data,
        counts: { ...fixture.counts }, arrivals: { ...fixture.arrivals }, pending: fixture.session.status(true).checks.pendingIntents }));
      return receipt;
    }
    await a2Pause();
  }
  assert.fail("the current second cause did not reach a joined request-check receipt");
}

async function finishA2MaterialFixture(fixture) {
  fixture.latch.release();
  try {
    await fixture.session.retire("fixture-a2-complete");
    const deadline = Date.now() + 5_000;
    while ((fixture.counts.transportsActive !== 0 || fixture.counts.promptsActive !== 0) && Date.now() < deadline) await a2Pause();
    assert.equal(fixture.counts.transportsActive, 0, "the actual held transport drained");
    assert.equal(fixture.counts.promptsActive, 0, "the actual SDK prompt completed or rejected");
    assert.equal(fixture.counts.transportsSettled, 1, "the held transport settled exactly once");
    assert.equal(fixture.session.status(true).runtime.state, "retired", "the engine owner retired");
    console.log("K07-A2-DRAIN", JSON.stringify({ sessionId: fixture.sessionId, counts: fixture.counts, cleanupErrors: [] }));
  } catch (error) {
    console.error("K07-A2-CLEANUP", String(error));
    throw new AggregateError([fixture.firstFailureRef.value, error].filter(Boolean), "A.2 control/cleanup failure; owned state retained");
  }
  if (fixture.firstFailureRef.value === null) await rm(fixture.root, { recursive: true, force: true });
}

test("K07-A2-incompatible-authority: a later operator amendment cannot silently reuse the held expert's authority", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 1, suspicionCount: 1, expertTrigger: "none" });
  const { session, latch, arrivals, counts, agentDir } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const tool1 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2-21", toolName: "read", parentOperationId: null, occurredAt: tool1 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2-21", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool1 });
    const heldDeadline = Date.now() + 20_000;
    while (arrivals.expert === 0 && Date.now() < heldDeadline) await a2Pause();
    assert.equal(arrivals.expert, 1, "the policy-first expert is held");
    assert.equal(counts.creates, 1, "one real SDK session was created");
    const started = (await journal()).filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    assert.equal(started.length, 1, "one expert run started");
    const expertRun = started[0]?.fields?.correlation?.["runId"] ?? null;
    const originalScope = started[0]?.fields?.scope ?? null;
    assert.equal(typeof expertRun, "string", "the held expert identity is captured");
    assert.equal(session.scopeCurrent(originalScope), true, "the original scope is current before the amendment");
    const heldInput = fixture.transcripts[0] ?? "";
    // A distinct accepted operator amendment to the still-open original task.
    a2Work(fixture);
    await a2Pause(150);
    assert.equal(session.scopeCurrent(originalScope), false, "the amendment advanced the observed authorization");
    // The ordinary preliminary trigger produces a new current cause.
    const tool2 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2-22", toolName: "read", parentOperationId: null, occurredAt: tool2 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2-22", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool2 });
    const receipt = await observeA2MaterialReceipt(fixture);
    const amendedScopes = (await journal())
      .filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "suspicion")
      .map(record => record.fields?.scope ?? null);
    const amendedScope = amendedScopes[amendedScopes.length - 1];
    assert.equal(amendedScope.episodeId, originalScope.episodeId, "the amendment keeps the same episode");
    assert.notEqual(amendedScope.authorizationRevision, originalScope.authorizationRevision, "the amendment advanced the authorization revision");
    assert.equal(receipt.fields.data.state, "rejected", "the amended cause has its own rejected receipt");
    assert.equal(receipt.fields.data.errorCode, "core.escalation-incompatible-cause", "the amended cause is refused explicitly");
    assert.equal(receipt.fields.scope.authorizationRevision, amendedScope.authorizationRevision, "the receipt belongs to the amended authority");
    assert.equal(fixture.transcripts[0], heldInput, "the original expert input is immutable");
    assert.equal(counts.creates, 1, "the amended cause created no extra SDK session");
    assert.equal(arrivals.expert, 1, "the amended cause started no extra expert turn");
    latch.release();
    const settleDeadline = Date.now() + 20_000;
    let settled = false;
    while (!settled && Date.now() < settleDeadline) {
      settled = (await journal()).some(record => record.event === "quality.check.settled"
        && record.fields?.correlation?.["runId"] === expertRun
        && record.fields?.data?.operational === "completed");
      if (!settled) await a2Pause();
    }
    assert.equal(settled, true, "the held expert finished under its original authority");
    assert.equal(arrivals.expert, 2, "the held expert used its two turns");
    assert.equal(counts.creates, 1, "no second expert was created after drain");
  } catch (error) {
    fixture.firstFailureRef.value = error;
    throw error;
  } finally {
    await finishA2MaterialFixture(fixture);
  }
});

test("K07-A2-material-change: changed required material is refused, not silently covered", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 1, suspicionCount: 1, material: true, expertTrigger: "none" });
  const { session, latch, arrivals, counts, agentDir } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const tool1 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2m-1", toolName: "read", parentOperationId: null, occurredAt: tool1 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2m-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool1 });
    const heldDeadline = Date.now() + 20_000;
    while (arrivals.expert === 0 && Date.now() < heldDeadline) await a2Pause();
    assert.equal(arrivals.expert, 1, "the policy-first expert is held");
    assert.equal(counts.creates, 1, "one real SDK session was created");
    const held = fixture.transcripts[0] ?? "";
    assert.equal(held.includes("material-v1 owner evidence"), true, "the held expert input carries the original required material");
    const started = (await journal()).filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    assert.equal(started.length, 1, "one expert run started");
    const childRun = started[0]?.fields?.correlation?.["runId"] ?? null;
    assert.equal(typeof childRun, "string", "the held expert identity is captured");
    // The declared required material changes while the expert is held.
    await writeFile(join(agentDir, "quality", "material.md"), "material-v2 owner evidence", "utf8");
    const tool2 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2m-2", toolName: "read", parentOperationId: null, occurredAt: tool2 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2m-2", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool2 });
    const receipt = await observeA2MaterialReceipt(fixture);
    assert.equal(await readFile(join(agentDir, "quality", "material.md"), "utf8"), "material-v2 owner evidence", "the target's currently required material really changed");
    assert.equal(fixture.transcripts[0], held, "the original expert input is immutable");
    assert.equal(held.includes("material-v2 owner evidence"), false, "the old input does not retroactively contain the new material");
    assert.equal(counts.creates, 1, "the changed-material cause created no second expert");
    assert.equal(arrivals.expert, 1, "the changed-material cause started no second expert turn");
    const refused = receipt.fields.data.state === "rejected" && receipt.fields.data.errorCode === "core.escalation-incompatible-cause";
    assert.ok(refused, "changed required material is refused explicitly, not silently covered");
  } catch (error) {
    fixture.firstFailureRef.value = error;
    try {
      const rows = (await journal()).filter(record => /^(quality[.](config|context|check|assessment|policy|action)[.])/.test(record.event));
      console.error("A2-DEBUG", JSON.stringify(rows.map(record => ({ e: record.event, s: record.fields?.scope ?? null, d: record.fields?.data ?? null, c: record.fields?.correlation ?? null }))).slice(0, 20000));
    } catch (debugError) { console.error("A2-DEBUG-FAIL", String(debugError)); }
    throw error;
  } finally {
    await finishA2MaterialFixture(fixture);
  }
});

test("K07-A2-window-expired: an expired material window is refused, not silently covered", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 1, suspicionCount: 1, material: true, expertTrigger: "none" });
  const { session, latch, arrivals, counts, agentDir } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const tool1 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2w-1", toolName: "read", parentOperationId: null, occurredAt: tool1 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2w-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool1 });
    const heldDeadline = Date.now() + 20_000;
    while (arrivals.expert === 0 && Date.now() < heldDeadline) await a2Pause();
    assert.equal(arrivals.expert, 1, "the policy-first expert is held");
    assert.equal(counts.creates, 1, "one real SDK session was created");
    const held = fixture.transcripts[0] ?? "";
    assert.equal(held.includes("material-v1 owner evidence"), true, "the held expert input carries the original required material");
    // The declared required material disappears: the held window can no longer be revalidated.
    await rm(join(agentDir, "quality", "material.md"), { force: true });
    const tool2 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2w-2", toolName: "read", parentOperationId: null, occurredAt: tool2 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2w-2", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool2 });
    const receipt = await observeA2MaterialReceipt(fixture);
    assert.equal(existsSync(join(agentDir, "quality", "material.md")), false, "the target's required old material window really became unavailable");
    assert.equal(fixture.transcripts[0], held, "the original expert input is immutable after window loss");
    assert.equal(counts.creates, 1, "the expired-window cause created no second expert");
    assert.equal(arrivals.expert, 1, "the expired-window cause started no second expert turn");
    const refused = receipt.fields.data.state === "rejected" && receipt.fields.data.errorCode === "core.escalation-incompatible-cause";
    assert.ok(refused, "an expired material window is refused explicitly, not silently covered");
  } catch (error) {
    fixture.firstFailureRef.value = error;
    throw error;
  } finally {
    await finishA2MaterialFixture(fixture);
  }
});

test("K07-A2-material-unchanged: an unchanged required material window is reused", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 1, suspicionCount: 1, material: true, expertTrigger: "none" });
  const { session, latch, arrivals, counts, agentDir } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const tool1 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2u-1", toolName: "read", parentOperationId: null, occurredAt: tool1 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2u-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool1 });
    const heldDeadline = Date.now() + 20_000;
    while (arrivals.expert === 0 && Date.now() < heldDeadline) await a2Pause();
    assert.equal(arrivals.expert, 1, "the policy-first expert is held");
    const started = (await journal()).filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    const expertRun = started[0]?.fields?.correlation?.["runId"] ?? null;
    assert.equal(typeof expertRun, "string", "the held expert identity is captured");
    const held = fixture.transcripts[0] ?? "";
    assert.equal(held.includes("material-v1 owner evidence"), true, "the held expert input carries the declared material");
    // Required material is unchanged: the equivalent current cause reuses the run.
    const tool2 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "a2u-2", toolName: "read", parentOperationId: null, occurredAt: tool2 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "a2u-2", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool2 });
    const receipt = await observeA2MaterialReceipt(fixture);
    assert.equal(receipt.fields.data.state, "queued", "the compatible current cause is accepted, not refused");
    assert.equal(receipt.fields.data.destinationRef, expertRun, "the current cause names the same held expert run");
    assert.equal(counts.creates, 1, "the reused cause created no second expert");
    assert.equal(arrivals.expert, 1, "the reused cause started no second expert turn");
  } catch (error) {
    fixture.firstFailureRef.value = error;
    throw error;
  } finally {
    await finishA2MaterialFixture(fixture);
  }
});

test("K07-A2-required-set-second-changed: only the second required resource changes is handled by the complete required set", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 1, suspicionCount: 1, materialPair: true, expertTrigger: "none" });
  const { session, latch, arrivals, counts, agentDir } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const tool1 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "K07-A2-required-set-second-changed-1", toolName: "read", parentOperationId: null, occurredAt: tool1 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "K07-A2-required-set-second-changed-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool1 });
    const heldDeadline = Date.now() + 20_000;
    while (arrivals.expert === 0 && Date.now() < heldDeadline) await a2Pause();
    assert.equal(arrivals.expert, 1, "the policy-first expert is held");
    const held = fixture.transcripts[0] ?? "";
    assert.equal(held.includes("stable-required-A"), true, "the first required resource reached the held target");
    assert.equal(held.includes("original-required-B"), true, "the second required resource reached the held target");
    const started = (await journal()).filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    const expertRun = started[0]?.fields?.correlation?.["runId"] ?? null;
    assert.equal(typeof expertRun, "string", "the held expert identity is captured");
    await writeFile(join(agentDir, "quality", "b.md"), "changed-required-B", "utf8");
    const tool2 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "K07-A2-required-set-second-changed-2", toolName: "read", parentOperationId: null, occurredAt: tool2 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "K07-A2-required-set-second-changed-2", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool2 });
    const receipt = await observeA2MaterialReceipt(fixture);
    assert.equal(fixture.transcripts[0], held, "the original expert input is immutable");
    assert.equal(counts.creates, 1, "no extra expert was created");
    assert.equal(arrivals.expert, 1, "no extra expert turn started");
    if ("rejected" === "rejected") {
      assert.equal(receipt.fields.data.state, "rejected", "the changed required set is refused, not covered");
      assert.equal(receipt.fields.data.errorCode, "core.escalation-incompatible-cause", "the refusal is the exact incompatibility code");
    } else {
      assert.equal(receipt.fields.data.state, "queued", "the compatible current cause is accepted");
      assert.equal(receipt.fields.data.destinationRef, expertRun, "the current cause names the same held expert run");
    }
  } catch (error) {
    fixture.firstFailureRef.value = error;
    throw error;
  } finally {
    await finishA2MaterialFixture(fixture);
  }
});

test("K07-A2-required-set-second-missing: the second required resource disappears is handled by the complete required set", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 1, suspicionCount: 1, materialPair: true, expertTrigger: "none" });
  const { session, latch, arrivals, counts, agentDir } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const tool1 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "K07-A2-required-set-second-missing-1", toolName: "read", parentOperationId: null, occurredAt: tool1 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "K07-A2-required-set-second-missing-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool1 });
    const heldDeadline = Date.now() + 20_000;
    while (arrivals.expert === 0 && Date.now() < heldDeadline) await a2Pause();
    assert.equal(arrivals.expert, 1, "the policy-first expert is held");
    const held = fixture.transcripts[0] ?? "";
    assert.equal(held.includes("stable-required-A"), true, "the first required resource reached the held target");
    assert.equal(held.includes("original-required-B"), true, "the second required resource reached the held target");
    const started = (await journal()).filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    const expertRun = started[0]?.fields?.correlation?.["runId"] ?? null;
    assert.equal(typeof expertRun, "string", "the held expert identity is captured");
    await rm(join(agentDir, "quality", "b.md"), { force: true });
    const tool2 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "K07-A2-required-set-second-missing-2", toolName: "read", parentOperationId: null, occurredAt: tool2 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "K07-A2-required-set-second-missing-2", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool2 });
    const receipt = await observeA2MaterialReceipt(fixture);
    assert.equal(fixture.transcripts[0], held, "the original expert input is immutable");
    assert.equal(counts.creates, 1, "no extra expert was created");
    assert.equal(arrivals.expert, 1, "no extra expert turn started");
    if ("rejected" === "rejected") {
      assert.equal(receipt.fields.data.state, "rejected", "the changed required set is refused, not covered");
      assert.equal(receipt.fields.data.errorCode, "core.escalation-incompatible-cause", "the refusal is the exact incompatibility code");
    } else {
      assert.equal(receipt.fields.data.state, "queued", "the compatible current cause is accepted");
      assert.equal(receipt.fields.data.destinationRef, expertRun, "the current cause names the same held expert run");
    }
  } catch (error) {
    fixture.firstFailureRef.value = error;
    throw error;
  } finally {
    await finishA2MaterialFixture(fixture);
  }
});

test("K07-A2-required-set-unchanged: both required resources stay unchanged is handled by the complete required set", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 1, suspicionCount: 1, materialPair: true, expertTrigger: "none" });
  const { session, latch, arrivals, counts, agentDir } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const tool1 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "K07-A2-required-set-unchanged-1", toolName: "read", parentOperationId: null, occurredAt: tool1 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "K07-A2-required-set-unchanged-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool1 });
    const heldDeadline = Date.now() + 20_000;
    while (arrivals.expert === 0 && Date.now() < heldDeadline) await a2Pause();
    assert.equal(arrivals.expert, 1, "the policy-first expert is held");
    const held = fixture.transcripts[0] ?? "";
    assert.equal(held.includes("stable-required-A"), true, "the first required resource reached the held target");
    assert.equal(held.includes("original-required-B"), true, "the second required resource reached the held target");
    const started = (await journal()).filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    const expertRun = started[0]?.fields?.correlation?.["runId"] ?? null;
    assert.equal(typeof expertRun, "string", "the held expert identity is captured");
    
    const tool2 = new Date().toISOString();
    session.handlePrimaryEvent({ type: "tool-started", operationId: "K07-A2-required-set-unchanged-2", toolName: "read", parentOperationId: null, occurredAt: tool2 });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "K07-A2-required-set-unchanged-2", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: tool2 });
    const receipt = await observeA2MaterialReceipt(fixture);
    assert.equal(fixture.transcripts[0], held, "the original expert input is immutable");
    assert.equal(counts.creates, 1, "no extra expert was created");
    assert.equal(arrivals.expert, 1, "no extra expert turn started");
    if ("queued" === "rejected") {
      assert.equal(receipt.fields.data.state, "rejected", "the changed required set is refused, not covered");
      assert.equal(receipt.fields.data.errorCode, "core.escalation-incompatible-cause", "the refusal is the exact incompatibility code");
    } else {
      assert.equal(receipt.fields.data.state, "queued", "the compatible current cause is accepted");
      assert.equal(receipt.fields.data.destinationRef, expertRun, "the current cause names the same held expert run");
    }
  } catch (error) {
    fixture.firstFailureRef.value = error;
    throw error;
  } finally {
    await finishA2MaterialFixture(fixture);
  }
});

test("K07-A2-pending-material-changed: changed target material is revalidated on wake", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 1, suspicionCount: 2, material: true, expertTrigger: "none", blockerCount: 1 });
  const { session, latch, arrivals, counts, agentDir } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const tool = serial => {
      const at = new Date().toISOString();
      session.handlePrimaryEvent({ type: "tool-started", operationId: `K07-A2-pending-material-changed-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
      session.handlePrimaryEvent({ type: "tool-completed", operationId: `K07-A2-pending-material-changed-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
    };
    tool(1);
    const blockerDeadline = Date.now() + 20_000;
    while (arrivals.blocker === 0 && Date.now() < blockerDeadline) await a2Pause();
    assert.equal(arrivals.blocker, 1, "the real blocker reviewer occupies the single reviewer slot");
    assert.equal(counts.creates, 1, "only the blocker SDK session exists");
    tool(2);
    const reserveDeadline = Date.now() + 20_000;
    let reserved = null;
    while (reserved === null && Date.now() < reserveDeadline) {
      reserved = (await journal()).find(record => record.event === "quality.action.receipt"
        && record.fields?.data?.state === "queued"
        && record.fields?.data?.errorCode === null
        && typeof record.fields?.data?.destinationRef === "string") ?? null;
      if (reserved === null) await a2Pause();
    }
    assert.ok(reserved, "the first cause reserved a bounded queued identity");
    const reservedRunId = reserved.fields.data.destinationRef;
    assert.equal((await journal()).some(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert"), false, "the target is not created before its first dispatch");
    assert.equal(arrivals.expert, 0, "the target never entered the provider while queued");
    await writeFile(join(agentDir, "quality", "material.md"), "material-v2 owner evidence", "utf8");
    tool(3);
    tool(4);
    const secondDeadline = Date.now() + 20_000;
    let second = null;
    while (second === null && Date.now() < secondDeadline) {
      second = (await journal()).filter(record => record.event === "quality.action.receipt"
        && record.fields?.data?.state === "queued"
        && record.fields?.data?.destinationRef === reservedRunId).slice(1)[0] ?? null;
      if (second === null) await a2Pause();
    }
    assert.ok(second, "the distinct current cause reuses the same truthful reserved identity");
    assert.equal(session.status(true).checks.pendingIntents >= 1, true, "the bounded pending request is retained while capacity is held");
    assert.equal(counts.creates, 1, "no target create while queued");
    latch.release();
    const wakeDeadline = Date.now() + 20_000;
    while (arrivals.expert === 0 && Date.now() < wakeDeadline) await a2Pause();
    assert.equal(arrivals.expert >= 1, true, "the released capacity lets the reserved target assemble fresh material");
    const freshInput = fixture.transcripts[0] ?? "";
    assert.equal(freshInput.includes("material-v2 owner evidence"), true, "the fresh target input carries the current material, not the obsolete assumption");
    assert.equal(freshInput.includes("material-v1 owner evidence"), false, "the obsolete material is not delivered retroactively");
    const expertStarted = (await journal()).find(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    const expertRunId = expertStarted?.fields?.correlation?.runId ?? null;
    assert.equal(typeof expertRunId, "string", "the fresh target run identity is captured");
    const freshSettle = Date.now() + 20_000;
    let settledRun = null;
    while (settledRun === null && Date.now() < freshSettle) {
      settledRun = (await journal()).find(record => record.event === "quality.check.settled"
        && record.fields?.correlation?.runId === expertRunId
        && record.fields?.data?.operational === "completed"
        && record.fields?.data?.terminalReason === "evaluated") ?? null;
      if (settledRun === null) await a2Pause();
    }
    assert.ok(settledRun, "the fresh target settled canonically once");
    assert.equal(arrivals.expert, 2, "the fresh target used its read and submit turns only");
  } catch (error) {
    fixture.firstFailureRef.value = error;
    throw error;
  } finally {
    latch.release();
    try {
      await session.retire("fixture-a2-pending-complete");
      const drainDeadline = Date.now() + 5_000;
      while (counts.transportsActive !== 0 && Date.now() < drainDeadline) await a2Pause();
      assert.equal(counts.transportsActive, 0, "the actual held transports drained");
      assert.equal(session.status(true).runtime.state, "retired", "the engine owner retired");
    } catch (cleanupError) {
      console.error("K07-A2-PENDING-CLEANUP", String(cleanupError));
      throw new AggregateError([fixture.firstFailureRef.value, cleanupError].filter(Boolean), "pending control/cleanup failure; owned state retained");
    }
    if (fixture.firstFailureRef.value === null) await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K07-A2-pending-material-missing: missing target material never enters the provider", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 1, suspicionCount: 2, material: true, expertTrigger: "none", blockerCount: 1 });
  const { session, latch, arrivals, counts, agentDir } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const tool = serial => {
      const at = new Date().toISOString();
      session.handlePrimaryEvent({ type: "tool-started", operationId: `K07-A2-pending-material-missing-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
      session.handlePrimaryEvent({ type: "tool-completed", operationId: `K07-A2-pending-material-missing-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
    };
    tool(1);
    const blockerDeadline = Date.now() + 20_000;
    while (arrivals.blocker === 0 && Date.now() < blockerDeadline) await a2Pause();
    assert.equal(arrivals.blocker, 1, "the real blocker reviewer occupies the single reviewer slot");
    assert.equal(counts.creates, 1, "only the blocker SDK session exists");
    tool(2);
    const reserveDeadline = Date.now() + 20_000;
    let reserved = null;
    while (reserved === null && Date.now() < reserveDeadline) {
      reserved = (await journal()).find(record => record.event === "quality.action.receipt"
        && record.fields?.data?.state === "queued"
        && record.fields?.data?.errorCode === null
        && typeof record.fields?.data?.destinationRef === "string") ?? null;
      if (reserved === null) await a2Pause();
    }
    assert.ok(reserved, "the first cause reserved a bounded queued identity");
    const reservedRunId = reserved.fields.data.destinationRef;
    assert.equal((await journal()).some(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert"), false, "the target is not created before its first dispatch");
    assert.equal(arrivals.expert, 0, "the target never entered the provider while queued");
    await rm(join(agentDir, "quality", "material.md"), { force: true });
    tool(3);
    tool(4);
    const secondDeadline = Date.now() + 20_000;
    let second = null;
    while (second === null && Date.now() < secondDeadline) {
      second = (await journal()).filter(record => record.event === "quality.action.receipt"
        && record.fields?.data?.state === "queued"
        && record.fields?.data?.destinationRef === reservedRunId).slice(1)[0] ?? null;
      if (second === null) await a2Pause();
    }
    assert.ok(second, "the distinct current cause reuses the same truthful reserved identity");
    assert.equal(session.status(true).checks.pendingIntents >= 1, true, "the bounded pending request is retained while capacity is held");
    assert.equal(counts.creates, 1, "no target create while queued");
    latch.release();
    // Bounded wake window: give the ordinary wake path a fixed chance to dispatch.
    await a2Pause(3_000);
    assert.equal(arrivals.expert, 0, "missing required material never enters the provider");
    assert.equal(counts.transportsSettled, 1, "only the blocker transport settled; no paid target turn");
  } catch (error) {
    fixture.firstFailureRef.value = error;
    throw error;
  } finally {
    latch.release();
    try {
      await session.retire("fixture-a2-pending-complete");
      const drainDeadline = Date.now() + 5_000;
      while (counts.transportsActive !== 0 && Date.now() < drainDeadline) await a2Pause();
      assert.equal(counts.transportsActive, 0, "the actual held transports drained");
      assert.equal(session.status(true).runtime.state, "retired", "the engine owner retired");
    } catch (cleanupError) {
      console.error("K07-A2-PENDING-CLEANUP", String(cleanupError));
      throw new AggregateError([fixture.firstFailureRef.value, cleanupError].filter(Boolean), "pending control/cleanup failure; owned state retained");
    }
    if (fixture.firstFailureRef.value === null) await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K07-A2-required-set-over-bound: an over-cap required set never becomes a complete input", { timeout: 90_000 }, async () => {
  const fixture = await startA2Fixture({ expertCount: 1, suspicionCount: 1, materialMany: 33, expertTrigger: "none" });
  const { session, latch, arrivals, counts, agentDir } = fixture;
  const journal = () => readA2Journal(agentDir);
  try {
    a2Work(fixture);
    const tool = serial => {
      const at = new Date().toISOString();
      session.handlePrimaryEvent({ type: "tool-started", operationId: `a2ob-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
      session.handlePrimaryEvent({ type: "tool-completed", operationId: `a2ob-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
    };
    tool(1);
    // The declared required set exceeds the canonical assembly capacity; the
    // engine must not dispatch, must not claim a complete input, and must not
    // silently relabel the omitted tail as current.
    await a2Pause(4_000);
    assert.equal(arrivals.expert, 0, "an over-cap required set never enters the provider");
    assert.equal(counts.creates, 0, "no paid target session is created for an over-cap set");
    const rows = await journal();
    const expertStarted = rows.filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert");
    assert.equal(expertStarted.length <= 1, true, "at most one target run was admitted for the cause");
    const canonicalComplete = rows.some(record => record.event === "quality.check.settled"
      && record.fields?.data?.operational === "completed"
      && record.fields?.data?.terminalReason === "evaluated"
      && record.fields?.data?.findingCount !== undefined);
    assert.equal(canonicalComplete, false, "the over-cap input is never reported as a complete evaluated check");
  } catch (error) {
    fixture.firstFailureRef.value = error;
    throw error;
  } finally {
    latch.release();
    try {
      await session.retire("fixture-a2-over-bound-complete");
      assert.equal(session.status(true).runtime.state, "retired", "the engine owner retired");
    } catch (cleanupError) {
      console.error("K07-A2-OVER-CLEANUP", String(cleanupError));
      throw new AggregateError([fixture.firstFailureRef.value, cleanupError].filter(Boolean), "over-bound control/cleanup failure; owned state retained");
    }
    if (fixture.firstFailureRef.value === null) await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K07-B.03/B.04: the fixture policy really proposes one bounded action and the C1 recovery defaults parse", async () => {
  // The policy module is exercised through the child in runWindow; here the C1
  // recovery settings are validated through the real configuration parser.
  const root = await mkdtemp(join(tmpdir(), "qe-k07-cfg-"));
  try {
    const agentDir = join(root, "agent");
    const projectConfigDir = join(root, "project", ".pi");
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    const invalid = { ...config(), runtime: { ...config().runtime, restore: "replay-all" } };
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(invalid), "utf8");
    const session = await EngineSession.start({
      observedSessionId: `sess-k07-cfg-${process.pid}`,
      branchId: "unresolved",
      agentDir,
      projectConfigDir,
      projectTrusted: true,
      hostVersion: "1.1.0",
      hostMode: "rpc",
      resourcesDir: RESOURCES_DIR,
      hostIdleAtStart: true,
    });
    try {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
      const status = session.status(true);
      assert.equal(status.configuration.rejection?.errorCode, "config.capability-unavailable", "an unimplemented replay mode is refused");
      assert.equal(status.configuration.rejection?.field, "$.runtime.restore");
    } finally {
      await session.retire("fixture-complete");
    }
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(config()), "utf8");
    const valid = await EngineSession.start({
      observedSessionId: `sess-k07-cfg2-${process.pid}`,
      branchId: "unresolved",
      agentDir,
      projectConfigDir,
      projectTrusted: true,
      hostVersion: "1.1.0",
      hostMode: "rpc",
      resourcesDir: RESOURCES_DIR,
      hostIdleAtStart: true,
    });
    try {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
      assert.equal(valid.status(true).configuration.rejection, null, "the reconcile-only recovery default applies");
      assert.equal(valid.status(true).configuration.enabled, true);
    } finally {
      await valid.retire("fixture-complete");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

// K07-B.04–B.07/T.09/X.02: the original attempt keeps its genuine run identity,
// original generation, known branch, captured route and price across a real fresh
// child and a label remap (shared tariff), and a late settlement is priced at the
// original P_A although the current tariff is P_B.
function projectCurrentFinancial(financial) {
  return {
    attempts: [...financial.attempts].sort((left, right) => String(left.attemptId).localeCompare(String(right.attemptId))).map(entry => ({
      attemptId: entry.attemptId, purpose: entry.purpose, profileId: entry.profileId,
      originRunId: entry.originRunId ?? null, originGeneration: entry.originGeneration ?? null,
      branchRef: entry.branchRef ?? null,
      requestedRoute: entry.requestedRoute === null || entry.requestedRoute === undefined ? null : { provider: entry.requestedRoute.provider ?? null, model: entry.requestedRoute.model ?? null, revision: entry.requestedRoute.revision ?? null },
      actualRoute: entry.actualRoute === null || entry.actualRoute === undefined ? null : { provider: entry.actualRoute.provider ?? null, model: entry.actualRoute.model ?? null, revision: entry.actualRoute.revision ?? null },
      price: entry.price ?? null,
      state: entry.state === "dispatched" ? "unresolved" : entry.state,
      usageRevision: entry.usageRevision, totalTokens: entry.totalTokens ?? null,
      usageCoverage: entry.usageCoverage, costCurrency: entry.costCurrency ?? null, costAmount: entry.costAmount ?? null,
      reservedTokens: Number(entry.reservedTokens ?? 0), reservedCostAmount: entry.reservedCostAmount ?? null, reservedCostCurrency: entry.reservedCostCurrency ?? null,
    })),
    ownedRequestCount: financial.ownedRequestCount, ledgerRevision: financial.ledgerRevision,
    reservedTokens: Number(financial.reservedTokens),
    reservedCostByCurrency: financial.reservedCostByCurrency, knownCostByCurrency: financial.knownCostByCurrency,
    unresolvedCount: financial.unresolvedCount,
    aggregate: financial.aggregate ?? null,
  };
}

// These three B fixtures share one real-operation deadline, including cleanup.
// A timed-out Promise stays counted until it actually returns; never refund it.
function bFixtureBudget() {
  const startedAt = Date.now();
  const deadline = startedAt + 85_000; // Leave 5s below node:test's hard 90s cap.
  const workDeadline = deadline - 10_000;
  let pending = 0;
  const within = async (operation, cleanup = false) => {
    const remaining = (cleanup ? deadline : workDeadline) - Date.now();
    if (remaining <= 0) throw new Error("B fixture absolute deadline exhausted");
    const actual = Promise.resolve().then(operation);
    pending += 1;
    actual.then(() => { pending -= 1; }, () => { pending -= 1; });
    let timer;
    try {
      return await Promise.race([actual, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("B fixture operation exceeded absolute deadline")), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  return {
    startedAt, deadline, workDeadline,
    phase: ms => Math.min(workDeadline, Date.now() + ms),
    work: operation => within(operation),
    cleanup: operation => within(operation, true),
    get pending() { return pending; },
  };
}

async function finishBFixture({ budget, root, evidenceRoot, firstFailure, release, released = () => 0, sessions, active, returned, child = null, injectCleanupError = false }) {
  const errors = [];
  const attempt = async operation => {
    try { await budget.cleanup(operation); } catch (error) { errors.push(error); }
  };
  release?.();
  if (child && !child.close) {
    // Only this exact handle is ours. A healthy child is never killed for coverage.
    if (child.handle.exitCode === null && child.handle.signalCode === null) child.handle.kill("SIGKILL");
    await attempt(() => child.closed);
  }
  for (const session of sessions) if (session) await attempt(() => session.retire("fixture-complete"));
  while (active() !== 0 && Date.now() < budget.deadline) {
    await attempt(() => new Promise(resolvePromise => setTimeout(resolvePromise, 10)));
  }
  if (active() !== 0) errors.push(new Error("owned raw transport did not actually drain"));
  if (budget.pending !== 0) errors.push(new Error(`${budget.pending} actual fixture operations remain unresolved`));
  if (child && (!child.close || child.error)) errors.push(child.error ?? new Error("owned child has no native close"));
  if (injectCleanupError) errors.push(new Error("injected-cleanup-failure"));
  const errorText = error => String(error?.message ?? error).slice(0, 512);
  const outputText = bytes => {
    let text = bytes.toString("utf8");
    while (Buffer.byteLength(text, "utf8") > 2048) text = text.slice(0, -1);
    return text;
  };
  const outcome = {
    phase: "operations-finished-before-scratch-disposal", root, evidenceRoot,
    firstFailure: firstFailure === null ? null : errorText(firstFailure),
    cleanupErrors: errors.map(errorText), active: active(), returned: returned(), pending: budget.pending, releaseCount: released(),
    startedAt: budget.startedAt, deadline: budget.deadline, finishedAt: Date.now(),
    child: child ? { pid: child.handle.pid, exit: child.exit, close: child.close, cleanup: child.cleanup ?? null,
      stdout: outputText(child.stdout), stderr: outputText(child.stderr),
      stdoutBytes: child.stdout.length, stderrBytes: child.stderr.length,
      stdoutEnded: child.handle.stdout.readableEnded, stderrEnded: child.handle.stderr.readableEnded } : null,
    scratchRetained: existsSync(root),
  };
  const serialized = JSON.stringify(outcome);
  if (Buffer.byteLength(serialized, "utf8") > 32_768) errors.push(new Error("fixture cleanup evidence exceeds its byte bound"));
  else await attempt(() => writeFile(join(evidenceRoot, "cleanup.json"), serialized, { encoding: "utf8", flag: "wx" }));
  outcome.finishedAt = Date.now();
  if (firstFailure !== null || errors.length > 0) {
    const message = firstFailure === null ? "B fixture cleanup failed after a successful body" : "B fixture body failed; original error retained";
    const failure = new AggregateError(firstFailure === null ? errors : [firstFailure, ...errors], `${message}: ${errors.map(errorText).join("; ")}`, { cause: firstFailure ?? undefined });
    Object.assign(failure, { fixtureOutcome: outcome, root, evidenceRoot });
    throw failure;
  }
  // Only after real close/return and retained evidence, with no known error.
  await budget.cleanup(() => rm(root, { recursive: true, force: true }));
  outcome.finishedAt = Date.now();
  return outcome;
}

async function runOriginOwningCase({ injectCleanupError = false } = {}) {
  const budget = bFixtureBudget();
  const root = await budget.work(() => (mkdtemp(join(tmpdir(), "qe-k07-origin-"))));
  const evidenceRoot = await budget.work(() => (mkdtemp(join(resolve(process.env.QE_EVIDENCE_DIR ?? tmpdir()), "B-origin-"))));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-origin-${process.pid}-${Date.now()}`;
  const priceA = { currency: "USD", revision: "price-A", inputPerMillion: "0.20", outputPerMillion: "0.80", cacheReadPerMillion: "0.02", cacheWritePerMillion: "0" };
  const baseConfig = () => ({
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { maxConcurrentEvaluations: 2, maxRetiredUnsettledOperations: 1, restore: "reconcile-only", boundaryWaitMs: 0, defaultRunTimeoutMs: 30_000 },
    modelProfiles: {
      "route-a": { provider: "fixture-a", model: "a-1", maxAttempts: 1, price: { ...priceA } },
      "route-b": { provider: "fixture-b", model: "b-1", maxAttempts: 1, price: { ...priceA } },
      "route-alias": { provider: "fixture-a", model: "a-1", maxAttempts: 1, price: { ...priceA } },
    },
    permissions: { modelProfiles: ["route-a", "route-b", "route-alias"] },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: {
      "chat-a": { use: "core.chat", modelProfile: "route-a", options: {} },
      "chat-b": { use: "core.chat", modelProfile: "route-b", options: {} },
      "chat-alias": { use: "core.chat", modelProfile: "route-alias", options: {} },
    },
    policies: { record: { use: "core.record-only" } },
    checks: {
      "route-a": { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-a", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      "route-b": { enabled: false, triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-b", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      "route-alias": { enabled: false, triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-alias", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  });
  const writeConfig = async (value) => {
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(value), "utf8");
  };
  let release = null;
  const latch = new Promise(resolvePromise => { release = resolvePromise; });
  const state = { aEntered: 0, aReturned: 0, aActive: 0, bEntered: 0, cEntered: 0 };
  const noFinding = () => ({
    operational: "completed",
    coverage: { state: "complete", scopeDescription: "route witness", issues: [] },
    conclusion: "no-supported-finding",
    findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
  });
  const port = {
    findChat: (provider) => ({ provider, model: provider === "fixture-a" ? "a-1" : provider === "fixture-c" ? "c-1" : "b-1" }),
    findClassifier: () => null,
    hasConfiguredAuth: () => true,
    async completeChat(model) {
      const provider = typeof model?.["provider"] === "string" ? model["provider"] : "";
      if (provider === "fixture-a") {
        state.aEntered += 1;
        state.aActive += 1;
        try {
          await latch;
          state.aReturned += 1;
        } finally {
          state.aActive -= 1;
        }
      } else if (provider === "fixture-c") {
        state.cEntered += 1;
      } else {
        state.bEntered += 1;
      }
      return { text: JSON.stringify(noFinding()), model: { provider, id: provider === "fixture-a" ? "a-1" : provider === "fixture-c" ? "c-1" : "b-1", revision: null }, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, totalTokens: 110 }, stopReason: "stop", errorCode: null };
    },
    async classify() { throw new Error("unused"); },
  };
  const physicalState = new SessionPhysicalState();
  const base = {
    observedSessionId: sessionId, branchId: "b-origin-branch", agentDir, projectConfigDir, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
  };
  let sessionA = null;
  let sessionC = null;
  const settle = async (ms = 25) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  const drive = (instance, serial) => {
    const at = new Date().toISOString();
    instance.handlePrimaryEvent({ type: "operator-input", text: `origin work ${serial}`, source: "interactive", occurredAt: at });
    instance.handlePrimaryEvent({ type: "tool-started", operationId: `og-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
    instance.handlePrimaryEvent({ type: "tool-completed", operationId: `og-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
  };
  let firstFailure = null;
  let releasedOnce = false;
  let releaseCount = 0;
  let child = null;
  const releaseOnce = () => { if (!releasedOnce) { releasedOnce = true; releaseCount += 1; release(); } };
  try {
  await budget.work(() => (mkdir(join(agentDir, "quality"), { recursive: true })));
  await budget.work(() => (mkdir(projectConfigDir, { recursive: true })));
    await budget.work(() => (writeConfig(baseConfig())));
    sessionA = await budget.work(() => (EngineSession.start({ ...base, modelRegistry: port, physicalState })));
    const ready = budget.phase(10_000);
    while (sessionA.status(true).checks.active < 1 && Date.now() < ready) await budget.work(() => (settle()));
    drive(sessionA, "a");
    const enteredDeadline = budget.phase(20_000);
    while (state.aEntered === 0 && Date.now() < enteredDeadline) await budget.work(() => (settle()));
    assert.equal(state.aEntered, 1, "the genuine R_A transport is entered once");
    assert.equal(state.aActive, 1, "R_A is physically active");
    const started = (await budget.work(() => (readA2Journal(agentDir)))).find(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "route-a");
    const startedRunId = started?.fields?.correlation?.["runId"] ?? null;
    const startedGeneration = started?.fields?.scope?.runtimeGeneration ?? null;
    assert.equal(typeof startedRunId, "string", "the engine-issued run identity is captured");
    assert.equal(typeof startedGeneration, "string", "the engine-issued original generation is captured");
    const before = await budget.work(() => (protectedCheckpoint(agentDir, sessionId)));
    assert.ok(before !== null, "the protected checkpoint is readable");
    const rowA = before.attempts.find(entry => entry.state === "dispatched" || entry.state === "unresolved") ?? null;
    assert.ok(rowA, "A's attempt row exists");
    const originalAttemptId = rowA.attemptId;
    assert.equal(rowA.originRunId, startedRunId, "the row keeps the actual original run identity");
    assert.equal(rowA.originGeneration, startedGeneration, "the row keeps the actual original generation");
    assert.equal(rowA.branchRef, "b-origin-branch", "the row keeps the known non-placeholder branch");
    assert.equal(JSON.stringify(rowA.actualRoute ?? null).includes("fixture-a"), true, "the row keeps the actual captured route R_A");
    assert.equal(JSON.stringify(rowA).includes("0.20") && JSON.stringify(rowA).includes("0.80"), true, "the row keeps the captured original P_A tariff");
    assert.equal(rowA.totalTokens, null, "the held attempt has no usage");
    assert.equal(rowA.usageRevision, 0, "the held attempt has no usage revision");
    assert.equal(Number(rowA.reservedTokens) > 0, true, "the held attempt keeps a real nonzero reservation");
    await budget.work(() => (sessionA.retire("replaced")));
    assert.equal(state.aActive, 1, "the raw R_A transport stays physically active after logical retirement");
    // Real fresh child: a genuinely separate process reopens the actual checkpoint.
    const childEnv = Object.fromEntries(["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "TMPDIR", "PI_AGENT_DIR", "PI_CODING_AGENT_DIR", "GIT_CEILING_DIRECTORIES", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
    const handle = spawn(process.execPath, [CHILD, root, "known-origin", sessionId], {
      cwd: REPO,
      env: { ...childEnv, QE_K07_REPO: REPO, QE_K07_FIXTURE_DEADLINE: String(budget.deadline), QE_K07_FIXTURE_WORK_DEADLINE: String(budget.workDeadline) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child = { handle, exit: null, close: null, error: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
    child.exited = new Promise(resolvePromise => {
      handle.once("exit", (code, signal) => { child.exit = { code, signal }; resolvePromise(child.exit); });
      handle.once("error", error => { child.error = error; resolvePromise({ code: null, signal: null }); });
    });
    child.closed = new Promise(resolvePromise => handle.once("close", (code, signal) => { child.close = { code, signal }; resolvePromise(child.close); }));
    for (const stream of ["stdout", "stderr"]) handle[stream].on("data", chunk => {
      const remaining = 2048 - child[stream].length;
      if (remaining > 0) child[stream] = Buffer.concat([child[stream], Buffer.from(chunk).subarray(0, remaining)]);
    });
    const childResult = await budget.work(() => (child.exited));
    await budget.work(() => (child.closed));
    assert.equal(child.error, null, "the real child spawned without error");
    assert.equal(childResult.code, 0, "the fresh known-origin child exited natively");
    assert.equal(child.close.code, 0, "the child's actual native close/pipes completed");
    const childReceipt = JSON.parse(await budget.work(() => (readFile(join(root, "child-origin-receipt.json"), "utf8"))));
    const childCleanup = JSON.parse(await budget.work(() => readFile(join(root, "child-origin-cleanup.json"), "utf8")));
    assert.equal(childCleanup.exitCode, 0, "the child's actual retirement returned successfully");
    assert.equal(childCleanup.pending, 0, "the child has no unresolved actual operations");
    assert.equal(childCleanup.deadline, budget.deadline, "the child inherited this exact absolute deadline");
    assert.ok(childCleanup.finishedAt <= budget.deadline, "actual child retirement fits the case budget");
    child.cleanup = childCleanup;
    assert.notEqual(childReceipt.generation, startedGeneration, "the receiving child generation is genuinely different");
    assert.equal(childReceipt.target.attemptId, originalAttemptId, "the child sees the same actual attempt identity");
    assert.equal(childReceipt.target.originRunId, startedRunId, "the child keeps the original run identity");
    assert.equal(childReceipt.target.originGeneration, startedGeneration, "the child keeps the original generation, not its own");
    assert.equal(childReceipt.target.branchRef, "b-origin-branch", "the child keeps the known branch");
    assert.equal(JSON.stringify(childReceipt.target.actualRoute ?? null).includes("fixture-a"), true, "the child keeps the original captured route");
    assert.equal(childReceipt.target.totalTokens, null, "the child keeps the unresolved usage");
    assert.equal(Number(childReceipt.target.reservedTokens) > 0, true, "the child keeps the retained reservation");
    assert.equal(childReceipt.arrivalCount, 0, "the child launched no model transport");
    assert.equal(childReceipt.denialReasons.includes("core.retired-unsettled-limit"), true, `the child's useful R_A work is denied by the retired bound (${childReceipt.denialReasons.join(",")})`);
    // Generation C: same physical state; the same label is remapped to R_B while
    // both routes still share P_A; a differently named alias selects the old R_A.
    const remap = baseConfig();
    remap.modelProfiles["route-a"] = { provider: "fixture-b", model: "b-1", maxAttempts: 1, price: { ...priceA } };
    remap.checks["route-a"].enabled = true;
    remap.checks["route-alias"].enabled = true;
    await budget.work(() => (writeConfig(remap)));
    sessionC = await budget.work(() => (EngineSession.start({ ...base, branchId: "unresolved", modelRegistry: port, physicalState })));
    const readyC = budget.phase(10_000);
    while (sessionC.status(true).checks.active < 2 && Date.now() < readyC) await budget.work(() => (settle()));
    assert.equal((await budget.work(() => (sessionC.reloadConfiguration()))).ok, true, "the remap configuration reload is accepted");
    await budget.work(() => (settle(200)));
    const aEnteredBeforeRemap = state.aEntered;
    const bEnteredBeforeRemap = state.bEntered;
    drive(sessionC, "c-remap");
    const remapDeadline = budget.phase(20_000);
    while (state.bEntered === bEnteredBeforeRemap && Date.now() < remapDeadline) await budget.work(() => (settle()));
    assert.equal(state.aEntered, aEnteredBeforeRemap, "the alias to the old R_A reaches no provider");
    const aliasDenied = (await budget.work(() => (readA2Journal(agentDir))))
      .filter(record => record.event === "quality.check.admission" && record.fields?.data?.checkId === "route-alias" && record.fields?.data?.outcome === "denied")
      .flatMap(record => record.fields?.data?.reasonCodes ?? []);
    assert.equal(aliasDenied.some(code => code === "core.retired-unsettled-limit" || code === "core.unsettled-operation-limit"), true, `the old R_A is denied by the unsettled bound (${aliasDenied.join(",") || "nothing"})`);
    assert.equal(state.bEntered, bEnteredBeforeRemap + 1, "the remapped R_B enters exactly once despite sharing the old label and tariff");
    assert.equal(state.aActive, 1, "A remains physically active throughout the remap phase");
    const remapSettled = (await budget.work(() => (protectedCheckpoint(agentDir, sessionId))))?.attempts.find(entry => entry.attemptId !== originalAttemptId && entry.state === "settled" && entry.usageRevision >= 1) ?? null;
    assert.ok(remapSettled, "the remapped R_B request settled");
    assert.equal(remapSettled.costAmount, "0.000028", "the remapped request shares the original P_A tariff");
    const remapAttemptId = remapSettled.attemptId;
    // Late A: switch the current tariff to a genuinely different P_B, disable the
    // paid checks so retained causes cannot auto-launch, then release A once.
    const priceBConfig = baseConfig();
    priceBConfig.modelProfiles["route-a"] = { provider: "fixture-b", model: "b-1", maxAttempts: 1, price: { currency: "USD", revision: "price-B", inputPerMillion: "0.50", outputPerMillion: "2.00", cacheReadPerMillion: "0.05", cacheWritePerMillion: "0" } };
    priceBConfig.checks["route-a"].enabled = false;
    priceBConfig.checks["route-alias"].enabled = false;
    await budget.work(() => (writeConfig(priceBConfig)));
    assert.equal((await budget.work(() => (sessionC.reloadConfiguration()))).ok, true, "the P_B tariff reload is accepted");
    await budget.work(() => (settle(200)));
    const currentPre = await budget.work(() => (protectedCheckpoint(agentDir, sessionId)));
    assert.ok(currentPre, "the current pre-settlement image is readable");
    assert.equal(currentPre.attempts.length, 2, "the current pre image carries the two real attempt identities");
    const currentPreWire = JSON.stringify(currentPre.financial);
    await budget.work(() => (writeFile(join(evidenceRoot, "current-pre-financial.json"), currentPreWire, { encoding: "utf8", flag: "wx" })));
    releaseOnce();
    const returnedDeadline = budget.phase(20_000);
    while ((state.aReturned === 0 || state.aActive !== 0) && Date.now() < returnedDeadline) await budget.work(() => (settle()));
    assert.equal(state.aReturned, 1, "the raw R_A transport returned exactly once");
    assert.equal(state.aActive, 0, "the raw R_A transport is physically drained");
    const settledDeadline = budget.phase(20_000);
    let rowSettled = null;
    let currentPost = null;
    while (rowSettled === null && Date.now() < settledDeadline) {
      const after = await budget.work(() => (protectedCheckpoint(agentDir, sessionId)));
      rowSettled = after?.attempts.find(entry => entry.attemptId === originalAttemptId && entry.state === "settled" && entry.usageRevision >= 1) ?? null;
      if (rowSettled !== null) currentPost = after;
      if (rowSettled === null) await budget.work(() => (settle()));
    }
    assert.ok(currentPost, "the successful late-A disk read is captured before any feed/new request");
    const currentPostWire = JSON.stringify(currentPost.financial);
    await budget.work(() => (writeFile(join(evidenceRoot, "current-post-financial.json"), currentPostWire, { encoding: "utf8", flag: "wx" })));
    assert.ok(rowSettled, "the original attempt settled in the current owner's protected checkpoint");
    assert.equal(rowSettled.totalTokens, 110, "the actual raw usage is recorded");
    assert.equal(rowSettled.costAmount, "0.000028", "late A is priced at the original P_A (100x0.20 + 10x0.80 per million)");
    assert.equal(JSON.stringify(rowSettled).includes("0.00007"), false, "late A is not repriced at the current P_B");
    assert.equal(rowSettled.originRunId, startedRunId, "settlement keeps the original run identity");
    assert.equal(rowSettled.originGeneration, startedGeneration, "settlement keeps the original generation");
    assert.equal(rowSettled.branchRef, "b-origin-branch", "settlement keeps the known branch");
    {
      const pre = parseFinancialSnapshot(JSON.parse(currentPreWire));
      const post = parseFinancialSnapshot(JSON.parse(currentPostWire));
      assert.ok(pre && post, "the current wires parse through the owning checkpoint parser");
      assert.deepEqual(pre.attempts.map(entry => entry.attemptId).sort(), post.attempts.map(entry => entry.attemptId).sort(), "both current wires keep the same two real attempt identities");
      const providerBeforeReplay = state.aEntered + state.bEntered + state.cEntered;
      const replay = new ModelService({
        profiles: {}, approved: [], registry: port,
        budget: { maxRequestsPerSession: 200, maxOwnedTokensPerSession: 400_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
      });
      try {
        assert.equal(replay.restore(pre), 2, "the current pre wire applies its two real rows");
        const preSnap = replay.financialSnapshot();
        assert.deepEqual(projectCurrentFinancial(preSnap), projectCurrentFinancial(pre), "the receiver's current pre projection equals the genuine wire");
        assert.equal(replay.restore(pre), 0, "an identical current pre replay applies nothing");
        assert.deepEqual(replay.financialSnapshot(), preSnap, "an identical current pre replay does not alter receiver state");
        assert.equal(replay.restore(post), 1, "the current post wire advances exactly the late row");
        const postSnap = replay.financialSnapshot();
        assert.deepEqual(projectCurrentFinancial(postSnap), projectCurrentFinancial(post), "the receiver's current post projection equals the genuine wire");
        assert.equal(Number(postSnap.reservedTokens), 0, "the genuine current post wire carries no aggregate reservation");
        assert.equal(replay.restore(post), 0, "an identical current post replay applies nothing");
        assert.deepEqual(replay.financialSnapshot(), postSnap, "an identical current post replay does not alter receiver state");
        assert.equal(replay.restore(JSON.parse(JSON.stringify(postSnap))), 0, "the owner's own reprojection applies nothing");
        assert.equal(replay.restore(pre), 0, "a stale current pre wire applies nothing");
        assert.deepEqual(replay.financialSnapshot(), postSnap, "stale current replay cannot resurrect a reservation or alter accounting");
        assert.equal(state.aEntered + state.bEntered + state.cEntered, providerBeforeReplay, "no current replay dispatched a provider request");
      } finally {
        if (typeof replay.disposeFeed === "function") replay.disposeFeed();
      }
    }
    // One explicitly new fitting current request at the current P_B.
    const finalConfig = baseConfig();
    finalConfig.permissions.modelProfiles.push("route-c");
    finalConfig.modelProfiles["route-c"] = { provider: "fixture-c", model: "c-1", maxAttempts: 1, price: { currency: "USD", revision: "price-B", inputPerMillion: "0.50", outputPerMillion: "2.00", cacheReadPerMillion: "0.05", cacheWritePerMillion: "0" } };
    finalConfig.evaluators["chat-c"] = { use: "core.chat", modelProfile: "route-c", options: {} };
    finalConfig.checks["route-c"] = { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-c", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] };
    finalConfig.checks["route-a"].enabled = false;
    finalConfig.checks["route-b"].enabled = false;
    await budget.work(() => (writeConfig(finalConfig)));
    assert.equal((await budget.work(() => (sessionC.reloadConfiguration()))).ok, true, "the new current request configuration is accepted");
    await budget.work(() => (settle(200)));
    drive(sessionC, "c-new");
    const newDeadline = budget.phase(20_000);
    while (state.cEntered === 0 && Date.now() < newDeadline) await budget.work(() => (settle()));
    console.error("K07-ORIGIN-C-RUN", JSON.stringify((await budget.work(() => (readA2Journal(agentDir)))).filter(record => (record.fields?.data?.checkId === "route-c" || String(record.fields?.data?.terminalReason ?? "").length > 0 || String(record.event).startsWith("quality.model")) && (record.fields?.scope?.runtimeGeneration !== undefined)).map(record => ({ e: record.event, d: record.fields?.data ?? null, c: record.fields?.correlation ?? null })).slice(-14)));
    console.error("K07-ORIGIN-C-DIAG", JSON.stringify({ checks: sessionC.status(true).checks, admissions: (await budget.work(() => (readA2Journal(agentDir)))).filter(record => record.event === "quality.check.admission").map(record => [record.fields?.data?.checkId, record.fields?.data?.outcome, record.fields?.data?.reasonCodes]).slice(-8), aActive: state.aActive }));
    assert.equal(state.cEntered, 1, "the new current request enters exactly once");
    const newSettleDeadline = budget.phase(20_000);
    let newRow = null;
    while (newRow === null && Date.now() < newSettleDeadline) {
      const after = await budget.work(() => (protectedCheckpoint(agentDir, sessionId)));
      newRow = after?.attempts.find(entry => entry.attemptId !== originalAttemptId && entry.attemptId !== remapAttemptId && entry.state === "settled" && entry.usageRevision >= 1) ?? null;
      if (newRow === null) await budget.work(() => (settle()));
    }
    assert.ok(newRow, "the new current request settled with its own attempt identity");
    assert.notEqual(newRow.attemptId, originalAttemptId, "the new request has a distinct actual attempt ID");
    assert.notEqual(newRow.attemptId, remapAttemptId, "the new request is distinct from the remap request");
    assert.equal(newRow.costAmount, "0.00007", "the new request is priced at the current P_B");
    const aAfter = (await budget.work(() => (protectedCheckpoint(agentDir, sessionId))))?.attempts.find(entry => entry.attemptId === originalAttemptId) ?? null;
    assert.equal(aAfter?.costAmount, "0.000028", "A's charge is not repriced by the new request");
    assert.equal(aAfter?.originGeneration, startedGeneration, "A's original generation is unchanged by the new request");
  } catch (error) {
    firstFailure = error;
  } finally {
    const outcome = await finishBFixture({ budget, root, evidenceRoot, firstFailure, release: releaseOnce, released: () => releaseCount,
      sessions: [sessionA, sessionC], active: () => state.aActive, returned: () => state.aReturned, child, injectCleanupError });
    assert.equal(releaseCount, 1, "the owned latch was actually released once");
    assert.equal(outcome.pending, 0, "all actual awaited operations returned before completion");
    return outcome;
  }
}

test("K07-B04-origin: original origin/branch/route survive a fresh child and a shared-tariff remap, and late A keeps P_A", { timeout: 90_000 }, async () => {
  const outcome = await runOriginOwningCase();
  assert.equal(outcome.active, 0);
  assert.equal(outcome.pending, 0);
  assert.equal(outcome.releaseCount, 1);
  assert.equal(outcome.child.close.code, 0);
  assert.equal(outcome.child.stdoutEnded && outcome.child.stderrEnded, true);
  assert.ok(outcome.finishedAt <= outcome.deadline, "actual closure fits the shared absolute budget");
});

test("K07-B04-origin-cleanup-error: the owning helper rejects a cleanup-only failure", { timeout: 90_000 }, async () => {
  let thrown = null;
  try {
    await runOriginOwningCase({ injectCleanupError: true });
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown, "the real owning case rejects a cleanup-only failure instead of passing");
  assert.equal(String(thrown?.message ?? "").includes("cleanup failed after a successful body"), true, "the failure reports the cleanup-only cause");
  assert.equal(String(thrown?.message ?? "").includes("injected-cleanup-failure"), true, "the recorded cleanup error is retained");
  const outcome = thrown.fixtureOutcome;
  assert.equal(outcome.firstFailure, null, "the useful body passed; cleanup alone caused rejection");
  assert.equal(outcome.active, 0);
  assert.equal(outcome.pending, 0);
  assert.equal(outcome.releaseCount, 1);
  assert.equal(outcome.child.close.code, 0);
  assert.equal(outcome.child.stdoutEnded && outcome.child.stderrEnded, true);
  assert.ok(outcome.finishedAt <= outcome.deadline, "real fault-path completion fits the same absolute budget");
  assert.ok(existsSync(thrown.root), "failed scratch is retained after the actual helper rejects");
});

// K07-B.04/B.07 (Astra279 §2): the authentic pre-/post-settlement financial
// snapshots of a genuine held attempt are replayed through the real public
// ModelService restore path. Identical, reprojected and stale serialized copies
// must be idempotent and must not resurrect a reservation, duplicate a charge or
// replace the original origin with receiver context.
test("K07-B04-origin-replay: authentic pre/post restore and serialized replay are idempotent", { timeout: 90_000 }, async () => {
  const budget = bFixtureBudget();
  const root = await budget.work(() => (mkdtemp(join(tmpdir(), "qe-k07-replay-"))));
  const evidenceRoot = await budget.work(() => (mkdtemp(join(resolve(process.env.QE_EVIDENCE_DIR ?? tmpdir()), "B-replay-"))));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-replay-${process.pid}-${Date.now()}`;
  const priceA = { currency: "USD", revision: "price-A", inputPerMillion: "0.20", outputPerMillion: "0.80", cacheReadPerMillion: "0.02", cacheWritePerMillion: "0" };
  const priceB = { currency: "USD", revision: "price-B", inputPerMillion: "0.50", outputPerMillion: "2.00", cacheReadPerMillion: "0.05", cacheWritePerMillion: "0" };
  const configFor = (price, enabled) => ({
    schemaVersion: 1, enabled: true, mode: "advise",
    runtime: { maxConcurrentEvaluations: 2, maxRetiredUnsettledOperations: 1, restore: "reconcile-only", boundaryWaitMs: 0, defaultRunTimeoutMs: 30_000 },
    modelProfiles: { "route-a": { provider: "fixture-a", model: "a-1", maxAttempts: 1, price: { ...price } } },
    permissions: { modelProfiles: ["route-a"] },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { "chat-a": { use: "core.chat", modelProfile: "route-a", options: {} } },
    policies: { record: { use: "core.record-only" } },
    checks: { "route-a": { enabled, triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-a", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
    observability: {},
  });
  let release = null;
  const latch = new Promise(resolvePromise => { release = resolvePromise; });
  const state = { entered: 0, active: 0, returned: 0 };
  const noFinding = {
    operational: "completed",
    coverage: { state: "complete", scopeDescription: "replay witness", issues: [] },
    conclusion: "no-supported-finding",
    findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
  };
  const port = {
    findChat: (provider) => ({ provider, model: provider === "fixture-a" ? "a-1" : "b-1" }),
    findClassifier: () => null,
    hasConfiguredAuth: () => true,
    async completeChat(model) {
      const provider = typeof model?.["provider"] === "string" ? model["provider"] : "";
      state.entered += 1;
      state.active += 1;
      try {
        await latch;
        state.returned += 1;
      } finally {
        state.active -= 1;
      }
      return { text: JSON.stringify(noFinding), model: { provider, id: "a-1", revision: null }, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, totalTokens: 110 }, stopReason: "stop", errorCode: null };
    },
    async classify() { throw new Error("unused"); },
  };
  let session = null;
  const settle = async (ms = 25) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  let firstFailure = null;
  let releasedOnce = false;
  let releaseCount = 0;
  const releaseOnce = () => { if (!releasedOnce) { releasedOnce = true; releaseCount += 1; release(); } };
  try {
  await budget.work(() => (mkdir(join(agentDir, "quality"), { recursive: true })));
  await budget.work(() => (mkdir(projectConfigDir, { recursive: true })));
  await budget.work(() => (writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configFor(priceA, true)), "utf8")));
    session = await budget.work(() => (EngineSession.start({
    observedSessionId: sessionId, branchId: "b-replay-branch", agentDir, projectConfigDir, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
    modelRegistry: port,
  })));
    const ready = budget.phase(15_000);
    while (session.status(true).checks.active < 1 && Date.now() < ready) await budget.work(() => (settle()));
    const at = new Date().toISOString();
    session.handlePrimaryEvent({ type: "operator-input", text: "replay work", source: "interactive", occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-started", operationId: "rp-1", toolName: "read", parentOperationId: null, occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: "rp-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
    const enteredDeadline = budget.phase(20_000);
    while (state.entered === 0 && Date.now() < enteredDeadline) await budget.work(() => (settle()));
    assert.equal(state.entered, 1, "the genuine R_A transport is entered once");
    assert.equal(state.active, 1, "R_A is physically active before the pre snapshot");
    const preRead = await budget.work(() => (protectedCheckpoint(agentDir, sessionId)));
    assert.ok(preRead, "the pre-settlement protected checkpoint is readable");
    const preWire = JSON.stringify(preRead.financial);
    const preRow = preRead.attempts[0];
    const originalAttemptId = preRow.attemptId;
    const originalRunId = preRow.originRunId;
    const originalGeneration = preRow.originGeneration;
    assert.equal(preRow.usageRevision, 0, "the pre image has no usage revision");
    assert.equal(preRow.totalTokens, null, "the pre image has no usage");
    assert.equal(Number(preRow.reservedTokens) > 0, true, "the pre image keeps a real reservation");
    assert.equal(JSON.stringify(preRow).includes("0.20") && JSON.stringify(preRow).includes("0.80"), true, "the pre image keeps the captured P_A");
    // Switch the current tariff to P_B and disable the paid check, then settle A.
    await budget.work(() => (writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configFor(priceB, false)), "utf8")));
    assert.equal((await budget.work(() => (session.reloadConfiguration()))).ok, true, "the P_B tariff reload is accepted");
    await budget.work(() => (settle(200)));
    releaseOnce();
    const returnedDeadline = budget.phase(20_000);
    while ((state.returned === 0 || state.active !== 0) && Date.now() < returnedDeadline) await budget.work(() => (settle()));
    assert.equal(state.returned, 1, "the genuine raw transport returned once");
    assert.equal(state.active, 0, "the genuine raw transport drained");
    const settleDeadline = budget.phase(20_000);
    let postRead = null;
    let postWire = null;
    while (postWire === null && Date.now() < settleDeadline) {
      const after = await budget.work(() => (protectedCheckpoint(agentDir, sessionId)));
      const row = after?.attempts.find(entry => entry.attemptId === originalAttemptId && entry.state === "settled" && entry.usageRevision >= 1) ?? null;
      if (row !== null && after !== null) {
        postRead = after;
        postWire = JSON.stringify(after.financial);
      }
      if (postWire === null) await budget.work(() => (settle()));
    }
    assert.ok(postRead && postWire, "the post-settlement financial snapshot was read disk-first");
    const postRow = postRead.attempts.find(entry => entry.attemptId === originalAttemptId);
    assert.equal(postRow.totalTokens, 110, "the post image records the actual usage");
    assert.equal(postRow.costAmount, "0.000028", "the post image keeps the original P_A charge");
    assert.equal(Number(postRow.reservedTokens), 0, "the post image released the row reservation");
    assert.equal(postRow.costAmount === "0.00007", false, "the settled row is not repriced at the current P_B");
    assert.equal(postRow.originRunId, originalRunId, "the post image keeps the original run identity");
    assert.equal(postRow.originGeneration, originalGeneration, "the post image keeps the original generation");
    assert.equal(postRead.financial.ownedRequestCount, 1, "the post image owns exactly one request");
    assert.equal(Number(postRead.financial.reservedTokens), 0, "the post image has no aggregate token reservation");
    // Authentic snapshots are preserved under the author root before replaying.
    await budget.work(() => (writeFile(join(evidenceRoot, "origin-pre-financial.json"), preWire, { encoding: "utf8", flag: "wx" })));
    await budget.work(() => (writeFile(join(evidenceRoot, "origin-post-financial.json"), postWire, { encoding: "utf8", flag: "wx" })));
    const decode = wire => {
      const value = parseFinancialSnapshot(JSON.parse(wire));
      assert.ok(value, "the actual serialized financial snapshot parses");
      return value;
    };
    const project = financial => ({
      attempts: [...financial.attempts].sort((left, right) => String(left.attemptId).localeCompare(String(right.attemptId))).map(entry => ({
        attemptId: entry.attemptId, purpose: entry.purpose, profileId: entry.profileId,
        originRunId: entry.originRunId ?? null, originGeneration: entry.originGeneration ?? null,
        branchRef: entry.branchRef ?? null,
        requestedRoute: entry.requestedRoute === null || entry.requestedRoute === undefined ? null : { provider: entry.requestedRoute.provider ?? null, model: entry.requestedRoute.model ?? null, revision: entry.requestedRoute.revision ?? null },
        actualRoute: entry.actualRoute === null || entry.actualRoute === undefined ? null : { provider: entry.actualRoute.provider ?? null, model: entry.actualRoute.model ?? null, revision: entry.actualRoute.revision ?? null },
        price: entry.price ?? null,
        state: entry.state === "dispatched" ? "unresolved" : entry.state, usageRevision: entry.usageRevision, totalTokens: entry.totalTokens ?? null,
        usageCoverage: entry.usageCoverage, costCurrency: entry.costCurrency ?? null, costAmount: entry.costAmount ?? null,
        reservedTokens: Number(entry.reservedTokens ?? 0), reservedCostAmount: entry.reservedCostAmount ?? null,
      })),
      ownedRequestCount: financial.ownedRequestCount, ledgerRevision: financial.ledgerRevision,
      reservedTokens: Number(financial.reservedTokens),
      reservedCostByCurrency: financial.reservedCostByCurrency, knownCostByCurrency: financial.knownCostByCurrency,
      unresolvedCount: financial.attempts.filter(entry => entry.state === "unresolved" || entry.state === "dispatched").length,
    });
    const entriesBeforeReplay = state.entered;
    const replay = new ModelService({
      profiles: {}, approved: [], registry: port,
      budget: { maxRequestsPerSession: 200, maxOwnedTokensPerSession: 400_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
    });
    try {
      assert.equal(replay.restore(decode(preWire)), 1, "the genuine pre image applies its one real row");
      const pre = replay.financialSnapshot();
      { const a = project(pre); const b = project(decode(preWire)); assert.deepEqual(a, b, "the receiver pre projection equals the genuine pre snapshot: " + JSON.stringify([a.attempts, b.attempts])); }
      assert.equal(replay.restore(decode(preWire)), 0, "an identical pre replay applies nothing");
      assert.deepEqual(replay.financialSnapshot(), pre, "an identical pre replay does not alter receiver state");
      assert.equal(replay.restore(decode(postWire)), 1, "the genuine post image advances the settled row once");
      const post = replay.financialSnapshot();
      assert.deepEqual(project(post), project(decode(postWire)), "the receiver's post projection equals the genuine post snapshot");
      assert.equal(replay.restore(decode(postWire)), 0, "an identical post replay applies nothing");
      assert.deepEqual(replay.financialSnapshot(), post, "an identical post replay does not alter receiver state");
      const projectedWire = JSON.stringify(post);
      assert.equal(replay.restore(decode(projectedWire)), 0, "the receiver's own reprojection applies nothing");
      assert.deepEqual(replay.financialSnapshot(), post, "reprojection does not alter receiver state");
      assert.equal(replay.restore(decode(preWire)), 0, "a stale pre image cannot replace the newer revision");
      assert.deepEqual(replay.financialSnapshot(), post, "stale replay cannot resurrect a reservation or alter accounting/origin");
      assert.equal(state.entered, entriesBeforeReplay, "no restore dispatched a provider request");
    } finally {
      if (typeof replay.disposeFeed === "function") replay.disposeFeed();
    }
  } catch (error) {
    firstFailure = error;
  } finally {
    await finishBFixture({ budget, root, evidenceRoot, firstFailure, release: releaseOnce, released: () => releaseCount, sessions: [session], active: () => state.active, returned: () => state.returned });
  }
});

// K07-B.04 (Sol282): the genuine connected equal-ledger oracle. The two actual
// snapshots come from a real A -> fresh child -> C -> shared-tariff B -> late A
// run; both carry ledgerRevision 4 and the same two attempt identities. The
// stale pre copy must not resurrect the aggregate reservation after late A.
test("K07-B04-origin-replay-connected: equal-ledger connected pre/post replay reconciles aggregates", { timeout: 90_000 }, async () => {
  const evidenceRoot = resolve("verification/K07/author/implementation-20261017-223/continuation-after-239/qualification/attempt-29");
  const preWire = await readFile(join(evidenceRoot, "connected-pre-financial.json"), "utf8");
  const postWire = await readFile(join(evidenceRoot, "connected-post-financial.json"), "utf8");
  const decode = wire => {
    const value = parseFinancialSnapshot(JSON.parse(wire));
    assert.ok(value, "the genuine connected financial snapshot parses");
    return value;
  };
  const pre = decode(preWire);
  const post = decode(postWire);
  assert.equal(pre.ledgerRevision, 4, "the genuine pre image carries ledger revision 4");
  assert.equal(post.ledgerRevision, 4, "the genuine post image carries ledger revision 4");
  assert.equal(pre.attempts.length, 2, "the genuine pre image carries exactly two attempts");
  assert.equal(post.attempts.length, 2, "the genuine post image carries exactly two attempts");
  const ids = list => list.map(entry => entry.attemptId).sort();
  assert.deepEqual(ids(pre.attempts), ids(post.attempts), "both images keep the same two actual attempt identities");
  const project = financial => ({
    attempts: [...financial.attempts].sort((left, right) => String(left.attemptId).localeCompare(String(right.attemptId))).map(entry => ({
      attemptId: entry.attemptId, purpose: entry.purpose, profileId: entry.profileId,
      originRunId: entry.originRunId ?? null, originGeneration: entry.originGeneration ?? null,
      branchRef: entry.branchRef ?? null,
      requestedRoute: entry.requestedRoute === null || entry.requestedRoute === undefined ? null : { provider: entry.requestedRoute.provider ?? null, model: entry.requestedRoute.model ?? null, revision: entry.requestedRoute.revision ?? null },
      actualRoute: entry.actualRoute === null || entry.actualRoute === undefined ? null : { provider: entry.actualRoute.provider ?? null, model: entry.actualRoute.model ?? null, revision: entry.actualRoute.revision ?? null },
      price: entry.price ?? null,
      state: entry.state, usageRevision: entry.usageRevision, totalTokens: entry.totalTokens ?? null,
      usageCoverage: entry.usageCoverage, costCurrency: entry.costCurrency ?? null, costAmount: entry.costAmount ?? null,
      reservedTokens: Number(entry.reservedTokens ?? 0), reservedCostAmount: entry.reservedCostAmount ?? null, reservedCostCurrency: entry.reservedCostCurrency ?? null,
    })),
    ownedRequestCount: financial.ownedRequestCount, ledgerRevision: financial.ledgerRevision,
    reservedTokens: Number(financial.reservedTokens),
    reservedCostByCurrency: financial.reservedCostByCurrency, knownCostByCurrency: financial.knownCostByCurrency,
    unresolvedCount: financial.attempts.filter(entry => entry.state === "unresolved" || entry.state === "dispatched").length,
    aggregate: financial.aggregate ?? null,
  });
  let dispatched = 0;
  const port = {
    findChat: () => { throw new Error("replay must not resolve a route"); },
    findClassifier: () => null,
    hasConfiguredAuth: () => true,
    async completeChat() { dispatched += 1; throw new Error("replay must not dispatch"); },
    async classify() { throw new Error("replay must not classify"); },
  };
  const replay = new ModelService({
    profiles: {}, approved: [], registry: port,
    budget: { maxRequestsPerSession: 200, maxOwnedTokensPerSession: 400_000, unknownCost: "allow-with-token-limits", maxOwnedCost: null },
  });
  try {
    assert.equal(replay.restore(decode(preWire)), 2, "the genuine connected pre image applies its two real rows");
    const preSnap = replay.financialSnapshot();
    assert.deepEqual(project(preSnap), project(pre), "the receiver's connected pre projection equals the genuine pre image");
    assert.equal(Number(preSnap.reservedTokens), 4480, "the pre image honestly reserves the held operation");
    assert.equal(replay.restore(decode(preWire)), 0, "an identical connected pre replay applies nothing");
    assert.deepEqual(replay.financialSnapshot(), preSnap, "an identical connected pre replay does not alter receiver state");
    assert.equal(replay.restore(decode(postWire)), 1, "the genuine connected post image advances exactly the late row");
    const postSnap = replay.financialSnapshot();
    assert.deepEqual(project(postSnap), project(post), "the receiver's connected post projection equals the genuine post image");
    assert.equal(Number(postSnap.reservedTokens), 0, "the settled post image carries no aggregate reservation");
    assert.equal(replay.restore(decode(postWire)), 0, "an identical connected post replay applies nothing");
    assert.deepEqual(replay.financialSnapshot(), postSnap, "an identical connected post replay does not alter receiver state");
    assert.equal(replay.restore(decode(JSON.stringify(postSnap))), 0, "the owner's own reprojection applies nothing");
    assert.deepEqual(replay.financialSnapshot(), postSnap, "reprojection does not alter receiver state");
    assert.equal(replay.restore(decode(preWire)), 0, "a stale equal-ledger pre image applies nothing");
    assert.deepEqual(replay.financialSnapshot(), postSnap, "stale equal-ledger replay cannot resurrect a reservation or alter accounting");
    assert.equal(Number(replay.financialSnapshot().reservedTokens), 0, "the aggregate reservation stays released");
    assert.equal(dispatched, 0, "no restore dispatched a provider request");
  } finally {
    if (typeof replay.disposeFeed === "function") replay.disposeFeed();
  }
});

// Atomic proposal refusal, NOT accepted revocation: an evaluator referencing an
// unapproved profile cannot pass configuration acceptance. The prior accepted
// configuration/grant and its P_B charge remain unchanged (Sol287 adjudication).
test("K07-B04-origin-current-grant: removing the current grant cannot dispatch or spend", { timeout: 90_000 }, async () => {
  const budget = bFixtureBudget();
  const root = await budget.work(() => (mkdtemp(join(tmpdir(), "qe-k07-grant-"))));
  const evidenceRoot = await budget.work(() => (mkdtemp(join(resolve(process.env.QE_EVIDENCE_DIR ?? tmpdir()), "B-grant-"))));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-grant-${process.pid}-${Date.now()}`;
  const priceB = { currency: "USD", revision: "price-B", inputPerMillion: "0.50", outputPerMillion: "2.00", cacheReadPerMillion: "0.05", cacheWritePerMillion: "0" };
  const configFor = (granted) => ({
    schemaVersion: 1, enabled: true, mode: "advise",
    runtime: { maxConcurrentEvaluations: 2, maxRetiredUnsettledOperations: 1, restore: "reconcile-only", boundaryWaitMs: 0, defaultRunTimeoutMs: 30_000 },
    modelProfiles: { "route-c": { provider: "fixture-c", model: "c-1", maxAttempts: 1, price: { ...priceB } }, "route-unused": { provider: "fixture-c", model: "c-1", maxAttempts: 1, price: { ...priceB } } },
    permissions: { modelProfiles: granted ? ["route-c", "route-unused"] : ["route-unused"] },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { "chat-c": { use: "core.chat", modelProfile: "route-c", options: {} } },
    policies: { record: { use: "core.record-only" } },
    checks: { "route-c": { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-c", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
    observability: {},
  });
  let entered = 0;
  let rawActive = 0;
  let rawReturned = 0;
  const noFinding = { operational: "completed", coverage: { state: "complete", scopeDescription: "grant witness", issues: [] }, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };
  const port = {
    findChat: (provider) => ({ provider, model: provider === "fixture-c" ? "c-1" : "b-1" }),
    findClassifier: () => null, hasConfiguredAuth: () => true,
    async completeChat(model) {
      entered += 1;
      rawActive += 1;
      try {
        const provider = typeof model?.["provider"] === "string" ? model["provider"] : "";
        return { text: JSON.stringify(noFinding), model: { provider, id: "c-1", revision: null }, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, totalTokens: 110 }, stopReason: "stop", errorCode: null };
      } finally { rawReturned += 1; rawActive -= 1; }
    },
    async classify() { throw new Error("unused"); },
  };
  let session = null;
  const settle = async (ms = 25) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  const drive = serial => {
    const at = new Date().toISOString();
    session.handlePrimaryEvent({ type: "operator-input", text: `grant work ${serial}`, source: "interactive", occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-started", operationId: `gr-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: `gr-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
  };
  let firstFailure = null;
  try {
  await budget.work(() => (mkdir(join(agentDir, "quality"), { recursive: true })));
  await budget.work(() => (mkdir(projectConfigDir, { recursive: true })));
  await budget.work(() => (writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configFor(true)), "utf8")));
    session = await budget.work(() => (EngineSession.start({ observedSessionId: sessionId, branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true, hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true, modelRegistry: port })));
    const ready = budget.phase(15_000);
    while (session.status(true).checks.active < 1 && Date.now() < ready) await budget.work(() => (settle()));
    drive(1);
    const enteredDeadline = budget.phase(20_000);
    while (entered === 0 && Date.now() < enteredDeadline) await budget.work(() => (settle()));
    assert.equal(entered, 1, "the accepted route-c/P_B positive enters exactly once");
    const settledDeadline = budget.phase(20_000);
    let settledRow = null;
    while (settledRow === null && Date.now() < settledDeadline) {
      const checkpoint = await budget.work(() => (protectedCheckpoint(agentDir, sessionId)));
      settledRow = checkpoint?.attempts.find(entry => entry.state === "settled" && entry.usageRevision >= 1) ?? null;
      if (settledRow === null) await budget.work(() => (settle()));
    }
    assert.ok(settledRow, "the accepted positive settled with its current price");
    assert.equal(settledRow.costAmount, "0.00007", "the positive is priced at the current P_B");
    const before = await budget.work(() => (protectedCheckpoint(agentDir, sessionId)));
    const attemptsBefore = before?.attempts.length ?? 0;
    const ownedBefore = before?.financial.ownedRequestCount ?? 0;
    const enteredBefore = entered;
    await budget.work(() => (writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configFor(false)), "utf8")));
    const reloaded = await budget.work(() => (session.reloadConfiguration()));
    assert.equal(reloaded.ok, false, "the unapproved reference cannot pass configuration acceptance");
    assert.equal(reloaded.errorCode, "config.capability-unavailable", "the refusal is the exact capability code");
    assert.equal(entered, enteredBefore, "no provider entry occurs");
    const after = await budget.work(() => (protectedCheckpoint(agentDir, sessionId)));
    assert.equal(after?.attempts.length, attemptsBefore, "no financial attempt row is created");
    assert.equal(after?.financial.ownedRequestCount, ownedBefore, "the owned request count does not increase");
    const previous = after?.attempts.find(entry => entry.attemptId === settledRow.attemptId);
    assert.equal(previous?.costAmount, "0.00007", "the accepted positive keeps its current charge");
    assert.equal(previous?.price?.revision, "price-B", "the accepted positive keeps its current captured price");
  } catch (error) {
    firstFailure = error;
  } finally {
    await finishBFixture({ budget, root, evidenceRoot, firstFailure, sessions: [session], active: () => rawActive, returned: () => rawReturned });
  }
});

// K07-B04 (Sol284 §3): one controlled failure at the owning fixture boundary must
// keep the original assertion, drain the owned raw transport and retain scratch.
