import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager,
  SettingsManager, createEventBus,
} from "@earendil-works/pi-coding-agent";

// Focused regressions for the remaining reacceptance R1/R5 defects. Canonical
// C1 fixtures; every assertion is a product-boundary assertion through the built
// public extension, the real loader/runner and the event bus.

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
  const root = await mkdtemp(join(tmpdir(), "qe-k02-repair2-"));
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
  const result = endpoint.register({ id: "qa.repair2-fixture", version: "1.0.0", baseUri: "file:///qa-repair2/", resources: {}, components });
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
        // Evidence capture is best effort for a failed probe.
      }
      assert.deepEqual(host.effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 });
      await rm(host.root, { recursive: true, force: true });
    }
    results.push(row);
    console.log(`${name}: ${row.status}${row.assertion ? " — " + row.assertion : ""}`);
  }
}

test("K02-R1 provenance labels are tokenized before every diagnostic destination", { timeout: 30000 }, async () => {
  await run("R1-provenance-labels", (() => {
    const c = config([{ id: "source", use: "qa.source" }]);
    c.evaluators.repetition = { use: "qa.capture" };
    return c;
  })(), async (host, observed) => {
    const heading = "QE_PRIVATE_SECTION_HEADING_CANARY";
    const absoluteUri = "file:///qa-owner/QE_PRIVATE_ABSOLUTE_URI_CANARY.md";
    const externalRevision = "QE_PRIVATE_EXTERNAL_REVISION_CANARY";
    const body = "QE_PRIVATE_CONTEXT_BODY_CANARY";
    const sample = contextItem("section-item", "qa.source", { body }, {
      provenance: {
        sourceId: "qa.source",
        uri: absoluteUri,
        revision: externalRevision,
        acquiredAt: new Date().toISOString(),
        selection: { kind: "sections", headings: [heading] },
        changedDuringRead: false,
      },
    });
    let calls = 0;
    await register(host, [
      {
        ...meta("qa.source", "context"),
        produces: ["json"],
        async collect() {
          return { ok: true, value: { items: [sample], coverage: { state: "complete", scopeDescription: "scoped", issues: [] }, dependencies: [] } };
        },
      },
      {
        ...meta("qa.capture", "evaluator"),
        mechanism: "deterministic",
        accepts: ["json"],
        async evaluate(_options, input) {
          calls += 1;
          observed.functionalBodyPresent = JSON.stringify(input.context.items).includes(body);
          return canonicalResult();
        },
      },
    ]);
    const state = await fire(host);
    await delay(25);
    const history = JSON.stringify(state.diagnostics.recentEvents);
    const journal = await journalText(host);
    const part = state.diagnostics.recentEvents.find(record => record.event === "quality.context.manifest-part")?.fields.data;
    const item = part?.items?.[0];
    observed.tokenShape = { resourceId: item?.resourceId, revisionRef: item?.revisionRef, sectionRefs: item?.selection?.sectionRefs };
    observed.validationState = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data.validationState;
    assert.equal(calls, 1);
    assert.equal(observed.functionalBodyPresent, true, "the evaluator still receives functional evidence");
    assert.equal(observed.validationState, "valid");
    for (const canary of [heading, absoluteUri, externalRevision, body]) {
      assert.equal(history.includes(canary), false, `history leaked ${canary}`);
      assert.equal(journal.includes(canary), false, `journal leaked ${canary}`);
    }
    assert.match(String(item?.resourceId), /^(res-\d+|builtin:)/, "URI is an approved reference");
    assert.match(String(item?.revisionRef), /^(rev-\d+|sha-|obs-)/, "revision is an engine reference");
    assert.match(String(item?.selection?.sectionRefs?.[0]), /^sec-\d+$/, "section labels are opaque references");
  });
});

test("K02-R1 only issued attempt identities are accepted", { timeout: 30000 }, async () => {
  await run("R1-unissued-attempt", (() => {
    const c = config();
    c.evaluators.repetition = { use: "qa.capture" };
    return c;
  })(), async (host, observed) => {
    await register(host, [{
      ...meta("qa.capture", "evaluator"),
      mechanism: "deterministic",
      accepts: ["json"],
      async evaluate() {
        return canonicalResult({ usageAttemptIds: ["QE_UNISSUED_ATTEMPT_CANARY"] });
      },
    }]);
    const state = await fire(host);
    await delay(25);
    const result = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
    const journal = await journalText(host);
    observed.validationState = result?.validationState;
    observed.attemptRefs = result?.attemptRefs;
    assert.equal(result?.validationState, "invalid");
    assert.deepEqual(result?.attemptRefs, []);
    assert.equal(JSON.stringify(state.diagnostics.recentEvents).includes("QE_UNISSUED_ATTEMPT_CANARY"), false);
    assert.equal(journal.includes("QE_UNISSUED_ATTEMPT_CANARY"), false);
  });
});

test("K02-R1 score criteria resolve to configured check criteria", { timeout: 30000 }, async () => {
  await run("R1-score-criterion", (() => {
    const c = config();
    c.evaluators.repetition = { use: "qa.valid-score" };
    return c;
  })(), async (host, observed) => {
    await register(host, [
      {
        ...meta("qa.valid-score", "evaluator"),
        mechanism: "deterministic",
        accepts: ["json"],
        async evaluate() {
          return canonicalResult({
            scores: [{ criterion: "efficiency.repetition", kind: "numeric", value: 1, minimum: 0, maximum: 1, interpretation: "bounded", calibrationRef: null }],
          });
        },
      },
    ]);
    const state = await fire(host);
    const result = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
    observed.positiveCriterion = result?.scores?.[0]?.criterionId;
    assert.equal(result?.validationState, "valid");
    assert.equal(observed.positiveCriterion, "efficiency.repetition");
  });
});

test("K02-R1 out-of-check score criteria are rejected without leaking", { timeout: 30000 }, async () => {
  await run("R1-unrecognized-score", (() => {
    const c = config();
    c.evaluators.repetition = { use: "qa.capture" };
    return c;
  })(), async (host, observed) => {
    const canary = "QE_UNRECOGNIZED_CRITERION_CANARY";
    await register(host, [{
      ...meta("qa.capture", "evaluator"),
      mechanism: "deterministic",
      accepts: ["json"],
      async evaluate() {
        return canonicalResult({
          scores: [{ criterion: canary, kind: "numeric", value: 1, minimum: 0, maximum: 1, interpretation: "private", calibrationRef: null }],
        });
      },
    }]);
    const state = await fire(host);
    await delay(25);
    const result = state.diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data;
    const journal = await journalText(host);
    observed.validationState = result?.validationState;
    assert.equal(result?.validationState, "invalid");
    assert.equal(JSON.stringify(state.diagnostics.recentEvents).includes(canary), false);
    assert.equal(journal.includes(canary), false);
  });
});

test("K02-R1 result accessors are never invoked during admission", { timeout: 30000 }, async () => {
  await run("R1-result-getter", (() => {
    const c = config();
    c.evaluators.repetition = { use: "qa.capture" };
    return c;
  })(), async (host, observed) => {
    let reads = 0;
    const additional = contextItem("plain-additional", "qa.capture", { safe: true });
    Object.defineProperty(additional, "id", { enumerable: true, get() { reads += 1; return "getter-result-id"; } });
    await register(host, [{
      ...meta("qa.capture", "evaluator"),
      mechanism: "deterministic",
      accepts: ["json"],
      async evaluate() {
        return canonicalResult({ additionalEvidence: [additional] });
      },
    }]);
    await fire(host);
    observed.getterReads = reads;
    observed.resultState = (await host.status()).diagnostics.recentEvents.find(record => record.event === "quality.assessment.result")?.fields.data.validationState;
    assert.equal(reads, 0, "result metadata accessors are inspected, never invoked");
    assert.equal(observed.resultState, "invalid", "non-data result metadata is rejected safely");
  });
});

test("K02-R5 result schema and questions share the assessment byte budget", { timeout: 60000 }, async () => {
  for (const field of ["resultSchema", "questions"]) {
    await run(`R5-${field}-budget`, (() => {
      const c = config([{ id: "empty", use: "qa.empty" }]);
      c.contexts.recent.maxBytes = 8_192;
      c.runtime = { maxEvidenceBytes: 65_536 };
      c.prompts.repetition = { use: "qa.resources" };
      c.evaluators.repetition = { use: "qa.capture" };
      return c;
    })(), async (host, observed) => {
      const large = "QE_FUNCTIONAL_RESOURCE_CANARY_" + "q".repeat(131_072);
      const resources = {
        resourceRevision: "qa-resources-v1",
        instructions: [],
        questions: field === "questions" ? { supported: { type: "bool", instructions: large, criteria: { true: "present", false: "absent" } } } : null,
        resultSchema: field === "resultSchema" ? { type: "object", description: large, additionalProperties: false } : { type: "object", additionalProperties: false },
        criteria: ["efficiency.repetition"],
      };
      let calls = 0;
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
            observed.assessmentBytes = Buffer.byteLength(JSON.stringify(input.assessment), "utf8");
            return canonicalResult();
          },
        },
      ]);
      const state = await fire(host);
      const settled = state.diagnostics.recentEvents.find(record => record.event === "quality.check.settled")?.fields.data;
      observed.evaluatorCalls = calls;
      observed.settlement = settled;
      assert.equal(calls, 0, `oversized ${field} must decline before evaluator admission`);
      assert.notEqual(settled?.conclusion, "no-supported-finding");
      assert.equal(settled?.coverage, "insufficient");
      assert.equal(settled?.terminalReason, "core.context-overflow");
    });
  }
});

test("K02-R5 resource measurement appears in the manifest boundary", { timeout: 30000 }, async () => {
  await run("R5-resource-measured", (() => {
    const c = config([{ id: "empty", use: "qa.empty" }]);
    c.contexts.recent.maxBytes = 8_192;
    c.prompts.repetition = { use: "qa.resources" };
    c.evaluators.repetition = { use: "qa.capture" };
    return c;
  })(), async (host, observed) => {
    const resources = {
      resourceRevision: "qa-resources-small-v1",
      instructions: [],
      questions: { supported: { type: "bool", instructions: "Is the change present?", criteria: { true: "present", false: "absent" } } },
      resultSchema: { type: "object", description: "bounded canonical result", additionalProperties: false },
      criteria: ["efficiency.repetition"],
    };
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
          return canonicalResult();
        },
      },
    ]);
    const state = await fire(host);
    const manifest = state.diagnostics.recentEvents.find(record => record.event === "quality.context.manifest")?.fields.data;
    observed.evaluatorCalls = calls;
    observed.assessmentBytes = assessmentBytes;
    observed.manifestSelected = manifest?.sizes?.[0]?.utf8Bytes;
    assert.equal(calls, 1);
    assert.ok(assessmentBytes > 0);
    assert.ok((manifest?.sizes?.[0]?.utf8Bytes ?? 0) >= assessmentBytes, "the manifest describes the measured assessment boundary");
  });
});

test("K02 repair2 summary report", async () => {
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
    await writeFile(join(evidenceDir, "repair2-boundaries.json"), JSON.stringify(report, null, 2) + "\n");
  }
  assert.equal(report.failed, 0, JSON.stringify(results.filter(row => row.status === "failed")));
});
