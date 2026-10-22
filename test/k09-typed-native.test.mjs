import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ModelRuntime, ModelRegistry } from '@earendil-works/pi-coding-agent';
import { registerQualityDecisionRoute, modelProfile, priceProvenance } from '../examples/quality-decision/register.mjs';
import { ModelService } from '../dist/models.js';
import { piModelRegistryPort } from '../dist/adapters/pi-models.js';

const pause = ms => new Promise(r => setTimeout(r, ms));
const qs = JSON.parse(await readFile(new URL('../resources/prompts/progress-v1.questions.json', import.meta.url), 'utf8'));
const labels = ['progressing', 'repeating', 'waiting', 'unclear'];
const reply = (extra = {}) => ({ answers: { progress: { type: 'choice', choice: 'progressing', probabilities: Object.fromEntries(labels.map(k => [k, k === 'progressing' ? 1 : 0])), confidence: .61 }, unfinished: { type: 'noul', noul: .12 } }, usage: { input_tokens: 31, output_tokens: 4, total_tokens: 35 }, ...extra });
const response = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
async function setup(transport, { approved = true, timeoutMs = 1000 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qe-native-classifier-376-'));
  const runtime = await ModelRuntime.create({ authPath: join(root, 'owned-empty-auth.json'), modelsPath: null, modelsStorePath: join(root, 'models-cache.json'), refreshOnCreate: false, allowModelNetwork: false });
  registerQualityDecisionRoute(runtime, 'synthetic-376-not-a-credential');
  const registry = new ModelRegistry(runtime), port = piModelRegistryPort(registry), calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), body: init.body, signal: init.signal }); return transport(url, init); };
  const service = new ModelService({ profiles: { typed: { ...modelProfile, requestTimeoutMs: timeoutMs } }, approved: approved ? ['typed'] : [], registry: port, budget: { maxRequestsPerSession: 3, maxOwnedTokensPerSession: 20000, maxOwnedCost: null, unknownCost: 'allow-with-token-limits' } });
  const request = signal => ({ runId: 'native-owned-376', profileId: 'typed', kind: 'classifier', classifierState: { revision: 'native-proof-v1', instructions: ['NATIVE_INSTRUCTION_376'], body: 'NATIVE_SOURCE_376' }, classifierQuestions: qs, maxOutputTokens: 1024, estimatedInputTokens: 0, signal: signal ?? new AbortController().signal });
  return { root, runtime, registry, port, service, calls, request };
}

test('376 native public SDK: explicit classifier route, System One wire and bool normalization, no fake generative cap', async () => {
  const f = await setup(async () => response(reply()));
  const result = await f.service.dispatch(f.request()); assert.equal(result.ok, true);
  assert.equal(f.calls.length, 1); const wire = JSON.parse(f.calls[0].body);
  assert.equal(f.calls[0].url, 'https://api.polza.ai/api/v1/systemone'); assert.equal(wire.model, 'typesafe/jev');
  assert.deepEqual(Object.keys(wire).sort(), ['model', 'questions', 'state']); assert.equal(wire.questions.unfinished.type, 'noul');
  assert.equal(result.value.output.unfinished.type, 'bool'); assert.equal(result.value.output.unfinished.probability, .12);
  const model = f.port.findClassifier('polza', 'typesafe/jev'); assert.equal(model.type, 'classifier'); assert.equal(model.contextWindow, 64000); assert.equal(model.maxTokens, undefined);
  assert.equal(f.service.summary().ownedRequestCount, 1); assert.equal(f.service.summary().normalizedTokens.total, 35);
  assert.equal(f.service.attempts[0].usage.observationSource, 'sdk-normalized'); assert.equal(f.service.attempts[0].cost.amount, null); assert.equal(f.service.attempts[0].cost.basis, 'unknown'); assert.equal(priceProvenance.state, 'unavailable-price-placeholders');
  assert.ok(f.calls[0].signal instanceof AbortSignal); assert.equal(f.calls[0].signal.aborted, false);
  const out = process.env.QE_EVIDENCE_DIR; if (out) { await mkdir(out, { recursive: true }); await writeFile(join(out, 'native-serializer.json'), JSON.stringify({ endpoint: f.calls[0].url, sdkContextBytes: Buffer.byteLength(JSON.stringify({ state: f.request().classifierState, questions: qs })), wireBytes: Buffer.byteLength(f.calls[0].body), wireSha256: createHash('sha256').update(f.calls[0].body).digest('hex'), wireKeys: Object.keys(wire), nativeBoolType: wire.questions.unfinished.type, normalizedBool: result.value.output.unfinished, usageProvenance: f.service.attempts[0].usage.observationSource, actualRUB: 'UNKNOWN', sdkCatalogZerosAreNotCharges: true }, null, 2)); }
});
test('376 native SDK transient HTTP failure has exactly one fetch, static body-free failure', async () => {
  const f = await setup(async () => new Response('PRIVATE_PROVIDER_ERROR_376', { status: 503 }));
  const r = await f.service.dispatch(f.request()); assert.equal(r.ok, false); assert.equal(f.calls.length, 1); assert.equal(r.error.code, 'core.classifier-transport-failed'); assert.ok(!JSON.stringify({ r, attempts: f.service.attempts }).includes('PRIVATE_PROVIDER_ERROR_376'));
});
test('376 standard SDK missing-answer transport failure differs from custom normalized invalid-answer', async () => {
  const native = await setup(async () => response(reply({ answers: {} })));
  const a = await native.service.dispatch(native.request()); assert.equal(a.ok, false); assert.equal(a.error.code, 'core.classifier-transport-failed'); assert.equal(native.service.summary().normalizedTokens.total, 35);
  const port = { ...native.port, classify: async () => ({ answers: {}, model: { provider: 'polza', id: 'typesafe/jev', revision: null }, usage: { input: 31, output: 4, totalTokens: 35 }, stopReason: 'stop', errorMessage: null }) };
  const owned = new ModelService({ profiles: { typed: modelProfile }, approved: ['typed'], registry: port, budget: { maxRequestsPerSession: 1, maxOwnedTokensPerSession: 20000, maxOwnedCost: null, unknownCost: 'allow-with-token-limits' } });
  const b = await owned.dispatch(native.request()); assert.equal(b.ok, false); assert.equal(b.error.code, 'core.classifier-answer-invalid'); assert.equal(owned.summary().normalizedTokens.total, 35);
});
test('376 native SDK propagates actual timeout and signal; no implicit retry', async () => {
  let aborted = 0;
  const f = await setup(async (_url, init) => new Promise((_resolve, reject) => { init.signal.addEventListener('abort', () => { aborted++; reject(Error('PRIVATE_ABORT_376')); }, { once: true }); }), { timeoutMs: 30 });
  const record = f.port.findClassifier('polza', 'typesafe/jev');
  const result = await f.port.classify(record, { marker: 'direct supported boundary' }, qs, { requestTimeoutMs: 30 }, new AbortController().signal);
  assert.equal(result.stopReason, 'error'); assert.equal(result.errorMessage, 'core.classifier-transport-failed'); assert.equal(aborted, 1); assert.equal(f.calls.length, 1);
  const controller = new AbortController(); const pending = f.port.classify(record, {}, qs, { requestTimeoutMs: 1000 }, controller.signal); await pause(5); controller.abort();
  const cancelled = await pending; assert.equal(cancelled.stopReason, 'aborted'); assert.equal(cancelled.errorMessage, 'core.model-request-cancelled'); assert.equal(aborted, 2); assert.equal(f.calls.length, 2);
});
test('376 owned timeout retains physical liability and accepts late normalized usage exactly once', async () => {
  let deliver; const f = await setup(async () => new Promise(r => { deliver = r; }), { timeoutMs: 30 });
  const result = await f.service.dispatch(f.request()); assert.equal(result.ok, false); assert.equal(f.calls.length, 1); assert.equal(f.service.summary().unresolvedCount, 1);
  deliver(response(reply())); for (let i = 0; i < 100 && f.service.summary().unresolvedCount; i++) await pause(5);
  assert.equal(f.service.summary().unresolvedCount, 0); assert.equal(f.service.summary().normalizedTokens.total, 35); assert.equal(f.service.summary().ownedRequestCount, 1); assert.equal(f.service.attempts[0].cost.amount, null);
  await pause(20); assert.equal(f.service.summary().normalizedTokens.total, 35); assert.equal(f.service.attempts[0].usageRevision, 1);
});
test('376 permission and Stop deny before actual SDK fetch with a meaningful authorized counterpart', async () => {
  const f = await setup(async () => response(reply()), { approved: false }); assert.equal((await f.service.dispatch(f.request())).ok, false); assert.equal(f.calls.length, 0);
  const yes = await setup(async () => response(reply())); const controller = new AbortController(); controller.abort(); assert.equal((await yes.service.dispatch(yes.request(controller.signal))).ok, false); assert.equal(yes.calls.length, 0);
  assert.equal((await yes.service.dispatch(yes.request())).ok, true); assert.equal(yes.calls.length, 1);
});
test('376 actual SDK response byte bound refuses oversize, without copying raw body into failure', async () => {
  const f = await setup(async () => response(reply({ unused: 'X'.repeat(1048577) })));
  const result = await f.service.dispatch(f.request()); assert.equal(result.ok, false); assert.equal(f.calls.length, 1); assert.equal(result.error.code, 'core.classifier-transport-failed'); assert.ok(JSON.stringify(f.service.attempts).length < 10000);
});
