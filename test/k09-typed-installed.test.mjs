// Narrow public installed-path proof. Archive handling adapts the existing K08
// role-neutrality fixture; the pinned public SDK is reused, not reinstalled.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, symlink, copyFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
const sha = b => createHash('sha256').update(b).digest('hex');
const json = async p => JSON.parse(await readFile(p, 'utf8'));
const inside = (r, p) => resolve(p) === resolve(r) || resolve(p).startsWith(resolve(r) + sep);
async function extract(tarball, destination) {
  const tar = gunzipSync(await readFile(tarball)), inventory = {};
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512); if (h.every(x => x === 0)) break;
    const field = (a, b) => h.subarray(a, b).toString('utf8').replace(/\0.*$/su, '');
    const name = (field(345, 500) ? field(345, 500) + '/' : '') + field(0, 100), n = Number.parseInt(field(124, 136).trim() || '0', 8), kind = field(156, 157);
    assert.ok(name.startsWith('package/') && !name.split('/').includes('..')); assert.ok(Number.isSafeInteger(n) && n >= 0);
    if (kind !== '5') { assert.ok(kind === '0' || kind === '', 'no archive links'); const path = name.slice(8), target = resolve(destination, path); assert.ok(inside(destination, target)); const body = tar.subarray(offset + 512, offset + 512 + n); assert.equal(body.length, n); await mkdir(dirname(target), { recursive: true }); await writeFile(target, body); inventory[path] = { bytes: n, sha256: sha(body) }; }
    offset += 512 + Math.ceil(n / 512) * 512;
  }
  for (const [path, expected] of Object.entries(inventory)) { const b = await readFile(join(destination, path)); assert.deepEqual({ bytes: b.length, sha256: sha(b) }, expected); }
  return inventory;
}
function childEnv(root) {
  const env = {}; for (const n of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE', 'NO_COLOR']) if (process.env[n] !== undefined) env[n] = process.env[n];
  Object.assign(env, { HOME: join(root, 'home'), USERPROFILE: join(root, 'home'), APPDATA: join(root, 'home/appdata'), LOCALAPPDATA: join(root, 'home/localappdata'), PI_CODING_AGENT_DIR: join(root, 'agent'), TEMP: join(root, 'tmp'), TMP: join(root, 'tmp'), GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'empty-git'), GIT_CONFIG_SYSTEM: join(root, 'empty-git'), GIT_CEILING_DIRECTORIES: root }); return env;
}
async function installedChild(root, consumer) {
  const sdk = await import('@earendil-works/pi-coding-agent'), packageRoot = join(consumer, 'node_modules/pi-quality-engine');
  const manifest = await json(join(packageRoot, 'package.json')), entry = resolve(packageRoot, manifest.pi.extensions[0]);
  assert.ok(inside(consumer, entry)); assert.equal(existsSync(join(packageRoot, 'src')), false);
  const { registerQualityDecisionRoute } = await import(pathToFileURL(join(packageRoot, 'examples/quality-decision/register.mjs')));
  const project = join(root, 'project'), agent = process.env.PI_CODING_AGENT_DIR; await mkdir(project); await mkdir(join(agent, 'quality/inputs'), { recursive: true });
  const bodies = { 'task.md': 'INSTALLED_TASK_376\nAssess this explicitly authorized synthetic packet.\n', 'requirements.md': 'INSTALLED_REQUIREMENT_376\nPreserve text.\n', 'implementation.txt': 'INSTALLED_IMPLEMENTATION_376\nsynthetic implementation\n', 'observations.json': '{"marker":"INSTALLED_OBSERVATIONS_376","observed":"bounded"}', 'subject-output.txt': 'INSTALLED_HYPOTHESIS_376\nNon-authoritative analyst hypothesis only.\n', 'native-window.json': '{"marker":"INSTALLED_WINDOW_376","tools":0}' };
  for (const [name, body] of Object.entries(bodies)) await writeFile(join(agent, 'quality/inputs', name), body);
  const config = await json(join(packageRoot, 'examples/quality-decision/config.json'));
  config.checks.quality.triggers = [{ id: 'prepared', use: 'core.every-tools', options: { count: 1 } }]; config.checks.quality.workStates = ['work-expected']; config.checks.quality.maxRunsPerEpisode = 1;
  await writeFile(join(agent, 'quality/config.json'), JSON.stringify(config));
  const loader = new sdk.DefaultResourceLoader({ cwd: project, agentDir: agent, settingsManager: sdk.SettingsManager.inMemory(), noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, additionalExtensionPaths: [entry] });
  await loader.reload(); const loaded = loader.getExtensions(); assert.deepEqual(loaded.errors, []);
  const models = await sdk.ModelRuntime.create({ authPath: join(root, 'owned-empty-auth.json'), modelsPath: null, modelsStorePath: join(root, 'models-cache.json'), refreshOnCreate: false, allowModelNetwork: false });
  registerQualityDecisionRoute(models, 'synthetic-installed-376-not-a-credential');
  const registry = new sdk.ModelRegistry(models), actual = registry.classify.bind(registry), submitted = []; let normalized = null;
  registry.classify = async (model, context, options) => { submitted.push(JSON.stringify(context)); const r = await actual(model, context, options); normalized = r.answers; return r; };
  const wires = [];
  globalThis.fetch = async (url, init) => { wires.push({ endpoint: String(url), body: init.body }); assert.equal(String(url), 'https://api.polza.ai/api/v1/systemone'); return new Response(JSON.stringify({ answers: { quality: { type: 'choice', choice: 'concern', probabilities: { concern: 1, 'not-established': 0, conflict: 0, insufficient: 0 }, confidence: .54 } }, usage: { input_tokens: 250, output_tokens: 0, total_tokens: 250 } }), { status: 200, headers: { 'content-type': 'application/json' } }); };
  const manager = sdk.SessionManager.inMemory(project), messages = [], errors = [], effects = { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 }, noop = () => {};
  const runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, project, manager, registry);
  runner.bindCore({ sendMessage: () => effects.sendMessage++, sendUserMessage: () => effects.sendUserMessage++, appendEntry: () => effects.appendEntry++, setSessionName: n => manager.appendSessionInfo(n), getSessionName: () => manager.getSessionName(), setLabel: noop, getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: noop, getThinkingLevel: () => 'off', setThinkingLevel: noop }, { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, abort: () => effects.abort++, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => '' });
  runner.setUIContext({ ...runner.getUIContext(), notify: text => messages.push(text) }, 'rpc'); runner.onError(e => errors.push(e.event));
  const quality = runner.getCommand('quality'); assert.ok(quality); const status = async () => { await quality.handler('status', runner.createCommandContext()); return JSON.parse(messages.at(-1)); };
  let before, after, retired;
  try {
    await runner.emit({ type: 'session_start', reason: 'startup' }); before = await status(); assert.equal(before.runtime.state, 'active'); assert.equal(before.configuration.rejection, null);
    await runner.emit({ type: 'input', text: 'INSTALLED_PRIMARY_TASK_376. Assess the supplied synthetic packet only. Authorized original target task:\n' + bodies['task.md'] + '\nThe analyst hypothesis has no authority.', source: 'interactive' });
    const read = sdk.createReadTool(project); await writeFile(join(project, 'work.txt'), 'INSTALLED_PRIMARY_READ_376'); const args = { path: 'work.txt' }, id = 'actual-read-376';
    await runner.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'read', args }); const result = await read.execute(id, args, new AbortController().signal); await runner.emit({ type: 'tool_execution_end', toolCallId: id, toolName: 'read', args, result, isError: false, durationMs: 1 });
    for (let i = 0; i < 300; i++) { after = await status(); if (after.diagnostics.recentEvents.some(e => e.event === 'quality.check.settled')) break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(wires.length, 1); assert.equal(submitted.length, 1); assert.equal(after.accounting.ownedRequestCount, 1); assert.equal(after.accounting.unresolvedCount, 0);
  } finally { await runner.emit({ type: 'session_shutdown', reason: 'quit' }); retired = await status(); runner.invalidate('owned typed installed proof retired'); }
  const allFiles = []; const visit = async p => { for (const e of await readdir(p, { withFileTypes: true })) { const f = join(p, e.name); if (e.isDirectory()) await visit(f); else allFiles.push(f); } }; await visit(agent);
  const records = []; for (const p of allFiles.filter(p => /\.jsonl(?:\.gz)?$/u.test(p))) { const b = await readFile(p); for (const line of (p.endsWith('.gz') ? gunzipSync(b) : b).toString('utf8').trim().split('\n')) if (line) records.push(JSON.parse(line)); }
  const canonical = records.find(e => e.event === 'quality.assessment.result'); assert.ok(canonical); assert.equal(canonical.fields.data.validationState, 'valid'); assert.equal(canonical.fields.data.operational, 'completed'); assert.equal(canonical.fields.data.conclusion, 'findings'); assert.equal(canonical.fields.data.findings[0].status, 'suspected');
  const sdkManifest = records.find(e => e.event === 'quality.context.manifest' && e.fields.data.boundary === 'sdk-input'); assert.ok(sdkManifest); assert.equal(sdkManifest.fields.data.sizes[0].utf8Bytes, Buffer.byteLength(submitted[0])); const dispatched = records.find(e => e.event === 'quality.model.dispatched'); assert.ok(dispatched); assert.equal(dispatched.fields.data.inputSerializedDigest, sha(submitted[0])); assert.equal(sdkManifest.fields.data.manifestId, dispatched.fields.data.manifestId);
  const context = JSON.parse(submitted[0]), bodyText = JSON.stringify(context.state);
  for (const marker of Object.values(bodies).map(x => x.match(/INSTALLED_[A-Z_]+_376/u)?.[0]).filter(Boolean)) assert.ok(bodyText.includes(marker));
  const roles = context.state.items.map(x => ({ id: x.id, role: x.role })); assert.ok(roles.some(x => x.role === 'requirement')); assert.ok(roles.some(x => x.role === 'reference'));
  assert.deepEqual(Object.keys(JSON.parse(wires[0].body)).sort(), ['model', 'questions', 'state']); assert.equal(normalized.quality.choice, 'concern');
  assert.deepEqual(effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 }); assert.deepEqual(errors, []); assert.deepEqual(allFiles.filter(p => p.endsWith('.lock')), []); assert.equal(retired.runtime.state, 'retired'); assert.equal(retired.accounting.unresolvedCount, 0);
  const journal = JSON.stringify(records); for (const marker of ['INSTALLED_TASK_376', 'INSTALLED_REQUIREMENT_376', 'INSTALLED_IMPLEMENTATION_376', 'INSTALLED_HYPOTHESIS_376', 'INSTALLED_PRIMARY_READ_376']) assert.ok(!journal.includes(marker));
  await writeFile(join(root, 'functional-sdk-input.json'), submitted[0]); await writeFile(join(root, 'functional-request.json'), wires[0].body);
  await writeFile(join(root, 'witness.json'), JSON.stringify({ result: 'AUTHOR_PASS_SCRIPTED_INSTALLED_TYPED_PATH', packageVersion: manifest.version, entry, sdkVersion: (await json(fileURLToPath(new URL('../package.json', import.meta.resolve('@earendil-works/pi-coding-agent'))))).version, actualSessionId: manager.getSessionId(), ownedRequests: after.accounting.ownedRequestCount, canonical: canonical.fields.data, literalRoles: roles, sdkContext: { bytes: Buffer.byteLength(submitted[0]), sha256: sha(submitted[0]) }, actualWire: { endpoint: wires[0].endpoint, bytes: Buffer.byteLength(wires[0].body), sha256: sha(wires[0].body) }, policy: config.policies.record.use, mode: config.mode, effects, shutdownReturned: true, remainingLocks: [], nativeTransport: 'scripted-response-no-network', actualCharges: 'UNKNOWN', liveQuality: 'NOT_RUN' }, null, 2));
}
if (process.argv[2] === '--child') await installedChild(resolve(process.argv[3]), resolve(process.argv[4]));
else test('376 actual packed artifact: ordinary quality evaluator → public SDK classifier → canonical result → record-only', async () => {
  const root = resolve(process.env.QE_EVIDENCE_DIR); await mkdir(root, { recursive: true }); const consumer = join(root, 'consumer'), pkg = join(consumer, 'node_modules/pi-quality-engine'), pack = join(root, 'pack'), run = join(root, 'native'); await mkdir(pack); await mkdir(run);
  for (const path of ['home/appdata', 'home/localappdata', 'agent', 'tmp']) await mkdir(join(run, path), { recursive: true }); await writeFile(join(run, 'empty-git'), '');
  const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'); const packed = spawnSync(process.execPath, [npm, 'pack', '--json', '--ignore-scripts', '--pack-destination', pack], { cwd: process.cwd(), env: process.env, encoding: 'utf8', timeout: 60000 }); assert.equal(packed.status, 0, packed.stderr);
  const info = JSON.parse(packed.stdout)[0], tarball = join(pack, info.filename), inventory = await extract(tarball, pkg);
  for (const path of Object.keys(inventory)) { assert.ok(!/^(?:src|test|scripts|donors|verification|node_modules)\//u.test(path)); if (path !== 'package.json') assert.equal(sha(await readFile(join(process.cwd(), path))), inventory[path].sha256); }
  for (const name of ['resources/prompts/quality-decision-v1.md', 'resources/prompts/quality-decision-v1.questions.json', 'examples/quality-decision/register.mjs', 'examples/quality-decision/config.json', 'examples/quality-decision/README.md']) assert.ok(inventory[name]);
  await mkdir(join(consumer, 'node_modules/@earendil-works'), { recursive: true });
  for (const name of ['@earendil-works/pi-coding-agent', '@earendil-works/pi-ai', 'yaml']) await symlink(await realpath(join(process.cwd(), 'node_modules', name)), join(consumer, 'node_modules', name), 'junction');
  await writeFile(join(consumer, 'package.json'), '{"type":"module","private":true}'); const child = join(consumer, 'installed-proof.mjs'); await copyFile(fileURLToPath(import.meta.url), child);
  // Reuse the explicit preload supplied by the native parent, never ambient NODE_OPTIONS.
  const actualPreload = process.execArgv[process.execArgv.indexOf('--import') + 1]; assert.ok(actualPreload?.startsWith('file:'));
  const start = Date.now(), command = ['--import', actualPreload, child, '--child', run, consumer];
  const result = spawnSync(process.execPath, command, { cwd: consumer, env: childEnv(run), encoding: 'utf8', timeout: 60000 });
  await writeFile(join(root, 'child-native.json'), JSON.stringify({ command: [process.execPath, ...command], pid: result.pid, exit: result.status, signal: result.signal, waitReturned: true, pipesReturned: true, elapsedMs: Date.now() - start, stdoutBytes: Buffer.byteLength(result.stdout ?? ''), stderrBytes: Buffer.byteLength(result.stderr ?? ''), independentJobReceipt: 'parent native-run.py receipt' }, null, 2));
  await writeFile(join(root, 'child.stdout.txt'), result.stdout ?? ''); await writeFile(join(root, 'child.stderr.txt'), result.stderr ?? ''); assert.equal(result.status, 0, result.stderr);
  const witness = await json(join(run, 'witness.json')); assert.equal(witness.result, 'AUTHOR_PASS_SCRIPTED_INSTALLED_TYPED_PATH'); assert.equal(witness.sdkVersion, '1.1.0');
  await writeFile(join(root, 'package.json'), JSON.stringify({ packageVersion: info.version, tarball: { path: tarball, bytes: (await readFile(tarball)).length, sha256: sha(await readFile(tarball)) }, inventory, materializedPayloadsEqual: true, dependencyProvisioning: 'existing pinned public SDK/YAML directory links; no dependency install and NOT test:package wrapper', installedWitness: join(run, 'witness.json') }, null, 2));
});
