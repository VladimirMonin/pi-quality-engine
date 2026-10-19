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

// The original required observation predicate is retained unchanged. New source
// controls additionally exercise the independently packed example, not counters.
const PACKAGE_ID = "fixture.independent-extension", CONTEXT_ID = "fixture.note", EVALUATOR_ID = "fixture.audit-evaluator", POLICY_ID = "fixture.audit-policy", ACTION_ID = "fixture.audit-file";
const ROLE_IDS = ["fixture.burst-tools", CONTEXT_ID, EVALUATOR_ID, POLICY_ID, ACTION_ID, "fixture.mutating-sink", "fixture.projected-sink", "fixture.stalled-sink", "fixture.observation"];
const RULE = "Repeated reads are evidence for investigation, not proof of an implementation defect.";
const TASK = "Assess the neutral synthetic work. Investigation alone is not a defect.";
const ROLE_SCENARIOS = ["observation-required", "opposite-order", "delayed-ready", "validation", "missing-dependency", "unload-reregister", "late-ready", "generation-replacement", "sink-failure", "example-observation", "example-observation-denied", "observation-lifecycle", "observation-late-start"];

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

async function rolesChild(options) {
  const { root, consumer, scenario, mirror } = options;
  assert.equal(existsSync(mirror), false, 'no packaging source mirror at execution');
  const report = { scenario, root, consumer, providerCalls: [], primaryReads: [], snapshots: [], controls: [], effects: { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 }, extensionErrors: [], validation: [], sink: { creates: 0, writes: 0, flushes: 0, disposes: 0 }, cleanup: [] };
  let runner = null, endpoint = null, status = null, control = null, failure = null, stopped = false, off = null, bus = null;
  let releaseModel = () => {}, holdModel = false, modelGate = null, pendingProviders = 0;
  let observationContext = null, observationStarts = 0, observationDisposes = 0;
  const endpoints = [], captured = new Map(), messages = [];
  report.collectors = [];
  const capture = value => { for (const event of value.diagnostics.recentEvents) captured.set([event.observedSessionId, event.fields.scope.runtimeGeneration, event.eventId].join('|'), event); report.snapshots.push(value); return value; };
  const allFiles = async directory => {
    const result = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const p = join(directory, entry.name);
      if (entry.isDirectory()) result.push(...await allFiles(p)); else if (entry.isFile()) result.push(p);
    }
    return result;
  };
  const until = async (read, accepts, label) => {
    const deadline = Date.now() + 5000;
    do { const value = await read(); if (accepts(value)) return value; await new Promise(r => setTimeout(r, 10)); } while (Date.now() < deadline);
    throw new Error('331 deadline: ' + label);
  };
  const meta = id => ({ id, apiMajor: 1, requiredCapabilities: [], diagnosticCodes: [], optionsSchema: { type: 'object', additionalProperties: false } });
  const noAction = () => ({ outcome: 'no-action', reasonCode: 'probe.none', actions: [] });
  const register = (id, components, extra = {}) => endpoint.register({ id, version: '0.1.0', baseUri: pathToFileURL(root + '/').href, resources: {}, components, ...extra });
  const events = name => [...captured.values()].filter(e => e.event === name);
  const componentPhases = (instance, phase) => events('quality.component.lifecycle').filter(e => e.fields.scope.runtimeGeneration === instance.generation && e.fields.data.registrationId === instance.registrationId && e.fields.data.packageId === PACKAGE_ID && e.fields.data.phase === phase);
  try {
    const engine = join(consumer, 'node_modules/pi-quality-engine'), contributor = join(consumer, 'node_modules/qe-independent-fixture');
    const contract = import.meta.resolve('pi-quality-engine/contracts');
    assert.equal(await realpath(fileURLToPath(contract)), await realpath(join(engine, 'dist/contracts.js')));
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    const before = await allFiles(agentDir); await import('pi-quality-engine/contracts'); assert.deepEqual(await allFiles(agentDir), before);
    report.publicContracts = { inert: true, url: contract, ...await identity(fileURLToPath(contract)) };
    const sdk = await import('@earendil-works/pi-coding-agent');
    report.sdkUrl = import.meta.resolve('@earendil-works/pi-coding-agent');
    const project = join(root, 'project'); await mkdir(project); await mkdir(join(agentDir, 'quality'));
    const configPath = join(agentDir, 'quality/config.json'), audit = join(root, 'audit-1.json');
    const config = {
      schemaVersion: 1, enabled: true, mode: 'advise',
      modelProfiles: { scripted: { provider: 'qe-k08-scripted', model: 'audit-1', maxOutputTokens: 128, price: 'unknown' } },
      permissions: { modelProfiles: ['scripted'], actions: [ACTION_ID] },
      prompts: { audit: { use: 'core.prompt-files', options: { instructions: ['builtin:repetition-v1.md'] } } },
      contexts: { work: { providers: [{ id: 'note', use: CONTEXT_ID }, { id: 'task', use: 'core.task' }, { id: 'waits', use: 'core.waits' }] } },
      evaluators: { audit: { use: scenario === 'missing-dependency' ? 'fixture.not-installed' : EVALUATOR_ID, modelProfile: 'scripted', options: { maxOutputTokens: 128 } } },
      policies: { audit: { use: POLICY_ID, options: { destination: pathToFileURL(audit).href } } },
      checks: { audit: { triggers: [{ id: 'once', use: 'core.every-tools', options: { count: 1 } }], context: 'work', prompt: 'audit', evaluator: 'audit', policy: 'audit', cooldownMs: 0, criteria: ['efficiency.repetition'], workStates: ['work-expected'] } },
    };
    if (scenario === 'sink-failure') config.observability = { sinks: [{ id: 'fixture.failure-sink', options: {} }] };
    if (scenario === 'generation-replacement') config.observability = { sinks: [{ id: 'probe.lifecycle-collector', options: {} }] };
    const sourceCase = ['example-observation','example-observation-denied','observation-lifecycle','observation-late-start'].includes(scenario);
    const collectGenerations = ['generation-replacement','observation-lifecycle','observation-late-start'].includes(scenario);
    if (sourceCase) {
      config.observationSources = { fixture: { use: 'fixture.observation', options: scenario === 'observation-late-start' ? { holdStart: true } : {} } };
      config.checks.audit.triggers = [{ id: 'signal', use: 'fixture.burst-tools', options: { count: 1 } }];
      if (scenario === 'example-observation-denied') config.permissions.actions = [];
    }
    if (collectGenerations) config.observability = { sinks: [{ id: 'probe.lifecycle-collector', options: {} }] };
    await save(configPath, config); report.configuration = structuredClone(config);
    const probe = pi => {
      bus = pi.events;
      let sid = null, collector = null;
      const accept = value => {
        if (value?.apiMajor !== 1 || value.observedSessionId !== sid) return;
        if (collector !== null && collector.generation !== value.engineGeneration) return;
        endpoint = value; if (!endpoints.includes(value)) endpoints.push(value);
        if (collectGenerations && collector === null) {
          const result = register('probe.lifecycle-collector-package', [{ ...meta('probe.lifecycle-collector'), kind: 'sink', create(_options, ctx) {
            const instance = { scope: structuredClone(ctx.scope), writes: 0, disposes: 0, afterDisposeWrites: 0, foreignScopeWrites: 0 };
            report.collectors.push(instance);
            return { write(record) {
              instance.writes++; if (instance.disposes > 0) instance.afterDisposeWrites++;
              if (record.fields.scope.runtimeGeneration !== instance.scope.runtimeGeneration) instance.foreignScopeWrites++;
              const snapshot = structuredClone(record);
              captured.set([snapshot.observedSessionId, snapshot.fields.scope.runtimeGeneration, snapshot.eventId].join('|'), snapshot);
            }, async flush() {}, dispose() { instance.disposes++; } };
          } }]);
          assert.equal(result.ok, true); collector = result.value;
        }
      };
      pi.on('session_start', (_event, ctx) => { sid = ctx.sessionManager.getSessionId(); collector = null; off?.(); off = pi.events.on('quality.registry.available.v1', accept); pi.events.emit('quality.registry.query.v1', { apiMajor: 1, observedSessionId: sid, reply: accept }); });
      pi.on('session_shutdown', () => { off?.(); off = null; });
    };
    const paths = [];
    for (const directory of scenario === 'opposite-order' ? [contributor, engine] : [engine, contributor]) {
      const manifest = await json(join(directory, 'package.json')); const p = resolve(directory, manifest.pi.extensions[0]); assert.equal(inside(directory, p), true); paths.push(p);
    }
    const loader = new sdk.DefaultResourceLoader({ cwd: project, agentDir, settingsManager: sdk.SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: paths, extensionFactories: [probe] });
    await loader.reload(); const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
    const models = await sdk.ModelRuntime.create({ authPath: join(root, 'owned-empty-auth.json'), modelsPath: null, modelsStorePath: join(root, 'models-cache.json'), refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider('qe-k08-scripted', {
      name: '331 bounded scripted public receiver', api: 'qe-k08-api', apiKey: 'fixture-not-credential', baseUrl: 'http://127.0.0.1:9/not-used',
      models: [{ id: 'audit-1', name: 'bounded audit', api: 'qe-k08-api', input: ['text'], contextWindow: 32768, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
      streamSimple(model, input, requestOptions) {
        const delivered = JSON.parse(JSON.stringify(input)), complete = JSON.stringify(delivered).includes(RULE);
        const returned = { operational: 'completed', coverage: { state: complete ? 'complete' : 'insufficient', scopeDescription: 'Actual independently packaged note input.', issues: [] }, conclusion: complete ? 'no-supported-finding' : 'undetermined', findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };
        const call = { model: { provider: model.provider, id: model.id, api: model.api }, input: delivered, maxTokens: requestOptions?.maxTokens, returned, held: holdModel, returnedPhysically: false };
        report.providerCalls.push(call);
        const gate = holdModel ? modelGate : null;
        if (gate !== null) pendingProviders += 1;
        const message = { role: 'assistant', content: [{ type: 'text', text: JSON.stringify(returned) }], api: model.api, provider: model.provider, model: model.id, usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150 }, stopReason: 'stop', timestamp: Date.now() };
        const finish = async () => { if (gate !== null) await gate; if (!call.returnedPhysically) { call.returnedPhysically = true; if (gate !== null) pendingProviders -= 1; } return message; };
        return { async *[Symbol.asyncIterator]() { yield { type: 'start', partial: { ...message, content: [] } }; await finish(); yield { type: 'text_start', contentIndex: 0, partial: message }; yield { type: 'text_delta', contentIndex: 0, delta: message.content[0].text, partial: message }; yield { type: 'text_end', contentIndex: 0, content: message.content[0].text, partial: message }; yield { type: 'done', reason: 'stop', message }; }, result: finish };
      },
    });
    runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, project, sdk.SessionManager.inMemory(project), new sdk.ModelRegistry(models));
    const noop = () => {}, effects = report.effects;
    runner.bindCore({ sendMessage: () => { effects.sendMessage++; }, sendUserMessage: () => { effects.sendUserMessage++; }, appendEntry: () => { effects.appendEntry++; }, setSessionName: noop, getSessionName: () => undefined, setLabel: noop, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: noop, getThinkingLevel: () => 'off', setThinkingLevel: noop }, { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, abort: () => { effects.abort++; }, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => '' });
    runner.setUIContext({ ...runner.getUIContext(), notify: message => messages.push(message) }, 'rpc'); runner.onError(error => report.extensionErrors.push({ event: error.event, error: String(error.error) }));
    report.loadedPaths = runner.getExtensionPaths(); assert.equal(paths.every(p => report.loadedPaths.map(value => resolve(value)).includes(resolve(p))), true);
    assert.ok(report.loadedPaths.map(value => resolve(value)).indexOf(resolve(paths[0])) < report.loadedPaths.map(value => resolve(value)).indexOf(resolve(paths[1])), 'actual SDK load order, not just requested paths');
    const quality = runner.getCommand('quality'), lifecycle = runner.getCommand('fixture-lifecycle'); assert.ok(quality && lifecycle);
    status = async () => { await quality.handler('status', runner.createCommandContext()); return capture(JSON.parse(messages.at(-1))); };
    control = async command => { await lifecycle.handler(command, runner.createCommandContext()); const value = JSON.parse(messages.at(-1)); report.controls.push({ command, value }); return value; };
    const ready = async () => until(control.bind(null, 'status'), value => value.current?.ready?.ok === true, 'acknowledged actual package ready');
    const active = async () => until(status, value => value.checks.detail[0]?.state === 'active', 'normal configured check active');
    const reload = async () => { await save(configPath, config); await quality.handler('reload', runner.createCommandContext()); const s = await status(); assert.equal(s.configuration.rejection, null); return s; };
    const readTool = sdk.createReadTool(project);
    let readNumber = 0;
    const read = async () => {
      const id = 'roles-read-' + (++readNumber), args = { path: 'work.txt' };
      await runner.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'read', args });
      const result = await readTool.execute(id, args, new AbortController().signal); report.primaryReads.push({ id, result });
      await runner.emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'read', args, result, isError: false, durationMs: 1 });
    };
    const receipt = async destination => {
      await until(status, s => s.diagnostics.recentEvents.some(e => e.event === 'quality.action.receipt' && e.fields.data.state === 'completed') && existsSync(destination), 'real permitted receiver write and completed receipt');
      const value = await json(destination); assert.ok(value.actionId && value.run.runId && value.authorizationRevision); assert.equal(value.summary.coverage, 'complete');
      report.receivers ??= []; report.receivers.push({ path: destination, ...await identity(destination), value }); return value;
    };
    if (['delayed-ready', 'late-ready'].includes(scenario)) await control('hold-next');
    await runner.emit({ type: 'session_start', reason: 'startup' });
    assert.ok(endpoint); report.initialScope = { observedSessionId: endpoint.observedSessionId, generation: endpoint.engineGeneration };
    report.afterStart = await status();
    if (!['delayed-ready', 'late-ready'].includes(scenario)) await ready();
    else {
      const held = await control('status'); assert.equal(held.current.held, true); assert.equal(held.current.prepareCalls, 1); assert.equal(held.current.resourceReadStarts, 0); assert.equal(held.current.readyCallbacks, 0);
      assert.equal(report.afterStart.checks.detail[0].state, 'waiting', 'emit completion is not acknowledged readiness');
    }
    if (scenario === 'observation-required') {
      const result = register('probe.observation-package', [{ ...meta('probe.observation'), kind: 'observation', observationSchemas: { 'probe.signal': { type: 'object', properties: { changed: { type: 'boolean' } }, required: ['changed'], additionalProperties: false } }, start(_options, ctx) { observationContext = ctx; observationStarts++; return { dispose() { observationDisposes++; } }; } }, { ...meta('probe.observation-trigger'), kind: 'trigger', diagnosticCodes: ['probe.changed'], initialState: () => ({}), update(_options, input) { return { state: {}, nextDueMonoMs: null, intent: input.observation?.kind === 'probe.signal' ? { reasons: [{ code: 'probe.changed', evidenceIds: input.observation.evidenceIds }] } : null }; } }]);
      report.observationAdmission = result.ok ? { ok: true } : { ok: false, error: result.error };
      report.observationDownstream = result.ok ? 'not yet executed' : 'NOT_RUN after first responsible public refusal';
      assert.equal(result.ok, true, '331-F1: documented public observation role must be admitted');
      assert.equal((await result.value.ready).ok, true);
      config.observationSources = { external: { use: 'probe.observation' } }; config.checks.audit.triggers = [{ id: 'external', use: 'probe.observation-trigger' }];
      await reload(); await until(async () => observationContext, Boolean, 'activated actual public observation source');
      await runner.emitInput(TASK, undefined, 'interactive');
      const draft = { externalId: 'signal-1', kind: 'probe.signal', occurredAt: observationContext.clock().utc, visibility: 'complete', facts: { changed: true }, evidenceIds: [] };
      const published = observationContext.publish(draft); assert.equal(published.ok, true); report.observationPublished = published;
      await receipt(audit); observationContext.publish(draft); await status(); assert.equal(report.providerCalls.length, 1, 'duplicate external identity is not another check');
      report.observationDownstream = 'actual public publish changed normal check and permitted receiver';
    } else if (scenario === 'validation') {
      const calls = Object.fromEntries(['trigger','context','prompt','evaluator','policy','action','sink','observation','getter'].map(k => [k, 0]));
      const defs = [
        { ...meta('probe.trigger'), kind: 'trigger', initialState() { calls.trigger++; return {}; }, update() { calls.trigger++; return { state: {}, intent: null, nextDueMonoMs: null }; } },
        { ...meta('probe.context'), kind: 'context', produces: ['json'], collect() { calls.context++; throw new Error('unselected'); } },
        { ...meta('probe.prompt'), kind: 'prompt', build() { calls.prompt++; throw new Error('unselected'); } },
        { ...meta('probe.evaluator'), kind: 'evaluator', mechanism: 'deterministic', accepts: ['text'], evaluate() { calls.evaluator++; throw new Error('unselected'); } },
        { ...meta('probe.policy'), kind: 'policy', decide() { calls.policy++; return noAction(); } },
        { ...meta('probe.action'), kind: 'action', effects: ['probe.synthetic'], execute() { calls.action++; throw new Error('unselected'); } },
        { ...meta('probe.sink'), kind: 'sink', create() { calls.sink++; throw new Error('unselected'); } },
        { ...meta('probe.observation'), kind: 'observation', observationSchemas: { 'probe.signal': { type: 'object', additionalProperties: false } }, start() { calls.observation++; return {}; } },
      ];
      const admitted = register('probe.validation', defs); assert.equal(admitted.ok, true); assert.equal((await admitted.value.ready).ok, true);
      const repeated = register('probe.validation', defs); // A different package definition, not the same installed instance.
      assert.equal(repeated.ok, false); assert.equal(repeated.error.code, 'core.duplicate-component');
      const checks = [ ['foreign-owner', [{ ...meta('fixture.burst-tools'), kind: 'trigger', initialState: () => ({}), update() {} }], 'core.duplicate-component'], ['apiMajor', [{ ...meta('probe.major'), apiMajor: 2, kind: 'policy', decide: noAction }], 'core.invalid-component'], ['unknown-kind', [{ ...meta('probe.future'), kind: 'future-role' }], 'core.component-kind-unavailable'] ];
      const required = ['update', 'collect', 'build', 'evaluate', 'decide', 'execute', 'create', 'start'];
      for (let i=0;i<defs.length;i++) { const bad = { ...defs[i], id: 'probe.bad-' + defs[i].kind }; delete bad[required[i]]; checks.push(['missing-' + defs[i].kind, [bad], 'core.invalid-component']); }
      const getter = { ...meta('probe.accessor'), kind: 'policy' }; Object.defineProperty(getter, 'decide', { get() { calls.getter++; return noAction; }, enumerable: true }); checks.push(['accessor', [getter], 'core.invalid-component']);
      const sourceDefinition = defs.at(-1);
      checks.push(['observation-api-major',[{...sourceDefinition,id:'probe.version-source',apiMajor:2}],'core.invalid-component']);
      checks.push(['observation-core-namespace',[{...sourceDefinition,id:'probe.core-source',observationSchemas:{'core.operator-input':{type:'object'}}}],'core.invalid-component']);
      checks.push(['observation-schema-unsupported',[{...sourceDefinition,id:'probe.unsupported-schema',observationSchemas:{'probe.signal':{$ref:'https://not-used.invalid/schema'}}}],'core.invalid-component']);
      const accessorSchemas={};Object.defineProperty(accessorSchemas,'probe.signal',{enumerable:true,get(){calls.getter++;return {type:'object'};}});
      checks.push(['observation-schema-accessor',[{...sourceDefinition,id:'probe.schema-accessor',observationSchemas:accessorSchemas}],'core.invalid-component']);
      for (const [label, components, code] of checks) { const result = register('probe.validation-' + label, components); report.validation.push({ label, result }); assert.equal(result.ok, false, label); assert.equal(result.error.code, code, label); }
      const source = await control('status'); await control('repeat'); const repeat = await control('status'); assert.equal(repeat.lastRepeat.registrationId, source.current.registrationId); assert.equal(repeat.lastRepeat.sameReadyPromise, true); assert.equal(repeat.current.prepareCalls, 1);
      const counts = { ...calls }; const packageReads = repeat.current.resourceReads;
      for (let i=0;i<3;i++) { const s = await status(); const pkg = s.registry.packages.find(p => p.packageId === PACKAGE_ID); assert.equal(pkg.version, '0.1.0'); assert.equal(pkg.registrationId, source.current.registrationId); assert.equal(pkg.phase, 'ready'); assert.equal(pkg.readyComponents, ROLE_IDS.length); assert.ok(s.configuration.revision); }
      assert.deepEqual(calls, counts); assert.equal((await control('status')).current.resourceReads, packageReads); assert.equal(report.providerCalls.length, 0); assert.equal(report.primaryReads.length, 0); assert.deepEqual(Object.values(calls), Array(9).fill(0)); report.validationCalls = calls;
      await admitted.value.dispose(); await admitted.value.dispose();
    } else if (sourceCase) {
      report.sourceTransitions = [];
      const sourceOf = (snapshot, number) => [snapshot.currentSource, snapshot.previousSource].find(value => value?.number === number);
      const sourceReady = async previous => until(control.bind(null,'status'), value => value.currentSource?.startReturned === true && value.currentSource.number !== previous, 'actual configured source instance start');
      const retainedDenied = async (number, id) => {
        const snapshot = await control('publish-source ' + number + ' ' + id), source = sourceOf(snapshot,number);
        assert.ok(source); assert.deepEqual(source.results.at(-1),{ok:false,errorCode:'core.retired-generation'});
        report.sourceTransitions.push({phase:id,source}); return source;
      };
      await reload();
      if (scenario === 'observation-late-start') {
        const held = await until(control.bind(null,'status'),value=>value.currentSource!==null,'actual held source start entered');
        const old = held.currentSource; assert.equal(old.startReturned,false); assert.equal(old.disposals,0);
        await quality.handler('pause',runner.createCommandContext()); await retainedDenied(old.number,'paused-held');
        await quality.handler('resume',runner.createCommandContext());
        config.observationSources.fixture.options={holdStart:false}; await save(configPath,config);
        const before=performance.now(); await runner.emit({type:'session_start',reason:'reload'}); await ready();
        const current=(await sourceReady(old.number)).currentSource;
        await reload(); await active(); // Reapprove the current generation's actual action declaration.
        report.sourceLogicalReplacementMs=performance.now()-before;
        assert.notEqual(current.scope.runtimeGeneration,old.scope.runtimeGeneration);
        const unresolved=await control('status');assert.equal(unresolved.previousSource.startReturned,false);assert.equal(unresolved.previousSource.disposals,0);assert.equal(unresolved.previousSource.signalAborted,true);
        report.sourceStillPhysicalAfterLogicalReplacement=unresolved.previousSource;
        await retainedDenied(old.number,'retired-held');
        await control('release-source '+old.number);
        await until(control.bind(null,'status'),value=>value.previousSource?.number===old.number&&value.previousSource.startReturned&&value.previousSource.disposals===1,'late old source physically returned and disposed once');
        const after=await control('status');assert.equal(after.currentSource.number,current.number);assert.equal(after.currentSource.signalAborted,false);assert.equal(after.currentSource.disposals,0);
        report.sourceTransitions.push({phase:'late-old-released',snapshot:after});
      } else await sourceReady();
      await active();
      const initial=await control('status');report.actualExampleSource=initial.currentSource;
      assert.equal(initial.currentSource.signalAborted,false);assert.equal(initial.currentSource.disposals,0);
      assert.equal(initial.currentSource.scope.observedSessionId,endpoint.observedSessionId);
      const packageReads=initial.current.resourceReads;
      for(let i=0;i<3;i++)await status();
      const inspected=await control('status');assert.equal(inspected.currentSource.number,initial.currentSource.number);assert.equal(inspected.current.resourceReads,packageReads);assert.equal(report.providerCalls.length,0);
      await runner.emitInput(TASK,undefined,'interactive');await control('observe signal-1');
      await until(status,value=>value.diagnostics.recentEvents.some(event=>event.event==='quality.check.settled'),'published observation caused normal check settlement');
      if(scenario==='example-observation-denied'){
        const admissions=events('quality.action.admission');assert.equal(admissions.length,1);assert.equal(admissions[0].fields.data.outcome,'rejected');assert.ok(admissions[0].fields.reasonCodes.includes('core.action-effects-unapproved'));assert.equal(existsSync(audit),false);assert.equal(events('quality.action.receipt').length,0);
      }else await receipt(audit);
      assert.equal(report.providerCalls.length,1);assert.equal(report.primaryReads.length,0,'the contributed observation, not an incidental primary tool, triggered the check');
      assert.equal(JSON.stringify(report.providerCalls[0].input).includes(RULE),true);assert.equal(report.providerCalls[0].returned.coverage.state,'complete');
      assert.ok(events('quality.assessment.result').some(event=>event.fields.data.validationState==='valid'));
      assert.ok(events('quality.trigger.due').some(event=>event.fields.data.componentId==='fixture.burst-tools'));
      const accepted=(await control('status')).currentSource.results.at(-1);assert.equal(accepted.ok,true);assert.ok(accepted.observationId);
      await control('observe signal-1');await status();assert.deepEqual((await control('status')).currentSource.results.at(-1),accepted);assert.equal(report.providerCalls.length,1,'same-source externalId duplicate is not another assessment');
      await control('observe-bad invalid-facts');await status();assert.deepEqual((await control('status')).currentSource.results.at(-1),{ok:false,errorCode:'core.invalid-observation'});
      await control('observe-foreign invalid-evidence');await status();assert.deepEqual((await control('status')).currentSource.results.at(-1),{ok:false,errorCode:'core.invalid-observation'});
      let getters=0;const facts={};Object.defineProperty(facts,'changed',{enumerable:true,get(){getters++;return true;}});bus.emit('fixture.observation.input.v1',{externalId:'getter',facts});await status();assert.equal(getters,0);assert.equal((await control('status')).currentSource.results.at(-1).ok,false);assert.equal(report.providerCalls.length,1);
      report.sourceValidation={accepted,invalidFacts:true,unissuedEvidence:true,getterCalls:getters,duplicateRequests:report.providerCalls.length};
      if(scenario==='observation-lifecycle'){
        await quality.handler('stop',runner.createCommandContext());
        const old=(await control('status')).currentSource;
        await quality.handler('pause',runner.createCommandContext());await until(control.bind(null,'status'),value=>value.currentSource.signalAborted&&value.currentSource.disposals===1,'source pause disposes once');await retainedDenied(old.number,'paused');
        await quality.handler('resume',runner.createCommandContext());let current=(await sourceReady(old.number)).currentSource;assert.equal(current.signalAborted,false);await retainedDenied(old.number,'resumed-old');
        await control('observe current-after-resume');assert.equal((await control('status')).currentSource.results.at(-1).ok,true);assert.equal(report.providerCalls.length,1);
        const revision=(await status()).configuration.revision;
        for(const [name,reference,field] of [['wrong-role',{use:POLICY_ID,options:{destination:pathToFileURL(audit).href}},'use'],['invalid-options',{use:'fixture.observation',options:{holdStart:'invalid'}},'options']]){
          const bad=structuredClone(config);bad.observationSources.fixture=reference;await save(configPath,bad);await quality.handler('reload',runner.createCommandContext());const s=await status();assert.equal(s.configuration.revision,revision);assert.equal((await control('status')).currentSource.number,current.number);const rejected=events('quality.config.rejected').at(-1);assert.deepEqual(rejected.fields.data.errorCodes,['config.invalid-value']);assert.deepEqual(rejected.fields.data.fieldPaths,['$.observationSources.fixture.'+field]);report.sourceTransitions.push({phase:name,configuration:s.configuration});
        }
        config.observationSources.fixture.options={holdStart:false};await reload();const beforeOptions=current;current=(await sourceReady(current.number)).currentSource;await retainedDenied(beforeOptions.number,'replaced-options');assert.equal(sourceOf(await control('status'),beforeOptions.number).disposals,1);
        const beforeUnload=current;await control('dispose');await until(control.bind(null,'status'),value=>value.currentSource.disposals===1,'unloaded source disposed once');await retainedDenied(beforeUnload.number,'unloaded');await control('register');await ready();current=(await sourceReady(beforeUnload.number)).currentSource;await active();await retainedDenied(beforeUnload.number,'reregistered-old');assert.notEqual(current.packageNumber,beforeUnload.packageNumber);
        const destination=join(root,'audit-2.json');config.policies.audit.options.destination=pathToFileURL(destination).href;await save(configPath,config);const oldGeneration=current;
        await runner.emit({type:'session_start',reason:'reload'});await ready();current=(await sourceReady(oldGeneration.number)).currentSource;await reload();assert.notEqual(current.scope.runtimeGeneration,oldGeneration.scope.runtimeGeneration);await retainedDenied(oldGeneration.number,'generation-old');
        const oldCallbacks=sourceOf(await control('status'),oldGeneration.number).callbacks;await control('observe stopped-new-generation');const observed=await control('status');assert.equal(observed.currentSource.results.at(-1).ok,true);assert.equal(observed.previousSource.callbacks,oldCallbacks,'unsubscribed old source receives no new feed callback');const s=await status();assert.equal(s.runtime.operatorStopped,true);assert.equal(s.accounting.ownedRequestCount,1);assert.equal(report.providerCalls.length,1);assert.equal(existsSync(destination),false);report.sourceFinalScope=s;
      }
      const finalSource=await control('status');report.sourceBeforeShutdown=finalSource;assert.equal((await status()).accounting.ownedRequestCount,1);
    } else {
      await writeFile(join(project, 'work.txt'), 'K08_ROLES_READ_CANARY\nA neutral synthetic local input.\n', 'utf8');
      if (scenario === 'late-ready') {
        const old = (await control('status')).current; await control('dispose'); await status(); await control('register'); const current = (await ready()).current; await reload(); await active();
        assert.notEqual(current.registrationId, old.registrationId); assert.equal(current.generation, old.generation);
        await control('release ' + old.number); await until(control.bind(null,'status'), v => v.previous?.readyCallbacks === 1, 'obsolete preparation physically returned');
        const retained = await control('status'); assert.equal(retained.previous.ready.ok, false); assert.equal(retained.previous.signalAborted, true); assert.equal(retained.current.ready.ok, true); assert.equal(retained.sameLifecycleAsPrevious, false);
        await active(); assert.equal(componentPhases(old,'ready').length, 0); report.lateOldInstance = retained;
      } else if (scenario === 'delayed-ready') {
        const held = (await control('status')).current; await control('repeat'); assert.equal((await control('status')).lastRepeat.registrationId, held.registrationId);
        await runner.emitInput(TASK, undefined, 'interactive'); await read(); const waiting = await status(); assert.equal(waiting.checks.runs, 0); assert.equal(report.providerCalls.length, 0); assert.equal(existsSync(audit), false);
        await control('release ' + held.number); const actual = (await ready()).current; assert.equal(actual.prepareCalls, 1); assert.equal(actual.resourceReads, 1); assert.equal(actual.readyCallbacks, 1); await reload(); await active();
      } else if (scenario !== 'missing-dependency') { await reload(); await active(); }
      if (scenario === 'sink-failure') {
        const result = register('probe.failure-sink', [{ ...meta('fixture.failure-sink'), kind: 'sink', create() { report.sink.creates++; return { write() { report.sink.writes++; throw new Error('K08_SINK_EXCEPTION_CANARY'); }, flush() { report.sink.flushes++; throw new Error('K08_SINK_EXCEPTION_CANARY'); }, dispose() { report.sink.disposes++; } }; } }]);
        assert.equal(result.ok, true); assert.equal((await result.value.ready).ok, true); await reload();
      }
      await runner.emitInput(TASK, undefined, 'interactive'); await read();
      if (scenario === 'missing-dependency') {
        const s = await status(); assert.equal(s.checks.detail[0].state, 'waiting'); assert.match(JSON.stringify(s.checks.detail[0].missing), /evaluator:audit/u); assert.equal(s.checks.runs, 0); assert.equal(report.providerCalls.length, 0); assert.equal(existsSync(audit), false);
      } else {
        const first = await receipt(audit); report.positiveRun = first.run; assert.equal(report.providerCalls.length, 1); assert.equal(JSON.stringify(report.providerCalls[0].input).includes(RULE), true); assert.equal(report.providerCalls[0].returned.coverage.state, 'complete');
        if (scenario === 'unload-reregister') {
          const old = (await control('status')).current; await control('dispose'); await control('dispose'); const disposed = await status(); assert.equal(disposed.checks.detail[0].state,'waiting');
          await read(); assert.equal(report.providerCalls.length,1); await control('register'); const current = (await ready()).current;
          assert.notEqual(current.registrationId,old.registrationId); assert.equal(current.generation,old.generation); assert.equal((await control('status')).sameLifecycleAsPrevious,false);
          const now = await active(); const oldStatus = now.registry.packages.find(p=>p.registrationId===old.registrationId);
          assert.equal(oldStatus.phase,'disposed'); assert.equal(oldStatus.readyComponents,0,'disposed registration must not borrow replacement readiness');
          await control('repeat'); assert.equal((await control('status')).lastRepeat.registrationId,current.registrationId);
          const beforeNotes = events('quality.component.note').length; await control('note '+current.number); await status(); assert.equal(events('quality.component.note').length,beforeNotes+1,'live retained C1 diagnostic facet positive control');
          await control('note '+old.number); await status(); assert.equal(events('quality.component.note').length,beforeNotes+1,'obsolete registration callback cannot gain replacement authority');
          report.instanceReplacement={old,current,after:await control('status')};
          const next=join(root,'audit-2.json'); config.policies.audit.options.destination=pathToFileURL(next).href; await reload(); await read(); await receipt(next); assert.equal(report.providerCalls.length,2);
        }
        if (scenario === 'generation-replacement') {
          const oldEndpoint=endpoint, old=(await control('status')).current;
          const next=join(root,'audit-2.json'); config.policies.audit.options.destination=pathToFileURL(next).href; await reload();
          modelGate=new Promise(r=>{releaseModel=r;});holdModel=true;await read();await until(async()=>report.providerCalls.length,n=>n===2,'actual held valid model request');assert.equal(pendingProviders,1);report.beforeStop=await status();assert.equal(report.beforeStop.accounting.ownedRequestCount,2);
          await quality.handler('stop',runner.createCommandContext());await runner.emit({type:'session_start',reason:'reload'});await ready();const replacement=await status();const current=(await control('status')).current;
          assert.notEqual(endpoint.engineGeneration,oldEndpoint.engineGeneration);assert.equal(endpoint.observedSessionId,oldEndpoint.observedSessionId);assert.equal(replacement.runtime.operatorStopped,true);assert.equal(replacement.accounting.ownedRequestCount,2,'shared ledger not reset by generation replacement');
          const obsolete=oldEndpoint.register({id:'probe.retired',version:'0.1.0',baseUri:pathToFileURL(root+'/').href,components:[{...meta('probe.retired-policy'),kind:'policy',decide:noAction}],resources:{}});assert.equal(obsolete.ok,false);assert.equal(obsolete.error.code,'core.retired-generation');report.obsoleteEndpoint=obsolete;
          const beforeNotes=events('quality.component.note').length;await control('note '+old.number);await status();assert.equal(events('quality.component.note').length,beforeNotes);
          bus.emit('quality.registry.available.v1',oldEndpoint);await new Promise(r=>setTimeout(r,0));await control('repeat');assert.equal((await control('status')).lastRepeat.registrationId,current.registrationId,'stale availability must not replace the current endpoint');
          releaseModel();holdModel=false;await until(async()=>pendingProviders,n=>n===0,'actual local held provider returned');await quality.handler('resume',runner.createCommandContext());await read();const final=await status();assert.equal(final.runtime.operatorStopped,true);assert.equal(report.providerCalls.length,2);assert.equal(existsSync(next),false,'late valid result cannot dispatch a stopped/obsolete effect');assert.equal(final.accounting.ownedRequestCount,2);report.afterReplacement=final;
        }
        if (scenario === 'sink-failure') {
          assert.equal(report.sink.creates,1);assert.ok(report.sink.writes>0);const beforeStop=await status();assert.equal(beforeStop.accounting.ownedRequestCount,1);await quality.handler('stop',runner.createCommandContext());await quality.handler('resume',runner.createCommandContext());await quality.handler('reload',runner.createCommandContext());await read();const final=await status();assert.equal(final.runtime.operatorStopped,true);assert.equal(report.providerCalls.length,1);assert.equal(final.accounting.ownedRequestCount,1);report.failedSinkStatus=final;
        }
      }
    }
    report.beforeShutdown=await status();report.finalControl=await control('status');
    await runner.emit({type:'session_shutdown',reason:'quit'});stopped=true;report.retired=await status();report.retiredControl=await control('status');
  } catch(error) { failure=error;report.failure={name:error.name,message:error.message}; }
  finally {
    releaseModel();
    if(runner!==null&&!stopped){try{await runner.emit({type:'session_shutdown',reason:'quit'});stopped=true;if(status)report.retired=await status();if(control)report.retiredControl=await control('status');}catch(error){report.cleanup.push({returned:false,message:error.message});failure??=error;}}
    if(runner!==null)runner.invalidate('331 installed roles case ended');
    report.shutdownReturned=stopped;report.pendingLocalProviders=pendingProviders;report.observation={starts:observationStarts,disposes:observationDisposes};
    const files=await allFiles(process.env.PI_CODING_AGENT_DIR);report.finalStateFiles=files;report.remainingLocks=files.filter(p=>p.endsWith('.lock'));
    const physical=(await Promise.all(files.filter(p=>/\.jsonl(?:\.gz)?$/u.test(p)).map(async p=>{const b=await readFile(p);return(p.endsWith('.gz')?gunzipSync(b):b).toString('utf8');}))).join('\n');
    const rows=physical.split('\n').filter(Boolean).map(line=>JSON.parse(line));report.physicalRecords=rows.length;
    for(const event of rows)captured.set([event.observedSessionId,event.fields.scope.runtimeGeneration,event.eventId].join('|'),event);
    report.events=[...captured.values()];report.lifecycle=events('quality.component.lifecycle').filter(e=>e.fields.data.packageId===PACKAGE_ID);
    report.modelDispatched=events('quality.model.dispatched');report.actionAdmissions=events('quality.action.admission');report.actionReceipts=events('quality.action.receipt');report.canonical=events('quality.assessment.result');report.policies=events('quality.policy.decided');
    report.privacy={resourceBodyInJournal:physical.includes(RULE),primaryBodyInJournal:physical.includes('K08_ROLES_READ_CANARY'),exceptionBodyInJournal:physical.includes('K08_SINK_EXCEPTION_CANARY')};
    try{
      assert.equal(stopped,true);assert.deepEqual(report.remainingLocks,[]);assert.equal(pendingProviders,0);assert.deepEqual(report.extensionErrors,[]);assert.deepEqual(report.effects,{sendMessage:0,sendUserMessage:0,appendEntry:0,abort:0});assert.deepEqual(report.privacy,{resourceBodyInJournal:false,primaryBodyInJournal:false,exceptionBodyInJournal:false});
      if(!failure){
        assert.equal(report.modelDispatched.length,report.providerCalls.length);assert.equal(report.observation.starts,scenario==='observation-required'?1:0);
        const instances=[report.retiredControl?.current,report.retiredControl?.previous].filter(Boolean);
        for(const instance of instances){assert.equal(componentPhases(instance,'registered').length,ROLE_IDS.length,'one registration lifecycle event per actual definition instance');assert.equal(componentPhases(instance,'disposed').length,ROLE_IDS.length,'once-only C1 disposal despite repeated handle calls');assert.equal(instance.prepareCalls,1);assert.equal(instance.readyCallbacks,1);assert.equal(instance.signalAborted,true);}
        if(scenario==='sink-failure')assert.equal(report.sink.disposes,1,'failing sink instance disposed once');
        if(['example-observation','example-observation-denied','observation-lifecycle','observation-late-start'].includes(scenario)){
          const sources=[report.retiredControl.currentSource,report.retiredControl.previousSource].filter(Boolean);
          for(const source of sources){assert.equal(source.startReturned,true);assert.equal(source.disposals,1,'actual source instance disposal, not just registration disposal');assert.equal(source.signalAborted,true);}
        }
        if(['generation-replacement','observation-lifecycle','observation-late-start'].includes(scenario)){
          assert.equal(report.collectors.length,2,'one actual public sink instance in each real generation');
          for(const instance of report.collectors){assert.ok(instance.writes>0);assert.equal(instance.disposes,1);assert.equal(instance.afterDisposeWrites,0);assert.equal(instance.foreignScopeWrites,0);}
          report.lifecycleEvidence='Unique full-scope projected DTOs received by a normal selected public C1 sink, joined with explicit status snapshots and physical journal. Post-close component disposal transport is not relabeled persisted.';
        }
        if(report.receivers)for(const receiver of report.receivers){const a=report.actionAdmissions.find(e=>e.fields.data.actionId===receiver.value.actionId);assert.ok(a);assert.equal(a.fields.data.outcome,'admitted');assert.ok(report.actionReceipts.some(e=>e.fields.data.actionId===receiver.value.actionId&&e.fields.data.state==='completed'));assert.ok(report.canonical.some(e=>e.fields.correlation.runId===receiver.value.run.runId&&e.fields.data.validationState==='valid'));}
      }
    }catch(error){failure??=error;report.failure??={name:error.name,message:error.message};}
    report.result=failure?'AUTHOR_FAIL':'AUTHOR_PASS';await save(join(root,'witness.json'),report);
  }
  if(failure)throw failure;
}

async function materialize(tarPath, destination) {
  const bytes = await readFile(tarPath), expected = tarInventory(bytes), tar = gunzipSync(bytes);
  for (let offset=0;offset+512<=tar.length;) {
    const header=tar.subarray(offset,offset+512);if(header.every(byte=>byte===0))break;
    const field=(a,b)=>header.subarray(a,b).toString('utf8').replace(/\0.*$/su,'');
    const prefix=field(345,500),name=(prefix?prefix+'/':'')+field(0,100),size=Number.parseInt(field(124,136).trim()||'0',8),kind=field(156,157);
    if(kind!=='5'){const target=resolve(destination,name.slice(8));assert.equal(inside(destination,target),true);await mkdir(dirname(target),{recursive:true});await writeFile(target,tar.subarray(offset+512,offset+512+size));}
    offset+=512+Math.ceil(size/512)*512;
  }
  const actual={};for(const[name,value]of Object.entries(expected)){actual[name]=await identity(join(destination,name));assert.deepEqual(actual[name],value);}
  return actual;
}

if (process.argv[2] === '--installed-child') {
  try { await rolesChild(JSON.parse(process.argv[3])); }
  catch (error) { console.error(error); process.exitCode=1; }
} else {
  test('K08 public roles and contribution lifecycle: coherent installed required family', {timeout:90000}, async t=>{
    const evidence=process.env.QE_EVIDENCE_DIR;assert.ok(evidence&&isAbsolute(evidence),'use the existing isolation wrapper with a fresh absolute evidence directory');
    const root=await mkdtemp(join(evidence,'installed-roles-lifecycle-')),source=fileURLToPath(new URL('../',import.meta.url));
    const baseline=await packageInputs(source),env=await prepareEnvironment(root),mirror=join(root,'source-mirror'),engineMirror=join(mirror,'engine'),contributorMirror=join(mirror,'contributor'),artifacts=join(root,'artifacts');await mkdir(artifacts);
    for(const[name,expected]of Object.entries(baseline.payload)){assert.deepEqual(await identity(join(source,name)),expected);await mkdir(dirname(join(engineMirror,name)),{recursive:true});await copyFile(join(source,name),join(engineMirror,name));}
    const contributorSources={};
    for(const name of ['package.json','extension.mjs','resources/k08-context.md','resources/k08-prompt.md']){const p=join(source,'examples/independent-extension',name);await mkdir(dirname(join(contributorMirror,name)),{recursive:true});await copyFile(p,join(contributorMirror,name));contributorSources[name]=await identity(p);}
    const packages={};
    for(const[name,cwd]of [['engine',engineMirror],['contributor',contributorMirror],['yaml',baseline.existingYaml.path]]){const result=await runNative(join(root,'pack-'+name),npmCommand('pack','--json','--ignore-scripts','--offline','--pack-destination',artifacts),cwd,env);assert.equal(result.receipt.exit,0,'actual local pack '+name);const value=JSON.parse(result.stdout)[0],p=join(artifacts,value.filename);packages[name]={path:p,...await identity(p),inventory:tarInventory(await readFile(p))};}
    assert.deepEqual(packages.engine.inventory,baseline.payload);
    const consumer=join(root,'consumer');await mkdir(consumer);await save(join(consumer,'package.json'),{name:'k08-installed-roles-lifecycle',private:true,type:'module'});
    const installed={};for(const[name,directory]of [['engine','pi-quality-engine'],['contributor','qe-independent-fixture'],['yaml','yaml']])installed[name]=await materialize(packages[name].path,join(consumer,'node_modules',directory));
    const peer=join(consumer,'node_modules/@earendil-works/pi-coding-agent');await mkdir(dirname(peer),{recursive:true});await symlink(baseline.hostSdk.path,peer,'junction');
    const own=join(consumer,'driver-roles.mjs');await copyFile(fileURLToPath(import.meta.url),own);
    const prior=[['trigger','k08-installed-contribution.test.mjs',['positive','context-omitted','contributor-absent']],['admission','k08-installed-admission.test.mjs',['admitted','request-outside-binding','request-run-outside-binding','effect-ungranted','selected-profile-unapproved','binding-safety','contributor-absent']],['sink-prompt','k08-installed-sink-prompt.test.mjs',['prompt-pair','sink-isolation','sink-unselected']]];
    const drivers={};for(const[label,name]of prior){const p=join(consumer,'driver-'+label+'.mjs');await copyFile(join(source,'test',name),p);drivers[label]={path:p,...await identity(p)};assert.deepEqual(await identity(join(source,'test',name)),await identity(p));}
    await rm(mirror,{recursive:true,force:true});assert.equal(existsSync(mirror),false);
    await save(join(root,'package-bindings.json'),{packages,installed,contributorSources,drivers,rolesDriver:{path:own,...await identity(own)},mirrorRemovedBeforeSdkImports:true,hostPeer:baseline.hostSdk,installation:'Exact regular tar payloads safely materialized and read back into a separate consumer. No npm/dependency installation or network; existing pinned SDK is the explicit sole host peer. YAML is a physical extracted declared dependency.',engineBuild:'Caller-supplied coherent owned build. No historical checkout dist substitution or source fallback.'});
    const cases=[...ROLE_SCENARIOS.map(scenario=>({label:'roles/'+scenario,scenario,driver:own,timeout:15000})),...prior.flatMap(([label,_name,scenarios])=>scenarios.map(scenario=>({label:'prior-'+label+'/'+scenario,scenario,driver:drivers[label].path,timeout:label==='sink-prompt'?20000:15000})))];
    const executions=[];
    for(const item of cases)await t.test(item.label,{timeout:item.timeout+5000},async()=>{
      const caseRoot=join(root,item.label),childEnv=await prepareEnvironment(caseRoot);const result=await runNative(join(caseRoot,'native'),[process.execPath,item.driver,'--installed-child',JSON.stringify({root:caseRoot,consumer,scenario:item.scenario,mirror})],consumer,childEnv,item.timeout);
      executions.push({label:item.label,receipt:result.receipt});assert.equal(result.receipt.exit,0,item.label+' actual installed assertions');const witness=await json(join(caseRoot,'witness.json'));assert.equal(witness.result,'AUTHOR_PASS');assert.equal(witness.shutdownReturned,true);assert.deepEqual(witness.remainingLocks,[]);
    });
    await save(join(root,'completion.json'),{logicalCases:cases.length,executions,failedNativeCases:executions.filter(v=>v.receipt.exit!==0).map(v=>v.label),requiredObservation:'Not skipped or converted to expected failure. Any actual refusal remains a required failure, with later boundaries uncredited.',entireK08Accepted:false});
  });
}
