import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

// K02 real-host checks: the enabled deterministic loop through the actual Pi
// extension runner, a genuine runtime timer, an independently loaded C1
// contribution, and a post-retirement sentinel scan of the real journal.

const packageRoot = process.env.QE_PACKAGE_ROOT ?? process.cwd();
const extensionEntry = resolve(packageRoot, "dist/index.js");
const fixtureExtension = resolve(packageRoot, "examples", "independent-extension", "extension.mjs");
const evidenceDir = process.env.QE_EVIDENCE_DIR;

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

function createContextActions(effects, idle) {
  return {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => idle,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => { effects.abort += 1; },
    hasPendingMessages: () => false,
    shutdown: noop,
    getContextUsage: () => undefined,
    compact: noop,
    getSystemPrompt: () => "",
  };
}

async function listOrEmpty(root) {
  try {
    return (await readdir(root, { recursive: true })).sort();
  } catch {
    return [];
  }
}

async function loadHost(root, extensionPaths = [extensionEntry]) {
  const agentDir = join(root, "agent");
  const project = join(root, "project");
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
    additionalExtensionPaths: extensionPaths,
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
  const effects = { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 };
  runner.bindCore(createExtensionActions(effects), createContextActions(effects, true));
  const messages = [];
  runner.setUIContext({ ...runner.getUIContext(), notify: message => messages.push(message) }, "rpc");
  return { root, agentDir, loaded, runner, messages, effects };
}

async function readStatus(host) {
  const command = host.runner.getCommand("quality");
  assert.ok(command);
  await command.handler("status", host.runner.createCommandContext());
  return JSON.parse(host.messages.at(-1));
}

async function waitFor(probe, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== null && value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
}

async function writeEnabledConfig(agentDir, checks) {
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "observe",
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: {
      "recent-work": {
        providers: [
          { id: "task", use: "core.task" },
          { id: "history", use: "core.history", options: { limit: 12, includeToolBodies: false } },
          { id: "waits", use: "core.waits" },
        ],
      },
      "fixture-plan": {
        providers: [
          { id: "fixture", use: "fixture.note" },
          { id: "waits", use: "core.waits" },
        ],
      },
    },
    evaluators: { "repetition-check": { use: "core.repeated-tools", options: { window: 12, minimumRepeats: 3 } } },
    policies: { record: { use: "core.record-only" } },
    checks,
  }), "utf8");
}

function check(triggers, context = "recent-work") {
  return {
    triggers,
    context,
    prompt: "repetition",
    evaluator: "repetition-check",
    policy: "record",
    cooldownMs: 0,
    criteria: ["efficiency.repetition"],
  };
}

async function readJournalText(agentDir) {
  const directory = join(agentDir, "quality", "logs");
  const files = await listOrEmpty(directory);
  let text = "";
  for (const file of files) {
    text += await readFile(join(directory, file), "utf8");
  }
  return text;
}

test("K02-T02 a genuine runtime timer admits a check with no new primary completion", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-k02-host-"));
  let host = null;
  try {
    host = await loadHost(root);
    await writeEnabledConfig(host.agentDir, {
      repetition: check([{ id: "periodic", use: "core.periodic", options: { everyMs: 150, requireNewEvidence: false } }]),
    });
    const startedAt = Date.now();
    await host.runner.emit({ type: "session_start", reason: "startup" });
    await host.runner.emit({ type: "input", text: "assess repetition", source: "interactive" });
    const settled = await waitFor(async () => {
      const status = await readStatus(host);
      return status.checks.runs >= 1 ? status : null;
    }, 2_500, "a check admitted by the real timer");
    const lateness = Date.now() - startedAt;
    assert.equal(settled.observation.completedPrimaryTools, 0, "the timer needed no primary completion");
    assert.ok(lateness >= 150, `the configured interval elapsed (${lateness}ms)`);
    assert.ok(lateness < 2_500, `timer lateness stayed bounded (${lateness}ms)`);
    assert.ok(settled.diagnostics.recentEvents.some(record => record.event === "quality.check.settled"));
    const journal = await readJournalText(host.agentDir);
    assert.ok(journal.includes('"quality.check.settled"'), "the journal records the settlement");
    assert.ok(journal.includes("quality.trigger.due"));
    await host.runner.emit({ type: "session_shutdown", reason: "quit" });
    const retired = await readStatus(host);
    assert.ok(retired.diagnostics.recentEvents.some(record => record.event === "quality.journal.closed"));
    if (evidenceDir) {
      await mkdir(evidenceDir, { recursive: true });
      await writeFile(join(evidenceDir, "k02-real-timer.json"), `${JSON.stringify({
        configuredIntervalMs: 150,
        observedLatenessMs: lateness,
        completedPrimaryTools: settled.observation.completedPrimaryTools,
        runs: settled.checks.runs,
        journalClosed: true,
      }, null, 2)}\n`, "utf8");
    }
  } finally {
    if (host !== null) {
      try {
        await host.runner.emit({ type: "session_shutdown", reason: "quit" });
      } catch {
        // The test may already have shut the session down.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("K02-T06 an independently loaded contribution registers, affects a check and disposes", { timeout: 30000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-k02-host-"));
  let host = null;
  try {
    host = await loadHost(root, [extensionEntry, fixtureExtension]);
    assert.deepEqual(host.loaded.errors, []);
    assert.equal(host.loaded.extensions.length, 2);
    await writeEnabledConfig(host.agentDir, {
      repetition: check([{ id: "fixture-burst", use: "fixture.burst-tools", options: { count: 2 } }], "fixture-plan"),
    });
    await host.runner.emit({ type: "session_start", reason: "startup" });
    const active = await waitFor(async () => {
      const status = await readStatus(host);
      return status.checks.detail[0]?.state === "active" ? status : null;
    }, 2_500, "the contribution to become ready and activate the check");
    assert.ok(active.registry.packages.some(entry =>
      entry.packageId === "fixture.independent-extension" && entry.phase === "ready"));

    await host.runner.emit({ type: "input", text: "assess repetition", source: "interactive" });
    for (const toolCallId of ["h1", "h2"]) {
      await host.runner.emit({ type: "tool_execution_start", toolCallId, toolName: "read", args: { file_path: "x" } });
      await host.runner.emit({ type: "tool_execution_end", toolCallId, toolName: "read", result: "ok", isError: false, durationMs: 1 });
    }
    const withRun = await waitFor(async () => {
      const status = await readStatus(host);
      return status.checks.runs >= 1 ? status : null;
    }, 2_500, "the contribution-triggered check to run");
    const manifestItems = withRun.diagnostics.recentEvents
      .filter(record => record.event === "quality.context.manifest-part")
      .flatMap(record => record.fields.data.items ?? []);
    assert.ok(manifestItems.some(item => item.sourceId === "fixture.note"), "the contribution context reached the real run");

    await host.runner.emit({ type: "session_shutdown", reason: "quit" });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    const retired = await readStatus(host);
    const inventory = retired.registry.packages.find(entry => entry.packageId === "fixture.independent-extension");
    assert.equal(inventory?.phase, "disposed");
    assert.ok(retired.diagnostics.recentEvents.some(record =>
      record.event === "quality.component.lifecycle" && record.fields.data.phase === "disposed"));
    assert.deepEqual(host.effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 });
  } finally {
    if (host !== null) {
      try {
        await host.runner.emit({ type: "session_shutdown", reason: "quit" });
      } catch {
        // The test may already have shut the session down.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("K02-T07 task, argument and tool-error sentinels stay out of Standard history and journal", { timeout: 30000 }, async () => {
  const taskSentinel = "k02-host-task-sentinel-2b7e";
  const argumentSentinel = "k02-host-argument-sentinel-6d1a";
  const errorSentinel = "k02-host-error-sentinel-91c4";
  const root = await mkdtemp(join(tmpdir(), "quality-k02-host-"));
  let host = null;
  try {
    host = await loadHost(root);
    await writeEnabledConfig(host.agentDir, {
      repetition: check([{ id: "every-one", use: "core.every-tools", options: { count: 1 } }]),
    });
    await host.runner.emit({ type: "session_start", reason: "startup" });
    await host.runner.emit({ type: "input", text: `review this ${taskSentinel}`, source: "interactive" });
    await host.runner.emit({
      type: "tool_execution_start",
      toolCallId: "s1",
      toolName: "bash",
      args: { command: `echo ${argumentSentinel}` },
    });
    await host.runner.emit({
      type: "tool_execution_end",
      toolCallId: "s1",
      toolName: "bash",
      result: { error: errorSentinel },
      isError: true,
      durationMs: 3,
    });
    await waitFor(async () => {
      const status = await readStatus(host);
      return status.checks.runs >= 1 ? status : null;
    }, 2_500, "the sentinel check to settle");
    await host.runner.emit({ type: "session_shutdown", reason: "quit" });
    const retired = await readStatus(host);
    const history = JSON.stringify(retired.diagnostics.recentEvents);
    const journal = await readJournalText(host.agentDir);
    for (const sentinel of [taskSentinel, argumentSentinel, errorSentinel]) {
      assert.equal(history.includes(sentinel), false, `history leaked ${sentinel}`);
      assert.equal(journal.includes(sentinel), false, `journal leaked sentinel`);
    }
    assert.ok(journal.includes("quality.check.settled"), "positive control: the journal carries useful metadata");
    assert.ok(journal.includes("quality.trigger.due"));
    await mkdir(evidenceDir ?? root, { recursive: true });
    if (evidenceDir) {
      await writeFile(join(evidenceDir, "k02-sentinel-scan.json"), `${JSON.stringify({
        sentinels: [taskSentinel, argumentSentinel, errorSentinel],
        contentScans: [
          { surface: "retained-history", occurrences: 0 },
          { surface: "session-journal", occurrences: 0, afterRetirement: true },
        ],
        positiveControl: "journal contains quality.check.settled and quality.trigger.due",
      }, null, 2)}\n`, "utf8");
    }
  } finally {
    if (host !== null) {
      try {
        await host.runner.emit({ type: "session_shutdown", reason: "quit" });
      } catch {
        // The test may already have shut the session down.
      }
    }
    await rm(root, { recursive: true, force: true });
  }
});
