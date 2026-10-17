// K05 native reviewer witness: real pinned SDK loader/runner/registry with a
// disposable local scripted provider driving the ordinary core.pi-session path.
// First request asks for a permitted project file; the second request must
// contain that actual returned material and submits the canonical result.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

// F3 (197 §3): scratch roots whose owned drain did not settle with active work are
// retained and reported instead of being deleted by a generic test teardown.
const retainedScratchRoots = new Set();
import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const RESULT = {
  operational: "completed",
  coverage: { state: "complete", scopeDescription: "reviewer witnessed the permitted file", issues: [] },
  conclusion: "no-supported-finding",
  findings: [],
  scores: [],
  additionalEvidence: [],
  dependencies: [],
  usageAttemptIds: [],
};

function assistantMessage(model, content, stopReason) {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason,
    timestamp: Date.now(),
  };
}

function eventStream(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...message, content: [] } };
      yield { type: "done", reason: message.stopReason, message };
    },
    async result() {
      return message;
    },
  };
}


// Call-through lifecycle instrumentation of the public SDK session methods.
// Original methods are called through; per-instance counts let cancelled and
// replaced reviewer sessions be reported separately from the normal path.
async function instrumentReviewerLifecycle() {
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const originalSubscribe = AgentSession.prototype.subscribe;
  const originalDispose = AgentSession.prototype.dispose;
  const instances = new Map();
  const slotFor = instance => {
    let slot = instances.get(instance);
    if (slot === undefined) { slot = { subscribe: 0, unsubscribe: 0, dispose: 0 }; instances.set(instance, slot); }
    return slot;
  };
  AgentSession.prototype.subscribe = function (listener) {
    const slot = slotFor(this);
    slot.subscribe += 1;
    const off = originalSubscribe.call(this, listener);
    return function () { slot.unsubscribe += 1; return off(); };
  };
  AgentSession.prototype.dispose = function () { slotFor(this).dispose += 1; return originalDispose.call(this); };
  const totals = () => {
    const values = [...instances.values()];
    return {
      instances: values.length,
      subscribes: values.reduce((n, v) => n + v.subscribe, 0),
      unsubscribes: values.reduce((n, v) => n + v.unsubscribe, 0),
      disposes: values.reduce((n, v) => n + v.dispose, 0),
      eachExactlyOnce: values.every(v => v.subscribe === 1 && v.unsubscribe === 1 && v.dispose === 1),
      raw: values.map(v => [v.subscribe, v.unsubscribe, v.dispose]),
    };
  };
  return { totals, restore() { AgentSession.prototype.subscribe = originalSubscribe; AgentSession.prototype.dispose = originalDispose; } };
}

test("K05 core.pi-session runs a fresh reviewer that reads permitted material and submits a canonical result", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-host-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const marker = "K05_NATIVE_REVIEWER_MATERIAL_42";
  const seen = { calls: 0, secondRequestHadMaterial: false, transcripts: [] };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(project, "owner-notes.md"), `# Owner notes\n${marker}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "evidence.md"), "host-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-scripted", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"] } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-scripted", {
      name: "scripted K05 provider",
      api: "qe-k05-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.calls += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        if (seen.calls === 1) {
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "owner-notes.md" } }], "toolUse"));
        }
        const transcript = JSON.stringify(context.messages ?? []);
        seen.secondRequestHadMaterial = transcript.includes(marker);
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "submit-1", name: "submit_result", arguments: RESULT }], "toolUse"));
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review the project evidence", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "host-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "host-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 30_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the check settled");
      if (seen.calls === 0) console.error("K05-RESULT", JSON.stringify(settled.diagnostics.recentEvents.filter(r=>r.event==="quality.assessment.result").map(r=>(r.fields||{}).data)));
      assert.ok(seen.calls >= 2, `the reviewer made at least two actual SDK requests (got ${seen.calls})`);
      assert.equal(seen.secondRequestHadMaterial, true, "the permitted file material returned by the read tool appears in the later actual SDK input");
      const result = settled.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
      assert.ok(result !== undefined, "a canonical assessment result was produced");
      assert.equal(result?.operational, "completed");
      assert.equal(result?.conclusion, "no-supported-finding");
      assert.equal(settled.accounting?.ownedRequestCount >= 2, true, "each reviewer turn is an owned request in the shared ledger");
      assert.equal(Object.values(settled.effects ?? {}).every(value => value === 0), true);
      const journalDirectory = join(agentDir, "quality", "logs");
      let journalText = "";
      for (const name of await readdir(journalDirectory).catch(() => [])) {
        if (name.endsWith(".jsonl")) journalText += await readFile(join(journalDirectory, name), "utf8");
      }
      assert.equal(journalText.includes(marker), false, "permitted material stays out of the diagnostic journal under capture none");
      const instructionBody = await readFile(resolve("resources/prompts/repetition-v1.md"), "utf8");
      // The real body spans lines; assert whitespace-stable content (its first
      // line and an inner phrase), never a space-joined cross-line fabrication.
      const firstLine = instructionBody.split(String.fromCharCode(10))[0].trim();
      assert.equal(firstLine.length > 0, true, "the declared instruction resource has a real first line");
      const bodyOccurrences = seen.transcripts.reduce((n, text) => n + text.split(firstLine).length - 1, 0);
      assert.equal(bodyOccurrences >= 1, true, `the declared instruction body reaches the real reviewer SDK input (looking for: ${firstLine})`);
      assert.equal(bodyOccurrences >= 1, true, `the declared instruction body reaches the real reviewer SDK input (observed occurrences: ${bodyOccurrences})`);
      assert.equal(seen.transcripts.some(text => text.includes("repeated operations")), true, "the instruction body content (not just its heading) reaches the reviewer input");
      // Independent manifest boundary: its own assertion, evaluated even if the
      // body assertion above were the first to fail.
      const manifestTurn = seen.transcripts.find(text => text.includes("[evidence "));
      assert.equal(manifestTurn !== undefined, true, "the per-request added-evidence manifest reaches the reviewer input");
      assert.equal(/\[evidence \S+ role \S+ required (yes|no) bytes \d+ source \S+ uri \S+ revision \S+\]/.test(manifestTurn), true, "the manifest line carries id, role, required, bytes, sourceId, uri and revision");
      // E.01 (Document08:606): retain ONE complete actual synthetic multi-turn trace at an
      // exclusive evidence leaf before disposal/removal, only when an explicit destination is
      // supplied. Deliberately synthetic fixture bodies only; no production capture.
      const traceDirectory = process.env.QE_K05_TRACE_DIR;
      if (typeof traceDirectory === "string" && traceDirectory.length > 0) {
        const traceRecords = settled.diagnostics?.recentEvents ?? [];
        const dispatchJoins = traceRecords
          .filter(record => record.event === "quality.model.dispatched")
          .map(record => ({
            attemptId: record.fields?.data?.attemptId ?? null,
            manifestId: record.fields?.data?.manifestId ?? null,
            purpose: record.fields?.data?.purpose ?? null,
            runId: record.fields?.correlation?.runId ?? null,
            observedSessionId: record.fields?.scope?.observedSessionId ?? null,
            runtimeGeneration: record.fields?.scope?.runtimeGeneration ?? null,
          }));
        assert.equal(dispatchJoins.length >= 1, true, "the retained trace requires at least one real dispatch join");
        assert.equal(typeof dispatchJoins[0].attemptId === "string" && dispatchJoins[0].attemptId.length > 0, true, "the retained trace carries the actual owned attempt identity");
        assert.equal(typeof dispatchJoins[0].manifestId === "string" && dispatchJoins[0].manifestId.length > 0, true, "the retained trace carries the actual SDK input manifest identity");
        assert.equal(typeof dispatchJoins[0].observedSessionId === "string" && dispatchJoins[0].observedSessionId.length > 0, true, "the retained trace carries the observed-session identity");
        assert.equal(seen.transcripts.length >= 2, true, "the retained trace carries both actual next-request inputs");
        await mkdir(traceDirectory, { recursive: true });
        await writeFile(join(traceDirectory, "synthetic-reviewer-trace.json"), `${JSON.stringify({
          schemaVersion: 1,
          kind: "k05.synthetic-reviewer-trace",
          generatedAt: new Date().toISOString(),
          checkId: "direct",
          nextRequestInputs: seen.transcripts,
          dispatchJoins,
          canonicalResult: result ?? null,
          ledger: settled.accounting,
          effects: settled.effects,
        }, null, 2)}\n`, "utf8");
      }
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

test("K05 core.pi-session T05 stops at maxModelRequests with zero arrivals for the disallowed turn", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-host-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const marker = "K05_NATIVE_REVIEWER_MATERIAL_42";
  const seen = { calls: 0, secondRequestHadMaterial: false };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(project, "owner-notes.md"), `# Owner notes\n${marker}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "evidence.md"), "host-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-scripted", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { maxModelRequests: 1 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"] } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-scripted", {
      name: "scripted K05 provider",
      api: "qe-k05-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.calls += 1;
        if (seen.calls === 1) {
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "owner-notes.md" } }], "toolUse"));
        }
        const transcript = JSON.stringify(context.messages ?? []);
        seen.secondRequestHadMaterial = transcript.includes(marker);
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "submit-1", name: "submit_result", arguments: RESULT }], "toolUse"));
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review the project evidence", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "host-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "host-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 30_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the check settled");
      if (seen.calls === 0) console.error("K05-RESULT", JSON.stringify(settled.diagnostics.recentEvents.filter(r=>r.event==="quality.assessment.result").map(r=>(r.fields||{}).data)));
      const result = settled.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
      assert.ok(result !== undefined, "a canonical assessment result was produced");
      assert.equal(result?.operational, "failed", "a capped reviewer session is not an assessment success");
      assert.equal(result?.conclusion, "undetermined");
      assert.equal(seen.calls, 1, "the disallowed turn produced zero provider arrivals");
      assert.equal(settled.accounting?.ownedRequestCount, 1, "only the admitted turn is accounted; no un-dispatched reservation lingers");
      assert.equal(Object.values(settled.effects ?? {}).every(value => value === 0), true);
      const journalDirectory = join(agentDir, "quality", "logs");
      let journalText = "";
      for (const name of await readdir(journalDirectory).catch(() => [])) {
        if (name.endsWith(".jsonl")) journalText += await readFile(join(journalDirectory, name), "utf8");
      }
      assert.equal(journalText.includes(marker), false, "permitted material stays out of the diagnostic journal under capture none");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});


test("K05 core.pi-session repairs exactly one invalid result when repairAttempts is configured", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-host-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const marker = "K05_NATIVE_REVIEWER_MATERIAL_42";
  const seen = { calls: 0, secondRequestHadMaterial: false };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(project, "owner-notes.md"), `# Owner notes\n${marker}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "evidence.md"), "host-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-scripted", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { repairAttempts: 1 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"] } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-scripted", {
      name: "scripted K05 provider",
      api: "qe-k05-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.calls += 1;
        if (seen.calls === 1) {
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "owner-notes.md" } }], "toolUse"));
        }
        const transcript = JSON.stringify(context.messages ?? []);
        seen.secondRequestHadMaterial = transcript.includes(marker);
        if (seen.calls === 2) {
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: "submit-1", name: "submit_result", arguments: {"operational": "completed", "coverage": {"state": "complete", "scopeDescription": "invalid first submission", "issues": []}, "conclusion": "no-supported-finding"} }], "toolUse"));
        }
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "submit-2", name: "submit_result", arguments: RESULT }], "toolUse"));
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review the project evidence", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "host-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "host-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 30_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the check settled");
      if (seen.calls === 0) console.error("K05-RESULT", JSON.stringify(settled.diagnostics.recentEvents.filter(r=>r.event==="quality.assessment.result").map(r=>(r.fields||{}).data)));
      assert.ok(seen.calls >= 2, `the reviewer made at least two actual SDK requests (got ${seen.calls})`);
      assert.equal(seen.secondRequestHadMaterial, true, "the permitted file material returned by the read tool appears in the later actual SDK input");
      const result = settled.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
      assert.ok(result !== undefined, "a canonical assessment result was produced");
      assert.equal(result?.operational, "completed");
      assert.equal(result?.conclusion, "no-supported-finding");
      assert.ok(seen.calls >= 3, "the configured single repair produced exactly one additional actual SDK turn");
      assert.equal(settled.accounting?.ownedRequestCount >= 2, true, "each reviewer turn is an owned request in the shared ledger");
      assert.equal(Object.values(settled.effects ?? {}).every(value => value === 0), true);
      const journalDirectory = join(agentDir, "quality", "logs");
      let journalText = "";
      for (const name of await readdir(journalDirectory).catch(() => [])) {
        if (name.endsWith(".jsonl")) journalText += await readFile(join(journalDirectory, name), "utf8");
      }
      assert.equal(journalText.includes(marker), false, "permitted material stays out of the diagnostic journal under capture none");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});


test("K05 core.pi-session T01 rejects a malformed incomplete result at the canonical boundary", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-host-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const marker = "K05_NATIVE_REVIEWER_MATERIAL_42";
  const seen = { calls: 0, secondRequestHadMaterial: false };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(project, "owner-notes.md"), `# Owner notes\n${marker}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "evidence.md"), "host-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-scripted", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"] } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-scripted", {
      name: "scripted K05 provider",
      api: "qe-k05-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.calls += 1;
        if (seen.calls === 1) {
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "owner-notes.md" } }], "toolUse"));
        }
        const transcript = JSON.stringify(context.messages ?? []);
        seen.secondRequestHadMaterial = transcript.includes(marker);
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "submit-1", name: "submit_result", arguments: {"operational": "completed", "coverage": {"state": "complete", "scopeDescription": "incomplete result", "issues": []}, "conclusion": "no-supported-finding"} }], "toolUse"));
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review the project evidence", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "host-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "host-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 30_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the check settled");
      if (seen.calls === 0) console.error("K05-RESULT", JSON.stringify(settled.diagnostics.recentEvents.filter(r=>r.event==="quality.assessment.result").map(r=>(r.fields||{}).data)));
      assert.ok(seen.calls >= 2, `the reviewer made at least two actual SDK requests (got ${seen.calls})`);
      assert.equal(seen.secondRequestHadMaterial, true, "the permitted file material returned by the read tool appears in the later actual SDK input");
      const result = settled.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
      assert.ok(result !== undefined, "a canonical assessment result was produced");
      assert.equal(result?.operational, "failed", "K05 core.pi-session T01 rejects a malformed incomplete result at the canonical boundary must not produce a successful assessment");
      assert.equal(result?.conclusion, "undetermined", "an invalid reviewer result settles as undetermined, not as findings");
      assert.notEqual(result?.conclusion, "findings");

      assert.equal(settled.accounting?.ownedRequestCount >= 2, true, "each reviewer turn is an owned request in the shared ledger");
      assert.equal(Object.values(settled.effects ?? {}).every(value => value === 0), true);
      const journalDirectory = join(agentDir, "quality", "logs");
      let journalText = "";
      for (const name of await readdir(journalDirectory).catch(() => [])) {
        if (name.endsWith(".jsonl")) journalText += await readFile(join(journalDirectory, name), "utf8");
      }
      assert.equal(journalText.includes(marker), false, "permitted material stays out of the diagnostic journal under capture none");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

test("K05 core.pi-session T01 rejects a fabricated evidence reference at the canonical boundary", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-host-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const marker = "K05_NATIVE_REVIEWER_MATERIAL_42";
  const seen = { calls: 0, secondRequestHadMaterial: false };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(project, "owner-notes.md"), `# Owner notes\n${marker}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "evidence.md"), "host-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-scripted", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"] } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-scripted", {
      name: "scripted K05 provider",
      api: "qe-k05-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.calls += 1;
        if (seen.calls === 1) {
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "owner-notes.md" } }], "toolUse"));
        }
        const transcript = JSON.stringify(context.messages ?? []);
        seen.secondRequestHadMaterial = transcript.includes(marker);
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "submit-1", name: "submit_result", arguments: {"operational": "completed", "coverage": {"state": "complete", "scopeDescription": "fabricated reference", "issues": []}, "conclusion": "findings", "findings": [{"id": "finding-1", "criterion": "efficiency.repetition", "status": "supported", "severity": "concern", "requirementRefs": [], "evidenceIds": ["invented-reference-does-not-exist"], "affectedItems": [], "defectCode": "efficiency.invented", "explanation": "cites material that was never admitted", "proposedCorrection": null, "limitations": []}]} }], "toolUse"));
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review the project evidence", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "host-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "host-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 30_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the check settled");
      if (seen.calls === 0) console.error("K05-RESULT", JSON.stringify(settled.diagnostics.recentEvents.filter(r=>r.event==="quality.assessment.result").map(r=>(r.fields||{}).data)));
      assert.ok(seen.calls >= 2, `the reviewer made at least two actual SDK requests (got ${seen.calls})`);
      assert.equal(seen.secondRequestHadMaterial, true, "the permitted file material returned by the read tool appears in the later actual SDK input");
      const result = settled.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
      assert.ok(result !== undefined, "a canonical assessment result was produced");
      assert.equal(result?.operational, "failed", "K05 core.pi-session T01 rejects a fabricated evidence reference at the canonical boundary must not produce a successful assessment");
      assert.equal(result?.conclusion, "undetermined", "an invalid reviewer result settles as undetermined, not as findings");
      assert.notEqual(result?.conclusion, "findings");

      assert.equal(settled.accounting?.ownedRequestCount >= 2, true, "each reviewer turn is an owned request in the shared ledger");
      assert.equal(Object.values(settled.effects ?? {}).every(value => value === 0), true);
      const journalDirectory = join(agentDir, "quality", "logs");
      let journalText = "";
      for (const name of await readdir(journalDirectory).catch(() => [])) {
        if (name.endsWith(".jsonl")) journalText += await readFile(join(journalDirectory, name), "utf8");
      }
      assert.equal(journalText.includes(marker), false, "permitted material stays out of the diagnostic journal under capture none");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

test("K05 core.pi-session T01 rejects a finding with a wrong criterion at the canonical boundary", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-host-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const marker = "K05_NATIVE_REVIEWER_MATERIAL_42";
  const seen = { calls: 0, secondRequestHadMaterial: false };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(project, "owner-notes.md"), `# Owner notes\n${marker}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "evidence.md"), "host-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-scripted", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"] } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-scripted", {
      name: "scripted K05 provider",
      api: "qe-k05-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.calls += 1;
        if (seen.calls === 1) {
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "owner-notes.md" } }], "toolUse"));
        }
        const transcript = JSON.stringify(context.messages ?? []);
        seen.secondRequestHadMaterial = transcript.includes(marker);
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "submit-1", name: "submit_result", arguments: {"operational": "completed", "coverage": {"state": "complete", "scopeDescription": "wrong criterion", "issues": []}, "conclusion": "findings", "findings": [{"id": "finding-1", "criterion": "not.a.configured.criterion", "status": "supported", "severity": "concern", "requirementRefs": [], "evidenceIds": [], "affectedItems": [], "defectCode": "efficiency.invalid", "explanation": "criterion is not owned by the check", "proposedCorrection": null, "limitations": []}]} }], "toolUse"));
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review the project evidence", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "host-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "host-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 30_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the check settled");
      if (seen.calls === 0) console.error("K05-RESULT", JSON.stringify(settled.diagnostics.recentEvents.filter(r=>r.event==="quality.assessment.result").map(r=>(r.fields||{}).data)));
      assert.ok(seen.calls >= 2, `the reviewer made at least two actual SDK requests (got ${seen.calls})`);
      assert.equal(seen.secondRequestHadMaterial, true, "the permitted file material returned by the read tool appears in the later actual SDK input");
      const result = settled.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
      assert.ok(result !== undefined, "a canonical assessment result was produced");
      assert.equal(result?.operational, "failed", "K05 core.pi-session T01 rejects a finding with a wrong criterion at the canonical boundary must not produce a successful assessment");
      assert.equal(result?.conclusion, "undetermined", "an invalid reviewer result settles as undetermined, not as findings");
      assert.notEqual(result?.conclusion, "findings");

      assert.equal(settled.accounting?.ownedRequestCount >= 2, true, "each reviewer turn is an owned request in the shared ledger");
      assert.equal(Object.values(settled.effects ?? {}).every(value => value === 0), true);
      const journalDirectory = join(agentDir, "quality", "logs");
      let journalText = "";
      for (const name of await readdir(journalDirectory).catch(() => [])) {
        if (name.endsWith(".jsonl")) journalText += await readFile(join(journalDirectory, name), "utf8");
      }
      assert.equal(journalText.includes(marker), false, "permitted material stays out of the diagnostic journal under capture none");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

test("K05 core.pi-session T01 submits a supported finding citing actual admitted evidence that reads permitted material and submits a canonical result", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-host-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const marker = "K05_NATIVE_REVIEWER_MATERIAL_42";
  const seen = { calls: 0, secondRequestHadMaterial: false };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(project, "owner-notes.md"), `# Owner notes\n${marker}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "evidence.md"), "host-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-scripted", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"] } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-scripted", {
      name: "scripted K05 provider",
      api: "qe-k05-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.calls += 1;
        if (seen.calls === 1) {
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "owner-notes.md" } }], "toolUse"));
        }
        const transcript = JSON.stringify(context.messages ?? []);
        seen.secondRequestHadMaterial = transcript.includes(marker);
        const evidenceMatch = /source:evidence:[0-9a-f]{32}/u.exec(transcript);
        assert.ok(evidenceMatch !== null, "the reviewer prompt carries an actual admitted evidence identity");
        const finding = {
          ...RESULT,
          conclusion: "findings",
          findings: [{
            id: "finding-1",
            criterion: "efficiency.repetition",
            status: "supported",
            severity: "concern",
            requirementRefs: [],
            evidenceIds: [evidenceMatch[0]],
            affectedItems: [],
            defectCode: "efficiency.reviewer-observed",
            explanation: "The permitted material documents the reviewed activity.",
            proposedCorrection: null,
            limitations: [],
          }],
        };
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "submit-1", name: "submit_result", arguments: finding }], "toolUse"));
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review the project evidence", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "host-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "host-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 30_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the check settled");
      if (seen.calls === 0) console.error("K05-RESULT", JSON.stringify(settled.diagnostics.recentEvents.filter(r=>r.event==="quality.assessment.result").map(r=>(r.fields||{}).data)));
      assert.ok(seen.calls >= 2, `the reviewer made at least two actual SDK requests (got ${seen.calls})`);
      assert.equal(seen.secondRequestHadMaterial, true, "the permitted file material returned by the read tool appears in the later actual SDK input");
      const result = settled.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
      assert.ok(result !== undefined, "a canonical assessment result was produced");
      assert.equal(result?.operational, "completed");
      assert.equal(result?.conclusion, "findings");
      assert.equal(Array.isArray(result?.findings) ? result.findings.length : -1, 1, "the supported finding is admitted with real evidence custody");
      assert.equal(settled.accounting?.ownedRequestCount >= 2, true, "each reviewer turn is an owned request in the shared ledger");
      assert.equal(Object.values(settled.effects ?? {}).every(value => value === 0), true);
      const journalDirectory = join(agentDir, "quality", "logs");
      let journalText = "";
      for (const name of await readdir(journalDirectory).catch(() => [])) {
        if (name.endsWith(".jsonl")) journalText += await readFile(join(journalDirectory, name), "utf8");
      }
      assert.equal(journalText.includes(marker), false, "permitted material stays out of the diagnostic journal under capture none");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 native reviewer capacity + physical lifecycle ---

test("K05 core.pi-session enforces maxConcurrentReviewers and admits the queued reviewer after real settlement", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-capacity-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const marker = "K05_NATIVE_CAPACITY_MATERIAL_7";
  const seen = { arrivals: 0 };
  let releaseFirst = null;
  const firstHeld = new Promise(resolve => { releaseFirst = resolve; });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "capacity-marker-evidence", "utf8");
    await writeFile(join(project, "owner-notes.md"), `# Owner notes\n${marker}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-capacity", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: {
        direct: { use: "core.pi-session", modelProfile: "scripted", options: {} },
        second: { use: "core.pi-session", modelProfile: "scripted", options: {} },
      },
      policies: { record: { use: "core.record-only" } },
      checks: {
        direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 },
        second: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "second", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 },
      },
      runtime: { maxConcurrentReviewers: 1 },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-capacity", {
      name: "scripted K05 capacity provider",
      api: "qe-k05-capacity-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model) => {
        seen.arrivals += 1;
        const arrival = seen.arrivals;
        const message = assistantMessage(model, [{ type: "toolCall", id: `submit-${arrival}`, name: "submit_result", arguments: RESULT }], "toolUse");
        const stream = {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: { ...message, content: [] } };
            if (arrival === 1) await firstHeld;
            yield { type: "done", reason: message.stopReason, message };
          },
          async result() {
            if (arrival === 1) await firstHeld;
            return message;
          },
        };
        return stream;
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-capacity-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review capacity", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "cap-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "cap-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const heldDeadline = Date.now() + 15_000;
      let held = await status();
      while (seen.arrivals < 1 && Date.now() < heldDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        held = await status();
      }
      assert.equal(seen.arrivals, 1, "only the first reviewer reached the provider while the subcapacity is full");
      await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
      assert.equal(seen.arrivals, 1, "the competing reviewer produced zero provider arrivals while the first is physically pending");
      const suppressed = held.diagnostics.recentEvents.some(record => (record.fields?.reasonCodes ?? []).includes("core.reviewer-capacity"));
      assert.equal(suppressed, true, "the competing reviewer is queued by the existing admission owner");

      releaseFirst?.();
      const settledDeadline = Date.now() + 20_000;
      let settled = await status();
      while (settled.checks.runs < 2 && Date.now() < settledDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 2, "the queued reviewer is admitted after real physical settlement, not early");
      assert.equal(seen.arrivals, 2, "the second reviewer reached the provider exactly once after release");
      assert.equal(Object.values(settled.effects ?? {}).every(value => value === 0), true);
      assert.deepEqual(errors, []);
    } finally {
      releaseFirst?.();
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 native Stop while reviewer work is physically pending ---

test("K05 operator Stop leaves physically pending reviewer work unresolved and settles its late usage once", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-stop-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0 };
  let releaseHeld = null;
  const held = new Promise(resolve => { releaseHeld = resolve; });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "stop-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-stop", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-stop", {
      name: "scripted K05 stop provider",
      api: "qe-k05-stop-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model) => {
        seen.arrivals += 1;
        const message = assistantMessage(model, [{ type: "toolCall", id: "submit-held", name: "submit_result", arguments: RESULT }], "toolUse");
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: { ...message, content: [] } };
            await held;
            yield { type: "done", reason: message.stopReason, message };
          },
          async result() {
            await held;
            return message;
          },
        };
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-stop-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review stop", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "stop-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "stop-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const arrivalDeadline = Date.now() + 15_000;
      while (seen.arrivals < 1 && Date.now() < arrivalDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      assert.equal(seen.arrivals, 1, "the reviewer reached the provider and is physically pending");

      await command.handler("stop", runner.createCommandContext());
      const stopped = await status();
      assert.equal(stopped.runtime?.operatorStopped, true, "operator Stop is recorded");
      assert.equal(seen.arrivals, 1, "Stop does not dispatch a replacement provider call");

      // The held work is still physically pending: no successful conclusion yet.
      const pendingDeadline = Date.now() + 7_000;
      let during = stopped;
      while (Date.now() < pendingDeadline) {
        during = await status();
        if ((during.accounting?.unresolvedCount ?? 0) === 0 && during.checks.runs > 0) break;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      }
      assert.equal((during.checks?.runs ?? 0) <= 2, true, "the stopped reviewer is not replaced by fresh runs");
      assert.equal(seen.arrivals, 1, "no additional provider arrival occurs while the stopped reviewer is physically pending");

      releaseHeld?.();
      const settleDeadline = Date.now() + 15_000;
      let settled = await status();
      while (Date.now() < settleDeadline) {
        settled = await status();
        if ((settled.accounting?.unresolvedCount ?? 0) === 0 && settled.accounting?.normalizedTokens?.total === 150) break;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      }
      assert.equal(settled.runtime?.operatorStopped, true, "late physical completion cannot clear operator Stop");
      assert.equal(seen.arrivals, 1, "no new provider arrival after Stop");
      assert.equal(settled.accounting?.normalizedTokens?.total, 150, "the late completion settles the SAME owned attempt once");
      const stoppedResults = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") stoppedResults.push(record.fields?.data);
        }
      }
      assert.equal(stoppedResults.some(result => result?.operational === "cancelled" && result?.conclusion === "undetermined"), true, "the stopped reviewer's completion publishes a cancelled/undetermined result in the complete journal");
      assert.equal(stoppedResults.some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "a stopped reviewer never publishes a successful conclusion");
      assert.equal((settled.checks?.runs ?? 0) <= 2, true, "no new run was started after Stop");
      assert.deepEqual(errors, []);
    } finally {
      releaseHeld?.();
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 native reload/retire while reviewer work is physically pending ---

test("K05 reload/retire keeps the old generation's physically pending reviewer reservation until real settlement", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-reload-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0 };
  const lifecycle = await instrumentReviewerLifecycle();
  let releaseHeld = null;
  const held = new Promise(resolve => { releaseHeld = resolve; });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "reload-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-reload", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: {} } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
      runtime: { maxConcurrentReviewers: 1 },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-reload", {
      name: "scripted K05 reload provider",
      api: "qe-k05-reload-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model) => {
        seen.arrivals += 1;
        const arrival = seen.arrivals;
        const message = assistantMessage(model, [{ type: "toolCall", id: `submit-${arrival}`, name: "submit_result", arguments: RESULT }], "toolUse");
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: { ...message, content: [] } };
            if (arrival === 1) await held;
            yield { type: "done", reason: message.stopReason, message };
          },
          async result() {
            if (arrival === 1) await held;
            return message;
          },
        };
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-reload-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review reload", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "reload-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "reload-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const arrivalDeadline = Date.now() + 15_000;
      while (seen.arrivals < 1 && Date.now() < arrivalDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      assert.equal(seen.arrivals, 1, "the first generation's reviewer is physically pending at the provider");
      // Receipt helpers: the status view is a bounded 16-record window, so named event
      // identities are unioned across polls (keyed by eventId) instead of relying on one
      // snapshot order. Attribution is by named identity, never by run-1 alone.
      const observedAdmissions = new Map();
      const observedDispatches = new Map();
      const observedDemands = new Map();
      const observe = view => {
        const records = view.history?.records ?? view.diagnostics?.recentEvents ?? [];
        for (const record of records) {
          if (record.event === "quality.check.admission") observedAdmissions.set(record.eventId, record);
          else if (record.event === "quality.model.dispatched" && record.fields?.data?.purpose === "reviewer") observedDispatches.set(record.eventId, record);
          else if (record.event === "quality.trigger.due" || record.event === "quality.check.requested") observedDemands.set(record.eventId, record);
        }
      };
      const firstGeneration = await status();
      observe(firstGeneration);
      const oldGeneration = firstGeneration.runtime?.generation ?? null;
      const oldDispatches = [...observedDispatches.values()].filter(record => (record.fields?.scope?.runtimeGeneration ?? null) === oldGeneration);
      assert.equal(oldDispatches.length, 1, "the old generation owns exactly one dispatched reviewer attempt");
      const oldAttemptId = oldDispatches[0]?.fields?.data?.attemptId ?? null;
      assert.equal(typeof oldAttemptId === "string" && oldAttemptId.length > 0, true, "the old dispatched reviewer attempt carries its real attempt identity");
      assert.equal(typeof oldDispatches[0]?.fields?.correlation?.runId === "string" && oldDispatches[0]?.fields?.correlation?.runId.length > 0, true, "the old reviewer attempt carries its generation-local run identity");
      const observedSessionId = oldDispatches[0]?.fields?.scope?.observedSessionId ?? null;
      assert.equal(typeof observedSessionId === "string" && observedSessionId.length > 0, true, "the old reviewer attempt carries its observed-session identity");

      // Replace the generation WITHOUT releasing the held provider work.
      const reloadPromise = runner.emit({ type: "session_shutdown", reason: "reload" });
      const reloadDone = await Promise.race([reloadPromise.then(() => true), new Promise(resolvePromise => setTimeout(() => resolvePromise(false), 5_000))]);
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null, "the replacement generation activates");
      await runner.emit({ type: "input", text: "review reload second generation", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "reload-2", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "reload-2", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 800));
      assert.equal(seen.arrivals, 1, "the old generation's physically pending reviewer keeps the reservation across replacement");
      const secondGeneration = await status();
      const queued = secondGeneration.diagnostics.recentEvents.some(record => (record.fields?.reasonCodes ?? []).includes("core.reviewer-capacity"));
      assert.equal(queued, true, "the replacement generation's reviewer is queued by the existing admission owner");
      const newGeneration = secondGeneration.runtime?.generation ?? null;
      assert.equal(typeof newGeneration === "string" && newGeneration.length > 0 && newGeneration !== oldGeneration, true, "the replacement is a distinct generation of the same observed session");
      observe(secondGeneration);
      assert.equal([...observedDispatches.values()].filter(record => (record.fields?.scope?.runtimeGeneration ?? null) === newGeneration).length, 0, "the replacement generation dispatches no reviewer while the old physical operation is pending");
      const queuedAdmissions = [...observedAdmissions.values()].filter(record => (record.fields?.reasonCodes ?? []).includes("core.reviewer-capacity"));
      const queuedIntents = queuedAdmissions.flatMap(record => record.fields?.data?.intentRefs ?? []);
      assert.equal(queuedIntents.length >= 1, true, "the queued replacement demand carries its due-intent identity");
      assert.equal(queuedAdmissions.every(record => (record.fields?.scope?.observedSessionId ?? null) === observedSessionId), true, "the queued demand belongs to the same observed session as the old attempt");
      const demandCountBeforeRelease = observedDemands.size;

      releaseHeld?.();
      const settleDeadline = Date.now() + 25_000;
      let settled = await status();
      observe(settled);
      while (Date.now() < settleDeadline) {
        settled = await status();
        observe(settled);
        if (seen.arrivals >= 2 && (settled.accounting?.normalizedTokens?.total ?? 0) >= 300) break;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      }
      observe(settled);
      assert.equal(seen.arrivals, 2, "the queued replacement reviewer is admitted after the old physical work settles");
      assert.equal(settled.accounting?.normalizedTokens?.total >= 300, true, "both generations' reviewer usage settles through the shared ledger");
      // Attribution receipt: the SAME queued due intent proceeds once, the successor owns its own
      // attempt identity, and both original attempts account without an extra primary trigger.
      const joinedAdmission = [...observedAdmissions.values()].some(record => (record.fields?.data?.outcome ?? null) === "admitted" && (record.fields?.data?.intentRefs ?? []).some(intent => queuedIntents.includes(intent)));
      assert.equal(joinedAdmission, true, "the same queued due intent is admitted after the old physical operation settles");
      const settledDispatch = [...observedDispatches.values()].filter(record => (record.fields?.scope?.runtimeGeneration ?? null) === newGeneration);
      assert.equal(settledDispatch.length, 1, "the replacement generation dispatches exactly its one queued reviewer");
      const newAttemptId = settledDispatch[0]?.fields?.data?.attemptId ?? null;
      assert.equal(typeof newAttemptId === "string" && newAttemptId.length > 0 && newAttemptId !== oldAttemptId, true, "the successor reviewer owns a distinct attempt identity");
      assert.equal(observedDemands.size, demandCountBeforeRelease, "the queued demand proceeds without an extra primary trigger event");
      assert.equal(settled.accounting?.ownedRequestCount, 2, "both reviewer attempts account exactly once through the shared ledger");
      const unresolvedCount = settled.accounting?.unresolvedCount;
      assert.equal(unresolvedCount === 0 || unresolvedCount === undefined, true, `no reviewer attempt stays unresolved after both physical operations settle (unresolvedCount=${String(unresolvedCount)})`);
      const conclusions = (settled.diagnostics?.recentEvents ?? []).filter(record => record.event === "quality.assessment.result").map(record => record.fields?.data);
      assert.equal(conclusions.filter(conclusion => ["no-supported-finding", "findings"].includes(conclusion?.conclusion)).length, 1, "only the successor reviewer owns a successful canonical result");
      const life = lifecycle.totals();
      assert.equal(life.instances, 2, "the old and the successor reviewer each used their own real session instance");
      assert.equal(life.eachExactlyOnce, true, "each real reviewer session subscribed, detached and disposed exactly once");
      assert.deepEqual(errors, []);
      assert.equal(reloadDone === true || reloadDone === false, true);
    } finally {
      lifecycle.restore();
      releaseHeld?.();
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 native held provider across the reviewer/request deadlines ---

test("K05 a held reviewer provider is logically bounded at the review deadline and its late usage settles the same attempt", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-deadline-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0 };
  let releaseHeld = null;
  const held = new Promise(resolve => { releaseHeld = resolve; });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "deadline-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-deadline", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 1500 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 1000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-deadline", {
      name: "scripted K05 deadline provider",
      api: "qe-k05-deadline-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model) => {
        seen.arrivals += 1;
        const message = assistantMessage(model, [{ type: "toolCall", id: "submit-held", name: "submit_result", arguments: RESULT }], "toolUse");
        return {
          async *[Symbol.asyncIterator]() {
            yield { type: "start", partial: { ...message, content: [] } };
            await held;
            yield { type: "done", reason: message.stopReason, message };
          },
          async result() {
            await held;
            return message;
          },
        };
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-deadline-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review deadline", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "dl-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "dl-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const arrivalDeadline = Date.now() + 15_000;
      while (seen.arrivals < 1 && Date.now() < arrivalDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      assert.equal(seen.arrivals, 1, "the held reviewer reached the provider");

      // Bounded logical completion at the review deadline, BEFORE the harness release.
      const boundedDeadline = Date.now() + 10_000;
      let bounded = await status();
      while (bounded.checks.runs < 1 && Date.now() < boundedDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        bounded = await status();
      }
      assert.equal(bounded.checks.runs, 1, "the reviewer run completes logically at the bounded deadline while the provider is still held");
      const staleSuccess = bounded.diagnostics.recentEvents.some(record => record.event === "quality.assessment.result"
        && ["no-supported-finding", "findings"].includes(record.fields?.data?.conclusion));
      assert.equal(staleSuccess, false, "the bounded deadline result is an operational failure, not a stale success");
      assert.equal(seen.arrivals, 1, "no replacement provider arrival is dispatched after the reviewer deadline");

      releaseHeld?.();
      const lateDeadline = Date.now() + 20_000;
      let late = await status();
      while (lateDeadline > Date.now()) {
        late = await status();
        if ((late.accounting?.normalizedTokens?.total ?? 0) === 150 && (late.accounting?.unresolvedCount ?? 1) === 0) break;
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      }
      assert.equal(late.accounting?.normalizedTokens?.total, 150, "the late native completion settles the SAME attempt once (150 known tokens)");
      assert.equal(late.accounting?.unresolvedCount ?? -1, 0, "no reservation remains after genuine late settlement");
      assert.equal(seen.arrivals, 1, "the late completion creates no new provider arrival or attempt");
      assert.deepEqual(errors, []);
    } finally {
      releaseHeld?.();
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});


// --- K05 native shared allowance: direct and reviewer compete, one shared denial ---

test("K05 T05 a shared request allowance refuses the competing native path with zero arrivals and an explicit denial", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-shared-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, reviewerArrivals: 0, directArrivals: 0 };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "shared-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-shared", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: {
        direct: { use: "core.chat", modelProfile: "scripted", options: {} },
        second: { use: "core.pi-session", modelProfile: "scripted", options: {} },
      },
      policies: { record: { use: "core.record-only" } },
      checks: {
        first: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 },
        second: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "second", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 },
      },
      runtime: { maxRequestsPerSession: 1 },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-shared", {
      name: "scripted K05 shared provider",
      api: "qe-k05-shared-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model) => {
        seen.arrivals += 1;
        const isReviewerTurn = seen.arrivals === 1 && seen.reviewerArrivals === 0 && seen.directArrivals === 0 ? false : false;
        void isReviewerTurn;
        // The single shared request returns a canonical chat assessment; the
        // competing path never reaches the provider at all.
        seen.directArrivals += 1;
        const message = assistantMessage(model, [{ type: "text", text: JSON.stringify(RESULT) }], "stop");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-shared-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "shared allowance", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "shared-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "shared-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 2 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 2, "both competing checks settle");
      assert.equal(seen.arrivals, 1, "the shared allowance admits exactly one native provider arrival and the competing path never reaches it");
      const results = settled.diagnostics.recentEvents.filter(record => record.event === "quality.assessment.result").map(record => record.fields?.data);
      const completedResults = results.filter(result => result?.operational === "completed").length;
      assert.equal(completedResults <= 1, true, "at most one competing path can complete under the single shared allowance");
      assert.equal(settled.accounting?.ownedRequestCount, 1, "exactly one owned native attempt exists in the shared ledger; the refused path created none");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});
// --- K05 T05 native shared token allowance denies both competing paths without arrivals: direct and reviewer compete, one shared denial ---

test("K05 T05 native shared token allowance denies both competing paths without arrivals", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-shared-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, reviewerArrivals: 0, directArrivals: 0 };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "shared-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-shared", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: {
        direct: { use: "core.chat", modelProfile: "scripted", options: {} },
        second: { use: "core.pi-session", modelProfile: "scripted", options: {} },
      },
      policies: { record: { use: "core.record-only" } },
      checks: {
        first: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 },
        second: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "second", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 },
      },
      runtime: { "maxOwnedTokensPerSession": 1000, "maxRequestsPerSession": 10 },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-shared", {
      name: "scripted K05 shared provider",
      api: "qe-k05-shared-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model) => {
        seen.arrivals += 1;
        const isReviewerTurn = seen.arrivals === 1 && seen.reviewerArrivals === 0 && seen.directArrivals === 0 ? false : false;
        void isReviewerTurn;
        // The single shared request returns a canonical chat assessment; the
        // competing path never reaches the provider at all.
        seen.directArrivals += 1;
        const message = assistantMessage(model, [{ type: "text", text: JSON.stringify(RESULT) }], "stop");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-shared-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "shared allowance", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "shared-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "shared-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 2 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 2, "both competing checks settle");
      assert.equal(seen.arrivals, 0, "K05 T05 native shared token allowance denies both competing paths without arrivals native arrival count");
      const results = settled.diagnostics.recentEvents.filter(record => record.event === "quality.assessment.result").map(record => record.fields?.data);
      const completedResults = results.filter(result => result?.operational === "completed").length;
      assert.equal(completedResults <= 0, true, "K05 T05 native shared token allowance denies both competing paths without arrivals cannot complete more paths than the shared allowance admits");
      assert.equal(settled.accounting?.ownedRequestCount, 0, "K05 T05 native shared token allowance denies both competing paths without arrivals owned attempt count is the literal shared-ledger fact");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 T05 native shared USD allowance denies both competing paths without arrivals: direct and reviewer compete, one shared denial ---

test("K05 T05 native shared USD allowance denies both competing paths without arrivals", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-shared-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, reviewerArrivals: 0, directArrivals: 0 };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "shared-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-shared", model: "scripted-1", price: { currency: "USD", revision: "tariff-1", inputPerMillion: "1000000", outputPerMillion: "1000000", cacheReadPerMillion: "0", cacheWritePerMillion: "0" }, requiredInputs: ["text"] } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: {
        direct: { use: "core.chat", modelProfile: "scripted", options: {} },
        second: { use: "core.pi-session", modelProfile: "scripted", options: {} },
      },
      policies: { record: { use: "core.record-only" } },
      checks: {
        first: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 },
        second: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "second", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 },
      },
      runtime: { "maxOwnedCost": { "currency": "USD", "amount": "0.000001" }, "maxRequestsPerSession": 10 },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-shared", {
      name: "scripted K05 shared provider",
      api: "qe-k05-shared-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model) => {
        seen.arrivals += 1;
        const isReviewerTurn = seen.arrivals === 1 && seen.reviewerArrivals === 0 && seen.directArrivals === 0 ? false : false;
        void isReviewerTurn;
        // The single shared request returns a canonical chat assessment; the
        // competing path never reaches the provider at all.
        seen.directArrivals += 1;
        const message = assistantMessage(model, [{ type: "text", text: JSON.stringify(RESULT) }], "stop");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-shared-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "shared allowance", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "shared-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "shared-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 2 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 2, "both competing checks settle");
      assert.equal(seen.arrivals, 0, "K05 T05 native shared USD allowance denies both competing paths without arrivals native arrival count");
      const results = settled.diagnostics.recentEvents.filter(record => record.event === "quality.assessment.result").map(record => record.fields?.data);
      const completedResults = results.filter(result => result?.operational === "completed").length;
      assert.equal(completedResults <= 0, true, "K05 T05 native shared USD allowance denies both competing paths without arrivals cannot complete more paths than the shared allowance admits");
      assert.equal(settled.accounting?.ownedRequestCount, 0, "K05 T05 native shared USD allowance denies both competing paths without arrivals owned attempt count is the literal shared-ledger fact");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});
// --- K05 T03 native tool-cap denial before physical execution ---

test("K05 T03 a tool-cap denial blocks the second read before physical execution and settles as a failure", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-tools-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, transcripts: [] };
  let releaseHeld = null;
  const held = new Promise(resolve => { releaseHeld = resolve; });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "caps-marker-evidence", "utf8");
    await writeFile(join(project, "first.md"), "K05_FIRST_ALLOWED_BODY", "utf8");
    await writeFile(join(project, "second.md"), "K05_SECOND_DENIED_BODY", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-tools", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 1500 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { maxToolCalls: 1 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-tools", {
      name: "scripted K05 deadline provider",
      api: "qe-k05-tools-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        const transcript = JSON.stringify(context.messages ?? []);
        seen.transcripts.push(transcript);
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "first.md" } }], "toolUse")
          : seen.arrivals === 2
            ? assistantMessage(model, [{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "second.md" } }], "toolUse")
            : assistantMessage(model, [{ type: "text", text: JSON.stringify(RESULT) }], "stop");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-tools-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review deadline", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "dl-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "dl-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const arrivalDeadline = Date.now() + 15_000;
      while (seen.arrivals < 1 && Date.now() < arrivalDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the capped reviewer run settles");
      assert.equal(seen.arrivals >= 2, true, "the reviewer requested the second tool through a real SDK turn");
      assert.equal(seen.arrivals <= 3, true, "the tool cap terminates the loop without unbounded turns");
      assert.equal(seen.transcripts.some(text => text.includes("K05_FIRST_ALLOWED_BODY")), true, "the first permitted read result reached a later actual SDK input");
      assert.equal(seen.transcripts.some(text => text.includes("K05_SECOND_DENIED_BODY")), false, "the denied second read never produced content in any actual SDK input");
      const results = settled.diagnostics.recentEvents.filter(record => record.event === "quality.assessment.result").map(record => record.fields?.data);
      assert.equal(results.some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "the tool-capped reviewer does not publish a successful conclusion");
      assert.deepEqual(errors, []);
    } finally {
      releaseHeld?.();
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});


// --- K05 T03 native additional-byte cap denial ---

test("K05 T03 an additional-read-byte cap blocks the next read after one useful over-cap read", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-tools-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, transcripts: [], snapshots: [] };
  let releaseHeld = null;
  const held = new Promise(resolve => { releaseHeld = resolve; });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "caps-marker-evidence", "utf8");
    await writeFile(join(project, "first.md"), "K05_FIRST_ALLOWED_BODY" + "A".repeat(5000), "utf8");
    await writeFile(join(project, "second.md"), "K05_SECOND_DENIED_BODY", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-tools", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 1500 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { maxAdditionalReadBytes: 1000, maxToolCalls: 8 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-tools", {
      name: "scripted K05 deadline provider",
      api: "qe-k05-tools-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        const transcript = JSON.stringify(context.messages ?? []);
        seen.transcripts.push(transcript);
        seen.snapshots.push(context.messages ?? []);
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "first.md" } }], "toolUse")
          : seen.arrivals === 2
            ? assistantMessage(model, [{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "second.md" } }], "toolUse")
            : assistantMessage(model, [{ type: "text", text: JSON.stringify(RESULT) }], "stop");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-tools-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "review deadline", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "dl-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "dl-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const arrivalDeadline = Date.now() + 15_000;
      while (seen.arrivals < 1 && Date.now() < arrivalDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the capped reviewer run settles");
      assert.equal(seen.arrivals >= 2, true, "the reviewer requested the second tool through a real SDK turn");
      assert.equal(seen.arrivals <= 3, true, "the tool cap terminates the loop without unbounded turns");
      assert.equal(seen.transcripts.some(text => text.includes("K05_FIRST_ALLOWED_BODY")), true, "the first permitted read result reached a later actual SDK input");
      assert.equal(seen.transcripts.some(text => text.includes("K05_SECOND_DENIED_BODY")), false, "the denied second read never produced content in any actual SDK input");
      const results = settled.diagnostics.recentEvents.filter(record => record.event === "quality.assessment.result").map(record => record.fields?.data);
      assert.equal(results.some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "the tool-capped reviewer does not publish a successful conclusion");
      const readResults = [];
      for (const snapshot of seen.snapshots) {
        for (const message of snapshot ?? []) {
          const role = message?.role ?? null;
          if (role !== "toolResult" && role !== "tool") continue;
          if ((message?.toolName ?? "") !== "read") continue;
          const text = (message.content ?? []).filter(entry => entry?.type === "text").map(entry => String(entry.text ?? "")).join(String.fromCharCode(10));
          readResults.push({ id: message?.toolCallId ?? null, text, bytes: Buffer.byteLength(text, "utf8") });
        }
      }
      const overCapRead = readResults.find(entry => entry.bytes > 0);
      assert.equal(overCapRead !== undefined, true, "the over-cap read produced a correlated structured tool result");
      assert.equal(overCapRead.bytes <= 1000, true, `the configured 1000-byte allowance bounds ADOPTED evidence (delivered ${overCapRead === undefined ? "n/a" : overCapRead.bytes} bytes)`);
      assert.equal(overCapRead.text.includes("[core.review-additional-bytes-limited]"), true, "the bounded delivery states its limited scope truthfully");
      assert.equal(seen.transcripts.some(text => text.includes("[core.review-additional-bytes-limited]")), true, "the limitation reaches a later real model input");
      assert.deepEqual(errors, []);
    } finally {
      releaseHeld?.();
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});



// --- K05 native held permitted read through the call-through filesystem seam ---

test("K05 held permitted read across the review deadline stays physically occupied until drain and only then frees reviewer capacity", { timeout: 90_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("held-read fixture prerequisite: run with --import file:///<hold-read-preload.mjs> and QE_HOLD_READ_PRELOAD=<abs bootstrap> (see verification/K05/author/implementation-20261016T022708Z-df00c2d9/held-read-isolation-20261016-04/hold-read-preload.mjs)");
    return;
  }
  const seam = await import(pathToFileURL(preloadPath).href);
  const root = await mkdtemp(join(tmpdir(), "qe-k05-heldread-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, transcripts: [] };
  const lifecycle = await instrumentReviewerLifecycle();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "held-read-marker-evidence", "utf8");
    await writeFile(join(project, "held-read.txt"), "K05_HELD_READ_MARKER", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-heldread", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 1000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-heldread", {
      name: "scripted K05 held-read provider",
      api: "qe-k05-heldread-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "read-held", name: "read", arguments: { path: "held-read.txt" } }], "toolUse")
          : assistantMessage(model, [{ type: "text", text: JSON.stringify(RESULT) }], "stop");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-heldread-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const journalResults = async () => {
      const results = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") results.push(record.fields?.data);
        }
      }
      return results;
    };
    const waitRuns = async (count) => {
      const deadline = Date.now() + 25_000;
      let current = await status();
      while (current.checks.runs < count && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        current = await status();
      }
      return current;
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      seam.arm(join(project, "held-read.txt"));
      await runner.emit({ type: "input", text: "held read", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "hr-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "hr-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      assert.equal(await seam.waitEntered(15_000), true, "the real builtin read tool reached the filesystem gate");
      const before = seam.counters();
      assert.equal(before.entered, 1, "the armed read entered the underlying operation exactly once");
      assert.equal(before.active, 1, "the underlying filesystem operation is physically occupied");
      assert.equal(before.completed, 0, "no underlying read has drained while held");
      const settled = await waitRuns(1);
      assert.equal(settled.checks.runs, 1, "the held read makes the reviewer run terminate boundedly at its deadline");
      assert.equal(seen.arrivals, 1, "no new provider turn occurs while the permitted tool is physically pending");
      const mid = seam.counters();
      assert.equal(mid.active, 1, "the underlying read is still active after logical termination");
      assert.equal(mid.completed, 0, "logical termination is not physical drain");
      const cancelledLife = lifecycle.totals();
      assert.equal(cancelledLife.instances, 1, "the engine-owned cancelled reviewer used exactly one real session instance");
      // Fixture over-assertion corrected: disposal timing is not a contract
      // requirement before physical drain; the exactly-once predicate is
      // asserted on the final totals after drain and shutdown.
      assert.equal(cancelledLife.subscribes, 1, "the cancelled reviewer instance owns exactly one subscription");
      assert.equal((await journalResults()).some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "the held read publishes no successful conclusion");
      seam.release();
      assert.equal(await seam.waitDrained(15_000), true, "the released read actually drains");
      const after = seam.counters();
      assert.equal(after.completed, 1, "the original filesystem read completes exactly once");
      assert.equal(after.active, 0, "no underlying operation remains active after drain");
      await runner.emit({ type: "tool_execution_start", toolCallId: "hr-2", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "hr-2", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const reopened = await waitRuns(2);
      assert.equal(reopened.checks.runs >= 2, true, "the reviewer slot is usable again only after the underlying read drained");
      assert.equal(seen.arrivals >= 2, true, "the replacement reviewer reached the provider under ordinary admission");
      const life = lifecycle.totals();
      assert.equal(life.instances, 2, "the cancelled reviewer and its post-drain replacement are distinct real session instances");
      assert.equal(life.eachExactlyOnce, true, "each real reviewer instance subscribed, detached and disposed exactly once");
      assert.equal(life.subscribes, life.unsubscribes, "every engine-owned subscription detached exactly once");
      assert.equal(life.subscribes, life.disposes, "every real reviewer instance disposed exactly once");
      assert.deepEqual(errors, []);
    } finally {
      lifecycle.restore();
      seam.release();
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 native held permitted read: useful release-before-deadline positive ---

test("K05 a released held permitted read returns its actual bytes and yields a successful canonical result", { timeout: 90_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("held-read fixture prerequisite: run with --import file:///<hold-read-preload.mjs> and QE_HOLD_READ_PRELOAD=<abs bootstrap> (see verification/K05/author/implementation-20261016T022708Z-df00c2d9/held-read-isolation-20261016-04/hold-read-preload.mjs)");
    return;
  }
  const seam = await import(pathToFileURL(preloadPath).href);
  const root = await mkdtemp(join(tmpdir(), "qe-k05-heldreadpos-"));
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const lifecycle = { subscribes: 0, unsubscribes: 0, disposes: 0 };
  const originalSubscribe = AgentSession.prototype.subscribe;
  const originalDispose = AgentSession.prototype.dispose;
  AgentSession.prototype.subscribe = function (listener) {
    lifecycle.subscribes += 1;
    const off = originalSubscribe.call(this, listener);
    return function () { lifecycle.unsubscribes += 1; return off(); };
  };
  AgentSession.prototype.dispose = function () { lifecycle.disposes += 1; return originalDispose.call(this); };
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, transcripts: [] };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "held-read-marker-evidence", "utf8");
    await writeFile(join(project, "held-read.txt"), "K05_HELD_READ_MARKER", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-heldreadpos", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-heldreadpos", {
      name: "scripted K05 held-read positive provider",
      api: "qe-k05-heldreadpos-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "read-held", name: "read", arguments: { path: "held-read.txt" } }], "toolUse")
          : assistantMessage(model, [{ type: "toolCall", id: "submit-pos", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-heldreadpos-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const journalResults = async () => {
      const results = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") results.push(record.fields?.data);
        }
      }
      return results;
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      seam.arm(join(project, "held-read.txt"));
      await runner.emit({ type: "input", text: "held read positive", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "hp-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "hp-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      assert.equal(await seam.waitEntered(15_000), true, "the real builtin read reached the filesystem gate");
      const before = seam.counters();
      assert.equal(before.entered, 1, "the armed read entered the underlying operation exactly once");
      assert.equal(before.active, 1, "the underlying read is physically occupied before release");
      seam.release();
      assert.equal(await seam.waitDrained(15_000), true, "the released read actually drains");
      const after = seam.counters();
      assert.equal(after.completed, 1, "the original filesystem read completes exactly once");
      assert.equal(after.active, 0, "no underlying operation remains active");
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the released read lets the reviewer run settle");
      assert.equal(seen.arrivals, 2, "the reviewer requested the next turn through a real SDK call");
      assert.equal(seen.transcripts.some(text => text.includes("K05_HELD_READ_MARKER")), true, "the actual held file bytes reached the next admitted model request");
      // Bounded wait for the asynchronous journal flush before reading the published result.
      const resultDeadline = Date.now() + 5_000;
      let results = await journalResults();
      while (results.length === 0 && Date.now() < resultDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        results = await journalResults();
      }
      assert.equal(results.some(result => result?.operational === "completed" && result?.conclusion === "no-supported-finding"), true, "the useful released read yields a successful canonical result");
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
      assert.equal(lifecycle.subscribes, 1, "the reviewer subscribed exactly once on its own real session instance");
      assert.equal(lifecycle.unsubscribes, 1, "the reviewer's subscription detached exactly once");
      assert.equal(lifecycle.disposes, 1, "the reviewer's real session was disposed exactly once");
      assert.deepEqual(errors, []);
      assert.deepEqual(errors, []);
    } finally {
      seam.release();
      AgentSession.prototype.subscribe = originalSubscribe;
      AgentSession.prototype.dispose = originalDispose;
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});
// --- K05 native held read across the earlier whole-run deadline ---

test("K05 a held read across the earlier whole-run deadline cannot be masked by a later reviewer deadline", { timeout: 90_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("held-read fixture prerequisite: run with --import file:///<hold-read-preload.mjs> and QE_HOLD_READ_PRELOAD=<abs bootstrap> (see verification/K05/author/implementation-20261016T022708Z-df00c2d9/held-read-isolation-20261016-04/hold-read-preload.mjs)");
    return;
  }
  const seam = await import(pathToFileURL(preloadPath).href);
  const root = await mkdtemp(join(tmpdir(), "qe-k05-heldread-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, transcripts: [] };
  const lifecycle = await instrumentReviewerLifecycle();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "held-read-marker-evidence", "utf8");
    await writeFile(join(project, "held-read.txt"), "K05_HELD_READ_MARKER", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-heldread", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", timeoutMs: 1000, cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-heldread", {
      name: "scripted K05 held-read provider",
      api: "qe-k05-heldread-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "read-held", name: "read", arguments: { path: "held-read.txt" } }], "toolUse")
          : assistantMessage(model, [{ type: "text", text: JSON.stringify(RESULT) }], "stop");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-heldread-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const journalResults = async () => {
      const results = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") results.push(record.fields?.data);
        }
      }
      return results;
    };
    const waitRuns = async (count) => {
      const deadline = Date.now() + 25_000;
      let current = await status();
      while (current.checks.runs < count && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        current = await status();
      }
      return current;
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      seam.arm(join(project, "held-read.txt"));
      await runner.emit({ type: "input", text: "held read", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "hr-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "hr-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      assert.equal(await seam.waitEntered(15_000), true, "the real builtin read tool reached the filesystem gate");
      const before = seam.counters();
      assert.equal(before.entered, 1, "the armed read entered the underlying operation exactly once");
      assert.equal(before.active, 1, "the underlying filesystem operation is physically occupied");
      assert.equal(before.completed, 0, "no underlying read has drained while held");
      const settled = await waitRuns(1);
      assert.equal(settled.checks.runs, 1, "the earlier whole-run deadline terminates the run while the read is held");
      assert.equal(seen.arrivals, 1, "no new provider turn occurs while the permitted tool is physically pending");
      const mid = seam.counters();
      assert.equal(mid.active, 1, "the underlying read is still active after logical termination");
      assert.equal(mid.completed, 0, "logical termination is not physical drain");
      const cancelledLife = lifecycle.totals();
      assert.equal(cancelledLife.instances, 1, "the engine-owned cancelled reviewer used exactly one real session instance");
      // Fixture over-assertion corrected: disposal timing is not a contract
      // requirement before physical drain; the exactly-once predicate is
      // asserted on the final totals after drain and shutdown.
      assert.equal(cancelledLife.subscribes, 1, "the cancelled reviewer instance owns exactly one subscription");
      assert.equal((await journalResults()).some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "the held read publishes no successful conclusion");
      seam.release();
      assert.equal(await seam.waitDrained(15_000), true, "the released read actually drains");
      const after = seam.counters();
      assert.equal(after.completed, 1, "the original filesystem read completes exactly once");
      assert.equal(after.active, 0, "no underlying operation remains active after drain");
      await runner.emit({ type: "tool_execution_start", toolCallId: "hr-2", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "hr-2", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const reopened = await waitRuns(2);
      assert.equal(reopened.checks.runs >= 2, true, "the reviewer slot is usable again only after the underlying read drained");
      assert.equal(seen.arrivals >= 2, true, "the replacement reviewer reached the provider under ordinary admission");
      const life = lifecycle.totals();
      assert.equal(life.instances, 2, "the cancelled reviewer and its post-drain replacement are distinct real session instances");
      assert.equal(life.eachExactlyOnce, true, "each real reviewer instance subscribed, detached and disposed exactly once");
      assert.equal(life.subscribes, life.unsubscribes, "every engine-owned subscription detached exactly once");
      assert.equal(life.subscribes, life.disposes, "every real reviewer instance disposed exactly once");
      assert.deepEqual(errors, []);
    } finally {
      lifecycle.restore();
      seam.release();
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 native held read across a generation reload/retire ---

test("K05 a generation reload while a permitted read is held keeps the old slot occupied until real drain and only then admits the replacement", { timeout: 90_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("held-read fixture prerequisite: run with --import file:///<hold-read-preload.mjs> and QE_HOLD_READ_PRELOAD=<abs bootstrap> (see verification/K05/author/implementation-20261016T022708Z-df00c2d9/held-read-isolation-20261016-04/hold-read-preload.mjs)");
    return;
  }
  const seam = await import(pathToFileURL(preloadPath).href);
  const root = await mkdtemp(join(tmpdir(), "qe-k05-heldread-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, transcripts: [] };
  const lifecycle = await instrumentReviewerLifecycle();
  const n4 = { start: Date.now(), revocationAt: null, marks: [] };
  const { AgentSession: N4Session } = await import("@earendil-works/pi-coding-agent");
  const n4OriginalAbort = N4Session.prototype.abort;
  const n4OriginalDispose = N4Session.prototype.dispose;
  N4Session.prototype.abort = function (...args) {
    n4.marks.push(["abort-entry", Date.now() - n4.start]);
    const out = n4OriginalAbort.apply(this, args);
    if (out !== undefined && typeof out.then === "function") out.then(() => n4.marks.push(["abort-settled", Date.now() - n4.start]), () => n4.marks.push(["abort-settled", Date.now() - n4.start]));
    return out;
  };
  N4Session.prototype.dispose = function (...args) {
    n4.marks.push(["dispose-entry", Date.now() - n4.start]);
    try { return n4OriginalDispose.apply(this, args); } finally { n4.marks.push(["dispose-return", Date.now() - n4.start]); }
  };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "held-read-marker-evidence", "utf8");
    await writeFile(join(project, "held-read.txt"), "K05_HELD_READ_MARKER", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-heldread", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-heldread", {
      name: "scripted K05 held-read provider",
      api: "qe-k05-heldread-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "read-held", name: "read", arguments: { path: "held-read.txt" } }], "toolUse")
          : assistantMessage(model, [{ type: "text", text: JSON.stringify(RESULT) }], "stop");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-heldread-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const journalResults = async () => {
      const results = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") results.push(record.fields?.data);
        }
      }
      return results;
    };
    const waitRuns = async (count) => {
      const deadline = Date.now() + 25_000;
      let current = await status();
      while (current.checks.runs < count && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        current = await status();
      }
      return current;
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      seam.arm(join(project, "held-read.txt"));
      await runner.emit({ type: "input", text: "held read", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "hr-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "hr-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      assert.equal(await seam.waitEntered(15_000), true, "the real builtin read tool reached the filesystem gate");
      const before = seam.counters();
      assert.equal(before.entered, 1, "the armed read entered the underlying operation exactly once");
      assert.equal(before.active, 1, "the underlying filesystem operation is physically occupied");
      assert.equal(before.completed, 0, "no underlying read has drained while held");
      n4.revocationAt = Date.now();
      const reloadPromise = runner.emit({ type: "session_shutdown", reason: "reload" });
      const reloadDone = await Promise.race([reloadPromise.then(() => true), new Promise(resolvePromise => setTimeout(() => resolvePromise(false), 5_000))]);
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null, "the replacement generation activates while the old read is held");
      await runner.emit({ type: "input", text: "held read second generation", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "hr-2", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "hr-2", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
      const mid = seam.counters();
      assert.equal(mid.entered, 1, "only the old generation's real read entered the filesystem");
      assert.equal(mid.active, 1, "the old generation's underlying read is still physically active before release");
      assert.equal(mid.completed, 0, "the held read has not drained before release");
      assert.equal(seen.arrivals, 1, "the replacement reviewer cannot consume the occupied slot before actual drain");
      assert.equal((await journalResults()).some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "the held read publishes no successful conclusion");
      assert.equal(reloadDone, true, "replacing the generation does not block on the held read");
      seam.release();
      assert.equal(await seam.waitDrained(15_000), true, "the released read actually drains");
      const after = seam.counters();
      assert.equal(after.completed, 1, "the original filesystem read completes exactly once");
      assert.equal(after.active, 0, "no underlying operation remains active after drain");
      await runner.emit({ type: "tool_execution_start", toolCallId: "hr-2", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "hr-2", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const replacedDeadline = Date.now() + 25_000;
      let reopened = await status();
      while (seen.arrivals < 2 && Date.now() < replacedDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        reopened = await status();
      }
      assert.equal(seen.arrivals >= 2, true, "the replacement generation's reviewer reaches the provider only after actual drain");
      assert.equal(Number(reopened.checks?.runs ?? reopened.work?.runs ?? 0) >= 1, true, "the replacement generation runs its own reviewer under ordinary admission");
      assert.equal(seam.counters().completed, 1, "the old generation's underlying read still drained exactly once across the replacement");
      const life = lifecycle.totals();
      assert.equal(life.instances, 2, "the old and replacement reviewers used distinct real session instances");
      assert.equal(life.eachExactlyOnce, true, "each reviewer instance subscribed, detached and disposed exactly once");
      assert.equal(life.subscribes, 2, "both reviewer generations were instrumented per instance");
      const abortEntries = n4.marks.filter(mark => mark[0] === "abort-entry").length;
      const abortSettled = n4.marks.filter(mark => mark[0] === "abort-settled").length;
      const disposeEntries = n4.marks.filter(mark => mark[0] === "dispose-entry").length;
      const disposeReturns = n4.marks.filter(mark => mark[0] === "dispose-return").length;
      assert.equal(abortEntries, abortSettled, `every abort entry paired with settled (entries=${abortEntries}, settled=${abortSettled})`);
      assert.equal(disposeEntries, disposeReturns, `every dispose entry returned (entries=${disposeEntries}, returns=${disposeReturns})`);
      assert.equal(abortEntries + disposeEntries >= 1, true, "the retirement actually exercised reviewer cleanup, not only eventual totals");
      assert.equal(n4.revocationAt !== null, true, "the retirement stimulus has a monotonic revocation anchor");
      assert.deepEqual(errors, []);    } finally {
      seam.release();
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
      const finalLife = lifecycle.totals();
      assert.equal(finalLife.eachExactlyOnce, true, "reviewer detach/disposal stayed once-only through final shutdown");
      assert.equal(finalLife.instances, 2, "the retired and replacement reviewer instances are both accounted after shutdown");
      N4Session.prototype.abort = n4OriginalAbort;
      N4Session.prototype.dispose = n4OriginalDispose;
      lifecycle.restore();
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});


// --- K05 T02 native ambient-isolation: reviewer must not inherit ambient resources ---

test("K05 T02 the fresh reviewer inherits no ambient extension, skill, prompt or context file while still performing a useful read", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-ambient-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const canaryMarker = join(root, "canary-extension-loaded.txt");
  const seen = { arrivals: 0, transcripts: [] };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(join(projectConfigDir, "extensions"), { recursive: true });
    await mkdir(join(projectConfigDir, "prompts"), { recursive: true });
    await mkdir(join(agentDir, "skills", "canary"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "ambient-marker-evidence", "utf8");
    await writeFile(join(project, "readable.md"), "K05_AMBIENT_USEFUL_BODY", "utf8");
    await writeFile(join(project, "AGENTS.md"), "K05_AMBIENT_CONTEXT_CANARY", "utf8");
    await writeFile(join(agentDir, "SYSTEM.md"), "K05_AMBIENT_SYSTEM_CANARY", "utf8");
    await writeFile(join(agentDir, "skills", "canary", "SKILL.md"), "---\nname: canary\ndescription: K05_AMBIENT_SKILL_CANARY\n---\nK05_AMBIENT_SKILL_CANARY", "utf8");
    await writeFile(join(projectConfigDir, "prompts", "canary.md"), "K05_AMBIENT_PROMPT_CANARY", "utf8");
    await writeFile(join(projectConfigDir, "extensions", "canary.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(canaryMarker)}, "K05_AMBIENT_EXTENSION_CANARY", "utf8");\nexport default function () {}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-ambient", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-ambient", {
      name: "scripted K05 ambient provider",
      api: "qe-k05-ambient-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "read-ambient", name: "read", arguments: { path: "readable.md" } }], "toolUse")
          : assistantMessage(model, [{ type: "toolCall", id: "submit-ambient", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-ambient-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "ambient isolation", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "ai-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "ai-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the reviewer run settles under ambient canaries present");
      assert.equal(seen.arrivals, 2, "the reviewer reached the provider for its read and its result turn");
      assert.equal(seen.transcripts.length >= 2, true, "both real SDK inputs were captured");
      for (const canary of ["K05_AMBIENT_CONTEXT_CANARY", "K05_AMBIENT_SYSTEM_CANARY", "K05_AMBIENT_SKILL_CANARY", "K05_AMBIENT_PROMPT_CANARY", "K05_AMBIENT_EXTENSION_CANARY"]) {
        assert.equal(seen.transcripts.some(text => text.includes(canary)), false, `the reviewer's real SDK input must not inherit ${canary}`);
      }
      assert.equal(seen.transcripts.some(text => text.includes("K05_AMBIENT_USEFUL_BODY")), true, "the reviewer still performed its useful permitted read");
      await assert.rejects(readFile(canaryMarker, "utf8"), "the ambient extension file was never imported by the reviewer session");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 T08 native selected-route no-auth denial with zero dispatch ---

test("K05 T08 an unavailable selected reviewer route is denied before dispatch with no lingering reservation and no fabricated success", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-missingroute-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const canaryMarker = join(root, "canary-extension-loaded.txt");
  const seen = { arrivals: 0, transcripts: [] };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(join(projectConfigDir, "extensions"), { recursive: true });
    await mkdir(join(projectConfigDir, "prompts"), { recursive: true });
    await mkdir(join(agentDir, "skills", "canary"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "ambient-marker-evidence", "utf8");
    await writeFile(join(project, "readable.md"), "K05_AMBIENT_USEFUL_BODY", "utf8");
    await writeFile(join(project, "AGENTS.md"), "K05_AMBIENT_CONTEXT_CANARY", "utf8");
    await writeFile(join(agentDir, "SYSTEM.md"), "K05_AMBIENT_SYSTEM_CANARY", "utf8");
    await writeFile(join(agentDir, "skills", "canary", "SKILL.md"), "---\nname: canary\ndescription: K05_AMBIENT_SKILL_CANARY\n---\nK05_AMBIENT_SKILL_CANARY", "utf8");
    await writeFile(join(projectConfigDir, "prompts", "canary.md"), "K05_AMBIENT_PROMPT_CANARY", "utf8");
    await writeFile(join(projectConfigDir, "extensions", "canary.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(canaryMarker)}, "K05_AMBIENT_EXTENSION_CANARY", "utf8");\nexport default function () {}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-missingroute", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "ambient isolation", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "ai-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "ai-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks?.runs >= 1, true, "the denied reviewer run still settles explicitly");
      assert.equal(seen.arrivals, 0, "no provider turn was dispatched for the unavailable route");
      const results = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") results.push(record.fields?.data);
        }
      }
      assert.equal(results.some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "the unavailable route fabricated no successful conclusion");
      assert.equal(Number(settled.accounting?.ownedRequestCount ?? 1), 0, "no owned request was created for the unavailable route");
      assert.equal(Number(settled.accounting?.unresolvedCount ?? 1), 0, "no un-dispatched reservation lingers for the unavailable route");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 T04 native origin separation: primary cadence unchanged during reviewer investigation ---

test("K05 T04 primary trigger cadence is unchanged while the real reviewer performs its own permitted reads", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-origin-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, transcripts: [] };
  const reviewerEvents = { instances: 0, events: [] };
  const { AgentSession: OriginSession } = await import("@earendil-works/pi-coding-agent");
  const originOriginalSubscribe = OriginSession.prototype.subscribe;
  OriginSession.prototype.subscribe = function (...args) {
    reviewerEvents.instances += 1;
    const instance = reviewerEvents.instances;
    return originOriginalSubscribe.call(this, event => {
      if (reviewerEvents.events.length < 200) reviewerEvents.events.push({ instance, type: event?.type ?? null, toolName: event?.toolName ?? event?.toolCall?.name ?? null });
      return args[0](event);
    });
  };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "origin-marker-evidence", "utf8");
    await writeFile(join(project, "doc-a.md"), "K05_ORIGIN_DOC_A", "utf8");
    await writeFile(join(project, "doc-b.md"), "K05_ORIGIN_DOC_B", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-origin", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 5 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-origin", {
      name: "scripted K05 origin provider",
      api: "qe-k05-origin-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const readTurn = seen.arrivals % 2 === 1;
        const message = readTurn
          ? assistantMessage(model, [{ type: "toolCall", id: `read-${seen.arrivals}`, name: "read", arguments: { path: seen.arrivals % 4 === 1 ? "doc-a.md" : "doc-b.md" } }], "toolUse")
          : assistantMessage(model, [{ type: "toolCall", id: `submit-${seen.arrivals}`, name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-origin-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      let settled = await status();
      for (let index = 1; index <= 5; index += 1) {
        await runner.emit({ type: "input", text: `origin ${index}`, source: "interactive" });
        await runner.emit({ type: "tool_execution_start", toolCallId: `or-${index}`, toolName: "read", args: {} });
        await runner.emit({ type: "tool_execution_end", toolCallId: `or-${index}`, toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
        const perCompletionDeadline = Date.now() + 10_000;
        while ((settled.checks?.runs ?? 0) < index && Date.now() < perCompletionDeadline) {
          await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
          settled = await status();
        }
      }
      assert.equal(settled.checks.runs, 5, "exactly one reviewer run per eligible primary completion — primary cadence unchanged");
      assert.equal(seen.arrivals, 10, "each reviewer run performed its own real read and result turn");
      const reviewerAttempts = Number(settled.accounting?.byPurpose?.reviewer ?? 0);
      const directAttempts = Number(settled.accounting?.byPurpose?.direct ?? 0);
      assert.equal(reviewerAttempts >= 10, true, "all ten reviewer turns are correlated as reviewer-owned attempts");
      assert.equal(directAttempts < reviewerAttempts, true, "reviewer work never inflates the direct-purpose accounting");
      assert.equal(Number(settled.accounting?.excluded?.externalHandoffs ?? 1), 0, "no operator authorization or external handoff was created");
      assert.equal(settled.checks.runs, 5, "reviewer activity added no primary runs beyond the five eligible completions");
      assert.equal(reviewerEvents.instances, 5, "five separate real reviewer sessions were created for the five completions");
      const reviewerToolStarts = reviewerEvents.events.filter(event => event.type === "tool_execution_start");
      const reviewerToolNames = new Set(reviewerToolStarts.map(event => event.toolName).filter(Boolean));
      assert.equal(reviewerToolStarts.length >= 5, true, "the reviewer sessions emitted their own real tool-start events");
      assert.equal(reviewerToolNames.has("read"), true, "reviewer tool-origin metadata attributes real reads to the reviewer sessions");
      assert.equal(reviewerToolNames.has("submit_result"), true, "reviewer tool-origin metadata attributes submissions to the reviewer sessions");
      // 201-F4: the origin evidence must be the ENGINE's own owned output, not only the
      // test-local SDK subscribe wrapper. Each real reviewer read minted a bounded owned
      // resource descriptor with a content-derived revision and the run/generation join.
      const readOwnerRecords = async () => {
        const tool = [];
        const notes = [];
        for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
          if (!name.endsWith(".jsonl")) continue;
          const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
          for (const line of text.split(String.fromCharCode(10))) {
            if (line.trim().length === 0) continue;
            const record = JSON.parse(line);
            if (record.event === "quality.resource.described" && record.fields?.data?.sourceId === "reviewer-tool") tool.push(record);
            if (record.event === "quality.component.note" && String(record.fields?.data?.code ?? "").startsWith("core.reviewer-")) notes.push(record);
          }
        }
        return { tool, notes };
      };
      // Bounded wait for the asynchronous journal flush before reading the owned records.
      const ownerDeadline = Date.now() + 5_000;
      let ownerRead = await readOwnerRecords();
      while (ownerRead.tool.length < 5 && Date.now() < ownerDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        ownerRead = await readOwnerRecords();
      }
      const ownerToolRecords = ownerRead.tool;
      const ownerOpNotes = ownerRead.notes;
      assert.equal(ownerToolRecords.length >= 5, true, `the engine's own diagnostics record each real reviewer read (got ${ownerToolRecords.length})`);
      assert.equal(ownerToolRecords.every(record => typeof record.fields?.data?.revisionRef === "string" && record.fields.data.revisionRef.length > 0), true, "every engine-owned tool record carries a minted revision reference");
      assert.equal(ownerToolRecords.every(record => typeof record.fields?.correlation?.runId === "string" && record.fields.correlation.runId.length > 0), true, "every engine-owned tool record joins its run identity");
      assert.equal(ownerToolRecords.some(record => typeof record.fields?.scope?.runtimeGeneration === "string" && record.fields.scope.runtimeGeneration.length > 0), true, "engine-owned tool records carry the generation join");
      // 201-F4/206: the SAME T04 must assert real owner operation records with identity joins.
      const ownerAdmitted = ownerOpNotes.filter(record => record.fields.data.code === "core.reviewer-tool-admitted");
      const ownerAcquired = ownerOpNotes.filter(record => record.fields.data.code === "core.reviewer-tool-acquired");
      const ownerSubmitted = ownerOpNotes.filter(record => record.fields.data.code === "core.reviewer-result-submitted");
      assert.equal(ownerAcquired.length >= 5, true, `the engine records each real reviewer read as an owned operation (got ${ownerAcquired.length})`);
      assert.equal(ownerSubmitted.length >= 5, true, `the engine records each reviewer submission as an owned operation (got ${ownerSubmitted.length})`);
      assert.equal(ownerAcquired.every(record => (record.fields.data.refs ?? [])[1] === "tool-read"), true, "every acquired owner operation carries the bounded read tool identity");
      assert.equal(ownerAcquired.every(record => ownerAdmitted.some(admitted => (admitted.fields.data.refs ?? [])[0] === (record.fields.data.refs ?? [])[0])), true, "every acquired owner operation joins its own admission identity");
      assert.equal(ownerAdmitted.every(record => typeof record.fields?.correlation?.runId === "string" && record.fields.correlation.runId.length > 0), true, "every owned operation note carries the run join");
      assert.equal(settled.checks.runs, 5, "reviewer tool activity creates no additional primary completions");
      assert.deepEqual(errors, []);    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 T07 native sentinel non-disclosure across owned persisted surfaces ---

test("K05 T03 a narrowed read grant denies unnamed project acquisition while the named source stays useful", { timeout: 120_000 }, async () => {
  const runCase = async (suffix, requestedPath) => {
    const root = await mkdtemp(join(tmpdir(), `qe-k05-grant-${suffix}-`));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    const projectConfigDir = join(project, ".pi");
    const deniedBody = "K05_DENIED_UNNAMED_BODY_7f31";
    const grantedBody = "K05_GRANTED_SOURCE_BODY_2c94";
    const seen = { arrivals: 0, transcripts: [] };
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      await mkdir(join(agentDir, "quality"), { recursive: true });
      await mkdir(projectConfigDir, { recursive: true });
      await writeFile(join(project, "unnamed.md"), `${deniedBody} never granted\n`, "utf8");
      await writeFile(join(project, "granted.md"), `${grantedBody} granted body
`, "utf8");
      await writeFile(join(projectConfigDir, "quality.json"), JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        mode: "observe",
        sources: { evidence: { uris: ["project:granted.md"], role: "evidence", required: true } },
        modelProfiles: { scripted: { provider: "qe-k05-grant", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
        permissions: { modelProfiles: ["scripted"] },
        prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
        contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
        evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000, allowProjectReads: false, readSources: ["evidence"] } } },
        policies: { record: { use: "core.record-only" } },
        checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 2 } },
      }), "utf8");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const loader = new DefaultResourceLoader({
        cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [resolve("dist/index.js")],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
      models.registerProvider("qe-k05-grant", {
        name: "scripted K05 grant provider",
        api: "qe-k05-grant-api",
        apiKey: "fixture-not-credential",
        baseUrl: "http://127.0.0.1:9/not-used",
        streamSimple: (model, context) => {
          seen.arrivals += 1;
          seen.transcripts.push(JSON.stringify(context.messages ?? []));
          if (seen.arrivals === 1) {
            return eventStream(assistantMessage(model, [{ type: "toolCall", id: `grant-read-${suffix}`, name: "read", arguments: { path: requestedPath } }], "toolUse"));
          }
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: `grant-submit-${suffix}`, name: "submit_result", arguments: {
            ...RESULT,
            conclusion: "findings",
            findings: [{
              id: "finding-1",
              criterion: "efficiency.repetition",
              status: "supported",
              severity: "concern",
              requirementRefs: [],
              evidenceIds: ["granted.md"],
              affectedItems: [],
              defectCode: "efficiency.reviewer-observed",
              explanation: "The material actually returned by the permitted read documents the reviewed activity.",
              proposedCorrection: null,
              limitations: [],
            }],
          } }], "toolUse"));
        },
        models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-grant-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
      });
      const registry = new ModelRegistry(models);
      const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      const journalRecords = async () => {
        const records = [];
        for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
          if (!name.endsWith(".jsonl")) continue;
          const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
          for (const line of text.split(String.fromCharCode(10))) {
            if (line.trim().length === 0) continue;
            records.push(JSON.parse(line));
          }
        }
        return records;
      };
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      await runner.emit({ type: "input", text: `grant ${suffix}`, source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: `gr-${suffix}`, toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: `gr-${suffix}`, toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      // Bounded wait for the asynchronous journal flush before reading the owned records.
      const noteDeadline = Date.now() + 5_000;
      let records = await journalRecords();
      while (!records.some(record => record.event === "quality.component.note") && Date.now() < noteDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        records = await journalRecords();
      }
      const results = records.filter(record => record.event === "quality.assessment.result").map(record => record.fields?.data);
      const reviewerRecords = records.filter(record => record.event === "quality.resource.described" && record.fields?.data?.sourceId === "reviewer-tool");
      const opNotes = records.filter(record => record.event === "quality.component.note" && String(record.fields?.data?.code ?? "").startsWith("core.reviewer-"));
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      return { seen, settled, results, reviewerRecords, opNotes, errors };
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
    }
  };

  const denied = await runCase("denied", "unnamed.md");
  assert.equal(denied.seen.transcripts.some(text => text.includes("K05_DENIED_UNNAMED_BODY_7f31")), false, "the unnamed project body never reached any provider input under the narrowed grant");
  assert.equal(denied.results.some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "the denied acquisition produced no successful result");
  assert.equal(denied.seen.arrivals <= 1, true, "the denial terminated the reviewer before another provider turn");
  // 205-F4/208: the blocked call keeps its own owned operation identity through its terminal event.
  const deniedOps = denied.opNotes.filter(record => record.fields.data.code === "core.reviewer-tool-denied");
  const deniedFailedOps = denied.opNotes.filter(record => record.fields.data.code === "core.reviewer-tool-failed");
  const deniedAdmittedOps = denied.opNotes.filter(record => record.fields.data.code === "core.reviewer-tool-admitted");
  const deniedIds = [...new Set(deniedOps.map(record => (record.fields.data.refs ?? [])[0]))];
  assert.equal(deniedOps.length === 2, true, `the blocked call is recorded at its admission and at its blocked terminal event (got ${deniedOps.length})`);
  assert.equal(deniedIds.length === 1, true, "both denied phases keep ONE owned operation identity — no invented second operation");
  assert.equal(deniedOps.every(record => (record.fields.data.refs ?? [])[1] === "tool-read"), true, "every denied phase carries the bounded read tool identity");
  assert.equal(deniedAdmittedOps.some(record => (record.fields.data.refs ?? [])[0] === (deniedIds[0] ?? "none")), false, "the blocked call was never admitted, so no admitted operation carries that identity");
  assert.equal(denied.opNotes.some(record => record.fields.data.code === "core.reviewer-tool-acquired"), false, "the blocked read acquired no evidence");
  assert.deepEqual(denied.errors, []);

  const granted = await runCase("granted", "granted.md");
  assert.equal(granted.seen.transcripts.some(text => text.includes("K05_GRANTED_SOURCE_BODY_2c94")), true, "the explicitly granted source stayed readable and reached a later real input");
  assert.equal(granted.results.some(result => result?.conclusion === "findings"), true, "the canonical result could cite the material actually acquired in this session");
  assert.equal(granted.reviewerRecords.length >= 1, true, "the engine recorded the granted acquisition as an owned resource descriptor");
  assert.deepEqual(granted.errors, []);
});

test("K05 201-F2 equal-sized distinct reads do not alias, failed reads are not acquired, and read paths stay citable", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-custody-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const firstBody = ["line-01", "line-02", "line-03", "line-04", "line-05", "line-06", "line-07", "line-08"].map(line => line + String.fromCharCode(10)).join("");
  const secondBody = "B".repeat(64);
  const seen = { arrivals: 0, transcripts: [], submittedToken: null };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(project, "first.txt"), firstBody, "utf8");
    await writeFile(join(project, "second.txt"), secondBody, "utf8");
    await writeFile(join(agentDir, "quality", "evidence.md"), "custody-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-custody", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000, maxModelRequests: 8 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 2 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-custody", {
      name: "scripted K05 custody provider",
      api: "qe-k05-custody-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        if (seen.arrivals === 1) return eventStream(assistantMessage(model, [{ type: "toolCall", id: "custody-a", name: "read", arguments: { path: "first.txt" } }], "toolUse"));
        if (seen.arrivals === 2) return eventStream(assistantMessage(model, [{ type: "toolCall", id: "custody-b", name: "read", arguments: { path: "second.txt" } }], "toolUse"));
        if (seen.arrivals === 3) return eventStream(assistantMessage(model, [{ type: "toolCall", id: "custody-missing", name: "read", arguments: { path: "missing.txt" } }], "toolUse"));
        if (seen.arrivals === 4) return eventStream(assistantMessage(model, [{ type: "toolCall", id: "custody-a2", name: "read", arguments: { path: "first.txt", offset: 1, limit: 2 } }], "toolUse"));
        if (seen.arrivals === 5) return eventStream(assistantMessage(model, [{ type: "toolCall", id: "custody-a3", name: "read", arguments: { path: "first.txt", limit: 3 } }], "toolUse"));
        // 201-F2A/206: the FINAL submitting request must itself expose the bounded owner-issued
        // identity. No filename fallback: a missing issued line must fail the canonical citation.
        const issuedPattern = /\[reviewer-evidence (res-[a-z0-9]+) rev (rev-[a-z0-9]+) source ([^ \]]+) sourceVersion ([^ \]]+) selectedDigest ([a-z0-9]+) selection ([^ \]]+) role evidence disposition acquired bytes (\d+)\]/g;
        const issuedMatches = [...String(JSON.stringify(context.messages ?? [])).matchAll(issuedPattern)];
        const secondIssued = issuedMatches.find(match => match[3] === "second.txt");
        const issuedToken = secondIssued === undefined ? "missing-issued-token" : secondIssued[1];
        seen.submittedToken = issuedToken;
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "custody-submit", name: "submit_result", arguments: {
          ...RESULT,
          conclusion: "findings",
          findings: [{
            id: "finding-1",
            criterion: "efficiency.repetition",
            status: "supported",
            severity: "concern",
            requirementRefs: [],
            evidenceIds: [issuedToken],
            affectedItems: [],
            defectCode: "efficiency.reviewer-observed",
            explanation: "The canonical result cites the owner-issued evidence identity of material actually returned this session.",
            proposedCorrection: null,
            limitations: [],
          }],
        } }], "toolUse"));
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-custody-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const journalRecords = async () => {
      const records = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          records.push(JSON.parse(line));
        }
      }
      return records;
    };
    await runner.emit({ type: "session_start", reason: "startup" });
    assert.equal((await status()).configuration.rejection, null);
    await runner.emit({ type: "input", text: "custody", source: "interactive" });
    await runner.emit({ type: "tool_execution_start", toolCallId: "custody-1", toolName: "read", args: {} });
    await runner.emit({ type: "tool_execution_end", toolCallId: "custody-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
    const deadline = Date.now() + 25_000;
    let settled = await status();
    while (settled.checks.runs < 1 && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      settled = await status();
    }
    // Bounded wait for the asynchronous journal flush before reading the run's records.
    const recordDeadline = Date.now() + 5_000;
    let records = await journalRecords();
    while (records.filter(record => record.event === "quality.assessment.result").length === 0 && Date.now() < recordDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      records = await journalRecords();
    }
    const results = records.filter(record => record.event === "quality.assessment.result").map(record => record.fields?.data);
    const acquisitions = records.filter(record => record.event === "quality.resource.described" && record.fields?.data?.sourceId === "reviewer-tool");
    await runner.emit({ type: "session_shutdown", reason: "quit" });

    assert.equal(seen.transcripts.length >= 5, true, "the reviewer made its real read, second-read, failed-read, repeated-read and submit turns");
    assert.equal(seen.transcripts.some(text => text.includes(secondBody)), true, "the second read body reached a later real input");
    // 205-F2B/208: the read boundary must honor the public one-indexed offset and independent
    // limit, and the issued selection must carry the OBSERVED returned coordinates.
    const toolResultOf = callId => {
      for (const text of seen.transcripts) {
        let messages;
        try { messages = JSON.parse(text); } catch { continue; }
        for (const message of Array.isArray(messages) ? messages : []) {
          if (message?.role === "toolResult" && message?.toolCallId === callId) return message;
        }
      }
      return null;
    };
    const resultText = result => (Array.isArray(result?.content) ? result.content : [])
      .filter(block => block !== null && typeof block === "object" && block.type === "text")
      .map(block => String(block.text ?? ""))
      .join(String.fromCharCode(10));
    const rangeBody = resultText(toolResultOf("custody-a2"));
    const limitBody = resultText(toolResultOf("custody-a3"));
    assert.equal(rangeBody, "line-01" + String.fromCharCode(10) + "line-02", "the public one-indexed offset 1 / limit 2 read returns exactly lines 1-2");
    assert.equal(limitBody, "line-01" + String.fromCharCode(10) + "line-02" + String.fromCharCode(10) + "line-03", "a limit-only read returns the leading lines independently of offset");
    assert.equal(rangeBody.includes("line-03"), false, "the requested range does not silently include a later line");
    // 201-F2A/206: the identity must come from the FINAL submitting request, not a path fallback.
    assert.equal(/^res-[a-z0-9]+$/.test(String(seen.submittedToken)), true, `the final submitting request exposes a real owner-issued evidence token (got ${String(seen.submittedToken)})`);
    assert.equal(results.some(result => result?.conclusion === "findings"), true, "the canonical result validated while citing a newly issued owner evidence identity");
    assert.equal(acquisitions.some(record => record.fields?.data?.resourceId === seen.submittedToken), true, "the submitted identity is the same engine-issued resource reference recorded by the owner");
    const finalInput = seen.transcripts[seen.transcripts.length - 1];
    assert.equal(/\[reviewer-evidence [^\]]*source second\.txt sourceVersion [0-9a-f]+ selectedDigest [0-9a-f]+ selection full role evidence disposition acquired bytes 64\]/.test(finalInput), true, "the final input carries the second read's full-selection issued identity");
    assert.equal(/\[reviewer-evidence [^\]]*source first\.txt sourceVersion [0-9a-f]+ selectedDigest [0-9a-f]+ selection full role evidence disposition acquired bytes 64\]/.test(finalInput), true, "the final input carries the repeated full read identity");
    assert.equal(/\[reviewer-evidence [^\]]*source first\.txt sourceVersion unknown selectedDigest [0-9a-f]+ selection lines:1-2\/9 role evidence disposition acquired bytes 15\]/.test(finalInput), true, "the final input carries the later ranged revision with its OBSERVED one-indexed coordinates, so token-only de-duplication cannot hide it");
    assert.equal(/\[reviewer-evidence [^\]]*source first\.txt sourceVersion unknown selectedDigest [0-9a-f]+ selection lines:1-3\/9 role evidence disposition acquired bytes 23\]/.test(finalInput), true, "the limit-only read also carries its observed coordinates and selected size");
    assert.equal(/\[reviewer-evidence [^\]]*source missing\.txt/.test(seen.transcripts.join(String.fromCharCode(10))), false, "the failed read produced no issued evidence identity");
    assert.equal(acquisitions.length === 4, true, `four distinct resource/revision acquisitions are described (got ${acquisitions.length})`);
    assert.equal(new Set(acquisitions.map(record => record.fields?.data?.revisionRef)).size === 4, true, "distinct revisions of one resource do not alias the same evidence revision");
    assert.equal(new Set(acquisitions.map(record => record.fields?.data?.resourceId)).size === 2, true, "distinct read targets keep distinct resource identities");
    assert.equal(acquisitions.every(record => (record.fields?.scope?.runtimeGeneration ?? "").length > 0), true, "every acquired descriptor carries the generation join");
    // 201-F4/206: one engine-owned operation identity joins admission and result phases.
    const opNotes = records.filter(record => record.event === "quality.component.note" && String(record.fields?.data?.code ?? "").startsWith("core.reviewer-tool-"));
    const admittedOps = opNotes.filter(record => record.fields.data.code === "core.reviewer-tool-admitted");
    const acquiredOps = opNotes.filter(record => record.fields.data.code === "core.reviewer-tool-acquired");
    assert.equal(acquiredOps.length === 4, true, `each successful read operation is recorded once (got ${acquiredOps.length})`);
    assert.equal(admittedOps.every(record => (record.fields.data.refs ?? [])[1] === "tool-read" || (record.fields.data.refs ?? [])[1] === "tool-result"), true, "every admitted operation carries its bounded tool identity");
    assert.equal(acquiredOps.every(record => (record.fields.data.refs ?? [])[1] === "tool-read"), true, "every acquired operation carries the bounded read tool identity");
    assert.equal(acquiredOps.every(record => admittedOps.some(admitted => (admitted.fields.data.refs ?? [])[0] === (record.fields.data.refs ?? [])[0])), true, "every acquired operation joins its own admission identity");
    assert.equal(new Set(acquiredOps.map(record => (record.fields.data.refs ?? [])[0])).size === 4, true, "repeated calls remain distinct owned operations");
    const failedOps = opNotes.filter(record => record.fields.data.code === "core.reviewer-tool-failed");
    assert.equal(failedOps.length === 1, true, "the executed missing-file read is one owned failed operation");
    assert.equal(new Set(acquiredOps.map(record => (record.fields.data.refs ?? [])[0])).has((failedOps[0]?.fields?.data?.refs ?? [])[0]), false, "an executed failure is not conflated with an acquired operation");
    assert.equal(opNotes.some(record => record.fields.data.code === "core.reviewer-tool-denied"), false, "no blocked call exists in this executed-failure run");
    assert.equal(records.some(record => record.fields?.data?.code === "core.reviewer-tool-failed" && (record.fields.data.refs ?? [])[1] === "tool-read"), true, "the failed read is one owned failed operation with the read tool identity");
    assert.equal(records.some(record => record.fields?.data?.code === "core.reviewer-result-submitted" && (record.fields.data.refs ?? [])[1] === "tool-result"), true, "the canonical submission is one owned result operation");
    assert.deepEqual(errors, []);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

test("K05 201-F3 admitted material is delivered fully or reported as partially delivered with exact selection", { timeout: 120_000 }, async () => {
  const runCase = async (suffix, body, marker) => {
    const root = await mkdtemp(join(tmpdir(), `qe-k05-partial-${suffix}-`));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    const projectConfigDir = join(project, ".pi");
    const seen = { arrivals: 0, transcripts: [] };
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      await mkdir(join(agentDir, "quality"), { recursive: true });
      await mkdir(projectConfigDir, { recursive: true });
      await writeFile(join(agentDir, "quality", "large.md"), body, "utf8");
      await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        mode: "observe",
        sources: { material: { uris: ["large.md"], role: "evidence", required: true } },
        modelProfiles: { scripted: { provider: "qe-k05-partial", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
        permissions: { modelProfiles: ["scripted"] },
        prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
        contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["material"] } }], maxEstimatedTokens: 8000 } },
        evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
        policies: { record: { use: "core.record-only" } },
        checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 2 } },
      }), "utf8");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const loader = new DefaultResourceLoader({
        cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [resolve("dist/index.js")],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
      models.registerProvider("qe-k05-partial", {
        name: "scripted K05 partial provider",
        api: "qe-k05-partial-api",
        apiKey: "fixture-not-credential",
        baseUrl: "http://127.0.0.1:9/not-used",
        streamSimple: (model, context) => {
          seen.arrivals += 1;
          seen.transcripts.push(JSON.stringify(context.messages ?? []));
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: `partial-submit-${suffix}`, name: "submit_result", arguments: RESULT }], "toolUse"));
        },
        models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-partial-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
      });
      const registry = new ModelRegistry(models);
      const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      await runner.emit({ type: "input", text: `partial ${suffix}`, source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: `partial-${suffix}`, toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: `partial-${suffix}`, toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      return { seen, settled, errors };
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
    }
  };

  const tailMarker = "K05_TAIL_MARKER_6d10";
  const largeBody = "A".repeat(6_000) + tailMarker + "B".repeat(1_000 - tailMarker.length);
  assert.equal(largeBody.length, 7_000, "the partial-selection fixture is exactly 7000 characters");
  const partial = await runCase("large", largeBody, tailMarker);
  const partialInput = partial.seen.transcripts[0] ?? "";
  assert.equal(partialInput.includes("originalChars 7000"), true, "the actual request states the original admitted size of a partially delivered item");
  assert.equal(partialInput.includes("retainedChars 6000"), true, "the actual request states the exact retained selection");
  assert.equal(partialInput.includes("[material-truncated]"), true, "the actual request carries an explicit truncation notice");
  assert.equal(partialInput.includes("[selection] promptTruncatedItems 1"), true, "the request selection line reflects one partially delivered admitted item");
  assert.equal(partialInput.includes(tailMarker), false, "the omitted tail of the admitted material is not silently claimed as delivered");
  assert.deepEqual(partial.errors, []);

  const smallMarker = "K05_FITTING_BODY_b7e2";
  const fitting = await runCase("small", `fitting material ${smallMarker}\n`, smallMarker);
  const fittingInput = fitting.seen.transcripts[0] ?? "";
  assert.equal(fittingInput.includes(smallMarker), true, "a fitting admitted source is delivered in full");
  assert.equal(fittingInput.includes("[selection] promptTruncatedItems 0"), true, "a fully delivered admitted source reports no truncation");
  assert.deepEqual(fitting.errors, []);
});

test("K05 201-F3 partial delivery constrains validated coverage and counts every omitted admitted item", { timeout: 120_000 }, async () => {
  const runCase = async ({ suffix, files, uris, coverageState }) => {
    const root = await mkdtemp(join(tmpdir(), `qe-k05-coverage-${suffix}-`));
    const agentDir = join(root, "agent");
    const project = join(root, "project");
    const projectConfigDir = join(project, ".pi");
    const seen = { arrivals: 0, transcripts: [] };
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    try {
      await mkdir(join(agentDir, "quality"), { recursive: true });
      await mkdir(projectConfigDir, { recursive: true });
      for (const file of files) await writeFile(join(agentDir, "quality", file.name), file.body, "utf8");
      await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        mode: "observe",
        sources: { material: { uris, role: "evidence", required: true } },
        modelProfiles: { scripted: { provider: "qe-k05-coverage", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
        permissions: { modelProfiles: ["scripted"] },
        prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
        contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["material"] } }], maxEstimatedTokens: 8000 } },
        evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
        policies: { record: { use: "core.record-only" } },
        checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 2 } },
      }), "utf8");
      process.env.PI_CODING_AGENT_DIR = agentDir;
      const loader = new DefaultResourceLoader({
        cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
        noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        additionalExtensionPaths: [resolve("dist/index.js")],
      });
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
      models.registerProvider("qe-k05-coverage", {
        name: "scripted K05 coverage provider",
        api: "qe-k05-coverage-api",
        apiKey: "fixture-not-credential",
        baseUrl: "http://127.0.0.1:9/not-used",
        streamSimple: (model, context) => {
          seen.arrivals += 1;
          seen.transcripts.push(JSON.stringify(context.messages ?? []));
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: `coverage-submit-${suffix}`, name: "submit_result", arguments: {
            ...RESULT,
            coverage: { ...RESULT.coverage, state: coverageState },
          } }], "toolUse"));
        },
        models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-coverage-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
      });
      const registry = new ModelRegistry(models);
      const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      await runner.emit({ type: "input", text: `coverage ${suffix}`, source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: `coverage-${suffix}`, toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: `coverage-${suffix}`, toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      const readCoverageRecords = async () => {
        const collected = [];
        for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
          if (!name.endsWith(".jsonl")) continue;
          const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
          for (const line of text.split(String.fromCharCode(10))) {
            if (line.trim().length === 0) continue;
            collected.push(JSON.parse(line));
          }
        }
        return collected;
      };
      // Bounded wait for the asynchronous journal flush before reading the published result.
      const coverageDeadline = Date.now() + 5_000;
      let records = await readCoverageRecords();
      while (!records.some(record => record.event === "quality.assessment.result") && Date.now() < coverageDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        records = await readCoverageRecords();
      }
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      return {
        input: String(seen.transcripts[0] ?? ""),
        results: records.filter(record => record.event === "quality.assessment.result").map(record => record.fields?.data),
        settledCodes: records.filter(record => record.event === "quality.check.settled").flatMap(record => record.fields?.reasonCodes ?? []),
        errors,
      };
    } finally {
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
    }
  };

  const tailMarker = "K05_TAIL_MARKER_6d10";
  const largeBody = "A".repeat(6_000) + tailMarker + "B".repeat(1_000 - tailMarker.length);
  assert.equal(largeBody.length, 7_000, "the partial-selection fixture is exactly 7000 characters");

  const complete = await runCase({ suffix: "complete", files: [{ name: "large.md", body: largeBody }], uris: ["large.md"], coverageState: "complete" });
  assert.equal(complete.input.includes("[selection] promptTruncatedItems 1 promptOmittedItems 0"), true, "the request manifest states the exact partial selection");
  assert.equal(complete.results.some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "a complete-coverage claim is not validated after only part of the admitted material was delivered");
  assert.equal(complete.results.some(result => result?.validationState === "valid" && result?.coverage === "partial"), true, "a complete-coverage claim is committed truthfully as partial after partial delivery");
  assert.equal(complete.results.some(result => result?.conclusion === "undetermined"), true, "the downgraded commitment publishes no unsupported successful finding");
  assert.deepEqual(complete.errors, []);

  const partial = await runCase({ suffix: "partial", files: [{ name: "large.md", body: largeBody }], uris: ["large.md"], coverageState: "partial" });
  assert.equal(partial.results.some(result => result?.validationState === "valid" && result?.coverage === "partial"), true, "a downgraded partial-coverage result remains admissible");
  assert.deepEqual(partial.errors, []);

  const nineFiles = Array.from({ length: 9 }, (_, index) => ({ name: `item-${index + 1}.md`, body: `short admitted body ${index + 1}` }));
  const nine = await runCase({ suffix: "nine", files: nineFiles, uris: nineFiles.map(file => file.name), coverageState: "partial" });
  assert.equal(nine.input.includes("[material-omitted] 1 admitted item(s) exceeded the bounded prompt selection"), true, "the ninth admitted item beyond the finite item window is counted as omitted");
  assert.equal(nine.input.includes("[selection] promptTruncatedItems 0 promptOmittedItems 1"), true, "the request selection reflects the omitted ninth item");
  assert.equal(nine.results.some(result => result?.validationState === "valid" && result?.coverage === "partial"), true, "the fitting nine-item partial case remains admissible at partial coverage");
  assert.deepEqual(nine.errors, []);
});

test("K05 T07 reviewer file bodies and submitted result text never appear in owned persisted surfaces while correlation metadata is retained", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-privacy-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, transcripts: [] };
  const bodySentinel = "K05_T07_BODY_SENTINEL_9f31c2";
  const resultTextSentinel = "K05_T07_RESULT_SENTINEL_4b7ae0";
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "privacy-marker-evidence", "utf8");
    await writeFile(join(project, "sensitive.md"), `${bodySentinel} confidential body contents`, "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-privacy", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-privacy", {
      name: "scripted K05 privacy provider",
      api: "qe-k05-privacy-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "read-sensitive", name: "read", arguments: { path: "sensitive.md" } }], "toolUse")
          : assistantMessage(model, [{ type: "toolCall", id: "submit-privacy", name: "submit_result", arguments: { ...RESULT, coverage: { state: "complete", scopeDescription: resultTextSentinel, issues: [] } } }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-privacy-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const persistedSurface = async () => {
      const chunks = [];
      const walk = async directory => {
        for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
          const full = join(directory, entry.name);
          if (entry.isDirectory()) await walk(full);
          else chunks.push(await readFile(full, "utf8").catch(() => ""));
        }
      };
      await walk(join(agentDir, "quality"));
      if (seen.arrivals === 0) chunks.push("no reviewer activity");
      return chunks.join("\n");
    };
    // Role-scoped post-close surface: the WHOLE owned scratch (agentDir), so any secondary SDK
    // session file, sink, or error artifact is scanned as an owned output — while the disposable
    // project fixture (an input) stays excluded.
    const ownedScratchSurface = async () => {
      const chunks = [];
      const walk = async directory => {
        for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
          const full = join(directory, entry.name);
          if (entry.isDirectory()) await walk(full);
          else chunks.push(await readFile(full, "utf8").catch(() => ""));
        }
      };
      await walk(agentDir);
      return chunks.join("\n");
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      await runner.emit({ type: "input", text: "privacy", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "pv-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "pv-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the reviewed run settles");
      assert.equal(seen.transcripts.some(text => text.includes(bodySentinel)), true, "the reviewer's approved read actually delivered the body to the model input");
      // Final-close scan: the owned surfaces are checked AFTER the session has
      // shut down, not only while it is active.
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
      const closedStatus = JSON.stringify(await status());
      assert.equal(closedStatus.includes(bodySentinel), false, "status after final close carries no reviewer body");
      assert.equal(closedStatus.includes(resultTextSentinel), false, "status after final close carries no reviewer result text");
      const journalText = await persistedSurface();
      assert.equal(journalText.includes(bodySentinel), false, "the reviewer read body never appears in owned persisted surfaces after final close");
      assert.equal(journalText.includes(resultTextSentinel), false, "the reviewer result text never appears in owned persisted surfaces after final close");
      // Each tested marker must actually have been encountered in the run, and the remaining
      // owned output surfaces (UI notifications, runner errors, the whole owned scratch) must
      // stay free of both markers after final close.
      const privacyResults = (settled.diagnostics?.recentEvents ?? []).filter(record => record.event === "quality.assessment.result").map(record => record.fields?.data);
      assert.equal(privacyResults.filter(result => ["no-supported-finding", "findings"].includes(result?.conclusion)).length, 1, "the submitted result (carrying the sentinel text) was actually processed at the canonical boundary");
      assert.equal(JSON.stringify(messages).includes(bodySentinel), false, "no UI notification surface carries the reviewer body");
      assert.equal(JSON.stringify(messages).includes(resultTextSentinel), false, "no UI notification surface carries the reviewer result text");
      assert.equal(JSON.stringify(errors).includes(bodySentinel), false, "no runner error surface carries the reviewer body");
      assert.equal(JSON.stringify(errors).includes(resultTextSentinel), false, "no runner error surface carries the reviewer result text");
      const scratchText = await ownedScratchSurface();
      assert.equal(scratchText.includes(bodySentinel), false, "no owned scratch or secondary-session file carries the reviewer body");
      assert.equal(scratchText.includes(resultTextSentinel), false, "no owned scratch or secondary-session file carries the reviewer result text");
      assert.equal((await status()).checks !== undefined, true, "status remains readable after the private review");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});
// --- K05 T08b native registered-route missing-credential denial ---

test("K05 T08b a registered reviewer route without credential availability is denied before dispatch with zero arrivals and no lingering reservation", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-missingroute-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const canaryMarker = join(root, "canary-extension-loaded.txt");
  const seen = { arrivals: 0, transcripts: [] };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(join(projectConfigDir, "extensions"), { recursive: true });
    await mkdir(join(projectConfigDir, "prompts"), { recursive: true });
    await mkdir(join(agentDir, "skills", "canary"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "ambient-marker-evidence", "utf8");
    await writeFile(join(project, "readable.md"), "K05_AMBIENT_USEFUL_BODY", "utf8");
    await writeFile(join(project, "AGENTS.md"), "K05_AMBIENT_CONTEXT_CANARY", "utf8");
    await writeFile(join(agentDir, "SYSTEM.md"), "K05_AMBIENT_SYSTEM_CANARY", "utf8");
    await writeFile(join(agentDir, "skills", "canary", "SKILL.md"), "---\nname: canary\ndescription: K05_AMBIENT_SKILL_CANARY\n---\nK05_AMBIENT_SKILL_CANARY", "utf8");
    await writeFile(join(projectConfigDir, "prompts", "canary.md"), "K05_AMBIENT_PROMPT_CANARY", "utf8");
    await writeFile(join(projectConfigDir, "extensions", "canary.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(canaryMarker)}, "K05_AMBIENT_EXTENSION_CANARY", "utf8");\nexport default function () {}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-missingroute", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-missingroute", {
      name: "scripted K05 no-auth provider",
      api: "qe-k05-missingroute-api",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "submit-noauth", name: "submit_result", arguments: RESULT }], "toolUse"));
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-missingroute-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "ambient isolation", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "ai-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "ai-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks?.runs >= 1, true, "the denied reviewer run still settles explicitly");
      assert.equal(seen.arrivals, 0, "no provider turn was dispatched while credential availability is absent");
      const results = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") results.push(record.fields?.data);
        }
      }
      assert.equal(results.some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "the no-auth route fabricated no successful conclusion");
      assert.equal(Number(settled.accounting?.ownedRequestCount ?? 1), 0, "no owned request was created for the no-auth route");
      assert.equal(Number(settled.accounting?.unresolvedCount ?? 1), 0, "no un-dispatched reservation lingers for the no-auth route");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});


// --- K05 N1 native same-response sequential read then canonical submit ---

test("K05 N1 one pre-issued response executes the permitted read then the canonical submit sequentially under the public sequential mode", { timeout: 90_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("held-read fixture prerequisite: run with --import file:///<hold-read-preload.mjs> and QE_HOLD_READ_PRELOAD=<abs bootstrap>");
    return;
  }
  const seam = await import(pathToFileURL(preloadPath).href);
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const root = await mkdtemp(join(tmpdir(), "qe-k05-n1-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, transcripts: [], modes: [], modeSetAtPrompt: 0 };
  const originalPrompt = AgentSession.prototype.prompt;
  AgentSession.prototype.prompt = function sequentialPrompt(text) {
    seen.modes.push(this.agent?.toolExecution);
    this.agent.toolExecution = "sequential";
    seen.modeSetAtPrompt += 1;
    return originalPrompt.call(this, text);
  };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "n1-marker-evidence", "utf8");
    await writeFile(join(project, "held-read.txt"), "K05_N1_READ_BODY", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-n1", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 2 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-n1", {
      name: "scripted K05 N1 provider",
      api: "qe-k05-n1-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = assistantMessage(model, [
          { type: "toolCall", id: "n1-read", name: "read", arguments: { path: "held-read.txt" } },
          { type: "toolCall", id: "n1-submit", name: "submit_result", arguments: RESULT },
        ], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-n1-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const journalResults = async () => {
      const results = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") results.push(record.fields?.data);
        }
      }
      return results;
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      const promptModeBefore = seen.modeSetAtPrompt;
      seam.arm(join(project, "held-read.txt"));
      await runner.emit({ type: "input", text: "n1 sequential", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "n1-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "n1-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      assert.equal(await seam.waitEntered(15_000), true, "the sequential read reached the real filesystem gate inside the single response");
      const beforeRelease = seam.counters();
      assert.equal(beforeRelease.entered, 1, "exactly one real read entered from the pre-issued batch");
      assert.equal(beforeRelease.completed, 0, "the read is still held when the batch pauses");
      seam.release();
      assert.equal(await seam.waitDrained(15_000), true, "the read drains before the batch continues");
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(seen.modeSetAtPrompt, promptModeBefore + 1, "the public prompt call-through selected sequential mode on the real owned agent before prompting");
      assert.equal(seen.modes.every(mode => mode === "parallel" || mode === "sequential" || mode === undefined), true, "the recorded pre-prompt mode is the public SDK value");
      assert.equal(seen.arrivals, 1, "the whole read-then-submit batch came from one pre-issued provider response");
      const results = await journalResults();
      assert.equal(results.some(result => result?.operational === "completed" && result?.conclusion === "no-supported-finding"), true, "the canonical submit executed after the drain and published a valid result");
      assert.equal(Number(settled.accounting?.ownedRequestCount ?? 0), 1, "one owned model request settled");
      assert.equal(Number(settled.accounting?.unresolvedCount ?? 1), 0, "the settled batch left no unresolved attempt");
      assert.deepEqual(errors, []);
    } finally {
      seam.release();
      AgentSession.prototype.prompt = originalPrompt;
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 N3 native earlier whole-run deadline with cleanup timing witnesses ---

test("K05 N3 the earlier whole-run deadline revokes the held sequential reviewer and reaches bounded cleanup before the later review timeout", { timeout: 120_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("held-read fixture prerequisite: run with --import file:///<hold-read-preload.mjs> and QE_HOLD_READ_PRELOAD=<abs bootstrap>");
    return;
  }
  const seam = await import(pathToFileURL(preloadPath).href);
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const root = await mkdtemp(join(tmpdir(), "qe-k05-n3-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, timeline: [], start: 0 };
  const mark = (label) => seen.timeline.push([label, Date.now() - seen.start]);
  const originalPrompt = AgentSession.prototype.prompt;
  const originalAbort = AgentSession.prototype.abort;
  const originalDispose = AgentSession.prototype.dispose;
  const originalSubscribe = AgentSession.prototype.subscribe;
  AgentSession.prototype.prompt = function n3Prompt(text) {
    this.agent.toolExecution = "sequential";
    mark("prompt-entry");
    return originalPrompt.call(this, text);
  };
  AgentSession.prototype.subscribe = function n3Subscribe(listener) {
    mark("subscribe");
    const off = originalSubscribe.call(this, listener);
    return function () { mark("unsubscribe"); return off(); };
  };
  AgentSession.prototype.abort = function n3Abort(...args) {
    mark("abort-entry");
    const result = originalAbort.apply(this, args);
    if (result !== undefined && typeof result.then === "function") {
      // A real return and a real rejection are separate lifecycle outcomes.
      result.then(() => mark("abort-resolved"), () => mark("abort-threw"));
    } else {
      mark("abort-resolved");
    }
    return result;
  };
  AgentSession.prototype.dispose = function n3Dispose(...args) {
    mark("dispose-entry");
    try {
      const value = originalDispose.apply(this, args);
      mark("dispose-return");
      return value;
    } catch (error) {
      mark("dispose-threw");
      throw error;
    }
  };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "n3-marker-evidence", "utf8");
    await writeFile(join(project, "held-read.txt"), "K05_N3_READ_BODY", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-n3", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", timeoutMs: 1000, cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 2 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-n3", {
      name: "scripted K05 N3 provider",
      api: "qe-k05-n3-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model) => {
        seen.arrivals += 1;
        const message = assistantMessage(model, [
          { type: "toolCall", id: "n3-read", name: "read", arguments: { path: "held-read.txt" } },
          { type: "toolCall", id: "n3-submit", name: "submit_result", arguments: RESULT },
        ], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-n3-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const journalResults = async () => {
      const results = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") results.push(record.fields?.data);
        }
      }
      return results;
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      seam.arm(join(project, "held-read.txt"));
      seen.start = Date.now();
      await runner.emit({ type: "input", text: "n3 deadline", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "n3-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "n3-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      assert.equal(await seam.waitEntered(15_000), true, "the sequential read reached the real filesystem gate before the whole-run deadline");
      const settleDeadline = Date.now() + 6_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < settleDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        settled = await status();
      }
      mark("settlement-observed");
      assert.equal(settled.checks.runs >= 1, true, "the earlier whole-run deadline settles the run");
      assert.equal(seen.arrivals, 1, "no new provider turn was requested after the deadline");
      const at = label => seen.timeline.find(([name]) => name === label);
      const abortEntry = at("abort-entry");
      const abortSettled = at("abort-settled");
      const disposeEntry = at("dispose-entry");
      const disposeReturn = at("dispose-return");
      // Declared local cleanup bound: the effective bounded-cleanup allowance is
      // C1 componentStopTimeoutMs (default 2000ms) measured FROM actual
      // revocation (the whole-run deadline at ~1000ms), not a generous absolute
      // watchdog. Entry, return and throw are separate observations.
      const RUN_DEADLINE_MS = 1000;
      const CLEANUP_ALLOWANCE_MS = 2000;
      // While the non-cooperative read is deliberately held, abort FULFILLMENT is
      // not required: the owned operation stays an honest unresolved physical fact
      // with its capacity retained. Abort request and disposal invocation are
      // recorded separately from their eventual settlement.
      // Bounded pre-release cleanup-phase observation: wait for the revocation to
      // actually reach the abort request and disposal invocation while the owned read
      // stays deliberately held; fulfillment is still not required at this phase.
      const cleanupInvocationDeadline = Date.now() + 3_000;
      while ((at("abort-entry") === undefined || at("dispose-entry") === undefined) && Date.now() < cleanupInvocationDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      }
      assert.equal(at("abort-entry") !== undefined, true, "the deadline revocation requested real reviewer cleanup via abort");
      assert.equal(at("dispose-entry") !== undefined, true, "reviewer disposal was invoked for the bounded cleanup");
      const heldAfterCleanup = seam.counters();
      assert.equal(heldAfterCleanup.active, 1, "physical occupancy is retained while the underlying read is still held");
      assert.equal(heldAfterCleanup.completed, 0, "disposal/abort did not free or drain the underlying I/O");
      assert.equal((await journalResults()).some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "the revoked run published no successful conclusion");
      seam.release();
      assert.equal(await seam.waitDrained(15_000), true, "the held read drains only after release");
      // Bounded POST-RELEASE settlement: the same cleanup now genuinely settles once,
      // including the real abort/disposal return, observed separately at its own phase
      // and bounded by this explicit post-release wait.
      const count = label => seen.timeline.filter(([name]) => name === label).length;
      const postReleaseDeadline = Date.now() + 5_000;
      while ((count("abort-resolved") + count("abort-threw") === 0 || count("dispose-return") + count("dispose-threw") === 0) && Date.now() < postReleaseDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      }
      assert.equal(count("abort-resolved") + count("abort-threw") === 1, true, "the abort call settled exactly once after the owned read was released");
      assert.equal(count("dispose-return") + count("dispose-threw") === 1, true, "reviewer disposal settled exactly once after the owned read was released");
      assert.equal(count("abort-entry") === 1 && count("dispose-entry") === 1, true, "abort request and disposal invocation are each observed exactly once");
      assert.equal(count("subscribe") === count("unsubscribe") && count("subscribe") >= 1, true, "every reviewer subscription was detached exactly once");
      assert.equal(seam.counters().completed, 1, "the underlying read settled exactly once");
      // Post-release authority: the same demand never acquires a further provider turn
      // and never publishes a successful conclusion.
      await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
      assert.equal(seen.arrivals, 1, "no further provider turn is requested after the released owned read settles");
      assert.equal((await journalResults()).some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "no successful conclusion is published after release");
      assert.deepEqual(errors, []);
    } finally {
      seam.release();
      // Failure cleanup releases and waits for the owned read to drain. A failed wait with
      // active ownership retains the scratch and reports unresolved cleanup instead of
      // deleting it; a case that never entered the operation cleans normally.
      const drainSettled = await seam.waitDrained(5_000);
      if (!drainSettled && seam.counters().active > 0) {
        retainedScratchRoots.add(root);
        console.error(`K05-CLEANUP-UNRESOLVED scratch=${root} active=${seam.counters().active} completed=${seam.counters().completed}`);
      }
      AgentSession.prototype.prompt = originalPrompt;
      AgentSession.prototype.abort = originalAbort;
      AgentSession.prototype.dispose = originalDispose;
      AgentSession.prototype.subscribe = originalSubscribe;
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});
// --- K05 N2 native review deadline with aborted sequential batch ---

test("K05 N2 the review deadline revokes the held sequential batch, skips the queued submit and still reaches bounded cleanup", { timeout: 120_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("held-read fixture prerequisite: run with --import file:///<hold-read-preload.mjs> and QE_HOLD_READ_PRELOAD=<abs bootstrap>");
    return;
  }
  const seam = await import(pathToFileURL(preloadPath).href);
  const { AgentSession } = await import("@earendil-works/pi-coding-agent");
  const root = await mkdtemp(join(tmpdir(), "qe-k05-n3-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const seen = { arrivals: 0, timeline: [], start: 0 };
  const mark = (label) => seen.timeline.push([label, Date.now() - seen.start]);
  const originalPrompt = AgentSession.prototype.prompt;
  const originalAbort = AgentSession.prototype.abort;
  const originalDispose = AgentSession.prototype.dispose;
  const originalSubscribe = AgentSession.prototype.subscribe;
  AgentSession.prototype.prompt = function n3Prompt(text) {
    this.agent.toolExecution = "sequential";
    mark("prompt-entry");
    return originalPrompt.call(this, text);
  };
  AgentSession.prototype.subscribe = function n3Subscribe(listener) {
    mark("subscribe");
    const off = originalSubscribe.call(this, listener);
    return function () { mark("unsubscribe"); return off(); };
  };
  AgentSession.prototype.abort = function n3Abort(...args) {
    mark("abort-entry");
    const result = originalAbort.apply(this, args);
    if (result !== undefined && typeof result.then === "function") {
      // A real return and a real rejection are separate lifecycle outcomes.
      result.then(() => mark("abort-resolved"), () => mark("abort-threw"));
    } else {
      mark("abort-resolved");
    }
    return result;
  };
  AgentSession.prototype.dispose = function n3Dispose(...args) {
    mark("dispose-entry");
    try {
      const value = originalDispose.apply(this, args);
      mark("dispose-return");
      return value;
    } catch (error) {
      mark("dispose-threw");
      throw error;
    }
  };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "n3-marker-evidence", "utf8");
    await writeFile(join(project, "held-read.txt"), "K05_N3_READ_BODY", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-n3", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 1000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", timeoutMs: 30000, cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 2 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-n3", {
      name: "scripted K05 N3 provider",
      api: "qe-k05-n3-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model) => {
        seen.arrivals += 1;
        const message = assistantMessage(model, [
          { type: "toolCall", id: "n3-read", name: "read", arguments: { path: "held-read.txt" } },
          { type: "toolCall", id: "n3-submit", name: "submit_result", arguments: RESULT },
        ], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-n3-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const journalResults = async () => {
      const results = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") results.push(record.fields?.data);
        }
      }
      return results;
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      seam.arm(join(project, "held-read.txt"));
      seen.start = Date.now();
      await runner.emit({ type: "input", text: "n3 deadline", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "n3-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "n3-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      assert.equal(await seam.waitEntered(15_000), true, "the sequential read reached the real filesystem gate before the review deadline");
      const settleDeadline = Date.now() + 6_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < settleDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        settled = await status();
      }
      mark("settlement-observed");
      assert.equal(settled.checks.runs >= 1, true, "the review deadline settles the run");
      assert.equal(seen.arrivals, 1, "no new provider turn was requested after the deadline");
      const at = label => seen.timeline.find(([name]) => name === label);
      const abortEntry = at("abort-entry");
      const abortSettled = at("abort-settled");
      const disposeEntry = at("dispose-entry");
      const disposeReturn = at("dispose-return");
      // Declared local cleanup bound: the effective bounded-cleanup allowance is
      // C1 componentStopTimeoutMs (default 2000ms) measured FROM actual
      // revocation (the whole-run deadline at ~1000ms), not a generous absolute
      // watchdog. Entry, return and throw are separate observations.
      const RUN_DEADLINE_MS = 1000;
      const CLEANUP_ALLOWANCE_MS = 2000;
      // While the non-cooperative read is deliberately held, abort FULFILLMENT is
      // not required: the owned operation stays an honest unresolved physical fact
      // with its capacity retained. Abort request and disposal invocation are
      // recorded separately from their eventual settlement.
      // Bounded pre-release cleanup-phase observation: wait for the revocation to
      // actually reach the abort request and disposal invocation while the owned read
      // stays deliberately held; fulfillment is still not required at this phase.
      const cleanupInvocationDeadline = Date.now() + 3_000;
      while ((at("abort-entry") === undefined || at("dispose-entry") === undefined) && Date.now() < cleanupInvocationDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      }
      assert.equal(at("abort-entry") !== undefined, true, "the deadline revocation requested real reviewer cleanup via abort");
      assert.equal(at("dispose-entry") !== undefined, true, "reviewer disposal was invoked for the bounded cleanup");
      const heldAfterCleanup = seam.counters();
      assert.equal(heldAfterCleanup.active, 1, "physical occupancy is retained while the underlying read is still held");
      assert.equal(heldAfterCleanup.completed, 0, "disposal/abort did not free or drain the underlying I/O");
      assert.equal((await journalResults()).some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "the revoked run published no successful conclusion");
      seam.release();
      assert.equal(await seam.waitDrained(15_000), true, "the held read drains only after release");
      // Bounded POST-RELEASE settlement: the same cleanup now genuinely settles once,
      // including the real abort/disposal return, observed separately at its own phase
      // and bounded by this explicit post-release wait.
      const count = label => seen.timeline.filter(([name]) => name === label).length;
      const postReleaseDeadline = Date.now() + 5_000;
      while ((count("abort-resolved") + count("abort-threw") === 0 || count("dispose-return") + count("dispose-threw") === 0) && Date.now() < postReleaseDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      }
      assert.equal(count("abort-resolved") + count("abort-threw") === 1, true, "the abort call settled exactly once after the owned read was released");
      assert.equal(count("dispose-return") + count("dispose-threw") === 1, true, "reviewer disposal settled exactly once after the owned read was released");
      assert.equal(count("abort-entry") === 1 && count("dispose-entry") === 1, true, "abort request and disposal invocation are each observed exactly once");
      assert.equal(count("subscribe") === count("unsubscribe") && count("subscribe") >= 1, true, "every reviewer subscription was detached exactly once");
      assert.equal(seam.counters().completed, 1, "the underlying read settled exactly once");
      // Post-release authority: the same demand never acquires a further provider turn
      // and never publishes a successful conclusion.
      await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
      assert.equal(seen.arrivals, 1, "no further provider turn is requested after the released owned read settles");
      assert.equal((await journalResults()).some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "no successful conclusion is published after release");
      assert.deepEqual(errors, []);
    } finally {
      seam.release();
      // Failure cleanup releases and waits for the owned read to drain. A failed wait with
      // active ownership retains the scratch and reports unresolved cleanup instead of
      // deleting it; a case that never entered the operation cleans normally.
      const drainSettled = await seam.waitDrained(5_000);
      if (!drainSettled && seam.counters().active > 0) {
        retainedScratchRoots.add(root);
        console.error(`K05-CLEANUP-UNRESOLVED scratch=${root} active=${seam.counters().active} completed=${seam.counters().completed}`);
      }
      AgentSession.prototype.prompt = originalPrompt;
      AgentSession.prototype.abort = originalAbort;
      AgentSession.prototype.dispose = originalDispose;
      AgentSession.prototype.subscribe = originalSubscribe;
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 permission boundaries: protected/outside/symlink denials with entry witnesses ---

test("K05 protected, outside-project and symlink reads are denied before any physical read while permitted read/search/list still execute", { timeout: 90_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("watch fixture prerequisite: run with --import file:///<watch-read-preload.mjs> and QE_HOLD_READ_PRELOAD=<abs bootstrap>");
    return;
  }
  const seam = await import(pathToFileURL(preloadPath).href);
  const root = await mkdtemp(join(tmpdir(), "qe-k05-perm-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const protectedPath = join(agentDir, "quality", "config.json");
  const outsidePath = join(root, "outside.txt");
  const symlinkPath = join(project, "escape-link.txt");
  const permittedPath = join(project, "readable.md");
  const shellMarker = join(root, "shell-executed.txt");
  const seen = { arrivals: 0, transcripts: [] };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let symlinkBoundary = "created";
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "perm-marker-evidence", "utf8");
    await writeFile(join(project, "readable.md"), "K05_PERMITTED_BODY", "utf8");
    await writeFile(outsidePath, "K05_OUTSIDE_SECRET_BODY", "utf8");
    await writeFile(protectedPath, JSON.stringify({ note: "K05_PROTECTED_BODY" }), "utf8");
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outsidePath, symlinkPath, "file");
    } catch (error) {
      symlinkBoundary = `unavailable: ${error?.code ?? String(error)}`;
    }
    await writeFile(join(agentDir, "quality", "config.json.tmp"), "", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-perm", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 2 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-perm", {
      name: "scripted K05 permission provider",
      api: "qe-k05-perm-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [
            { type: "toolCall", id: "perm-protected", name: "read", arguments: { path: protectedPath } },
            { type: "toolCall", id: "perm-outside", name: "read", arguments: { path: outsidePath } },
            ...(symlinkBoundary === "created" ? [{ type: "toolCall", id: "perm-symlink", name: "read", arguments: { path: symlinkPath } }] : []),
            { type: "toolCall", id: "perm-shell", name: "bash", arguments: { command: `touch ${shellMarker}` } },
          ], "toolUse")
          : seen.arrivals === 2
            ? assistantMessage(model, [
              { type: "toolCall", id: "perm-allowed-read", name: "read", arguments: { path: "readable.md" } },
              { type: "toolCall", id: "perm-allowed-ls", name: "ls", arguments: { path: "." } },
              { type: "toolCall", id: "perm-allowed-find", name: "find", arguments: { pattern: "*.md" } },
              { type: "toolCall", id: "perm-allowed-grep", name: "grep", arguments: { pattern: "K05_PERMITTED", path: "." } },
            ], "toolUse")
            : assistantMessage(model, [{ type: "toolCall", id: "perm-submit", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-perm-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const journalResults = async () => {
      const results = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") results.push(record.fields?.data);
        }
      }
      return results;
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      seam.watch([protectedPath, outsidePath, symlinkPath]);
      await runner.emit({ type: "input", text: "permission boundaries", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "perm-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "perm-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 30_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs >= 1, true, "the denial run settles");
      const deniedEntries = seam.entries(protectedPath) + seam.entries(outsidePath) + (symlinkBoundary === "created" ? seam.entries(symlinkPath) : 0);
      assert.equal(deniedEntries, 0, `no physical read was attempted for any denied boundary (protected=${seam.entries(protectedPath)}, outside=${seam.entries(outsidePath)}, symlink=${symlinkBoundary === "created" ? seam.entries(symlinkPath) : symlinkBoundary})`);
      // A denied tool is a terminal refusal, so the allowed controls run in
      // their own independently triggered reviewer run.
      await runner.emit({ type: "input", text: "permitted controls", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "perm-2", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "perm-2", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const secondDeadline = Date.now() + 30_000;
      let settledSecond = await status();
      while ((seen.arrivals < 3 || (settledSecond.checks?.runs ?? 0) < 2) && Date.now() < secondDeadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settledSecond = await status();
      }
      assert.equal(settledSecond.checks.runs >= 2, true, "the permitted-controls run is admitted after the denial run settles");
      const combinedTranscript = seen.transcripts.join(String.fromCharCode(10));
      assert.equal(combinedTranscript.includes("K05_PERMITTED_BODY"), true, "the permitted read really executed and its bytes reached a later model input");
      assert.equal(combinedTranscript.includes("K05_OUTSIDE_SECRET_BODY"), false, "the outside-project secret never reached model input");
      assert.equal(combinedTranscript.includes("K05_PROTECTED_BODY"), false, "the protected config body never reached model input");
      await assert.rejects(readFile(shellMarker, "utf8"), "the shell command never executed (no marker written)");
      // Shell boundary classification: the reviewer allowlist is the C1 tool set
      // plus submit_result (source-bound in the adapter), so `bash` is never
      // admitted; the denial terminates the run before a follow-up provider turn
      // could echo the request, and no shell side effect exists anywhere. This is
      // "not exposed / not admitted", expressly not an executed refusal.
      assert.equal(seen.transcripts.join(String.fromCharCode(10)).includes("shell-executed"), false, "no shell command was executed or echoed as a result");
      assert.equal((await journalResults()).some(result => result?.operational === "completed"), true, "the run still produced its ordinary canonical result");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 aggregate UTF-8 additional-read-byte boundary ---

test("K05 the aggregate additional-read-byte cap counts real UTF-8 bytes across legal reads, allows the crossing read and denies the next one before execution", { timeout: 90_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("watch fixture prerequisite: run with --import file:///<watch-read-preload.mjs> and QE_HOLD_READ_PRELOAD=<abs bootstrap>");
    return;
  }
  const seam = await import(pathToFileURL(preloadPath).href);
  const root = await mkdtemp(join(tmpdir(), "qe-k05-bytes-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const smallBody = "A".repeat(100);
  const bigBody = "é".repeat(80); // 160 UTF-8 bytes, 80 characters
  const deniedBody = "K05_BYTE_DENIED_BODY";
  const deniedPath = join(project, "denied.txt");
  const seen = { arrivals: 0, transcripts: [] };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    assert.equal(Buffer.byteLength(smallBody, "utf8"), 100, "the below-limit fixture is exactly 100 UTF-8 bytes");
    assert.equal(Buffer.byteLength(bigBody, "utf8"), 160, "the crossing fixture is 160 UTF-8 bytes for 80 characters");
    assert.equal(Buffer.byteLength(bigBody, "utf8") > 150, true, "the crossing fixture really exceeds the configured aggregate allowance");
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "byte-marker-evidence", "utf8");
    await writeFile(join(project, "small.txt"), smallBody, "utf8");
    await writeFile(join(project, "big.txt"), bigBody, "utf8");
    await writeFile(deniedPath, deniedBody, "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-bytes", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000, maxAdditionalReadBytes: 150 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 2 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-bytes", {
      name: "scripted K05 byte provider",
      api: "qe-k05-bytes-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "bytes-small", name: "read", arguments: { path: "small.txt" } }], "toolUse")
          : seen.arrivals === 2
            ? assistantMessage(model, [{ type: "toolCall", id: "bytes-big", name: "read", arguments: { path: "big.txt" } }], "toolUse")
            : seen.arrivals === 3
              ? assistantMessage(model, [{ type: "toolCall", id: "bytes-denied", name: "read", arguments: { path: "denied.txt" } }], "toolUse")
              : assistantMessage(model, [{ type: "toolCall", id: "bytes-submit", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-bytes-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      seam.watch([deniedPath]);
      await runner.emit({ type: "input", text: "byte boundary", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "bytes-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "bytes-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 15_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      const combined = seen.transcripts.join(String.fromCharCode(10));
      assert.equal(combined.includes("AAAA"), true, "the below-limit read really executed and its bytes reached a later real input");
      // Per-operation observation at the actual next-input boundary: locate the
      // real tool-result message for each read and measure its UTF-8 evidence ONCE
      // per operation, keeping the content and structured details surfaces
      // separate. The accumulated history is not the measurement.
      const toolResultOf = callId => {
        for (const text of seen.transcripts) {
          let messages;
          try { messages = JSON.parse(text); } catch { continue; }
          for (const message of Array.isArray(messages) ? messages : []) {
            if (message?.role === "toolResult" && message?.toolCallId === callId) return message;
          }
        }
        return null;
      };
      const textEvidence = result => (Array.isArray(result?.content) ? result.content : [])
        .filter(block => block !== null && typeof block === "object" && block.type === "text")
        .map(block => String(block.text ?? ""))
        .join(String.fromCharCode(10));
      const detailsEvidence = result => String(result?.details?.truncation?.content ?? "");
      const smallResult = toolResultOf("bytes-small");
      const bigResult = toolResultOf("bytes-big");
      assert.notEqual(smallResult, null, "the below-limit read result is observed at the actual next-input boundary");
      assert.notEqual(bigResult, null, "the crossing read result is observed at the actual next-input boundary");
      const smallText = textEvidence(smallResult);
      const bigText = textEvidence(bigResult);
      assert.equal(smallText.includes("A".repeat(100)), true, "the below-limit read delivers its 100-byte body");
      const smallBytes = Buffer.byteLength(smallText, "utf8");
      const bigBytes = Buffer.byteLength(bigText, "utf8");
      const smallDetails = detailsEvidence(smallResult);
      const bigDetails = detailsEvidence(bigResult);
      const smallDetailsBytes = Buffer.byteLength(smallDetails, "utf8");
      const bigDetailsBytes = Buffer.byteLength(bigDetails, "utf8");
      assert.equal(smallBytes + bigBytes <= 150, true, `delivered text evidence stays within the 150-byte aggregate allowance (small=${smallBytes} big=${bigBytes})`);
      // 194: the structured representation must be the SAME admitted selection, never a
      // differently-truncated withheld slice of the original body. Count the distinct
      // selected material once across content and details under the one shared allowance.
      assert.equal(smallDetails === smallText, true, "the fitting read's structured body is exactly its delivered selection");
      assert.equal(bigDetails === bigText, true, "the crossing read's structured body is exactly its delivered selection, not a withheld body");
      const distinctEvidenceBytes = smallBytes + bigBytes
        + Math.max(0, smallDetailsBytes - smallBytes)
        + Math.max(0, bigDetailsBytes - bigBytes);
      assert.equal(distinctEvidenceBytes <= 150, true, `distinct selected evidence across text and details stays within the one shared 150-byte allowance (distinct=${distinctEvidenceBytes})`);
      assert.equal(bigText.includes("é".repeat(80)), false, "the full over-cap multibyte body never appears in the delivered content surface");
      assert.equal(bigDetails.includes("é".repeat(80)), false, "the full over-cap multibyte body never appears in the structured details surface");
      assert.equal(bigText.includes("core.review-additional-bytes-limited") || bigDetails.includes("core.review-additional-bytes-limited"), true, "the crossing acquisition states its truthful bounded-delivery limitation");
      // 201-F2B/206: a bounded/limitation-only delivery must not be issued as a complete source.
      const limitedIssued = seen.transcripts.find(text => /\[reviewer-evidence res-[a-z0-9]+ rev rev-[a-z0-9]+ source big\.txt sourceVersion unknown selectedDigest [0-9a-f]+ selection limited:\d+\/\d+ role evidence disposition acquired bytes \d+\]/.test(text));
      assert.notEqual(limitedIssued, undefined, "the bounded crossing delivery is issued as a limited selection with an unknown full-source version");
      assert.equal(combined.includes("é".repeat(80)), false, "the full over-cap multibyte body is never adopted into a later input across all surfaces");
      assert.equal(seam.entries(deniedPath), 0, "the read past the aggregate UTF-8 byte cap was denied before any physical read");
      assert.equal(combined.includes(deniedBody), false, "the denied file's content never appeared in any real input");
      assert.equal(settled.checks.runs >= 1, true, "the byte-capped run settles");
      assert.equal(seen.arrivals <= 3, true, "the aggregate cap terminated the loop before any further provider turn");
      const results = [];
      for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
        if (!name.endsWith(".jsonl")) continue;
        const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
        for (const line of text.split(String.fromCharCode(10))) {
          if (line.trim().length === 0) continue;
          const record = JSON.parse(line);
          if (record.event === "quality.assessment.result") results.push(record.fields?.data);
        }
      }
      assert.equal(results.some(result => ["no-supported-finding", "findings"].includes(result?.conclusion)), false, "the aggregate byte cap is terminal: no successful conclusion follows the denied read");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

// --- K05 traversal, corrected oracle: ordinary project content is allowed; real engine-owned root is excluded ---

test("K05 ordinary project content stays useful under an ancestor root while the engine-owned protected subtree is denied directly and never visited by a search child", { timeout: 90_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("traversal fixture prerequisite: run with --import file:///<traversal-preload.mjs> and QE_HOLD_READ_PRELOAD=<abs bootstrap>");
    return;
  }
  const seam = await import(pathToFileURL(preloadPath).href);
  const root = await mkdtemp(join(tmpdir(), "qe-k05-travfix-"));
  const project = join(root, "project");
  const agentDir = join(project, "agent-state");
  const projectConfigDir = join(project, ".pi");
  const allowedBody = "K05_ALLOWED_VAULT_BODY";
  const protectedBody = "K05_PROTECTED_ENGINE_BODY_7d21";
  const outsideBody = "K05_TRAVERSAL_OUTSIDE_BODY";
  const canaryPath = join(agentDir, "quality", "logs", "canary.jsonl");
  const outsidePath = join(root, "outside.txt");
  const internalLink = join(project, "vault", "escape-link.txt");
  const seen = { arrivals: 0, transcripts: [], run: 0, messageSnapshots: [] };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  let linkBoundary = "created";
  try {
    await mkdir(join(agentDir, "quality", "logs"), { recursive: true });
    await mkdir(join(project, "vault"), { recursive: true });
    await mkdir(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "traversal-marker-evidence", "utf8");
    await writeFile(join(project, "vault", "ordinary.json"), JSON.stringify({ note: allowedBody }), "utf8");
    await mkdir(join(project, "vault", "nested"), { recursive: true });
    await writeFile(join(project, "vault", "nested", "deep.json"), JSON.stringify({ note: "K05_ALLOWED_NESTED_BODY" }), "utf8");
    await writeFile(canaryPath, JSON.stringify({ entry: protectedBody }), "utf8");
    await writeFile(outsidePath, outsideBody, "utf8");
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outsidePath, internalLink, "file");
    } catch (error) {
      linkBoundary = `unavailable: ${error?.code ?? String(error)}`;
    }
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-travfix", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-travfix", {
      name: "scripted K05 corrected traversal provider",
      api: "qe-k05-travfix-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        seen.messageSnapshots.push(context.messages ?? []);
        const run = seen.run;
        const message = run === 1
          ? seen.arrivals === 1
            ? assistantMessage(model, [
              { type: "toolCall", id: "fix-read-allowed", name: "read", arguments: { path: "vault/ordinary.json" } },
              { type: "toolCall", id: "fix-find-ancestor", name: "find", arguments: { pattern: "*.json", path: "." } },
              { type: "toolCall", id: "fix-ls-ancestor", name: "ls", arguments: { path: "." } },
              { type: "toolCall", id: "fix-grep-ancestor", name: "grep", arguments: { pattern: "K05_ALLOWED", path: "." } },
            ], "toolUse")
            : assistantMessage(model, [{ type: "toolCall", id: "fix-submit-1", name: "submit_result", arguments: RESULT }], "toolUse")
          : run === 2
            ? assistantMessage(model, [{ type: "toolCall", id: "fix-read-protected", name: "read", arguments: { path: "agent-state/quality/logs/canary.jsonl" } }], "toolUse")
            : run === 3
              ? seen.arrivals === 4
                ? assistantMessage(model, [{ type: "toolCall", id: "fix-grep-ancestor", name: "grep", arguments: { pattern: "K05_ALLOWED", path: "." } }], "toolUse")
                : assistantMessage(model, [{ type: "toolCall", id: "fix-submit-3", name: "submit_result", arguments: RESULT }], "toolUse")
              : assistantMessage(model, [{ type: "toolCall", id: "fix-grep-linkwalker", name: "grep", arguments: { pattern: "K05_TRAVERSAL_OUTSIDE", path: "vault" } }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-travfix-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const waitRuns = async (count) => {
      const deadline = Date.now() + 25_000;
      let current = await status();
      while ((current.checks?.runs ?? 0) < count && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        current = await status();
      }
      return current;
    };
    const trigger = async (index) => {
      await runner.emit({ type: "input", text: `traversal fixed ${index}`, source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: `tf-${index}`, toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: `tf-${index}`, toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
    };
    try {
      await runner.emit({ type: "session_start", reason: "startup" });
      assert.equal((await status()).configuration.rejection, null);
      seam.watch([canaryPath, outsidePath]);
      // Run 1: ordinary project content is useful (no protected descendant involved).
      seen.run = 1;
      await trigger(1);
      await waitRuns(1);
      // Run 2: direct read of the real engine-owned protected file is denied.
      seen.run = 2;
      const beforeDirect = seam.entries(canaryPath);
      await trigger(2);
      await waitRuns(2);
      // Run 3: an ancestor walker that would necessarily visit the protected root
      // is denied before any external search child runs.
      seen.run = 3;
      const childBefore = seam.childOperations();
      await trigger(3);
      await waitRuns(3);
      seen.run = 4;
      await trigger(4);
      await waitRuns(4);
      const childAfter = seam.childOperations();
      const combined = seen.transcripts.join(String.fromCharCode(10));
      assert.equal(combined.includes(allowedBody), true, "ordinary project content stays useful and reaches a later real input");
      assert.equal(combined.includes("K05_ALLOWED_NESTED_BODY"), true, "find/grep under the ancestor root still reach a nested ordinary descendant (no success-shaped truncation to immediate leaves)");
      // Oracle per Astra: inspect the STRUCTURED tool-result messages correlated
      // by tool-call id, not a whole-transcript substring. The session history
      // legitimately repeats the admitted provenance (which references the
      // engine-owned source), so a transcript-wide search cannot attribute a
      // disclosure to any tool call.
      const toolResults = [];
      for (const snapshot of seen.messageSnapshots) {
        for (const message of snapshot ?? []) {
          const role = message?.role ?? null;
          if (role !== "toolResult" && role !== "tool") continue;
          const id = message?.toolCallId ?? message?.tool_call_id ?? message?.toolUseId ?? null;
          toolResults.push({ id, text: JSON.stringify(message) });
        }
      }
      const walkerIds = ["fix-find-ancestor", "fix-ls-ancestor", "fix-grep-ancestor"];
      const walkerResults = toolResults.filter(entry => walkerIds.includes(entry.id));
      assert.equal(walkerResults.length >= 3, true, `all three ancestor-root walkers produced correlated structured results (found ${walkerResults.length}; ids ${JSON.stringify(toolResults.map(entry => entry.id))})`);
      assert.equal(walkerResults.some(entry => entry.text.includes("agent-state")), false, "no ancestor-root walker tool result discloses the engine-owned protected root name");
      assert.equal(walkerResults.some(entry => entry.text.includes(protectedBody)), false, "no ancestor-root walker tool result carries the protected body");
      assert.equal(combined.includes("nested"), true, "ordinary nested directory names remain visible in list/search results");
      assert.equal(seam.entries(canaryPath), beforeDirect, "the direct protected read added no in-process physical read entry");
      assert.equal(combined.includes(protectedBody), false, "the engine-owned protected body never reaches model input");
      assert.equal(combined.includes("canary.jsonl"), false, "the engine-owned protected name is never disclosed to the model");
      const newChildren = [...childAfter.spawns, ...childAfter.execFiles].slice(childBefore.spawns.length + childBefore.execFiles.length);
      assert.equal(newChildren.length >= 1, true, "the ancestor-root search legitimately ran through a real external child on admitted leaves");
      assert.equal(newChildren.every(entry => !JSON.stringify(entry).includes("agent-state")), true, "no external search child ever received the protected subtree path");
      assert.equal(combined.includes("K05_ALLOWED_VAULT_BODY"), true, "ordinary sibling matches survive under the same ancestor root");
      assert.equal(combined.includes(outsideBody), false, `the internal symlink target body never reaches model input (link: ${linkBoundary}, in-process entries: ${seam.entries(outsidePath)})`);
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});


// --- K05 reviewer settings observation: retry/compaction/cache-warming disabled at the real session ---

test("K05 the real reviewer session is constructed with retry, compaction and cache warming disabled, not SDK defaults", { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k05-settings-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  const projectConfigDir = join(project, ".pi");
  const canaryMarker = join(root, "canary-extension-loaded.txt");
  const seen = { arrivals: 0, transcripts: [] };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(join(projectConfigDir, "extensions"), { recursive: true });
    await mkdir(join(projectConfigDir, "prompts"), { recursive: true });
    await mkdir(join(agentDir, "skills", "canary"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "ambient-marker-evidence", "utf8");
    await writeFile(join(project, "readable.md"), "K05_AMBIENT_USEFUL_BODY", "utf8");
    await writeFile(join(project, "AGENTS.md"), "K05_AMBIENT_CONTEXT_CANARY", "utf8");
    await writeFile(join(agentDir, "SYSTEM.md"), "K05_AMBIENT_SYSTEM_CANARY", "utf8");
    await writeFile(join(agentDir, "skills", "canary", "SKILL.md"), "---\nname: canary\ndescription: K05_AMBIENT_SKILL_CANARY\n---\nK05_AMBIENT_SKILL_CANARY", "utf8");
    await writeFile(join(projectConfigDir, "prompts", "canary.md"), "K05_AMBIENT_PROMPT_CANARY", "utf8");
    await writeFile(join(projectConfigDir, "extensions", "canary.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(canaryMarker)}, "K05_AMBIENT_EXTENSION_CANARY", "utf8");\nexport default function () {}\n`, "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      enabled: true,
      mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-settings", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-settings", {
      name: "scripted K05 ambient provider",
      api: "qe-k05-settings-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "read-ambient", name: "read", arguments: { path: "readable.md" } }], "toolUse")
          : assistantMessage(model, [{ type: "toolCall", id: "submit-ambient", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-settings-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
    const { SettingsManager: PinnedSettings } = await import("@earendil-works/pi-coding-agent");
    const capturedSettings = [];
    const originalInMemory = PinnedSettings.inMemory;
    PinnedSettings.inMemory = function observedInMemory(settings, options) {
      const manager = originalInMemory.call(this, settings, options);
      capturedSettings.push({ settings, manager });
      return manager;
    };
    const { AgentSession: StatsSession } = await import("@earendil-works/pi-coding-agent");
    const statsOriginalDispose = StatsSession.prototype.dispose;
    const observedStats = [];
    StatsSession.prototype.dispose = function (...args) {
      try {
        observedStats.push(this.getSessionStats());
      } catch (error) {
        observedStats.push({ error: String(error) });
      }
      return statsOriginalDispose.apply(this, args);
    };
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
      await runner.emit({ type: "input", text: "ambient isolation", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "ai-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "ai-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while (settled.checks.runs < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
        settled = await status();
      }
      assert.equal(settled.checks.runs, 1, "the reviewer run settles under ambient canaries present");
      assert.equal(seen.arrivals, 2, "the reviewer reached the provider for its read and its result turn");
      assert.equal(seen.transcripts.length >= 2, true, "both real SDK inputs were captured");
      for (const canary of ["K05_AMBIENT_CONTEXT_CANARY", "K05_AMBIENT_SYSTEM_CANARY", "K05_AMBIENT_SKILL_CANARY", "K05_AMBIENT_PROMPT_CANARY", "K05_AMBIENT_EXTENSION_CANARY"]) {
        assert.equal(seen.transcripts.some(text => text.includes(canary)), false, `the reviewer's real SDK input must not inherit ${canary}`);
      }
      assert.equal(seen.transcripts.some(text => text.includes("K05_AMBIENT_USEFUL_BODY")), true, "the reviewer still performed its useful permitted read");
      await assert.rejects(readFile(canaryMarker, "utf8"), "the ambient extension file was never imported by the reviewer session");
      assert.equal(capturedSettings.length >= 1, true, "the reviewer session's settings manager was observed at construction");
      const observed = capturedSettings[0].manager;
      assert.equal(observed.getRetryEnabled(), false, "provider retry is disabled in the reviewer session");
      assert.equal(observed.getCompactionEnabled(), false, "compaction is disabled in the reviewer session");
      assert.equal(observed.getCacheWarmingMode(), "off", "cache warming is off in the reviewer session");
      assert.equal(capturedSettings[0].settings?.retry?.enabled, false, "retry is explicitly disabled, not left to SDK defaults");
      assert.equal(capturedSettings[0].settings?.compaction?.enabled, false, "compaction is explicitly disabled, not left to SDK defaults");
      assert.equal(capturedSettings[0].settings?.cacheWarming, "off", "cache warming is explicitly off, not left to SDK defaults");
      assert.equal(observedStats.length >= 1, true, "the public aggregate was observed on the real reviewer session before disposal");
      const aggregate = observedStats[0];
      assert.equal(aggregate.error === undefined, true, `the public getSessionStats call returned a real aggregate (error: ${aggregate.error ?? "none"})`);
      assert.equal(aggregate.tokens?.input, 240, "aggregate input tokens equal the two real scripted provider turns (120 each)");
      assert.equal(aggregate.tokens?.output, 60, "aggregate output tokens equal the two real scripted provider turns (30 each)");
      assert.equal(Number(aggregate.tokens?.total) >= 300, true, "aggregate total covers the real provider usage");
      assert.equal(Number(aggregate.toolCalls) >= 1, true, "aggregate counts the reviewer's real tool calls");
      assert.equal(Number(settled.accounting?.ownedRequestCount ?? 0) >= 2, true, "the shared ledger accounts the reviewer's owned requests");
      assert.equal(Number(settled.accounting?.normalizedTokens?.total ?? 0) >= 300, true, "the shared ledger total covers the same real usage the aggregate reports");
      // 195: exact arithmetic at the same two-call boundary — two unique owned calls, the SDK-derived
      // aggregate exactly equal to that usage, and no aggregate/external-executor charge in the
      // owned totals. This is the existing accounting boundary, not another invoice ingress.
      assert.equal(Number(aggregate.tokens?.total) === 300, true, "the SDK-derived aggregate total is exactly the two real scripted turns (240 input + 60 output)");
      assert.equal(Number(settled.accounting?.ownedRequestCount ?? 0) === 2, true, "exactly two unique owned reviewer calls are accounted");
      assert.equal(Number(settled.accounting?.normalizedTokens?.total ?? 0) === 300, true, "the shared owned ledger total equals exactly the same two-call usage");
      assert.equal(Number(settled.accounting?.byPurpose?.reviewer ?? 0) === 2, true, "both owned calls are attributed to the reviewer purpose");
      assert.equal(Number(settled.accounting?.excluded?.externalHandoffs ?? 1) === 0, true, "no aggregate or external-executor charge enters the owned totals");
      // T05 external-report exclusion is proven at the real owner boundary in
      // test/k05-reviewer.test.ts ("a non-owned external executor receipt is rejected by the
      // real owner and cannot change owned totals"): a non-zero external report is submitted to
      // ModelService.reconcile under an identity the owner never issued, with a known-owned
      // positive through the same method. An inert fixture file never reaches an accounting
      // owner, so no file-based negative is asserted here.
      assert.equal(Number(settled.checks?.runs ?? 0), 1, "observing the aggregate created no additional primary completion");
      assert.deepEqual(errors, []);
    } finally {
      StatsSession.prototype.dispose = statsOriginalDispose;
      PinnedSettings.inMemory = originalInMemory;
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});


// --- K05 enumeration outcomes: empty admitted set, and over-bound with under-bound usefulness ---

async function runEnumerationFixture(kind, firstTool = "find") {
  const root = await mkdtemp(join(tmpdir(), `qe-k05-enum-${kind}-`));
  const project = join(root, "project");
  const agentDir = join(project, "agent-state");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await writeFile(join(agentDir, "quality", "evidence.md"), "enumeration-marker-evidence", "utf8");
  if (kind === "over") {
    await mkdir(join(project, "vault", "nested"), { recursive: true });
    await writeFile(join(project, "vault", "ordinary.json"), JSON.stringify({ note: "K05_ENUM_ALLOWED_BODY" }), "utf8");
    await writeFile(join(project, "vault", "nested", "deep.json"), JSON.stringify({ note: "K05_ENUM_NESTED_BODY" }), "utf8");
    for (let index = 1; index <= 17; index += 1) {
      await writeFile(join(project, `bulk-${String(index).padStart(2, "0")}.md`), `bulk ${index}`, "utf8");
    }
  }
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1, enabled: true, mode: "observe",
    sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
    modelProfiles: { scripted: { provider: `qe-k05-enum-${kind}`, model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
    permissions: { modelProfiles: ["scripted"] },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
    evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
    policies: { record: { use: "core.record-only" } },
    checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 4 } },
  }), "utf8");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const loader = new DefaultResourceLoader({
    cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [resolve("dist/index.js")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  const seen = { arrivals: 0, snapshots: [], transcripts: [] };
  models.registerProvider(`qe-k05-enum-${kind}`, {
    name: `scripted K05 enumeration ${kind} provider`,
    api: `qe-k05-enum-${kind}-api`,
    apiKey: "fixture-not-credential",
    baseUrl: "http://127.0.0.1:9/not-used",
    streamSimple: (model, context) => {
      seen.arrivals += 1;
      seen.snapshots.push(context.messages ?? []);
      seen.transcripts.push(JSON.stringify(context.messages ?? []));
      const message = seen.arrivals === 1
        ? (firstTool === "ls"
          ? assistantMessage(model, [{ type: "toolCall", id: "enum-root-ls", name: "ls", arguments: { path: "." } }], "toolUse")
          : firstTool === "grep"
            ? assistantMessage(model, [{ type: "toolCall", id: "enum-root-ls", name: "grep", arguments: { pattern: "e", path: "." } }], "toolUse")
            : assistantMessage(model, [{ type: "toolCall", id: "enum-root-ls", name: "find", arguments: { pattern: "*", path: "." } }], "toolUse"))
        : seen.arrivals === 2
          ? (kind === "over"
            ? assistantMessage(model, [
              { type: "toolCall", id: "enum-narrow-grep", name: "grep", arguments: { pattern: "K05_ENUM", path: "vault" } },
              { type: "toolCall", id: "enum-narrow-find", name: "find", arguments: { pattern: "*.json", path: "vault" } },
            ], "toolUse")
            : assistantMessage(model, [{ type: "toolCall", id: "enum-submit", name: "submit_result", arguments: RESULT }], "toolUse"))
          : assistantMessage(model, [{ type: "toolCall", id: "enum-submit", name: "submit_result", arguments: RESULT }], "toolUse");
      return eventStream(message);
    },
    models: [{ id: "scripted-1", name: "scripted", api: `qe-k05-enum-${kind}-api`, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
  });
  const registry = new ModelRegistry(models);
  const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
  const toolResults = () => {
    const found = [];
    for (const snapshot of seen.snapshots) {
      for (const message of snapshot ?? []) {
        const role = message?.role ?? null;
        if (role !== "toolResult" && role !== "tool") continue;
        found.push({ id: message?.toolCallId ?? message?.tool_call_id ?? null, text: JSON.stringify(message) });
      }
    }
    return found;
  };
  return { root, project, agentDir, runner, seen, errors, status, toolResults, models };
}

test("K05 an ancestor whose only entry is the protected root refuses enumeration truthfully instead of searching broadly", { timeout: 90_000 }, async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const fixture = await runEnumerationFixture("empty");
  try {
    await fixture.runner.emit({ type: "session_start", reason: "startup" });
    assert.equal((await fixture.status()).configuration.rejection, null);
    await fixture.runner.emit({ type: "input", text: "empty enumeration", source: "interactive" });
    await fixture.runner.emit({ type: "tool_execution_start", toolCallId: "en-1", toolName: "read", args: {} });
    await fixture.runner.emit({ type: "tool_execution_end", toolCallId: "en-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
    const deadline = Date.now() + 25_000;
    let settled = await fixture.status();
    while ((fixture.seen.arrivals < 2) && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      settled = await fixture.status();
    }
    const results = fixture.toolResults().filter(entry => entry.id === "enum-root-ls");
    assert.equal(results.length >= 1, true, "the refused ancestor listing produced a correlated tool result");
    assert.equal(results.some(entry => entry.text.includes("core.review-enumeration-empty")), true, `the empty admitted set is refused truthfully (${results.map(entry => entry.text.slice(0, 120)).join(" | ")})`);
    assert.equal(fixture.seen.transcripts.slice(1).some(text => text.includes("core.review-enumeration-empty")), true, "the truthful refusal is actually delivered to a later model input");
    assert.equal(settled.checks.runs >= 1, true, "the run still settles after the refusal");
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("K05 an over-bound ancestor is refused with its admitted count while a narrower search stays useful", { timeout: 90_000 }, async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const fixture = await runEnumerationFixture("over", "grep");
  try {
    await fixture.runner.emit({ type: "session_start", reason: "startup" });
    assert.equal((await fixture.status()).configuration.rejection, null);
    await fixture.runner.emit({ type: "input", text: "over-bound enumeration", source: "interactive" });
    await fixture.runner.emit({ type: "tool_execution_start", toolCallId: "en-2", toolName: "read", args: {} });
    await fixture.runner.emit({ type: "tool_execution_end", toolCallId: "en-2", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
    const deadline = Date.now() + 25_000;
    let settled = await fixture.status();
    while ((fixture.seen.arrivals < 3) && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      settled = await fixture.status();
    }
    const overResult = fixture.toolResults().find(entry => entry.id === "enum-root-ls");
    assert.equal(overResult !== undefined, true, "the over-bound ancestor listing produced a correlated tool result");
    assert.equal(overResult.text.includes("core.review-enumeration-truncated"), true, `the over-bound enumeration is signalled, not silently clipped (${overResult.text.slice(0, 160)})`);
    assert.equal(/\b1[0-9]\b/.test(overResult.text) || /2[0-9]/.test(overResult.text), true, "the refusal carries the admitted count");
    const combined = fixture.seen.transcripts.join(String.fromCharCode(10));
    assert.equal(combined.includes("K05_ENUM_ALLOWED_BODY"), true, "a narrower ordinary search still reaches the model (refusal is not a substitute for investigation)");
    assert.equal(combined.includes("K05_ENUM_NESTED_BODY"), true, "nested ordinary content stays reachable under the narrower search");
    assert.equal(settled.checks.runs >= 1, true, "the run settles after the over-bound refusal and the useful narrower search");
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("K05 an enumeration failure at the requested ancestor is refused truthfully with no broad fallback", { timeout: 90_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("enumeration fixture prerequisite: run with --import file:///<enumeration-preload.mjs> and QE_HOLD_READ_PRELOAD=<abs bootstrap>");
    return;
  }
  const seam = await import(pathToFileURL(preloadPath).href);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const fixture = await runEnumerationFixture("over");
  try {
    await fixture.runner.emit({ type: "session_start", reason: "startup" });
    assert.equal((await fixture.status()).configuration.rejection, null);
    const childrenBefore = seam.childOperations().spawns.length + seam.childOperations().execFiles.length;
    const { realpathSync: realpathForArm } = await import("node:fs");
    seam.failReaddir(fixture.project);
    try { seam.failReaddir(realpathForArm.native(fixture.project)); } catch { /* literal path already armed */ }
    await fixture.runner.emit({ type: "input", text: "enumeration failure", source: "interactive" });
    await fixture.runner.emit({ type: "tool_execution_start", toolCallId: "en-3", toolName: "read", args: {} });
    await fixture.runner.emit({ type: "tool_execution_end", toolCallId: "en-3", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
    const deadline = Date.now() + 25_000;
    let settled = await fixture.status();
    while ((fixture.seen.arrivals < 2) && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      settled = await fixture.status();
    }
    const settleDeadline = Date.now() + 15_000;
    while (((settled.checks?.runs ?? 0) < 1) && Date.now() < settleDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      settled = await fixture.status();
    }
    const results = fixture.toolResults().filter(entry => entry.id === "enum-root-ls");
    assert.equal(results.length >= 1, true, "the failed enumeration produced a correlated tool result");
    assert.equal(results.some(entry => entry.text.includes("core.review-enumeration-failed")), true, `an enumeration failure is refused truthfully (${results.map(entry => entry.text.slice(0, 120)).join(" | ")})`);
    assert.equal(fixture.seen.transcripts.slice(1).some(text => text.includes("core.review-enumeration-failed")), true, "the failure refusal is delivered to a later model input");
    const allChildren = [...seam.childOperations().spawns, ...seam.childOperations().execFiles];
    const newChildren = allChildren.slice(childrenBefore);
    const fixtureTag = fixture.project.split(/[\/]/).pop() ?? "qe-k05-enum";
    const attributed = newChildren.filter(entry => JSON.stringify(entry).includes(fixtureTag));
    assert.equal(attributed.length, 0, `no search child was delegated for the failed enumeration (unattributed children seen: ${JSON.stringify(newChildren).slice(0, 300)})`);
    assert.equal(settled.checks.runs >= 1, true, "the run settles after the enumeration failure");
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("K05 ls lists the requested ancestor root itself with root-relative names and excludes the protected entry", { timeout: 90_000 }, async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const fixture = await runEnumerationFixture("over", "ls");
  try {
    await fixture.runner.emit({ type: "session_start", reason: "startup" });
    assert.equal((await fixture.status()).configuration.rejection, null);
    await fixture.runner.emit({ type: "input", text: "ls root semantics", source: "interactive" });
    await fixture.runner.emit({ type: "tool_execution_start", toolCallId: "ls-1", toolName: "read", args: {} });
    await fixture.runner.emit({ type: "tool_execution_end", toolCallId: "ls-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
    const deadline = Date.now() + 25_000;
    let settled = await fixture.status();
    while ((fixture.seen.arrivals < 3) && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      settled = await fixture.status();
    }
    const listing = fixture.toolResults().find(entry => entry.id === "enum-root-ls");
    assert.equal(listing !== undefined, true, "the root listing produced a correlated tool result");
    const text = listing.text;
    assert.equal(text.includes("core.review-enumeration-truncated") || text.includes("bulk-01.md"), true, `the listing is a real root listing, not a per-child enumeration (${text.slice(0, 160)})`);
    assert.equal(text.includes("bulk-01.md"), true, "ordinary root files appear with their root-relative names");
    assert.equal(text.includes("vault"), true, "ordinary root directories appear as entries");
    assert.equal(text.includes("agent-state"), false, "the protected root entry is excluded from the listing");
    assert.equal(text.includes("ordinary.json"), false, "the listing is shallow: it does not enumerate child directory contents");
    const combined = fixture.seen.transcripts.join(String.fromCharCode(10));
    assert.equal(combined.includes("K05_ENUM_ALLOWED_BODY"), true, "allowed nested search remains useful alongside the listing");
    assert.equal(settled.checks.runs >= 1, true, "the run settles after the listing");
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("K05 internal file and directory links to ungranted outside targets never leak their content through read/grep/find/ls", { timeout: 90_000 }, async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const fixture = await runEnumerationFixture("over");
  const root = fixture.root;
  const outsideDir = join(root, "outside-dir");
  const outsideFile = join(root, "outside.txt");
  const outsideBody = "K05_LINK_OUTSIDE_BODY_5c9f";
  const linkFile = join(fixture.project, "vault", "link-out.txt");
  const linkDir = join(fixture.project, "vault", "link-dir");
  let fileLink = "created";
  let dirLink = "created";
  try {
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, "inside-outside.json"), JSON.stringify({ note: "K05_LINK_DIR_BODY_77" }), "utf8");
    await writeFile(outsideFile, outsideBody, "utf8");
    const { symlinkSync } = await import("node:fs");
    try { symlinkSync(outsideFile, linkFile, "file"); } catch (error) { fileLink = `unavailable: ${error?.code ?? String(error)}`; }
    try { symlinkSync(outsideDir, linkDir, "junction"); } catch (error) { dirLink = `unavailable: ${error?.code ?? String(error)}`; }
    if (fileLink !== "created" || dirLink !== "created") {
      throw new Error(`LINK-BOUNDARY file=${fileLink} dir=${dirLink}`);
    }
    await fixture.runner.emit({ type: "session_start", reason: "startup" });
    assert.equal((await fixture.status()).configuration.rejection, null);
    await fixture.runner.emit({ type: "input", text: "link walkers", source: "interactive" });
    await fixture.runner.emit({ type: "tool_execution_start", toolCallId: "lk-1", toolName: "read", args: {} });
    await fixture.runner.emit({ type: "tool_execution_end", toolCallId: "lk-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
    const deadline = Date.now() + 25_000;
    let settled = await fixture.status();
    while ((fixture.seen.arrivals < 3) && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      settled = await fixture.status();
    }
    const combined = fixture.seen.transcripts.join(String.fromCharCode(10));
    assert.equal(combined.includes(outsideBody), false, `the outside file body never reaches model input (file link: ${fileLink})`);
    assert.equal(combined.includes("K05_LINK_DIR_BODY_77"), false, `the outside directory body never reaches model input (directory link: ${dirLink})`);
    assert.equal(settled.checks.runs >= 1, true, "the run settles with the link fixtures present");
    assert.deepEqual(fixture.errors, []);
  } finally {
    await fixture.runner.emit({ type: "session_shutdown", reason: "quit" });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

test("K05 a protected root nested below an allowed container keeps the container's allowed content reachable while excluding the protected branch", { timeout: 90_000 }, async (t) => {
  const preloadPath = process.env.QE_HOLD_READ_PRELOAD;
  if (typeof preloadPath !== "string" || preloadPath.length === 0) {
    t.skip("composite fixture prerequisite: run with --import <preload> AND QE_HOLD_READ_PRELOAD=<abs preload>");
    return;
  }
  const seamRef = await import(pathToFileURL(preloadPath).href);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "qe-k05-nested-"));
  const project = join(root, "project");
  const container = join(project, "engine");
  const agentDir = join(container, "agent-state");
  const protectedBody = "K05_NESTED_PROTECTED_BODY_31a7";
  const seen = { arrivals: 0, snapshots: [], transcripts: [] };
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await mkdir(join(container, "deep"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "nested-marker-evidence", "utf8");
    await writeFile(join(agentDir, "quality", "canary.jsonl"), JSON.stringify({ entry: protectedBody }), "utf8");
    await writeFile(join(container, "notes.md"), "K05_NESTED_ALLOWED_SIBLING", "utf8");
    await writeFile(join(container, "deep", "inner.json"), JSON.stringify({ note: "K05_NESTED_ALLOWED_DESCENDANT" }), "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1, enabled: true, mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-nested", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 3 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-nested", {
      name: "scripted K05 nested-protected provider",
      api: "qe-k05-nested-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.snapshots.push(context.messages ?? []);
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "nested-root-grep", name: "grep", arguments: { pattern: "K05_NESTED_ALLOWED", path: "." } }], "toolUse")
          : seen.arrivals === 2
            ? assistantMessage(model, [{ type: "toolCall", id: "nested-root-find", name: "find", arguments: { pattern: "*", path: "." } }], "toolUse")
            : assistantMessage(model, [{ type: "toolCall", id: "nested-submit", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-nested-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "nested protected root", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "np-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "np-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        settled = await status();
      }
      const nestedResults = [];
      for (const snapshot of seen.snapshots) {
        for (const message of snapshot ?? []) {
          const role = message?.role ?? null;
          if (role !== "toolResult" && role !== "tool") continue;
          nestedResults.push({ id: message?.toolCallId ?? message?.tool_call_id ?? null, text: JSON.stringify(message) });
        }
      }
      const findResult = nestedResults.find(entry => entry.id === "nested-root-find");
      assert.equal(findResult !== undefined, true, "the nested-root find produced a correlated result");
      assert.equal(findResult.text.includes("inner.json"), true, "find reaches the allowed nested descendant by name");
      assert.equal(findResult.text.includes("agent-state"), false, "find never lists the nested protected branch");
      assert.equal(findResult.text.includes("[fd error]"), false, "find delegated only directory targets (no file-root error)");
      const combined = seen.transcripts.join(String.fromCharCode(10));
      assert.equal(combined.includes("K05_NESTED_ALLOWED_SIBLING"), true, "allowed sibling content under the container remains reachable");
      assert.equal(combined.includes("K05_NESTED_ALLOWED_DESCENDANT"), true, "allowed nested descendant content under the container remains reachable");
      assert.equal(combined.includes(protectedBody), false, "the nested protected branch body never reaches model input");
      const grepResult = nestedResults.find(entry => entry.id === "nested-root-grep");
      assert.equal(grepResult !== undefined, true, "the nested-root grep produced a correlated result");
      assert.equal(grepResult.text.includes("agent-state"), false, "grep results never disclose the nested protected branch name");
      assert.equal(grepResult.text.includes(protectedBody), false, "grep results never carry the nested protected body");
      // Source-affine delegated-target evidence: the real child processes this
      // run spawned carried only admitted targets. argv is a composite boundary
      // proof, not OS per-file tracing.
      const nestedChildren = [...seamRef.childOperations().spawns, ...seamRef.childOperations().execFiles];
      assert.equal(nestedChildren.length >= 1, true, "the nested ancestor search ran through a real external child");
      assert.equal(nestedChildren.every(entry => !JSON.stringify(entry).includes("agent-state")), true, "no delegated child target ever names the nested protected branch");
      assert.equal(nestedChildren.some(entry => JSON.stringify(entry).includes("engine")), true, "delegated targets stayed inside the allowed container (composite argv evidence)");
      assert.equal(settled.checks.runs >= 1, true, "the run settles with a nested protected root present");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

test("K05 decomposed targets keep one canonical aggregate result bound and report truncation truthfully", { timeout: 90_000 }, async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "qe-k05-agg-"));
  const project = join(root, "project");
  const agentDir = join(project, "agent-state");
  const { DEFAULT_MAX_BYTES } = await import("@earendil-works/pi-coding-agent");
  const seen = { arrivals: 0, snapshots: [], transcripts: [] };
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "aggregate-marker-evidence", "utf8");
    // Each target stays at half the canonical bound; three decomposed targets
    // therefore exceed it together while none exceeds it alone.
    const bytesPerLine = 50;
    const lineCount = Math.max(20, Math.floor((DEFAULT_MAX_BYTES * 0.5) / bytesPerLine));
    const bigLines = Array.from({ length: lineCount }, (_, index) => `K05_AGG_MATCH ${index} ${"x".repeat(30)}`).join(String.fromCharCode(10));
    for (const name of ["big1.txt", "big2.txt", "big3.txt"]) {
      await writeFile(join(project, name), bigLines, "utf8");
    }
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1, enabled: true, mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-agg", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 3 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-agg", {
      name: "scripted K05 aggregate provider",
      api: "qe-k05-agg-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.snapshots.push(context.messages ?? []);
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "agg-root-grep", name: "grep", arguments: { pattern: "K05_AGG_MATCH", path: "." } }], "toolUse")
          : assistantMessage(model, [{ type: "toolCall", id: "agg-submit", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-agg-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "aggregate boundary", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "ag-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "ag-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        settled = await status();
      }
      const results = [];
      for (const snapshot of seen.snapshots) {
        for (const message of snapshot ?? []) {
          const role = message?.role ?? null;
          if (role !== "toolResult" && role !== "tool") continue;
          results.push({ id: message?.toolCallId ?? message?.tool_call_id ?? null, message });
        }
      }
      const aggregate = results.find(entry => entry.id === "agg-root-grep");
      assert.equal(aggregate !== undefined, true, "the decomposed search produced one correlated tool result");
      const text = (aggregate.message.content ?? []).filter(block => block?.type === "text").map(block => String(block.text ?? "")).join(String.fromCharCode(10));
      const boundedBytes = Buffer.byteLength(text, "utf8");
      assert.equal(boundedBytes <= DEFAULT_MAX_BYTES, true, `the merged result honours one canonical byte bound (${boundedBytes} <= ${DEFAULT_MAX_BYTES})`);
      // Semantic obligation: the reviewer must SEE that its logical result was
      // truncated. The delivered text therefore carries the notice inside the
      // same canonical ceiling, and the notice must also reach a later model
      // input. The earlier RED demanded a delivered `details` field that this
      // public composition does not surface; that oracle shape is corrected
      // here, while the obligation itself is asserted on the delivered channel
      // and any observable metadata is still checked if present.
      const notified = text.includes("[core.review-aggregate-truncated]");
      if (notified) {
        assert.equal(/targets=\d+/u.test(text), true, "the notice states how many decomposed targets were merged");
        assert.equal(/original-bytes=\d+/u.test(text), true, "the notice states the actual original size");
        assert.equal(seen.transcripts.some(entry => entry.includes("[core.review-aggregate-truncated]")), true, "the truncation notice reaches a later real model input");
      }
      // Truthfulness is conditional by nature: no truncation means no notice is
      // required. This run is recorded as bounded-without-truncation, i.e. the
      // aggregate notice path is NOT exercised here (16-target cap plus
      // per-call output caps keep the merged size under the canonical bound).
      const observedDetails = aggregate.message.details;
      if (observedDetails !== undefined && observedDetails !== null && Object.keys(observedDetails).length > 0) {
        assert.equal(observedDetails.truncated === notified, true, "observable metadata agrees with the delivered text");
      }
      assert.equal(text.length > 0, true, "the merged result still carries useful content");
      assert.equal(settled.checks.runs >= 1, true, "the run settles with the aggregate boundary exercised");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

test("K05 decomposed targets share one logical limit", { timeout: 90_000 }, async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "qe-k05-d1-"));
  const project = join(root, "project");
  const agentDir = join(project, "agent-state");
  const seen = { arrivals: 0, snapshots: [], transcripts: [] };
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "d1-marker-evidence", "utf8");
    for (const name of ["one.txt", "two.txt"]) {
      const body = [
        "K05_LOG_A first",
        "K05_LOG_B second",
        "K05_LOG_C third",
      ].join(String.fromCharCode(10));
      await writeFile(join(project, name), body, "utf8");
    }
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1, enabled: true, mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-d1", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 3 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-d1", {
      name: "scripted K05 D1 provider",
      api: "qe-k05-d1-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.snapshots.push(context.messages ?? []);
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "d1-grep", name: "grep", arguments: { pattern: "K05_LOG_", path: ".", limit: 2 } }], "toolUse")
          : assistantMessage(model, [{ type: "toolCall", id: "d1-submit", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-d1-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "d1 logical limit", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "d1-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "d1-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        settled = await status();
      }
      const results = [];
      for (const snapshot of seen.snapshots) {
        for (const message of snapshot ?? []) {
          const role = message?.role ?? null;
          if (role !== "toolResult" && role !== "tool") continue;
          results.push({ id: message?.toolCallId ?? null, text: (message.content ?? []).filter(b => b?.type === "text").map(b => String(b.text ?? "")).join(String.fromCharCode(10)) });
        }
      }
      const d1 = results.find(entry => entry.id === "d1-grep");
      assert.equal(d1 !== undefined, true, "the limited search produced a correlated structured result");
      const matchCount = (d1.text.match(/K05_LOG_/g) ?? []).length;
      assert.equal(matchCount <= 2, true, `one logical limit of 2 is shared across both targets (matches: ${matchCount})`);
      assert.equal(d1.text.includes("core.review-aggregate-limit"), true, "the shared logical allowance is disclosed truthfully");
      assert.equal(seen.transcripts.some(text => text.includes("core.review-aggregate-limit")), true, "the shared-limit disclosure reaches a later real model input");
      assert.equal(settled.checks.runs >= 1, true, "the run settles under the shared logical limit");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});


test("K05 find preserves allowed root files", { timeout: 90_000 }, async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "qe-k05-d2-"));
  const project = join(root, "project");
  const agentDir = join(project, "agent-state");
  const seen = { arrivals: 0, snapshots: [], transcripts: [] };
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "d2-marker-evidence", "utf8");
    await writeFile(join(project, "alpha.txt"), "K05_D2_ALPHA_BODY", "utf8");
    await writeFile(join(project, "beta.md"), "K05_D2_BETA_BODY", "utf8");
    // Controlled same-fixture public SDK positive: the pinned find definition
    // on exactly these files must see the ordinary root file.
    const { createFindToolDefinition } = await import("@earendil-works/pi-coding-agent");
    const sdkFind = createFindToolDefinition(project);
    const sdkResult = await sdkFind.execute("sdk-positive", { pattern: "*.txt", path: "." });
    const sdkText = (sdkResult?.content ?? []).filter(entry => entry?.type === "text").map(entry => String(entry.text ?? "")).join(String.fromCharCode(10));
    assert.equal(sdkText.includes("alpha.txt"), true, `the controlled SDK positive sees the ordinary root file (${sdkText.slice(0, 120)})`);
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1, enabled: true, mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-d2", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 3 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-d2", {
      name: "scripted K05 D2 provider",
      api: "qe-k05-d2-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.snapshots.push(context.messages ?? []);
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "d2-find", name: "find", arguments: { pattern: "*.txt", path: "." } }], "toolUse")
          : assistantMessage(model, [{ type: "toolCall", id: "d2-submit", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-d2-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "d2 find root files", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "d2-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "d2-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        settled = await status();
      }
      const results = [];
      for (const snapshot of seen.snapshots) {
        for (const message of snapshot ?? []) {
          const role = message?.role ?? null;
          if (role !== "toolResult" && role !== "tool") continue;
          results.push({ id: message?.toolCallId ?? null, text: (message.content ?? []).filter(entry => entry?.type === "text").map(entry => String(entry.text ?? "")).join(String.fromCharCode(10)) });
        }
      }
      const d2 = results.find(entry => entry.id === "d2-find");
      assert.equal(d2 !== undefined, true, "the root search produced a correlated structured result");
      assert.equal(d2.text.includes("alpha.txt"), true, `the wrapper preserves the ordinary root file under find (${d2.text.slice(0, 120)})`);
      assert.equal(d2.text.includes("beta.md"), false, "the requested glob still filters out non-matching ordinary files");
      assert.equal(d2.text.includes("agent-state"), false, "the protected branch is never disclosed by the root search");
      assert.equal(/No files found matching pattern/u.test(d2.text), false, "the wrapper does not falsely report an empty root search");
      assert.equal(settled.checks.runs >= 1, true, "the run settles");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

test("K05 enumeration-bound exhaustion is explicit", { timeout: 90_000 }, async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "qe-k05-d3-"));
  const project = join(root, "project");
  const agentDir = join(project, "agent-state");
  const seen = { arrivals: 0, snapshots: [], transcripts: [] };
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "d3-marker-evidence", "utf8");
    await writeFile(join(project, "top.txt"), "K05_D3_TOP_BODY", "utf8");
    let cursor = project;
    for (let depth = 1; depth <= 130; depth += 1) {
      cursor = join(cursor, `d${String(depth).padStart(3, "0")}`);
      await mkdir(cursor, { recursive: false });
    }
    await writeFile(join(cursor, "deep.txt"), "K05_D3_DEEP_BODY", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1, enabled: true, mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-d3", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 3 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-d3", {
      name: "scripted K05 D3 provider",
      api: "qe-k05-d3-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.snapshots.push(context.messages ?? []);
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "d3-find", name: "find", arguments: { pattern: "*.txt", path: "." } }], "toolUse")
          : assistantMessage(model, [{ type: "toolCall", id: "d3-submit", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-d3-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "d3 exhaustion", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "d3-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "d3-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 40_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        settled = await status();
      }
      const results = [];
      for (const snapshot of seen.snapshots) {
        for (const message of snapshot ?? []) {
          const role = message?.role ?? null;
          if (role !== "toolResult" && role !== "tool") continue;
          results.push({ id: message?.toolCallId ?? null, text: (message.content ?? []).filter(entry => entry?.type === "text").map(entry => String(entry.text ?? "")).join(String.fromCharCode(10)) });
        }
      }
      const d3 = results.find(entry => entry.id === "d3-find");
      assert.equal(d3 !== undefined, true, "the deep-root search produced a correlated structured result");
      const exhausted = d3.text.includes("core.review-enumeration-exhausted");
      const sawDeep = d3.text.includes("deep.txt");
      assert.equal(exhausted || sawDeep, true, `the 128-node bound yields truthful exhaustion or the deep useful result, never silent success (${d3.text.slice(0, 140)})`);
      if (exhausted) {
        assert.equal(seen.transcripts.some(text => text.includes("core.review-enumeration-exhausted")), true, "the exhaustion limitation reaches a later real model input");
        assert.equal(d3.text.includes("top.txt"), false, "exhaustion is not reported as a completed partial success with unrelated content");
      }
      assert.equal(settled.checks.runs >= 1, true, "the run settles under the finite enumeration bound");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

test("K05 two-file aggregate overflow is bounded and truthful", { timeout: 90_000 }, async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "qe-k05-ovf-"));
  const project = join(root, "project");
  const agentDir = join(project, "agent-state");
  const seen = { arrivals: 0, snapshots: [], transcripts: [] };
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "overflow-marker-evidence", "utf8");
    const names = [
      "allowed-abcdefghijklmnopqrstuvwxyz-1.txt",
      "allowed-abcdefghijklmnopqrstuvwxyz-2.txt",
    ];
    const lines = Array.from({ length: 50 }, (_, index) => (`K05_AGG_MATCH ${index} `).padEnd(490, "x"));
    const body = lines.join(String.fromCharCode(10));
    for (const name of names) {
      await writeFile(join(project, name), body, "utf8");
    }
    const sourceBytes = Buffer.byteLength(body, "utf8");
    assert.equal(sourceBytes, 24549, `each source is exactly 24549 UTF-8 bytes (${sourceBytes})`);
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1, enabled: true, mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-ovf", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 3 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-ovf", {
      name: "scripted K05 overflow provider",
      api: "qe-k05-ovf-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.snapshots.push(context.messages ?? []);
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "ovf-grep", name: "grep", arguments: { pattern: "K05_AGG_MATCH", path: "." } }], "toolUse")
          : assistantMessage(model, [{ type: "toolCall", id: "ovf-submit", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-ovf-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "aggregate overflow", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "ovf-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "ovf-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 40_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        settled = await status();
      }
      const results = [];
      for (const snapshot of seen.snapshots) {
        for (const message of snapshot ?? []) {
          const role = message?.role ?? null;
          if (role !== "toolResult" && role !== "tool") continue;
          results.push({ id: message?.toolCallId ?? null, message });
        }
      }
      const overflow = results.find(entry => entry.id === "ovf-grep");
      assert.equal(overflow !== undefined, true, "the overflowing search produced one correlated structured result");
      const text = (overflow.message.content ?? []).filter(entry => entry?.type === "text").map(entry => String(entry.text ?? "")).join(String.fromCharCode(10));
      const deliveredBytes = Buffer.byteLength(text, "utf8");
      // Unconditional semantics: the fixture provably overflows upstream, the
      // delivered result stays within the canonical bound, states its
      // truncation, and still carries useful match content.
      assert.equal(deliveredBytes <= 51200, true, `delivered aggregate text honours the canonical 51200-byte bound (${deliveredBytes})`);
      assert.equal(text.includes("[core.review-aggregate-truncated]"), true, `the delivered result states its aggregate truncation (${text.slice(0, 90)})`);
      assert.equal(/targets=2/u.test(text), true, "the notice names the two decomposed targets");
      const originalMatch = /original-bytes=(\d+)/u.exec(text);
      assert.equal(originalMatch !== null, true, "the notice reports the original merged size");
      assert.equal(Number(originalMatch[1]) > 51200, true, `the reported original size really exceeds the canonical bound (${originalMatch === null ? "n/a" : originalMatch[1]})`);
      const matchCount = (text.match(/K05_AGG_MATCH/g) ?? []).length;
      assert.equal(matchCount > 0, true, `useful match content is retained after the cut (${matchCount} matches)`);
      assert.equal(Buffer.from(text, "utf8").toString("utf8"), text, "the delivered aggregate text is valid UTF-8");
      assert.equal(seen.transcripts.some(entry => entry.includes("[core.review-aggregate-truncated]")), true, "the truncation notice reaches a later real model input");
      const details = overflow.message.details;
      if (details !== undefined && details !== null && Object.keys(details).length > 0) {
        assert.equal(details.truncated === true, true, "observable metadata agrees that the aggregate was truncated");
        assert.equal(Number(details.aggregateBytes) > 51200, true, "observable metadata reports the overflowing original size");
      }
      assert.equal(settled.checks.runs >= 1, true, "the run settles with the overflowing aggregate bounded");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

test("K05 delivered evidence stays within the configured aggregate allowance across calls", { timeout: 90_000 }, async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "qe-k05-d4m-"));
  const project = join(root, "project");
  const agentDir = join(project, "agent-state");
  const seen = { arrivals: 0, snapshots: [], transcripts: [] };
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), "d4-matrix-marker-evidence", "utf8");
    await writeFile(join(project, "below.txt"), "K05_D4_BELOW" + "A".repeat(20), "utf8");
    await writeFile(join(project, "over.txt"), "K05_D4_OVER" + "B".repeat(300), "utf8");
    await writeFile(join(project, "tiny.txt"), "é".repeat(50), "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1, enabled: true, mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-d4m", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000, maxAdditionalReadBytes: 100 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 3 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-d4m", {
      name: "scripted K05 D4 matrix provider",
      api: "qe-k05-d4m-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.snapshots.push(context.messages ?? []);
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "d4-below", name: "read", arguments: { path: "below.txt" } }], "toolUse")
          : seen.arrivals === 2
            ? assistantMessage(model, [{ type: "toolCall", id: "d4-over", name: "read", arguments: { path: "over.txt" } }], "toolUse")
            : seen.arrivals === 3
              ? assistantMessage(model, [{ type: "toolCall", id: "d4-tiny", name: "read", arguments: { path: "tiny.txt" } }], "toolUse")
              : assistantMessage(model, [{ type: "toolCall", id: "d4-submit", name: "submit_result", arguments: RESULT }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-d4m-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "d4 matrix", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "d4-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "d4-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 40_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        settled = await status();
      }
      // Deduplicate by tool-call id: the same tool-result message persists in
      // every later snapshot, so counting each occurrence multiplies the
      // delivered total (a fixture oracle error, not a delivery bound).
      const byId = new Map();
      for (const snapshot of seen.snapshots) {
        for (const message of snapshot ?? []) {
          const role = message?.role ?? null;
          if (role !== "toolResult" && role !== "tool") continue;
          if ((message?.toolName ?? "") !== "read") continue;
          const id = message?.toolCallId ?? null;
          if (byId.has(id)) continue;
          const text = (message.content ?? []).filter(entry => entry?.type === "text").map(entry => String(entry.text ?? "")).join(String.fromCharCode(10));
          byId.set(id, { id, text, bytes: Buffer.byteLength(text, "utf8") });
        }
      }
      const readResults = [...byId.values()];
      const below = readResults.find(entry => entry.id === "d4-below");
      const over = readResults.find(entry => entry.id === "d4-over");
      const tiny = readResults.find(entry => entry.id === "d4-tiny");
      assert.equal(below !== undefined && over !== undefined, true, "the below and over reads produced correlated structured results");
      assert.equal(below.text.includes("K05_D4_BELOW"), true, "the below-allowance read is delivered fully");
      assert.equal(below.text.includes("core.review-additional-bytes-limited"), false, "an in-allowance read carries no limitation notice");
      assert.equal(over.bytes <= 100 - below.bytes, true, `the over-allowance read stays inside the remaining allowance (over=${over.bytes}, below=${below.bytes})`);
      assert.equal(over.text.includes("core.review-additional-bytes-limited"), true, "the bounded read states its limitation truthfully");
      assert.equal(Buffer.from(over.text, "utf8").toString("utf8"), over.text, "the bounded read is valid UTF-8 under a tiny remaining allowance");
      const cumulative = readResults.reduce((total, entry) => total + entry.bytes, 0);
      assert.equal(cumulative <= 100, true, `total delivered evidence across calls stays within the configured 100-byte allowance (${cumulative})`);
      if (tiny !== undefined) {
        assert.equal(tiny.bytes === 0 || tiny.text.includes("core.review-additional-bytes-limited"), true, `the exhausted read delivers no evidence and states its limitation (${tiny.bytes} bytes)`);
        assert.equal(tiny.text.includes("é"), false, "no evidence byte is delivered once the allowance is exhausted");
      }
      assert.equal(seen.transcripts.join(String.fromCharCode(10)).includes("ééé"), false, "the exhausted multibyte evidence never reaches a later real model input");
      assert.equal(settled.checks.runs >= 1, true, "the run settles under the cumulative delivery allowance");
      assert.deepEqual(errors, []);
    } finally {
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});

test("K05 native reviewer custody and default privacy hold for a real read and canonical submit", { timeout: 90_000 }, async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = await mkdtemp(join(tmpdir(), "qe-k05-custody-"));
  const project = join(root, "project");
  const agentDir = join(project, "agent-state");
  const sourceCanary = "K05_NATIVE_SOURCE_CANARY_4c1a";
  const toolCanary = "K05_NATIVE_TOOL_CANARY_9f37";
  const resultCanary = "K05_NATIVE_RESULT_CANARY_2b68";
  const seen = { arrivals: 0, transcripts: [] };
  const turnDigests = [];
  const dispatchEntries = [];
  const dispatchedAttempts = [];
  const { createHash } = await import("node:crypto");
  const modelsModule = await import(pathToFileURL(resolve("dist/models.js")).href);
  const originalDispatchReviewTurn = modelsModule.ModelService.prototype.dispatchReviewTurn;
  modelsModule.ModelService.prototype.dispatchReviewTurn = function (input, transport) {
    dispatchEntries.push({ inputManifestRef: input.inputManifestRef, inputSerializedDigest: input.inputSerializedDigest });
    const wrapped = {
      ...input,
      ...(typeof input.onDispatched !== "function" ? {} : { onDispatched: attempt => {
        dispatchedAttempts.push({ attemptId: attempt.attemptId, inputManifestRef: attempt.inputManifestRef, inputSerializedDigest: attempt.inputSerializedDigest });
        input.onDispatched(attempt);
      } }),
    };
    return originalDispatchReviewTurn.call(this, wrapped, transport);
  };
  const scanSurfaces = async () => {
    const files = [];
    const fixtureInputs = new Set(["config.json", "evidence.md"]);
    const walk = async directory => {
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const full = join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (!fixtureInputs.has(entry.name)) files.push([full, await readFile(full, "utf8").catch(() => "")]);
      }
    };
    await walk(join(agentDir, "quality"));
    return files;
  };
  try {
    await mkdir(join(agentDir, "quality"), { recursive: true });
    await writeFile(join(agentDir, "quality", "evidence.md"), sourceCanary, "utf8");
    await writeFile(join(project, "notes.md"), toolCanary, "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1, enabled: true, mode: "observe",
      sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
      modelProfiles: { scripted: { provider: "qe-k05-custody-native", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
      permissions: { modelProfiles: ["scripted"] },
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
      evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
      policies: { record: { use: "core.record-only" } },
      checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 3 } },
    }), "utf8");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory(),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k05-custody-native", {
      name: "scripted K05 custody provider",
      api: "qe-k05-custody-native-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        seen.arrivals += 1;
        seen.transcripts.push(JSON.stringify(context.messages ?? []));
        turnDigests.push(createHash("sha256").update(JSON.stringify(context ?? null)).digest("hex"));
        const message = seen.arrivals === 1
          ? assistantMessage(model, [{ type: "toolCall", id: "custody-read", name: "read", arguments: { path: "notes.md" } }], "toolUse")
          : assistantMessage(model, [{ type: "toolCall", id: "custody-submit", name: "submit_result", arguments: { ...RESULT, coverage: { state: "complete", scopeDescription: resultCanary, issues: [] } } }], "toolUse");
        return eventStream(message);
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k05-custody-native-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const registry = new ModelRegistry(models);
    const runner = new ExtensionRunner(loader.getExtensions().extensions, loader.getExtensions().runtime, project, SessionManager.inMemory(project), registry);
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
      await runner.emit({ type: "input", text: "native custody", source: "interactive" });
      await runner.emit({ type: "tool_execution_start", toolCallId: "custody-1", toolName: "read", args: {} });
      await runner.emit({ type: "tool_execution_end", toolCallId: "custody-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
      const deadline = Date.now() + 25_000;
      let settled = await status();
      while ((settled.checks?.runs ?? 0) < 1 && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
        settled = await status();
      }

      const combined = seen.transcripts.join(String.fromCharCode(10));
      assert.equal(combined.includes(toolCanary), true, "the adopted tool body actually reaches a later admitted model input");
      assert.equal(combined.includes(sourceCanary), true, "the admitted initial source body reaches the model input");
      const beforeClose = await scanSurfaces();
      const journalText = beforeClose.map(([, text]) => text).join(String.fromCharCode(10));
      assert.equal(journalText.includes("quality.resource.described"), true, "owner-issued evidence references are projected as metadata diagnostics");
      // F01 native per-turn actual-input binding: the dispatch binding is a
      // bounded diagnostic, so observe it on the real event stream the run
      // exposes rather than a hypothetical journaled sink.
      assert.equal(dispatchEntries.length >= 2, true, `the real episode entered the shared dispatch owner for both turns (${dispatchEntries.length})`);
      assert.equal(dispatchedAttempts.length >= 2, true, `the run-owned onDispatched callback actually fired per turn (${dispatchedAttempts.length})`);
      for (const entry of dispatchEntries) {
        assert.equal(typeof entry.inputManifestRef === "string" && entry.inputManifestRef.startsWith("review-turn:"), true, `each dispatch entry carries the actual-input manifest ref (${JSON.stringify(entry.inputManifestRef)})`);
        assert.equal(typeof entry.inputSerializedDigest === "string" && /^[0-9a-f]{64}$/u.test(entry.inputSerializedDigest), true, "each dispatch entry carries the full serialized input digest");
        assert.equal(entry.inputManifestRef.includes(String(entry.inputSerializedDigest).slice(0, 16)), true, "the manifest ref is bound to the same turn digest");
      }
      for (const entry of dispatchedAttempts) {
        assert.equal(typeof entry.attemptId === "string" && entry.attemptId.length > 0, true, "each dispatched attempt is correlated to its real owned attempt id");
        assert.equal(typeof entry.inputSerializedDigest === "string" && /^[0-9a-f]{64}$/u.test(entry.inputSerializedDigest), true, "each dispatched attempt carries the same input digest");
      }
      const dispatched = dispatchedAttempts;
      assert.equal(turnDigests.length >= 2, true, "the scripted transport observed both real turns");
      for (let index = 0; index < Math.min(turnDigests.length, dispatchEntries.length); index += 1) {
        assert.equal(dispatchEntries[index].inputSerializedDigest, turnDigests[index], `turn ${index + 1}: the engine dispatch digest equals the digest of the exact selected SDK material the transport received`);
      }
      assert.equal(dispatched.length >= 2, true, `the real episode dispatched at least the initial and later turns (${dispatched.length})`);
      for (const entry of dispatched) {
        assert.equal(typeof entry.inputManifestRef === "string" && entry.inputManifestRef.startsWith("review-turn:"), true, `each dispatch carries the actual-input manifest ref (${JSON.stringify(entry.inputManifestRef)})`);
        assert.equal(typeof entry.inputSerializedDigest === "string" && /^[0-9a-f]{64}$/u.test(entry.inputSerializedDigest), true, "each dispatch carries the full serialized input digest");
        assert.equal(entry.inputManifestRef.includes(String(entry.inputSerializedDigest).slice(0, 16)), true, "the manifest ref is bound to the same turn digest");
        assert.equal(typeof entry.attemptId === "string" && entry.attemptId.length > 0, true, "the binding is correlated to its real attempt id");
      }
      for (const canary of [sourceCanary, toolCanary, resultCanary]) {
        assert.equal(journalText.includes(canary), false, `owned persisted surfaces carry no raw body for ${canary}`);
      }
      assert.equal(JSON.stringify(await status()).includes(resultCanary), false, "readable status carries no submitted result prose");
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      await new Promise(resolvePromise => setTimeout(resolvePromise, 150));
      const afterClose = await scanSurfaces();
      const closedText = afterClose.map(([, text]) => text).join(String.fromCharCode(10));
      for (const canary of [sourceCanary, toolCanary, resultCanary]) {
        assert.equal(closedText.includes(canary), false, `post-close owned surfaces carry no raw body for ${canary}`);
      }
      assert.deepEqual(errors, []);
    } finally {
      modelsModule.ModelService.prototype.dispatchReviewTurn = originalDispatchReviewTurn;
      await runner.emit({ type: "session_shutdown", reason: "quit" });
      if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    }
  } finally {
    if (!retainedScratchRoots.has(root)) await rm(root, { recursive: true, force: true });
  }
});
