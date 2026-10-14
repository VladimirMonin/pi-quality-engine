import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { EngineSession } from "../src/runtime.js";
import { ObservationStore } from "../src/observation.js";
import type { EngineSessionInput, PrimaryHostEvent } from "../src/runtime.js";
import type { ContextDefinition, PackageDefinition, TriggerDefinition } from "../src/contracts.js";
import type { EngineClock } from "../src/scheduling.js";

const RESOURCES_DIR = join(process.cwd(), "resources");

class ControlledClock implements EngineClock {
  #monoMs = 1_000;
  #timers: Array<{ at: number; callback: () => void; cancelled: boolean }> = [];

  nowMonoMs(): number {
    return this.#monoMs;
  }

  nowUtc(): string {
    return new Date(this.#monoMs).toISOString();
  }

  setTimer(delayMs: number, callback: () => void): () => void {
    const entry = { at: this.#monoMs + Math.max(0, delayMs), callback, cancelled: false };
    this.#timers.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  /** Fires every timer due within `ms`, in time order. */
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
}

interface LoopFixture {
  root: string;
  agentDir: string;
  projectConfigDir: string;
  clock: ControlledClock;
  session: EngineSession;
}

async function startLoop(check: object, observability: object = {}, contextsOverride?: object): Promise<LoopFixture> {
  const root = await mkdtemp(join(tmpdir(), "qe-loop-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  const config = {
    schemaVersion: 1,
    enabled: true,
    mode: "observe",
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: contextsOverride ?? {
      "recent-work": {
        providers: [
          { id: "task", use: "core.task" },
          { id: "history", use: "core.history", options: { limit: 12, includeToolBodies: false } },
          { id: "waits", use: "core.waits" },
        ],
        maxEstimatedTokens: 4000,
      },
    },
    evaluators: { "repetition-check": { use: "core.repeated-tools", options: { window: 12, minimumRepeats: 3 } } },
    policies: { record: { use: "core.record-only" } },
    checks: { repetition: check },
    observability,
  };
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(config), "utf8");
  const clock = new ControlledClock();
  const input: EngineSessionInput & { hostIdleAtStart: boolean } = {
    observedSessionId: `sess-${process.pid}-${Date.now()}`,
    branchId: "unresolved",
    agentDir,
    projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: RESOURCES_DIR,
    clock,
    hostIdleAtStart: true,
  };
  const session = await EngineSession.start(input);
  return { root, agentDir, projectConfigDir, clock, session };
}

async function closeLoop(fixture: LoopFixture): Promise<void> {
  fixture.session.retire("quit");
  await rm(fixture.root, { recursive: true, force: true });
}

async function settle(): Promise<void> {
  // Let pending microtasks from asynchronous context/evaluator boundaries settle.
  await new Promise(resolve => setTimeout(resolve, 20));
}

type WithoutTimestamp<T> = T extends { occurredAt: string } ? Omit<T, "occurredAt"> : never;

function send(fixture: LoopFixture, event: WithoutTimestamp<PrimaryHostEvent>): void {
  fixture.session.handlePrimaryEvent({ ...event, occurredAt: fixture.clock.nowUtc() } as PrimaryHostEvent);
}

function toolSequence(fixture: LoopFixture, id: string, toolName = "read"): void {
  send(fixture, { type: "tool-started", operationId: id, toolName, parentOperationId: null });
  send(fixture, { type: "tool-completed", operationId: id, toolName, parentOperationId: null, isError: false, durationMs: 5 });
}

function workInput(fixture: LoopFixture, text = "assess repetition"): void {
  send(fixture, { type: "operator-input", text, source: "interactive" });
}

function eventNames(fixture: LoopFixture): string[] {
  return fixture.session.status(true).diagnostics.recentEvents.map(record => record.event);
}

function eventData(fixture: LoopFixture, event: string): Array<Record<string, unknown>> {
  return fixture.session.status(true).diagnostics.recentEvents
    .filter(record => record.event === event)
    .map(record => record.fields.data as Record<string, unknown>);
}

const countCheck = (count: number, extra: object = {}): object => ({
  triggers: [{ id: "every-count", use: "core.every-tools", options: { count } }],
  context: "recent-work",
  prompt: "repetition",
  evaluator: "repetition-check",
  policy: "record",
  cooldownMs: 0,
  criteria: ["efficiency.repetition"],
  ...extra,
});

test("K02-T01 count threshold fires once on the fifth unique completion", async () => {
  const fixture = await startLoop(countCheck(5));
  try {
    workInput(fixture);
    for (const id of ["t1", "t2", "t3", "t4"]) toolSequence(fixture, id);
    await settle();
    assert.equal(fixture.session.status(true).checks.runs, 0, "no early check before the threshold");
    assert.equal(fixture.session.status(true).observation.completedPrimaryTools, 4);

    toolSequence(fixture, "t5");
    await settle();
    let status = fixture.session.status(true);
    assert.equal(status.observation.completedPrimaryTools, 5);
    assert.equal(status.checks.runs, 1, "exactly one admitted run at the threshold");
    assert.ok(eventNames(fixture).includes("quality.check.settled"));
    const due = eventData(fixture, "quality.trigger.due")[0];
    assert.equal(due?.["basis"], "count");
    assert.deepEqual(due?.["measurements"], {
      counter: "completedPrimaryTools",
      value: 5,
      threshold: 5,
      crossedThresholds: 1,
      elapsedMs: null,
      thresholdMs: null,
      lastActivityAgeMs: null,
      lastProgressAgeMs: null,
      activeOperationCount: 0,
    });

    // Duplicate terminal reports for an already counted operation, and a nested
    // completion, must not advance the counter or create a second crossing.
    send(fixture, { type: "tool-completed", operationId: "t5", toolName: "read", parentOperationId: null, isError: false, durationMs: 5 });
    send(fixture, { type: "tool-completed", operationId: "t5", toolName: "read", parentOperationId: null, isError: false, durationMs: 5 });
    send(fixture, { type: "tool-started", operationId: "nested-1", toolName: "grep", parentOperationId: "t5" });
    send(fixture, { type: "tool-completed", operationId: "nested-1", toolName: "grep", parentOperationId: "t5", isError: false, durationMs: 2 });
    await settle();
    status = fixture.session.status(true);
    assert.equal(status.observation.completedPrimaryTools, 5);
    assert.equal(status.checks.runs, 1, "duplicates and nested completions create no second run");
  } finally {
    await closeLoop(fixture);
  }
});

test("K02-T01b observer-origin completions never advance the primary counter", async () => {
  const fixture = await startLoop(countCheck(1));
  try {
    const store = new ObservationStore({
      observedSessionId: "sess-observer",
      branchId: "unresolved",
      runtimeGeneration: "gen-unit",
      episodeId: null,
      authorizationRevision: "auth-0",
    });
    const reviewer = store.publish(
      { ownerId: "core.reviewer-session", kind: "owned-reviewer" },
      {
        externalId: "reviewer-tool-1",
        kind: "core.tool-completed",
        occurredAt: "2026-10-14T00:00:00.000Z",
        visibility: "complete",
        facts: { operationId: "r1", toolName: "read", outcome: "success", readOnly: true, outputBytes: null },
        evidenceIds: [],
      },
      { receivedMonoMs: 1 },
    );
    assert.equal(reviewer.ok, true);
    assert.equal(store.view().counters.completedPrimaryTools, 0, "reviewer work is not primary cadence");
    assert.equal(fixture.session.status(true).checks.runs, 0);
  } finally {
    await closeLoop(fixture);
  }
});

test("K02-T02 a real deadline admits one check without a new completion", async () => {
  const fixture = await startLoop({
    triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 1_000, requireNewEvidence: true } }],
    context: "recent-work",
    prompt: "repetition",
    evaluator: "repetition-check",
    policy: "record",
    cooldownMs: 0,
    criteria: ["efficiency.repetition"],
  });
  try {
    workInput(fixture);
    toolSequence(fixture, "t1");
    await settle();
    assert.equal(fixture.session.status(true).checks.runs, 0, "nothing due before the interval");

    fixture.clock.advance(1_000);
    await settle();
    let status = fixture.session.status(true);
    assert.equal(status.checks.runs, 1, "one diagnostic check admitted by time");
    assert.equal(status.observation.completedPrimaryTools, 1, "the timer added no primary completion");
    const due = eventData(fixture, "quality.trigger.due");
    assert.equal(due[0]?.["basis"], "time");
    assert.equal(due[0]?.["measurements"] !== null && (due[0]?.["measurements"] as Record<string, unknown>)["thresholdMs"], 1_000);

    // No new evidence since the last intent: the next interval declines.
    fixture.clock.advance(1_000);
    await settle();
    status = fixture.session.status(true);
    assert.equal(status.checks.runs, 1, "requireNewEvidence declines a no-new-evidence interval");
    assert.equal(status.observation.completedPrimaryTools, 1);
  } finally {
    await closeLoop(fixture);
  }
});

test("K02-T03 count and time coalesce while a contribution context boundary is held", async () => {
  const fixture = await startLoop({
    triggers: [
      { id: "every-count", use: "core.every-tools", options: { count: 2 } },
      { id: "periodic", use: "core.periodic", options: { everyMs: 500, requireNewEvidence: true } },
    ],
    context: "held-work",
    prompt: "repetition",
    evaluator: "repetition-check",
    policy: "record",
    cooldownMs: 0,
    criteria: ["efficiency.repetition"],
  }, {}, {
    "held-work": {
      providers: [
        { id: "held", use: "fixture.held-context" },
        { id: "waits", use: "core.waits" },
      ],
    },
  });
  try {
    // Register a real contribution whose context provider is held by the test.
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const provider: ContextDefinition = {
      id: "fixture.held-context",
      apiMajor: 1,
      kind: "context",
      produces: ["json"],
      optionsSchema: { type: "object", additionalProperties: false },
      requiredCapabilities: [],
      diagnosticCodes: ["fixture.held"],
      async collect() {
        await gate;
        return {
          ok: true,
          value: {
            items: [{
              id: "fixture-item",
              role: "evidence",
              required: false,
              content: [{ type: "json", value: { note: "contribution" } }],
              provenance: {
                sourceId: "fixture.held-context",
                uri: "fixture:item",
                revision: "fixture-rev-1",
                acquiredAt: new Date().toISOString(),
                selection: { kind: "full" },
                changedDuringRead: false,
              },
              bytes: 24,
              tokenEstimate: null,
            }],
            coverage: { state: "complete", scopeDescription: "Held fixture source.", issues: [] },
            dependencies: [],
          },
        };
      },
    };
    const packageDefinition: PackageDefinition = {
      id: "fixture.contribution",
      version: "0.0.1",
      baseUri: "fixture:contribution",
      components: [provider],
      resources: {},
    };
    const registration = fixture.session.endpoint.register(packageDefinition);
    assert.equal(registration.ok, true);
    if (!registration.ok) return;
    await registration.value.ready;
    await settle();

    workInput(fixture);
    toolSequence(fixture, "t1");
    toolSequence(fixture, "t2");
    await settle();
    // Run one is admitted by count and held at the contribution boundary.
    fixture.clock.advance(500);
    await settle();
    let status = fixture.session.status(true);
    assert.equal(status.checks.runs, 0, "held run has not settled yet");
    const admissions = eventData(fixture, "quality.check.admission");
    const coalesced = admissions.filter(entry => entry["outcome"] === "coalesced");
    assert.equal(coalesced.length, 1, "the time reason coalesces into the active run");
    assert.match(String(coalesced[0]?.["mergedIntoRunId"]), /^run-\d+$/);
    const due = eventData(fixture, "quality.trigger.due");
    assert.deepEqual([...new Set(due.map(entry => entry["basis"]))].sort(), ["count", "time"]);

    release();
    await settle();
    status = fixture.session.status(true);
    assert.equal(status.checks.runs, 2, "the coalesced pending intent runs after the held run settles");
    const settled = eventData(fixture, "quality.check.settled");
    assert.equal(settled.length, 2);
    const manifestParts = eventData(fixture, "quality.context.manifest-part");
    assert.ok(manifestParts.length >= 2);
    const items = manifestParts[0]?.["items"] as Array<Record<string, unknown>> | undefined;
    assert.ok(items?.some(item => item["sourceId"] === "fixture.held-context"));
  } finally {
    await closeLoop(fixture);
  }
});

test("K02-T04 a known active wait is diagnosed, not treated as abandonment", async () => {
  const fixture = await startLoop({
    triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 100, requireNewEvidence: false } }],
    context: "recent-work",
    prompt: "repetition",
    evaluator: "repetition-check",
    policy: "record",
    cooldownMs: 0,
    criteria: ["efficiency.repetition"],
  });
  try {
    workInput(fixture);
    send(fixture, { type: "tool-started", operationId: "long-1", toolName: "bash", parentOperationId: null });
    await settle();
    fixture.clock.advance(100);
    await settle();
    fixture.clock.advance(100);
    await settle();
    const status = fixture.session.status(true);
    assert.equal(status.observation.activeOperations, 1, "the identified operation is still active");
    assert.ok(status.checks.runs >= 1, "temporal diagnosis proceeds while the wait is known");
    const manifestParts = eventData(fixture, "quality.context.manifest-part");
    const waitItems = manifestParts.flatMap(part => (part["items"] as Array<Record<string, unknown>>) ?? [])
      .filter(item => item["sourceId"] === "core.waits");
    assert.ok(waitItems.length >= 1, "the wait is reported as evidence");
    assert.ok(waitItems.some(item => item["disposition"] === "included"));
    assert.equal(eventNames(fixture).some(name => name.startsWith("quality.action.")), false);
  } finally {
    await closeLoop(fixture);
  }
});

test("K02-T05 operator stop denies the due callback and cannot be cleared by time", async () => {
  const fixture = await startLoop({
    triggers: [
      { id: "every-count", use: "core.every-tools", options: { count: 2 } },
      { id: "periodic", use: "core.periodic", options: { everyMs: 100, requireNewEvidence: false } },
    ],
    context: "recent-work",
    prompt: "repetition",
    evaluator: "repetition-check",
    policy: "record",
    cooldownMs: 0,
    criteria: ["efficiency.repetition"],
  });
  try {
    workInput(fixture);
    fixture.session.requestOperatorStop();
    toolSequence(fixture, "t1");
    toolSequence(fixture, "t2");
    fixture.clock.advance(100);
    await settle();
    const status = fixture.session.status(true);
    assert.equal(status.runtime.operatorStopped, true);
    assert.equal(status.checks.runs, 0, "no check is admitted after Stop");
    assert.ok((status.checks.suppressedReasons["core.operator-stopped"] ?? 0) >= 1);
    assert.equal(eventNames(fixture).includes("quality.check.started"), false);
    const denials = eventData(fixture, "quality.check.admission").filter(entry => entry["outcome"] === "denied");
    assert.ok(denials.length >= 1);
    assert.deepEqual(denials[0]?.["reasonCodes"], ["core.operator-stopped"]);
  } finally {
    await closeLoop(fixture);
  }
});

test("K02-T07 Standard history and journal exclude task and tool sentinels", async () => {
  const taskSentinel = "k02-task-body-sentinel-4c1d";
  const errorSentinel = "k02-tool-error-sentinel-9a7f";
  const fixture = await startLoop(countCheck(1));
  try {
    workInput(fixture, `please review this diff ${taskSentinel}`);
    send(fixture, { type: "tool-started", operationId: "e1", toolName: "bash", parentOperationId: null });
    send(fixture, { type: "tool-completed", operationId: "e1", toolName: "bash", parentOperationId: null, isError: true, durationMs: 9 });
    await settle();
    const status = fixture.session.status(true);
    const historyText = status.diagnostics.recentEvents.map(record => JSON.stringify(record)).join("\n");
    const journalPath = join(fixture.agentDir, "quality", "logs");
    const journalFiles = await readdir(journalPath);
    assert.equal(journalFiles.length, 1);
    const journalText = await readFile(join(journalPath, journalFiles[0] as string), "utf8");
    for (const sentinel of [taskSentinel, errorSentinel]) {
      assert.equal(historyText.includes(sentinel), false, `history leaked ${sentinel}`);
      assert.equal(journalText.includes(sentinel), false, `journal leaked ${sentinel}`);
    }
    assert.ok(journalText.includes("\"quality.check.settled\""), "the journal contains the real check settlement");
    assert.ok(journalText.includes("quality.trigger.due"), "positive control: the journal is useful, not empty");
    assert.ok(status.diagnostics.historyRecords > 0);
    assert.ok(status.diagnostics.historyBytes > 0);
    assert.ok(status.diagnostics.historyRecords <= 512);
  } finally {
    await closeLoop(fixture);
  }
});

test("K02-T06 a registered contribution trigger and context affect a real check and retire cleanly", async () => {
  const fixture = await startLoop({
    triggers: [{ id: "fixture-count", use: "fixture.contribution-trigger", options: { count: 2 } }],
    context: "fixture-context",
    prompt: "repetition",
    evaluator: "repetition-check",
    policy: "record",
    cooldownMs: 0,
    criteria: ["efficiency.repetition"],
  }, {}, {
    "fixture-context": {
      providers: [{ id: "fixture", use: "fixture.contribution-context" }],
    },
  });
  try {
    let status = fixture.session.status(true);
    assert.equal(status.checks.detail[0]?.state, "waiting", "check waits for the independent component");

    const trigger: TriggerDefinition = {
      id: "fixture.contribution-trigger",
      apiMajor: 1,
      kind: "trigger",
      optionsSchema: { type: "object", properties: { count: { type: "integer" } }, required: ["count"], additionalProperties: false },
      requiredCapabilities: ["fixture.capability"],
      diagnosticCodes: ["fixture.due"],
      initialState: () => ({ seen: 0 }),
      update(options, input) {
        if (input.cause !== "observation" || input.observation?.kind !== "core.tool-completed") {
          return { state: input.state, intent: null, nextDueMonoMs: null };
        }
        const seen = Number((input.state as { seen?: number }).seen ?? 0) + 1;
        const count = Number(options["count"]);
        if (seen >= count) {
          return {
            state: { seen: 0 },
            intent: { reasons: [{ code: "fixture.due", evidenceIds: [input.observation.id] }] },
            nextDueMonoMs: null,
          };
        }
        return { state: { seen }, intent: null, nextDueMonoMs: null };
      },
    };
    const provider: ContextDefinition = {
      id: "fixture.contribution-context",
      apiMajor: 1,
      kind: "context",
      produces: ["json"],
      optionsSchema: { type: "object", additionalProperties: false },
      requiredCapabilities: [],
      diagnosticCodes: ["fixture.context"],
      collect: async () => ({
        ok: true,
        value: {
          items: [{
            id: "fixture-context-item",
            role: "evidence",
            required: false,
            content: [{ type: "json", value: { note: "independent" } }],
            provenance: {
              sourceId: "fixture.contribution-context",
              uri: "fixture:evidence",
              revision: "fixture-rev-1",
              acquiredAt: new Date().toISOString(),
              selection: { kind: "full" },
              changedDuringRead: false,
            },
            bytes: 24,
            tokenEstimate: null,
          }],
          coverage: { state: "complete", scopeDescription: "Independent fixture source.", issues: [] },
          dependencies: [],
        },
      }),
    };
    const packageDefinition: PackageDefinition = {
      id: "fixture.contribution",
      version: "0.1.0",
      baseUri: "fixture:contribution",
      components: [trigger, provider],
      resources: {},
    };
    const first = fixture.session.endpoint.register(packageDefinition);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const duplicate = fixture.session.endpoint.register({
      id: "fixture.other-owner",
      version: "0.1.0",
      baseUri: "fixture:other",
      components: [{ ...trigger }],
      resources: {},
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, "core.duplicate-component");

    const second = fixture.session.endpoint.register(packageDefinition);
    assert.equal(second.ok, true, "the same instance registration is idempotent");
    await first.value.ready;
    await settle();

    status = fixture.session.status(true);
    assert.equal(status.checks.detail[0]?.state, "active", "the dependent check activates after readiness");
    const lifecycle = eventData(fixture, "quality.component.lifecycle");
    assert.ok(lifecycle.some(entry => entry["componentId"] === "fixture.contribution-trigger" && entry["phase"] === "ready"));
    assert.ok(status.registry.packages.some(entry => entry.packageId === "fixture.contribution" && entry.phase === "ready"));

    workInput(fixture);
    toolSequence(fixture, "t1");
    toolSequence(fixture, "t2");
    await settle();
    assert.equal(fixture.session.status(true).checks.runs, 1, "the contribution trigger reached the real check path");
    const manifestParts = eventData(fixture, "quality.context.manifest-part");
    const items = manifestParts.flatMap(part => (part["items"] as Array<Record<string, unknown>>) ?? []);
    assert.ok(items.some(item => item["sourceId"] === "fixture.contribution-context"));

    await first.value.dispose();
    await settle();
    status = fixture.session.status(true);
    const inventory = status.registry.packages.find(entry => entry.packageId === "fixture.contribution");
    assert.equal(inventory?.phase, "disposed");
    assert.ok(eventData(fixture, "quality.component.lifecycle").some(entry => entry["phase"] === "disposed"));
    assert.equal(status.checks.detail[0]?.state, "waiting", "the dependent check visibly waits again after disposal");
  } finally {
    await closeLoop(fixture);
  }
});

test("K02-T05b the /quality stop command is an operator action that blocks later runs", async () => {
  const fixture = await startLoop(countCheck(1));
  try {
    fixture.session.requestOperatorStop();
    toolSequence(fixture, "t1");
    await new Promise(resolve => setTimeout(resolve, 20));
    const status = fixture.session.status(true);
    assert.equal(status.runtime.operatorStopped, true);
    assert.equal(status.checks.runs, 0);
    assert.ok(eventData(fixture, "quality.runtime.state").length >= 1);
  } finally {
    await closeLoop(fixture);
  }
});

test("K02-B.10 a bounded journal degrades visibly while history keeps working", async () => {
  const fixture = await startLoop(countCheck(1), {
    journal: { maxFileBytes: 4_096 },
  });
  try {
    workInput(fixture);
    for (const id of ["t1", "t2", "t3"]) {
      toolSequence(fixture, id);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const status = fixture.session.status(true);
    assert.equal(status.checks.runs, 3, "checks still execute when the journal is full");
    assert.equal(status.journal?.state, "failed");
    assert.equal(status.journal?.reasonCode, "journal-size-limit");
    assert.ok((status.journal?.lostRecords ?? 0) >= 1, "lost journal records stay visible");
    assert.ok(status.diagnostics.historyRecords > 0, "bounded history is independent of the sink");
    assert.ok((status.journal?.lostRecords ?? 0) > 0, "the failed sink keeps explicit loss accounting");
  } finally {
    await closeLoop(fixture);
  }
});

test("K02-B.04/D-09 a spinning trigger is disabled instead of looping the event loop", async () => {
  const fixture = await startLoop({
    triggers: [{ id: "spin", use: "fixture.spin-trigger", options: {} }],
    context: "recent-work",
    prompt: "repetition",
    evaluator: "repetition-check",
    policy: "record",
    cooldownMs: 0,
    criteria: ["efficiency.repetition"],
  });
  try {
    const spinTrigger: TriggerDefinition = {
      id: "fixture.spin-trigger",
      apiMajor: 1,
      kind: "trigger",
      optionsSchema: { type: "object", additionalProperties: false },
      requiredCapabilities: [],
      diagnosticCodes: [],
      initialState: () => ({ touched: 0 }),
      update(_options, input) {
        if (input.cause === "activation") {
          return { state: input.state, intent: null, nextDueMonoMs: input.now.monoMs };
        }
        if (input.cause === "deadline") {
          return { state: input.state, intent: { reasons: [{ code: "fixture.spin", evidenceIds: [] }] }, nextDueMonoMs: input.now.monoMs };
        }
        return { state: input.state, intent: null, nextDueMonoMs: null };
      },
    };
    const registration = fixture.session.endpoint.register({
      id: "fixture.spin",
      version: "0.0.1",
      baseUri: "fixture:spin",
      components: [spinTrigger],
      resources: {},
    });
    assert.equal(registration.ok, true);
    if (!registration.ok) return;
    await registration.value.ready;
    await new Promise(resolve => setTimeout(resolve, 20));
    fixture.clock.advance(5);
    await new Promise(resolve => setTimeout(resolve, 30));
    const status = fixture.session.status(true);
    assert.ok((status.checks.suppressedReasons["core.trigger-spin"] ?? 0) >= 1, "the spinning binding is disabled");
    assert.equal(status.checks.runs, 0);
  } finally {
    await closeLoop(fixture);
  }
});
