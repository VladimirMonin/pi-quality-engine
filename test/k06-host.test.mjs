// K06 native witness: one bounded advisory note, admitted by the real runtime,
// appears exactly once in the next actual MAIN Pi provider input after the held
// tool batch ends, with correlated action receipts in the durable journal.
//
// This drives the real pinned SDK agent loop (`createAgentSession`) with the
// built `dist/index.js` extension and a disposable local scripted provider, so
// every turn boundary, draft commit and provider request is the SDK's own code
// path - not a test-side imitation.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, createReadToolDefinition,
} from "@earendil-works/pi-coding-agent";

// The bounded note carries its opaque action identity inside the marker.
const NOTE_MARKER = "[quality-advice";
const CUSTOM_TYPE = "pi-quality-engine.feedback.v1";

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

// A fixture extension that contributes one slow deterministic evaluator through
// the engine's published public registry endpoint. It changes nothing else.
const FIXTURE_EXTENSION = `
export default function fixtureEvaluator(pi) {
  let registered = false;
  pi.events.on("quality.registry.available.v1", endpoint => {
    if (registered || typeof endpoint?.register !== "function") return;
    registered = true;
    const evaluator = {
      id: "fixture.slow",
      apiMajor: 1,
      kind: "evaluator",
      mechanism: "deterministic",
      accepts: ["json"],
      optionsSchema: { type: "object", additionalProperties: false },
      requiredCapabilities: [],
      diagnosticCodes: ["fixture.slow-evidence"],
      evaluate: async (_options, input) => {
        // Bounded local hold so the check settles after the first turn boundary
        // and during the natural final turn.
        await new Promise(resolve => setTimeout(resolve, 300));
        const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
        return {
          operational: "completed",
          coverage: input.context.coverage,
          conclusion: items.length > 0 ? "findings" : "no-supported-finding",
          findings: items.map(item => ({
            id: input.run.runId + ":finding-1",
            criterion: "efficiency.repetition",
            status: "supported",
            severity: "concern",
            requirementRefs: [],
            evidenceIds: [item.id],
            affectedItems: [],
            defectCode: "fixture.slow-drift",
            explanation: "fixture concern over observed work",
            proposedCorrection: null,
            limitations: [],
          })),
          scores: [],
          additionalEvidence: [],
          dependencies: input.context.dependencies,
          usageAttemptIds: [],
        };
      },
    };
    void endpoint.register({ id: "fixture.slow-package", version: "0.1.0", baseUri: "fixture:slow", components: [evaluator], resources: {} });
  });
}
`;

async function runNaturalFinish(allowIdleContinuation) {
  const root = await mkdtemp(join(tmpdir(), "qe-k06-nat-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "fixture-extension.mjs"), FIXTURE_EXTENSION, "utf8");
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { boundaryWaitMs: 0, maxFeedbackPerEpisode: 3, maxAutonomousFollowUpsPerEpisode: 1 },
    permissions: { actions: ["core.feedback"], allowIdleContinuation, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: { slow: { use: "fixture.slow", options: {} } },
    policies: { engineering: { use: "core.engineering", options: allowIdleContinuation ? { allowIdleContinuation: true } : {} } },
    checks: {
      repetition: {
        triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }],
        context: "recent-work",
        prompt: "repetition",
        evaluator: "slow",
        policy: "engineering",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
      },
    },
    observability: {},
  }), "utf8");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const calls = [];
  const loader = new DefaultResourceLoader({
    cwd: project,
    agentDir,
    settingsManager: SettingsManager.inMemory(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    additionalExtensionPaths: [join(project, "fixture-extension.mjs"), resolve("dist/index.js")],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "the built extension and the fixture extension load cleanly");
  const models = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(root, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  models.registerProvider("qe-k06-scripted", {
    name: "scripted K06 provider",
    api: "qe-k06-api",
    apiKey: "fixture-not-credential",
    baseUrl: "http://127.0.0.1:9/not-used",
    streamSimple: model => {
      const turn = calls.length + 1;
      calls.push(1);
      if (turn === 1) {
        return eventStream(assistantMessage(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.md" } }], "toolUse"));
      }
      // The natural final turn: bounded local hold so the check settles here.
      return {
        async *[Symbol.asyncIterator]() {
          await new Promise(resolvePromise => setTimeout(resolvePromise, 700));
          yield { type: "start", partial: { ...assistantMessage(model, [], "endTurn"), content: [] } };
          yield { type: "done", reason: "endTurn", message: assistantMessage(model, [{ type: "text", text: "work is complete" }], "endTurn") };
        },
        async result() {
          return assistantMessage(model, [{ type: "text", text: "work is complete" }], "endTurn");
        },
      };
    },
    models: [{ id: "scripted-1", name: "scripted", api: "qe-k06-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
  });
  const model = models.getModel("qe-k06-scripted", "scripted-1");
  const { session, extensionsResult } = await createAgentSession({
    cwd: project,
    agentDir,
    modelRuntime: models,
    model,
    thinkingLevel: "off",
    tools: ["read"],
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(project),
    settingsManager: SettingsManager.inMemory(),
  });
  assert.deepEqual(extensionsResult.errors, []);
  const extensionErrors = [];
  await session.bindExtensions({ mode: "print", onError: error => extensionErrors.push(`${error.event}: ${error.error}`) });
  try {
    await session.prompt("finish the work naturally");
  } finally {
    // No synthetic user prompt is ever used to cause the wake.
  }
  await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
  return { calls: calls.length, extensionErrors, journal: await readK06Journal(agentDir), dispose: () => session.dispose(), root, agentDir };
}

async function readK06Journal(agentDir) {
  let text = "";
  for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
    if (name.endsWith(".jsonl")) text += await readFile(join(agentDir, "quality", "logs", name), "utf8");
  }
  return text;
}

test("K06-T03: natural completion never wakes without the grant and a granted follow-up wakes exactly once", { timeout: 180_000 }, async () => {
  const disabled = await runNaturalFinish(false);
  try {
    assert.equal(disabled.calls, 2, `continuation disabled: exactly the two ordinary requests (got ${disabled.calls})`);
    assert.equal(disabled.journal.includes(NOTE_MARKER), false, "no note is appended or woken without the grant");
    assert.deepEqual(disabled.extensionErrors, [], "no host error in the disabled run");
  } finally {
    await disabled.dispose();
    await rm(disabled.root, { recursive: true, force: true });
  }
  const granted = await runNaturalFinish(true);
  try {
    assert.equal(granted.calls, 3, `granted follow-up: exactly one additional provider request (got ${granted.calls})`);
    const lines = granted.journal.split(String.fromCharCode(10)).filter(line => line.trim().length > 0).map(line => JSON.parse(line));
    const admitted = lines.filter(record => record.event === "quality.action.admission").map(record => record.fields?.data ?? {}).filter(entry => entry.outcome === "admitted");
    assert.equal(admitted.length, 1, "the granted follow-up is admitted once");
    assert.equal(admitted[0].componentId, "core.feedback");
    const dispatched = lines.filter(record => record.event === "quality.action.dispatched").map(record => record.fields?.data ?? {});
    assert.equal(dispatched.length, 1, "the same action is dispatched once");
    assert.deepEqual(granted.extensionErrors, [], "no host error in the granted run");
  } finally {
    await granted.dispose();
    await rm(granted.root, { recursive: true, force: true });
  }
});

test("K06-B08/T04b: an abort while the evaluator is still pending leaves no late effect", { timeout: 120_000 }, async () => {
  // Complementary native ordering to the queued-note abort: here the abort lands
  // BEFORE admission - the contributed evaluation is still held when the real main
  // abort arrives, and only then is the late evaluation released.
  const root = await mkdtemp(join(tmpdir(), "qe-k06-late-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.md"), "# notes\nfirst read\n", "utf8");
  await writeFile(join(project, "held.md"), "# held\nsecond read\n", "utf8");
  const latch = () => {
    let release;
    const promise = new Promise(resolvePromise => { release = resolvePromise; });
    return { promise, release };
  };
  const evaluation = latch();
  const heldTool = latch();
  const control = { evaluationRelease: evaluation.promise, entered: 0, active: 0, settled: 0 };
  globalThis.__QE218_LATE__ = control;
  await writeFile(join(project, "fixture-extension.mjs"), `
export default function fixtureEvaluator(pi) {
  const control = globalThis.__QE218_LATE__;
  let registered = false;
  pi.events.on("quality.registry.available.v1", endpoint => {
    if (registered || typeof endpoint?.register !== "function") return;
    registered = true;
    const evaluator = {
      id: "fixture.slow",
      apiMajor: 1,
      kind: "evaluator",
      mechanism: "deterministic",
      accepts: ["json"],
      optionsSchema: { type: "object", additionalProperties: false },
      requiredCapabilities: [],
      diagnosticCodes: ["fixture.slow-evidence"],
      evaluate: async (_options, input) => {
        control.entered += 1;
        control.active += 1;
        try {
          await control.evaluationRelease;
          const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
          return {
            operational: "completed",
            coverage: input.context.coverage,
            conclusion: items.length > 0 ? "findings" : "no-supported-finding",
            findings: items.map(item => ({
              id: input.run.runId + ":finding-1",
              criterion: "efficiency.repetition",
              status: "supported",
              severity: "concern",
              requirementRefs: [],
              evidenceIds: [item.id],
              affectedItems: [],
              defectCode: "fixture.slow-drift",
              explanation: "late evaluation concern",
              proposedCorrection: null,
              limitations: [],
            })),
            scores: [],
            additionalEvidence: [],
            dependencies: input.context.dependencies,
            usageAttemptIds: [],
          };
        } finally {
          control.active -= 1;
          control.settled += 1;
        }
      },
    };
    endpoint.register({ id: "fixture.slow-package", version: "0.1.0", baseUri: "fixture:slow", components: [evaluator], resources: {} });
  });
}
`, "utf8");
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    runtime: { boundaryWaitMs: 0, maxFeedbackPerEpisode: 3, maxAutonomousFollowUpsPerEpisode: 1 },
    permissions: { actions: ["core.feedback"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: { slow: { use: "fixture.slow", options: {} } },
    policies: { engineering: { use: "core.engineering", options: {} } },
    checks: { repetition: { triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }], context: "recent-work", prompt: "repetition", evaluator: "slow", policy: "engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
    observability: {},
  }), "utf8");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const calls = [];
  const appended = [];
  let heldSignal;
  let heldEntered = 0;
  let session;
  try {
    const settings = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(project, "fixture-extension.mjs"), resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k06-late-scripted", {
      name: "late abort scripted provider", api: "qe-k06-late-api", apiKey: "fixture-not-credential", baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: model => {
        const turn = calls.length + 1;
        calls.push(1);
        if (turn === 1) return eventStream(assistantMessage(model, [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "notes.md" } }], "toolUse"));
        if (turn === 2) return eventStream(assistantMessage(model, [{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "held.md" } }], "toolUse"));
        return eventStream(assistantMessage(model, [{ type: "text", text: "final" }], "endTurn"));
      },
      models: [{ id: "scripted", name: "scripted", api: "qe-k06-late-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const readDefinition = createReadToolDefinition(project);
    const heldRead = {
      ...readDefinition,
      async execute(...args) {
        if (args[1]?.path !== "held.md") return Reflect.apply(readDefinition.execute, readDefinition, args);
        heldEntered += 1;
        heldSignal = args[2];
        try {
          await heldTool.promise;
          return await Reflect.apply(readDefinition.execute, readDefinition, args);
        } finally {
          // released by the test after the abort
        }
      },
    };
    const created = await createAgentSession({
      cwd: project, agentDir, modelRuntime: models, model: models.getModel("qe-k06-late-scripted", "scripted"),
      thinkingLevel: "off", tools: ["read"], customTools: [heldRead], resourceLoader: loader,
      sessionManager: SessionManager.inMemory(project), settingsManager: SettingsManager.inMemory(),
    });
    session = created.session;
    assert.deepEqual(created.extensionsResult.errors, []);
    const extensionErrors = [];
    await session.bindExtensions({ mode: "print", onError: error => extensionErrors.push(`${error.event}: ${error.error}`) });
    session.subscribe(event => {
      if (event.type === "entry_appended" && event.entry?.type === "custom_message" && event.entry.customType === "pi-quality-engine.feedback.v1") appended.push(1);
    });
    const prompt = session.prompt("read both files");
    let settled = false;
    prompt.then(() => { settled = true; }, () => { settled = true; });
    const deadline = Date.now() + 15_000;
    while (!(heldEntered === 1 && control.entered >= 1) && Date.now() < deadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
    assert.equal(heldEntered, 1, "the second primary read is actually held");
    assert.equal(control.active, 1, "the contributed evaluation is still pending, before admission");
    assert.equal(calls.length, 2);
    assert.equal(appended.length, 0);
    // Actual public main abort while the evaluation has not yet been admitted.
    const abortPromise = session.abort();
    abortPromise.catch(() => undefined);
    const abortDeadline = Date.now() + 10_000;
    while (heldSignal?.aborted !== true && Date.now() < abortDeadline) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    }
    assert.equal(heldSignal?.aborted, true, "the actual main abort reached the held tool signal");
    // Release the late evaluation only after the abort.
    control.releaseLate = true;
    evaluation.release();
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
    heldTool.release();
    const settleDeadline = Date.now() + 10_000;
    while (!settled && Date.now() < settleDeadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
    assert.equal(settled, true, "the prompt actually settled after the abort");
    assert.equal(control.settled, control.entered, "the late evaluation actually settled");
    assert.equal(control.active, 0);
    assert.equal(appended.length, 0, "no late effect is appended after revocation");
    let journal = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")) .catch(() => [])) {
      if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    // The decisive predicate is the absence of any late EFFECT: whether the late
    // proposal was refused at admission or cancelled at the facet, nothing was
    // dispatched and nothing was appended.
    const lines = journal.split(String.fromCharCode(10)).filter(line => line.trim().length > 0);
    const dispatched = lines.filter(line => line.includes("quality.action.dispatched"));
    assert.equal(dispatched.length, 0, "the late evaluation dispatches no effect after the abort");
    const receipts = lines.filter(line => line.includes("quality.action.receipt"))
      .map(line => JSON.parse(line).fields?.data ?? {});
    assert.equal(receipts.every(entry => entry.state === "cancelled" || entry.state === "unknown"), true,
      "no receipt for the late action reports a delivered effect");
    const revokedOrRejected = lines.filter(line => line.includes("quality.action.admission") && line.includes('"outcome":"rejected"'));
    assert.equal(revokedOrRejected.length >= 1 || receipts.length > 0, true,
      "the late attempt is explicitly refused or cancelled instead of silently dropped");
    assert.deepEqual(extensionErrors, [], "no extension host error");
  } finally {
    evaluation.release();
    heldTool.release();
    delete globalThis.__QE218_LATE__;
    if (session !== undefined) {
      await session.abort().catch(() => undefined);
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }).catch(() => undefined);
      session.dispose();
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("K06-T02: the admitted note reaches the next actual MAIN provider input exactly once", { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k06-host-"));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.md"), "# Notes\nproject fixture\n", "utf8");
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "advise",
    // A bounded wait inside the boundary callback; the default is 0 and never
    // waits for network work. This fixture waits only for the local
    // deterministic check it just triggered.
    runtime: { boundaryWaitMs: 5000, maxFeedbackPerEpisode: 3, maxAutonomousFollowUpsPerEpisode: 1 },
    permissions: { actions: ["core.feedback"], allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: { "repetition-check": { use: "core.repeated-tools", options: { minimumRepeats: 3 } } },
    policies: { engineering: { use: "core.engineering", options: {} } },
    checks: {
      repetition: {
        triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 3 } }],
        context: "recent-work",
        prompt: "repetition",
        evaluator: "repetition-check",
        policy: "engineering",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
      },
    },
    observability: {},
  }), "utf8");
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const calls = [];
  try {
    const loader = new DefaultResourceLoader({
      cwd: project,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      additionalExtensionPaths: [resolve("dist/index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, [], "the built extension loads without errors");

    const models = await ModelRuntime.create({
      authPath: join(root, "auth.json"),
      modelsPath: null,
      modelsStorePath: join(root, "models.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    models.registerProvider("qe-k06-scripted", {
      name: "scripted K06 provider",
      api: "qe-k06-api",
      apiKey: "fixture-not-credential",
      baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        const messages = context.messages ?? [];
        const transcript = JSON.stringify(messages);
        calls.push({ transcript, messages });
        const turn = calls.length;
        if (turn <= 3) {
          // Three real read calls: the engine sees the tool batch held to its end
          // and the third completion is the check's trigger.
          return eventStream(assistantMessage(model, [{
            type: "toolCall",
            id: `read-${turn}`,
            name: "read",
            arguments: { path: "notes.md" },
          }], "toolUse"));
        }
        return eventStream(assistantMessage(model, [{ type: "text", text: "done" }], "endTurn"));
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k06-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
    });
    const model = models.getModel("qe-k06-scripted", "scripted-1");
    assert.ok(model, "the scripted model resolves");

    const { session, extensionsResult } = await createAgentSession({
      cwd: project,
      agentDir,
      modelRuntime: models,
      model,
      thinkingLevel: "off",
      tools: ["read"],
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(project),
      settingsManager: SettingsManager.inMemory(),
    });
    assert.deepEqual(extensionsResult.errors, [], "the extension session loads without errors");
    // `createAgentSession` builds the runner but does not bind it; binding is the
    // real host step that emits session_start and wires the extension context.
    const extensionErrors = [];
    await session.bindExtensions({
      mode: "print",
      onError: error => extensionErrors.push(`${error.event}: ${error.error}`),
    });
    await session.prompt("review the project notes");
    assert.deepEqual(extensionErrors, [], "the extension ran without host errors");

    assert.ok(calls.length >= 4, `the scripted provider served the real loop (got ${calls.length} requests)`);
    const withNote = calls.map((call, index) => ({ index: index + 1, count: call.transcript.split(NOTE_MARKER).length - 1 }));
    assert.deepEqual(withNote.slice(0, 3).map(entry => entry.count), [0, 0, 0], "no provider input before the boundary carries the note");
    assert.equal(withNote[3].count, 1, `the note appears exactly once in the first input after the held tool batch (saw ${JSON.stringify(withNote)})`);
    // It is one appended transcript entry: later requests carry that same single
    // entry, never a second copy of the delivered note.
    assert.equal(withNote.slice(4).every(entry => entry.count <= 1), true, `no duplicate delivery appears later (saw ${JSON.stringify(withNote)})`);
    assert.equal(calls[0].transcript.includes(NOTE_MARKER), false, "the first request carries no note");

    // The actual received note, as the MAIN provider input carried it.
    const carryingMessages = calls[3].messages.filter(message =>
      Array.isArray(message.content) && message.content.some(block => typeof block.text === "string" && block.text.includes(NOTE_MARKER)));
    assert.equal(carryingMessages.length, 1, "exactly one actual provider message carries the note");
    const receivedNote = carryingMessages[0].content
      .filter(block => typeof block.text === "string")
      .map(block => block.text)
      .join("");
    const receivedBytes = Buffer.byteLength(receivedNote, "utf8");
    assert.equal(receivedBytes > 0 && receivedBytes <= 2048, true, `the actual received note is inside the 2048-byte default (${receivedBytes})`);
    assert.equal(receivedNote.includes("efficiency.repetition"), true, "the received note names the criterion");
    assert.equal(receivedNote.includes("This note is advisory only"), true, "the received note carries the advisory footer inside its own bound");

    // Correlated action receipts from the durable journal.
    const logDirectory = join(agentDir, "quality", "logs");
    let journalText = "";
    for (const name of await readdir(logDirectory)) {
      if (name.endsWith(".jsonl")) journalText += await readFile(join(logDirectory, name), "utf8");
    }
    const records = journalText.split(String.fromCharCode(10))
      .filter(line => line.trim().length > 0)
      .map(line => JSON.parse(line));
    const dataOf = event => records.filter(record => record.event === event).map(record => record.fields?.data ?? {});
    const admitted = dataOf("quality.action.admission").filter(entry => entry.outcome === "admitted");
    assert.equal(admitted.length, 1, "the runtime admitted exactly one action");
    const actionId = admitted[0].actionId;
    assert.match(actionId, /^action-\d+$/);
    assert.equal(admitted[0].freshness, "current", "the admitted action was current when it was admitted");
    const delivered = dataOf("quality.action.dispatched").filter(entry => entry.actionId === actionId);
    assert.equal(delivered.length, 1, "the same action identity was dispatched once");
    const receipts = dataOf("quality.action.receipt").filter(entry => entry.actionId === actionId);
    assert.equal(receipts.length >= 2, true, "the host reported more than one real receipt revision");
    // The engine observes inclusion only at a genuinely supported request
    // boundary. This harness route reaches turn_end but not the request
    // transform, so the receipt stays at its truthful dispatched strength; the
    // actual recipient input is proven by the independent capture above.
    assert.equal(receipts.at(-1).state, "dispatched", "the receipt keeps its truthful observed strength");
    assert.equal(receipts.some(entry => entry.state === "included"), false, "no unobserved inclusion is claimed");
    assert.equal(receipts.some(entry => entry.state === "queued"), true, "the delivery first reported only queued");
    const observations = dataOf("quality.feedback.observed").filter(entry => entry.actionId === actionId);
    assert.equal(observations.length === 0 || observations.at(-1).classification === "unknown", true,
      "no acknowledgment, dispute, behavior change or clearance is inferred from delivery");

    // The note itself is bounded and never contains reviewer reasoning or JSON.
    const noteLine = records.find(record => record.event === "quality.action.dispatched");
    assert.equal(typeof noteLine.fields.data.bodyDescriptor, "string");
    const noteBytes = Number(/feedback-bytes-(\d+)/u.exec(noteLine.fields.data.bodyDescriptor)?.[1] ?? "0");
    assert.equal(noteBytes > 0 && noteBytes <= 2048, true, `the dispatched note is bounded (${noteBytes} bytes)`);
    assert.equal(noteBytes, receivedBytes, "the dispatched descriptor and the actually received note agree byte for byte");
    // The bounded note body itself is not persisted: the journal carries its
    // byte descriptor and the correlated receipts, not the delivered prose.
    assert.equal(journalText.includes(NOTE_MARKER), false, "the delivered note text stays out of the diagnostic journal");
    assert.equal(journalText.includes("advisory only"), false, "no note prose is persisted in the journal");

    // The owned default status surface never carries the note body either.
    const runner = session.extensionRunner;
    const uiMessages = [];
    runner.setUIContext({ ...runner.getUIContext(), notify: message => uiMessages.push(message) }, "print");
    const command = runner.getCommand("quality");
    assert.ok(command, "the /quality command is exposed on the real runner");
    await command.handler("status", runner.createCommandContext());
    const statusText = uiMessages.at(-1) ?? "";
    assert.equal(statusText.includes(NOTE_MARKER), false, "the owned status surface does not carry the note body");
    assert.equal(JSON.parse(statusText).runtime.state, "active");

    // Actual /quality stop in this host mode: no further check is admitted and no
    // note is created by the next real run.
    await command.handler("stop", runner.createCommandContext());
    const runsBefore = JSON.parse(statusText).checks.runs;
    await session.prompt("continue after stop");
    await command.handler("status", runner.createCommandContext());
    const stoppedStatus = JSON.parse(uiMessages.at(-1));
    assert.equal(stoppedStatus.runtime.operatorStopped, true, "the actual command stop is reported");
    assert.equal(stoppedStatus.runtime.workState, "waiting-operator");
    assert.equal(stoppedStatus.checks.runs, runsBefore, "no check is admitted after the actual stop");
    // The whole-session journal (re-read after the stop) still holds exactly the
    // one admitted action the receiver already saw.
    let journalAfterStop = "";
    for (const name of await readdir(logDirectory)) {
      if (name.endsWith(".jsonl")) journalAfterStop += await readFile(join(logDirectory, name), "utf8");
    }
    const admittedAfterStop = journalAfterStop.split(String.fromCharCode(10))
      .filter(line => line.includes("quality.action.admission") && line.includes('"outcome":"admitted"'));
    assert.equal(admittedAfterStop.length, 1, "the actual stop admitted no second action");
    const afterStop = calls.slice(4).map(call => call.transcript.split(NOTE_MARKER).length - 1);
    assert.equal(afterStop.every(count => count <= 1), true,
      `the already delivered note is history, never re-appended, after the actual stop (saw ${JSON.stringify(afterStop)})`);

    // Retain the synthetic actual MAIN recipient input as bounded evidence.
    const evidenceDirectory = process.env.QE_EVIDENCE_DIR;
    if (evidenceDirectory !== undefined) {
      await mkdir(evidenceDirectory, { recursive: true });
      await writeFile(join(evidenceDirectory, "k06-main-recipient-input.json"), `${JSON.stringify({
        check: "K06 actual MAIN recipient input for the admitted feedback action",
        mode: "print (extension mode bound through bindExtensions)",
        provider: "qe-k06-scripted in-process streamSimple",
        requests: calls.length,
        carryingRequestIndex: 4,
        markerOccurrencesPerRequest: calls.map((call, index) => ({ index: index + 1, count: call.transcript.split(NOTE_MARKER).length - 1 })),
        actionId,
        receiptStates: receipts.map(entry => entry.state),
        note: {
          receivedBytes,
          sha256: createHash("sha256").update(receivedNote, "utf8").digest("hex"),
          text: receivedNote,
        },
        journalAbsent: {
          noteMarker: !journalText.includes(NOTE_MARKER),
          noteProse: !journalText.includes("advisory only"),
        },
        statusAbsent: !statusText.includes(NOTE_MARKER),
        capturedAt: new Date().toISOString(),
      }, null, 2)}
`, "utf8");
    }

    await session.dispose();
  } finally {
    delete process.env.PI_CODING_AGENT_DIR;
    await rm(root, { recursive: true, force: true });
  }
});
