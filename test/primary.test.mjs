import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession,
} from "@earendil-works/pi-coding-agent";

// Real primary-session smoke with a scripted, no-paid provider route.
//
// The scripted provider counts every dispatch at the actual provider boundary.
// That counter is the independent witness for K02-B.10/K02-B.12: engine lifecycle work
// (start, status, retirement) adds zero dispatches, while ordinary prompt turns
// reach the provider exactly once each. The same session then proves that the
// primary keeps working after engine retirement and that the retired generation
// writes no new diagnostic records.

const packageRoot = process.env.QE_PACKAGE_ROOT ?? process.cwd();
const extensionEntry = resolve(packageRoot, "dist/index.js");
const evidenceDir = process.env.QE_EVIDENCE_DIR;
const REPLY = "scripted no-paid reply";

function scriptedStream(model, text) {
  const message = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  const events = [
    { type: "start", partial: { ...message, content: [] } },
    { type: "text_start", contentIndex: 0, partial: { ...message, content: [] } },
    { type: "text_delta", contentIndex: 0, delta: text, partial: message },
    { type: "text_end", contentIndex: 0, content: text, partial: message },
    { type: "done", reason: "stop", message },
  ];
  return {
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
    async result() {
      return message;
    },
  };
}

test("the real primary stays usable through engine retirement with zero owned dispatches", { timeout: 60000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-primary-"));
  try {
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;

    const settingsManager = SettingsManager.inMemory({});
    const resourceLoader = new DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [extensionEntry],
    });
    await resourceLoader.reload();

    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(root, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    const dispatchCounter = { total: 0 };
    modelRuntime.registerProvider("qe-scripted", {
      name: "QE scripted fixture",
      api: "qe-scripted-api",
      apiKey: "qe-fixture-not-a-credential",
      baseUrl: "http://127.0.0.1:9/qe-scripted",
      streamSimple: model => {
        dispatchCounter.total += 1;
        return scriptedStream(model, REPLY);
      },
      models: [{
        id: "qe-scripted-1",
        name: "QE scripted fixture",
        api: "qe-scripted-api",
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    });
    const model = modelRuntime.getModel("qe-scripted", "qe-scripted-1");
    assert.ok(model, "the scripted fixture model resolves through the real model runtime");

    const { session } = await createAgentSession({
      cwd: project,
      agentDir,
      model,
      modelRuntime,
      resourceLoader,
      sessionManager: SessionManager.inMemory(project),
      settingsManager,
      noTools: "all",
      sessionStartEvent: { type: "session_start", reason: "startup" },
    });
    const runner = session.extensionRunner;
    const extensionErrors = [];
    runner.onError(error => extensionErrors.push(`${error.event}: ${error.error}`));
    const messages = [];
    const uiContext = { ...runner.getUIContext(), notify: message => messages.push(message) };
    try {
      assert.deepEqual(resolve(runner.getExtensionPaths()[0] ?? ""), extensionEntry);
      assert.ok(runner.getCommand("quality"));
      assert.equal(runner.hasHandlers("before_provider_request"), false, "the engine registers no provider hooks");

      await session.bindExtensions({ mode: "print", uiContext });
      assert.equal(dispatchCounter.total, 0, "session start and engine binding dispatch no provider request");
      assert.deepEqual(extensionErrors, []);

      // The engine command runs through the actual primary prompt path without a model call.
      await session.prompt("/quality status");
      assert.equal(dispatchCounter.total, 0, "the engine command must not dispatch a provider request");
      const active = JSON.parse(messages.at(-1));
      assert.equal(active.runtime.state, "active");
      assert.equal(active.configuration.enabled, false);
      assert.deepEqual(active.diagnostics.recentEvents.map(record => record.event), [
        "quality.runtime.started",
        "quality.config.applied",
      ]);

      // A normal primary turn reaches the scripted provider exactly once.
      await session.prompt("Say hello");
      assert.equal(session.getLastAssistantText(), REPLY);
      assert.equal(dispatchCounter.total, 1, "one primary turn is one provider dispatch");

      // Retire the engine generation while the primary session continues.
      await runner.emit({ type: "session_shutdown", reason: "reload" });
      const afterRetirementDispatches = dispatchCounter.total;
      await session.prompt("/quality status");
      assert.equal(dispatchCounter.total, afterRetirementDispatches, "retirement dispatches no provider request");
      const retired = JSON.parse(messages.at(-1));
      assert.equal(retired.runtime.state, "retired");
      assert.equal(retired.runtime.executionState, "shutdown");
      assert.deepEqual(retired.diagnostics.recentEvents.map(record => record.event), [
        "quality.runtime.started",
        "quality.config.applied",
        "quality.runtime.retired",
        "quality.journal.closed",
      ]);
      const recordsAfterRetirement = retired.diagnostics.recentEvents.length;

      // The primary remains usable after engine retirement, and the retired
      // generation cannot add work or records.
      await session.prompt("Say hello again");
      assert.equal(session.getLastAssistantText(), REPLY);
      assert.equal(dispatchCounter.total, afterRetirementDispatches + 1, "the primary turn still dispatches exactly once");
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      await session.prompt("/quality status");
      const afterLateShutdown = JSON.parse(messages.at(-1));
      assert.equal(afterLateShutdown.runtime.state, "retired");
      assert.equal(afterLateShutdown.diagnostics.recentEvents.length, recordsAfterRetirement, "no record after retirement");
      assert.deepEqual(extensionErrors, []);

      if (evidenceDir) {
        await mkdir(evidenceDir, { recursive: true });
        await writeFile(join(evidenceDir, "primary-smoke.json"), `${JSON.stringify({
          checkpoint: "K02",
          case: "K02 primary provider counter",
          route: "scripted in-process provider (no network, no credentials)",
          providerDispatches: dispatchCounter.total,
          engineOwnedDispatches: 0,
          observations: {
            afterEngineStart: 0,
            afterEngineCommand: 0,
            afterFirstPrimaryTurn: 1,
            afterEngineRetirement: afterRetirementDispatches,
            afterSecondPrimaryTurn: dispatchCounter.total,
          },
          replies: [REPLY],
          retiredRecordEvents: retired.diagnostics.recentEvents.map(record => record.event),
          recordsAfterRetirement,
          extensionErrors,
        }, null, 2)}\n`, "utf8");
      }
    } finally {
      const beforeDispose = dispatchCounter.total;
      session.dispose();
      assert.equal(dispatchCounter.total, beforeDispose, "dispose dispatches nothing");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
