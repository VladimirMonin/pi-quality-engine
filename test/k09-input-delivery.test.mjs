// K09 mechanical C1 -> SDK -> serialized-provider input qualification.
// Run after an ordinary build, or set QE_K09_ENGINE_ROOT to an owned coherent
//build. QE_EVIDENCE_DIR must name fresh disposable owned output. No live mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { syncBuiltinESMExports } from 'node:module';

const PACKAGE = fileURLToPath(new URL('../', import.meta.url));
const HERE = fileURLToPath(import.meta.url);
const FIXTURE = join(PACKAGE, 'test/fixtures/k09/v1');
const PROVIDER = 'k09-scripted-input';
const MODEL = 'synthetic-text';
const ENDPOINT = 'https://k09-input.invalid/v1/chat/completions';
const MARKER = 'K09_PRIVATE_ORACLE_349_ONLY';
const AMBIENT = 'K09_AMBIENT_RESOURCE_349_ONLY';
const FUTURE = 'K09_AFTER_ASSESSMENT_349_ONLY';
const sha = value => createHash('sha256').update(value).digest('hex');
const save = (path, value) => fsp.writeFile(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, ms, code) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(Error(code), { code })), ms); })]); } finally { clearTimeout(timer); } }
const specs = [
  { mode: 'direct', caseId: 'case-002', title: 'direct C1 sources/resources reach real SDK and serialized body with issued refs' },
  { mode: 'missing', caseId: 'case-008', title: 'complete coverage refuses an unavailable required source before SDK' },
  { mode: 'partial-window', caseId: 'case-008', title: 'explicit partial scope and real section selection preserve excerpts and cutoff' },
  { mode: 'wrong-ref', caseId: 'case-002', title: 'normal canonical boundary rejects an unissued reference after real dispatch' },
  { mode: 'denied-resource', caseId: 'case-002', title: 'prompt acquisition refuses an out-of-root grader resource without reading it' },
  { mode: 'reviewer', caseId: 'case-002', title: 'separate clean reviewer delivers a genuine read and submits its issued reference' },
  { mode: 'reviewer-denied', caseId: 'case-002', title: 'clean reviewer private-oracle attempt is denied and ends the owned review' },
  { mode: 'reviewer-wrong-ref', caseId: 'case-002', title: 'real reviewer and direct boundary share the same body-free reference rejection category' },
  { mode: 'cutoff', caseId: 'case-027', title: 'accepted selector rejects post-assessment synthetic events before materialization' },
];

function textOf(messages) {
  return (messages ?? []).flatMap(m => typeof m.content === 'string' ? [m.content] : (m.content ?? []).filter(x => x.type === 'text').map(x => x.text)).join('\n');
}
function issuedRefs(text) {
  return {
    requirement: /^## requirement (\S+)\n/m.exec(text)?.[1] ?? /\[evidence (\S+) role requirement /u.exec(text)?.[1],
    implementation: /^## evidence (source:implementation:\S+)\n/m.exec(text)?.[1] ?? /\[evidence (\S+) role evidence [^\n]*implementation/u.exec(text)?.[1],
    acquired: /\[reviewer-evidence (\S+) rev /u.exec(text)?.[1],
  };
}
function canonical(criterion, coverage, refs, wrong = false) {
  return {
    operational: 'completed', coverage: { state: coverage, scopeDescription: 'Scripted input/reference protocol control, NOT model judgment.', issues: [] },
    conclusion: coverage === 'complete' ? 'findings' : 'undetermined',
    findings: coverage === 'complete' ? [{ id: 'mechanical-reference-probe', criterion, status: 'suspected', severity: 'concern',
      requirementRefs: [wrong ? 'unissued-reference' : refs.requirement], evidenceIds: [refs.acquired ?? refs.implementation],
      affectedItems: [refs.acquired ?? refs.implementation], defectCode: 'correctness.requirement-violation',
      explanation: 'Mechanical issued-reference custody probe; this scripted response is not semantic evidence.',
      proposedCorrection: null, limitations: ['No model judgment or promotion claim.'] }] : [],
    scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
  };
}
function sse(model, payload, tool = false) {
  const base = { id: 'synthetic-k09-349', object: 'chat.completion.chunk', created: 1, model };
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: payload.id, type: 'function', function: { name: payload.name, arguments: JSON.stringify(payload.args) } }] } : { role: 'assistant', content: JSON.stringify(payload) };
  const chunks = [{ ...base, usage: null, choices: [{ index: 0, delta, finish_reason: null }] },
    { ...base, usage: null, choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] },
    { ...base, choices: [], usage: { prompt_tokens: 180, completion_tokens: 50, total_tokens: 230 } }];
  return new Response(chunks.map(x => 'data: ' + JSON.stringify(x) + '\n\n').join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function child(options) {
  const report = { mode: options.mode, caseId: options.caseId, boundary: 'Mechanical host input, not semantic evaluation', frames: [], wire: [],
    effects: 0, uncontrolledNetworkAttempts: 0, privateBodyReads: 0, privateDirectoryReads: 0, canaryControlReads: 0,
    productionOptionsRewritten: false, providerStreamReplacement: false, headersRetained: false, phase: 'setup' };
  const out = options.out, project = join(out, 'project'), agent = join(out, 'agent'), grader = join(out, 'grader');
  let runner = null, status = null, shutdown = false, physicalWindow = false;
  const originalFetch = globalThis.fetch;
  const originalReadSync = fs.readFileSync, originalRead = fsp.readFile, originalReadCallback = fs.readFile;
  const originalDirSync = fs.readdirSync, originalDir = fsp.readdir, originalDirCallback = fs.readdir;
  const watched = [];
  const asPath = p => { try { return resolve(p instanceof URL ? fileURLToPath(p) : String(p)).toLowerCase(); } catch { return ''; } };
  const matches = p => watched.some(w => { const target = asPath(p); return target === w || target.startsWith(w + '\\') || target.startsWith(w + '/'); });
  let control = false;
  const observeRead = path => { if (matches(path)) { if (control) report.canaryControlReads++; else if (physicalWindow) report.privateBodyReads++; } };
  const observeDirectory = path => { if (physicalWindow && matches(path)) report.privateDirectoryReads++; };
  // Passive observers, NOT protective replacements: a bad product read would
  //really retrieve the harmless sentinel and fail this test. No external guard
  //can manufacture an oracle-isolation pass by suppressing the file read.
  fs.readFileSync = function(path, ...args) { observeRead(path); return originalReadSync.call(this, path, ...args); };
  fsp.readFile = function(path, ...args) { observeRead(path); return originalRead.call(this, path, ...args); };
  fs.readFile = function(path, ...args) { observeRead(path); return originalReadCallback.call(this, path, ...args); };
  fs.readdirSync = function(path, ...args) { observeDirectory(path); return originalDirSync.call(this, path, ...args); };
  fsp.readdir = function(path, ...args) { observeDirectory(path); return originalDir.call(this, path, ...args); };
  fs.readdir = function(path, ...args) { observeDirectory(path); return originalDirCallback.call(this, path, ...args); };
  const deny = () => { report.uncontrolledNetworkAttempts++; throw Error('k09.offline-network-denied'); };
  globalThis.fetch = deny; http.request = deny; http.get = deny; https.request = deny; https.get = deny;
  net.connect = deny; net.createConnection = deny; net.Socket.prototype.connect = deny; tls.connect = deny; syncBuiltinESMExports();
  try {
    const api = await import('../scripts/validate-k09.mjs');
    const corpus = JSON.parse(await fsp.readFile(join(FIXTURE, 'corpus.json'), 'utf8'));
    const split = JSON.parse(await fsp.readFile(join(FIXTURE, 'split.json'), 'utf8'));
    const c = corpus.cases.find(x => x.id === options.caseId);
    assert.equal(split.groups.find(g => g.id === c.group).split, 'calibration', 'no held-out semantic trial');
    const selection = api.evaluatorInput({ corpus }, c.id);
    report.selectedInputDigest = api.semanticDigest(selection); report.assessmentSequence = c.assessmentSequence;
    report.originalSelections = c.sources.map(s => ({ id: s.id, path: s.path, availability: s.availability, selection: s.selection, sha256: s.sha256 }));
    if (options.mode === 'cutoff') {
      const pack = await api.loadK09(); const target = pack.corpus.cases.find(x => x.id === c.id), source = target.sources[3], trace = JSON.parse(source.body);
      trace.events.push({ sequence: target.assessmentSequence + 1, kind: 'supplied-observation', text: FUTURE });
      source.body = JSON.stringify(trace); source.sha256 = sha(source.body);
      assert.throws(() => api.validateK09(pack), error => error.code === 'assessment-cutoff');
      report.selectorRefusal = 'assessment-cutoff'; report.materialized = false; report.passed = true; return;
    }
    await fsp.mkdir(project, { recursive: true }); await fsp.mkdir(join(agent, 'quality'), { recursive: true }); await fsp.mkdir(grader);
    for (const [name, body] of [['labels.json', JSON.stringify({ privateOracle: MARKER })], ['split.json', JSON.stringify({ privateSplit: MARKER })], ['review.md', MARKER + '\n']]) await fsp.writeFile(join(grader, name), body);
    for (const name of ['AGENTS.md', 'SYSTEM.md', 'APPEND_SYSTEM.md']) await fsp.writeFile(join(agent, name), AMBIENT + '\n');
    watched.push(asPath(grader), ...['AGENTS.md', 'SYSTEM.md', 'APPEND_SYSTEM.md'].map(n => asPath(join(agent, n))), asPath(join(FIXTURE, 'labels.json')), asPath(join(FIXTURE, 'split.json')));
    control = true; assert.ok(fs.readFileSync(join(grader, 'labels.json'), 'utf8').includes(MARKER)); control = false;
    assert.equal(report.canaryControlReads, 1);
    for (const s of selection.sources) if (s.availability === 'provided') await fsp.writeFile(join(project, s.path), s.body);
    const supplement = await fsp.readFile(join(FIXTURE, 'review-instructions.md'));
    const schemaText = JSON.stringify(JSON.parse(await fsp.readFile(new URL('../resources/prompts/evaluation-v1.schema.json', import.meta.url), 'utf8')));
    const engineeringText = await fsp.readFile(new URL('../resources/prompts/engineering-v1.md', import.meta.url), 'utf8');
    await fsp.writeFile(join(project, 'k09-review-instructions.md'), supplement);
    if (options.mode === 'partial-window') await fsp.writeFile(join(project, 'implementation.txt'), '# At assessment\n' + c.sources[2].body + '\n# After assessment\n' + FUTURE + '\n');
    const sourceIds = ['task', 'requirements', 'implementation', 'window'];
    const sources = Object.fromEntries(selection.sources.map((s, i) => [sourceIds[i], { uris: ['project:' + s.path], role: s.role, required: true,
      ...(options.mode === 'partial-window' && i === 2 ? { include: 'selected', sections: ['At assessment'] } : {}) }]));
    const review = options.mode.startsWith('reviewer'), partial = options.mode === 'partial-window';
    const config = { schemaVersion: 1, enabled: true, mode: 'observe', sources,
      modelProfiles: { probe: { provider: PROVIDER, model: MODEL, reasoning: 'off', requestTimeoutMs: 5000, maxAttempts: 1, retryDelayMs: 0, maxOutputTokens: 1024,
        price: { currency: 'USD', revision: 'synthetic-bookkeeping-not-a-tariff', inputPerMillion: '1.00', outputPerMillion: '1.00' }, requiredInputs: ['text'] } },
      permissions: { modelProfiles: ['probe'] },
      contexts: { c: { providers: [{ id: 'files', use: 'core.files', options: { sourceIds } }], requiredCoverage: partial ? 'partial' : 'complete', maxBytes: 32768, maxEstimatedTokens: 8192 } },
      prompts: { p: { use: 'core.prompt-files', options: { instructions: ['builtin:engineering-v1.md', options.mode === 'denied-resource' ? pathToFileURL(join(grader, 'review.md')).href : 'project:k09-review-instructions.md'], resultSchema: 'builtin:evaluation-v1.schema.json' } } },
      evaluators: { e: { use: review ? 'core.pi-session' : 'core.chat', modelProfile: 'probe', options: review ? { tools: ['read'], readSources: ['implementation'], allowProjectReads: false, maxModelRequests: 3, maxToolCalls: 2, maxAdditionalReadBytes: 1024, timeoutMs: 10000, maxOutputTokens: 1024, repairAttempts: 0 } : { maxOutputTokens: 1024, repairAttempts: 0 } } },
      policies: { p: { use: 'core.record-only' } },
      checks: { input: { triggers: [{ id: 'one', use: 'core.every-tools', options: { count: 1 } }], context: 'c', prompt: 'p', evaluator: 'e', policy: 'p', criteria: [c.criterion], cooldownMs: 0, maxRunsPerEpisode: 1, workStates: ['work-expected'] } },
      runtime: { maxConcurrentEvaluations: 1, maxConcurrentReviewers: 1, maxRequestsPerSession: review ? 3 : 1, maxOwnedTokensPerSession: 32768, unknownCost: 'deny', maxOwnedCost: { currency: 'USD', amount: '0.10' }, defaultRunTimeoutMs: 15000, maxRunTimeoutMs: 15000, maxEscalationsPerEpisode: 0 } };
    await save(join(agent, 'quality/config.json'), config); report.configuration = config;
    process.env.PI_CODING_AGENT_DIR = agent;
    report.phase = 'sdk-import';
    const sdk = await import('@earendil-works/pi-coding-agent');
    const loader = new sdk.DefaultResourceLoader({ cwd: project, agentDir: agent, settingsManager: sdk.SettingsManager.inMemory(), noExtensions: true, noSkills: true, noThemes: true,
      noContextFiles: true, noPromptTemplates: true, systemPrompt: '', appendSystemPrompt: [], additionalExtensionPaths: [join(options.engineRoot, 'dist/index.js')] });
    report.phase = 'real-loader'; physicalWindow = true; await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
    // Public SDK only: all default storage resolves inside this fresh empty
    //owned agent directory. No credential store is supplied/read by the test.
    const models = await sdk.ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
    models.registerProvider(PROVIDER, { api: 'openai-completions', baseUrl: ENDPOINT.slice(0, -'/chat/completions'.length), apiKey: 'synthetic-349-not-a-credential',
      models: [{ id: MODEL, name: 'Synthetic offline input transport', api: 'openai-completions', reasoning: false, input: ['text'], contextWindow: 65536, maxTokens: 1024,
        cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, compat: { maxTokensField: 'max_tokens', supportsDeveloperRole: false } }] });
    const registry = new sdk.ModelRegistry(models);
    assert.equal(registry.getRegisteredProviderConfig(PROVIDER).streamSimple, undefined, 'ordinary API serializer, not a custom provider stream');
    // Read-only public SDK call observers. Same argument objects are delegated;
    //no option, cap, prompt, context, auth or response field is supplied/repaired.
    for (const method of ['complete', 'streamSimple']) {
      const original = registry[method];
      registry[method] = function(...args) {
        const [model, context, opts] = args;
        report.frames.push({ method, model: { provider: model.provider, id: model.id, api: model.api }, context: JSON.parse(JSON.stringify(context)),
          contextDigest: sha(JSON.stringify(context)), observedMaxTokens: opts?.maxTokens ?? null });
        return Reflect.apply(original, this, args);
      };
    }
    globalThis.fetch = async (url, init) => {
      assert.equal(String(url), ENDPOINT); assert.equal(init?.method, 'POST'); assert.equal(typeof init.body, 'string');
      const body = JSON.parse(init.body), bytes = Buffer.byteLength(init.body), text = textOf(body.messages), n = report.wire.length + 1;
      assert.ok(n <= (review ? 3 : 1)); assert.ok(bytes <= (review ? 32768 : 16384)); assert.equal(body.model, MODEL); assert.equal(body.max_tokens, 1024);
      assert.ok(!text.includes(MARKER) && !text.includes(AMBIENT) && !text.includes(FUTURE));
      report.wire.push({ method: init.method, url: String(url), body, serializedBody: init.body, jsonBytes: bytes, digest: sha(init.body), headersRetained: false });
      const refs = issuedRefs(text); report.lastIssuedRefs = refs;
      if (review && n === 1) return sse(MODEL, { id: 'read-admitted', name: 'read', args: { path: 'implementation.txt' } }, true);
      if (review && n === 2) {
        assert.ok(refs.acquired && text.includes(c.sources[2].body), 'real tool body/new issued ref reached later actual input');
        if (options.mode === 'reviewer-denied') return sse(MODEL, { id: 'read-private', name: 'read', args: { path: join(grader, 'labels.json') } }, true);
      }
      assert.ok(refs.requirement || partial); if (!partial) assert.ok(refs.implementation || refs.acquired);
      // Only the explicit negative control supplies a deliberately unissued ref.
      //Positive delivery is always judged against the real supplied stimulus.
      const result = canonical(c.criterion, partial ? 'partial' : 'complete', refs, options.mode === 'wrong-ref' || options.mode === 'reviewer-wrong-ref');
      report.scriptedSubmission = result;
      return review ? sse(MODEL, { id: 'submit-probe', name: 'submit_result', args: result }, true) : sse(MODEL, result);
    };
    const loaded = loader.getExtensions(), noop = () => {}, messages = [];
    runner = new sdk.ExtensionRunner(loaded.extensions, loaded.runtime, project, sdk.SessionManager.inMemory(project), registry);
    report.extensionErrors = []; runner.onError(e => report.extensionErrors.push({ event: e.event }));
    runner.bindCore({ sendMessage: () => report.effects++, sendUserMessage: () => report.effects++, appendEntry: () => report.effects++, setSessionName: noop, getSessionName: () => undefined, setLabel: noop,
      getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}), setActiveTools: noop, refreshTools: noop, getCommands: () => [], setModel: noop, getThinkingLevel: () => 'off', setThinkingLevel: noop },
    { getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true, getSignal: () => undefined, abort: () => report.effects++, hasPendingMessages: () => false, shutdown: noop, getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => '' });
    runner.setUIContext({ ...runner.getUIContext(), notify: value => messages.push(value) }, 'rpc'); const command = runner.getCommand('quality');
    status = async () => { await command.handler('status', runner.createCommandContext()); return JSON.parse(messages.at(-1)); };
    report.phase = 'managed-check'; await runner.emit({ type: 'session_start', reason: 'startup' }); report.initial = await status(); assert.equal(report.initial.configuration.rejection, null);
    await runner.emitInput('Assess only the supplied current synthetic materials. This is a mechanical input-boundary control, not a model-quality trial.', undefined, 'interactive');
    await runner.emit({ type: 'tool_execution_start', toolCallId: 'primary-one', toolName: 'fixture.progress', args: {} });
    await runner.emit({ type: 'tool_execution_end', toolCallId: 'primary-one', toolName: 'fixture.progress', result: { content: [] }, isError: false, durationMs: 1 });
    const until = performance.now() + 17000;
    do { report.settled = await status(); if (report.settled.diagnostics.recentEvents.some(x => x.event === 'quality.check.settled')) break; await delay(10); } while (performance.now() < until);
    report.phase = 'shutdown'; await bounded(runner.emit({ type: 'session_shutdown', reason: 'quit' }), 5000, 'cleanup-pending'); shutdown = true;
    report.retired = await status(); runner.invalidate('K09 mechanical input child finished');
    async function files(root) { const result = []; for (const item of await fsp.readdir(root, { withFileTypes: true }).catch(() => [])) { if (item.isSymbolicLink() || /^(?:auth|models|settings)\.json|^\.env/iu.test(item.name)) continue; const p = join(root, item.name); if (item.isDirectory()) result.push(...await files(p)); else if (item.isFile()) result.push(p); } return result; }
    const journalFiles = await files(join(agent, 'quality/logs')), locks = [...journalFiles, ...await files(join(agent, 'quality'))].filter(p => p.endsWith('.lock'));
    const rows = []; let journalText = '';
    for (const path of journalFiles.filter(p => /\.jsonl(?:\.gz)?$/u.test(p))) { const b = await fsp.readFile(path), text = (path.endsWith('.gz') ? gunzipSync(b) : b).toString(); journalText += text; rows.push(...text.split('\n').filter(Boolean).map(line => JSON.parse(line))); }
    report.phase = 'independent-assertions'; report.rows = rows; report.canonical = rows.filter(x => x.event === 'quality.assessment.result');
    report.manifests = rows.filter(x => x.event === 'quality.context.manifest'); report.manifestParts = rows.filter(x => x.event === 'quality.context.manifest-part'); report.sourceFacts = rows.filter(x => x.event === 'quality.context.source');
    report.toolEvents = rows.filter(x => x.event.startsWith('quality.tool.') || x.event === 'quality.component.note'); report.locks = locks.map(p => relative(out, p));
    assert.equal(report.effects, 0); assert.equal(report.uncontrolledNetworkAttempts, 0); assert.equal(report.privateBodyReads, 0); assert.equal(report.privateDirectoryReads, 0);
    assert.deepEqual(report.extensionErrors, []); assert.deepEqual(report.locks, []); assert.equal(report.retired.accounting.unresolvedCount, 0);
    for (const s of c.sources.filter(s => s.availability === 'provided')) assert.ok(!journalText.includes(s.body), 'normal O1 does not capture supplied body');
    assert.ok(!journalText.includes(MARKER) && !journalText.includes(AMBIENT) && !journalText.includes(FUTURE));
    if (options.mode === 'missing' || options.mode === 'denied-resource') {
      assert.equal(report.wire.length, 0); assert.equal(report.frames.length, 0);
      assert.ok(JSON.stringify(rows).includes(options.mode === 'missing' ? 'core.context-incomplete' : 'core.prompt-provider-error'));
    } else {
      assert.equal(report.wire.length, review ? 2 : 1); assert.equal(report.frames.length, report.wire.length);
      assert.ok(report.frames.every(f => f.method === (review ? 'streamSimple' : 'complete')));
      const firstWire = textOf(report.wire[0].body.messages), sdkJson = JSON.stringify(report.frames[0].context);
      const sdkContains = body => sdkJson.includes(JSON.stringify(body).slice(1, -1));
      report.delivery = {
        sources: c.sources.filter(s => s.availability === 'provided').map(s => ({ id: s.id, sha256: s.sha256, sdk: sdkContains(s.body), provider: firstWire.includes(s.body) })),
        supplement: { sdk: sdkContains(supplement.toString()), provider: firstWire.includes(supplement.toString()) },
        engineering: { sdk: sdkContains(engineeringText), provider: firstWire.includes(engineeringText) },
        schema: { sdk: sdkContains(schemaText), provider: firstWire.includes(schemaText) },
      };
      for (const s of report.delivery.sources) { assert.ok(s.sdk); assert.ok(s.provider); }
      assert.ok(report.delivery.supplement.sdk && report.delivery.supplement.provider);
      assert.ok(report.delivery.engineering.sdk && report.delivery.engineering.provider, 'complete engineering instruction resource, not only its heading');
      assert.ok(report.delivery.schema.sdk && report.delivery.schema.provider, 'actual complete selected schema resource, not a route-specific heading');
      assert.equal(report.canonical.length, 1);
      if (options.mode === 'wrong-ref') { assert.equal(report.canonical[0].fields.data.validationState, 'invalid'); assert.notEqual(report.canonical[0].fields.data.operational, 'completed'); assert.ok(report.canonical[0].fields.reasonCodes.includes('core.assessment.reference')); assert.ok(!journalText.includes('unissued-reference')); }
      else if (options.mode === 'reviewer-denied' || options.mode === 'reviewer-wrong-ref') { assert.equal(report.canonical[0].fields.data.validationState, 'valid'); assert.notEqual(report.canonical[0].fields.data.operational, 'completed'); }
      else { assert.equal(report.canonical[0].fields.data.validationState, 'valid'); assert.equal(report.canonical[0].fields.data.operational, 'completed'); assert.equal(report.canonical[0].fields.data.coverage, partial ? 'partial' : 'complete'); }
      if (partial) { assert.ok(!firstWire.includes(FUTURE)); assert.ok(report.manifestParts.some(row => row.fields.data.items.some(item => item.selection.kind === 'sections'))); assert.ok(report.manifests.some(row => row.fields.data.coverage === 'partial')); }
      if (review) {
        assert.ok(report.toolEvents.some(row => row.fields.data.code === 'core.reviewer-tool-acquired')); assert.ok(report.lastIssuedRefs.acquired);
        if (options.mode === 'reviewer-denied') assert.ok(report.toolEvents.some(row => row.fields.data.code === 'core.reviewer-tool-denied'));
        else if (options.mode === 'reviewer-wrong-ref') { assert.ok(report.canonical[0].fields.reasonCodes.includes('core.assessment.reference')); assert.ok(!journalText.includes('unissued-reference')); }
        else assert.ok(report.canonical[0].fields.data.findings[0].evidenceRefs.includes(report.lastIssuedRefs.acquired));
      }
    }
    report.passed = true;
  } catch (error) { report.failure = { phase: report.phase, kind: error?.name === 'AssertionError' ? 'assertion' : 'preparation-or-operation', code: typeof error?.code === 'string' && /^[A-Z_\-\w.]+$/u.test(error.code) ? error.code : null }; report.passed = false; }
  finally {
    if (runner && !shutdown) { try { await bounded(runner.emit({ type: 'session_shutdown', reason: 'quit' }), 5000, 'cleanup-pending'); shutdown = true; runner.invalidate('K09 failed probe retired'); } catch { report.cleanupFailure = 'physical-cleanup-not-proven'; } }
    physicalWindow = false; report.shutdownReturned = shutdown; globalThis.fetch = originalFetch;
    fs.readFileSync = originalReadSync; fsp.readFile = originalRead; fs.readFile = originalReadCallback; fs.readdirSync = originalDirSync; fsp.readdir = originalDir; fs.readdir = originalDirCallback; syncBuiltinESMExports();
    await save(join(out, 'witness.json'), report);
    console.log(JSON.stringify({ mode: options.mode, passed: report.passed, phase: report.phase, wireRequests: report.wire.length, SDKCalls: report.frames.length, failure: report.failure ?? null, uncontrolledNetworkAttempts: report.uncontrolledNetworkAttempts }));
    process.exitCode = report.passed ? 0 : 1;
  }
}

async function runNative(spec, index) {
  assert.ok(process.env.QE_EVIDENCE_DIR, 'explicit disposable evidence output is required');
  const root = resolve(process.env.QE_EVIDENCE_DIR), out = join(root, `sample-${String(index + 1).padStart(3, '0')}`); await fsp.mkdir(out, { recursive: false });
  const home = join(out, 'home'); for (const path of [home, join(home, 'appdata'), join(home, 'localappdata'), join(home, 'temp')]) await fsp.mkdir(path);
  for (const name of ['git-empty', 'npm-empty']) await fsp.writeFile(join(home, name), '');
  const env = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'SYSTEMDRIVE']) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, { HOME: home, USERPROFILE: home, APPDATA: join(home, 'appdata'), LOCALAPPDATA: join(home, 'localappdata'), TEMP: join(home, 'temp'), TMP: join(home, 'temp'), PI_CODING_AGENT_DIR: join(out, 'agent'),
    GIT_CONFIG_SYSTEM: join(home, 'git-empty'), GIT_CONFIG_GLOBAL: join(home, 'git-empty'), GIT_CONFIG_NOSYSTEM: '1', GIT_CEILING_DIRECTORIES: out, NPM_CONFIG_USERCONFIG: join(home, 'npm-empty'), NPM_CONFIG_GLOBALCONFIG: join(home, 'npm-empty'), NO_COLOR: '1', FORCE_COLOR: '0' });
  const options = { ...spec, out, engineRoot: process.env.QE_K09_ENGINE_ROOT ? resolve(process.env.QE_K09_ENGINE_ROOT) : PACKAGE };
  const args = [HERE, '--k09-child', JSON.stringify(options)], started = performance.now(), handle = spawn(process.execPath, args, { cwd: PACKAGE, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = [], stderr = []; let exit = null, signal = null, stdoutEnd = false, stderrEnd = false, killed = false;
  handle.stdout.on('data', b => stdout.push(b)); handle.stderr.on('data', b => stderr.push(b)); handle.stdout.on('end', () => { stdoutEnd = true; }); handle.stderr.on('end', () => { stderrEnd = true; });
  const timer = setTimeout(() => { killed = true; handle.kill(); }, 40000);
  await new Promise((done, reject) => { handle.once('error', reject); handle.once('exit', (code, sig) => { exit = code; signal = sig; }); handle.once('close', done); }); clearTimeout(timer);
  await fsp.writeFile(join(out, 'stdout.txt'), Buffer.concat(stdout)); await fsp.writeFile(join(out, 'stderr.txt'), Buffer.concat(stderr));
  const receipt = { pid: handle.pid, mode: spec.mode, exit, signal, closeObserved: true, stdoutEnd, stderrEnd, watchdogKill: killed, outerMs: 40000, elapsedMs: performance.now() - started };
  await save(join(out, 'native.json'), receipt);
  assert.equal(killed, false, 'an outer kill is not product cleanup'); assert.equal(stdoutEnd && stderrEnd, true); assert.equal(exit, 0, `${spec.mode}: inspect owned witness/native records`);
}
if (process.argv[2] === '--k09-child') await child(JSON.parse(process.argv[3]));
else for (const [index, spec] of specs.entries()) test('K09 input: ' + spec.title, { timeout: 45000 }, async () => runNative(spec, index));
