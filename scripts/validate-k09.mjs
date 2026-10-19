// Read-only validation of the concrete K09/v1 OFFLINE preparation family.
// No SDK, provider, runtime, shell execution or semantic-result generation.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = new URL('../', import.meta.url);
const FIXTURE = new URL('../test/fixtures/k09/v1/', import.meta.url);
export const FIXTURE_FILES = ['corpus.json', 'labels.json', 'split.json', 'acceptance-plan.json', 'review-instructions.md', 'README.md'];
// File acquisition is this fixed allowlist, NEVER paths supplied by a manifest,
//corpus source, CLI flag or model. No recursive checkout scan is performed.
export const BOUND_FILES = [
  'package.json', 'src/builtins/evaluators.ts', 'src/builtins/prompts.ts',
  'src/contracts.ts', 'src/models.ts', 'src/runtime.ts', 'src/context.ts',
  'src/adapters/pi-models.ts', 'resources/prompts/engineering-v1.md',
  'resources/prompts/evaluation-v1.schema.json', 'scripts/validate-k09.mjs',
  'test/k09-offline.test.mjs',
];
const DOMAINS = ['task-instructions', 'architecture-proportionality', 'test-specific-production', 'operational-logging', 'progress-waiting-repetition', 'completion-verification', 'visual-coverage-honesty'];
const SOURCE_PATHS = ['task.md', 'requirements.md', 'implementation.txt', 'observations.json'];
const SOURCE_ROLES = ['evidence', 'requirement', 'evidence', 'evidence'];
const CLASSES = ['supported-finding', 'no-supported-finding', 'conflicting-requirements', 'insufficient-evidence', 'suspected-needs-investigation'];
const HASH = /^[a-f0-9]{64}$/;
export class K09Error extends Error { constructor(code) { super(code); this.code = code; } }
const need = (condition, code) => { if (!condition) throw new K09Error(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const strings = value => Array.isArray(value) && value.every(text);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const keys = (value, names) => object(value) && Object.keys(value).length === names.length && names.every(n => Object.hasOwn(value, n));
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const semanticDigest = value => sha256(JSON.stringify(value));
export function fraction(numerator, denominator) {
  need(integer(numerator) && integer(denominator) && numerator <= denominator, 'metric-counts');
  return { numerator, denominator, value: denominator === 0 ? null : numerator / denominator };
}

export async function loadK09() {
  const raw = {};
  for (const name of [...FIXTURE_FILES, 'freeze.json']) {
    const bytes = await readFile(new URL(name, FIXTURE));
    need(bytes.byteLength <= 262144, 'artifact-byte-bound'); raw[name] = bytes;
  }
  const parse = name => { try { return JSON.parse(raw[name].toString('utf8')); } catch { throw new K09Error('artifact-json'); } };
  const bound = {};
  for (const path of BOUND_FILES) bound[path] = await readFile(new URL(path, ROOT));
  return {
    corpus: parse('corpus.json'), labels: parse('labels.json'), split: parse('split.json'),
    plan: parse('acceptance-plan.json'), manifest: parse('freeze.json'),
    reviewInstructions: raw['review-instructions.md'].toString('utf8'),
    readme: raw['README.md'].toString('utf8'), raw, bound,
    productionPackage: JSON.parse(bound['package.json'].toString('utf8')),
  };
}

// A selection snapshot ONLY. Call validateK09 before using it. Deliberately
//whitelists evaluator-visible fields; it never reads labels/group/split/plan.
// Fixture IDs do not impersonate runtime-issued evidence references.
export function evaluatorInput(pack, caseId) {
  const c = pack.corpus.cases.find(item => item.id === caseId);
  need(c !== undefined, 'unknown-case');
  return {
    caseId: c.id, reviewScope: c.reviewScope, assessmentSequence: c.assessmentSequence,
    criterion: c.criterion,
    sources: c.sources.map(s => ({ id: s.id, path: s.path, role: s.role, revision: s.revision,
      availability: s.availability, selection: s.selection, body: s.body, sha256: s.sha256 })),
  };
}

export function validateK09(pack) {
  const { corpus, labels, split, plan } = pack;
  need(keys(corpus, ['schemaVersion', 'revision', 'sourceRevision', 'origin', 'domains', 'cases']) && corpus.schemaVersion === 1 && text(corpus.revision) && text(corpus.sourceRevision) && text(corpus.origin), 'corpus-shape');
  need(JSON.stringify(corpus.domains) === JSON.stringify(DOMAINS) && Array.isArray(corpus.cases) && corpus.cases.length === 42, 'corpus-population');
  need(object(split) && split.schemaVersion === 1 && text(split.unit) && split.unit.startsWith('independent') && split.tuningPerformed === false && Array.isArray(split.groups) && split.groups.length === 14, 'split-shape');
  const groups = new Map();
  for (const g of split.groups) {
    need(keys(g, ['id', 'domain', 'split', 'context']) && /^group-\d{3}$/.test(g.id) && DOMAINS.includes(g.domain) && ['calibration', 'held-out'].includes(g.split) && text(g.context) && !groups.has(g.id), 'split-shape');
    groups.set(g.id, { ...g, cases: [] });
  }
  for (const domain of DOMAINS) {
    const list = [...groups.values()].filter(g => g.domain === domain);
    need(list.length === 2 && list.filter(g => g.split === 'calibration').length === 1 && list.filter(g => g.split === 'held-out').length === 1, 'split-population');
  }
  const cases = new Map();
  for (const c of corpus.cases) {
    need(keys(c, ['id', 'group', 'domain', 'criterion', 'assessmentSequence', 'reviewScope', 'sources']) && /^case-\d{3}$/.test(c.id) && !cases.has(c.id) && text(c.criterion) && text(c.reviewScope) && integer(c.assessmentSequence), 'case-shape');
    need(groups.has(c.group) && groups.get(c.group).domain === c.domain, 'group-population');
    need(Array.isArray(c.sources) && c.sources.length === 4, 'source-shape');
    const ids = new Set();
    for (const [index, s] of c.sources.entries()) {
      need(keys(s, ['id', 'path', 'role', 'revision', 'availability', 'selection', 'body', 'sha256']) && text(s.id) && s.id.startsWith(c.id + '-') && !ids.has(s.id) && text(s.revision) && ['provided', 'unavailable'].includes(s.availability) && ['full-fixture', 'excerpt'].includes(s.selection), 'source-shape');
      need(s.path === SOURCE_PATHS[index] && s.role === SOURCE_ROLES[index], 'source-path'); ids.add(s.id);
      if (s.availability === 'provided') need(text(s.body) && Buffer.byteLength(s.body) <= 8192 && HASH.test(s.sha256) && sha256(s.body) === s.sha256, 'source-digest');
      else need(s.body === null && s.sha256 === null, 'source-shape');
    }
    need(c.sources[0].availability === 'provided' && c.sources[2].availability === 'provided' && c.sources[3].availability === 'provided', 'source-shape');
    let trace; try { trace = JSON.parse(c.sources[3].body); } catch { throw new K09Error('trace-shape'); }
    need(keys(trace, ['synthetic', 'completeWindow', 'assessmentSequence', 'events']) && trace.synthetic === true && typeof trace.completeWindow === 'boolean' && Array.isArray(trace.events) && trace.events.length > 0 && trace.events.length <= 12, 'trace-shape');
    need(trace.assessmentSequence === c.assessmentSequence && trace.events.length === c.assessmentSequence && trace.events.every((e, i) => e.sequence === i + 1 && e.sequence <= c.assessmentSequence), 'assessment-cutoff');
    let currentConfig = null; const codeRevisions = new Set();
    for (const e of trace.events) {
      need(['snapshot', 'configuration-edit', 'verification', 'supplied-observation'].includes(e.kind), 'trace-shape');
      if (e.kind === 'snapshot') { need(e.revision === c.sources[2].revision && e.artifact === 'implementation.txt', 'verification-revision'); codeRevisions.add(e.revision); currentConfig = e.configRevision; }
      if (e.kind === 'configuration-edit') { need(text(e.configRevision), 'verification-revision'); currentConfig = e.configRevision; }
      if (e.kind === 'supplied-observation') need(text(e.text), 'trace-shape');
      if (e.kind === 'verification') {
        need(['requested', 'started', 'complete'].includes(e.state) && (e.state === 'complete' ? integer(e.exitCode) : e.exitCode === null), 'verification-state');
        need(codeRevisions.has(e.codeRevision) && e.configRevision === currentConfig && text(e.testRevision) && text(e.environmentRevision) && e.provenance === 'declared-synthetic-not-executed', 'verification-revision');
      }
    }
    groups.get(c.group).cases.push(c.id); cases.set(c.id, c);
  }
  need([...groups.values()].every(g => g.cases.length === 3), 'group-population');
  need(keys(labels, ['schemaVersion', 'revision', 'status', 'oracleOnlyMarker', 'independentAdjudication', 'cases']) && labels.schemaVersion === 1 && labels.status === 'author-proposed-unadjudicated' && text(labels.oracleOnlyMarker) && text(labels.independentAdjudication) && Array.isArray(labels.cases) && labels.cases.length === cases.size, 'labels-shape');
  const labelMap = new Map(); const buckets = { violation: 0, 'near-miss': 0, limited: 0 };
  for (const l of labels.cases) {
    need(keys(l, ['caseId', 'bucket', 'classification', 'expectedScope', 'expectedFindingOrLimitation', 'rationaleSourceRefs', 'requirementRefs', 'acceptableConclusions', 'acceptableAlternatives', 'proportionateResponse', 'requiredLimitation', 'forbiddenResponses']) && cases.has(l.caseId) && !labelMap.has(l.caseId) && Object.hasOwn(buckets, l.bucket) && CLASSES.includes(l.classification) && [l.expectedScope, l.expectedFindingOrLimitation, l.proportionateResponse].every(text) && strings(l.acceptableAlternatives) && l.acceptableAlternatives.length >= 2 && strings(l.forbiddenResponses) && typeof l.requiredLimitation === 'boolean', 'label-shape');
    const c = cases.get(l.caseId), sources = new Map(c.sources.map(s => [s.id, s]));
    need(strings(l.rationaleSourceRefs) && l.rationaleSourceRefs.length > 0 && l.rationaleSourceRefs.every(id => sources.has(id)), 'label-reference');
    need(strings(l.requirementRefs) && l.requirementRefs.every(id => sources.has(id) && sources.get(id).role === 'requirement' && sources.get(id).availability === 'provided') && (l.bucket !== 'violation' || l.requirementRefs.length > 0), 'label-requirement');
    need(strings(l.acceptableConclusions) && l.acceptableConclusions.length > 0 && l.acceptableConclusions.every(x => ['findings', 'no-supported-finding', 'conflicting-requirements', 'undetermined'].includes(x)), 'label-shape');
    need(l.bucket === 'violation' ? l.classification === 'supported-finding' : l.bucket === 'near-miss' ? l.classification === 'no-supported-finding' : !['supported-finding', 'no-supported-finding'].includes(l.classification), 'label-population');
    if (l.bucket === 'violation') need(c.sources.every(s => s.availability === 'provided'), 'label-requirement');
    if (l.bucket === 'limited' || c.domain === 'visual-coverage-honesty') need(l.requiredLimitation, 'label-population');
    buckets[l.bucket]++; labelMap.set(l.caseId, l);
  }
  for (const g of groups.values()) need(g.cases.map(id => labelMap.get(id).bucket).sort().join(',') === 'limited,near-miss,violation', 'label-population');
  need(object(plan) && plan.schemaVersion === 1 && text(plan.revision) && plan.state === 'offline-preparation-only' && plan.policyApproval === 'proposal-not-independently-approved' && plan.evaluationStatus === 'not-run', 'plan-shape');
  need(plan.tuple?.corpusRevision === corpus.revision && plan.tuple.sourceRevision === corpus.sourceRevision && plan.tuple.labelsRevision === labels.revision && plan.tuple.splitRevision === split.revision, 'plan-tuple');
  need(plan.evaluator?.use === 'core.chat' && plan.evaluator.options.maxOutputTokens === 1024 && plan.evaluator.options.repairAttempts === 0 && plan.resources?.questions === null && plan.reaction?.mode === 'observe' && plan.reaction.policy === 'core.record-only' && plan.reaction.actionGrants.length === 0, 'plan-profile');
  need(plan.modelProfile?.provider === 'ollama-cloud' && plan.modelProfile.model === 'deepseek-v4.1-flash' && plan.modelProfile.actualModel === null && plan.modelProfile.actualRevision === null && plan.modelProfile.price === 'unknown' && plan.modelProfile.maxAttempts === 1 && plan.modelProfile.reasoning === 'off', 'plan-route');
  need(plan.visual?.actualImageSet === null && plan.visual.actualReferenceSet === null && plan.visual.recommendVisualCapability === false, 'plan-visual');
  const splitCases = { calibration: 0, 'held-out': 0 };
  for (const g of groups.values()) splitCases[g.split] += g.cases.length;
  const inventory = plan.inventory;
  need(inventory?.calibrationCases === splitCases.calibration && inventory.heldOutCases === splitCases['held-out'] && inventory.repetitions === 1 && inventory.promptCandidates === 1 && inventory.routes === 1 && inventory.maximumOwnedRequests === cases.size && inventory.calibrationRequests + inventory.heldOutRequests === cases.size && inventory.heldOutEligibleViolations === 7 && inventory.heldOutNearMisses === 7 && inventory.heldOutLimitedCases === 7, 'plan-inventory');
  const b = plan.bounds;
  need(object(b) && b.concurrency === 1 && b.maxOwnedRequests === cases.size && b.maxRequestsPerCase === 1 && b.maxRequestsPerPhase === 21 && b.maxPrimaryRequests === 0 && b.maxReviewers === 0 && b.maxToolCalls === 0 && b.maxRetries === 0 && b.maxRepairs === 0 && b.maxOutputTokensPerRequest === 1024 && b.maxOutputTokensCampaign === cases.size * b.maxOutputTokensPerRequest && b.maxFullSdkJsonBytesCampaign === cases.size * b.maxFullSdkJsonBytesPerRequest && b.requestTimeoutMs === plan.modelProfile.requestTimeoutMs && b.requestTimeoutMs <= b.caseWorkMs && b.caseWorkMs + b.cleanupGraceMs === b.caseTotalMs && b.phaseWallMs >= 21 * b.caseTotalMs && b.campaignWallMs >= cases.size * b.caseTotalMs + b.finalizationReserveMs && b.independentOuterWatchdogMs > b.campaignWallMs, 'plan-bounds');
  const gates = plan.gates;
  for (const name of ['structuredValidity', 'findingPrecision', 'violationDetection', 'falseCorrection', 'coverageHonesty', 'overIntervention']) need(object(gates?.[name]) && typeof gates[name].value === 'number' && Number.isFinite(gates[name].value) && gates[name].value >= 0 && gates[name].value <= 1 && text(gates[name].numerator) && text(gates[name].denominator), 'gate-definition');
  need(gates.structuredValidity.plannedDenominator === 21 && gates.structuredValidity.minimumPassingCountIfAllAttempted === Math.ceil(21 * gates.structuredValidity.value) && gates.violationDetection.plannedDenominator === 7 && gates.violationDetection.minimumPassingCount === Math.ceil(7 * gates.violationDetection.value) && gates.coverageHonesty.minimumPassingCount === 7 && gates.falseCorrection.value === 0 && gates.coverageHonesty.value === 1 && gates.findingPrecision.minimumApplicableDenominator >= 5 && gates.escalationPrecision.denominator === 0 && gates.escalationPrecision.value === null && text(gates.authorityAndEvidenceSafety.required), 'gate-definition');
  need(plan.money?.unknownCost === 'deny' && plan.money.knownRateBasis === null && plan.money.qualifiedBillableInputCeiling === null && plan.money.status === 'policy-proposal-not-an-allowance-or-price', 'plan-money');
  const cents = value => { need(/^\d+\.\d{2}$/.test(value), 'plan-money'); return BigInt(value.replace('.', '')); };
  need(cents(plan.money.proposedCampaignNominalCap) === BigInt(cases.size) * cents(plan.money.proposedPerCaseNominalCap), 'plan-money');
  // Nothing below is an empirical model metric. Freeze covers both exact raw
  //bytes and parsed meaning so an in-memory mutation cannot borrow old bytes.
  const parsed = { 'corpus.json': corpus, 'labels.json': labels, 'split.json': split, 'acceptance-plan.json': plan };
  const manifest = pack.manifest;
  need(object(manifest) && manifest.schemaVersion === 1 && manifest.candidate === plan.tuple.candidate && object(manifest.files) && object(manifest.boundFiles) && object(manifest.selectedInputs), 'freeze-shape');
  need(Object.keys(manifest.files).length === FIXTURE_FILES.length && Object.keys(manifest.boundFiles).length === BOUND_FILES.length && Object.keys(manifest.selectedInputs).length === cases.size, 'freeze-mismatch');
  for (const name of FIXTURE_FILES) {
    const expected = manifest.files[name], raw = pack.raw[name];
    need(object(expected) && raw && raw.length === expected.bytes && sha256(raw) === expected.sha256, 'freeze-mismatch');
    const semantic = Object.hasOwn(parsed, name) ? semanticDigest(parsed[name]) : sha256(name === 'review-instructions.md' ? pack.reviewInstructions : pack.readme);
    need(semantic === expected.semanticSHA256, 'freeze-mismatch');
  }
  for (const path of BOUND_FILES) need(pack.bound[path] && manifest.boundFiles[path]?.bytes === pack.bound[path].length && manifest.boundFiles[path].sha256 === sha256(pack.bound[path]), 'freeze-mismatch');
  for (const c of cases.values()) {
    const input = evaluatorInput(pack, c.id), serialized = JSON.stringify(input);
    need(semanticDigest(input) === manifest.selectedInputs[c.id] && !serialized.includes(labels.oracleOnlyMarker), 'freeze-mismatch');
    need(Buffer.byteLength(serialized) <= 12288, 'selected-input-bound');
  }
  need(pack.productionPackage.version === '0.6.0' && !Object.hasOwn(pack.productionPackage.scripts, 'test:live') && Array.isArray(pack.productionPackage.files) && pack.productionPackage.files.every(path => !['test', 'scripts'].some(prefix => path === prefix || path.startsWith(prefix + '/'))), 'package-boundary');
  return {
    status: 'valid-offline-inputs', cases: cases.size, groups: groups.size, domains: DOMAINS.length,
    splitCases, buckets, plannedModelRequests: inventory.maximumOwnedRequests,
    executedModelRequests: 0, semanticStatus: 'not-run', semanticMetrics: null,
    requestedRoute: { provider: plan.modelProfile.provider, model: plan.modelProfile.model, reasoning: plan.modelProfile.reasoning },
    actualModel: null, actualRevision: null, priceKnown: false,
    policyApproval: plan.policyApproval, automaticCorrectiveUse: 'unavailable',
    candidate: plan.tuple.candidate, planRevision: plan.revision, planDigest: sha256(pack.raw['acceptance-plan.json']),
    freezeDigest: sha256(pack.raw['freeze.json']), bounds: b,
    dataDestination: 'No files or model outputs are generated by this validator. Future execution needs a new explicit authorized output root.',
    boundary: 'Offline fixture/selection/freeze validation only; not production context delivery, model judgment, promotion, spending authority, D-39 or K09 acceptance.',
  };
}

async function main() {
  if (process.argv.slice(2).some(arg => arg !== '--plan-only') || process.argv.length > 3) {
    console.log(JSON.stringify({ status: 'unsupported-operation', executedModelRequests: 0 })); process.exitCode = 2; return;
  }
  try { console.log(JSON.stringify(validateK09(await loadK09()))); }
  catch (error) { console.log(JSON.stringify({ status: 'invalid-offline-inputs', code: error instanceof K09Error ? error.code : 'artifact-unavailable-or-invalid', executedModelRequests: 0 })); process.exitCode = 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
