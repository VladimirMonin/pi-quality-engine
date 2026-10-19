import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// This suite validates authored inputs, NEVER model judgments. No SDK import.
let api = null;
try { api = await import('../scripts/validate-k09.mjs'); } catch { /* initial missing-implementation RED is asserted below without raw exception capture */ }
const sha = text => createHash('sha256').update(text).digest('hex');
const load = async () => { assert.ok(api, 'offline validator implementation is required'); return api.loadK09(); };
const fails = (pack, code) => assert.throws(() => api.validateK09(pack), error => error.code === code);

test('offline family is complete and frozen', async () => {
  assert.equal(typeof api?.validateK09, 'function', 'actual offline validation must exist');
  const pack = await load();
  const report = api.validateK09(pack);
  assert.equal(report.cases, 42);
  assert.equal(report.groups, 14);
  assert.equal(report.domains, 7);
  assert.deepEqual(report.splitCases, { calibration: 21, 'held-out': 21 });
  assert.deepEqual(report.buckets, { violation: 14, 'near-miss': 14, limited: 14 });
  assert.equal(report.plannedModelRequests, 42);
  assert.equal(report.executedModelRequests, 0);
  assert.equal(report.semanticStatus, 'not-run');
});

test('all seven domains have contrasts in both disjoint group-level splits', async () => {
  const pack = await load(); api.validateK09(pack);
  for (const domain of pack.corpus.domains) {
    const cases = pack.corpus.cases.filter(c => c.domain === domain);
    assert.equal(cases.length, 6);
    const groups = pack.split.groups.filter(g => g.domain === domain);
    assert.equal(groups.length, 2);
    assert.notEqual(groups[0].split, groups[1].split);
    for (const group of groups) {
      const ids = cases.filter(c => c.group === group.id).map(c => c.id);
      assert.equal(ids.length, 3);
      assert.deepEqual(pack.labels.cases.filter(l => ids.includes(l.caseId)).map(l => l.bucket).sort(), ['limited', 'near-miss', 'violation']);
    }
  }
});

test('evaluator selections include real supplied bodies but no labels, split or oracle metadata', async () => {
  const pack = await load(); api.validateK09(pack);
  for (const c of pack.corpus.cases) {
    const input = api.evaluatorInput(pack, c.id);
    assert.deepEqual(Object.keys(input), ['caseId', 'reviewScope', 'assessmentSequence', 'criterion', 'sources']);
    assert.equal(input.sources.find(s => s.path === 'task.md').body, c.sources[0].body);
    assert.equal(input.sources.length, 4);
    assert.ok(!JSON.stringify(input).includes(pack.labels.oracleOnlyMarker));
  }
  const c = pack.corpus.cases[0];
  const original = api.evaluatorInput(pack, c.id);
  pack.labels.oracleOnlyMarker = 'HIDDEN_ONLY_345_CANARY';
  pack.labels.cases[0].expectedFindingOrLimitation = 'HIDDEN_ONLY_345_CANARY';
  assert.deepEqual(api.evaluatorInput(pack, c.id), original, 'changing only the oracle must not change evaluator input');
  const source = c.sources.find(s => s.path === 'implementation.txt');
  source.body += '\nVISIBLE_SYNTHETIC_345_CANARY\n';
  source.sha256 = sha(source.body);
  assert.ok(JSON.stringify(api.evaluatorInput(pack, c.id)).includes('VISIBLE_SYNTHETIC_345_CANARY'), 'positive control defeats an empty-input separator');
});

test('unknown answer-bearing input fields are rejected, not copied into evaluator selections', async () => {
  const pack = await load(); pack.corpus.cases[0].expected = 'HIDDEN_ANSWER';
  fails(pack, 'case-shape');
});

test('related variants cannot cross the split or borrow another domain group', async () => {
  const pack = await load(); pack.corpus.cases[0].group = 'group-002';
  fails(pack, 'group-population');
  const other = await load(); other.split.groups[0].split = 'held-out';
  fails(other, 'split-population');
});

test('labels require actual source references and applicable supplied requirements', async () => {
  const pack = await load(); pack.labels.cases[0].rationaleSourceRefs.push('invented-source');
  fails(pack, 'label-reference');
  const other = await load(); const label = other.labels.cases.find(l => l.bucket === 'violation');
  label.requirementRefs = [];
  fails(other, 'label-requirement');
});

test('changed source bytes and fabricated source revisions cannot pass the frozen identity', async () => {
  const pack = await load(); pack.corpus.cases[0].sources[0].body += '\nchanged\n';
  fails(pack, 'source-digest');
  const other = await load(); other.corpus.cases[0].sources[0].revision = 'unissued-revision';
  fails(other, 'freeze-mismatch');
});

test('synthetic timelines retain requested versus completed and forbid post-cutoff evidence', async () => {
  const pack = await load(); const c = pack.corpus.cases[0]; const source = c.sources.find(s => s.path === 'observations.json');
  const trace = JSON.parse(source.body); trace.events.push({ sequence: c.assessmentSequence + 1, kind: 'supplied-observation', text: 'future evidence' });
  source.body = JSON.stringify(trace); source.sha256 = sha(source.body);
  fails(pack, 'assessment-cutoff');
  const other = await load(); const target = other.corpus.cases.find(x => JSON.parse(x.sources[3].body).events.some(e => e.kind === 'verification' && e.state === 'requested'));
  const s = target.sources[3]; const t = JSON.parse(s.body); t.events.find(e => e.kind === 'verification').exitCode = 0;
  s.body = JSON.stringify(t); s.sha256 = sha(s.body);
  fails(other, 'verification-state');
});

test('missing mandatory data, unsupported schema and outside-root source paths are invalid', async () => {
  const pack = await load(); delete pack.labels.cases[0].proportionateResponse;
  fails(pack, 'label-shape');
  const other = await load(); other.corpus.schemaVersion = 2;
  fails(other, 'corpus-shape');
  const outside = await load(); outside.corpus.cases[0].sources[0].path = '../unadmitted.txt';
  fails(outside, 'source-path');
});

test('an unapproved numerical gate or tuple mutation cannot silently reuse the freeze', async () => {
  const pack = await load(); delete pack.plan.gates.structuredValidity;
  fails(pack, 'gate-definition');
  const other = await load(); other.plan.revision = 'different-plan';
  fails(other, 'freeze-mismatch');
});

test('zero-denominator metrics are undefined, never fabricated perfect results', async () => {
  await load();
  assert.deepEqual(api.fraction(0, 0), { numerator: 0, denominator: 0, value: null });
  assert.deepEqual(api.fraction(5, 7), { numerator: 5, denominator: 7, value: 5 / 7 });
  assert.throws(() => api.fraction(1, 0));
});

test('visual corpus is text-only coverage honesty, not an image-review capability', async () => {
  const pack = await load(); api.validateK09(pack);
  assert.equal(pack.plan.visual.actualImageSet, null);
  assert.equal(pack.plan.visual.recommendVisualCapability, false);
  const cases = pack.corpus.cases.filter(c => c.domain === 'visual-coverage-honesty');
  assert.equal(cases.length, 6);
  assert.ok(cases.every(c => c.sources.every(s => typeof s.body === 'string' || s.body === null)));
  assert.ok(pack.labels.cases.filter(l => cases.some(c => c.id === l.caseId)).every(l => l.requiredLimitation));
});

test('fixture and support paths are outside the unchanged published files allowlist', async () => {
  const pack = await load(); api.validateK09(pack);
  const files = pack.productionPackage.files;
  for (const path of ['test/fixtures/k09/v1/corpus.json', 'test/fixtures/k09/v1/labels.json', 'scripts/validate-k09.mjs', 'test/k09-offline.test.mjs']) {
    assert.equal(files.some(entry => path === entry || path.startsWith(entry + '/')), false);
  }
  assert.equal(pack.productionPackage.version, '0.6.0');
  assert.equal(pack.productionPackage.scripts['test:live'], undefined, 'no successful test:live placeholder');
});

test('actual plan-only CLI reports zero execution and refuses live/execute flags', async () => {
  await load();
  const script = fileURLToPath(new URL('../scripts/validate-k09.mjs', import.meta.url));
  const preload = process.env.QE_K09_OFFLINE_PRELOAD ? ['--import', process.env.QE_K09_OFFLINE_PRELOAD] : [];
  const call = args => spawnSync(process.execPath, [...preload, script, ...args], { encoding: 'utf8', timeout: 10000, env: process.env });
  const result = call(['--plan-only']);
  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.executedModelRequests, 0);
  assert.equal(report.semanticStatus, 'not-run');
  assert.equal(report.requestedRoute.provider, 'ollama-cloud');
  assert.equal(report.actualModel, null);
  assert.equal(report.priceKnown, false);
  assert.ok(!result.stdout.includes('K09_ORACLE_ONLY_345_SENTINEL'));
  for (const flag of ['--live', '--execute']) {
    const denied = call([flag]);
    assert.equal(denied.status, 2);
    assert.equal(JSON.parse(denied.stdout).executedModelRequests, 0);
  }
});
