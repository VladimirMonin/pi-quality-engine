import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssessmentResult, ContextDefinition, EvaluatorDefinition, PackageDefinition, TriggerDefinition } from "../src/contracts.js";
import type { EngineSessionInput } from "../src/runtime.js";
import { EngineSession } from "../src/runtime.js";
import { ControlCheckpoint } from "../src/checkpoint.js";
import type { EngineClock } from "../src/scheduling.js";

const RESOURCES_DIR = join(process.cwd(), "resources");
const SENTINEL = "k03-lifecycle-sentinel-77aa";

/** Monotonic time and wall time move independently, as they do on a real host. */
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

  jumpWall(ms: number): void {
    this.#wallOffsetMs += ms;
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
  coverage: { state: "complete", scopeDescription: "Deterministic lifecycle fixture.", issues: [] },
  conclusion: "no-supported-finding",
  findings: [],
  scores: [],
  additionalEvidence: [],
  dependencies: [],
  usageAttemptIds: [],
});

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
    const deferred = new Deferred<AssessmentResult>();
    holds.push(deferred);
    return deferred.promise;
  },
};

const holds: Array<Deferred<AssessmentResult>> = [];

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
    value: {
      items: [],
      coverage: { state: "complete", scopeDescription: "Lifecycle fixture has no evidence.", issues: [] },
      dependencies: [],
    },
  }),
};

interface Lifecycle {
  root: string;
  agentDir: string;
  projectConfigDir: string;
  clock: DriftingClock | null;
  session: EngineSession;
}

async function startLifecycle(options: {
  checkCount?: number;
  observability?: object;
  runtime?: object;
  realClock?: boolean;
  observedSessionId?: string;
  checks?: Record<string, object>;
  evaluators?: object;
  root?: string;
} = {}): Promise<Lifecycle> {
  const root = options.root ?? await mkdtemp(join(tmpdir(), "qe-k03-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  const check = {
    triggers: [{ id: "every-count", use: "core.every-tools", options: { count: options.checkCount ?? 1 } }],
    context: "recent-work",
    prompt: "repetition",
    evaluator: "repetition-check",
    policy: "record",
    cooldownMs: 0,
    criteria: ["efficiency.repetition"],
  };
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "observe",
    runtime: options.runtime ?? {},
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "task", use: "core.task" }], maxEstimatedTokens: 4000 } },
    evaluators: options.evaluators ?? { "repetition-check": { use: "core.repeated-tools", options: { window: 12, minimumRepeats: 3 } } },
    policies: { record: { use: "core.record-only" } },
    checks: options.checks ?? { repetition: check },
    observability: options.observability ?? {},
  }), "utf8");
  const clock = options.realClock === true ? null : new DriftingClock();
  const input: EngineSessionInput & { hostIdleAtStart: boolean } = {
    observedSessionId: options.observedSessionId ?? `sess-${process.pid}-${Date.now()}-${Math.round(performance.now())}`,
    branchId: "unresolved",
    agentDir,
    projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: RESOURCES_DIR,
    hostIdleAtStart: true,
    ...(clock === null ? {} : { clock }),
  };
  const session = await EngineSession.start(input);
  return { root, agentDir, projectConfigDir, clock, session };
}

async function retire(fixture: Lifecycle, cause = "quit"): Promise<void> {
  await fixture.session.retire(cause);
}

async function settle(): Promise<void> {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
}

function work(fixture: Lifecycle, text = "assess repetition"): void {
  fixture.session.handlePrimaryEvent({
    type: "operator-input",
    text,
    source: "interactive",
    occurredAt: (fixture.clock ?? { nowUtc: () => new Date().toISOString() }).nowUtc(),
  });
}

function tool(fixture: Lifecycle, id: string): void {
  const occurredAt = (fixture.clock ?? { nowUtc: () => new Date().toISOString() }).nowUtc();
  fixture.session.handlePrimaryEvent({ type: "tool-started", operationId: id, toolName: "read", parentOperationId: null, occurredAt });
  fixture.session.handlePrimaryEvent({ type: "tool-completed", operationId: id, toolName: "read", parentOperationId: null, isError: false, durationMs: 3, occurredAt });
}

function events(fixture: Lifecycle): string[] {
  return fixture.session.status(true).diagnostics.recentEvents.map(record => record.event);
}

function admissions(fixture: Lifecycle): Array<Record<string, unknown>> {
  return fixture.session.status(true).diagnostics.recentEvents
    .filter(record => record.event === "quality.check.admission")
    .map(record => record.fields.data as Record<string, unknown>);
}

async function registerHold(fixture: Lifecycle): Promise<void> {
  const definition: PackageDefinition = {
    id: "fixture.lifecycle",
    version: "0.1.0",
    baseUri: "fixture:lifecycle",
    components: [holdEvaluator, contextProvider],
    resources: {},
  };
  const registered = fixture.session.endpoint.register(definition);
  assert.equal(registered.ok, true);
  if (!registered.ok) return;
  await registered.value.ready;
  await settle();
}

test("K03-T03 monotonic deadlines ignore wall-clock jumps in both directions", async () => {
  const fixture = await startLifecycle({
    checks: {
      repetition: {
        triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 5_000, requireNewEvidence: false } }],
        context: "recent-work",
        prompt: "repetition",
        evaluator: "repetition-check",
        policy: "record",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
      },
    },
  });
  try {
    work(fixture);
    const clock = fixture.clock as DriftingClock;
    clock.advance(2_000);
    clock.jumpWall(-86_400_000);
    clock.advance(1_000);
    await settle();
    assert.equal(fixture.session.status(true).checks.runs, 0, "wall time moving backward creates no early run");
    clock.jumpWall(172_800_000);
    await settle();
    assert.equal(fixture.session.status(true).checks.runs, 0, "a forward wall jump alone creates no burst either");
    clock.advance(2_000);
    await settle();
    assert.equal(fixture.session.status(true).checks.runs, 1, "the monotonic interval alone admits exactly one check");
    const due = fixture.session.status(true).diagnostics.recentEvents
      .find(record => record.event === "quality.trigger.due");
    assert.ok(due !== undefined);
    assert.equal(typeof due.fields.data["firstDueAt"], "string", "presentation stays UTC wall time");
  } finally {
    await retire(fixture);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K03-T04 a long suspension coalesces missed intervals into one assessment", async () => {
  const fixture = await startLifecycle({
    checks: {
      repetition: {
        triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 100, requireNewEvidence: false } }],
        context: "recent-work",
        prompt: "repetition",
        evaluator: "repetition-check",
        policy: "record",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
      },
    },
  });
  try {
    work(fixture);
    (fixture.clock as DriftingClock).advance(1_000);
    await settle();
    const status = fixture.session.status(true);
    // Ten missed intervals collapse into the initial run plus one coalesced
    // resynchronization; they do not replay ten times.
    assert.equal(status.checks.runs, 2, "missed intervals coalesce instead of replaying");
    assert.ok((status.checks.suppressedReasons["core.run-active"] ?? 0) >= 1, "coalescing is an explicit, counted outcome");
    assert.ok((status.checks.suppressedReasons["core.run-active"] ?? 0) >= 1);
  } finally {
    await retire(fixture);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K03-T05 a hung evaluator keeps capacity reserved and status responsive", async () => {
  holds.length = 0;
  const fixture = await startLifecycle({
    runtime: { maxConcurrentEvaluations: 1 },
    evaluators: { hold: { use: "fixture.hold" } },
    checks: {
      first: {
        triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }],
        context: "recent-work",
        prompt: "repetition",
        evaluator: "hold",
        policy: "record",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
      },
      second: {
        triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }],
        context: "recent-work",
        prompt: "repetition",
        evaluator: "hold",
        policy: "record",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
      },
    },
  });
  try {
    await registerHold(fixture);
    work(fixture);
    tool(fixture, "t1");
    await settle();
    const status = fixture.session.status(true);
    assert.equal(status.checks.runs, 0, "no logical settlement while the evaluator is held");
    assert.equal(status.checks.active, 2, "both checks are configured and active");
    const outcomes = admissions(fixture).map(entry => entry["outcome"]);
    assert.ok(outcomes.includes("admitted"), "one run occupies the single capacity slot");
    assert.ok(outcomes.includes("queued"), "the later eligible request is explicitly queued");
    assert.ok((status.checks.suppressedReasons["core.capacity"] ?? 0) >= 1);
    assert.equal(status.checks.pendingIntents, 1, "the queued request stays pending, not silently dropped");
    assert.equal(JSON.stringify(status).includes("quality.check.settled"), false, "a held run has not settled");
  } finally {
    await retire(fixture);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K03-T02 a released evaluator after retirement cannot reach the replacement generation", async () => {
  holds.length = 0;
  const fixture = await startLifecycle({
    evaluators: { hold: { use: "fixture.hold" } },
    checks: { repetition: { triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }], context: "recent-work", prompt: "repetition", evaluator: "hold", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
  });
  try {
    await registerHold(fixture);
    work(fixture);
    tool(fixture, "t1");
    await settle();
    assert.equal(holds.length, 1, "the deterministic evaluator accepted the run");
    await retire(fixture, "replaced");
    const retiredRecords = fixture.session.status(true).diagnostics.recentEvents.length;

    const replacement = await startLifecycle({
      observedSessionId: "sess-k03-replacement",
      checks: { repetition: { triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }], context: "recent-work", prompt: "repetition", evaluator: "repetition-check", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
    });
    try {
      const replacementBefore = replacement.session.status(true).diagnostics.recentEvents.length;
      holds[0]?.resolve(completedAssessment());
      await settle();
      assert.equal(fixture.session.status(true).diagnostics.recentEvents.length, retiredRecords, "the retired generation settles nothing further");
      assert.equal(replacement.session.status(true).diagnostics.recentEvents.length, replacementBefore, "the replacement generation records nothing from the old run");
      assert.equal(replacement.session.status(true).checks.runs, 0, "the late result cannot trigger replacement work");
      assert.equal(fixture.session.status(true).diagnostics.recentEvents.some(record => record.event === "quality.check.settled"), false);
    } finally {
      await retire(replacement);
      await rm(replacement.root, { recursive: true, force: true });
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K03-T06 an invalid reload leaves the accepted configuration in effect", async () => {
  const fixture = await startLifecycle({ checkCount: 5 });
  try {
    work(fixture);
    for (const id of ["t1", "t2"]) tool(fixture, id);
    await settle();
    assert.equal(fixture.session.status(true).checks.runs, 0, "A needs five completions");
    const acceptedRevision = fixture.session.status(true).configuration.revision;

    await writeFile(join(fixture.agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      unknownWideningControl: { capture: "all" },
      observability: { capture: { prompts: "excerpt" } },
    }), "utf8");
    const reloaded = await fixture.session.reloadConfiguration();
    assert.equal(reloaded.ok, false, "invalid B is rejected");
    assert.deepEqual(reloaded.errorCode, "config.unknown-key");
    const rejected = fixture.session.status(true).diagnostics.recentEvents
      .filter(record => record.event === "quality.config.rejected")
      .at(-1);
    assert.equal(rejected?.fields.data["runtimeUnchanged"], true);
    assert.equal(fixture.session.status(true).configuration.revision, acceptedRevision, "A remains the effective revision");
    assert.equal(fixture.session.status(true).configuration.enabled, true);

    for (const id of ["t3", "t4", "t5"]) tool(fixture, id);
    await settle();
    const status = fixture.session.status(true);
    assert.equal(status.checks.runs, 1, "A still admits at five completions; counters were not reset");
    assert.equal(status.observation.completedPrimaryTools, 5);
    assert.equal(status.configuration.recentHistory.maxEvents, 512, "B never widened or replaced observability");
  } finally {
    await retire(fixture);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K03-T07 real O1 records reach files, parse, and close releases ownership", async () => {
  const fixture = await startLifecycle();
  try {
    work(fixture, `task body ${SENTINEL}`);
    tool(fixture, "t1");
    await settle();
    const journal = fixture.session.status(true).journal;
    assert.equal(journal?.state, "healthy");
    await retire(fixture);
    const directory = join(fixture.agentDir, "quality", "logs");
    const files = await readdir(directory);
    assert.equal(files.some(name => name.endsWith(".lock")), false, "retirement releases the owner lock");
    const dataFiles = files.filter(name => name.endsWith(".jsonl"));
    assert.ok(dataFiles.length >= 1, "the closed segment remains as retained history");
    let records = 0;
    for (const name of dataFiles) {
      const lines = (await readFile(join(directory, name), "utf8")).trim().split(/\r?\n/u);
      for (const line of lines) {
        const record = JSON.parse(line) as Record<string, unknown>;
        assert.equal(record["schemaVersion"], 1);
        assert.equal(typeof record["event"], "string");
        assert.equal(typeof record["sequence"], "number");
        assert.equal(typeof record["eventId"], "string");
        assert.equal(JSON.stringify(record).includes(SENTINEL), false, "no task sentinel reaches the journal");
        records += 1;
      }
    }
    assert.ok(records >= 3, "startup, admission and settlement records were all written");
    assert.equal(events(fixture).includes("quality.journal.closed"), true, "closure is retained as a diagnostic record");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K03-T08 an arbitrary elapsed rotation interval rotates through real time", async () => {
  const fixture = await startLifecycle({
    realClock: true,
    observability: { journal: { rotationIntervalMs: 300, compressArchives: true } },
  });
  try {
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_100));
    const status = fixture.session.status(true);
    assert.equal(status.journal?.lastRotation?.reason, "elapsed", "the elapsed interval, not a calendar boundary, drove rotation");
    assert.ok((status.journal?.closedSegments ?? 0) >= 1);
    assert.equal(status.journal?.state, "healthy");
    await retire(fixture);
    const directory = join(fixture.agentDir, "quality", "logs");
    const files = await readdir(directory);
    assert.ok(files.some(name => name.endsWith(".gz")), "the compressed archive reached the destination");
    assert.equal(files.some(name => name.endsWith(".tmp")), false);
    for (const name of files.filter(entry => entry.endsWith(".gz"))) {
      const info = await stat(join(directory, name));
      assert.ok(info.size > 0);
    }
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K03-T09a disabling the journal cannot clear operator stop across reload", async () => {
  const sessionId = `sess-k03-stop-${Date.now()}`;
  const root = await mkdtemp(join(tmpdir(), "qe-k03-stop-"));
  const first = await startLifecycle({ root, observedSessionId: sessionId, observability: { journal: { enabled: false } } });
  assert.equal(first.session.status(true).journal, null, "the diagnostic destination is disabled");
  first.session.requestOperatorStop();
  await settle();
  await retire(first, "quit");

  const replacement = await startLifecycle({
    root,
    observedSessionId: sessionId,
    observability: { journal: { enabled: false } },
    checks: { repetition: { triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }], context: "recent-work", prompt: "repetition", evaluator: "repetition-check", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
  });
  try {
    const restored = replacement.session.status(true);
    assert.equal(restored.journal, null);
    assert.equal(restored.runtime.restored, true, "the protected control state was restored");
    assert.equal(restored.runtime.control.state, "restored");
    assert.equal(restored.runtime.operatorStopped, true, "stop survives journal disablement and reload");
    work(replacement);
    tool(replacement, "t1");
    await settle();
    assert.equal(replacement.session.status(true).checks.runs, 0);
    assert.ok((replacement.session.status(true).checks.suppressedReasons["core.operator-stopped"] ?? 0) >= 1);
  } finally {
    await retire(replacement);
    await rm(replacement.root, { recursive: true, force: true });
  }
});

test("K03-T09b a failed control checkpoint suspends dependent admission only", async () => {
  const fixture = await startLifecycle();
  try {
    work(fixture);
    const stateRoot = join(fixture.agentDir, "quality", "state");
    await rm(stateRoot, { recursive: true, force: true });
    await writeFile(stateRoot, "not a directory", "utf8");
    const reloaded = await fixture.session.reloadConfiguration();
    assert.equal(reloaded.ok, true, "configuration reload itself is not a paid effect");
    const degraded = fixture.session.status(true);
    assert.equal(degraded.runtime.control.state, "degraded", "the failed protected write is visible");

    tool(fixture, "t1");
    await settle();
    const status = fixture.session.status(true);
    assert.equal(status.checks.runs, 0, "dependent autonomous admission is suspended");
    assert.ok((status.checks.suppressedReasons["core.control-degraded"] ?? 0) >= 1, "the denial names the control reason");
    assert.ok(status.diagnostics.historyRecords > 0, "diagnostics keep working independently");
    assert.equal(status.journal?.state, "healthy", "the diagnostic sink is independent of the control checkpoint");
    assert.equal(status.observation.completedPrimaryTools, 1, "primary observation keeps working");
    await unlink(stateRoot).catch(() => undefined);
  } finally {
    await retire(fixture);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("K04-R8j material-receipt uncertainty survives protected restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-uncertain-"));
  const clock = { nowUtc: () => new Date().toISOString() };
  try {
    const opened = await ControlCheckpoint.open({ agentDir: root, observedSessionId: "unit-r8j", ownerGeneration: "gen-1", configurationRevision: "rev-1", clock });
    assert.equal(opened.financialUncertain, false);
    opened.checkpoint.setLocalState({ operatorStopped: false, observerPaused: false, financialUncertain: true });
    assert.equal((await opened.checkpoint.commit()).ok, true);
    await opened.checkpoint.close();
    const reopened = await ControlCheckpoint.open({ agentDir: root, observedSessionId: "unit-r8j", ownerGeneration: "gen-2", configurationRevision: "rev-1", clock });
    assert.equal(reopened.financialUncertain, true, "a generation change is not financial reauthorization");
    await reopened.checkpoint.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
