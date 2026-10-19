// K08-B.05/T03: installed contributed evaluator/policy/action executions through
// public Pi loading, real shared model services and normal action admission.
// The SDK provider is bounded scripted instrumentation, not live usefulness.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const TASK = "K08_OWNED_ADMISSION_TASK: Read the owned work note once, assess that input through the configured evaluator, and retain an audit record only when its action is explicitly granted.";
const RULE = "Repeated reads are evidence for investigation, not proof of an implementation defect.";
const PACKAGE_ID = "fixture.independent-extension";
const CONTEXT_ID = "fixture.note";
const EVALUATOR_ID = "fixture.audit-evaluator", POLICY_ID = "fixture.audit-policy", ACTION_ID = "fixture.audit-file";
const COMPONENT_IDS = ["fixture.burst-tools", CONTEXT_ID, EVALUATOR_ID, POLICY_ID, ACTION_ID];
const SCENARIOS = ["admitted", "request-outside-binding", "request-run-outside-binding", "effect-ungranted", "selected-profile-unapproved", "binding-safety", "contributor-absent"];
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
  assert.deepEqual(manifest.files, ["dist", "resources", "README.md", "THIRD_PARTY_NOTICES.md"], "copy only the declared public package surface, never a checkout snapshot");
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
  await visit("dist"); await visit("resources");
  const peer = await realpath(join(source, "node_modules", "@earendil-works", "pi-coding-agent"));
  const yaml = await realpath(join(source, "node_modules", "yaml"));
  const sdkManifest = await json(join(peer, "package.json")), yamlManifest = await json(join(yaml, "package.json"));
  assert.equal(sdkManifest.version, manifest.devDependencies["@earendil-works/pi-coding-agent"]);
  assert.equal(yamlManifest.version, manifest.dependencies.yaml);
  return { payload, hostSdk: { path: peer, version: sdkManifest.version, metadata: await identity(join(peer, "package.json")) }, existingYaml: { path: yaml, version: yamlManifest.version, metadata: await identity(join(yaml, "package.json")) } };
}

async function packedChild(options) {
  const { root, consumer, scenario, mirror } = options;
  assert.equal(existsSync(mirror), false, "the owned packaging mirror is gone before imports");
  const report = { scenario, root, consumer, mirrorAbsentBeforeImports: true, providerCalls: [], primaryReads: [], effects: { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 }, extensionErrors: [], cleanup: [] };
  let runner = null, status = null, stopped = false, failure = null, releaseProbe = () => {};
  report.probeCalls = 0; report.probeReady = []; report.safetySnapshots = []; report.bindingReads = [];
  const absent = scenario === "contributor-absent", upstream = scenario === "selected-profile-unapproved";
  const requestDenied = scenario === "request-outside-binding" || scenario === "request-run-outside-binding";
  const admitted = scenario === "admitted" || scenario === "binding-safety";
  const until = async (read, accepts, label) => {
    const deadline = Date.now() + 5000;
    do { const value = await read(); report.lastStatus = value; if (accepts(value)) return value; await new Promise(resolvePromise => setTimeout(resolvePromise, 10)); } while (Date.now() < deadline);
    throw new Error("K08 admission deadline: " + label);
  };
  const allFiles = async directory => {
    const out = [];
    if (!existsSync(directory)) return out;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) out.push(...await allFiles(path)); else if (entry.isFile()) out.push(path);
    }
    return out;
  };
  try {
    const engine = join(consumer, "node_modules", "pi-quality-engine"), contributor = join(consumer, "node_modules", "qe-independent-fixture");
    const contractUrl = import.meta.resolve("pi-quality-engine/contracts");
    assert.equal(await realpath(fileURLToPath(contractUrl)), await realpath(join(engine, "dist/contracts.js")));
    const beforeContracts = await allFiles(process.env.PI_CODING_AGENT_DIR);
    await import("pi-quality-engine/contracts");
    assert.deepEqual(await allFiles(process.env.PI_CODING_AGENT_DIR), beforeContracts, "public contracts import is inert");
    report.publicContracts = { url: contractUrl, ...await identity(fileURLToPath(contractUrl)), inert: true };
    const sdk = await import("@earendil-works/pi-coding-agent");
    report.sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const agentDir = process.env.PI_CODING_AGENT_DIR, project = join(root, "project"), audit = join(root, "audit.json");
    await mkdir(project, { recursive: true }); await mkdir(join(agentDir, "quality"), { recursive: true });
    assert.equal(existsSync(audit), false, "only the admitted installed action may create the audit destination");
    const config = {
      schemaVersion: 1, enabled: true, mode: "advise",
      modelProfiles: { scripted: { provider: "qe-k08-scripted", model: "audit-1", maxOutputTokens: 128, price: "unknown" }, forbidden: { provider: "qe-k08-scripted", model: "audit-1", maxOutputTokens: 128, price: "unknown" } },
      permissions: { modelProfiles: upstream ? [] : ["scripted"], actions: scenario === "effect-ungranted" ? [] : [ACTION_ID] },
      prompts: { admission: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { work: { providers: [{ id: "note", use: CONTEXT_ID }, { id: "task", use: "core.task" }, { id: "waits", use: "core.waits" }] } },
      evaluators: { audit: { use: EVALUATOR_ID, modelProfile: "scripted", options: { maxOutputTokens: 128, ...(scenario === "request-outside-binding" ? { requestProfile: "forbidden" } : {}), ...(scenario === "request-run-outside-binding" ? { requestRun: "foreign-run" } : {}) } } },
      policies: { audit: { use: POLICY_ID, options: { destination: pathToFileURL(audit).href } } },
      checks: { admission: { triggers: [{ id: "read-once", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "admission", evaluator: "audit", policy: "audit", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"] } },
    };
    await save(join(agentDir, "quality", "config.json"), config); report.configuration = config;
    const paths = [];
    for (const packageRoot of absent ? [engine] : [engine, contributor]) {
      const manifest = await json(join(packageRoot, "package.json")); assert.equal(manifest.pi.extensions.length, 1);
      const entry = resolve(packageRoot, manifest.pi.extensions[0]); assert.equal(inside(packageRoot, entry), true); paths.push(entry);
    }
    const probeGate = new Promise(resolvePromise => { releaseProbe = resolvePromise; });
    const factories = scenario !== "binding-safety" ? [] : [pi => {
      let handle = null, unsubscribe = null, observedSessionId = null;
      const register = endpoint => {
        if (endpoint === null || endpoint === undefined || handle !== null || endpoint.observedSessionId !== observedSessionId) return;
        const accepted = endpoint.register({ id: "fixture.binding-control", version: "0.1.0", baseUri: new URL(".", import.meta.url).href, resources: {},
          components: [{ id: "fixture.binding-deterministic", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["text", "json"], requiredCapabilities: [], diagnosticCodes: [], optionsSchema: { type: "object", additionalProperties: false },
            async evaluate() { report.probeCalls += 1; return { operational: "completed", coverage: { state: "complete", scopeDescription: "Bounded binding safety probe.", issues: [] }, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] }; } }],
          async prepare() { await probeGate; },
        });
        assert.equal(accepted.ok, true); handle = accepted.value;
        handle.ready.then(value => report.probeReady.push({ ok: value.ok, registrationId: handle.registrationId }));
      };
      pi.on("session_start", (_event, ctx) => { observedSessionId = ctx.sessionManager.getSessionId(); unsubscribe = pi.events.on("quality.registry.available.v1", register); pi.events.emit("quality.registry.query.v1", { apiMajor: 1, observedSessionId, reply: register }); });
      pi.on("session_shutdown", async () => { releaseProbe(); unsubscribe?.(); if (handle !== null) { await handle.ready; await handle.dispose(); } });
    }];
    const loader = new sdk.DefaultResourceLoader({ cwd: project, agentDir, settingsManager: sdk.SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: paths, extensionFactories: factories });
    await loader.reload(); const loaded = loader.getExtensions(); report.loadErrors = loaded.errors; assert.deepEqual(loaded.errors, []);
    const models = await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider("qe-k08-scripted", {
      name: "bounded K08 scripted provider", api: "qe-k08-api", apiKey: "fixture-not-credential", baseUrl: "http://127.0.0.1:9/not-used",
      models: [{ id: "audit-1", name: "scripted audit", api: "qe-k08-api", input: ["text"], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, context, requestOptions) {
        // This public SDK provider is the real receiver. It is not a model-port
        // substitute and never calls an HTTP provider. Usage is scripted, not a
        // tokenizer/cost calibration. Do not persist auth-bearing options.
        const delivered = JSON.parse(JSON.stringify(context));
        const complete = JSON.stringify(delivered).includes(RULE);
        const returned = { operational: "completed", coverage: { state: complete ? "complete" : "insufficient", scopeDescription: "Bounded scripted audit of the actual delivered packaged resource.", issues: [] }, conclusion: complete ? "no-supported-finding" : "undetermined", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };
        report.providerCalls.push({ model: { provider: model.provider, id: model.id, api: model.api }, context: delivered, maxTokens: requestOptions?.maxTokens, returned });
        const message = { role: "assistant", content: [{ type: "text", text: JSON.stringify(returned) }], api: model.api, provider: model.provider, model: model.id, usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }, stopReason: "stop", timestamp: Date.now() };
        return {
          async *[Symbol.asyncIterator]() { yield { type: "start", partial: { ...message, content: [] } }; yield { type: "text_start", contentIndex: 0, partial: message }; yield { type: "text_delta", contentIndex: 0, delta: message.content[0].text, partial: message }; yield { type: "text_end", contentIndex: 0, content: message.content[0].text, partial: message }; yield { type: "done", reason: "stop", message }; },
          async result() { return message; },
        };
      },
    });
    runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, project, sdk.SessionManager.inMemory(project), new sdk.ModelRegistry(models));
    const noop = () => {}, messages = [], effects = report.effects;
    runner.bindCore({ sendMessage: () => { effects.sendMessage += 1; }, sendUserMessage: () => { effects.sendUserMessage += 1; }, appendEntry: () => { effects.appendEntry += 1; }, setSessionName: noop, getSessionName: () => undefined, setLabel: noop, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: noop, getThinkingLevel: () => "off", setThinkingLevel: noop }, { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, abort: () => { effects.abort += 1; }, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => "" });
    runner.setUIContext({ ...runner.getUIContext(), notify: message => messages.push(message) }, "rpc");
    report.loadedPaths = runner.getExtensionPaths(); assert.equal(paths.every(path => report.loadedPaths.map(value => resolve(value)).includes(resolve(path))), true);
    runner.onError(error => report.extensionErrors.push({ event: error.event, error: String(error.error) }));
    const command = runner.getCommand("quality");
    status = async () => { await command.handler("status", runner.createCommandContext()); return JSON.parse(messages.at(-1)); };
    await runner.emit({ type: "session_start", reason: "startup" });
    report.readyStatus = await until(status, value => absent ? value.checks.detail[0]?.state === "waiting" : value.registry.packages.some(entry => entry.packageId === PACKAGE_ID && entry.phase === "ready"), "actual installed independent package readiness or explicit missing dependency");
    // Retry through the public operator command with the actual definitions
    // already registered/ready, also binding any approved action declaration.
    await command.handler("reload", runner.createCommandContext());
    report.approvedStatus = await status();
    if (upstream) {
      assert.equal(report.approvedStatus.configuration.rejection.errorCode, "config.capability-unavailable", "unapproved selected binding stays an upstream configuration rejection");
      assert.equal(report.approvedStatus.checks.total, 0); assert.equal(report.approvedStatus.configuration.enabled, false);
    } else {
      assert.equal(report.approvedStatus.configuration.rejection, null, "a lawful contributed selected modelProfile is admitted");
      report.checkReadyStatus = await until(status, value => value.checks.detail[0]?.state === (absent ? "waiting" : "active"), "selected binding state");
      await writeFile(join(project, "work.txt"), "K08_OWNED_ADMISSION_READ_CANARY\nRead this synthetic audit input once.\n", "utf8");
      const read = sdk.createReadTool(project);
      const performRead = async (toolCallId, target) => {
        const args = { path: "work.txt" }; await runner.emit({ type: "tool_execution_start", toolCallId, toolName: "read", args });
        const result = await read.execute(toolCallId, args, new AbortController().signal); target.push({ toolCallId, result });
        await runner.emit({ type: "tool_execution_end", toolCallId, toolName: "read", result, isError: false, durationMs: 1 });
      };
      if (scenario === "binding-safety") {
        const pending = structuredClone(config); pending.evaluators.audit = { use: "fixture.binding-deterministic", modelProfile: "scripted" };
        assert.equal(report.probeReady.length, 0, "a real preparation promise is still held");
        await save(join(agentDir, "quality", "config.json"), pending); await command.handler("reload", runner.createCommandContext());
        const waiting = await status(); report.safetySnapshots.push({ phase: "pending", status: waiting });
        assert.equal(waiting.checks.detail[0].state, "waiting", "unready metadata is neither guessed deterministic nor activated");
        releaseProbe();
        const invalidReady = await until(status, value => report.probeReady.length === 1 && JSON.stringify(value.checks.detail).includes("evaluator-model:audit"), "late deterministic metadata rejects the bound model");
        report.safetySnapshots.push({ phase: "ready-incompatible", status: invalidReady });
        await runner.emitInput(TASK, undefined, "interactive"); await performRead("binding-wait-read", report.bindingReads);
        assert.equal(report.probeCalls, 0); assert.equal(report.providerCalls.length, 0); assert.equal((await status()).checks.runs, 0);
        await save(join(agentDir, "quality", "config.json"), config); await command.handler("reload", runner.createCommandContext());
        const baselineStatus = await status(); assert.equal(baselineStatus.checks.detail[0].state, "active");
        const invalids = [
          ["missing-model", candidate => { delete candidate.evaluators.audit.modelProfile; }, "config.invalid-value"],
          ["unknown-model", candidate => { candidate.evaluators.audit.modelProfile = "absent"; }, "config.unresolved-reference"],
          ["unapproved-model", candidate => { candidate.permissions.modelProfiles = []; candidate.permissions.actions = []; }, "config.capability-unavailable"],
          ["known-deterministic", candidate => { candidate.evaluators.audit = { use: "fixture.binding-deterministic", modelProfile: "scripted" }; }, "config.invalid-value"],
        ];
        for (const [label, mutate, code] of invalids) {
          const candidate = structuredClone(config); mutate(candidate); await save(join(agentDir, "quality", "config.json"), candidate); await command.handler("reload", runner.createCommandContext());
          const retained = await status(); report.safetySnapshots.push({ phase: label, status: retained });
          assert.equal(retained.configuration.revision, baselineStatus.configuration.revision, "failed apply retains the accepted configuration"); assert.equal(retained.configuration.enabled, true); assert.equal(retained.checks.detail[0].state, "active");
          const rejection = retained.diagnostics.recentEvents.filter(event => event.event === "quality.config.rejected").at(-1);
          assert.deepEqual(rejection.fields.data.errorCodes, [code]); assert.deepEqual(rejection.fields.data.fieldPaths, ["$.evaluators.audit.modelProfile"]); assert.equal(rejection.fields.data.runtimeUnchanged, true);
          assert.match(rejection.fields.data.candidateRevision, /^rejected-/u, "invalid candidates retain opaque rejection identity, not a guessable effective-config digest");
        }
        // The file remains an invalid attempted candidate. The following real
        // model and action must still use the preceding accepted grants.
      }
      await runner.emitInput(TASK, undefined, "interactive"); await performRead("admission-read-1", report.primaryReads);
      if (absent) {
        report.settledStatus = await status(); assert.equal(report.settledStatus.checks.runs, 0); assert.match(JSON.stringify(report.settledStatus.checks.detail), /evaluator:audit/u);
      } else {
        report.settledStatus = await until(status, value => value.diagnostics.recentEvents.some(event => event.event === "quality.check.settled"), "actual check settlement");
        if (admitted) report.effectStatus = await until(status, value => value.diagnostics.recentEvents.some(event => event.event === "quality.action.receipt" && event.fields.data.state === "completed"), "actual completed action receipt");
      }
    }
    await runner.emit({ type: "session_shutdown", reason: "quit" }); stopped = true; report.retired = await status();
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message }; }
  finally {
    releaseProbe();
    if (runner !== null && !stopped) {
      try { await runner.emit({ type: "session_shutdown", reason: "quit" }); stopped = true; report.cleanup.push({ label: "real session shutdown", returned: true }); }
      catch (error) { report.cleanup.push({ label: "real session shutdown", returned: false, message: error.message }); failure ??= error; }
    }
    if (stopped && status !== null && report.retired === undefined) {
      try { report.retired = await status(); }
      catch (error) { report.cleanup.push({ label: "public retired status", returned: false, message: error.message }); failure ??= error; }
    }
    if (runner !== null) runner.invalidate("K08 owned admission case ended"); report.shutdownReturned = stopped;
    const stateFiles = await allFiles(process.env.PI_CODING_AGENT_DIR); report.finalStateFiles = stateFiles; report.remainingLocks = stateFiles.filter(path => path.endsWith(".lock"));
    const journal = (await Promise.all(stateFiles.filter(path => /\.jsonl(?:\.gz)?$/u.test(path)).map(async path => { const bytes = await readFile(path); return (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"); }))).join("\n");
    const records = journal.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const snapshots = [report.readyStatus, report.checkReadyStatus, report.approvedStatus, report.settledStatus, report.effectStatus, report.retired, report.lastStatus, ...report.safetySnapshots.map(value => value.status)].flatMap(value => value?.diagnostics.recentEvents ?? []);
    const events = [...new Map([...records, ...snapshots].map(event => [event.eventId, event])).values()]; report.events = events;
    const select = name => events.filter(event => event.event === name), note = code => select("quality.component.note").filter(event => event.fields.data.code === code);
    report.contributorLifecycle = select("quality.component.lifecycle").filter(event => event.fields.data.packageId === PACKAGE_ID);
    report.lifecycleCounts = Object.fromEntries(["registered", "ready", "disposed"].map(phase => [phase, Object.fromEntries(COMPONENT_IDS.map(id => [id, report.contributorLifecycle.filter(event => event.fields.data.phase === phase && event.fields.data.componentId === id).length]))]));
    report.lifecycleEvidence = "Unique logical event IDs joined across physical journal and explicit public snapshots; not all disposal events are claimed persisted.";
    report.policyDecisions = select("quality.policy.decided");
    report.canonical = select("quality.assessment.result"); report.settled = select("quality.check.settled"); report.modelDispatched = select("quality.model.dispatched"); report.modelSettled = select("quality.model.settled"); report.actionAdmissions = select("quality.action.admission"); report.actionReceipts = select("quality.action.receipt");
    report.entryNotes = note("fixture.audit-request"); report.returnNotes = note("fixture.audit-response"); report.executeNotes = note("fixture.audit-written"); report.scopeRefusals = note("fixture.audit-scope-refused");
    const audit = join(root, "audit.json"); report.audit = existsSync(audit) ? { path: audit, ...await identity(audit), value: await json(audit) } : null;
    report.physicalEffectCount = report.audit === null ? 0 : 1;
    report.reachability = { evaluatorEntries: report.entryNotes.length, providerArrivals: report.providerCalls.length, actionAdmissions: report.actionAdmissions.length, executorCompletions: report.executeNotes.length, physicalEffects: report.physicalEffectCount };
    report.privacy = { taskBodyInJournal: journal.includes(TASK), primaryBodyInJournal: journal.includes("K08_OWNED_ADMISSION_READ_CANARY"), resourceBodyInJournal: journal.includes(RULE) };
    try {
      if (failure === null && (upstream || absent)) {
        assert.equal(report.entryNotes.length, 0); assert.equal(report.returnNotes.length, 0); assert.equal(report.providerCalls.length, 0); assert.equal(report.modelDispatched.length, 0); assert.equal(report.canonical.length, 0); assert.equal(report.actionAdmissions.length, 0); assert.equal(report.physicalEffectCount, 0);
      }
      if (failure === null && !upstream && !absent) {
        assert.equal(report.primaryReads.length, 1); assert.equal(report.settled.length, 1); assert.equal(report.canonical.length, 1);
        assert.equal(report.entryNotes.length, 1, "the selected installed evaluator actually entered its common request path"); assert.equal(report.returnNotes.length, 1);
        assert.equal(report.canonical[0].fields.data.validationState, "valid");
        const canonical = report.canonical[0], runId = canonical.fields.correlation.runId;
        assert.ok(runId); assert.equal(report.settled[0].fields.correlation.runId, runId);
        assert.equal(report.entryNotes[0].fields.data.componentId, EVALUATOR_ID);
        const count = requestDenied ? 0 : 1;
        assert.equal(report.providerCalls.length, count, "independent public SDK provider arrival count"); assert.equal(report.modelDispatched.length, count); assert.equal(report.modelSettled.length, count);
        assert.equal(report.settledStatus.accounting.ownedRequestCount, count, "shared accounting owns the real request count");
        assert.equal(canonical.fields.data.operational, requestDenied ? "unavailable" : "completed"); assert.equal(canonical.fields.data.conclusion, requestDenied ? "undetermined" : "no-supported-finding"); assert.equal(canonical.fields.data.attemptRefs.length, count);
        assert.equal(report.returnNotes[0].fields.data.counts.completed, !requestDenied);
        assert.equal(report.returnNotes[0].fields.data.counts.records, count);
        assert.equal(report.policyDecisions.length, 1, "the selected contributed policy really ran");
        if (requestDenied) {
          assert.equal(report.scopeRefusals.length, 1, "the actual returned core.model-request-scope-mismatch is observed by the contributed caller before canonical normalization, not forced into a later unapproved-profile error");
          assert.deepEqual(report.scopeRefusals[0].fields.data.counts, { rejected: 1 });
          assert.equal(report.actionAdmissions.length, 0, "a request-denied case does not claim action-gate reachability");
        } else {
          assert.ok(JSON.stringify(report.providerCalls[0].context).includes(RULE), "actual model receiver got the installed context document, not just registry metadata");
          assert.equal(report.scopeRefusals.length, 0);
          assert.equal(report.modelDispatched[0].fields.correlation.runId, runId);
          const attemptId = report.modelDispatched[0].fields.data.attemptId;
          assert.equal(canonical.fields.data.attemptRefs[0], attemptId);
          assert.equal(report.modelSettled[0].fields.data.attemptId, attemptId); assert.equal(report.modelSettled[0].fields.correlation.runId, runId);
          assert.deepEqual(report.settled[0].fields.data.usageAttemptRefs, canonical.fields.data.attemptRefs);
          assert.equal(report.modelDispatched[0].fields.data.reservationRef, "attempt:" + attemptId); assert.equal(report.modelDispatched[0].fields.data.accountingOwner, "engine");
          assert.equal(report.modelDispatched[0].fields.data.profileId, "scripted"); assert.equal(report.modelDispatched[0].fields.data.actualRoute.provider, report.providerCalls[0].model.provider); assert.equal(report.modelDispatched[0].fields.data.actualRoute.model, report.providerCalls[0].model.id);
          assert.equal(report.modelSettled[0].fields.data.cost.basis, "unknown"); assert.equal(report.modelSettled[0].fields.data.cost.amount, null, "scripted usage and unknown configured price do not fabricate a free invoice");
          assert.equal(report.settledStatus.accounting.normalizedTokens.total, 150, "scripted provider-reported usage was reconciled");
          assert.equal(report.actionAdmissions.length, 1, "the selected policy proposed an action at the common action boundary");
          const admission = report.actionAdmissions[0]; assert.equal(admission.fields.correlation.runId, runId); assert.equal(admission.fields.data.componentId, ACTION_ID); assert.deepEqual(admission.fields.data.effectKinds, ["fixture.audit-file"]); assert.equal(admission.fields.data.freshness, "current");
          assert.equal(admission.fields.data.outcome, admitted ? "admitted" : "rejected");
          if (admitted) {
            assert.equal(report.actionReceipts.length, 1); assert.equal(report.actionReceipts[0].fields.data.state, "completed");
            assert.equal(report.actionReceipts[0].fields.data.actionId, admission.fields.data.actionId); assert.equal(report.actionReceipts[0].fields.correlation.runId, runId);
            assert.ok(admission.sequence < report.executeNotes[0].sequence && report.executeNotes[0].sequence < report.actionReceipts[0].sequence, "the actual exclusive-write completion precedes the completed common receipt");
            assert.deepEqual(report.audit.value.run.scope, canonical.fields.scope); assert.equal(report.audit.value.run.checkRevision, canonical.fields.configRevision);
            assert.equal(report.audit.value.actionId, admission.fields.data.actionId); assert.equal(report.audit.value.run.runId, runId); assert.equal(report.audit.value.authorizationRevision, admission.fields.data.currentAuthority);
            assert.equal(report.audit.value.summary.conclusion, canonical.fields.data.conclusion); assert.deepEqual(report.audit.value.summary.usageAttemptIds, canonical.fields.data.attemptRefs);
          } else {
            assert.ok(admission.fields.reasonCodes.includes("core.action-effects-unapproved"), "the available selected action reached its responsible effect-declaration approval gate, not an upstream request/mode/missing-component refusal"); assert.equal(report.actionReceipts.length, 0);
          }
        }
        assert.equal(report.executeNotes.length, admitted ? 1 : 0); assert.equal(report.physicalEffectCount, admitted ? 1 : 0, "independent physical file effect count");
      }
      for (const counts of Object.values(report.lifecycleCounts)) for (const count of Object.values(counts)) assert.equal(count, absent ? 0 : 1, "exact five-definition lifecycle count, including the unloaded control");
      assert.equal(report.probeCalls, 0, "an incompatible late deterministic binding never executes");
      if (scenario === "binding-safety") {
        const probeLifecycle = select("quality.component.lifecycle").filter(event => event.fields.data.packageId === "fixture.binding-control"); report.probeLifecycle = probeLifecycle;
        for (const phase of ["registered", "ready", "disposed"]) assert.equal(probeLifecycle.filter(event => event.fields.data.phase === phase).length, 1);
        assert.equal(report.bindingReads.length, 1, "the waiting binding was exercised with an actual SDK read");
        assert.equal(report.safetySnapshots.length, 6, "pending/late metadata plus four failed-apply controls are retained");
      }
      assert.deepEqual(report.extensionErrors, []); assert.deepEqual(report.effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 }); assert.deepEqual(report.remainingLocks, []); assert.equal(report.shutdownReturned, true); assert.deepEqual(report.privacy, { taskBodyInJournal: false, primaryBodyInJournal: false, resourceBodyInJournal: false });
    } catch (error) { failure ??= error; report.assertionFailure = { name: error.name, message: error.message }; }
    report.result = failure === null ? "AUTHOR_PASS" : "FAIL"; await save(join(root, "witness.json"), report);
  }
  if (failure !== null) throw failure;
}

if (process.argv[2] === "--installed-child") {
  try { await packedChild(JSON.parse(process.argv[3])); }
  catch (error) { console.error(error); process.exitCode = 1; }
} else {
  test("K08-T03 packed contributed evaluator/policy/action: admitted and responsible grant-denial boundaries", { timeout: 90_000 }, async t => {
    const evidence = process.env.QE_EVIDENCE_DIR;
    assert.ok(evidence && isAbsolute(evidence), "use the existing isolation wrapper or set a fresh absolute QE_EVIDENCE_DIR");
    const root = await mkdtemp(join(evidence, "installed-admission-")), source = fileURLToPath(new URL("../", import.meta.url));
    const baseline = await packageInputs(source);
    const env = await prepareEnvironment(root), mirror = join(root, "source-mirror"), engineMirror = join(mirror, "engine"), contributionMirror = join(mirror, "contributor");
    const artifacts = join(root, "artifacts"); await mkdir(artifacts, { recursive: true });
    for (const [name, expected] of Object.entries(baseline.payload)) {
      assert.ok(name.startsWith("dist/") || name.startsWith("resources/") || ["package.json", "README.md", "THIRD_PARTY_NOTICES.md"].includes(name));
      assert.deepEqual(await identity(join(source, name)), expected, "public compiled input stayed unchanged while preparing the removable mirror");
      await mkdir(dirname(join(engineMirror, name)), { recursive: true }); await copyFile(join(source, name), join(engineMirror, name));
    }
    const contributorSources = {};
    for (const name of ["package.json", "extension.mjs", "resources/k08-context.md"]) {
      const original = join(source, "examples", "independent-extension", name);
      if (existsSync(original)) { await mkdir(dirname(join(contributionMirror, name)), { recursive: true }); await copyFile(original, join(contributionMirror, name)); contributorSources[name] = await identity(original); }
    }
    const packages = {};
    for (const [name, cwd] of [["engine", engineMirror], ["contributor", contributionMirror], ["yaml", baseline.existingYaml.path]]) {
      const result = await runNative(join(root, "pack-" + name), npmCommand("pack", "--json", "--ignore-scripts", "--offline", "--pack-destination", artifacts), cwd, env);
      assert.equal(result.receipt.exit, 0, name + " local pack actually succeeded");
      const value = JSON.parse(result.stdout)[0], tar = join(artifacts, value.filename);
      packages[name] = { path: tar, ...await identity(tar), inventory: tarInventory(await readFile(tar)) };
    }
    assert.deepEqual(packages.engine.inventory, baseline.payload);
    const consumer = join(root, "consumer"); await mkdir(consumer);
    await save(join(consumer, "package.json"), { name: "k08-owned-admission-consumer", private: true, type: "module" });
    const install = await runNative(join(root, "install"), npmCommand("install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--legacy-peer-deps", "--package-lock=false", packages.engine.path, packages.contributor.path, packages.yaml.path), consumer, env);
    assert.equal(install.receipt.exit, 0, "only local artifacts are installed, without dependency fetching");
    const peer = join(consumer, "node_modules", "@earendil-works", "pi-coding-agent"); await mkdir(dirname(peer), { recursive: true }); await symlink(baseline.hostSdk.path, peer, "junction");
    const installed = {};
    for (const [name, directory] of [["engine", "pi-quality-engine"], ["contributor", "qe-independent-fixture"]]) {
      installed[name] = {};
      for (const [path, expected] of Object.entries(packages[name].inventory)) { const actual = await identity(join(consumer, "node_modules", directory, path)); assert.deepEqual(actual, expected); installed[name][path] = actual; }
    }
    await copyFile(fileURLToPath(import.meta.url), join(consumer, "driver.mjs"));
    await rm(mirror, { recursive: true, force: true });
    assert.equal(existsSync(mirror), false);
    await save(join(root, "package-bindings.json"), { packages, installed, contributorSources, mirrorRemovedBeforeSdkImports: true, hostPeer: baseline.hostSdk, networkDependencyFetching: false, engineBuild: "Caller-supplied coherent compiled public inputs repacked from the removable declared-input mirror. Build/source/dist/new-tar identities and acceptance remain separate packet readbacks; this harness performs no source build or fallback." });
    for (const scenario of SCENARIOS) {
      await t.test(scenario, { timeout: 20_000 }, async () => {
        const caseRoot = join(root, scenario), childEnv = await prepareEnvironment(caseRoot);
        const result = await runNative(join(caseRoot, "native"), [process.execPath, join(consumer, "driver.mjs"), "--installed-child", JSON.stringify({ root: caseRoot, consumer, scenario, mirror })], consumer, childEnv, 15_000);
        assert.equal(result.receipt.exit, 0, scenario + " actual installed child assertions passed");
        const witness = await json(join(caseRoot, "witness.json"));
        assert.equal(witness.result, "AUTHOR_PASS"); assert.equal(witness.shutdownReturned, true); assert.deepEqual(witness.remainingLocks, []);
      });
    }
    await save(join(root, "completion.json"), { scenarios: SCENARIOS, packageBindings: join(root, "package-bindings.json"), entireK08Accepted: false });
  });
}
