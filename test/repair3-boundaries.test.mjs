import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager,
  SettingsManager, createEventBus,
} from "@earendil-works/pi-coding-agent";

// Focused repair3 regressions: builtin-claim ownership, mandatory C1 result
// arrays, and final-assessment budget binding. Canonical C1 fixtures through the
// built public extension; positives prove real shipped builtin resources and
// explicit empty arrays remain useful.

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

function contextItem(id, sourceId, value, overrides = {}) {
  return {
    id,
    role: "evidence",
    required: false,
    content: [{ type: "json", value }],
    provenance: {
      sourceId,
      uri: `${sourceId}:${id}`,
      revision: "rev-1",
      acquiredAt: new Date().toISOString(),
      selection: { kind: "full" },
      changedDuringRead: false,
    },
    bytes: 1,
    tokenEstimate: null,
    ...overrides,
  };
}

function config(providers = [{ id: "history", use: "core.history" }], criteria = ["efficiency.repetition"]) {
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
        criteria,
      },
    },
  };
}

async function load(configuration) {
  const root = await mkdtemp(join(tmpdir(), "qe-k02-repair3-"));
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
  return { root, agentDir, runner, bus, manager, command, status, effects, errors, messages };
}

async function register(host, components) {
  let endpoint;
  host.bus.emit("quality.registry.query.v1", {
    apiMajor: 1,
    observedSessionId: host.manager.getSessionId(),
    reply: candidate => { endpoint = candidate; },
  });
  assert.ok(endpoint);
  const result = endpoint.register({ id: "qa.repair3-fixture", version: "1.0.0", baseUri: "file:///qa-repair3/", resources: {}, components });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal((await result.value.ready).ok, true);
  return result.value;
}

async function tool(host, id) {
  await host.runner.emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: {} });
  await host.runner.emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: {}, isError: false, durationMs: 1 });
}

async function fire(host) {
  await host.runner.emitInput("bounded operator task", undefined, "interactive");
  for (let index = 0; index < 5; index += 1) await tool(host, `t${index}`);
  const until = Date.now() + 4_000;
  while (Date.now() < until) {
    const state = await host.status();
    if (state.diagnostics.recentEvents.some(record => record.event === "quality.check.settled")) return state;
    await delay(10);
  }
  throw new Error("fixture check did not settle");
}

async function journalText(host) {
  let text = "";
  const directory = join(host.agentDir, "quality", "logs");
  for (const file of await readdir(directory)) text += await readFile(join(directory, file), "utf8");
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
        if (evidenceDir) {
          const state = await host.status();
          await writeFile(join(evidenceDir, `${name}.history.json`), JSON.stringify(state.diagnostics.recentEvents, null, 2) + "\n");
          await writeFile(join(evidenceDir, `${name}.journal.ndjson`), await journalText(host));
        }
      } catch {
        // Best-effort evidence capture.
      }
      assert.deepEqual(host.effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 });
      await rm(host.root, { recursive: true, force: true });
    }
    results.push(row);
    console.log(`${name}: ${row.status}${row.assertion ? " — " + row.assertion : ""}`);
  }
}

test("K02-R1A contributed builtin claims are verified at the artifact boundary", { timeout: 30000 }, async () => {
  for (const forged of ["prefix", "revision"]) {
    await run(`R1A-builtin-${forged}`, (() => {
      const c = config([{ id: "source", use: "qa.source" }]);
      c.evaluators.repetition = { use: "qa.capture" };
      return c;
    })(), async (host, observed) => {
      const uriCanary = "QE_PRIVATE_SPOOFED_BUILTIN_URI_CANARY";
      const revisionCanary = "QE_PRIVATE_BUILTIN_REVISION_CANARY";
      const item = contextItem("builtin-claim", "qa.source", { body: "QE_FUNCTIONAL_BODY_CONTROL" });
      item.provenance.uri = forged === "prefix" ? `builtin:${uriCanary}` : "builtin:repetition-v1.md";
      item.provenance.revision = revisionCanary;
      let calls = 0;
      await register(host, [
        {
          ...meta("qa.source", "context"),
          produces: ["json"],
          async collect() {
            return { ok: true, value: { items: [item], coverage: { state: "complete", scopeDescription: "canonical source", issues: [] }, dependencies: [] } };
          },
        },
        {
          ...meta("qa.capture", "evaluator"),
          mechanism: "deterministic",
          accepts: ["json"],
          async evaluate(_options, input) {
            calls += 1;
            observed.bodyReceived = JSON.stringify(input.context.items).includes("QE_FUNCTIONAL_BODY_CONTROL");
            return canonicalResult();
          },
        },
      ]);
      const state = await fire(host);
      await delay(25);
      const history = JSON.stringify(state.diagnostics.recentEvents);
      const journal = await journalText(host);
      const itemPart = state.diagnostics.recentEvents
        .filter(record => record.event === "quality.context.manifest-part")
        .flatMap(record => record.fields.data.items ?? [])[0];
      observed.part = { resourceId: itemPart?.resourceId, revisionRef: itemPart?.revisionRef };
      assert.equal(calls, 1);
      assert.equal(observed.bodyReceived, true);
      assert.equal(history.includes("QE_FUNCTIONAL_BODY_CONTROL"), false);
      for (const canary of [uriCanary, revisionCanary]) {
        assert.equal(history.includes(canary), false, `history leaked ${canary}`);
        assert.equal(journal.includes(canary), false, `journal leaked ${canary}`);
      }
      assert.match(String(itemPart?.revisionRef), /^rev-\d+$/, "an unverified revision becomes an opaque reference");
      if (forged === "prefix") assert.match(String(itemPart?.resourceId), /^res-\d+$/, "an unverified URI becomes an opaque reference");
    });
  }
});

test("K02-R1A the real shipped builtin resource keeps its approved identity", { timeout: 30000 }, async () => {
  await run("R1A-builtin-positive", config(), async (host, observed) => {
    const state = await fire(host);
    const manifest = state.diagnostics.recentEvents.find(record => record.event === "quality.context.manifest")?.fields.data;
    observed.resourceRefs = manifest?.resourceRefs ?? [];
    assert.ok(observed.resourceRefs.includes("builtin:repetition-v1.md"), "the genuine shipped prompt resource stays a literal approved reference");
    const result = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
    assert.equal(result?.validationState, "valid");
  });
});

test("K02-R1B absent and accessor mandatory arrays are rejected", { timeout: 30000 }, async () => {
  for (const mode of ["missing", "accessor"]) {
    await run(`R1B-required-${mode}`, (() => {
      const c = config();
      c.evaluators.repetition = { use: "qa.capture" };
      return c;
    })(), async (host, observed) => {
      let reads = 0;
      const value = canonicalResult();
      if (mode === "accessor") {
        Object.defineProperty(value, "findings", { enumerable: true, get() { reads += 1; return []; } });
      } else {
        for (const key of ["findings", "scores", "additionalEvidence", "dependencies", "usageAttemptIds"]) delete value[key];
      }
      let calls = 0;
      await register(host, [{
        ...meta("qa.capture", "evaluator"),
        mechanism: "deterministic",
        accepts: ["json"],
        async evaluate() {
          calls += 1;
          return value;
        },
      }]);
      const state = await fire(host);
      const result = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
      observed.getterReads = reads;
      observed.result = result;
      assert.equal(calls, 1);
      assert.equal(reads, 0, "mandatory result accessors are never invoked");
      assert.equal(result?.validationState, "invalid");
      assert.notEqual(result?.conclusion, "no-supported-finding");
      assert.notEqual(result?.coverage, "complete");
    });
  }
});

test("K02-R1B explicit empty arrays and complete results remain valid", { timeout: 30000 }, async () => {
  await run("R1B-empty-positive", (() => {
    const c = config();
    c.evaluators.repetition = { use: "qa.capture" };
    return c;
  })(), async (host, observed) => {
    await register(host, [{
      ...meta("qa.capture", "evaluator"),
      mechanism: "deterministic",
      accepts: ["json"],
      async evaluate() {
        return canonicalResult();
      },
    }]);
    const state = await fire(host);
    const result = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
    observed.result = result;
    assert.equal(result?.validationState, "valid");
    assert.equal(result?.coverage, "complete");
    assert.equal(result?.conclusion, "no-supported-finding");
  });
});

test("K02-R5A the dispatched assessment is exactly the measured, bound object", { timeout: 60000 }, async () => {
  const resources = {
    resourceRevision: "qa-budget-v1",
    instructions: [],
    questions: null,
    resultSchema: { type: "object", additionalProperties: false },
    criteria: [],
  };
  const resourceBytes = Buffer.byteLength(JSON.stringify(resources));
  await run("R5A-post-measure-growth", (() => {
    const c = config([{ id: "empty", use: "qa.empty" }]);
    c.contexts.recent.maxBytes = resourceBytes;
    c.prompts.repetition = { use: "qa.resources" };
    c.evaluators.repetition = { use: "qa.capture" };
    return c;
  })(), async (host, observed) => {
    let calls = 0;
    let assessmentBytes = 0;
    await register(host, [
      {
        ...meta("qa.empty", "context"),
        produces: ["json"],
        async collect() {
          return { ok: true, value: { items: [], coverage: { state: "complete", scopeDescription: "empty", issues: [] }, dependencies: [] } };
        },
      },
      { ...meta("qa.resources", "prompt"), async build() { return { ok: true, value: resources }; } },
      {
        ...meta("qa.capture", "evaluator"),
        mechanism: "deterministic",
        accepts: ["json"],
        async evaluate(_options, input) {
          calls += 1;
          assessmentBytes = Buffer.byteLength(JSON.stringify(input.assessment), "utf8");
          observed.receivedCriteria = input.assessment.criteria;
          return canonicalResult();
        },
      },
    ]);
    const state = await fire(host);
    const settlement = state.diagnostics.recentEvents.find(record => record.event === "quality.check.settled")?.fields.data;
    const manifest = state.diagnostics.recentEvents.find(record => record.event === "quality.context.manifest")?.fields.data;
    observed = Object.assign(observed, { calls, assessmentBytes, settlement });
    // Either the run declines before evaluation, or the dispatched object fits
    // the committed plan exactly; it can never grow past the measured boundary.
    assert.ok(calls === 0 || assessmentBytes <= (manifest?.sizes?.[0]?.utf8Bytes ?? 0),
      "dispatched assessment must fit the measured manifest boundary");
    if (calls === 0) {
      assert.equal(settlement?.coverage, "insufficient");
      assert.equal(settlement?.conclusion, "undetermined");
    }
  });
});

test("K02-R5A a fitting bound assessment is dispatched with check criteria counted", { timeout: 30000 }, async () => {
  await run("R5A-bound-positive", (() => {
    const c = config([{ id: "empty", use: "qa.empty" }]);
    c.contexts.recent.maxBytes = 8_192;
    c.prompts.repetition = { use: "qa.resources" };
    c.evaluators.repetition = { use: "qa.capture" };
    return c;
  })(), async (host, observed) => {
    const resources = {
      resourceRevision: "qa-budget-small-v1",
      instructions: [],
      questions: null,
      resultSchema: { type: "object", additionalProperties: false },
      criteria: [],
    };
    let assessmentBytes = 0;
    let receivedCriteria = null;
    await register(host, [
      {
        ...meta("qa.empty", "context"),
        produces: ["json"],
        async collect() {
          return { ok: true, value: { items: [], coverage: { state: "complete", scopeDescription: "empty", issues: [] }, dependencies: [] } };
        },
      },
      { ...meta("qa.resources", "prompt"), async build() { return { ok: true, value: resources }; } },
      {
        ...meta("qa.capture", "evaluator"),
        mechanism: "deterministic",
        accepts: ["json"],
        async evaluate(_options, input) {
          assessmentBytes = Buffer.byteLength(JSON.stringify(input.assessment), "utf8");
          receivedCriteria = input.assessment.criteria;
          return canonicalResult();
        },
      },
    ]);
    const state = await fire(host);
    const manifest = state.diagnostics.recentEvents.find(record => record.event === "quality.context.manifest")?.fields.data;
    observed = Object.assign(observed, { assessmentBytes, receivedCriteria, manifestBytes: manifest?.sizes?.[0]?.utf8Bytes });
    assert.deepEqual(receivedCriteria, ["efficiency.repetition"], "the check criteria are bound before dispatch");
    assert.equal(assessmentBytes, manifest?.sizes?.[0]?.utf8Bytes, "the manifest measures exactly the dispatched object");
  });
});

test("K02 repair3 summary report", async () => {
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
    await writeFile(join(evidenceDir, "repair3-boundaries.json"), JSON.stringify(report, null, 2) + "\n");
  }
  assert.equal(report.failed, 0, JSON.stringify(results.filter(row => row.status === "failed")));
});
