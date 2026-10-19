// K08 first packed trigger/context family. Only public Pi loading and C1
// discovery; the literal deterministic receiver is test instrumentation, not a
// shipped evaluator/policy/action replacement or a live judgment claim.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile, copyFile, readdir, realpath, rm, symlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import test from "node:test";

const RULE = "Repeated reads are evidence for investigation, not proof of an implementation defect.";
const PACKAGE_ID = "fixture.independent-extension";
const CONTEXT_ID = "fixture.note";
const RECEIVER_ID = "fixture.installed-receiver";
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
  assert.equal(existsSync(mirror), false, "the owned engine/contributor packaging mirror is gone before imports");
  const report = { scenario, root, consumer, mirrorAbsentBeforeImports: true, evaluations: [], receiverReady: [], effects: { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 }, primaryReads: [], extensionErrors: [], cleanup: [] };
  let runner = null, stopped = false, failure = null;
  const until = async (read, accepts, label) => {
    const deadline = Date.now() + 5000;
    do { const value = await read(); if (accepts(value)) return value; await new Promise(resolvePromise => setTimeout(resolvePromise, 10)); } while (Date.now() < deadline);
    throw new Error("K08 deadline: " + label);
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
    // Both resolutions are from THIS installed module root, never a checkout
    // import, an engine private subpath, or NODE_PATH.
    const engine = join(consumer, "node_modules", "pi-quality-engine");
    const contributor = join(consumer, "node_modules", "qe-independent-fixture");
    const contractUrl = import.meta.resolve("pi-quality-engine/contracts");
    assert.equal(await realpath(fileURLToPath(contractUrl)), await realpath(join(engine, "dist/contracts.js")));
    const beforeContracts = await allFiles(process.env.PI_CODING_AGENT_DIR);
    await import("pi-quality-engine/contracts");
    assert.deepEqual(await allFiles(process.env.PI_CODING_AGENT_DIR), beforeContracts, "installed public contracts import is inert");
    report.publicContracts = { url: contractUrl, ...await identity(fileURLToPath(contractUrl)), inert: true };
    const sdk = await import("@earendil-works/pi-coding-agent");
    report.sdkUrl = import.meta.resolve("@earendil-works/pi-coding-agent");
    const agentDir = process.env.PI_CODING_AGENT_DIR, project = join(root, "project");
    await mkdir(project, { recursive: true });
    await mkdir(join(agentDir, "quality"), { recursive: true });
    const config = {
      schemaVersion: 1, enabled: true, mode: "observe",
      prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
      contexts: { "packed-note": { providers: scenario === "context-omitted" ? [{ id: "waits", use: "core.waits" }] : [{ id: "note", use: CONTEXT_ID }, { id: "waits", use: "core.waits" }] } },
      evaluators: { "packed-receiver": { use: RECEIVER_ID } },
      policies: { record: { use: "core.record-only" } },
      checks: { repetition: { triggers: [{ id: "packed-burst", use: "fixture.burst-tools", options: { count: 2 } }], context: "packed-note", prompt: "repetition", evaluator: "packed-receiver", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
    };
    await save(join(agentDir, "quality", "config.json"), config);
    report.configuration = config;
    const paths = [];
    for (const packageRoot of scenario === "contributor-absent" ? [engine] : [engine, contributor]) {
      const manifest = await json(join(packageRoot, "package.json"));
      assert.equal(manifest.pi.extensions.length, 1);
      const entry = resolve(packageRoot, manifest.pi.extensions[0]);
      assert.equal(inside(packageRoot, entry), true);
      paths.push(entry);
    }
    const loader = new sdk.DefaultResourceLoader({
      cwd: project, agentDir, settingsManager: sdk.SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      additionalExtensionPaths: paths,
      extensionFactories: [pi => {
        let handle = null;
        pi.on("session_start", (_event, ctx) => {
          pi.events.emit("quality.registry.query.v1", { apiMajor: 1, observedSessionId: ctx.sessionManager.getSessionId(), reply(endpoint) {
            if (handle !== null) return;
            const result = endpoint.register({
              id: "fixture.installed-receiver-package", version: "0.1.0", baseUri: new URL(".", import.meta.url).href, resources: {},
              components: [{
                id: RECEIVER_ID, apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["text", "json"], requiredCapabilities: [], diagnosticCodes: [], optionsSchema: { type: "object", additionalProperties: false },
                async evaluate(_opts, input) {
                  // Same receiver in every case: its decision depends ONLY on
                  // actual delivered context, not the scenario/registry state.
                  const document = input.context.items.flatMap(item => item.content).find(part => part.type === "json" && typeof part.value?.document === "string")?.value.document ?? null;
                  const complete = document !== null && document.includes(RULE);
                  const result = { operational: "completed", coverage: { state: complete ? "complete" : "insufficient", scopeDescription: "Packaged repetition investigation note.", issues: [] }, conclusion: complete ? "no-supported-finding" : "undetermined", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };
                  report.evaluations.push({ input: JSON.parse(JSON.stringify(input)), document, returned: result });
                  return result;
                },
              }],
            });
            assert.equal(result.ok, true);
            handle = result.value;
            handle.ready.then(value => report.receiverReady.push({ ok: value.ok, registrationId: handle.registrationId, generation: handle.generation }));
          } });
        });
        pi.on("session_shutdown", async () => { if (handle !== null) { await handle.ready; await handle.dispose(); } });
      }],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    report.loadErrors = loaded.errors;
    assert.deepEqual(loaded.errors, []);
    const models = await sdk.ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, modelsStorePath: join(root, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
    report.modelDispatches = 0;
    for (const method of ["stream", "complete", "streamSimple", "completeSimple", "classify", "generateImages"]) models[method] = () => { report.modelDispatches += 1; throw new Error("Unapproved model boundary reached"); };
    runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, project, sdk.SessionManager.inMemory(project), new sdk.ModelRegistry(models));
    const noop = () => {}, messages = [], effects = report.effects;
    runner.bindCore({
      sendMessage: () => { effects.sendMessage += 1; }, sendUserMessage: () => { effects.sendUserMessage += 1; }, appendEntry: () => { effects.appendEntry += 1; },
      setSessionName: noop, getSessionName: () => undefined, setLabel: noop, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: noop, getThinkingLevel: () => "off", setThinkingLevel: noop,
    }, {
      getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, abort: () => { effects.abort += 1; }, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => "",
    });
    runner.setUIContext({ ...runner.getUIContext(), notify: message => messages.push(message) }, "rpc");
    report.loadedPaths = runner.getExtensionPaths();
    assert.equal(paths.every(path => report.loadedPaths.map(value => resolve(value)).includes(resolve(path))), true);
    const errors = report.extensionErrors; runner.onError(error => errors.push({ event: error.event, error: String(error.error) }));
    const status = async () => { await runner.getCommand("quality").handler("status", runner.createCommandContext()); return JSON.parse(messages.at(-1)); };
    await runner.emit({ type: "session_start", reason: "startup" });
    report.readyStatus = await until(status, value => report.receiverReady.length === 1 && (scenario === "contributor-absent" ? value.checks.detail[0]?.state !== "active" : value.checks.detail[0]?.state === "active"), "explicit component readiness");
    assert.equal(report.receiverReady[0].ok, true);
    await writeFile(join(project, "work.txt"), "K08_OWNED_READ_CANARY\nA bounded repeated read can be legitimate.\n", "utf8");
    await runner.emitInput("Inspect the same owned work note twice; use the configured bounded check.", undefined, "interactive");
    const read = sdk.createReadTool(project);
    for (const toolCallId of ["packed-read-1", "packed-read-2"]) {
      const args = { path: "work.txt" };
      await runner.emit({ type: "tool_execution_start", toolCallId, toolName: "read", args });
      const result = await read.execute(toolCallId, args, new AbortController().signal);
      report.primaryReads.push({ toolCallId, result });
      await runner.emit({ type: "tool_execution_end", toolCallId, toolName: "read", result, isError: false, durationMs: 1 });
      if (toolCallId === "packed-read-1") { report.afterOne = await status(); assert.equal(report.evaluations.length, 0, "one completion cannot satisfy the contributed count2 trigger"); }
    }
    if (scenario === "contributor-absent") {
      // Synchronize through real input/status boundaries, not a green skip.
      await runner.emitInput("The two actual reads are complete.", undefined, "interactive");
      report.afterTwo = await status();
      assert.equal(report.evaluations.length, 0);
      assert.equal(report.afterTwo.checks.runs, 0);
      assert.equal(report.afterTwo.registry.packages.some(item => item.packageId === PACKAGE_ID), false);
      assert.match(JSON.stringify(report.afterTwo.checks.detail), /waiting|missing/u);
    } else {
      report.afterTwo = await until(status, value => value.diagnostics.recentEvents.some(event => event.event === "quality.check.settled"), "actual canonical check result");
      assert.equal(report.afterTwo.checks.runs, 1);
      assert.equal(report.evaluations.length, 1);
      const evaluation = report.evaluations[0];
      const expected = scenario === "positive" ? "no-supported-finding" : "undetermined";
      const canonical = report.afterTwo.diagnostics.recentEvents.find(event => event.event === "quality.assessment.result");
      const settled = report.afterTwo.diagnostics.recentEvents.find(event => event.event === "quality.check.settled");
      report.canonical = canonical; report.settled = settled;
      assert.equal(evaluation.returned.conclusion, expected, "the contributed context must change actual canonical output, not only register");
      assert.equal(canonical.fields.data.conclusion, expected, "normal validation accepted the actual receiver result");
      assert.equal(settled.fields.data.conclusion, expected);
      if (scenario === "positive") {
        assert.ok(evaluation.document.includes(RULE), "packaged context reaches the actual evaluation input");
        const resource = join(contributor, "resources", "k08-context.md");
        assert.equal(evaluation.document, await readFile(resource, "utf8"));
        report.resource = { path: resource, ...await identity(resource) };
        const item = evaluation.input.context.items.find(value => value.provenance.sourceId === CONTEXT_ID);
        assert.equal(item.provenance.uri, pathToFileURL(resource).href, "resource acquisition is from the installed package, not its surviving checkout");
        assert.equal(item.provenance.revision, "sha256:" + report.resource.sha256);
      } else assert.equal(evaluation.document, null, "same trigger/evaluator with the contributed context omitted must remain undetermined");
    }
    assert.equal(report.primaryReads.length, 2);
    assert.deepEqual(errors, []);
    assert.equal(report.modelDispatches, 0);
    assert.deepEqual(effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 });
    await runner.emit({ type: "session_shutdown", reason: "quit" }); stopped = true;
    report.retired = await status();
    const entry = report.retired.registry.packages.find(item => item.packageId === PACKAGE_ID);
    report.contributorDisposals = entry?.phase === "disposed" ? 1 : 0;
    assert.equal(report.contributorDisposals, scenario === "contributor-absent" ? 0 : 1);
    report.lifecycle = report.retired.diagnostics.recentEvents.filter(event => event.event === "quality.component.lifecycle");
  } catch (error) { failure = error; report.failure = { name: error.name, message: error.message }; }
  finally {
    if (runner !== null && !stopped) {
      try { await runner.emit({ type: "session_shutdown", reason: "quit" }); stopped = true; report.cleanup.push({ label: "real session shutdown", returned: true }); }
      catch (error) { report.cleanup.push({ label: "real session shutdown", returned: false, message: error.message }); failure ??= error; }
    }
    if (runner !== null) runner.invalidate("K08 owned case ended");
    report.shutdownReturned = stopped;
    const stateFiles = await allFiles(process.env.PI_CODING_AGENT_DIR);
    report.finalStateFiles = stateFiles;
    report.remainingLocks = stateFiles.filter(path => path.endsWith(".lock"));
    const journal = (await Promise.all(stateFiles.filter(path => /\.jsonl(?:\.gz)?$/u.test(path)).map(async path => { const bytes = await readFile(path); return (path.endsWith(".gz") ? gunzipSync(bytes) : bytes).toString("utf8"); }))).join("\n");
    report.privacy = { sourceBodyInJournal: journal.includes(RULE), primaryBodyInJournal: journal.includes("K08_OWNED_READ_CANARY") };
    // Ready events and post-close disposal events occupy different bounded
    // readbacks. Count logical events once, preserving both actual domains.
    const records = journal.split("\n").filter(Boolean).map(line => JSON.parse(line));
    const snapshots = [report.readyStatus, report.afterTwo, report.retired].flatMap(value => value?.diagnostics.recentEvents ?? []);
    const lifecycle = [...new Map([...records, ...snapshots].filter(event => event.event === "quality.component.lifecycle" && event.fields.data.packageId === PACKAGE_ID).map(event => [event.eventId, event])).values()];
    report.contributorLifecycle = lifecycle;
    report.lifecycleCounts = Object.fromEntries(["registered", "ready", "disposed"].map(phase => [phase, Object.fromEntries(["fixture.burst-tools", CONTEXT_ID].map(id => [id, lifecycle.filter(event => event.fields.data.phase === phase && event.fields.data.componentId === id).length]))]));
    report.admittedContributorRegistrations = new Set(lifecycle.map(event => event.fields.data.registrationId)).size;
    report.lifecycleEvidence = "Logical event IDs joined across complete available physical journal and explicit public snapshots; not a claim all disposal events were persisted.";
    try {
      const expected = scenario === "contributor-absent" ? 0 : 1;
      assert.equal(report.admittedContributorRegistrations, expected);
      for (const counts of Object.values(report.lifecycleCounts)) for (const count of Object.values(counts)) assert.equal(count, expected, "exact contributed readiness/disposal count");
      assert.deepEqual(report.extensionErrors, []);
      assert.equal(report.modelDispatches, 0);
      assert.deepEqual(report.effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 });
    } catch (error) { failure ??= error; }
    if (report.remainingLocks.length !== 0 || report.privacy.sourceBodyInJournal || report.privacy.primaryBodyInJournal) failure ??= new Error("Owned lock or Standard privacy boundary failed");
    report.result = failure === null ? "AUTHOR_PASS" : "FAIL";
    await save(join(root, "witness.json"), report);
  }
  if (failure !== null) throw failure;
}

if (process.argv[2] === "--installed-child") {
  try { await packedChild(JSON.parse(process.argv[3])); }
  catch (error) { console.error(error); process.exitCode = 1; }
} else {
  test("K08-T01 packed independent trigger/context: actual input/output, omission and missing-contributor controls", { timeout: 90_000 }, async t => {
    const evidence = process.env.QE_EVIDENCE_DIR;
    assert.ok(evidence && isAbsolute(evidence), "use the existing isolation wrapper or set a fresh absolute QE_EVIDENCE_DIR");
    const root = await mkdtemp(join(evidence, "installed-family-")), source = fileURLToPath(new URL("../", import.meta.url));
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
    await save(join(consumer, "package.json"), { name: "k08-contained-consumer", private: true, type: "module" });
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
    await save(join(root, "package-bindings.json"), { packages, installed, contributorSources, mirrorRemovedBeforeSdkImports: true, hostPeer: baseline.hostSdk, networkDependencyFetching: false, engineBuild: "Current compiled public payloads repacked only from the removable declared-input mirror; no core/source build or edit. Acceptance and immutable-artifact equality are separate packet readbacks." });
    for (const scenario of ["positive", "context-omitted", "contributor-absent"]) {
      await t.test(scenario, { timeout: 20_000 }, async () => {
        const caseRoot = join(root, scenario), childEnv = await prepareEnvironment(caseRoot);
        const result = await runNative(join(caseRoot, "native"), [process.execPath, join(consumer, "driver.mjs"), "--installed-child", JSON.stringify({ root: caseRoot, consumer, scenario, mirror })], consumer, childEnv, 15_000);
        assert.equal(result.receipt.exit, 0, scenario + " actual installed child assertions passed");
        const witness = await json(join(caseRoot, "witness.json"));
        assert.equal(witness.result, "AUTHOR_PASS"); assert.equal(witness.shutdownReturned, true); assert.deepEqual(witness.remainingLocks, []);
      });
    }
    await save(join(root, "completion.json"), { scenarios: ["positive", "context-omitted", "contributor-absent"], packageBindings: join(root, "package-bindings.json"), entireK08Accepted: false });
  });
}
