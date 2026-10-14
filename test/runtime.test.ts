import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ENGINE_VERSION, EngineSession, inspectInactiveSession } from "../src/runtime.js";
import type { EngineSessionInput } from "../src/runtime.js";

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
  };
}

async function writeConfig(path: string, contents: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(contents), "utf8");
}

test("session start creates one inactive observation generation with lifecycle records", async () => {
  await withFixture(async paths => {
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdle: true });
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
      assert.equal(status.capabilities.journalFiles, "unavailable");
      assert.equal(status.diagnostics.detail, "standard");
      assert.equal(status.diagnostics.capture, "none");
      assert.deepEqual(status.diagnostics.recentEvents.map(record => record.event), ["quality.runtime.started"]);
      assert.equal(status.diagnostics.recentEvents[0]?.fields.data["engineVersion"], ENGINE_VERSION);
    } finally {
      session.retire("quit");
    }
  });
});

test("retirement is idempotent and reports shutdown without unsettled work", async () => {
  await withFixture(async paths => {
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdle: true });
    session.retire("quit");
    session.retire("quit");
    const status = session.status(true);
    assert.equal(status.runtime.state, "retired");
    assert.equal(status.runtime.executionState, "shutdown");
    assert.ok(status.runtime.retiredAt);
    assert.deepEqual(status.diagnostics.recentEvents.map(record => record.event), [
      "quality.runtime.started",
      "quality.runtime.retired",
    ]);
    const retired = status.diagnostics.recentEvents[1];
    assert.equal(retired?.fields.data["cause"], "quit");
    assert.equal(retired?.fields.data["unsettledOperations"], 0);
    assert.equal(retired?.fields.data["journalFlushState"], "not-implemented");
  });
});

test("a cold invalid configuration is rejected before activation and stays ineffective", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.json"), { schemaVersion: 1, [SENTINEL]: SENTINEL });
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdle: true });
    try {
      const status = session.status(true);
      assert.deepEqual(status.diagnostics.recentEvents.map(record => record.event), [
        "quality.config.rejected",
        "quality.runtime.started",
      ]);
      const rejection = status.diagnostics.recentEvents[0];
      assert.equal(rejection?.fields.data["runtimeUnchanged"], true);
      assert.deepEqual(rejection?.fields.data["fieldPaths"], ["$"]);
      assert.deepEqual(rejection?.fields.data["errorCodes"], ["config.unknown-key"]);
      assert.deepEqual(status.configuration.rejection, { origin: "user", errorCode: "config.unknown-key", field: "$" });
      assert.deepEqual(status.configuration.sources, { user: "rejected", project: "absent" });
      assert.equal(JSON.stringify(status).includes(SENTINEL), false);
    } finally {
      session.retire("quit");
    }
  });
});

test("each session generation owns its own identity and diagnostic sequence", async () => {
  await withFixture(async paths => {
    const first = await EngineSession.start({ ...sessionInput(paths), hostIdle: true });
    const second = await EngineSession.start({ ...sessionInput(paths), hostIdle: true });
    try {
      assert.notEqual(first.generation, second.generation);
      assert.deepEqual(second.status(true).diagnostics.recentEvents.map(record => record.sequence), [1]);
      assert.equal(first.status(true).runtime.generation, first.generation);
    } finally {
      first.retire("replaced");
      second.retire("quit");
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
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdle: false });
    try {
      const busy = session.status(false);
      assert.equal(busy.runtime.executionState, "unknown");
      assert.equal(busy.diagnostics.recentEvents[0]?.fields.data["executionState"], "unknown");
      assert.equal(session.status(true).runtime.executionState, "idle");
      assert.equal(session.status(true).diagnostics.recentEvents[0]?.fields.data["executionState"], "unknown");
    } finally {
      session.retire("quit");
    }
  });
});

test("zero recent-history limits retain no records while accounting drops", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.json"), {
      schemaVersion: 1,
      observability: { recentHistory: { maxEvents: 0, maxBytes: 0 } },
    });
    const session = await EngineSession.start({ ...sessionInput(paths), hostIdle: true });
    try {
      const status = session.status(true);
      assert.equal(status.configuration.rejection, null);
      assert.deepEqual(status.configuration.recentHistory, { maxEvents: 0, maxBytes: 0 });
      assert.equal(status.diagnostics.historyRecords, 0);
      assert.deepEqual(status.diagnostics.recentEvents, []);
      assert.ok(status.diagnostics.droppedRecords >= 1);
    } finally {
      session.retire("quit");
    }
  });
});
