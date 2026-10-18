// K07 core escalation: one ordinary admitted `core.request-check` child run with
// causal root/parent/depth identity, bounded depth and per-episode allowance.
//
// Engine-level owner fixture: the real runtime, scheduler, policy and action
// path with a registered deterministic evaluator. The native expert pair is
// separate evidence (test/k07-host.test.mjs).

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { EngineSession } from "../src/runtime.js";
import type { EngineClock } from "../src/scheduling.js";
import type { EngineSessionInput } from "../src/runtime.js";
import type { EvaluatorDefinition } from "../src/contracts.js";

const RESOURCES_DIR = join(process.cwd(), "resources");

/** Deterministic clock: fires due timers in time order (adapted from loop.test). */
class ControlledClock implements EngineClock {
  #monoMs = 1_000;
  #timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];
  nowMonoMs(): number { return this.#monoMs; }
  nowUtc(): string { return new Date(this.#monoMs).toISOString(); }
  setTimer(delayMs: number, callback: () => void): () => void {
    const entry = { at: this.#monoMs + Math.max(0, delayMs), callback, cancelled: false };
    this.#timers.push(entry);
    return () => { entry.cancelled = true; };
  }
  advance(ms: number): void {
    const target = this.#monoMs + ms;
    for (;;) {
      const due = this.#timers.filter(timer => !timer.cancelled && timer.at <= target).sort((left, right) => left.at - right.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      this.#monoMs = due.at;
      due.callback();
    }
    this.#monoMs = target;
  }
}

/** Deterministic evaluator: one suspected (preliminary) finding per run. */
function suspectedEvaluator(): EvaluatorDefinition {
  return {
    id: "fixture.suspected",
    apiMajor: 1,
    kind: "evaluator",
    mechanism: "deterministic",
    accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.suspected-evidence"],
    evaluate: async (_options, input) => {
      const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
      return {
        operational: "completed",
        coverage: input.context.coverage,
        conclusion: items.length > 0 ? "findings" : "no-supported-finding",
        findings: items.map(item => ({
          id: `${input.run.runId}:finding-1`,
          criterion: input.assessment.criteria[0] ?? "efficiency.repetition",
          status: "suspected" as const,
          severity: "concern" as const,
          requirementRefs: [],
          evidenceIds: [item.id],
          affectedItems: [],
          defectCode: "fixture.suspected-drift",
          explanation: "preliminary suspicion over observed work",
          proposedCorrection: null,
          limitations: ["preliminary"],
        })),
        scores: [],
        additionalEvidence: [],
        dependencies: input.context.dependencies,
        usageAttemptIds: [],
      };
    },
  };
}

interface Fixture {
  root: string;
  agentDir: string;
  projectConfigDir: string;
  session: EngineSession;
}

async function withEscalationFixture(
  run: (fixture: Fixture) => Promise<void>,
  options: { maxEscalationDepth?: number; maxEscalationsPerEpisode?: number } = {},
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: {
      boundaryWaitMs: 0,
      maxFeedbackPerEpisode: 3,
      maxAutonomousFollowUpsPerEpisode: 1,
      maxEscalationsPerEpisode: options.maxEscalationsPerEpisode ?? 2,
      maxEscalationDepth: options.maxEscalationDepth ?? 1,
    },
    permissions: { actions: ["core.request-check"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: { suspected: { use: "fixture.suspected", options: {} } },
    policies: {
      engineering: { use: "core.engineering", options: { escalateTo: "expert" } },
      record: { use: "core.record-only" },
    },
    checks: {
      repetition: {
        triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }],
        context: "recent-work",
        prompt: "repetition",
        evaluator: "suspected",
        policy: "engineering",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
      },
      // The configured escalation target. It is an ordinary check with its own
      // evaluator/policy; the owner fixture only needs the admission identity.
      expert: {
        triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }],
        context: "recent-work",
        prompt: "repetition",
        evaluator: "suspected",
        policy: "record",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
      },
    },
    observability: {},
  }), "utf8");
  const session = await EngineSession.start({
    observedSessionId: `sess-k07-${process.pid}-${Date.now()}`,
    branchId: "unresolved",
    agentDir,
    projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: RESOURCES_DIR,
    hostIdleAtStart: true,
    feedbackHost: {
      capabilities: () => new Set<string>(),
      deliver: async request => ({ actionId: request.actionId, state: "rejected", destinationId: null, evidenceIds: [], error: { code: "core.feedback-unsupported", retryable: false } }),
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
  });
  try {
    const registered = session.endpoint.register({
      id: "fixture.suspected-package",
      version: "0.1.0",
      baseUri: "fixture:suspected",
      components: [suspectedEvaluator()],
      resources: {},
    });
    assert.equal(registered.ok, true);
    if (registered.ok) await registered.value.ready;
    await session.reloadConfiguration();
    await settle();
    await run({ root, agentDir, projectConfigDir, session });
  } finally {
    await session.retire("fixture-complete");
    await rm(root, { recursive: true, force: true });
  }
}

async function settle(): Promise<void> {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 40));
}

function work(fixture: Fixture): void {
  fixture.session.handlePrimaryEvent({
    type: "operator-input",
    text: `escalation work ${Date.now()}`,
    source: "interactive",
    occurredAt: new Date().toISOString(),
  });
}

function tool(fixture: Fixture, id: string): void {
  const occurredAt = new Date().toISOString();
  fixture.session.handlePrimaryEvent({ type: "tool-started", operationId: id, toolName: "read", parentOperationId: null, occurredAt });
  fixture.session.handlePrimaryEvent({ type: "tool-completed", operationId: id, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt });
}

async function drive(fixture: Fixture, prefix: string): Promise<void> {
  const before = fixture.session.status(true).checks.runs;
  tool(fixture, `${prefix}-0`);
  const deadline = Date.now() + 10_000;
  while (fixture.session.status(true).checks.runs <= before && Date.now() < deadline) await settle();
  await settle();
  await settle();
  const s = fixture.session.status(true);
  {
    const ev = s.diagnostics.recentEvents.filter(r => String(r.event).includes("action") || String(r.event).includes("policy"));
    console.error("K07-ADM", JSON.stringify(ev.map(r => [r.event, r.fields.data])));
  }
  if (s.checks.runs <= before) {
    console.error("K07-DBG", JSON.stringify({ checks: s.checks, events: s.diagnostics.recentEvents.map(r => r.event).slice(-12), rejection: s.configuration.rejection }));
  }
}

test("K07-A3: launch-limit reuse and denial with a held expert", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-a3-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  const baseConfig = {
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { boundaryWaitMs: 0, maxFeedbackPerEpisode: 3, maxAutonomousFollowUpsPerEpisode: 1, maxEscalationsPerEpisode: 1, maxEscalationDepth: 1, maxConcurrentEvaluations: 2 },
    permissions: { actions: ["core.request-check"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: { suspected: { use: "fixture.suspected", options: {} }, held: { use: "fixture.held", options: {} } },
    policies: {
      engineering: { use: "core.engineering", options: { escalateTo: "expert" } },
      engineering2: { use: "core.engineering", options: { escalateTo: "expert2" } },
      record: { use: "core.record-only" },
    },
    checks: {
      suspicion: { triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }], context: "recent-work", prompt: "repetition", evaluator: "suspected", policy: "engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      suspicion2: { enabled: false, triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }], context: "recent-work", prompt: "repetition", evaluator: "suspected", policy: "engineering2", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      expert: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }], context: "recent-work", prompt: "repetition", evaluator: "held", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      expert2: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }], context: "recent-work", prompt: "repetition", evaluator: "held", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  };
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(baseConfig), "utf8");
  const releaseRef: { current: (() => void) | null } = { current: null };
  const gate = new Promise<void>(resolvePromise => { releaseRef.current = () => resolvePromise(); });
  const entries: string[] = [];
  const suspected: EvaluatorDefinition = {
    id: "fixture.suspected", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.suspected-evidence"],
    evaluate: async (_options, input) => {
      const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
      const serial = input.run.runId.match(/\d+/u)?.[0] ?? "0";
      return {
        operational: "completed", coverage: input.context.coverage,
        conclusion: items.length > 0 ? "findings" : "no-supported-finding",
        findings: items.map(item => ({
          id: `${input.run.runId}:finding-1`, criterion: "efficiency.repetition", status: "suspected", severity: "concern",
          requirementRefs: [], evidenceIds: [item.id], affectedItems: [], defectCode: `fixture.suspected-drift-${serial}`,
          explanation: "preliminary suspicion", proposedCorrection: null, limitations: [],
        })),
        scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [],
      };
    },
  };
  const held: EvaluatorDefinition = {
    id: "fixture.held", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.held-evidence"],
    evaluate: async (_options, input) => {
      entries.push(input.run.checkId);
      await gate;
      return { operational: "completed", coverage: input.context.coverage, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [] };
    },
  };
  const session = await EngineSession.start({
    observedSessionId: `sess-k07-a3-${process.pid}-${Date.now()}`,
    branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
    feedbackHost: {
      capabilities: () => new Set<string>(),
      deliver: async request => ({ actionId: request.actionId, state: "rejected", destinationId: null, evidenceIds: [], error: { code: "core.feedback-unsupported", retryable: false } }),
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
  });
  const fixture: Fixture = { root, agentDir, projectConfigDir, session };
  try {
    const registered = session.endpoint.register({ id: "fixture.k07-a3", version: "0.1.0", baseUri: "fixture:a3", components: [suspected, held], resources: {} });
    assert.equal(registered.ok, true);
    if (registered.ok) await registered.value.ready;
    assert.equal((await session.reloadConfiguration()).ok, true);
    await settle();
    work(fixture);
    tool(fixture, "a3-1");
    const enteredDeadline = Date.now() + 15_000;
    while (entries.length === 0 && Date.now() < enteredDeadline) await settle();
    assert.deepEqual(entries, ["expert"], "the first distinct cause launched exactly one expert and it is held");
    // A genuinely distinct equivalent cause while the expert is held reuses it.
    tool(fixture, "a3-2");
    await settle(); await settle(); await settle();
    let journal = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    const receipts = journal.split(String.fromCharCode(10)).filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
      .filter(record => record.event === "quality.action.receipt")
      .map(record => record.fields?.data ?? {})
      .filter(entry => typeof entry.destinationRef === "string" && entry.destinationRef.startsWith("run-"));
    assert.equal(receipts.length >= 2, true, "both escalation requests produced receipts");
    assert.equal(new Set(receipts.map(entry => entry.destinationRef)).size, 1, "equivalent causes resolve to one immutable expert run");
    assert.deepEqual(entries, ["expert"], "the equivalent cause created no second expert launch or provider entry");
    // A launch to a genuinely different target at the spent limit is refused.
    const enabled2 = JSON.parse(JSON.stringify(baseConfig));
    enabled2.checks.suspicion2.enabled = true;
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(enabled2), "utf8");
    assert.equal((await session.reloadConfiguration()).ok, true);
    await settle();
    tool(fixture, "a3-3");
    await settle(); await settle(); await settle();
    let journal3 = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) journal3 += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    // The episode-limit refusal happens inside the admitted request operation and
    // is reported on its own receipt (not a second action admission).
    const actionRecords3 = journal3.split(String.fromCharCode(10)).filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const refusedReceipts = actionRecords3
      .filter(record => record.event === "quality.action.receipt")
      .map(record => record.fields?.data ?? {})
      .filter(entry => entry.state === "rejected");
    assert.equal(refusedReceipts.some(entry => entry.errorCode === "core.escalation-episode-limit"), true,
      `a genuinely new target at the spent limit is refused (${JSON.stringify(refusedReceipts.map(entry => entry.errorCode))})`);
    const rejectedAdmissions = actionRecords3
      .filter(record => record.event === "quality.action.admission")
      .map(record => record.fields?.data ?? {})
      .filter(entry => entry.outcome === "rejected")
      .flatMap(entry => (entry.reasonCodes as string[] | undefined) ?? []);
    assert.equal(rejectedAdmissions.length === 0 || rejectedAdmissions.includes("core.escalation-episode-limit"), true, "no unrelated admission failure explains the refusal");
    assert.deepEqual(entries, ["expert"], "the refused launch created no expert2 evaluator entry");
    // Release once: the held expert settles; no second launch follows.
    releaseRef.current?.();
    const settleDeadline = Date.now() + 15_000;
    let settledExpert = 0;
    while (settledExpert === 0 && Date.now() < settleDeadline) {
      settledExpert = session.status(true).diagnostics.recentEvents
        .filter(record => record.event === "quality.check.settled" && record.fields.correlation?.runId === receipts[0].destinationRef).length;
      await settle();
    }
    assert.equal(settledExpert >= 1, true, "the held expert settled exactly once after release");
    assert.deepEqual(entries, ["expert"], "no extra expert launch or provider entry after drain");
  } finally {
    releaseRef.current?.();
    await session.retire("fixture-complete");
    await rm(root, { recursive: true, force: true });
  }
});

test("K07-A4-pending-bytes: fitting multibyte pending metadata is retained while an overflowing cause is refused", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-bytes-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  const clock = new ControlledClock();
  const FIT_SENTINEL = "K07_PENDING_FIT_SENTINEL";
  const OVER_SENTINEL = "K07_PENDING_OVER_SENTINEL";
  const config = {
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { boundaryWaitMs: 0, maxFeedbackPerEpisode: 3, maxAutonomousFollowUpsPerEpisode: 1, maxEscalationsPerEpisode: 2, maxEscalationDepth: 1, maxConcurrentEvaluations: 2, maxPendingBytes: 1_024 },
    permissions: { actions: ["core.request-check"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: { quiet: { use: "fixture.quiet", options: {} } },
    policies: { fits: { use: "fixture.p-fits", options: {} }, over: { use: "fixture.p-over", options: {} }, record: { use: "core.record-only" } },
    checks: {
      fits: { triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }], context: "recent-work", prompt: "repetition", evaluator: "quiet", policy: "fits", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      over: { triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 2 } }], context: "recent-work", prompt: "repetition", evaluator: "quiet", policy: "over", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      expert: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 8_000, requireNewEvidence: false } }], context: "recent-work", prompt: "repetition", evaluator: "quiet", policy: "record", cooldownMs: 4_000, criteria: ["efficiency.repetition"] },
      expert2: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }], context: "recent-work", prompt: "repetition", evaluator: "quiet", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  };
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(config), "utf8");
  const expertRuns: Array<{ checkId: string; runId: string }> = [];
  const quiet: EvaluatorDefinition = {
    id: "fixture.quiet", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.quiet-evidence"],
    evaluate: async (_options, input) => {
      expertRuns.push({ checkId: input.run.checkId, runId: input.run.runId });
      return { operational: "completed", coverage: input.context.coverage, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [] };
    },
  };
  const policy = (id: string, checkId: string, hypothesis: string): any => ({
    id, apiMajor: 1, kind: "policy",
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: [`${id}-proposed`],
    decide: () => ({
      outcome: "propose",
      reasonCode: "supported-concern",
      actions: [{ localId: `${id}-1`, action: "core.request-check", options: { checkId, hypothesis }, findingIds: [], evidenceIds: [], reasonCode: `${id}-proposed` }],
    }),
  });
  const fitsPolicy = policy("fixture.p-fits", "expert", `${FIT_SENTINEL} ${"Ж".repeat(40)}`);
  const overPolicy = policy("fixture.p-over", "expert2", `${OVER_SENTINEL} ${"Ж".repeat(400)}`);
  const session = await EngineSession.start({
    observedSessionId: `sess-k07-bytes-${process.pid}-${Date.now()}`,
    branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
    clock,
    feedbackHost: {
      capabilities: () => new Set<string>(),
      deliver: async request => ({ actionId: request.actionId, state: "rejected", destinationId: null, evidenceIds: [], error: { code: "core.feedback-unsupported", retryable: false } }),
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
  });
  const fixture: Fixture = { root, agentDir, projectConfigDir, session };
  type JournalRecord = { event: string; fields?: { data?: Record<string, unknown>; correlation?: Record<string, unknown> } };
  const readJournal = async (): Promise<JournalRecord[]> => {
    let journal = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    return journal.split(String.fromCharCode(10)).filter(Boolean).map(line => {
      try { return JSON.parse(line) as JournalRecord; } catch { return null; }
    }).filter((record): record is JournalRecord => record !== null);
  };
  const pause = async (ms = 120) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  const receipts = (records: JournalRecord[]) => records
    .filter(record => record.event === "quality.action.receipt")
    .map(record => ({ data: record.fields?.data ?? {}, parentRunId: record.fields?.correlation?.["runId"] ?? null }));
  try {
    const registered = session.endpoint.register({ id: "fixture.k07-bytes", version: "0.1.0", baseUri: "fixture:bytes", components: [quiet, fitsPolicy, overPolicy], resources: {} });
    assert.equal(registered.ok, true);
    if (registered.ok) await registered.value.ready;
    assert.equal((await session.reloadConfiguration()).ok, true);
    await pause();
    work(fixture);
    // Warmup: the periodic expert actually enters and settles, arming the cooldown.
    clock.advance(8_000);
    const warmDeadline = Date.now() + 15_000;
    while (expertRuns.length === 0 && Date.now() < warmDeadline) await pause();
    const targetRuns = () => expertRuns.filter(run => run.checkId === "expert");
    assert.equal(targetRuns().length, 1, "the warmup expert entered");
    const warmAdmittedAt = clock.nowMonoMs();
    const warmSettleDeadline = Date.now() + 15_000;
    let warmSettled = false;
    while (!warmSettled && Date.now() < warmSettleDeadline) {
      warmSettled = (await readJournal()).some(record => record.event === "quality.check.settled" && record.fields?.correlation?.["runId"] === targetRuns()[0]?.runId);
      if (!warmSettled) await pause();
    }
    assert.equal(warmSettled, true, "the warmup expert settled");
    // First tool completion: the fitting multibyte cause reserves during the cooldown.
    tool(fixture, "b-1");
    const fitDeadline = Date.now() + 5_000;
    let fitReceipt = null;
    while (fitReceipt === null && Date.now() < fitDeadline) {
      fitReceipt = receipts(await readJournal()).find(entry => entry.data.state === "queued" && typeof entry.data.destinationRef === "string") ?? null;
      if (fitReceipt === null) await pause();
    }
    assert.ok(fitReceipt, "the fitting multibyte cause is retained and queued with its reservation");
    const reserved = fitReceipt.data.destinationRef as string;
    assert.equal(targetRuns().length, 1, "the fitting cause did not start early");
    // Second tool completion: the overflowing multibyte cause is refused explicitly.
    tool(fixture, "b-2");
    const overDeadline = Date.now() + 7_000;
    let overflow = null;
    while (overflow === null && Date.now() < overDeadline) {
      const all = await readJournal();
      overflow = receipts(all).find(entry => entry.data.state === "rejected" && entry.data.errorCode === "core.pending-metadata-overflow") ?? null;
      if (overflow === null) await pause();
    }
    assert.ok(overflow, "the overflowing pending metadata is refused explicitly");
    assert.equal(expertRuns.some(run => run.checkId === "expert2"), false, "the refused cause launched no expert2");
    // The refused cause's material is not retained anywhere in the journal.
    let journalText = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) journalText += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    assert.equal(journalText.includes(OVER_SENTINEL), false, "the overflowing hypothesis text is not retained in the journal");
    assert.equal(journalText.includes(FIT_SENTINEL), false, "no full hypothesis text is retained in the journal");
    // The fitting reservation still wakes and executes with the same identity.
    const remaining = warmAdmittedAt + 4_000 - clock.nowMonoMs();
    assert.equal(remaining > 0, true, "still before the cooldown deadline");
    clock.advance(Math.max(0, remaining) + 1);
    const startDeadline = Date.now() + 10_000;
    while (targetRuns().length < 2 && Date.now() < startDeadline) await pause();
    assert.equal(targetRuns().length, 2, "the retained fitting cause executed exactly once");
    assert.equal(targetRuns()[1]?.runId, reserved, "the started run identity is the retained reservation");
  } finally {
    await session.retire("fixture-complete");
    await rm(root, { recursive: true, force: true });
  }
});

test("K07-A3-queued: one fixed config queues a compatible reuse and wakes exactly the reserved run", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-queued-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  const clock = new ControlledClock();
  const config = {
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { boundaryWaitMs: 0, maxFeedbackPerEpisode: 3, maxAutonomousFollowUpsPerEpisode: 1, maxEscalationsPerEpisode: 1, maxEscalationDepth: 1, maxConcurrentEvaluations: 2 },
    permissions: { actions: ["core.request-check"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: { suspected: { use: "fixture.suspected", options: {} }, instant: { use: "fixture.instant", options: {} } },
    policies: {
      engineering: { use: "core.engineering", options: { escalateTo: "expert" } },
      engineering2: { use: "core.engineering", options: { escalateTo: "expert2" } },
      record: { use: "core.record-only" },
    },
    checks: {
      suspicion: { triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }], context: "recent-work", prompt: "repetition", evaluator: "suspected", policy: "engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      suspicion2: { triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 3 } }], context: "recent-work", prompt: "repetition", evaluator: "suspected", policy: "engineering2", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      expert: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 8_000, requireNewEvidence: false } }], context: "recent-work", prompt: "repetition", evaluator: "instant", policy: "record", cooldownMs: 4_000, criteria: ["efficiency.repetition"] },
      expert2: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }], context: "recent-work", prompt: "repetition", evaluator: "instant", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  };
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(config), "utf8");
  const expertRuns: Array<{ checkId: string; runId: string; parentRunId: string | null; depth: number }> = [];
  let serialCounter = 0;
  const suspected: EvaluatorDefinition = {
    id: "fixture.suspected", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.suspected-evidence"],
    evaluate: async (_options, input) => {
      const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
      const serial = (++serialCounter).toString();
      return {
        operational: "completed", coverage: input.context.coverage,
        conclusion: items.length > 0 ? "findings" : "no-supported-finding",
        findings: items.map(item => ({
          id: `${input.run.runId}:finding-1`, criterion: "efficiency.repetition", status: "suspected", severity: "concern",
          requirementRefs: [], evidenceIds: [item.id], affectedItems: [], defectCode: `fixture.suspected-queued-${serial}`,
          explanation: "preliminary suspicion", proposedCorrection: null, limitations: [],
        })),
        scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [],
      };
    },
  };
  const instant: EvaluatorDefinition = {
    id: "fixture.instant", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.instant-evidence"],
    evaluate: async (_options, input) => {
      expertRuns.push({ checkId: input.run.checkId, runId: input.run.runId, parentRunId: input.run.parentRunId, depth: input.run.escalationDepth });
      return { operational: "completed", coverage: input.context.coverage, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [] };
    },
  };
  const session = await EngineSession.start({
    observedSessionId: `sess-k07-queued-${process.pid}-${Date.now()}`,
    branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
    clock,
    feedbackHost: {
      capabilities: () => new Set<string>(),
      deliver: async request => ({ actionId: request.actionId, state: "rejected", destinationId: null, evidenceIds: [], error: { code: "core.feedback-unsupported", retryable: false } }),
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
  });
  const fixture: Fixture = { root, agentDir, projectConfigDir, session };
  type JournalRecord = { event: string; fields?: { data?: Record<string, unknown>; correlation?: Record<string, unknown> } };
  const readJournal = async (): Promise<JournalRecord[]> => {
    let journal = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    return journal.split(String.fromCharCode(10)).filter(Boolean).map(line => {
      try { return JSON.parse(line) as JournalRecord; } catch { return null; }
    }).filter((record): record is JournalRecord => record !== null);
  };
  const actionReceipts = (records: JournalRecord[]) => records
    .filter(record => record.event === "quality.action.receipt")
    .map(record => ({ data: record.fields?.data ?? {}, parentRunId: record.fields?.correlation?.["runId"] ?? null }));
  const pause = async (ms = 120) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  try {
    const registered = session.endpoint.register({ id: "fixture.k07-queued", version: "0.1.0", baseUri: "fixture:queued", components: [suspected, instant], resources: {} });
    assert.equal(registered.ok, true);
    if (registered.ok) await registered.value.ready;
    // One fixed configuration is used for the whole schedule (F3 approval reload
    // happens before any reservation; no reload after R is reserved).
    assert.equal((await session.reloadConfiguration()).ok, true);
    await pause();
    work(fixture);
    // Warmup: advance to the first real periodic deadline (8000 ms).
    clock.advance(8_000);
    const warmDeadline = Date.now() + 15_000;
    while (expertRuns.length === 0 && Date.now() < warmDeadline) await pause();
    assert.equal(expertRuns.length, 1, "the periodic warmup expert actually entered");
    const warmAdmittedAt = clock.nowMonoMs();
    // Wait for the warmup run's own settlement/drain before the queue phase.
    const warmSettleDeadline = Date.now() + 15_000;
    let warmSettled = false;
    while (!warmSettled && Date.now() < warmSettleDeadline) {
      warmSettled = (await readJournal()).some(record => record.event === "quality.check.settled" && record.fields?.correlation?.["runId"] === expertRuns[0]?.runId);
      if (!warmSettled) await pause();
    }
    assert.equal(warmSettled, true, "the warmup expert settled and drained");
    // The next periodic deadline is later than warmAdmittedAt + cooldown.
    assert.equal(warmAdmittedAt + 4_000 < warmAdmittedAt + 8_000, true);
    // New episode (operator input) but stable material/authority.
    work(fixture);
    // q-2: reserve the expert during the real cooldown (queued, no entry).
    const receiptsBeforeQueue = actionReceipts(await readJournal()).length;
    tool(fixture, "q-2");
    const q2Deadline = Date.now() + 5_000;
    let q2 = null;
    while (q2 === null && Date.now() < q2Deadline) {
      const records = await readJournal();
      q2 = actionReceipts(records).slice(receiptsBeforeQueue).find(entry => entry.data.destinationRef !== null && entry.data.destinationRef !== undefined) ?? null;
      if (q2 === null) await pause();
    }
    assert.ok(q2, "the first new-episode escalation produced its own receipt");
    const reserved = q2.data.destinationRef as string;
    assert.match(reserved, /^run-/u);
    assert.equal(expertRuns.length, 1, "no target entry appears while the reservation is cooling down");
    const q2Admission = (await readJournal()).some(record => record.event === "quality.check.admission"
      && Array.isArray(record.fields?.data?.reasonCodes)
      && (record.fields?.data?.reasonCodes as string[]).includes("core.cooldown"));
    assert.equal(q2Admission, true, "the reservation was queued by the real cooldown");
    // q-3: a distinct owned cause with equivalent required material/window must
    // obtain a second distinct successful receipt naming the same reservation.
    tool(fixture, "q-3");
    const q3Deadline = Date.now() + 5_000;
    let q3Receipts: Array<{ data: Record<string, unknown>; parentRunId: unknown }> = [];
    while (Date.now() < q3Deadline) {
      const records = await readJournal();
      q3Receipts = actionReceipts(records)
        .filter(entry => entry.data.state === "queued" && entry.data.destinationRef === reserved && entry.parentRunId !== q2.parentRunId);
      if (q3Receipts.length > 0) break;
      await pause();
    }
    const q3FailedReason = actionReceipts(await readJournal())
      .filter(entry => entry.parentRunId !== q2.parentRunId && entry.data.state === "rejected")
      .map(entry => entry.data.errorCode);
    assert.equal(q3Receipts.length, 1, `a second distinct cause reuses the same reservation (rejections: ${JSON.stringify(q3FailedReason)})`);
    assert.equal(expertRuns.length, 1, "the compatible reuse created no extra launch or target entry");
    // q-4: the third tool completion triggers suspicion2; its own new-target
    // attempt must be refused by the spent episode limit.
    tool(fixture, "q-4");
    const q4Deadline = Date.now() + 7_000;
    let q4Refusal: Array<{ data: Record<string, unknown>; parentRunId: unknown }> = [];
    while (Date.now() < q4Deadline) {
      const records = await readJournal();
      const suspicion2Starts = records.filter(record => record.event === "quality.check.started"
        && record.fields?.data?.checkId === "suspicion2"
        && record.fields?.correlation?.["runId"] !== q2.parentRunId
        && record.fields?.correlation?.["runId"] !== (q3Receipts[0]?.parentRunId ?? null));
      const suspicion2RunId = suspicion2Starts[suspicion2Starts.length - 1]?.fields?.correlation?.["runId"] ?? null;
      q4Refusal = actionReceipts(records).filter(entry => entry.data.state === "rejected"
        && entry.data.errorCode === "core.escalation-episode-limit"
        && suspicion2RunId !== null && entry.parentRunId === suspicion2RunId);
      if (q4Refusal.length > 0) break;
      await pause();
    }
    assert.equal(q4Refusal.length, 1, "the new-target attempt is refused by the spent episode limit, joined to its own parent");
    assert.equal(expertRuns.some(run => run.checkId === "expert2"), false, "the refused target never executed");
    // Just before the cooldown deadline the reserved run has not entered.
    const now = clock.nowMonoMs();
    const remaining = warmAdmittedAt + 4_000 - now;
    assert.equal(remaining > 0, true, "the schedule still lies before the cooldown deadline");
    clock.advance(remaining - 1);
    await pause(250);
    assert.equal(expertRuns.length, 1, "the reserved run does not start early");
    // Through the armed deadline: the ordinary wake starts exactly the reserved run.
    clock.advance(1);
    const startDeadline = Date.now() + 10_000;
    while (expertRuns.length < 2 && Date.now() < startDeadline) await pause();
    assert.equal(expertRuns.length, 2, "the ordinary wake started exactly the reserved child");
    assert.equal(expertRuns[1]?.runId, reserved, "the started run identity is the queued reservation");
    assert.equal(expertRuns[1]?.checkId, "expert");
    const childSettleDeadline = Date.now() + 10_000;
    let childSettled = false;
    while (!childSettled && Date.now() < childSettleDeadline) {
      childSettled = (await readJournal()).some(record => record.event === "quality.check.settled"
        && record.fields?.correlation?.["runId"] === reserved
        && record.fields?.data?.operational === "completed");
      if (!childSettled) await pause();
    }
    assert.equal(childSettled, true, "the reserved child reached its accepted settlement exactly once");
    // Drain due work without crossing the next independent periodic interval.
    assert.equal(clock.nowMonoMs() < warmAdmittedAt + 8_000, true, "the schedule stayed inside the next periodic interval");
  } finally {
    await session.retire("fixture-complete");
    await rm(root, { recursive: true, force: true });
  }
});

test("K07-A3-depth: a real dynamic depth-2 proposal is denied while the depth-1 child executes", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-depth-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  const baseConfig = {
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { boundaryWaitMs: 0, maxEscalationsPerEpisode: 4, maxEscalationDepth: 1, maxConcurrentEvaluations: 2 },
    permissions: { actions: ["core.request-check"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: { suspected: { use: "fixture.suspected", options: {} }, instant: { use: "fixture.instant", options: {} } },
    policies: {
      engineering: { use: "core.engineering", options: { escalateTo: "expert" } },
      engineering3: { use: "core.engineering", options: { escalateTo: "expert3" } },
      record: { use: "core.record-only" },
    },
    checks: {
      suspicion: { triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }], context: "recent-work", prompt: "repetition", evaluator: "suspected", policy: "engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      expert: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }], context: "recent-work", prompt: "repetition", evaluator: "suspected", policy: "engineering3", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      expert3: { triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }], context: "recent-work", prompt: "repetition", evaluator: "instant", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  };
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(baseConfig), "utf8");
  const depthEntries: string[] = [];
  const suspected: EvaluatorDefinition = {
    id: "fixture.suspected", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.suspected-depth"],
    evaluate: async (_options, input) => {
      depthEntries.push(input.run.checkId);
      const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
      const serial = input.run.runId.match(/\d+/u)?.[0] ?? "0";
      return {
        operational: "completed", coverage: input.context.coverage,
        conclusion: items.length > 0 ? "findings" : "no-supported-finding",
        findings: items.map(item => ({
          id: `${input.run.runId}:finding-1`, criterion: "efficiency.repetition", status: "suspected", severity: "concern",
          requirementRefs: [], evidenceIds: [item.id], affectedItems: [], defectCode: `fixture.suspected-depth-${serial}`,
          explanation: "preliminary suspicion", proposedCorrection: null, limitations: [],
        })),
        scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [],
      };
    },
  };
  const instant: EvaluatorDefinition = {
    id: "fixture.instant", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.instant-depth"],
    evaluate: async (_options, input) => {
      depthEntries.push(input.run.checkId);
      return { operational: "completed", coverage: input.context.coverage, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [] };
    },
  };
  const session = await EngineSession.start({
    observedSessionId: `sess-k07-depth-${process.pid}-${Date.now()}`,
    branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
    feedbackHost: {
      capabilities: () => new Set<string>(),
      deliver: async request => ({ actionId: request.actionId, state: "rejected", destinationId: null, evidenceIds: [], error: { code: "core.feedback-unsupported", retryable: false } }),
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
  });
  const fixture: Fixture = { root, agentDir, projectConfigDir, session };
  try {
    const registered = session.endpoint.register({ id: "fixture.k07-depth", version: "0.1.0", baseUri: "fixture:depth", components: [suspected, instant], resources: {} });
    assert.equal(registered.ok, true);
    if (registered.ok) await registered.value.ready;
    assert.equal((await session.reloadConfiguration()).ok, true);
    await settle();
    work(fixture);
    tool(fixture, "d-1");
    const deadline = Date.now() + 15_000;
    while (!depthEntries.includes("expert3") && depthEntries.length < 2 && Date.now() < deadline) await settle();
    await settle(); await settle();
    assert.equal(depthEntries.includes("expert"), true, "the depth-1 expert actually executed");
    assert.equal(depthEntries.includes("expert3"), false, "the dynamic depth-2 child never executed");
    let journal = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    const records = journal.split(String.fromCharCode(10)).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const refused = records.filter(record => record.event === "quality.action.receipt")
      .map(record => record.fields?.data ?? {})
      .filter(entry => entry.state === "rejected");
    assert.equal(refused.some(entry => entry.errorCode === "core.escalation-depth-limit"), true,
      `the depth-2 request is refused by the depth limit (${JSON.stringify(refused.map(entry => entry.errorCode))})`);
    await session.retire("fixture-complete");
    // Static configuration table: missing target and a configured cycle are
    // rejected at apply; a valid acyclic chain is accepted.
    const writeConfig = async (patch: (config: Record<string, any>) => void) => {
      const config = JSON.parse(JSON.stringify(baseConfig));
      patch(config);
      await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(config), "utf8");
    };
    await writeConfig(config => { config.policies.engineering.options.escalateTo = "missing-check"; });
    const missing = await EngineSession.start({ observedSessionId: `sess-k07-depth-missing-${Date.now()}`, branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true, hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    assert.equal(missing.status(true).configuration.rejection?.errorCode, "config.unresolved-reference", "a missing configured target is rejected at apply");
    await missing.retire("fixture-complete");
    await writeConfig(config => {
      config.policies.engineering4 = { use: "core.engineering", options: { escalateTo: "expert" } };
      config.checks.expert3.policy = "engineering4";
    });
    const cyclic = await EngineSession.start({ observedSessionId: `sess-k07-depth-cycle-${Date.now()}`, branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true, hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 200));
    assert.equal(cyclic.status(true).configuration.rejection?.errorCode, "config.invalid-value", "a configured escalation cycle is rejected at apply");
    await cyclic.retire("fixture-complete");
  } finally {
    await session.retire("fixture-complete").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("K07-A4-slot-cap: one message slot admits one eligible feedback and refuses the second", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-slotcap-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1, enabled: true, mode: "advise",
    runtime: { boundaryWaitMs: 0, maxConcurrentEvaluations: 2, maxFeedbackPerEpisode: 1, restore: "reconcile-only" },
    permissions: { actions: ["core.feedback"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: { quiet: { use: "fixture.quiet", options: {} } },
    policies: { feedback: { use: "fixture.feedback-policy", options: {} } },
    checks: { repeat: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "recent-work", prompt: "repetition", evaluator: "quiet", policy: "feedback", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
    observability: {},
  }), "utf8");
  const delivered: string[] = [];
  const quiet: EvaluatorDefinition = {
    id: "fixture.quiet", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.quiet-slot"],
    evaluate: async (_options, input) => ({ operational: "completed", coverage: input.context.coverage, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [] }),
  };
  let serial = 0;
  const feedbackPolicy: any = {
    id: "fixture.feedback-policy", apiMajor: 1, kind: "policy",
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.feedback-proposed"],
    decide: () => {
      serial += 1;
      return { outcome: "propose", reasonCode: "supported-concern", actions: [{ localId: `f-${serial}`, action: "core.feedback", options: { text: `bounded advice ${serial}`, delivery: "steer" }, findingIds: [], evidenceIds: [], reasonCode: "fixture.feedback-proposed" }] };
    },
  };
  const session = await EngineSession.start({
    observedSessionId: `sess-k07-slotcap-${process.pid}-${Date.now()}`,
    branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
    feedbackHost: {
      capabilities: () => new Set(["host.feedback.steer"]),
      deliver: async request => {
        delivered.push(request.actionId);
        return { actionId: request.actionId, state: "queued", destinationId: "fixture.primary", evidenceIds: [] };
      },
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
  });
  const fixture: Fixture = { root, agentDir, projectConfigDir, session };
  try {
    const registered = session.endpoint.register({ id: "fixture.k07-slotcap", version: "0.1.0", baseUri: "fixture:slotcap", components: [quiet, feedbackPolicy], resources: {} });
    assert.equal(registered.ok, true);
    if (registered.ok) await registered.value.ready;
    assert.equal((await session.reloadConfiguration()).ok, true);
    await settle();
    work(fixture);
    tool(fixture, "sc-1");
    let deadline = Date.now() + 10_000;
    while (delivered.length === 0 && Date.now() < deadline) await settle();
    assert.equal(delivered.length, 1, "the single message slot delivered the first eligible note");
    tool(fixture, "sc-2");
    deadline = Date.now() + 10_000;
    let rejected = false;
    while (!rejected && Date.now() < deadline) {
      rejected = session.status(true).diagnostics.recentEvents.some(record => record.event === "quality.action.admission"
        && record.fields.data.outcome === "rejected"
        && Array.isArray(record.fields.data.reasonCodes)
        && (record.fields.data.reasonCodes as string[]).includes("core.feedback-limit"));
      if (!rejected) await settle();
    }
    assert.equal(rejected, true, "the second eligible feedback is refused by the actual one-message limit");
    assert.equal(delivered.length, 1, "the receiver saw exactly one message");
  } finally {
    await session.retire("fixture-slotcap-complete");
    await rm(root, { recursive: true, force: true });
  }
});

test("K07-B01/T01-owner: a preliminary suspicion admits exactly one core.request-check child", async () => {
  await withEscalationFixture(async fixture => {
    work(fixture);
    await drive(fixture, "first");
    const status = fixture.session.status(true);
    // Exactly one action is admitted: the ordinary escalation request.
    const admitted = status.diagnostics.recentEvents
      .filter(record => record.event === "quality.action.admission")
      .map(record => record.fields.data)
      .filter(entry => entry.outcome === "admitted");
    assert.equal(admitted.length, 1, "one admitted action for the preliminary suspicion");
    assert.equal(admitted[0]?.componentId, "core.request-check", "the admitted action is the ordinary escalation request");
    // The escalation produced a real child run with causal identity.
    const started = status.diagnostics.recentEvents
      .filter(record => record.event === "quality.check.started")
      .map(record => record.fields.data);
    const expert = started.filter(entry => entry.checkId === "expert");
    assert.equal(expert.length, 1, "exactly one expert child run was admitted");
    const statusAgain = fixture.session.status(true);
    assert.equal(statusAgain.checks.total, 2);
    // The action receipt carries the actual resulting run identity, never a
    // completed-expert claim.
    const receipt = statusAgain.diagnostics.recentEvents
      .filter(record => record.event === "quality.action.receipt")
      .map(record => record.fields.data)
      .filter(entry => entry.state === "queued" && typeof entry.destinationRef === "string" && entry.destinationRef.startsWith("run-"));
    assert.equal(receipt.length >= 1, true, "the escalation receipt names the actual queued child run");
  });
});

test("K07-B03: the escalation depth allowance refuses a deeper child", async () => {
  await withEscalationFixture(async fixture => {
    // Depth 0 by default (maxEscalationDepth 1 allows the first child only).
    work(fixture);
    await drive(fixture, "depth");
    const rejected = fixture.session.status(true).diagnostics.recentEvents
      .filter(record => record.event === "quality.action.admission")
      .map(record => record.fields.data)
      .filter(entry => entry.outcome === "rejected")
      .flatMap(entry => (entry.reasonCodes as string[] | undefined) ?? []);
    assert.equal(Array.isArray(rejected), true);
    // A child at the allowed depth exists; a nested request from it is refused by
    // the depth allowance rather than admitted.
    const childRun = fixture.session.status(true).checks.detail.find(entry => entry.checkId === "expert");
    assert.equal(childRun?.runs, 1, "the first causal child was admitted");
  }, { maxEscalationDepth: 1 });
});

// K07 A.2 (Astra272 successor): the shared complete-set count-bound invariant at
// the real owner — a fitting 32-entry required set must reuse the held target,
// while a complete 33-entry input can never be reported as covered by it.
// Public EngineSession + registered deterministic evaluators only: no SDK, no
// model profile, no private state and no production test hook.
test("K07-A2-required-set-bound-owner: fitting32 reuses, complete33 with an omitted tail is refused", { timeout: 90_000 }, async (t) => {
  const settle = async (ms = 20) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  const journalRows = async (agentDir: string): Promise<Array<{ event?: string; fields?: { data?: Record<string, unknown>; correlation?: Record<string, unknown>; scope?: Record<string, unknown> } }>> => {
    let raw = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [] as string[])) {
      if (name.endsWith(".jsonl")) raw += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    return raw.split(String.fromCharCode(10)).filter(Boolean)
      .map(line => { try { return JSON.parse(line) as { event?: string; fields?: { data?: Record<string, unknown>; correlation?: Record<string, unknown>; scope?: Record<string, unknown> } }; } catch { return null; } })
      .filter((row): row is { event?: string; fields?: { data?: Record<string, unknown>; correlation?: Record<string, unknown>; scope?: Record<string, unknown> } } => row !== null);
  };
  const runRow = async (row: "fitting32" | "input33"): Promise<void> => {
    await t.test(row, async () => {
      const root = await mkdtemp(join(tmpdir(), `qe-k07-bound-${row}-`));
      const project = join(root, "project");
      const agentDir = join(root, "agent");
      const sessionId = `sess-k07-bound-${row}-${process.pid}-${Date.now()}`;
      await mkdir(join(agentDir, "quality"), { recursive: true });
      await mkdir(project, { recursive: true });
      const baseNames = Array.from({ length: 32 }, (_, index) => `base-${String(index + 1).padStart(2, "0")}.txt`);
      for (const [index, name] of baseNames.entries()) {
        await writeFile(join(agentDir, "quality", name), `base-body-${index + 1}-unique`, "utf8");
      }
      await writeFile(join(agentDir, "quality", "tail.txt"), "tail-body-unique", "utf8");
      const targetBindings: Array<{ id: string; use: string; options: Record<string, unknown> }> = [{ id: "base", use: "core.files", options: { sourceIds: ["base"] } }];
      if (row === "input33") targetBindings.push({ id: "tail", use: "core.files", options: { sourceIds: ["tail"] } });
      await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
        schemaVersion: 1, enabled: true, mode: "advise",
        runtime: { boundaryWaitMs: 0, maxConcurrentEvaluations: 2, maxEscalationsPerEpisode: 2, maxEscalationDepth: 1, restore: "reconcile-only" },
        permissions: { actions: ["core.request-check"], modelProfiles: [], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
        prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
        sources: {
          base: { uris: baseNames, role: "evidence", required: true },
          tail: { uris: ["tail.txt"], role: "evidence", required: true },
        },
        contexts: {
          work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 12000 },
          target: { providers: targetBindings, maxEstimatedTokens: 12000 },
        },
        evaluators: { preliminary: { use: "fixture.bound-preliminary", options: {} }, held: { use: "fixture.bound-held", options: {} } },
        policies: { engineering: { use: "core.engineering", options: { escalateTo: "target" } }, record: { use: "core.record-only" } },
        checks: {
          preliminary: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "preliminary", policy: "engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
          target: { triggers: [], context: "target", prompt: "repetition", evaluator: "held", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
        },
        observability: {},
      }), "utf8");
      let release: () => void = () => undefined;
      const gate = new Promise<void>(resolvePromise => { release = () => resolvePromise(); });
      type BoundInput = Parameters<EvaluatorDefinition["evaluate"]>[1];
      let captured: BoundInput | null = null;
      let entered = 0;
      let finished = 0;
      let firstFailure: unknown = null;
      const preliminary: EvaluatorDefinition = {
        id: "fixture.bound-preliminary", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
        optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.bound-preliminary"],
        evaluate: async (_options, input) => {
          const item = input.context.items.find(entry => entry.provenance.sourceId === "core.history");
          return {
            operational: "completed", coverage: input.context.coverage,
            conclusion: item === undefined ? "no-supported-finding" : "findings",
            findings: item === undefined ? [] : [{
              id: `${input.run.runId}:finding-1`, criterion: "efficiency.repetition", status: "suspected", severity: "concern",
              requirementRefs: [], evidenceIds: [item.id], affectedItems: [], defectCode: `fixture.bound-${row}-${input.run.runId}`,
              explanation: "preliminary suspicion for the bound owner", proposedCorrection: null, limitations: [],
            }],
            scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
          };
        },
      };
      const held: EvaluatorDefinition = {
        id: "fixture.bound-held", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
        optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.bound-held"],
        evaluate: async (_options, input) => {
          captured = input;
          entered += 1;
          try {
            await gate;
            return { operational: "completed", coverage: input.context.coverage, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };
          } finally {
            finished += 1;
          }
        },
      };
      const session = await EngineSession.start({
        observedSessionId: sessionId, branchId: "unresolved", agentDir,
        projectConfigDir: join(project, ".pi"), projectRoot: project, projectTrusted: true,
        hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
        feedbackHost: {
          capabilities: () => new Set<string>(),
          deliver: async request => ({ actionId: request.actionId, state: "rejected" as const, destinationId: null, evidenceIds: [], error: { code: "core.feedback-unsupported", retryable: false } }),
          reconcile: async actionId => ({ actionId, state: "unknown" as const, destinationId: null, evidenceIds: [] }),
        },
      });
      try {
        const registered = session.endpoint.register({ id: "fixture.k07-bound", version: "0.1.0", baseUri: "fixture:bound", components: [preliminary, held], resources: {} });
        assert.equal(registered.ok, true, "the package registration is accepted");
        if (registered.ok) assert.equal((await registered.value.ready).ok, true, "the registered package is ready");
        assert.equal((await session.reloadConfiguration()).ok, true, "the configuration reload is accepted");
        await settle(200);
        assert.equal(session.status(true).checks.active, 2, "both actual checks are active before work");
        session.handlePrimaryEvent({ type: "operator-input", text: `bound ${row} work`, source: "interactive", occurredAt: new Date().toISOString() });
        const tool = (serial: number) => {
          const at = new Date().toISOString();
          session.handlePrimaryEvent({ type: "tool-started", operationId: `bound-${row}-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
          session.handlePrimaryEvent({ type: "tool-completed", operationId: `bound-${row}-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
        };
        tool(1);
        const enteredDeadline = Date.now() + 20_000;
        while (entered === 0 && Date.now() < enteredDeadline) await settle();
        assert.equal(entered, 1, "the first real preliminary action admitted the target and it is held");
        assert.equal(session.status(true).checks.active, 2, "the held target is the only target entry");
        assert.ok(captured, "the held target captured its real input");
        const input = captured as unknown as BoundInput;
        assert.equal(input.context.coverage.state, "complete", "the target input coverage is complete");
        assert.equal(input.context.coverage.issues.length, 0, "the target input has no coverage issues");
        const evidenceItems = input.context.items.filter(item => item.provenance.sourceId === "core.files");
        const expectedCount = row === "fitting32" ? 32 : 33;
        assert.equal(evidenceItems.length, expectedCount, `the target input carries exactly ${expectedCount} required files`);
        const bodies = evidenceItems.flatMap(item => item.content.filter(block => block.type === "text").map(block => block.text ?? "")).join(" ");
        assert.equal(bodies.includes("base-body-1-unique") && bodies.includes("base-body-32-unique"), true, "every base file body reaches the target input");
        if (row === "input33") assert.equal(bodies.includes("tail-body-unique"), true, "the tail body reaches the complete 33-entry input");
        const fingerprints = input.context.dependencies.filter(dependency => dependency.check === "content-fingerprint");
        assert.equal(fingerprints.length, expectedCount, `the required dependency set is exactly ${expectedCount}`);
        // Measure the same bounded descriptor entries the owner captures.
        let entriesBytes = 0;
        for (const dependency of fingerprints) {
          const item = input.context.items.find(entry => entry.id === dependency.evidenceId);
          const declared = item === undefined ? null : /^source:([^:]+):/u.exec(item.id)?.[1] ?? null;
          assert.equal(typeof declared, "string", "every required dependency resolves to a declared source");
          entriesBytes += Buffer.byteLength(JSON.stringify({ sourceId: declared, evidenceId: dependency.evidenceId, revision: dependency.revision }), "utf8");
        }
        assert.equal(entriesBytes < 8192, true, "the full descriptor entry set fits the byte bound");
        const heldRunId = input.run.runId;
        // Same session/generation/episode/authorization: only ordinary tool evidence.
        tool(2);
        const decisionDeadline = Date.now() + 20_000;
        let decision: Record<string, unknown> | null = null;
        while (decision === null && Date.now() < decisionDeadline) {
          const rows = await journalRows(agentDir);
          const admission = rows.filter(record => record.event === "quality.action.admission" && record.fields?.data?.componentId === "core.request-check")[1];
          decision = admission === undefined ? null : rows.find(record => record.event === "quality.action.receipt"
            && record.fields?.data?.actionId === admission.fields?.data?.actionId)?.fields?.data ?? null;
          if (decision === null) await settle();
        }
        assert.ok(decision, "the second cause reaches its own request-check receipt");
        assert.deepEqual(session.status(true).checks.active, 2, "the target check inventory is unchanged");
        if (row === "fitting32") {
          assert.equal(decision.state, "queued", "the fitting 32-entry cause is accepted");
          assert.equal(decision.destinationRef, heldRunId, "the fitting cause names exactly the held target run");
          assert.equal(decision.errorCode ?? null, null, "the fitting cause is not refused");
        } else {
          assert.equal(decision.state, "rejected", "the complete 33-entry cause is refused");
          assert.equal(decision.errorCode, "core.escalation-incompatible-cause", "the refusal is the exact incompatibility code");
        }
        assert.equal(entered, 1, "no second target entry was created");
        assert.equal(Number(session.status(true).checks.pendingIntents), 0, "no new target reservation was created");
        // Release once: the real evaluator returns and the same run settles.
        release();
        const settleDeadline = Date.now() + 20_000;
        let settled = false;
        while (!settled && Date.now() < settleDeadline) {
          settled = (await journalRows(agentDir)).some(record => record.event === "quality.check.settled"
            && record.fields?.correlation?.["runId"] === heldRunId
            && record.fields?.data?.operational === "completed"
            && record.fields?.data?.terminalReason === "evaluated");
          if (!settled) await settle();
        }
        assert.equal(settled, true, "the same held run settled canonically once");
        assert.equal(finished, 1, "the real evaluator finished exactly once");
        await session.retire("fixture-bound-complete");
        assert.equal(session.status(true).runtime.state, "retired", "the engine owner retired");
        assert.equal(finished, 1, "the owned evaluator operation drained after retirement");
      } catch (error) {
        firstFailure = error;
        throw error;
      } finally {
        release();
        try {
          await session.retire("fixture-bound-cleanup");
        } catch (cleanupError) {
          console.error("K07-A2-BOUND-CLEANUP", String(cleanupError));
          throw new AggregateError([firstFailure, cleanupError].filter(Boolean), "bound owner control/cleanup failure; owned state retained");
        }
        if (firstFailure === null) await rm(root, { recursive: true, force: true });
      }
    });
  };
  await runRow("fitting32");
  await runRow("input33");
});
