import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssessmentResult, ContextDefinition, EvaluatorDefinition, PackageDefinition } from "../src/contracts.js";
import type { EngineSessionInput } from "../src/runtime.js";
import { EngineSession, SessionPhysicalState } from "../src/runtime.js";
import { SessionJournal } from "../src/journal.js";
import type { EngineClock } from "../src/scheduling.js";

const RESOURCES_DIR = join(process.cwd(), "resources");

class DriftingClock implements EngineClock {
  #monoMs = 5_000;
  #wallOffsetMs = 0;
  #timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];

  nowMonoMs(): number {
    return this.#monoMs;
  }

  nowUtc(): string {
    return new Date(this.#monoMs + this.#wallOffsetMs).toISOString();
  }

  setTimer(delayMs: number, callback: () => void): () => void {
    const entry = { at: this.#monoMs + Math.max(0, delayMs), callback, cancelled: false };
    this.#timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  advance(ms: number): void {
    const target = this.#monoMs + ms;
    for (;;) {
      const due = this.#timers
        .filter(timer => !timer.cancelled && timer.at <= target)
        .sort((left, right) => left.at - right.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      this.#monoMs = due.at;
      due.callback();
    }
    this.#monoMs = target;
  }

  /** Jumps monotonic time first, as a recovered late wake does. */
  advanceLate(ms: number): void {
    this.#monoMs += ms;
    for (const timer of this.#timers.filter(entry => !entry.cancelled && entry.at <= this.#monoMs)) {
      timer.cancelled = true;
      timer.callback();
    }
  }
}

class Deferred<T> {
  readonly promise: Promise<T>;
  #resolve!: (value: T) => void;
  constructor() {
    this.promise = new Promise(resolvePromise => {
      this.#resolve = resolvePromise;
    });
  }

  resolve(value: T): void {
    this.#resolve(value);
  }
}

const completedAssessment = (): AssessmentResult => ({
  operational: "completed",
  coverage: { state: "complete", scopeDescription: "Repair fixture scope.", issues: [] },
  conclusion: "no-supported-finding",
  findings: [],
  scores: [],
  additionalEvidence: [],
  dependencies: [],
  usageAttemptIds: [],
});

const holds: Array<Deferred<AssessmentResult>> = [];
let holdCalls = 0;
const holdEvaluator: EvaluatorDefinition = {
  id: "fixture.hold",
  apiMajor: 1,
  kind: "evaluator",
  mechanism: "deterministic",
  accepts: ["json"],
  optionsSchema: { type: "object", additionalProperties: false },
  requiredCapabilities: [],
  diagnosticCodes: [],
  evaluate: async () => {
    holdCalls += 1;
    const deferred = new Deferred<AssessmentResult>();
    holds.push(deferred);
    return deferred.promise;
  },
};

const contextProvider: ContextDefinition = {
  id: "fixture.note",
  apiMajor: 1,
  kind: "context",
  produces: ["json"],
  optionsSchema: { type: "object", additionalProperties: false },
  requiredCapabilities: [],
  diagnosticCodes: [],
  collect: async () => ({
    ok: true,
    value: { items: [], coverage: { state: "complete", scopeDescription: "empty", issues: [] }, dependencies: [] },
  }),
};

interface Fixture {
  root: string;
  agentDir: string;
  clock: DriftingClock | null;
  session: EngineSession;
}

const baseCheck = (trigger: object, evaluator = "repetition-check"): object => ({
  triggers: [{ id: "due", ...trigger }],
  context: "recent-work",
  prompt: "repetition",
  evaluator,
  policy: "record",
  cooldownMs: 0,
  criteria: ["efficiency.repetition"],
  workStates: ["work-expected", "waiting-dependency", "completion-candidate"],
});

async function writeConfig(agentDir: string, overrides: { check?: object; checks?: Record<string, object>; runtime?: object; observability?: object; evaluators?: object } = {}): Promise<void> {
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "observe",
    runtime: overrides.runtime ?? {},
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "task", use: "core.task" }], maxEstimatedTokens: 4000 } },
    evaluators: overrides.evaluators ?? { "repetition-check": { use: "core.repeated-tools", options: { window: 12, minimumRepeats: 3 } } },
    policies: { record: { use: "core.record-only" } },
    checks: overrides.checks ?? { repetition: overrides.check ?? baseCheck({ use: "core.every-tools", options: { count: 1 } }) },
    observability: overrides.observability ?? {},
  }), "utf8");
}

async function start(options: {
  root?: string;
  check?: object;
  checks?: Record<string, object>;
  runtime?: object;
  observability?: object;
  evaluators?: object;
  realClock?: boolean;
  observedSessionId?: string;
  physicalState?: SessionPhysicalState;
} = {}): Promise<Fixture> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "qe-k03r-"));
  const agentDir = join(root, "agent");
  await writeConfig(agentDir, options);
  await mkdir(join(root, "project", ".pi"), { recursive: true });
  const clock = options.realClock === true ? null : new DriftingClock();
  const input: EngineSessionInput & { hostIdleAtStart: boolean } = {
    observedSessionId: options.observedSessionId ?? `sess-${process.pid}-${Date.now()}-${Math.round(performance.now())}`,
    branchId: "unresolved",
    agentDir,
    projectConfigDir: join(root, "project", ".pi"),
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: RESOURCES_DIR,
    hostIdleAtStart: true,
    ...(clock === null ? {} : { clock }),
    ...(options.physicalState === undefined ? {} : { physicalState: options.physicalState }),
  };
  return { root, agentDir, clock, session: await EngineSession.start(input) };
}

function input(fixture: Fixture, text = "repair task"): void {
  fixture.session.handlePrimaryEvent({ type: "operator-input", text, source: "interactive", occurredAt: fixture.clock?.nowUtc() ?? new Date().toISOString() });
}

function tool(fixture: Fixture, id: string): void {
  const occurredAt = fixture.clock?.nowUtc() ?? new Date().toISOString();
  fixture.session.handlePrimaryEvent({ type: "tool-started", operationId: id, toolName: "read", parentOperationId: null, occurredAt });
  fixture.session.handlePrimaryEvent({ type: "tool-completed", operationId: id, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt });
}

async function registerHold(fixture: Fixture): Promise<void> {
  const definition: PackageDefinition = {
    id: "fixture.repair",
    version: "0.1.0",
    baseUri: "fixture:repair",
    components: [holdEvaluator, contextProvider],
    resources: {},
  };
  const registered = fixture.session.endpoint.register(definition);
  assert.equal(registered.ok, true);
  if (registered.ok) await registered.value.ready;
  await settle();
}

async function settle(ms = 30): Promise<void> {
  await new Promise(resolvePromise => setTimeout(resolvePromise, ms));
}

// ---------------------------------------------------------------------------
// R1: physical reservations survive replacement and wake pending peers
// ---------------------------------------------------------------------------

test("K03-R1a a timed-out physical operation blocks replacement capacity until it settles", async () => {
  holds.length = 0;
  holdCalls = 0;
  const physical = new SessionPhysicalState();
  const first = await start({
    physicalState: physical,
    runtime: { maxConcurrentEvaluations: 1 },
    evaluators: { hold: { use: "fixture.hold" } },
    check: { ...baseCheck({ use: "core.every-tools", options: { count: 1 } }, "hold"), timeoutMs: 60 },
  });
  const second = await start({
    root: first.root,
    physicalState: physical,
    runtime: { maxConcurrentEvaluations: 1 },
    evaluators: { hold: { use: "fixture.hold" } },
    check: { ...baseCheck({ use: "core.every-tools", options: { count: 1 } }, "hold"), timeoutMs: 60 },
  });
  try {
    await registerHold(first);
    input(first);
    tool(first, "t1");
    (first.clock as DriftingClock).advance(100);
    await settle(120);
    assert.equal(holdCalls, 1, "the first generation owns the physical call");
    assert.ok(first.session.status(true).diagnostics.recentEvents.some(record => record.event === "quality.check.settled"));

    await first.session.retire("replaced");
    await registerHold(second);
    input(second);
    tool(second, "t2");
    await settle(80);
    assert.equal(holdCalls, 1, "the replacement generation cannot create free capacity while the operation is physically unsettled");
    assert.ok((second.session.status(true).checks.suppressedReasons["core.capacity"] ?? 0) >= 1);

    holds[0]?.resolve(completedAssessment());
    await settle(120);
    assert.equal(holdCalls, 2, "settlement wakes the queued replacement run without new primary activity");
  } finally {
    await second.session.retire("quit");
    await rm(first.root, { recursive: true, force: true });
  }
});

test("K03-R1b releasing capacity wakes an already queued other check", async () => {
  holds.length = 0;
  holdCalls = 0;
  const fixture = await start({
    runtime: { maxConcurrentEvaluations: 1 },
    evaluators: { hold: { use: "fixture.hold" } },
    checks: {
      first: { ...baseCheck({ use: "core.every-tools", options: { count: 1 } }, "hold") },
      second: { ...baseCheck({ use: "core.every-tools", options: { count: 1 } }, "hold") },
    },
  });
  try {
    await registerHold(fixture);
    input(fixture);
    tool(fixture, "t1");
    await settle(60);
    assert.equal(holdCalls, 1);
    assert.equal(fixture.session.status(true).checks.pendingIntents, 1);
    holds[0]?.resolve(completedAssessment());
    await settle(120);
    assert.equal(holdCalls, 2, "a settled run wakes the queued other check without a fresh observation");
  } finally {
    await fixture.session.retire("quit");
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R2: protected same-session ownership independent of journaling
// ---------------------------------------------------------------------------

test("K03-R2a a missing checkpoint with prior session evidence fails closed", async () => {
  const sessionId = `sess-k03-r2a-${Date.now()}`;
  const fixture = await start({ observedSessionId: sessionId });
  try {
    input(fixture);
    tool(fixture, "t1");
    await settle(60);
    fixture.session.requestOperatorStop();
    await settle(60);
    await fixture.session.retire("reload");
    const stateDirectory = join(fixture.agentDir, "quality", "state");
    for (const name of await readdir(stateDirectory)) {
      await unlink(join(stateDirectory, name));
    }
    const second = await start({ root: fixture.root, observedSessionId: sessionId });
    try {
      const status = second.session.status(true);
      assert.equal(status.runtime.operatorStopped, true, "a lost checkpoint must not reset persisted Stop");
      assert.equal(status.runtime.control.state, "degraded");
    } finally {
      await second.session.retire("quit");
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K03-R2b a second live owner is inspect-only even with the journal disabled", async () => {
  const sessionId = `sess-k03-r2b-${Date.now()}`;
  const first = await start({ observedSessionId: sessionId, observability: { journal: { enabled: false } } });
  const second = await start({ root: first.root, observedSessionId: sessionId, observability: { journal: { enabled: false } } });
  try {
    assert.equal(second.session.status(true).runtime.control.state, "conflict");
    input(second);
    tool(second, "t2");
    await settle(60);
    assert.equal(second.session.status(true).checks.runs, 0, "only the owner may admit work");
    assert.ok((second.session.status(true).checks.suppressedReasons["core.control-owner-conflict"] ?? 0) >= 1);
  } finally {
    await second.session.retire("quit");
    await first.session.retire("quit");
    await rm(first.root, { recursive: true, force: true });
  }
});

test("K03-R2c the checkpoint persists the accepted authorization revision", async () => {
  let observed: string | null = null;
  const capture: EvaluatorDefinition = {
    id: "fixture.capture",
    apiMajor: 1,
    kind: "evaluator",
    mechanism: "deterministic",
    accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: [],
    evaluate: async (_options, evaluatorInput) => {
      observed = evaluatorInput.run.scope.authorizationRevision;
      return completedAssessment();
    },
  };
  const fixture = await start({ evaluators: { capture: { use: "fixture.capture" } }, check: { ...baseCheck({ use: "core.every-tools", options: { count: 1 } }, "capture") } });
  try {
    const definition: PackageDefinition = { id: "fixture.capture-package", version: "0.1.0", baseUri: "fixture:capture", components: [capture], resources: {} };
    const registered = fixture.session.endpoint.register(definition);
    assert.equal(registered.ok, true);
    if (registered.ok) await registered.value.ready;
    input(fixture);
    tool(fixture, "t1");
    await settle(80);
    assert.equal(observed, "auth-1", "admitted work advanced authority");
    await fixture.session.retire("quit");
    const names = await readdir(join(fixture.agentDir, "quality", "state"));
    const checkpoint = JSON.parse(await readFile(join(fixture.agentDir, "quality", "state", names.find(name => name.endsWith(".json")) ?? ""), "utf8")) as { authorizationRevision?: string };
    assert.equal(checkpoint.authorizationRevision, "auth-1", "the checkpoint stores the actual accepted revision, not auth-0");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K03-R2d a valid reload leaves the next deterministic check functional", async () => {
  const fixture = await start({ check: baseCheck({ use: "core.every-tools", options: { count: 5 } }) });
  try {
    input(fixture);
    tool(fixture, "before");
    await writeConfig(fixture.agentDir);
    const reloaded = await fixture.session.reloadConfiguration();
    assert.equal(reloaded.ok, true);
    tool(fixture, "after");
    await settle(80);
    assert.equal(fixture.session.status(true).checks.runs, 1, "the reloaded count-1 check runs on the next completion");
  } finally {
    await fixture.session.retire("quit");
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R3: canonical triggers and normalized completion facts
// ---------------------------------------------------------------------------

test("K03-R3a inactivity refreshes its deadline after newer activity", async () => {
  const fixture = await start({ check: baseCheck({ use: "core.inactivity", options: { afterMs: 300 } }) });
  try {
    input(fixture);
    (fixture.clock as DriftingClock).advance(180);
    tool(fixture, "recent");
    (fixture.clock as DriftingClock).advance(180);
    await settle(40);
    assert.equal(fixture.session.status(true).checks.runs, 0, "300 ms cannot fire 180 ms after newer activity");
    (fixture.clock as DriftingClock).advance(150);
    await settle(40);
    assert.equal(fixture.session.status(true).checks.runs, 1);
  } finally {
    await fixture.session.retire("quit");
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K03-R3b canonical null repeat yields a functional one-shot inactivity run", async () => {
  const fixture = await start({ check: baseCheck({ use: "core.inactivity", options: { afterMs: 100, repeatAfterMs: null } }) });
  try {
    assert.equal(fixture.session.status(true).checks.active, 1, "repeatAfterMs:null is the ordinary no-repeat default");
    input(fixture);
    (fixture.clock as DriftingClock).advance(150);
    await settle(40);
    assert.equal(fixture.session.status(true).checks.runs, 1);
    (fixture.clock as DriftingClock).advance(500);
    await settle(40);
    assert.equal(fixture.session.status(true).checks.runs, 1, "a null repeat stays one-shot");
  } finally {
    await fixture.session.retire("quit");
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K03-R3c canonical wait and evidence options are accepted with defaults", async () => {
  const wait = await start({ check: baseCheck({ use: "core.wait-deadline", options: {} }) });
  const evidence = await start({ check: baseCheck({ use: "core.evidence-change", options: { sourceIds: ["core.history"] } }) });
  try {
    assert.equal(wait.session.status(true).configuration.rejection, null);
    assert.equal(wait.session.status(true).checks.active, 1);
    assert.equal(evidence.session.status(true).configuration.rejection, null);
    assert.equal(evidence.session.status(true).checks.active, 1);
  } finally {
    await wait.session.retire("quit");
    await evidence.session.retire("quit");
    await rm(wait.root, { recursive: true, force: true });
    await rm(evidence.root, { recursive: true, force: true });
  }
});

test("K03-R3d completion facts require explicit actionability", async () => {
  const fixture = await start({ check: baseCheck({ use: "core.before-completion", options: {} }) });
  try {
    input(fixture);
    const rejectedBefore = fixture.session.status(true).observation.rejectedObservations;
    fixture.session.handlePrimaryEvent({ type: "completion-boundary", boundaryId: "b-invalid", actionable: undefined as never, occurredAt: new Date().toISOString() });
    await settle(20);
    assert.equal(fixture.session.status(true).observation.rejectedObservations, rejectedBefore + 1, "a boundary without explicit actionability is rejected");
    fixture.session.handlePrimaryEvent({ type: "completion-boundary", boundaryId: "b-passive", actionable: false, occurredAt: new Date().toISOString() });
    fixture.session.handlePrimaryEvent({ type: "completion-boundary", boundaryId: "b-actionable", actionable: true, occurredAt: new Date().toISOString() });
    await settle(60);
    assert.equal(fixture.session.status(true).checks.runs, 1, "only the actionable boundary requests the completion-eligible check");
  } finally {
    await fixture.session.retire("quit");
    await rm(fixture.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R4: Debug/Trace detail and resynchronization visibility
// ---------------------------------------------------------------------------

test("K03-R4 debug/trace select timing diagnostics without widening capture", async () => {
  const debug = await start({
    observability: { detail: "debug" },
    check: baseCheck({ use: "core.periodic", options: { everyMs: 100, requireNewEvidence: false } }),
  });
  try {
    assert.equal(debug.session.status(true).configuration.rejection, null, "Debug detail is available");
    input(debug);
    (debug.clock as DriftingClock).advanceLate(5_000);
    await settle(60);
    const events = debug.session.status(true).diagnostics.recentEvents.map(record => record.event);
    assert.ok(events.includes("quality.clock.resynchronized"), "recovered timing is projected at Debug");
    assert.equal(debug.session.status(true).diagnostics.detail, "debug");
    assert.equal(debug.session.status(true).diagnostics.capture, "none");
  } finally {
    await debug.session.retire("quit");
    await rm(debug.root, { recursive: true, force: true });
  }

  const standard = await start({ check: baseCheck({ use: "core.periodic", options: { everyMs: 100, requireNewEvidence: false } }) });
  try {
    assert.equal(standard.session.status(true).diagnostics.detail, "standard");
    input(standard);
    (standard.clock as DriftingClock).advanceLate(5_000);
    await settle(60);
    assert.equal(standard.session.status(true).diagnostics.recentEvents.some(record => record.event === "quality.clock.resynchronized"), false, "Standard omits the debug-only resynchronization record");
  } finally {
    await standard.session.retire("quit");
    await rm(standard.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// R5-R8: journal lifecycle, bounds, tail identity and retention
// ---------------------------------------------------------------------------

const journalClock: EngineClock = {
  nowMonoMs: () => performance.now(),
  nowUtc: () => new Date().toISOString(),
  setTimer: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

const sessionKey = (observedSessionId: string): string => {
  const digest = createHash("sha256").update(observedSessionId, "utf8").digest("hex").slice(0, 8);
  return `${observedSessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)}-${digest}`;
};

const seededRecord = (sessionId: string, sequence: number) => ({
  schemaVersion: 1 as const,
  eventId: `repair-record-${sequence}`,
  sequence,
  event: "quality.runtime.started",
  observedSessionId: sessionId,
  fields: {
    time: { recordedAt: new Date().toISOString(), monoMs: sequence, occurredAt: null },
    engine: { name: "pi-quality-engine", version: "0.0.2", buildRef: "repair-fixture" },
    scope: { observedSessionId: sessionId, branchId: "unresolved", runtimeGeneration: "gen-1", episodeId: null, authorizationRevision: "auth-0" },
    data: {},
  },
} as never);

test("K03-R7 tail validity, foreign identity and monotonic ordinals survive reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k03-journal-"));
  const opened: Array<{ segmentOrdinal: number; previousTailState?: string }> = [];
  const emit = (kind: string, data: unknown): void => {
    if (kind === "opened") opened.push(data as { segmentOrdinal: number; previousTailState?: string });
  };
  try {
    // LF is not proof: a trailing invalid JSON line is damaged.
    const invalid = join(root, `${sessionKey("invalid")}.jsonl`);
    await writeFile(invalid, `${JSON.stringify(seededRecord("invalid", 1))}\n{"bad":}\n`, "utf8");
    const first = await SessionJournal.open({
      directory: root, observedSessionId: "invalid", writerGeneration: "gen-1", recordPolicyRevision: "metadata-v1",
      maxFileBytes: 10_485_760, rotationIntervalMs: null, compressArchives: false,
      retention: { maxArchivesPerSession: 4, maxAgeMs: 1_209_600_000, maxStorageBytes: 268_435_456 },
      maxPendingRecords: 256, maxPendingBytes: 1_048_576, clock: journalClock, emit,
    });
    assert.equal(first.ok, true);
    if (first.ok) {
      first.value.write(seededRecord("invalid", 2));
      await first.value.close("quit");
    }
    assert.equal(opened.length, 1, "the damaged segment is preserved and a new ordinal opens");
    assert.equal(opened[0]?.previousTailState, "damaged");

    // Foreign identity must not be appended through.
    const foreign = join(root, `${sessionKey("foreign")}.jsonl`);
    await writeFile(foreign, `${JSON.stringify(seededRecord("other-session", 1))}\n`, "utf8");
    const second = await SessionJournal.open({
      directory: root, observedSessionId: "foreign", writerGeneration: "gen-1", recordPolicyRevision: "metadata-v1",
      maxFileBytes: 10_485_760, rotationIntervalMs: null, compressArchives: false,
      retention: { maxArchivesPerSession: 4, maxAgeMs: 1_209_600_000, maxStorageBytes: 268_435_456 },
      maxPendingRecords: 256, maxPendingBytes: 1_048_576, clock: journalClock, emit,
    });
    assert.equal(second.ok, true);
    if (second.ok) {
      second.value.write(seededRecord("foreign", 2));
      await second.value.close("quit");
    }
    for (const name of await readdir(root)) {
      if (!name.endsWith(".jsonl")) continue;
      const records = (await readFile(join(root, name), "utf8")).trim().split(/\r?\n/u).filter(Boolean)
        .flatMap(line => {
          try {
            return [JSON.parse(line) as { observedSessionId: string }];
          } catch {
            // Preserved damaged bytes are not valid records; they also carry
            // no second logical identity.
            return [];
          }
        });
      assert.equal(new Set(records.map(record => record.observedSessionId)).size, 1, `no segment mixes logical identities (${name})`);
    }

    // Archive deletion must not reset ordinals.
    const ordinals: number[] = [];
    const ordinalEmit = (kind: string, data: unknown): void => {
      if (kind === "opened") ordinals.push((data as { segmentOrdinal: number }).segmentOrdinal);
    };
    for (let round = 0; round < 2; round += 1) {
      const journal = await SessionJournal.open({
        directory: root, observedSessionId: "ordinals", writerGeneration: "gen-1", recordPolicyRevision: "metadata-v1",
        maxFileBytes: 1, rotationIntervalMs: null, compressArchives: false,
        retention: { maxArchivesPerSession: 0, maxAgeMs: 1_209_600_000, maxStorageBytes: 268_435_456 },
        maxPendingRecords: 256, maxPendingBytes: 1_048_576, clock: journalClock, emit: ordinalEmit,
      });
      assert.equal(journal.ok, true);
      if (!journal.ok) continue;
      for (let n = 0; n < 3; n += 1) journal.value.write(seededRecord("ordinals", n + 1));
      await journal.value.close("quit");
    }
    assert.ok(ordinals.length >= 5, `several segments opened (${ordinals.join(",")})`);
    assert.ok(ordinals.every((value, index) => index === 0 || value > (ordinals[index - 1] ?? 0)), `ordinals stay monotonic after retention (${ordinals.join(",")})`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("K03-R8 retention counts the configured root once across sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k03-retention-"));
  try {
    const options = {
      directory: root,
      maxFileBytes: 10_485_760,
      rotationIntervalMs: null,
      compressArchives: false,
      retention: { maxArchivesPerSession: 64, maxAgeMs: 1_209_600_000, maxStorageBytes: 4_500 },
      maxPendingRecords: 256,
      maxPendingBytes: 1_048_576,
      clock: journalClock,
      emit: () => undefined,
    };
    const first = await SessionJournal.open({ ...options, observedSessionId: "session-one", writerGeneration: "gen-1", recordPolicyRevision: "metadata-v1" });
    assert.equal(first.ok, true);
    if (first.ok) {
      for (let n = 0; n < 6; n += 1) first.value.write(seededRecord("session-one", n + 1));
      await first.value.close("quit");
    }
    const second = await SessionJournal.open({ ...options, observedSessionId: "session-two", writerGeneration: "gen-1", recordPolicyRevision: "metadata-v1" });
    assert.equal(second.ok, true);
    if (second.ok) {
      for (let n = 0; n < 6; n += 1) second.value.write(seededRecord("session-two", n + 1));
      await second.value.close("quit");
    }
    let bytes = 0;
    for (const name of await readdir(root)) {
      if (!name.endsWith(".jsonl") && !name.endsWith(".jsonl.gz")) continue;
      bytes += (await readFile(join(root, name))).byteLength;
    }
    assert.ok(bytes <= 4_500, `configured-root retention counts other logical sessions (${bytes} bytes)`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
