import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager,
  SettingsManager, createEventBus,
} from "@earendil-works/pi-coding-agent";

// K02 repair boundary suite (R1-R5) through the built public extension, the real
// Pi loader/runner and the actual event bus. Component fixtures use the canonical
// C1 shapes. Every privacy/coverage assertion is kept from the rejected review
// plus explicit positive controls that prove useful notes/results still work.

const packageRoot = process.env.QE_PACKAGE_ROOT ?? process.cwd();
const extensionEntry = resolve(packageRoot, "dist/index.js");
const evidenceDir = process.env.QE_EVIDENCE_DIR;

const noop = () => {};
const delay = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms));
const results = [];
const schema = { type: "object", additionalProperties: false };
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });

function meta(id, kind) {
  return { id, kind, apiMajor: 1, optionsSchema: schema, requiredCapabilities: [], diagnosticCodes: ["qa.ready"] };
}

function jsonItem(id, sourceId, value, options = {}) {
  return {
    id,
    role: options.role ?? "evidence",
    required: options.required ?? false,
    content: [{ type: "json", value }],
    provenance: {
      sourceId,
      uri: options.uri ?? `${sourceId}:${id}`,
      revision: options.revision ?? `${id}-rev-1`,
      acquiredAt: new Date().toISOString(),
      selection: { kind: "full" },
      changedDuringRead: false,
    },
    bytes: options.bytes ?? Buffer.byteLength(JSON.stringify(value), "utf8"),
    tokenEstimate: null,
  };
}

function canonicalResult(overrides = {}) {
  return {
    operational: "completed",
    coverage: { state: "complete", scopeDescription: "bounded fixture scope", issues: [] },
    conclusion: "no-supported-finding",
    findings: [],
    scores: [],
    additionalEvidence: [],
    dependencies: [],
    usageAttemptIds: [],
    ...overrides,
  };
}

function config(providers = [{ id: "history", use: "core.history" }]) {
  return {
    schemaVersion: 1,
    enabled: true,
    mode: "observe",
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { recent: { providers } },
    evaluators: { repetition: { use: "core.repeated-tools", options: { window: 12, minimumRepeats: 3 } } },
    policies: { record: { use: "core.record-only" } },
    checks: {
      repetition: {
        triggers: [{ id: "count", use: "core.every-tools", options: { count: 5 } }],
        context: "recent",
        prompt: "repetition",
        evaluator: "repetition",
        policy: "record",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
      },
    },
  };
}

async function load(configuration) {
  const root = await mkdtemp(join(tmpdir(), "qe-k02-repair-"));
  const agentDir = join(root, "agent");
  const project = join(root, "project");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(project, { recursive: true });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configuration));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const bus = createEventBus();
  const loader = new DefaultResourceLoader({
    cwd: project,
    agentDir,
    eventBus: bus,
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
  assert.deepEqual(loaded.errors, []);
  const models = await ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(root, "models.json"),
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  const manager = SessionManager.inMemory(project);
  const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, project, manager, new ModelRegistry(models));
  const effects = { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 };
  const errors = [];
  runner.onError(error => errors.push({ event: error.event, error: error.error }));
  runner.bindCore({
    sendMessage: () => effects.sendMessage++,
    sendUserMessage: () => effects.sendUserMessage++,
    appendEntry: () => effects.appendEntry++,
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
  }, {
    getModel: () => undefined,
    getScopedModels: () => [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    getSignal: () => undefined,
    abort: () => effects.abort++,
    hasPendingMessages: () => false,
    shutdown: noop,
    getContextUsage: () => undefined,
    compact: noop,
    getSystemPrompt: () => "",
  });
  const messages = [];
  runner.setUIContext({ ...runner.getUIContext(), notify: message => messages.push(message) }, "rpc");
  const command = runner.getCommand("quality");
  assert.ok(command);
  const status = async () => {
    await command.handler("status", runner.createCommandContext());
    return JSON.parse(messages.at(-1));
  };
  await runner.emit({ type: "session_start", reason: "startup" });
  const initial = await status();
  assert.equal(initial.configuration.enabled, true, JSON.stringify(initial.configuration.rejection));
  assert.equal(initial.configuration.rejection, null);
  return { root, agentDir, runner, bus, manager, command, status, effects, errors, messages };
}

async function register(host, components, prepare) {
  let endpoint;
  host.bus.emit("quality.registry.query.v1", {
    apiMajor: 1,
    observedSessionId: host.manager.getSessionId(),
    reply: candidate => { endpoint = candidate; },
  });
  assert.ok(endpoint, "real Pi event-bus query must discover the public endpoint");
  const result = endpoint.register({
    id: "qa.repair-fixture",
    version: "1.0.0",
    baseUri: "file:///qa-repair-fixture/",
    resources: {},
    components,
    ...(prepare ? { prepare } : {}),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const ready = await result.value.ready;
  assert.equal(ready.ok, true, JSON.stringify(ready));
  return result.value;
}

async function tool(host, id, parent) {
  await host.runner.emit({
    type: "tool_execution_start",
    toolCallId: id,
    toolName: "bash",
    args: { command: "echo harmless" },
    ...(parent ? { parentToolCallId: parent } : {}),
  });
  await host.runner.emit({
    type: "tool_execution_end",
    toolCallId: id,
    toolName: "bash",
    result: { content: [{ type: "text", text: "ok" }] },
    isError: false,
    durationMs: 1,
    ...(parent ? { parentToolCallId: parent } : {}),
  });
}

async function operatorInput(host, text) {
  await host.runner.emitInput(text, undefined, "interactive");
}

async function settled(host) {
  const until = Date.now() + 4_000;
  while (Date.now() < until) {
    const state = await host.status();
    if (state.diagnostics.recentEvents.some(record => record.event === "quality.check.settled")) return state;
    await delay(10);
  }
  throw new Error("fixture check did not settle within 1500 ms");
}

async function journalText(host) {
  let text = "";
  const directory = join(host.agentDir, "quality", "logs");
  for (const file of await readdir(directory)) {
    text += await readFile(join(directory, file), "utf8");
  }
  return text;
}

async function run(name, configuration, probe) {
  let host;
  const row = { case: name, status: "running", observations: {} };
  try {
    host = await load(configuration);
    await probe(host, row.observations);
    row.status = "passed";
  } catch (error) {
    row.status = "failed";
    row.assertion = error.message;
  } finally {
    if (host) {
      await host.runner.emit({ type: "session_shutdown", reason: "quit" });
      await delay(25);
      row.effects = host.effects;
      row.extensionErrors = host.errors;
      try {
        const state = await host.status();
        row.finalState = { runtime: state.runtime, checks: state.checks, journal: state.journal };
        await writeFile(join(evidenceDir ?? host.root, `${name}.history.json`), JSON.stringify(state.diagnostics.recentEvents, null, 2) + "\n");
        await writeFile(join(evidenceDir ?? host.root, `${name}.journal.ndjson`), await journalText(host));
      } catch {
        // A failed probe may already have collected its own evidence.
      }
      assert.deepEqual(host.effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 });
      await rm(host.root, { recursive: true, force: true });
    }
    results.push(row);
    console.log(`${name}: ${row.status}${row.assertion ? " — " + row.assertion : ""}`);
  }
}

await run("R3-extension-input-authority", config(), async (host, observed) => {
  await host.runner.emitInput("QE_NON_OPERATOR_INPUT_CANARY", undefined, "extension");
  for (let index = 0; index < 5; index += 1) await tool(host, `e${index}`);
  await delay(50);
  const state = await host.status();
  observed.workState = state.runtime.workState;
  observed.runs = state.checks.runs;
  observed.suppressed = state.checks.suppressedReasons;
  assert.equal(state.runtime.workState, "unknown", "extension input must not create operator-authorized expected work");
  assert.equal(state.checks.runs, 0);
  assert.ok((state.checks.suppressedReasons["core.work-state-ineligible"] ?? 0) >= 1, "the count reason is suppressed by work-state eligibility");
});

await run("R3-nested-start-parent-retention", config(), async (host, observed) => {
  await operatorInput(host, "bounded operator task");
  for (let index = 0; index < 4; index += 1) await tool(host, `p${index}`);
  await host.runner.emit({ type: "tool_execution_start", toolCallId: "parent", toolName: "codemode", args: {} });
  await host.runner.emit({ type: "tool_execution_start", toolCallId: "child", toolName: "bash", args: {}, parentToolCallId: "parent" });
  await host.runner.emit({ type: "tool_execution_end", toolCallId: "child", toolName: "bash", result: {}, isError: false, durationMs: 1 });
  await delay(30);
  const state = await host.status();
  observed.counter = state.observation.completedPrimaryTools;
  observed.runs = state.checks.runs;
  assert.equal(state.observation.completedPrimaryTools, 4, "known nested start ownership is retained when the end parent field is absent");
  assert.equal(state.checks.runs, 0);
});

await run("R2-canonical-context-collect", config([{ id: "canonical", use: "qa.canonical" }]), async (host, observed) => {
  let calls = 0;
  await register(host, [{
    ...meta("qa.canonical", "context"),
    produces: ["json"],
    async collect() {
      calls += 1;
      return {
        ok: true,
        value: { items: [], coverage: { state: "complete", scopeDescription: "bounded empty source", issues: [] }, dependencies: [] },
      };
    },
  }]);
  await operatorInput(host, "bounded operator task");
  for (let index = 0; index < 5; index += 1) await tool(host, `c${index}`);
  const state = await settled(host);
  observed.collectCalls = calls;
  observed.contextEvents = state.diagnostics.recentEvents.filter(record => record.event.startsWith("quality.context.")).map(record => record.event);
  assert.equal(calls, 1, "C1 ContextDefinition.collect must execute");
  assert.ok(observed.contextEvents.includes("quality.context.manifest"));
});

const canonicalEvaluationConfig = config();
canonicalEvaluationConfig.evaluators.repetition = { use: "qa.canonical-evaluator" };
await run("R2-canonical-assessment-result", canonicalEvaluationConfig, async (host, observed) => {
  await register(host, [{
    ...meta("qa.canonical-evaluator", "evaluator"),
    mechanism: "deterministic",
    accepts: ["json"],
    async evaluate(_options, input) {
      observed.inputKeys = Object.keys(input).sort();
      observed.canonicalInput = {
        runId: input.run?.runId,
        snapshotItems: Array.isArray(input.context?.items),
        assessmentRevision: typeof input.assessment?.resourceRevision,
        modelProfileId: input.modelProfileId,
      };
      return canonicalResult();
    },
  }]);
  await operatorInput(host, "bounded operator task");
  for (let index = 0; index < 5; index += 1) await tool(host, `a${index}`);
  const state = await settled(host);
  const result = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
  observed.result = result;
  assert.deepEqual(observed.inputKeys, ["assessment", "context", "modelProfileId", "run"], "evaluator input uses the canonical EvaluationInput structure");
  assert.equal(result?.validationState, "valid", "valid canonical C1 result must survive validation");
  assert.equal(result?.conclusion, "no-supported-finding");
  assert.equal(result?.coverage, "complete");
});

await run("R2-o1-size-shapes", config(), async (host, observed) => {
  await operatorInput(host, "bounded operator task");
  for (let index = 0; index < 5; index += 1) await tool(host, `z${index}`);
  const state = await settled(host);
  observed.sizes = state.diagnostics.recentEvents
    .filter(record => record.event === "quality.context.source" || record.event === "quality.context.manifest")
    .flatMap(record => record.fields.data.sizes);
  const fields = ["boundary", "complete", "estimatedTokens", "lines", "unicodeScalars", "utf8Bytes"].sort();
  assert.ok(observed.sizes.length > 0, "positive measurement control");
  for (const size of observed.sizes) assert.deepEqual(Object.keys(size).sort(), fields);
  const conclusion = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data.conclusion;
  assert.ok(conclusion === "no-supported-finding" || conclusion === "findings" || conclusion === "undetermined");
});

await run("R1-component-note-admission", config([{ id: "note", use: "qa.note" }]), async (host, observed) => {
  let ctx;
  await register(host, [{
    ...meta("qa.note", "context"),
    produces: ["json"],
    async collect() {
      return { ok: true, value: { items: [], coverage: { state: "complete", scopeDescription: "note fixture", issues: [] }, dependencies: [] } };
    },
  }], async lifecycle => { ctx = lifecycle; });
  ctx.diagnostics.note({ code: "QE_PRIVATE_NOTE_CODE_CANARY", refs: ["QE_PRIVATE_NOTE_REF_CANARY"], counts: { "echo QE_PRIVATE_COUNT_KEY_CANARY": 1 } });
  ctx.diagnostics.note({ code: "qa.ready", refs: ["qa.note"], counts: { ready: 1 } });
  const state = await host.status();
  const text = JSON.stringify(state.diagnostics.recentEvents);
  observed.notes = state.diagnostics.recentEvents.filter(record => record.event === "quality.component.note").map(record => record.fields.data);
  observed.leaks = ["QE_PRIVATE_NOTE_CODE_CANARY", "QE_PRIVATE_NOTE_REF_CANARY", "QE_PRIVATE_COUNT_KEY_CANARY"].filter(value => text.includes(value));
  observed.missingIdentity = observed.notes.some(note => !note.componentId || !note.registrationId);
  const valid = observed.notes.find(note => note.code === "qa.ready");
  observed.validNote = valid ?? null;
  const disk = await journalText(host);
  observed.fileLeaks = ["QE_PRIVATE_NOTE_CODE_CANARY", "QE_PRIVATE_NOTE_REF_CANARY", "QE_PRIVATE_COUNT_KEY_CANARY"].filter(value => disk.includes(value));
  assert.deepEqual(observed.leaks, [], "undeclared code, unresolved reference and body-bearing count key must not reach history");
  assert.equal(observed.missingIdentity, false, "admitted notes carry component and registration identity");
  assert.ok(valid, "positive control: a declared valid note is admitted");
  assert.deepEqual(observed.fileLeaks, [], "the journal must not contain rejected note values");
  assert.ok(observed.notes.some(note => note.code === "core.invalid-note"), "invalid notes are represented by safe schema accounting");
});

const proseConfig = config();
proseConfig.evaluators.repetition = { use: "qa.prose" };
await run("R1-evaluator-prose-projection", proseConfig, async (host, observed) => {
  await register(host, [{
    ...meta("qa.prose", "evaluator"),
    mechanism: "deterministic",
    accepts: ["json"],
    async evaluate() {
      return canonicalResult({
        conclusion: "findings",
        findings: [{
          id: "finding-prose-1",
          criterion: "efficiency.repetition",
          status: "supported",
          severity: "concern",
          requirementRefs: [],
          evidenceIds: [],
          affectedItems: [],
          defectCode: "core.repeated-tools",
          explanation: "QE_PRIVATE_FINDING_PROSE_CANARY",
          proposedCorrection: null,
          limitations: [],
        }],
        scores: [{
          criterion: "efficiency.repetition",
          kind: "numeric",
          value: 1,
          minimum: 0,
          maximum: 1,
          interpretation: "QE_PRIVATE_SCORE_PROSE_CANARY",
          calibrationRef: null,
        }],
      });
    },
  }]);
  await operatorInput(host, "bounded operator task");
  for (let index = 0; index < 5; index += 1) await tool(host, `v${index}`);
  const state = await settled(host);
  const result = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
  const history = JSON.stringify(state.diagnostics.recentEvents);
  const disk = await journalText(host);
  observed.result = result;
  observed.proseLeaks = ["QE_PRIVATE_FINDING_PROSE_CANARY", "QE_PRIVATE_SCORE_PROSE_CANARY"]
    .filter(value => history.includes(value) || disk.includes(value));
  assert.deepEqual(observed.proseLeaks, [], "functional evaluator prose and score interpretation text are not projected");
  assert.equal(result?.validationState, "valid");
  assert.equal(result?.findings?.[0]?.defectCode, "core.repeated-tools", "positive control: finding metadata is still useful");
});

await run("R4-retired-component-note", config([{ id: "late", use: "qa.late" }]), async (host, observed) => {
  let ctx;
  await register(host, [{
    ...meta("qa.late", "context"),
    produces: ["json"],
    async collect() {
      return { ok: true, value: { items: [], coverage: { state: "complete", scopeDescription: "late fixture", issues: [] }, dependencies: [] } };
    },
  }], async lifecycle => { ctx = lifecycle; });
  await host.runner.emit({ type: "session_shutdown", reason: "quit" });
  await delay(25);
  const before = await host.status();
  await new Promise(resolvePromise => setTimeout(() => {
    ctx.diagnostics.note({ code: "qa.ready", counts: { late: 1 } });
    resolvePromise();
  }, 10));
  const after = await host.status();
  observed.signalAborted = ctx.signal.aborted;
  observed.beforeRecords = before.diagnostics.historyRecords;
  observed.afterRecords = after.diagnostics.historyRecords;
  observed.beforeLost = before.journal?.lostRecords ?? 0;
  observed.afterLost = after.journal?.lostRecords ?? 0;
  observed.lateEvents = after.diagnostics.recentEvents.slice(before.diagnostics.recentEvents.length).map(record => record.event);
  assert.equal(after.diagnostics.historyRecords, before.diagnostics.historyRecords, "retained contribution callbacks must not append after retirement/close");
  assert.equal(after.journal?.lostRecords ?? 0, before.journal?.lostRecords ?? 0, "no post-retirement journal write attempt is counted as loss");
  assert.equal(observed.signalAborted, true, "retirement revokes the contribution AbortSignal");
  assert.ok(after.diagnostics.recentEvents.some(record => record.event === "quality.runtime.retired"));
  assert.ok(after.diagnostics.recentEvents.some(record => record.event === "quality.journal.closed"));
  assert.ok(after.diagnostics.recentEvents.some(record =>
    record.event === "quality.component.lifecycle" && record.fields.data.phase === "disposed"),
  "positive control: disposal remains observable after retirement");
});

await run("R4-reload-stop-preservation", config(), async (host, observed) => {
  await operatorInput(host, "bounded operator task");
  await host.command.handler("stop", host.runner.createCommandContext());
  const stopped = await host.status();
  const priorSessionId = host.manager.getSessionId();
  await host.runner.emit({ type: "session_start", reason: "reload" });
  const reloaded = await host.status();
  observed.sameObservedSessionId = priorSessionId === host.manager.getSessionId();
  observed.before = stopped.runtime.operatorStopped;
  observed.after = reloaded.runtime.operatorStopped;
  observed.oldGeneration = stopped.runtime.generation;
  observed.newGeneration = reloaded.runtime.generation;
  assert.equal(stopped.runtime.operatorStopped, true);
  assert.equal(reloaded.runtime.operatorStopped, true, "same-session reload is not new operator authorization");
  assert.notEqual(observed.oldGeneration, observed.newGeneration);
});

await run("R5-context-byte-ceiling", (() => {
  const budget = config([{ id: "large", use: "qa.large" }]);
  budget.contexts.recent.maxBytes = 8_192;
  budget.runtime = { maxEvidenceBytes: 65_536 };
  budget.evaluators.repetition = { use: "qa.capture" };
  return budget;
})(), async (host, observed) => {
  const body = "QE_FUNCTIONAL_BUDGET_CANARY_" + "x".repeat(131_072);
  await register(host, [{
    ...meta("qa.large", "context"),
    produces: ["json"],
    async collect() {
      return {
        ok: true,
        value: {
          items: [jsonItem("large-item", "qa.large", { body }, { required: true })],
          coverage: { state: "complete", scopeDescription: "oversized fixture source", issues: [] },
          dependencies: [],
        },
      };
    },
  }, {
    ...meta("qa.capture", "evaluator"),
    mechanism: "deterministic",
    accepts: ["json"],
    async evaluate(_options, input) {
      observed.evaluatorInputBytes = Buffer.byteLength(JSON.stringify(input.context.items), "utf8");
      observed.omittedPayloadStillPresent = input.context.items.some(item =>
        item.content.some(block => block.type === "json" && block.value?.body === body));
      observed.contextCoverage = input.context.coverage.state;
      return canonicalResult({
        coverage: { state: "complete", scopeDescription: "claimed complete", issues: [] },
        conclusion: "no-supported-finding",
      });
    },
  }]);
  await operatorInput(host, "bounded operator task");
  for (let index = 0; index < 5; index += 1) await tool(host, `b${index}`);
  const state = await settled(host);
  const manifest = state.diagnostics.recentEvents.find(record => record.event === "quality.context.manifest")?.fields.data;
  const result = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
  observed.manifest = { coverage: manifest?.coverage, omittedItems: manifest?.omittedItems, sizes: manifest?.sizes };
  observed.result = result;
  assert.equal(observed.omittedPayloadStillPresent, false, "content excluded by the evidence ceiling cannot remain in evaluator input");
  assert.ok((observed.evaluatorInputBytes ?? Number.MAX_SAFE_INTEGER) <= 8_192, "the evaluator input respects the plan byte ceiling");
  assert.equal(observed.contextCoverage, "insufficient");
  assert.notEqual(result?.conclusion, "no-supported-finding", "insufficient required coverage cannot become a clean result");
  assert.equal(result?.coverage, "insufficient");
  assert.ok((manifest?.omittedItems ?? 0) >= 1, "positive control: omission metadata remains visible");
});

await run("R5-prompt-resource-budget", (() => {
  const budget = config();
  budget.contexts.recent.maxBytes = 64;
  return budget;
})(), async (host, observed) => {
  await operatorInput(host, "bounded operator task");
  for (let index = 0; index < 5; index += 1) await tool(host, `q${index}`);
  const until = Date.now() + 4_000;
  let state;
  while (Date.now() < until) {
    state = await host.status();
    if (state.diagnostics.recentEvents.some(record => record.event === "quality.check.settled")) break;
    await delay(10);
  }
  const settledRecord = state?.diagnostics.recentEvents.find(record => record.event === "quality.check.settled");
  const assessment = state?.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result");
  observed.settlement = settledRecord?.fields.data ?? null;
  observed.assessmentPresent = assessment !== undefined;
  assert.ok(settledRecord, "the check settles even when required resources do not fit");
  assert.equal(settledRecord.fields.data.coverage, "insufficient", "prompt resources count against the assembled plan budget");
  assert.equal(settledRecord.fields.data.conclusion, "undetermined");
  assert.equal(observed.assessmentPresent, false, "the run is declined before evaluation rather than sending an oversized input");
});

await run("R5-explicit-partial-operation", (() => {
  const budget = config([{ id: "large-partial", use: "qa.large-partial" }]);
  budget.contexts.recent.maxBytes = 8_192;
  budget.contexts.recent.requiredCoverage = "partial";
  budget.evaluators.repetition = { use: "qa.partial-evaluator" };
  return budget;
})(), async (host, observed) => {
  const body = "QE_PARTIAL_BUDGET_CANARY_" + "y".repeat(65_536);
  let evaluatorCalls = 0;
  await register(host, [{
    ...meta("qa.large-partial", "context"),
    produces: ["json"],
    async collect() {
      return {
        ok: true,
        value: {
          items: [jsonItem("large-partial-item", "qa.large-partial", { body }, { required: true })],
          coverage: { state: "complete", scopeDescription: "oversized partial fixture", issues: [] },
          dependencies: [],
        },
      };
    },
  }, {
    ...meta("qa.partial-evaluator", "evaluator"),
    mechanism: "deterministic",
    accepts: ["json"],
    async evaluate(_options, input) {
      evaluatorCalls += 1;
      observed.contextCoverage = input.context.coverage.state;
      return canonicalResult({ coverage: { state: "complete", scopeDescription: "claimed complete", issues: [] } });
    },
  }]);
  await operatorInput(host, "bounded operator task");
  for (let index = 0; index < 5; index += 1) await tool(host, `pp${index}`);
  const state = await settled(host);
  const result = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
  observed.evaluatorCalls = evaluatorCalls;
  observed.result = result;
  assert.equal(evaluatorCalls, 1, "explicit partial coverage still permits evaluation");
  assert.equal(observed.contextCoverage, "partial");
  assert.equal(result?.coverage, "partial", "the evaluator cannot widen committed partial coverage");
  assert.equal(result?.conclusion, "undetermined", "partial required evidence cannot become a clean conclusion");
});

await run("R2-canonical-coalescing-at-evaluator", (() => {
  const coalescing = config();
  coalescing.checks.repetition.triggers = [
    { id: "count", use: "core.every-tools", options: { count: 1 } },
    { id: "time", use: "core.periodic", options: { everyMs: 150, requireNewEvidence: false } },
  ];
  coalescing.evaluators.repetition = { use: "qa.held" };
  coalescing.runtime = { maxConcurrentEvaluations: 1, maxPendingChecks: 1 };
  return coalescing;
})(), async (host, observed) => {
  let calls = 0;
  let release = () => {};
  const held = new Promise(resolvePromise => { release = resolvePromise; });
  await register(host, [{
    ...meta("qa.held", "evaluator"),
    mechanism: "deterministic",
    accepts: ["json"],
    async evaluate() {
      calls += 1;
      if (calls === 1) await held;
      return canonicalResult();
    },
  }]);
  try {
    await operatorInput(host, "bounded operator task");
    await tool(host, "held-primary");
    const deadline = Date.now() + 3_000;
    let current;
    while (Date.now() < deadline) {
      current = await host.status();
      if (current.checks.pendingIntents === 1) break;
      await delay(10);
    }
    observed.heldCalls = calls;
    observed.pending = current.checks.pendingIntents;
    observed.admission = current.diagnostics.recentEvents
      .filter(record => record.event === "quality.check.admission")
      .map(record => record.fields.data.outcome);
    assert.equal(calls, 1, "exactly one evaluator invocation while held");
    assert.equal(current.checks.pendingIntents, 1, "at most one coalesced pending intent");
    assert.ok(observed.admission.includes("coalesced"), "the overlapping reason coalesces into the active run");
    release();
    const deadline2 = Date.now() + 1_000;
    while (Date.now() < deadline2) {
      const state = await host.status();
      if (state.checks.runs >= 2) break;
      await delay(5);
    }
    await host.command.handler("stop", host.runner.createCommandContext());
    observed.afterCalls = calls;
    assert.equal(calls, 2, "one held run plus exactly one coalesced pending run");
  } finally {
    release();
  }
});

await run("R1-component-note-getter", config([{ id: "getter", use: "qa.getter" }]), async (host, observed) => {
  let ctx;
  await register(host, [{
    ...meta("qa.getter", "context"),
    produces: ["json"],
    async collect() {
      return { ok: true, value: { items: [], coverage: { state: "complete", scopeDescription: "getter fixture", issues: [] }, dependencies: [] } };
    },
  }], async lifecycle => { ctx = lifecycle; });
  let reads = 0;
  const counts = {};
  Object.defineProperty(counts, "ready", { enumerable: true, get() { reads += 1; return 1; } });
  ctx.diagnostics.note({ code: "qa.ready", counts });
  observed.getterReads = reads;
  assert.equal(reads, 0, "diagnostic admission must reject accessors without invoking them");
});

const report = {
  runner: "real Pi 1.1.0 loader/ExtensionRunner, built public entry, actual event bus, canonical C1 fixtures",
  cases: results,
  discovered: results.length,
  executed: results.length,
  passed: results.filter(row => row.status === "passed").length,
  failed: results.filter(row => row.status === "failed").length,
  skipped: 0,
  todo: 0,
};
if (evidenceDir) {
  await mkdir(evidenceDir, { recursive: true });
  await writeFile(join(evidenceDir, "repair-boundaries.json"), JSON.stringify(report, null, 2) + "\n");
}
process.exitCode = results.every(row => row.status === "passed") ? 0 : 1;
