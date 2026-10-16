import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

// K04 actual-host managed path: the real Pi loader/runner/ModelRegistry with a
// genuine scripted SDK provider. The engine's pi-models adapter resolves the
// approved profile through this registry; no ModelRegistryPort stub is used.

const REPLY = { operational: "completed", coverage: { state: "complete", scopeDescription: "scripted host assessment", issues: [] }, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };

function stream(model) {
  const message = {
    role: "assistant",
    content: [{ type: "text", text: JSON.stringify(REPLY) }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    stopReason: "stop",
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...message, content: [] } };
      yield { type: "text_start", contentIndex: 0, partial: message };
      yield { type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message };
      yield { type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message };
      yield { type: "done", reason: "stop", message };
    },
    async result() {
      return message;
    },
  };
}

test("K04 SDK adapter dispatches core.chat through the real ModelRegistry scripted provider", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-host-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "host-marker-evidence\n", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k04-scripted", model: "scripted-1", price: "unknown" } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.chat", modelProfile: "scripted" } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"] } },
    }), "utf8");
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    let chatCalls = 0;
    models.registerProvider("qe-k04-scripted", {
      name: "scripted host provider",
      api: "qe-k04-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: model => { chatCalls += 1; return stream(model); },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k04-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    });
    const registry = new ModelRegistry(models);
    const manager = SessionManager.inMemory(project);
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, project, manager, registry);
    const errors = [];
    runner.onError(error => errors.push(`${error.event}: ${error.error}`));
    runner.bindCore({
      sendMessage: () => undefined, sendUserMessage: () => undefined, appendEntry: () => undefined,
      setSessionName: () => undefined, getSessionName: () => undefined, setLabel: () => undefined,
      getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}),
      setActiveTools: () => undefined, refreshTools: () => undefined, getCommands: () => [],
      setModel: () => undefined, getThinkingLevel: () => "off", setThinkingLevel: () => undefined,
    }, {
      getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true,
      getSignal: () => undefined, abort: () => undefined, hasPendingMessages: () => false,
      shutdown: () => undefined, getContextUsage: () => undefined, compact: () => undefined, getSystemPrompt: () => "",
    });
    const messages = [];
    runner.setUIContext({ ...runner.getUIContext(), notify: message => messages.push(message) }, "rpc");
    const command = runner.getCommand("quality");
    const status = async () => {
      await command.handler("status", runner.createCommandContext());
      return JSON.parse(messages.at(-1));
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      await runner.emit({ type: "input", text: "assess host evidence", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "host-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "host-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 10_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        settled = await status();
      }
      assert.equal(chatCalls, 1, "the real ModelRegistry scripted provider received exactly one managed request");
      assert.equal(settled.checks.runs, 1);
      const names = settled.diagnostics.recentEvents.map(record => record.event);
      assert.ok(names.includes("quality.model.settled"), "settlement is projected through the real host");
      assert.equal(settled.accounting?.ownedRequestCount, 1);
      assert.equal(settled.accounting?.normalizedTokens.total, 150);
      const result = settled.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
      assert.equal(result?.conclusion, "no-supported-finding");
      const journalDirectory = join(agentDir, "quality", "logs");
      let journalText = "";
      for (const name of await readdir(journalDirectory).catch(() => [])) {
        if (name.endsWith(".jsonl")) journalText += await readFile(join(journalDirectory, name), "utf8");
      }
      assert.equal(journalText.includes("host-marker-evidence"), false, "selected source bodies stay out of the journal under capture none");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
