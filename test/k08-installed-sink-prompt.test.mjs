// K08-B.06/B.07/T02/T04: real installed static prompt delivery and projected
// sink isolation/pressure. Public C1 receiver + scripted SDK provider are
// measurement instrumentation, not live semantic usefulness or an OS sandbox.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const TASK_DOCUMENT = "K08_TASK_SOURCE_CANARY\nCorrect retryDelay(attempt) as a one-based bounded retry delay; assess the original requirements without modifying them.\n";
const REQUIREMENT_DOCUMENT = "K08_REQUIREMENT_SOURCE_CANARY\nKeep export function retryDelay(attempt); attempts 1, 2, 3 return 100, 200, 400 milliseconds, and all later positive attempts return 400. Repeated inspection alone is not a defect.\n";
const PACKAGE_ID = "fixture.independent-extension", RECEIVER_ID = "fixture.resource-receiver";
const SINK_IDS = ["fixture.mutating-sink", "fixture.projected-sink", "fixture.stalled-sink"];
const MUTATION = "K08_MUTATOR_ONLY";
const SCENARIOS = ["prompt-pair", "sink-isolation", "sink-unselected"];
const sorted = value => Array.isArray(value) ? value.map(sorted) : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const fingerprint = value => sha(JSON.stringify(sorted(value)));
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
const identity = async path => { const bytes = await readFile(path); return { bytes: bytes.length, sha256: sha(bytes) }; };
const json = async path => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + "\n", "utf8");
const inside = (root, path) => { const name = relative(root, path); return name !== ".." && !name.startsWith("..\\") && !name.startsWith("../") && !isAbsolute(name); };

function isolatedEnvironment(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "SYSTEMDRIVE"].includes(key)));
  Object.assign(env, {
    HOME: join(root, "home"), USERPROFILE: join(root, "home"), APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"), PI_CODING_AGENT_DIR: join(root, "agent"),
    TMPDIR: join(root, "tmp"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"),
    GIT_CEILING_DIRECTORIES: root, GIT_CONFIG_GLOBAL: join(root, "empty.gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0",
    npm_config_userconfig: join(root, "user.npmrc"), npm_config_globalconfig: join(root, "global.npmrc"), npm_config_cache: join(root, "npm-cache"), npm_config_offline: "true",
  });
  return env;
}

async function prepareEnvironment(root) {
  const env = isolatedEnvironment(root);
  for (const key of ["HOME", "APPDATA", "LOCALAPPDATA", "PI_CODING_AGENT_DIR", "TMP", "npm_config_cache"]) await mkdir(env[key], { recursive: true });
  for (const name of ["empty.gitconfig", "user.npmrc", "global.npmrc"]) await writeFile(join(root, name), "", "utf8");
  return env;
}

// Actual exit, native close and both pipe ends are distinct from an assertion.
async function runNative(out, command, cwd, env, timeoutMs = 20_000) {
  await mkdir(out, { recursive: true });
  const receipt = { command, cwd, environmentKeys: Object.keys(env).sort(), timeoutMs, startUtc: new Date().toISOString() };
  await save(join(out, "command.json"), receipt);
  let stdout = "", stderr = "", stdoutEnd = false, stderrEnd = false, nativeExit = null, timedOut = false, spawnError = null;
  const started = performance.now();
  const child = spawn(command[0], command.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", bytes => { stdout += String(bytes); });
  child.stderr.on("data", bytes => { stderr += String(bytes); });
  child.stdout.once("end", () => { stdoutEnd = true; });
  child.stderr.once("end", () => { stderrEnd = true; });
  child.once("exit", (code, signal) => { nativeExit = { code, signal }; });
  child.once("error", error => { spawnError = error.code; });
  const timer = setTimeout(() => {
    timedOut = true;
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { env, stdio: "ignore" });
      killer.on("error", () => {});
    } else child.kill("SIGKILL");
  }, timeoutMs);
  const closed = await new Promise(resolvePromise => child.once("close", (code, signal) => resolvePromise({ code, signal })));
  clearTimeout(timer);
  Object.assign(receipt, { pid: child.pid, exit: closed.code, signal: closed.signal, nativeExit, stdoutEnd, stderrEnd, timedOut, spawnError, elapsedMs: performance.now() - started });
  await writeFile(join(out, "stdout.txt"), stdout, "utf8");
  await writeFile(join(out, "stderr.txt"), stderr, "utf8");
  await save(join(out, "exit.json"), receipt);
  assert.equal(spawnError, null, "the actual native child starts");
  assert.equal(timedOut, false, "an outer timeout is not a successful operation");
  assert.deepEqual(nativeExit, closed, "native exit and close both returned");
  assert.equal(stdoutEnd && stderrEnd, true, "both native pipes ended");
  return { receipt, stdout, stderr };
}

function tarInventory(bytes) {
  const tar = gunzipSync(bytes), files = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const field = (start, end) => header.subarray(start, end).toString("utf8").replace(/\0.*$/su, "");
    const prefix = field(345, 500), name = (prefix ? prefix + "/" : "") + field(0, 100);
    const size = Number.parseInt(field(124, 136).trim() || "0", 8), kind = field(156, 157);
    assert.ok(Number.isSafeInteger(size) && size >= 0);
    assert.ok(name.startsWith("package/") && !name.split("/").includes(".."));
    if (kind !== "5") {
      assert.ok(kind === "" || kind === "0", "no archive links or nonregular payloads");
      const body = tar.subarray(offset + 512, offset + 512 + size);
      assert.equal(body.length, size);
      files[name.slice(8)] = { bytes: size, sha256: sha(body) };
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

const npmCommand = (...args) => {
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  assert.equal(existsSync(cli), true, "use the existing npm CLI shipped with the selected native Node");
  return [process.execPath, cli, ...args];
};

async function packageInputs(source) {
  const manifest = await json(join(source, "package.json"));
  assert.deepEqual(manifest.files, ["dist", "resources", "examples", "README.md", "THIRD_PARTY_NOTICES.md"], "copy only the declared public package surface, never a checkout snapshot");
  const payload = {};
  const visit = async name => {
    for (const entry of await readdir(join(source, name), { withFileTypes: true })) {
      const path = join(name, entry.name);
      assert.equal(entry.isSymbolicLink(), false, "published inputs cannot escape through a link");
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) payload[path.replaceAll("\\", "/")] = await identity(join(source, path));
    }
  };
  for (const name of ["package.json", "README.md", "THIRD_PARTY_NOTICES.md"]) payload[name] = await identity(join(source, name));
  await visit("dist"); await visit("resources"); await visit("examples");
  const peer = await realpath(join(source, "node_modules", "@earendil-works", "pi-coding-agent"));
  const yaml = await realpath(join(source, "node_modules", "yaml"));
  const sdkManifest = await json(join(peer, "package.json")), yamlManifest = await json(join(yaml, "package.json"));
  assert.equal(sdkManifest.version, manifest.devDependencies["@earendil-works/pi-coding-agent"]);
  assert.equal(yamlManifest.version, manifest.dependencies.yaml);
  return { payload, hostSdk: { path: peer, version: sdkManifest.version, metadata: await identity(join(peer, "package.json")) }, existingYaml: { path: yaml, version: yamlManifest.version, metadata: await identity(join(yaml, "package.json")) } };
}

async function packedChild(options) {
  const { root, consumer, scenario, mirror } = options;
  assert.equal(existsSync(mirror), false);
  process.env.GIT_CEILING_DIRECTORIES = dirname(consumer);
  const report = { scenario, root, consumer, evaluations: [], providerCalls: [], receiverReady: [], reads: [], snapshots: [], phases: [], errors: [], effects: { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 }, cleanup: [] };
  let runner = null, status = null, stopped = false, failure = null;
  const until = async (read, accept, label) => { const end = Date.now() + 5000; do { const value = await read(); if (accept(value)) return value; await new Promise(done => setTimeout(done, 10)); } while (Date.now() < end); throw new Error("K08 sink/prompt deadline: " + label); };
  const files = async dir => { const out = []; if (!existsSync(dir)) return out; for (const item of await readdir(dir, { withFileTypes: true })) { const p = join(dir, item.name); if (item.isDirectory()) out.push(...await files(p)); else if (item.isFile()) out.push(p); } return out; };
  const lines = async p => existsSync(p) ? (await readFile(p, "utf8")).split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  const sinkPaths = Object.fromEntries(SINK_IDS.map(id => [id, join(root, id + ".jsonl")])); report.sinkPaths = sinkPaths;
  try {
    const engine = join(consumer, "node_modules", "pi-quality-engine"), contribution = join(consumer, "node_modules", "qe-independent-fixture"), project = consumer, agentDir = process.env.PI_CODING_AGENT_DIR;
    const contract = import.meta.resolve("pi-quality-engine/contracts"); assert.equal(await realpath(fileURLToPath(contract)), await realpath(join(engine, "dist/contracts.js")));
    const before = await files(agentDir); await import("pi-quality-engine/contracts"); assert.deepEqual(await files(agentDir), before); report.publicContracts = { url: contract, ...await identity(fileURLToPath(contract)), inert: true };
    const sdk = await import("@earendil-works/pi-coding-agent"); report.sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    await mkdir(join(agentDir, "quality"), { recursive: true });
    const taskName = scenario + "-task.md", requirementsName = scenario + "-requirements.md";
    await writeFile(join(project, taskName), TASK_DOCUMENT, "utf8"); await writeFile(join(project, requirementsName), REQUIREMENT_DOCUMENT, "utf8");
    report.originalSources = { task: { path: join(project, taskName), ...await identity(join(project, taskName)) }, requirements: { path: join(project, requirementsName), ...await identity(join(project, requirementsName)) } };
    const replacementPath = join(contribution, "resources/k08-prompt.md"), replacementText = await readFile(replacementPath, "utf8"), originalText = await readFile(join(engine, "resources/prompts/repetition-v1.md"), "utf8");
    const deployedPath = join(project, scenario + "-selected-k08-prompt.md");
    // Explicitly install this one PUBLIC data resource into the operator's
    // permitted file-resource area before either phase. No protected directory
    // permission is relaxed; no checkout source is used as a fallback.
    await copyFile(replacementPath, deployedPath); assert.deepEqual(await identity(deployedPath), await identity(replacementPath));
    report.resources = { original: { uri: "builtin:repetition-v1.md", text: originalText, ...await identity(join(engine, "resources/prompts/repetition-v1.md")) }, replacement: { uri: pathToFileURL(deployedPath).href, text: replacementText, ...await identity(deployedPath), installedArtifactSource: { path: replacementPath, ...await identity(replacementPath) }, deployment: "Exact one-file public resource deployment from installed tar payload into permitted project file surface before both paired phases; direct node_modules resource reads are not claimed." } };
    const selectedSinks = scenario !== "sink-isolation" ? [] : [
      { id: SINK_IDS[0], options: { destination: pathToFileURL(sinkPaths[SINK_IDS[0]]).href, mutate: true } },
      { id: SINK_IDS[1], options: { destination: pathToFileURL(sinkPaths[SINK_IDS[1]]).href } },
      { id: SINK_IDS[2], options: { destination: pathToFileURL(sinkPaths[SINK_IDS[2]]).href, stallMs: 800 } },
    ];
    const config = {
      schemaVersion: 1, enabled: true, mode: "observe", observability: { detail: "trace", sinks: selectedSinks },
      modelProfiles: { scripted: { provider: "qe-k08-resource", model: "resource-1", maxOutputTokens: 512, price: "unknown" } }, permissions: { modelProfiles: ["scripted"] },
      sources: { task: { uris: ["project:" + taskName], role: "evidence", required: true }, requirements: { uris: ["project:" + requirementsName], role: "requirement", required: true } },
      prompts: { assess: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "originals", use: "core.files", options: { sourceIds: ["task", "requirements"] } }, { id: "note", use: "fixture.note" }] } },
      evaluators: { receiver: { use: RECEIVER_ID, modelProfile: "scripted" } }, policies: { record: { use: "core.record-only" } },
      checks: { assessment: { triggers: [{ id: "reads", use: "fixture.burst-tools", options: { count: 2 } }], context: "work", prompt: "assess", evaluator: "receiver", policy: "record", cooldownMs: 0, maxRunsPerEpisode: scenario === "prompt-pair" ? 2 : 1, criteria: ["efficiency.repetition"], workStates: ["work-expected"] } },
    };
    report.initialConfig = structuredClone(config); await save(join(agentDir, "quality/config.json"), config);
    const paths = [];
    for (const dir of [engine, contribution]) { const manifest = await json(join(dir, "package.json")); const entry = resolve(dir, manifest.pi.extensions[0]); assert.equal(inside(dir, entry), true); paths.push(entry); }
    const factory = pi => {
      let handle = null, unsubscribe = null, sessionId = null;
      const register = endpoint => {
        if (!endpoint || endpoint.observedSessionId !== sessionId || handle !== null) return;
        const accepted = endpoint.register({ id: "fixture.resource-receiver-package", version: "0.1.0", baseUri: new URL(".", import.meta.url).href, resources: {}, components: [{
          id: RECEIVER_ID, apiMajor: 1, kind: "evaluator", mechanism: "direct-model", accepts: ["text", "json"], requiredCapabilities: [], diagnosticCodes: [], optionsSchema: { type: "object", additionalProperties: false },
          async evaluate(_opts, input, ctx) {
            const observed = { input: structuredClone(input) }; report.evaluations.push(observed);
            assert.ok(input.modelProfileId);
            const response = await ctx.services.request({ runId: input.run.runId, profileId: input.modelProfileId, kind: "chat", context: input.context, assessment: input.assessment, maxOutputTokens: 512 }, ctx.signal);
            observed.response = structuredClone(response); assert.equal(response.ok, true);
            const result = typeof response.value.output === "string" ? JSON.parse(response.value.output) : response.value.output;
            return { ...result, usageAttemptIds: [...response.value.attemptIds] };
          },
        }] });
        assert.equal(accepted.ok, true); handle = accepted.value; handle.ready.then(value => report.receiverReady.push({ ok: value.ok, registrationId: handle.registrationId }));
      };
      pi.on("session_start", (_event, ctx) => { sessionId = ctx.sessionManager.getSessionId(); unsubscribe = pi.events.on("quality.registry.available.v1", register); pi.events.emit("quality.registry.query.v1", { apiMajor: 1, observedSessionId: sessionId, reply: register }); });
      pi.on("session_shutdown", async () => { unsubscribe?.(); if (handle !== null) { await handle.ready; await handle.dispose(); } });
    };
    const loader = new sdk.DefaultResourceLoader({ cwd: project, agentDir, settingsManager: sdk.SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: paths, extensionFactories: [factory] });
    await loader.reload(); const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
    const models = await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k08-resource", { name: "bounded resource receiver", api: "qe-k08-resource-api", apiKey: "fixture-not-credential", baseUrl: "http://127.0.0.1:9/not-used", models: [{ id: "resource-1", name: "scripted", api: "qe-k08-resource-api", input: ["text"], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }], streamSimple(model, context) {
      const actual = structuredClone(context), text = actual.messages.flatMap(message => typeof message.content === "string" ? [message.content] : message.content.filter(part => part.type === "text").map(part => part.text)).join("\n");
      const originalsPresent = text.includes(TASK_DOCUMENT) && text.includes(REQUIREMENT_DOCUMENT), replacement = text.includes(replacementText), original = text.includes(originalText), complete = originalsPresent && (replacement || original);
      const result = { operational: "completed", coverage: { state: complete ? "complete" : "insufficient", scopeDescription: "Scripted resource delivery, not engineering usefulness.", issues: [] }, conclusion: complete ? "no-supported-finding" : "undetermined", findings: [], scores: complete && replacement ? [{ criterion: "efficiency.repetition", kind: "ordinal", value: 1, minimum: 0, maximum: 1, interpretation: "Original-document presence, not confidence or quality.", calibrationRef: null }] : [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };
      report.providerCalls.push({ model: { provider: model.provider, id: model.id }, context: actual, actualText: text, originalsPresent, replacement, original, result });
      const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify(result) }], api: model.api, provider: model.provider, model: model.id, usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }, stopReason: "stop", timestamp: Date.now() };
      return { async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "text_start", contentIndex: 0, partial: message }; yield { type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message }; yield { type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message }; yield { type: "done", reason: "stop", message }; }, async result() { return message; } };
    } });
    runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, project, sdk.SessionManager.inMemory(project), new sdk.ModelRegistry(models));
    const noop = () => {}, messages = [], effects = report.effects;
    runner.bindCore({ sendMessage: () => { effects.sendMessage += 1; }, sendUserMessage: () => { effects.sendUserMessage += 1; }, appendEntry: () => { effects.appendEntry += 1; }, setSessionName: noop, getSessionName: () => undefined, setLabel: noop, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: noop, getThinkingLevel: () => "off", setThinkingLevel: noop }, { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, abort: () => { effects.abort += 1; }, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => "" });
    runner.setUIContext({ ...runner.getUIContext(), notify: message => messages.push(message) }, "rpc"); runner.onError(error => report.errors.push({ event: error.event, error: String(error.error) }));
    const command = runner.getCommand("quality"); status = async () => { await command.handler("status", runner.createCommandContext()); return JSON.parse(messages.at(-1)); };
    await runner.emit({ type: "session_start", reason: "startup" });
    report.ready = await until(status, value => report.receiverReady.length === 1 && value.checks.detail[0]?.state === "active", "selected installed contributions ready"); report.snapshots.push(report.ready); assert.equal(report.ready.configuration.rejection, null);
    await runner.emitInput("Use the original task and requirement documents without changing their authority.", undefined, "interactive");
    const tool = sdk.createReadTool(project);
    const read = async (id, path) => { const args = { path }; await runner.emit({ type: "tool_execution_start", toolCallId: id, toolName: "read", args }); const result = await tool.execute(id, args, new AbortController().signal); report.reads.push({ id, path, result }); await runner.emit({ type: "tool_execution_end", toolCallId: id, toolName: "read", result, isError: false, durationMs: 1 }); };
    const phase = async (label, count) => { await read(label + "-task", taskName); await read(label + "-requirements", requirementsName); const settled = await until(status, value => { const runId = report.evaluations[count - 1]?.input.run.runId; return typeof runId === "string" && value.diagnostics.recentEvents.some(event => event.event === "quality.check.settled" && event.fields.correlation.runId === runId); }, "actual " + label + " settlement"); report.snapshots.push(settled); report.phases.push({ label, status: settled, evaluations: report.evaluations.length, providers: report.providerCalls.length }); };
    await phase("original", 1);
    if (scenario === "prompt-pair") {
      config.prompts.assess.options.instructions = [report.resources.replacement.uri]; report.replacementConfig = structuredClone(config); await save(join(agentDir, "quality/config.json"), config); await command.handler("reload", runner.createCommandContext()); report.afterReload = await status(); report.snapshots.push(report.afterReload); assert.equal(report.afterReload.configuration.rejection, null);
      await phase("replacement", 2);
    }
    if (scenario === "sink-isolation") {
      for (let n = 0; n < 96; n += 1) await read("pressure-" + n, n % 2 ? taskName : requirementsName);
      report.duringPressure = await status(); report.snapshots.push(report.duringPressure);
      report.stallEntryBeforeDrain = await lines(sinkPaths[SINK_IDS[2]] + ".entries.jsonl"); report.healthyBeforeDrain = await lines(sinkPaths[SINK_IDS[1]]); report.stalledBeforeDrain = await lines(sinkPaths[SINK_IDS[2]]);
      await until(async () => { const rows = await lines(sinkPaths[SINK_IDS[1]]); return rows; }, rows => rows.some(row => row.before.event === "quality.check.settled"), "healthy sink useful settlement delivery");
      assert.ok(report.stallEntryBeforeDrain.length > 0, "the stalled callback actually entered");
    }
    await runner.emit({ type: "session_shutdown", reason: "quit" }); stopped = true; report.retired = await status(); report.snapshots.push(report.retired);
    assert.deepEqual(await identity(join(project, taskName)), { bytes: report.originalSources.task.bytes, sha256: report.originalSources.task.sha256 }); assert.deepEqual(await identity(join(project, requirementsName)), { bytes: report.originalSources.requirements.bytes, sha256: report.originalSources.requirements.sha256 });
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message }; }
  finally {
    if (runner !== null && !stopped) { try { await runner.emit({ type: "session_shutdown", reason: "quit" }); stopped = true; report.cleanup.push({ shutdownReturned: true }); } catch (error) { report.cleanup.push({ shutdownReturned: false, message: error.message }); failure ??= error; } }
    if (stopped && status !== null && report.retired === undefined) { try { report.retired = await status(); report.snapshots.push(report.retired); } catch (error) { failure ??= error; } }
    if (runner !== null) runner.invalidate("K08 owned sink/prompt case ended"); report.shutdownReturned = stopped;
    const stateFiles = await files(process.env.PI_CODING_AGENT_DIR); report.finalStateFiles = stateFiles; report.remainingLocks = stateFiles.filter(p => p.endsWith(".lock"));
    const journal = (await Promise.all(stateFiles.filter(p => /\.jsonl(?:\.gz)?$/u.test(p)).map(async p => { const bytes = await readFile(p); return (p.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"); }))).join("\n");
    const physical = journal.split("\n").filter(Boolean).map(line => JSON.parse(line));
    report.events = [...new Map([...physical, ...report.snapshots.flatMap(value => value?.diagnostics.recentEvents ?? [])].map(event => [event.eventId, event])).values()];
    report.canonical = report.events.filter(row => row.event === "quality.assessment.result"); report.settled = report.events.filter(row => row.event === "quality.check.settled"); report.health = report.events.filter(row => row.event === "quality.sink.health"); report.gaps = report.events.filter(row => row.event === "quality.diagnostic.gap");
    report.captures = {};
    for (const id of SINK_IDS) { const path = sinkPaths[id]; report.captures[id] = { path, records: await lines(path), entries: await lines(path + ".entries.jsonl"), lifecycle: existsSync(path + ".lifecycle.json") ? await json(path + ".lifecycle.json") : null }; }
    report.privacy = Object.fromEntries(["K08_TASK_SOURCE_CANARY", "K08_REQUIREMENT_SOURCE_CANARY", "K08_STATIC_PROMPT_V1", "Scripted resource delivery, not engineering usefulness."].map(text => [text, !journal.includes(text)]));
    try {
      if (failure === null) {
        const count = scenario === "prompt-pair" ? 2 : 1; assert.equal(report.evaluations.length, count); assert.equal(report.providerCalls.length, count); assert.equal(report.canonical.length, count); assert.equal(report.settled.length, count);
        for (let n = 0; n < count; n += 1) {
          const observed = report.evaluations[n], request = report.providerCalls[n], canonical = report.canonical.find(row => row.fields.correlation.runId === observed.input.run.runId);
          const replacement = n === 1, resource = report.resources[replacement ? "replacement" : "original"], instruction = observed.input.assessment.instructions[0];
          assert.equal(instruction.content[0].text, resource.text, "exact versioned resource reached the actual evaluator");
          if (replacement) assert.equal(await realpath(fileURLToPath(instruction.provenance.uri)), await realpath(fileURLToPath(resource.uri)), "actual receiver provenance resolves to the deployed public artifact file"); else assert.equal(instruction.provenance.uri, resource.uri);
          assert.equal(instruction.provenance.revision, replacement ? resource.sha256.slice(0, 32) : "sha-" + resource.sha256.slice(0, 16)); assert.equal(instruction.provenance.changedDuringRead, false);
          assert.equal(request.originalsPresent, true, "unchanged original task and requirement bodies reach actual SDK receiver"); assert.equal(request.replacement, replacement); assert.equal(request.original, !replacement);
          assert.equal(canonical.fields.data.validationState, "valid"); assert.equal(canonical.fields.data.operational, "completed"); assert.equal(canonical.fields.data.coverage, "complete"); assert.equal(canonical.fields.data.conclusion, "no-supported-finding"); assert.equal(canonical.fields.data.scores.length, replacement ? 1 : 0);
          assert.deepEqual(canonical.fields.data.attemptRefs, observed.response.value.attemptIds); assert.equal(report.settled.find(row => row.fields.correlation.runId === observed.input.run.runId).fields.data.conclusion, "no-supported-finding");
        }
        if (scenario === "prompt-pair") {
          const normalized = structuredClone(report.replacementConfig); normalized.prompts.assess.options.instructions = report.initialConfig.prompts.assess.options.instructions; assert.deepEqual(normalized, report.initialConfig, "only static resource selection changes");
          assert.notEqual(report.evaluations[0].input.assessment.resourceRevision, report.evaluations[1].input.assessment.resourceRevision);
          const originals = evaluation => evaluation.input.context.items.filter(item => item.provenance.sourceId === "core.files" && ["evidence", "requirement"].includes(item.role)).map(item => ({ role: item.role, sourceId: item.provenance.sourceId, uri: item.provenance.uri, revision: item.provenance.revision, content: item.content }));
          assert.deepEqual(originals(report.evaluations[0]), originals(report.evaluations[1])); assert.equal(originals(report.evaluations[0]).length, 2);
          // 326-F1: use actual run/public revisions and PHYSICAL journal rows,
          // never URI-dependent fingerprints or a rewritten history snapshot.
          const initialRun = report.evaluations[0].input.run, replacementRun = report.evaluations[1].input.run;
          const q1 = report.phases[0].status.configuration.revision, q2 = report.afterReload.configuration.revision;
          assert.equal(initialRun.checkRevision, q1); assert.equal(replacementRun.checkRevision, q2); assert.notEqual(q1, q2);
          const runRows = (run, revision) => ["quality.model.dispatched", "quality.assessment.result", "quality.check.settled"].map(event => {
            const rows = physical.filter(row => row.event === event && row.fields.correlation.runId === run.runId && row.observedSessionId === run.scope.observedSessionId && row.fields.scope.runtimeGeneration === run.scope.runtimeGeneration);
            assert.equal(rows.length, 1, "one actual physical " + event + " for " + run.runId);
            assert.equal(rows[0].fields.configRevision, revision, "physical event retains the actual admitted run configuration");
            assert.deepEqual(rows[0].fields.scope, run.scope, "configuration provenance must not change scope/authority");
            return rows[0];
          });
          const initialRows = runRows(initialRun, q1), replacementRows = runRows(replacementRun, q2);
          const applied = physical.filter(row => row.event === "quality.config.applied" && row.fields.data.configRevision === q2);
          assert.equal(applied.length, 1); assert.equal(applied[0].fields.configRevision, q2); assert.equal(applied[0].fields.data.previousRevision, q1);
          assert.ok(initialRows[2].sequence < applied[0].sequence && applied[0].sequence < replacementRows[0].sequence, "first run completed before apply; new run begins after apply without resetting sequence");
          // The status suffix is bounded; it need not still contain dispatch.
          // The first settlement is necessarily present in the phase barrier.
          const beforeReload = report.phases[0].status.diagnostics.recentEvents.find(prior => prior.eventId === initialRows[2].eventId);
          assert.ok(beforeReload, "initial settlement positive control was observed before reload");
          assert.equal(fingerprint(initialRows[2]), fingerprint(beforeReload), "reload cannot rewrite an already emitted record");
          report.configurationProvenance = { initialRevision: q1, replacementRevision: q2, initialRun, replacementRun, initialPhysicalRows: initialRows, appliedPhysicalRow: applied[0], replacementPhysicalRows: replacementRows, priorEmittedRecordsUnchanged: true };
        }
        if (scenario === "sink-isolation") {
          const mutator = report.captures[SINK_IDS[0]], healthy = report.captures[SINK_IDS[1]], stalled = report.captures[SINK_IDS[2]];
          for (const capture of Object.values(report.captures)) { assert.ok(capture.records.length > 0, "every sink write boundary reached"); assert.equal(capture.lifecycle.disposed, true); assert.equal(capture.lifecycle.pending, 0); }
          assert.ok(mutator.records.some(row => row.mutationAttempted), "mutation was actually attempted on the received record");
          const byEvent = new Map(healthy.records.map(row => [row.before.eventId, row]));
          const shared = mutator.records.filter(row => byEvent.has(row.before.eventId)); assert.ok(shared.length > 0);
          report.fingerprints = shared.map(row => ({ eventId: row.before.eventId, mutatorBefore: fingerprint(row.before), mutatorAfter: fingerprint(row.after), healthy: fingerprint(byEvent.get(row.before.eventId).before) }));
          for (const row of report.fingerprints) assert.equal(row.healthy, row.mutatorBefore, "mutating sink cannot change a second destination's same-event fingerprint");
          assert.equal(JSON.stringify(healthy.records).includes(MUTATION), false, "second destination remains unmutated"); assert.equal(JSON.stringify(report.snapshots).includes(MUTATION), false, "history/status cannot be changed by a sink"); assert.equal(journal.includes(MUTATION), false, "built-in physical journal remains unmutated");
          const heldEntries = report.stallEntryBeforeDrain.filter(row => row.held); assert.ok(heldEntries.length <= 64 && heldEntries.length > 0, "actual bounded held sink callback count, distinct from later drained calls");
          assert.ok(healthy.records.some(row => row.before.event === "quality.check.settled" && row.writtenAt < stalled.lifecycle.releasedAt), "useful check and healthy destination completed while the other sink was still held");
          const gap = report.gaps.find(row => row.fields.data.sinkId === SINK_IDS[2] && row.fields.data.lostCount > 0); assert.ok(gap, "actual stalled-destination gap evidence"); assert.ok(report.health.some(row => row.fields.data.sinkId === SINK_IDS[2] && row.fields.data.lostRecords > 0));
          assert.equal(report.gaps.some(row => row.fields.data.sinkId === SINK_IDS[1]), false, "healthy destination did not inherit transport loss");
          assert.ok(healthy.records.some(row => row.before.event === "quality.check.settled"));
        } else for (const capture of Object.values(report.captures)) { assert.equal(capture.lifecycle, null); assert.equal(capture.records.length, 0, "install/ready alone cannot export diagnostic records"); }
      }
      assert.equal(report.shutdownReturned, true); assert.deepEqual(report.remainingLocks, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 }); assert.ok(Object.values(report.privacy).every(Boolean));
      for (const capture of Object.values(report.captures)) for (const row of capture.records) {
        assert.deepEqual(Object.keys(row.before).sort(), ["event", "eventId", "fields", "observedSessionId", "schemaVersion", "sequence"]);
        const text = JSON.stringify(row.before); for (const canary of Object.keys(report.privacy)) assert.equal(text.includes(canary), false, "sink input is projected, never raw source/prompt/model prose");
      }
    } catch (error) { failure ??= error; report.assertionFailure = { name: error.name, message: error.message }; }
    report.result = failure === null ? "AUTHOR_PASS" : "FAIL"; await save(join(root, "witness.json"), report);
  }
  if (failure !== null) throw failure;
}

if (process.argv[2] === "--installed-child") {
  try { await packedChild(JSON.parse(process.argv[3])); } catch (error) { console.error(error); process.exitCode = 1; }
} else {
  test("K08 installed static prompt and projected sink family plus unchanged connected regressions", { timeout: 90_000 }, async t => {
    const evidence = process.env.QE_EVIDENCE_DIR; assert.ok(evidence && isAbsolute(evidence));
    const root = await mkdtemp(join(evidence, "installed-sink-prompt-")), source = fileURLToPath(new URL("../", import.meta.url)), baseline = await packageInputs(source), env = await prepareEnvironment(root);
    const mirror = join(root, "source-mirror"), engineMirror = join(mirror, "engine"), contributionMirror = join(mirror, "contributor"), artifacts = join(root, "artifacts"); await mkdir(artifacts, { recursive: true });
    for (const [name, pin] of Object.entries(baseline.payload)) { assert.deepEqual(await identity(join(source, name)), pin); await mkdir(dirname(join(engineMirror, name)), { recursive: true }); await copyFile(join(source, name), join(engineMirror, name)); }
    const contributorSources = {};
    for (const name of ["package.json", "extension.mjs", "resources/k08-context.md", "resources/k08-prompt.md"]) { const original = join(source, "examples/independent-extension", name); assert.equal(existsSync(original), true); await mkdir(dirname(join(contributionMirror, name)), { recursive: true }); await copyFile(original, join(contributionMirror, name)); contributorSources[name] = await identity(original); }
    const packages = {};
    for (const [name, cwd] of [["engine", engineMirror], ["contributor", contributionMirror], ["yaml", baseline.existingYaml.path]]) { const result = await runNative(join(root, "pack-" + name), npmCommand("pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", artifacts), cwd, env); assert.equal(result.receipt.exit, 0); const value = JSON.parse(result.stdout)[0], tar = join(artifacts, value.filename); packages[name] = { path: tar, ...await identity(tar), inventory: tarInventory(await readFile(tar)) }; }
    assert.deepEqual(packages.engine.inventory, baseline.payload); assert.deepEqual(Object.keys(packages.contributor.inventory).sort(), Object.keys(contributorSources).sort(), "actual new static resource is packed");
    const consumer = join(root, "consumer"); await mkdir(consumer); await save(join(consumer, "package.json"), { name: "k08-sink-prompt-consumer", private: true, type: "module" });
    const install = await runNative(join(root, "install"), npmCommand("install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--package-lock=false", packages.engine.path, packages.contributor.path, packages.yaml.path), consumer, env); assert.equal(install.receipt.exit, 0);
    const peer = join(consumer, "node_modules/@earendil-works/pi-coding-agent"); await mkdir(dirname(peer), { recursive: true }); await symlink(baseline.hostSdk.path, peer, "junction");
    const installed = {};
    for (const [name, directory] of [["engine", "pi-quality-engine"], ["contributor", "qe-independent-fixture"]]) { installed[name] = {}; for (const [path, expected] of Object.entries(packages[name].inventory)) { const actual = await identity(join(consumer, "node_modules", directory, path)); assert.deepEqual(actual, expected); installed[name][path] = actual; } }
    await copyFile(fileURLToPath(import.meta.url), join(consumer, "driver.mjs"));
    const drivers = {};
    for (const [label, file] of [["trigger-context", "test/k08-installed-contribution.test.mjs"], ["admission", "test/k08-installed-admission.test.mjs"]]) { const original = join(source, file), target = join(consumer, label + "-driver.mjs"); await copyFile(original, target); drivers[label] = { path: target, source: file, ...await identity(target) }; }
    await rm(mirror, { recursive: true, force: true }); assert.equal(existsSync(mirror), false);
    await save(join(root, "package-bindings.json"), { packages, installed, contributorSources, drivers, mirrorRemovedBeforeSdkImports: true, hostPeer: baseline.hostSdk, networkDependencyFetching: false, core: "Coherent current compiled59 supplied by caller; historical checkout dist is never substituted. External artifact/build bindings own provenance." });
    for (const scenario of SCENARIOS) await t.test(scenario, { timeout: 25_000 }, async () => { const caseRoot = join(root, scenario), childEnv = await prepareEnvironment(caseRoot); const result = await runNative(join(caseRoot, "native"), [process.execPath, join(consumer, "driver.mjs"), "--installed-child", JSON.stringify({ root: caseRoot, consumer, scenario, mirror })], consumer, childEnv, 20_000); assert.equal(result.receipt.exit, 0, scenario + " real installed assertions"); });
    const regressions = { "trigger-context": ["positive", "context-omitted", "contributor-absent"], admission: ["admitted", "request-outside-binding", "request-run-outside-binding", "effect-ungranted", "selected-profile-unapproved", "binding-safety", "contributor-absent"] };
    for (const [label, scenarios] of Object.entries(regressions)) await t.test("unchanged installed " + label, async group => {
      for (const scenario of scenarios) await group.test(scenario, { timeout: 20_000 }, async () => { const caseRoot = join(root, "regression", label, scenario), childEnv = await prepareEnvironment(caseRoot); const result = await runNative(join(caseRoot, "native"), [process.execPath, drivers[label].path, "--installed-child", JSON.stringify({ root: caseRoot, consumer, scenario, mirror })], consumer, childEnv, 15_000); assert.equal(result.receipt.exit, 0); const witness = await json(join(caseRoot, "witness.json")); assert.equal(witness.result, "AUTHOR_PASS"); assert.equal(witness.shutdownReturned, true); assert.deepEqual(witness.remainingLocks, []); });
    });
    await save(join(root, "completion.json"), { newLogicalScenarios: SCENARIOS, unchangedRegressionLogicalScenarios: regressions, packageBindings: join(root, "package-bindings.json"), scope: "All three families consume the SAME physically installed engine59/contributor4. Old regression drivers/oracles are byte-identical; their three-file-only parent repackers are not rerun against a partial package.", wholeK08Accepted: false });
  });
}
