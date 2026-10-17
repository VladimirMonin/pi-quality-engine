import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = process.env.QE_PACKAGE_ROOT ?? process.cwd();
const extensionEntry = resolve(packageRoot, "dist/index.js");
const contractsEntry = resolve(packageRoot, "dist/contracts.js");
const evidenceDir = process.env.QE_EVIDENCE_DIR;
const SENTINEL = "k01-private-fixture-sentinel-7f3a";

const noop = () => {};

function createExtensionActions(effects) {
  return {
    sendMessage: () => { effects.sendMessage += 1; },
    sendUserMessage: () => { effects.sendUserMessage += 1; },
    appendEntry: () => { effects.appendEntry += 1; },
    setSessionName: noop,
    getSessionName: () => undefined,
    setLabel: noop,
    getActiveTools: () => [],
    getAllTools: () => [],
    getSettings: () => ({}),
    setActiveTools: noop,
    refreshTools: noop,
    getCommands: () => [],
    setModel: noop,
    getThinkingLevel: () => "off",
    setThinkingLevel: noop,
  };
}

function createContextActions(projectTrusted, idle, effects) {
  return {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => idle,
    isProjectTrusted: () => projectTrusted,
    getSignal: () => undefined,
    abort: () => { effects.abort += 1; },
    hasPendingMessages: () => false,
    shutdown: noop,
    getContextUsage: () => undefined,
    compact: noop,
    getSystemPrompt: () => "",
  };
}

async function listTree(root) {
  return (await readdir(root, { recursive: true })).sort();
}

async function listOrEmpty(root) {
  try {
    return (await readdir(root, { recursive: true })).sort();
  } catch {
    return [];
  }
}

async function loadHost(root, { trusted, idle = true }) {
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const effects = { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 };
  await mkdir(project, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const loader = new DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [extensionEntry],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  const models = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(root, "models-cache.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const runner = new ExtensionRunner(
    loaded.extensions,
    loaded.runtime,
    project,
    SessionManager.inMemory(project),
    new ModelRegistry(models),
  );
  runner.bindCore(createExtensionActions(effects), createContextActions(trusted, idle, effects));
  const messages = [];
  runner.setUIContext({ ...runner.getUIContext(), notify: message => messages.push(message) }, "rpc");
  return { root, agentDir, project, loaded, runner, messages, effects };
}

async function readStatus(host) {
  const command = host.runner.getCommand("quality");
  assert.ok(command, "quality command is registered");
  const before = host.messages.length;
  await command.handler("status", host.runner.createCommandContext());
  assert.equal(host.messages.length, before + 1);
  return JSON.parse(host.messages.at(-1));
}

async function recordEvidence(name, payload) {
  if (!evidenceDir) return;
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, name), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

/** Writes the retained lifecycle records, then re-reads and validates them. */
async function recordJournal(records, name = "lifecycle-journal.ndjson") {
  const text = `${records.map(record => JSON.stringify(record)).join("\n")}\n`;
  if (evidenceDir) {
    await mkdir(evidenceDir, { recursive: true });
    await writeFile(join(evidenceDir, name), text, "utf8");
    const reparsed = (await readFile(join(evidenceDir, name), "utf8"))
      .trim().split("\n").map(line => JSON.parse(line));
    assert.equal(reparsed.length, records.length);
    for (const record of reparsed) {
      assert.equal(record.schemaVersion, 1);
      assert.equal(typeof record.sequence, "number");
      assert.equal(typeof record.event, "string");
    }
  }
  return text;
}

test("the built package loads in real Pi and starts then retires an inert runtime", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-pi-"));
  try {
    const host = await loadHost(root, { trusted: true });
    assert.deepEqual(host.loaded.errors, []);
    assert.equal(host.loaded.extensions.length, 1);
    const extension = host.loaded.extensions[0];
    assert.ok(extension);
    assert.equal(resolve(extension.resolvedPath), extensionEntry);
    assert.equal(extension.tools.size, 0);
    assert.deepEqual([...extension.commands.keys()], ["quality"]);
    // K06 adds the public boundary handlers: the note courier consumes ready
    // work at turn_end/agent_before_settle, injects into the next run at
    // before_agent_start and observes real inclusion at context_with_system.
    assert.deepEqual([...extension.handlers.keys()].sort(), [
      "agent_before_settle", "agent_settled", "before_agent_start", "before_provider_request",
      "input", "session_shutdown", "session_start", "tool_execution_end",
      "tool_execution_start", "turn_end",
    ]);
    // K06 observes the actual request payload read-only for truthful inclusion
    // receipts; it publishes nothing and replaces no payload. Headers, provider
    // responses and the provider stream stay untouched.
    assert.equal(extension.handlers.has("before_provider_request"), true);
    for (const providerEvent of ["before_provider_headers", "after_provider_response", "provider_stream_event"]) {
      assert.equal(extension.handlers.has(providerEvent), false);
    }

    const filesBefore = await listTree(root);
    const inactive = await readStatus(host);
    assert.equal(inactive.runtime.state, "inactive");
    assert.equal(inactive.runtime.generation, null);
    assert.equal(inactive.engine.version, "0.4.0");
    assert.equal(inactive.configuration.enabled, false);
    assert.equal(inactive.configuration.mode, "observe");
    assert.equal(inactive.configuration.rejection, null);

    await host.runner.emit({ type: "session_start", reason: "startup" });
    const active = await readStatus(host);
    assert.equal(active.runtime.state, "active");
    assert.match(active.runtime.generation, /^gen-\d+$/);
    assert.equal(active.runtime.executionState, "idle");
    assert.equal(active.configuration.enabled, false);
    assert.equal(active.configuration.mode, "observe");
    assert.deepEqual(active.configuration.sources, { user: "absent", project: "absent" });
    assert.deepEqual(active.configuration.origins, []);
    assert.equal(active.activation.checkExecution, "unavailable");
    assert.equal(active.activation.autonomousModelCalls, "unavailable");
    assert.equal(active.capabilities.modelEvaluation, "unavailable");
    // K06: the bounded feedback action route is implemented; a delivery still
    // needs an explicit per-action grant, which the cold default does not carry.
    assert.equal(active.capabilities.feedbackActions, "available");
    assert.equal(active.activation.feedbackActions, "unavailable");
    assert.equal(active.capabilities.journalFiles, "available");
    assert.equal(active.capabilities.triggersAndScheduling, "available");
    assert.equal(active.capabilities.componentRegistry, "available");
    assert.equal(active.capabilities.functionalStatePersistence, "available");
    assert.deepEqual(active.diagnostics.recentEvents.map(record => record.event), [
      "quality.runtime.started",
      "quality.config.applied",
    ]);
    assert.equal(JSON.stringify(active).includes("quality.model.dispatched"), false);
    assert.deepEqual(host.effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 }, "the inert engine attempts no primary effect");

    await host.runner.emit({ type: "session_shutdown", reason: "quit" });
    const retired = await readStatus(host);
    assert.equal(retired.runtime.state, "retired");
    assert.equal(retired.runtime.executionState, "shutdown");
    assert.deepEqual(retired.diagnostics.recentEvents.map(record => record.event), [
      "quality.runtime.started",
      "quality.config.applied",
      "quality.runtime.retired",
      "quality.journal.closed",
    ]);
    assert.equal(retired.diagnostics.recentEvents[2]?.fields.data.cause, "quit");

    // K03 owns exactly one durable control checkpoint under the Pi agent
    // directory; a disabled journal still creates no diagnostic destination.
    const createdAfterStart = (await listTree(root)).filter(entry => !filesBefore.includes(entry));
    const ownedDirectory = (entry) => {
      const normalized = entry.replace(/\\/gu, "/");
      return normalized === "agent"
        || normalized === "agent/quality"
        || normalized.startsWith("agent/quality/state");
    };
    assert.ok(
      createdAfterStart.every(ownedDirectory),
      `the inert engine only creates its control checkpoint (${createdAfterStart.join(",")})`,
    );
    assert.deepEqual(await listOrEmpty(join(host.agentDir, "quality", "logs")), [], "a disabled journal creates no destination");

    const journalText = await recordJournal(retired.diagnostics.recentEvents);
    await recordEvidence("pi-integration.json", {
      extensionEntry,
      packageVersion: inactive.engine.version,
      hostVersion: retired.runtime.hostVersion,
      inactiveRuntimeState: inactive.runtime.state,
      activeRuntimeState: active.runtime.state,
      retiredRuntimeState: retired.runtime.state,
      eventNames: retired.diagnostics.recentEvents.map(record => record.event),
      capabilities: active.capabilities,
      createdFiles: createdAfterStart,
      notes: [
        "The lifecycle records are the implemented diagnostic destination; the session journal is exercised by the host cases.",
        "Exactly one durable control checkpoint appears under the Pi agent directory; a disabled journal creates no destination.",
        "No quality.model.dispatched or action event exists in the retained history.",
      ],
    });
    assert.equal(journalText.trim().split(/\r?\n/u).length, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid user configuration with a secret sentinel is rejected without leaking it", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-pi-"));
  try {
    const agentDir = join(root, "agent");
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({ schemaVersion: 1, [SENTINEL]: SENTINEL }), "utf8");

    const host = await loadHost(root, { trusted: false });
    await host.runner.emit({ type: "session_start", reason: "startup" });
    const status = await readStatus(host);
    assert.deepEqual(status.configuration.sources, { user: "rejected", project: "absent" });
    assert.equal(status.configuration.rejection.errorCode, "config.unknown-key");
    assert.equal(status.configuration.rejection.field, "$");
    assert.deepEqual(status.diagnostics.recentEvents.map(record => record.event), [
      "quality.config.rejected",
      "quality.runtime.started",
      "quality.config.applied",
    ]);
    const rejection = status.diagnostics.recentEvents[0];
    assert.deepEqual(rejection.fields.data.fieldPaths, ["$"]);
    assert.deepEqual(rejection.fields.data.errorCodes, ["config.unknown-key"]);
    assert.equal(rejection.fields.data.runtimeUnchanged, true);
    assert.match(String(rejection.fields.data.candidateRevision), /^rejected-user-[0-9a-f-]{36}$/);
    assert.equal(status.runtime.executionState, "idle");

    // Retirement is part of the scan window: late or retained output must stay clean.
    await host.runner.emit({ type: "session_shutdown", reason: "quit" });
    const retired = await readStatus(host);
    assert.equal(retired.runtime.state, "retired");
    const journalText = await recordJournal(retired.diagnostics.recentEvents, "sentinel-lifecycle-journal.ndjson");
    const contentSurfaces = {
      activeStatus: JSON.stringify(status),
      retiredStatus: JSON.stringify(retired),
      uiMessages: JSON.stringify(host.messages),
      lifecycleJournal: journalText,
    };
    for (const [surface, text] of Object.entries(contentSurfaces)) {
      assert.equal(text.includes(SENTINEL), false, `sentinel leaked into ${surface}`);
    }
    const fixtureInventory = await listOrEmpty(join(agentDir, "quality"));
    const ownedExtras = fixtureInventory.filter(entry => entry !== "config.json");
    assert.ok(
      ownedExtras.every(entry => entry.replaceAll("\\", "/").startsWith("state")),
      `only the control checkpoint appears next to the rejected file (${ownedExtras.join(",")})`,
    );
    for (const entry of ownedExtras) {
      const text = await readFile(join(agentDir, "quality", entry), "utf8").catch(() => "");
      assert.equal(text.includes(SENTINEL), false, `sentinel leaked into ${entry}`);
    }

    await recordEvidence("sentinel-scan.json", {
      sentinel: SENTINEL,
      contentScans: Object.keys(contentSurfaces).map(surface => ({ surface, afterRetirement: surface.startsWith("retired") || surface === "uiMessages" || surface === "lifecycleJournal", occurrences: 0 })),
      directoryInventories: [{
        directory: "agent/quality (config plus engine-owned control checkpoint only)",
        kind: "fixture directory inventory (not a content scan)",
        entries: fixtureInventory,
      }],
      occurrences: 0,
      rejectionCode: status.configuration.rejection.errorCode,
      rejectionField: status.configuration.rejection.field,
      candidateRevisionShape: "opaque rejected-user reference",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a project configuration is applied only for a trusted project and cannot set observability", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-pi-"));
  try {
    await mkdir(join(root, "project", ".pi"), { recursive: true });
    await writeFile(
      join(root, "project", ".pi", "quality.yaml"),
      "schemaVersion: 1\nobservability:\n  recentHistory:\n    maxEvents: 16\n",
      "utf8",
    );

    const untrustedHost = await loadHost(root, { trusted: false });
    await untrustedHost.runner.emit({ type: "session_start", reason: "startup" });
    const untrusted = await readStatus(untrustedHost);
    assert.deepEqual(untrusted.configuration.sources, { user: "absent", project: "skipped-untrusted" });
    assert.deepEqual(untrusted.configuration.origins, []);
    assert.equal(untrusted.configuration.recentHistory.maxEvents, 512);
    assert.equal(untrusted.configuration.rejection, null);
    await untrustedHost.runner.emit({ type: "session_shutdown", reason: "quit" });

    const trustedHost = await loadHost(root, { trusted: true });
    await trustedHost.runner.emit({ type: "session_start", reason: "startup" });
    const trusted = await readStatus(trustedHost);
    assert.deepEqual(trusted.configuration.sources, { user: "absent", project: "rejected" });
    assert.deepEqual(trusted.configuration.origins, []);
    assert.equal(trusted.configuration.rejection.errorCode, "config.project-observability-override");
    assert.equal(trusted.configuration.recentHistory.maxEvents, 512);
    assert.deepEqual(trusted.diagnostics.recentEvents.map(record => record.event), [
      "quality.config.rejected",
      "quality.runtime.started",
      "quality.config.applied",
    ]);
    await trustedHost.runner.emit({ type: "session_shutdown", reason: "quit" });

    await writeFile(join(root, "project", ".pi", "quality.yaml"), "schemaVersion: 1\npermissions: {}\n", "utf8");
    const plainHost = await loadHost(root, { trusted: true });
    await plainHost.runner.emit({ type: "session_start", reason: "startup" });
    const plain = await readStatus(plainHost);
    assert.deepEqual(plain.configuration.sources, { user: "absent", project: "applied" });
    assert.deepEqual(plain.configuration.origins, ["project"]);
    assert.equal(plain.configuration.rejection, null);
    await plainHost.runner.emit({ type: "session_shutdown", reason: "quit" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a busy primary is reported as unobserved, not idle", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-pi-"));
  try {
    const host = await loadHost(root, { trusted: true, idle: false });
    await host.runner.emit({ type: "session_start", reason: "startup" });
    const status = await readStatus(host);
    assert.equal(status.runtime.state, "active");
    assert.equal(status.runtime.executionState, "unknown");
    assert.equal(status.diagnostics.recentEvents[0]?.fields.data.executionState, "unknown");
    assert.equal(JSON.stringify(status).includes("\"executionState\":\"idle\""), false);
    await host.runner.emit({ type: "session_shutdown", reason: "quit" });
    const retired = await readStatus(host);
    assert.equal(retired.runtime.executionState, "shutdown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the public contracts entry imports without session-owned side effects", { timeout: 20000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-pi-"));
  try {
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    const before = await listTree(root);
    const probe = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `const module = await import(${JSON.stringify(pathToFileURL(contractsEntry).href)}); process.stdout.write(JSON.stringify(Object.keys(module)));`,
    ], { cwd: project, env: process.env, encoding: "utf8", timeout: 15000 });
    assert.equal(probe.status, 0, probe.stderr);
    assert.deepEqual(JSON.parse(probe.stdout), ["REGISTRY_AVAILABLE_CHANNEL", "REGISTRY_QUERY_CHANNEL"]);
    assert.deepEqual(await listTree(root), before, "a contract import must not create files");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
