// K07 native witness: one preliminary suspicion admits exactly one ordinary
// `core.request-check` expert child using the real pinned `core.pi-session`
// reviewer; in paired scripted outcomes only the current supported confirmation
// produces one admitted bounded note in actual MAIN input.
//
// Real SDK MAIN session + real reviewer AgentSession via the existing
// pi-session evaluator and the in-process scripted provider. No fake session,
// no hand-emitted result, no private SDK access.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession,
} from "@earendil-works/pi-coding-agent";

const NOTE_MARKER = "[quality-advice";
const PACKAGE_ROOT = resolve(process.env.QE_PACKAGE_ROOT ?? ".");
const ORIGINAL_TASK = "Correct retryDelay(attempt) so its attempt argument is one-based; use notes.md as the original work specification.";
const WORK_REQUIREMENT = "Keep export function retryDelay(attempt) unchanged; attempts 1, 2, and 3 must return 100, 200, and 400 milliseconds, and all later positive attempts must return 400.";
const ORIGINAL_SOURCE = "export function retryDelay(attempt) { return [100, 200, 400][attempt] ?? 400; }";

// A fixture extension contributing the deterministic preliminary-suspicion
// evaluator through the engine's published public registry endpoint.
const FIXTURE_EXTENSION = `
export default function fixtureSuspicion(pi) {
  let registered = false;
  pi.events.on("quality.registry.available.v1", endpoint => {
    if (registered || typeof endpoint?.register !== "function") return;
    registered = true;
    const evaluator = {
      id: "fixture.suspected",
      apiMajor: 1,
      kind: "evaluator",
      mechanism: "deterministic",
      accepts: ["json"],
      optionsSchema: { type: "object", additionalProperties: false },
      requiredCapabilities: [],
      diagnosticCodes: ["fixture.suspected-evidence"],
      evaluate: async (_options, input) => {
        const items = input.context.items.filter(item => item.provenance.sourceId === "core.history").slice(0, 1);
        return {
          operational: "completed",
          coverage: input.context.coverage,
          conclusion: items.length > 0 ? "findings" : "no-supported-finding",
          findings: items.map(item => ({
            id: input.run.runId + ":finding-1",
            criterion: "efficiency.repetition",
            status: "suspected",
            severity: "concern",
            requirementRefs: [],
            evidenceIds: [item.id],
            affectedItems: [],
            defectCode: "fixture.suspected-drift",
            explanation: "QE_K07_HYPOTHESIS preliminary suspicion over observed work",
            proposedCorrection: null,
            limitations: ["preliminary"],
          })),
          scores: [],
          additionalEvidence: [],
          dependencies: input.context.dependencies,
          usageAttemptIds: [],
        };
      },
    };
    endpoint.register({ id: "fixture.suspected-package", version: "0.1.0", baseUri: "fixture:suspected", components: [evaluator], resources: {} });
  });
}
`;

function expertResult(confirm) {
  return {
    operational: "completed",
    coverage: { state: "complete", scopeDescription: "expert reviewed the admitted material", issues: [] },
    conclusion: confirm ? "findings" : "no-supported-finding",
    findings: confirm ? [{
      id: "expert-finding-1",
      criterion: "efficiency.repetition",
      status: "supported",
      severity: "concern",
      requirementRefs: [],
      evidenceIds: [],
      affectedItems: [],
      defectCode: "k07.expert-confirmed-drift",
      explanation: "QE_K07_EXPERT the expert confirmed the hypothesis against the current material",
      proposedCorrection: "apply the smallest correction to the named location",
      limitations: [],
    }] : [],
    scores: [],
    additionalEvidence: [],
    dependencies: [],
    usageAttemptIds: [],
  };
}

function assistantMessage(model, content, stopReason) {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}

function eventStream(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...message, content: [] } };
      yield { type: "done", reason: message.stopReason, message };
    },
    async result() { return message; },
  };
}

async function readJournal(agentDir) {
  let text = "";
  for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
    if (name.endsWith(".jsonl")) text += await readFile(join(agentDir, "quality", "logs", name), "utf8");
  }
  return text.split(String.fromCharCode(10)).filter(line => line.trim().length > 0).map(line => JSON.parse(line));
}

async function runEscalation(outcome, options = {}) {
  const root = await mkdtemp(join(tmpdir(), `qe-k07-${outcome}-`));
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.md"), `# Original retry-delay work\n\n## Original task\n${ORIGINAL_TASK}\n\n## Independent acceptance requirement\n${WORK_REQUIREMENT}\n\n## Current source under review\n\`\`\`js\n${ORIGINAL_SOURCE}\n\`\`\`\n`, "utf8");
  await writeFile(join(project, "fixture-extension.mjs"), FIXTURE_EXTENSION, "utf8");
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: options.mode ?? "advise",
    runtime: {
      boundaryWaitMs: 2_000, maxFeedbackPerEpisode: 3, maxAutonomousFollowUpsPerEpisode: 1,
      maxEscalationsPerEpisode: 2, maxEscalationDepth: 1,
    },
    permissions: {
      actions: options.actions ?? ["core.request-check", "core.feedback"],
      modelProfiles: ["scripted"],
      allowIdleContinuation: false, allowPrimaryAbort: false, maxFeedbackBytes: 2048,
    },
    modelProfiles: { scripted: { provider: "qe-k07-scripted", model: "scripted-1", price: "unknown", requiredInputs: ["text"] } },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { "recent-work": { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 4000 } },
    evaluators: {
      suspected: { use: "fixture.suspected", options: {} },
      expert: { use: "core.pi-session", modelProfile: "scripted", options: {} },
    },
    policies: {
      // The preliminary check escalates; the expert uses the same engineering
      // policy WITHOUT escalation, so the configured graph has no cycle.
      engineering: { use: "core.engineering", options: { escalateTo: "expert" } },
      "expert-engineering": { use: "core.engineering", options: {} },
      record: { use: "core.record-only" },
    },
    checks: {
      suspicion: {
        triggers: [{ id: "every-count", use: "core.every-tools", options: { count: 1 } }],
        context: "recent-work", prompt: "repetition", evaluator: "suspected", policy: "engineering",
        cooldownMs: 0, criteria: ["efficiency.repetition"],
      },
      expert: {
        triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 86_400_000, requireNewEvidence: false } }],
        context: "recent-work", prompt: "repetition", evaluator: "expert", policy: "expert-engineering",
        cooldownMs: 0, criteria: ["efficiency.repetition"],
      },
    },
    observability: {},
  }), "utf8");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const primary = [];
  const expert = [];
  let session;
  let disposed = false;
  const proofPath = process.env.QE_EVIDENCE_DIR === undefined ? null : join(process.env.QE_EVIDENCE_DIR, `k07-${outcome}-${options.mode ?? "advise"}.json`);
  let proof;
  const dispose = async () => {
    if (session === undefined || disposed) return;
    disposed = true;
    const errors = [];
    for (const action of [() => session.abort(), () => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }), () => session.dispose()]) {
      try { await action(); } catch (error) { errors.push(error); }
    }
    const locks = [];
    for (const directory of ["logs", "state"]) {
      for (const name of await readdir(join(agentDir, "quality", directory)).catch(error => { if (error.code === "ENOENT") return []; throw error; })) if (name.endsWith(".lock")) locks.push(`${directory}/${name}`);
    }
    if (proofPath !== null && proof !== undefined) await writeFile(proofPath, JSON.stringify({ ...proof, cleanup: { abortShutdownDisposeReturned: errors.length === 0, locksRemaining: locks } }, null, 2), "utf8");
    assert.deepEqual(locks, [], "installed expert/main engine owners physically released their locks");
    if (errors.length > 0) throw new AggregateError(errors, "K07 native cleanup failed");
  };
  try {
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(project, "fixture-extension.mjs"), join(PACKAGE_ROOT, "dist", "index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k07-scripted", {
      name: "K07 scripted provider", api: "qe-k07-api", apiKey: "fixture-not-credential", baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: (model, context) => {
        const messages = context.messages ?? [];
        const transcript = JSON.stringify(messages);
        const isExpert = transcript.includes("Bounded review of check expert");
        if (isExpert) {
          expert.push({ at: new Date().toISOString(), transcript });
          // First reviewer request: perform one allowed real read. Second: submit
          // the canonical expert result (confirm or reject).
          if (!transcript.includes("notes.md") || expert.length === 1) {
            return eventStream(assistantMessage(model, [{ type: "toolCall", id: "expert-read-1", name: "read", arguments: { path: "notes.md" } }], "toolUse"));
          }
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: "expert-submit-1", name: "submit_result", arguments: expertResult(outcome === "confirm") }], "toolUse"));
        }
        primary.push({ at: new Date().toISOString(), transcript });
        if (primary.length === 1) {
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: "main-read-1", name: "read", arguments: { path: "notes.md" } }], "toolUse"));
        }
        return eventStream(assistantMessage(model, [{ type: "text", text: "work continues" }], "endTurn"));
      },
      models: [{ id: "scripted-1", name: "scripted", api: "qe-k07-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65_536, maxTokens: 8_192 }],
    });
    const created = await createAgentSession({
      cwd: project, agentDir, modelRuntime: models, model: models.getModel("qe-k07-scripted", "scripted-1"),
      thinkingLevel: "off", tools: ["read"], resourceLoader: loader,
      sessionManager: SessionManager.inMemory(project), settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    });
    session = created.session;
    assert.deepEqual(created.extensionsResult.errors, []);
    const extensionErrors = [];
    await session.bindExtensions({ mode: "print", onError: error => extensionErrors.push(`${error.event}: ${error.error}`) });
    // The fixture contribution registers through the published endpoint at
    // session_start; the operator approval (public /quality reload) is what binds
    // the checks to the now-registered evaluator.
    const runner = session.extensionRunner;
    const uiMessages = [];
    runner.setUIContext({ ...runner.getUIContext(), notify: message => uiMessages.push(message) }, "print");
    const command = runner.getCommand("quality");
    assert.ok(command, "the public quality command is exposed");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 400));
    await command.handler("reload", runner.createCommandContext());
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
    await command.handler("status", runner.createCommandContext());
    const initialStatus = JSON.parse(uiMessages.at(-1));
    assert.equal(initialStatus.configuration.rejection, null, `the K07 configuration applies (${JSON.stringify(initialStatus.configuration.rejection)})`);
    assert.equal(initialStatus.checks.active >= 1, true, `the suspicion check is bound to the registered evaluator (active ${initialStatus.checks.active})`);
    await session.prompt(ORIGINAL_TASK);
    // Bounded wait for the expert child + its outcome and any admitted effect.
    const deadline = Date.now() + 30_000;
    let records = [];
    while (Date.now() < deadline) {
      records = await readJournal(agentDir);
      const expertRunIds = new Set(records.filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert").map(record => record.fields.correlation.runId));
      const expertSettled = records.some(record => record.event === "quality.check.settled" && expertRunIds.has(record.fields.correlation.runId) && record.fields?.data?.terminalReason === "evaluated");
      const preliminarySettled = records.some(record => record.event === "quality.check.settled" && record.fields?.data?.terminalReason === "evaluated");
      const feedbackDecided = records.some(record => record.event === "quality.action.admission" && record.fields?.data?.componentId === "core.feedback");
      if (options.mode === "observe" ? preliminarySettled : expertSettled && (feedbackDecided || outcome === "reject")) break;
      await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    }
    // The configured bounded turn-end wait lets the expert's ready note ride
    // this prompt's ordinary tool continuation. A new interactive prompt is a
    // new task and correctly cancels an undelivered old-task note, not a valid
    // receiver-inclusion stimulus.
    await new Promise(resolvePromise => setTimeout(resolvePromise, 300));
    records = await readJournal(agentDir);
    assert.deepEqual(extensionErrors, [], "no extension host error");
    const entryPath = join(PACKAGE_ROOT, "dist", "index.js");
    proof = { outcome, mode: options.mode ?? "advise", entryPath, entrySHA256: createHash("sha256").update(await readFile(entryPath)).digest("hex"), packageVersion: JSON.parse(await readFile(join(PACKAGE_ROOT, "package.json"), "utf8")).version, primary, expert, records };
    if (proofPath !== null) await writeFile(proofPath, JSON.stringify(proof, null, 2), { flag: "wx" });
    return {
      root, agentDir, primary, expert, records,
      expertCreates: records.filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert").length,
      suspicionCreates: records.filter(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "suspicion").length,
      admissions: records.filter(record => record.event === "quality.action.admission").map(record => record.fields?.data ?? {}),
      dispose,
    };
  } catch (error) {
    try { await dispose(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], "K07 setup/execution and cleanup failed"); }
    throw error;
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
}

test("K07-T01 native: expert confirmation produces one admitted note in MAIN input; rejection produces none", { timeout: 90_000 }, async () => {
  const assertOriginalWorkDelivered = result => {
    const textOf = message => typeof message.content === "string" ? message.content : (message.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
    const initialPrimary = JSON.parse(result.primary[0].transcript);
    assert.equal(initialPrimary.some(message => message.role === "user" && textOf(message) === ORIGINAL_TASK), true, "the meaningful original task was the actual initial primary request");
    // Inspect the real post-read expert request, not an expected object/report,
    // a filename, or the stock evaluator instruction. Notes is owned material
    // containing the original task, a distinct work constraint and source.
    const expertRequests = result.expert.map(call => JSON.parse(call.transcript));
    const delivered = expertRequests.find(messages => messages.some(message => message.role === "toolResult" && message.toolCallId === "expert-read-1"));
    assert.ok(delivered, "an actual expert provider request received the original Notes read result before submission");
    const readResult = delivered.find(message => message.role === "toolResult" && message.toolCallId === "expert-read-1");
    assert.equal(readResult.toolName, "read");
    assert.equal(readResult.isError, false);
    const readBody = textOf(readResult);
    for (const [label, fact] of [["original task", ORIGINAL_TASK], ["independent work requirement", WORK_REQUIREMENT], ["original source", ORIGINAL_SOURCE]]) {
      assert.equal(readBody.includes(fact), true, `${label} is delivered in the real expert tool result`);
    }
    assert.equal(delivered.some(message => textOf(message).includes("[hypothesis non-authoritative]")), true, "the same expert input carries the separately labeled non-authoritative hypothesis");
  };
  const confirm = await runEscalation("confirm");
  try {
    assertOriginalWorkDelivered(confirm);
    assert.equal(confirm.expertCreates, 1, "exactly one real expert child run");
    assert.equal(confirm.expert.length >= 2, true, "the real reviewer session made its own provider arrivals");
    // The expert really saw the original instruction material and the labeled,
    // non-authoritative hypothesis (never the parent's authority).
    const expertInput = confirm.expert.map(entry => entry.transcript).join(String.fromCharCode(10));
    assert.equal(expertInput.includes("QE_K07_HYPOTHESIS"), true, "the preliminary hypothesis reaches the expert input");
    assert.equal(expertInput.includes("non-authoritative"), true, "the hypothesis is explicitly labeled non-authoritative");
    assert.equal(expertInput.includes("repetition-v1.md"), true, "the original declared instruction identity reaches the expert input");
    const expertRun = confirm.records.find(record => record.event === "quality.check.started" && record.fields?.data?.checkId === "expert")?.fields?.data ?? {};
    assert.equal(expertRun.mode, "advise");
    // Exactly one escalation action admitted, and its receipt names the child run.
    const escalationAdmitted = confirm.admissions.filter(entry => entry.outcome === "admitted" && entry.componentId === "core.request-check");
    assert.equal(escalationAdmitted.length, 1, "exactly one admitted core.request-check action");
    const escalationReceipt = confirm.records
      .filter(record => record.event === "quality.action.receipt")
      .map(record => record.fields?.data ?? {})
      .filter(entry => entry.state === "queued" && typeof entry.destinationRef === "string" && entry.destinationRef.startsWith("run-"));
    assert.equal(escalationReceipt.length, 1, "the queue receipt carries the actual child run identity");
    // The confirmed result produced one admitted bounded note that reached MAIN input.
    const noteAdmitted = confirm.admissions.filter(entry => entry.outcome === "admitted" && entry.componentId === "core.feedback");
    assert.equal(noteAdmitted.length, 1, "exactly one admitted bounded note for the confirmed finding");
    const carrying = confirm.primary.filter(entry => entry.transcript.includes(NOTE_MARKER));
    assert.equal(carrying.length, 1, `the note appears in exactly one actual MAIN input (saw ${carrying.length})`);
    assert.equal(carrying[0].transcript.split(NOTE_MARKER).length - 1, 1, "the note appears once inside that input");
    // The rendered note carries the expert's confirmed defect and its smallest step.
    const noteText = carrying[0].transcript;
    assert.equal(noteText.includes("k07.expert-confirmed-drift"), true, "the confirmed expert finding's defect feeds the note");
    assert.equal(noteText.includes("apply the smallest correction to the named location"), true, "the expert's smallest step feeds the note");
    // The expert's own explanation prose stays in the assessment record, not the bounded note.
    assert.equal(noteText.includes("QE_K07_EXPERT"), false, "reviewer prose is not copied into the bounded note");
  } finally {
    await confirm.dispose();
    await rm(confirm.root, { recursive: true, force: true });
  }
  const reject = await runEscalation("reject");
  try {
    assertOriginalWorkDelivered(reject);
    assert.equal(reject.expertCreates, 1, "the rejection case also created exactly one expert");
    const noteAdmitted = reject.admissions.filter(entry => entry.outcome === "admitted" && entry.componentId === "core.feedback");
    assert.equal(noteAdmitted.length, 0, "an expert rejection produces no categorical correction");
    assert.equal(reject.primary.some(entry => entry.transcript.includes(NOTE_MARKER)), false, "no note reaches MAIN after a rejection");
  } finally {
    await reject.dispose();
    await rm(reject.root, { recursive: true, force: true });
  }
  // Observe never autonomously launches the expert.
  const observe = await runEscalation("confirm", { mode: "observe", secondPrompt: false });
  try {
    assert.equal(observe.expertCreates, 0, "observe launches no finding-caused expert");
    assert.equal(observe.admissions.filter(entry => entry.outcome === "admitted").length, 0, "observe admits no effect");
  } finally {
    await observe.dispose();
    await rm(observe.root, { recursive: true, force: true });
  }
});


// Independently selectable hosted T04 dimensions share the same settled/held
// footing, not a fabricated navigation event or an SDK statistics ledger.
for (const dimension of ["rotation", "diagnostic-loss"]) {
test(`K07-T04 native: ${dimension} preserves owned finance and Stop across older-branch navigation`, { timeout: 90_000 }, async () => {
  const deadline = Date.now() + 80_000;
  const workDeadline = deadline - 8_000;
  const output = resolve(process.env.QE_EVIDENCE_DIR ?? tmpdir());
  await mkdir(output, { recursive: true });
  const root = await mkdtemp(join(output, `qe-k07-t04-${dimension}-`));
  const sha = bytes => createHash("sha256").update(bytes).digest("hex");
  const trace = { dimension, root, phases: [], cleanup: [] };
  async function bounded(promise, label, until = workDeadline) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`T04 deadline: ${label}`)), Math.max(0, until - Date.now()));
      })]);
    } finally { clearTimeout(timer); }
  }
  async function waitFor(read, accept, label, ms = 8_000, until = workDeadline) {
    const end = Math.min(until, Date.now() + ms);
    do {
      const value = await bounded(read(), label, end);
      if (accept(value)) return value;
      await bounded(new Promise(resolvePromise => setTimeout(resolvePromise, 20)), label, end);
    } while (Date.now() < end);
    assert.fail(`T04 boundary not reached: ${label}`);
  }
  const project = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(project, "notes.md"), "# T04 material\nhosted navigation witness\n", "utf8");
  const priceA = { currency: "USD", revision: "price-A", inputPerMillion: "0.20", outputPerMillion: "0.80", cacheReadPerMillion: "0.02", cacheWritePerMillion: "0" };
  const configFor = (detail) => ({
    schemaVersion: 1, enabled: true, mode: "advise",
    runtime: { boundaryWaitMs: 0, maxConcurrentEvaluations: 2, maxRetiredUnsettledOperations: 1, defaultRunTimeoutMs: 30_000, maxRequestsPerSession: 4, maxOwnedTokensPerSession: 40_000 },
    permissions: { modelProfiles: ["scripted"] },
    modelProfiles: { scripted: { provider: "qe-k07-t04", model: "scripted-1", maxAttempts: 1, price: { ...priceA } } },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { "chat-a": { use: "core.chat", modelProfile: "scripted", options: {} } },
    policies: { record: { use: "core.record-only" } },
    checks: { storage: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-a", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
    // These are writer-opening settings. Changing only their values on reload
    // does not reopen an existing destination; 304's failed candidate did that.
    observability: {
      detail: detail === "minimal" ? "minimal" : "standard",
      journal: { enabled: true, maxFileBytes: dimension === "rotation" ? 32_768 : 1_048_576, rotationIntervalMs: dimension === "rotation" ? 1370 : null, compressArchives: false },
      retention: { maxArchivesPerSession: 32, maxAgeMs: 86_400_000, maxStorageBytes: 8_388_608 },
    },
  });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configFor("normal")), "utf8");
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const noFinding = { operational: "completed", coverage: { state: "complete", scopeDescription: "t04 hosted", issues: [] }, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };
  const state = { ownedEntered: 0, ownedReturned: 0, active: 0, heldEntered: 0, heldReturned: 0, primaryCalls: 0, primaryToolDone: false, holdCheck: false, releaseCalls: 0 };
  let resolveHold;
  const holdGate = new Promise(resolvePromise => { resolveHold = resolvePromise; });
  const releaseOnce = () => { if (state.releaseCalls === 0) { state.releaseCalls += 1; resolveHold(); } };
  let session = null;
  let journalKey = null;
  let failure = null;
  const checkpoint = async () => {
    for (const name of await readdir(join(agentDir, "quality", "state")).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      if (!name.endsWith(".json")) continue;
      const path = join(agentDir, "quality", "state", name);
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.observedSessionId === session?.sessionId && value.financial !== null) return { path, value };
    }
    return null;
  };
  const checkpointRows = async () => (await checkpoint())?.value.financial.attempts ?? [];
  try {
    const loader = new DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [join(PACKAGE_ROOT, "dist", "index.js")],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k07-t04", {
      name: "K07 T04 scripted provider", api: "qe-k07-t04-api", apiKey: "fixture-not-credential", baseUrl: "http://127.0.0.1:9/not-used",
      streamSimple: model => {
        // Separate actual routes identify owned checks without a transcript regex.
        if (model.id === "scripted-1") {
          state.ownedEntered += 1;
          const held = state.holdCheck;
          if (held) state.heldEntered += 1;
          const operation = (async () => {
            state.active += 1;
            try {
              if (held) await holdGate; // Intentionally remains physical after Stop.
              return assistantMessage(model, [{ type: "text", text: JSON.stringify(noFinding) }], "endTurn");
            } finally {
              state.active -= 1;
              state.ownedReturned += 1;
              if (held) state.heldReturned += 1;
            }
          })();
          return {
            async *[Symbol.asyncIterator]() {
              const message = await operation;
              yield { type: "start", partial: { ...message, content: [] } };
              yield { type: "done", reason: message.stopReason, message };
            },
            async result() { return operation; },
          };
        }
        assert.equal(model.id, "primary-1");
        state.primaryCalls += 1;
        if (!state.primaryToolDone) {
          state.primaryToolDone = true;
          return eventStream(assistantMessage(model, [{ type: "toolCall", id: `t04-read-${state.primaryCalls}`, name: "read", arguments: { path: "notes.md" } }], "toolUse"));
        }
        return eventStream(assistantMessage(model, [{ type: "text", text: "primary work done" }], "endTurn"));
      },
      models: ["scripted-1", "primary-1"].map(id => ({ id, name: id, api: "qe-k07-t04-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 65_536, maxTokens: 8_192 })),
    });
    const manager = SessionManager.inMemory(project);
    const older = manager.appendCustomEntry("fixture.branch", { marker: "older" });
    const newer = manager.appendCustomEntry("fixture.branch", { marker: "newer" });
    assert.equal(typeof newer, "string", "the newer branch entry has a real id");
    const created = await createAgentSession({
      cwd: project, agentDir, modelRuntime: models, model: models.getModel("qe-k07-t04", "primary-1"),
      thinkingLevel: "off", tools: ["read"], resourceLoader: loader, sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    });
    session = created.session;
    assert.deepEqual(created.extensionsResult.errors, []);
    await session.bindExtensions({ mode: "print", onError: error => { throw new Error(`${error.event}: ${error.error}`); } });
    const runner = session.extensionRunner;
    const uiMessages = [];
    runner.setUIContext({ ...runner.getUIContext(), notify: message => uiMessages.push(message) }, "print");
    const command = runner.getCommand("quality");
    assert.ok(command, "the public quality command is exposed");
    const statusNow = async () => {
      await bounded(command.handler("status", runner.createCommandContext()), "quality status");
      return JSON.parse(uiMessages.at(-1));
    };
    const reload = async config => {
      await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(config), "utf8");
      await bounded(command.handler("reload", runner.createCommandContext()), "accepted reload");
      assert.equal(uiMessages.at(-1), "Pi Quality Engine configuration applied.");
      const current = await statusNow();
      assert.equal(current.configuration.rejection, null);
      return current;
    };
    const status = await waitFor(statusNow, value => value.checks.active === 1 && value.journal?.state === "healthy", "active hosted journal/check");
    journalKey = status.journal.logicalJournalId.slice("journal-".length);
    const logicalJournalId = status.journal.logicalJournalId;
    const sessionId = manager.getSessionId();
    const originLeaf = manager.getLeafId();
    const generation = status.runtime.generation;
    const drivePrimary = async label => {
      state.primaryToolDone = false;
      await bounded(session.prompt(label), "scripted primary read/return");
    };
    await drivePrimary("first hosted work");
    const settledRow = await waitFor(async () => (await checkpointRows()).find(entry => entry.state === "settled" && entry.usageRevision >= 1), value => value !== undefined, "settled paid row");
    // Literal oracle: 120 * 0.20 / 1e6 + 30 * 0.80 / 1e6.
    assert.equal(settledRow.costAmount, "0.000048");
    assert.equal(settledRow.totalTokens, 150);
    assert.equal(settledRow.costCurrency, "USD");
    assert.equal(settledRow.price.revision, "price-A");
    assert.deepEqual(settledRow.actualRoute, { provider: "qe-k07-t04", model: "scripted-1", revision: null });
    assert.equal(state.ownedEntered, 1);
    assert.equal(state.ownedReturned, 1);
    state.holdCheck = true;
    await drivePrimary("second hosted work with a held owned check");
    await waitFor(async () => state.heldEntered, value => value === 1, "real held owned request");
    const heldRow = await waitFor(async () => (await checkpointRows()).find(entry => entry.attemptId !== settledRow.attemptId), value => value !== undefined && Number(value.reservedTokens) > 0, "held persisted reservation");
    assert.equal(state.active, 1);
    assert.equal(state.ownedEntered, 2);
    assert.equal(state.heldReturned, 0);
    await bounded(command.handler("stop", runner.createCommandContext()), "operator Stop");
    await waitFor(checkpoint, value => value?.value.operatorStopped === true, "persisted Stop");
    const baselineStatus = await waitFor(statusNow, value => value.journal.pendingRecords === 0 && value.journal.pendingBytes === 0, "baseline native record drain");
    const baseline = (await checkpoint()).value;
    const { observability: ignored, ...baselineConfig } = configFor("normal");
    const protectedFacts = value => {
      const { ledgerRevision, ...financial } = value.financial;
      return { observedSessionId: value.observedSessionId, operatorStopped: value.operatorStopped, financialUncertain: value.financialUncertain, financial, actions: value.actions };
    };
    const baselineFacts = protectedFacts(baseline);
    const logsDir = join(agentDir, "quality", "logs");
    const inventory = async () => Promise.all((await readdir(logsDir)).filter(name => !name.endsWith(".tmp")).sort().map(async name => {
      try {
        const bytes = await readFile(join(logsDir, name));
        return { name, bytes: bytes.length, sha256: sha(bytes) };
      } catch (error) {
        if (error.code === "ENOENT") return { name, unavailableDuringRotation: true };
        throw error;
      }
    }));
    const phase = async label => {
      const current = await statusNow();
      const saved = await checkpoint();
      const { observability, ...config } = JSON.parse(await readFile(join(agentDir, "quality", "config.json"), "utf8"));
      trace.phases.push({ label, elapsedMs: 80_000 - (deadline - Date.now()), checkpointPath: saved.path, checkpoint: saved.value, runtime: current.runtime, accounting: current.accounting, journal: current.journal, observation: current.observation, config, observability, leaf: manager.getLeafId(), physical: await inventory(), counters: { ...state } });
      await writeFile(join(root, "trace.json"), JSON.stringify(trace, null, 2), "utf8");
      assert.deepEqual(protectedFacts(saved.value), baselineFacts, `${label}: protected finance/actions/Stop are unchanged (revision metadata excluded)`);
      assert.deepEqual(config, baselineConfig, `${label}: grants, routes, prices and ceilings are unchanged`);
      assert.equal(current.runtime.operatorStopped, true, `${label}: public Stop remains set`);
      assert.equal(current.runtime.control.state, "healthy");
      assert.equal(current.runtime.generation, generation);
      assert.equal(state.active, 1, `${label}: transport is still physically held`);
      assert.equal(state.ownedEntered, 2, `${label}: no new owned dispatch`);
      assert.equal(state.ownedReturned, 1, `${label}: held request has not returned`);
      if (current.journal !== null) assert.equal(current.journal.logicalJournalId, logicalJournalId);
      return current;
    };
    trace.footing = { sessionId, originLeaf, older, newer, baselineStatus, settledAttemptId: settledRow.attemptId, heldAttemptId: heldRow.attemptId };
    await phase("stopped paid-plus-held baseline");
    await reload(configFor("minimal"));
    await waitFor(statusNow, value => value.journal.pendingRecords === 0 && value.journal.pendingBytes === 0, "Minimal reload native record drain");
    const minimal = await phase("accepted Minimal reload");
    assert.equal(minimal.diagnostics.detail, "minimal");
    if (dimension === "rotation") {
      const firstOrdinal = minimal.journal.activeSegment;
      let sizeRotation;
      for (let n = 0; n < 12 && sizeRotation === undefined; n += 1) {
        await drivePrimary(`ordinary rotation work ${n}`);
        await reload(configFor("minimal"));
        await waitFor(statusNow, value => value.journal.pendingRecords === 0 && value.journal.pendingBytes === 0, "ordinary work native record drain");
        sizeRotation = (await readJournal(agentDir)).find(record => record.event === "quality.journal.rotation" && record.fields.data.reason === "size" && record.fields.data.outcome === "completed" && record.fields.data.fromSegment >= firstOrdinal)?.fields.data;
      }
      assert.ok(sizeRotation, "a real size rotation occurred after the paid-plus-held baseline");
      assert.equal(sizeRotation.thresholdBytes, 32_768);
      assert.equal(sizeRotation.observedBytes > 0, true);
      const afterSize = await phase("real size rotation");
      assert.equal(afterSize.journal.activeSegment > firstOrdinal, true);
      const elapsedRotation = await waitFor(async () => (await readJournal(agentDir)).find(record => record.event === "quality.journal.rotation" && record.fields.data.reason === "elapsed" && record.fields.data.outcome === "completed" && record.fields.data.fromSegment >= sizeRotation.toSegment)?.fields.data, value => value !== undefined, "real 1370ms elapsed rotation");
      const afterElapsed = await phase("real elapsed rotation");
      assert.equal(afterElapsed.journal.activeSegment >= elapsedRotation.toSegment, true);
      for (const rotation of [sizeRotation, elapsedRotation]) {
        const name = `${journalKey}.p${String(rotation.fromSegment).padStart(8, "0")}.jsonl`;
        const bytes = await readFile(join(logsDir, name));
        assert.equal(bytes.length, rotation.observedBytes, "post-close size matches the actual physical archive");
        const records = bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
        assert.equal(records.length > 0, true);
        assert.equal(records.every(record => record.observedSessionId === sessionId), true);
      }
      trace.rotations = { size: sizeRotation, elapsed: elapsedRotation, configuredIntervalMs: 1370 };
    } else {
      const lossConfig = configFor("minimal");
      lossConfig.observability.journal.enabled = false;
      await reload(lossConfig);
      await waitFor(async () => ({ status: await statusNow(), names: await readdir(logsDir) }), value => value.status.journal === null && !value.names.includes(`${journalKey}.lock`), "disabled journal physical close");
      await phase("accepted disable and physical journal closure");
      // Matched positive: intact indexed history stays complete on a real reopen.
      await reload(configFor("minimal"));
      const intact = await waitFor(statusNow, value => value.journal?.state === "healthy" && value.journal.pendingRecords === 0, "healthy reopen with retained diagnostics");
      assert.equal(intact.journal.historyCoverage, "complete");
      await phase("intact indexed diagnostics reopen as complete");
      await reload(lossConfig);
      await waitFor(async () => ({ status: await statusNow(), names: await readdir(logsDir) }), value => value.status.journal === null && !value.names.includes(`${journalKey}.lock`), "second disabled journal physical close");
      await phase("closed again before deliberate diagnostic removal");
      const indexPath = join(logsDir, `${journalKey}.journal-index.json`);
      const indexBytes = await readFile(indexPath);
      const index = JSON.parse(indexBytes);
      const removed = [];
      await mkdir(join(root, "removed-diagnostics"));
      for (const segment of index.segments) {
        assert.equal(segment.compressed, false);
        const name = `${journalKey}.p${String(segment.ordinal).padStart(8, "0")}.jsonl`;
        const bytes = await readFile(join(logsDir, name));
        const records = bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line));
        assert.equal(records.every(record => record.observedSessionId === sessionId), true, "delete only this owner's known diagnostic segment");
        await writeFile(join(root, "removed-diagnostics", name), bytes, { flag: "wx" });
        removed.push({ name, bytes: bytes.length, sha256: sha(bytes), ordinal: segment.ordinal });
        await rm(join(logsDir, name));
      }
      assert.equal(removed.length > 0, true, "diagnostic loss is non-vacuous");
      assert.equal(sha(await readFile(indexPath)), sha(indexBytes), "diagnostic index was not removed or modified");
      assert.equal((await readdir(join(agentDir, "quality", "state"))).includes(`${journalKey}.lock`), true, "functional ownership remains live");
      assert.deepEqual((await readdir(logsDir)).filter(name => name.endsWith(".jsonl")), []);
      trace.removedDiagnostics = removed;
      await phase("known diagnostic segments removed; index/control untouched");
    }
    // The public SDK call changes the actual leaf. There is no fabricated
    // session_start and no replacement EngineSession; origin rows remain old.
    const beforeNavigation = { sessionId: manager.getSessionId(), leaf: manager.getLeafId() };
    assert.notEqual(beforeNavigation.leaf, older);
    const navigation = await bounded(session.navigateTree(older, { summarize: false }), "older non-user branch navigation");
    assert.equal(navigation.cancelled, false);
    assert.equal(manager.getLeafId(), older);
    assert.equal(manager.getSessionId(), sessionId);
    trace.navigation = { before: beforeNavigation, after: { sessionId: manager.getSessionId(), leaf: manager.getLeafId() }, result: navigation };
    await phase("actual older-branch navigateTree");
    if (dimension === "diagnostic-loss") {
      await reload(configFor("minimal"));
      const reopened = await waitFor(statusNow, value => value.journal?.state === "healthy" && value.journal.pendingRecords === 0, "reenabled physical journal");
      assert.equal(reopened.journal.logicalJournalId, logicalJournalId);
      assert.equal(reopened.journal.activeSegment > Math.max(...trace.removedDiagnostics.map(segment => segment.ordinal)), true);
      assert.equal((await readFile(join(logsDir, `${journalKey}.jsonl`))).length > 0, true);
      await phase("journal reenabled after diagnostic loss");
      assert.equal(reopened.journal.historyCoverage, "partial", "known missing diagnostics cannot become complete history on reopen");
    }
    await bounded(command.handler("pause", runner.createCommandContext()), "observer pause");
    assert.equal((await statusNow()).runtime.observerPaused, true);
    await phase("observer paused without clearing Stop");
    await bounded(command.handler("resume", runner.createCommandContext()), "observer resume");
    assert.equal((await statusNow()).runtime.observerPaused, false);
    const toolsBefore = (await statusNow()).observation.completedPrimaryTools;
    await drivePrimary("useful primary read after resume with Stop still set");
    const resumed = await phase("observer resumed; primary remains usable; Stop still set");
    assert.equal(resumed.observation.completedPrimaryTools, toolsBefore + 1);
    releaseOnce();
    await waitFor(async () => ({ ...state }), value => value.active === 0 && value.heldReturned === 1 && value.ownedReturned === 2, "actual raw held request return");
    assert.equal(state.releaseCalls, 1);
    const finalRows = await checkpointRows();
    assert.deepEqual(finalRows.find(entry => entry.attemptId === settledRow.attemptId), settledRow, "prior charged row is never repriced/replayed");
    trace.result = "AUTHOR_PASS";
  } catch (error) {
    failure = error;
    trace.result = "FAIL";
    trace.failure = { name: error.name, message: error.message, code: error.code ?? null };
  } finally {
    releaseOnce();
    const cleanupErrors = [];
    const clean = async (label, action) => {
      try { await bounded(action(), label, deadline); trace.cleanup.push({ label, returned: true }); }
      catch (error) { cleanupErrors.push(error); trace.cleanup.push({ label, returned: false, message: error.message }); }
    };
    if (session !== null) {
      await clean("host abort returned", () => session.abort());
      await clean("raw provider physical drain", () => waitFor(async () => state.active, value => value === 0, "raw provider physical drain", 8_000, deadline));
      await clean("engine shutdown returned", () => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
      await clean("normal journal/control lock release", () => waitFor(async () => {
        const logs = await readdir(join(agentDir, "quality", "logs"));
        const controls = await readdir(join(agentDir, "quality", "state"));
        return { logs, controls };
      }, value => !value.logs.some(name => name.endsWith(".lock")) && !value.controls.some(name => name.endsWith(".lock")), "normal journal/control lock release", 8_000, deadline));
      await clean("SDK session disposed", async () => session.dispose());
      await clean("final canonical state and physical JSONL inspected", async () => {
        trace.finalCheckpoint = (await checkpoint())?.value ?? null;
        trace.finalJournalRecords = await readJournal(agentDir);
        if (failure === null) {
          assert.equal(trace.finalCheckpoint.operatorStopped, true);
          assert.equal(trace.finalCheckpoint.financial.ownedRequestCount, 2);
          assert.equal(trace.finalCheckpoint.financial.knownCostByCurrency.USD, "0.000096", "released valid usage settles the two existing calls exactly once");
          assert.equal(trace.finalCheckpoint.financial.reservedTokens, 0);
          assert.equal(state.active, 0);
          assert.equal(state.heldReturned, 1);
          assert.equal(state.releaseCalls, 1);
        }
      });
    }
    trace.counters = { ...state };
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    if (cleanupErrors.length > 0) {
      trace.result = "FAIL";
      failure = new AggregateError(failure === null ? cleanupErrors : [failure, ...cleanupErrors], "T04 experiment/cleanup failures");
    }
    await writeFile(join(root, "trace.json"), JSON.stringify(trace, null, 2), "utf8");
    console.log(JSON.stringify({ dimension, root, result: trace.result, counters: trace.counters, cleanup: trace.cleanup }));
  }
  if (failure !== null) throw failure;
});
}
