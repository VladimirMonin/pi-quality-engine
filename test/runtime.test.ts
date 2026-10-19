import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ENGINE_VERSION, EngineSession, inspectInactiveSession } from "../src/runtime.js";
import type { EngineSessionInput } from "../src/runtime.js";
import type { ObservationContext, ObservationDraft } from "../src/contracts.js";

const SENTINEL = "k01-private-fixture-sentinel-7f3a";

interface FixturePaths {
  agentDir: string;
  projectConfigDir: string;
}

async function withFixture(run: (paths: FixturePaths) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "qe-runtime-"));
  try {
    await run({ agentDir: join(root, "agent"), projectConfigDir: join(root, "project", ".pi") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function sessionInput(paths: FixturePaths): EngineSessionInput {
  return {
    observedSessionId: "sess-fixture",
    branchId: "unresolved",
    agentDir: paths.agentDir,
    projectConfigDir: paths.projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: join(process.cwd(), "resources"),
  };
}

async function writeConfig(path: string, contents: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(contents), "utf8");
}

test("session start creates one inactive observation generation with lifecycle records", async () => {
  await withFixture(async paths => {
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdleAtStart: true });
    try {
      const status = session.status(true);
      assert.equal(status.engine.version, ENGINE_VERSION);
      assert.equal(status.runtime.state, "active");
      assert.match(status.runtime.generation ?? "", /^gen-\d+$/);
      assert.equal(status.runtime.executionState, "idle");
      assert.equal(status.runtime.workState, "unknown");
      assert.equal(status.runtime.restored, false);
      assert.equal(status.configuration.enabled, false);
      assert.equal(status.configuration.mode, "observe");
      assert.equal(status.configuration.rejection, null);
      assert.equal(status.activation.coldActivation, "disabled");
      assert.equal(status.activation.autonomousModelCalls, "unavailable");
      assert.equal(status.capabilities.configurationDiscovery, "available");
      assert.equal(status.capabilities.modelEvaluation, "unavailable");
      assert.equal(status.capabilities.journalFiles, "available");
      assert.equal(status.capabilities.triggersAndScheduling, "available");
      assert.equal(status.capabilities.deterministicEvaluation, "available");
      assert.equal(status.diagnostics.detail, "standard");
      assert.equal(status.diagnostics.capture, "none");
      assert.deepEqual(status.diagnostics.recentEvents.map(record => record.event), [
        "quality.runtime.started",
        "quality.config.applied",
      ]);
      assert.equal(status.diagnostics.recentEvents[0]?.fields.data["engineVersion"], ENGINE_VERSION);
      assert.equal(status.journal, null, "a cold disabled engine opens no journal file");
    } finally {
      await session.retire("quit");
    }
  });
});

test("public observation publication validates copied schemas, owned references and detached JSON", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.json"), { schemaVersion: 1, enabled: true, observationSources: { feed: { use: "fixture.source" } } });
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdleAtStart: true });
    let context: ObservationContext | undefined, disposals = 0, getters = 0;
    const schema = { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"], additionalProperties: false };
    const registration = session.endpoint.register({ id: "fixture.source-package", version: "1.0.0", baseUri: "fixture:sources", resources: {}, components: [{
      id: "fixture.source", apiMajor: 1, kind: "observation", requiredCapabilities: [], diagnosticCodes: [], optionsSchema: { type: "object", additionalProperties: false }, observationSchemas: { "fixture.signal": schema },
      start(options, ctx) { options["callerMutation"] = true; context = ctx; return { dispose() { disposals += 1; } }; },
    }] });
    assert.equal(registration.ok, true); if (!registration.ok) return;
    schema.properties.changed.type = "string";
    await registration.value.ready;
    for (let i = 0; i < 20 && context === undefined; i += 1) await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(context);
    const draft: ObservationDraft = { externalId: "first", kind: "fixture.signal", occurredAt: context.clock().utc, visibility: "complete", facts: { changed: true }, evidenceIds: [] };
    const first = context.publish(draft); assert.equal(first.ok, true); if (!first.ok) return;
    assert.deepEqual(context.publish(draft), first, "same-source duplicate returns the original admitted identity");
    assert.equal(context.publish({ ...draft, externalId: "linked", evidenceIds: [first.value.observationId] }).ok, true);
    for (const evidenceId of ["obs-0", "obs-999999", "foreign-run"]) assert.equal(context.publish({ ...draft, externalId: evidenceId, evidenceIds: [evidenceId] }).ok, false);
    assert.equal(context.publish({ ...draft, externalId: "wrong-kind", kind: "core.operator-input" }).ok, false);
    assert.equal(context.publish({ ...draft, externalId: "bad-facts", facts: { changed: "invalid" } }).ok, false);
    const facts = {}; Object.defineProperty(facts, "changed", { enumerable: true, get() { getters += 1; return true; } });
    assert.equal(context.publish({ ...draft, externalId: "getter", facts }).ok, false); assert.equal(getters, 0);
    await session.retire("quit"); assert.equal(disposals, 1); assert.equal(context.signal.aborted, true);
    const stale = context.publish(draft); assert.equal(stale.ok, false); if (!stale.ok) assert.equal(stale.error.code, "core.retired-generation");
  });
});

test("cold observation definitions stay inert and a synchronous pause inside start disposes its returned handle", async () => {
  await withFixture(async paths => {
    const config = { schemaVersion: 1, enabled: false, observationSources: { feed: { use: "fixture.early-source" } } };
    const file = join(paths.agentDir, "quality", "config.json"); await writeConfig(file, config);
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdleAtStart: true });
    let starts = 0, disposals = 0;
    const registration = session.endpoint.register({ id: "fixture.early-source-package", version: "1.0.0", baseUri: "fixture:early", resources: {}, components: [{
      id: "fixture.early-source", apiMajor: 1, kind: "observation", requiredCapabilities: [], diagnosticCodes: [], optionsSchema: { type: "object" }, observationSchemas: {},
      start() { starts += 1; session.requestOperatorPause(); return { dispose() { disposals += 1; } }; },
    }] });
    assert.equal(registration.ok, true); if (!registration.ok) return; await registration.value.ready;
    session.status(true); session.status(true); assert.equal(starts, 0);
    config.enabled = true; await writeConfig(file, config); assert.equal((await session.reloadConfiguration()).ok, true);
    for (let i = 0; i < 20 && disposals === 0; i += 1) await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(starts, 1); assert.equal(disposals, 1); assert.equal(session.status(true).runtime.observerPaused, true);
    await session.retire("quit"); assert.equal(disposals, 1);
  });
});

test("failed observation start revokes publication, visibly waits and never retries on inspection or unrelated readiness", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.json"), {
      schemaVersion: 1, enabled: true, observationSources: { feed: { use: "fixture.failed-source" } },
      contexts: { work: { providers: [{ id: "task", use: "core.task" }] } }, prompts: { p: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      evaluators: { e: { use: "core.repeated-tools" } }, policies: { p: { use: "core.record-only" } },
      checks: { c: { triggers: [{ id: "one", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "p", evaluator: "e", policy: "p", criteria: ["efficiency.repetition"] } },
    });
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdleAtStart: true });
    let starts = 0, context: ObservationContext | undefined;
    const registered = session.endpoint.register({ id: "fixture.failed-source-package", version: "1.0.0", baseUri: "fixture:failed", resources: {}, components: [{
      id: "fixture.failed-source", apiMajor: 1, kind: "observation", requiredCapabilities: [], diagnosticCodes: [], optionsSchema: { type: "object" }, observationSchemas: {},
      start(_options, ctx) { starts += 1; context = ctx; throw new Error("K08_SOURCE_START_PRIVATE_SENTINEL"); },
    }] });
    assert.equal(registered.ok, true); if (!registered.ok) return; await registered.value.ready;
    for (let i = 0; i < 20 && context?.signal.aborted !== true; i += 1) await new Promise<void>(resolve => setImmediate(resolve));
    assert.ok(context); assert.equal(context.signal.aborted, true); assert.equal(starts, 1);
    const other = session.endpoint.register({ id: "fixture.other-package", version: "1.0.0", baseUri: "fixture:other", resources: {}, components: [{ id: "fixture.other-policy", apiMajor: 1, kind: "policy", requiredCapabilities: [], diagnosticCodes: [], optionsSchema: true, decide() { return { outcome: "no-action", reasonCode: "fixture.none", actions: [] }; } }] });
    assert.equal(other.ok, true); if (other.ok) assert.equal((await other.value.ready).ok, true);
    for (let i = 0; i < 3; i += 1) { const status = session.status(true); assert.equal(status.checks.detail[0]?.state, "waiting"); assert.ok(status.checks.detail[0]?.missing.includes("observation-source:feed")); assert.equal(JSON.stringify(status).includes("K08_SOURCE_START_PRIVATE_SENTINEL"), false); }
    assert.equal(starts, 1); await session.retire("quit");
  });
});

test("sink final records precede once-only disposal and no write follows it", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.json"), {
      schemaVersion: 1, enabled: true,
      observability: { sinks: [{ id: "fixture.close-order", options: {} }] },
    });
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdleAtStart: true });
    let writes = 0, disposals = 0, writesAfterDisposal = 0, closedBeforeDisposal = false;
    const registration = session.endpoint.register({
      id: "fixture.close-order-package", version: "1.0.0", baseUri: "fixture:close-order", resources: {},
      components: [{
        id: "fixture.close-order", apiMajor: 1, kind: "sink", requiredCapabilities: [], diagnosticCodes: [],
        optionsSchema: { type: "object", additionalProperties: false },
        create() {
          return {
            write(record) {
              writes += 1;
              if (disposals > 0) writesAfterDisposal += 1;
              if (record.event === "quality.journal.closed" && disposals === 0) closedBeforeDisposal = true;
            },
            async flush() {},
            dispose() { disposals += 1; },
          };
        },
      }],
    });
    assert.equal(registration.ok, true);
    if (!registration.ok) return;
    assert.equal((await registration.value.ready).ok, true);
    assert.equal((await session.reloadConfiguration()).ok, true);
    await session.retire("quit");
    await session.retire("quit");
    assert.ok(writes > 0);
    assert.equal(disposals, 1);
    assert.equal(writesAfterDisposal, 0, "a disposed destination is no longer a callback target");
    assert.equal(closedBeforeDisposal, true, "stopping illegal writes must not omit the final close marker");
  });
});

test("retirement is idempotent and reports shutdown without unsettled work", async () => {
  await withFixture(async paths => {
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdleAtStart: true });
    await session.retire("quit");
    await session.retire("quit");
    const status = session.status(true);
    assert.equal(status.runtime.state, "retired");
    assert.equal(status.runtime.executionState, "shutdown");
    assert.ok(status.runtime.retiredAt);
    assert.deepEqual(status.diagnostics.recentEvents.map(record => record.event), [
      "quality.runtime.started",
      "quality.config.applied",
      "quality.runtime.retired",
      "quality.journal.closed",
    ]);
    const retired = status.diagnostics.recentEvents[2];
    assert.equal(retired?.fields.data["cause"], "quit");
    assert.equal(retired?.fields.data["unsettledOperations"], 0);
    assert.equal(retired?.fields.data["journalFlushState"], "disabled");
  });
});

test("a cold invalid configuration is rejected before activation and stays ineffective", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.json"), { schemaVersion: 1, [SENTINEL]: SENTINEL });
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdleAtStart: true });
    try {
      const status = session.status(true);
      assert.deepEqual(status.diagnostics.recentEvents.map(record => record.event), [
        "quality.config.rejected",
        "quality.runtime.started",
        "quality.config.applied",
      ]);
      const rejection = status.diagnostics.recentEvents[0];
      assert.equal(rejection?.fields.data["runtimeUnchanged"], true);
      assert.deepEqual(rejection?.fields.data["fieldPaths"], ["$"]);
      assert.deepEqual(rejection?.fields.data["errorCodes"], ["config.unknown-key"]);
      assert.deepEqual(status.configuration.rejection, { origin: "user", errorCode: "config.unknown-key", field: "$" });
      assert.deepEqual(status.configuration.sources, { user: "rejected", project: "absent" });
      assert.equal(JSON.stringify(status).includes(SENTINEL), false);
    } finally {
      await session.retire("quit");
    }
  });
});

test("each session generation owns its own identity and diagnostic sequence", async () => {
  await withFixture(async paths => {
    const first = await EngineSession.start({ ...sessionInput(paths), hostIdleAtStart: true });
    const second = await EngineSession.start({ ...sessionInput(paths), hostIdleAtStart: true });
    try {
      assert.notEqual(first.generation, second.generation);
      // One protected owner per logical session: the later generation is
      // inspect-only and cannot act, while its own diagnostics still sequence.
      assert.equal(second.status(true).runtime.control.state, "conflict");
      assert.deepEqual(second.status(true).diagnostics.recentEvents.map(record => record.sequence), [1, 2, 3]);
      assert.deepEqual(second.status(true).diagnostics.recentEvents.map(record => record.event), [
        "quality.control.checkpoint",
        "quality.runtime.started",
        "quality.config.applied",
      ]);
      assert.equal(first.status(true).runtime.generation, first.generation);
    } finally {
      await first.retire("replaced");
      await second.retire("quit");
    }
  });
});

test("inactive inspection resolves configuration without creating a generation", async () => {
  await withFixture(async paths => {
    const status = await inspectInactiveSession(sessionInput(paths), true);
    assert.equal(status.runtime.state, "inactive");
    assert.equal(status.runtime.generation, null);
    assert.equal(status.runtime.startedAt, null);
    assert.equal(status.diagnostics.historyRecords, 0);
    assert.deepEqual(status.diagnostics.recentEvents, []);
    assert.equal(status.configuration.revision.startsWith("cfg-"), true);
  });
});

test("the engine identity constant matches the packaged version", async () => {
  const manifest = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as { name?: string; version?: string };
  assert.equal(manifest.name, "pi-quality-engine");
  assert.equal(manifest.version, ENGINE_VERSION);
});

test("a busy primary is never reported as idle", async () => {
  await withFixture(async paths => {
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdleAtStart: false });
    try {
      const busy = session.status(false);
      assert.equal(busy.runtime.executionState, "unknown");
      assert.equal(busy.diagnostics.recentEvents[0]?.fields.data["executionState"], "unknown");
      assert.equal(session.status(true).runtime.executionState, "idle");
      assert.equal(session.status(true).diagnostics.recentEvents[0]?.fields.data["executionState"], "unknown");
    } finally {
      await session.retire("quit");
    }
  });
});

test("zero recent-history limits retain no records while accounting drops", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.json"), {
      schemaVersion: 1,
      observability: { recentHistory: { maxEvents: 0, maxBytes: 0 } },
    });
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdleAtStart: true });
    try {
      const status = session.status(true);
      assert.equal(status.configuration.rejection, null);
      assert.deepEqual(status.configuration.recentHistory, { maxEvents: 0, maxBytes: 0 });
      assert.equal(status.diagnostics.historyRecords, 0);
      assert.deepEqual(status.diagnostics.recentEvents, []);
      assert.ok(status.diagnostics.droppedRecords >= 1);
    } finally {
      await session.retire("quit");
    }
  });
});
