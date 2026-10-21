import { createHash, createHmac, randomBytes } from "node:crypto";
// Canonical C1 context assembly, provenance metadata and derived coverage.
//
// Providers are invoked through the public ContextDefinition.collect contract.
// The assembler derives coverage itself from actual item budgets; omitted
// content is removed from the evaluator snapshot entirely. Every functional
// label that reaches O1 (resource URI, revision, section heading, derived
// method, dependency identity) is converted into an engine-issued opaque
// reference before any sink, so raw heading text, absolute paths and external
// revisions cannot leak by being renamed. Assessment resources (instructions,
// questions and the result schema) are measured as one boundary with the
// selected context and must fit the plan and runtime ceilings before the
// evaluator is admitted.

import { Buffer } from "node:buffer";
import type {
  AssessmentResources,
  ContentBlock,
  ContextBatch,
  ContextDefinition,
  ContextItem,
  ContextManifestData,
  ContextManifestPartData,
  ContextPlan,
  ContextSnapshot,
  Coverage,
  CoverageIssue,
  EvidenceAccess,
  EvidenceDependency,
  Json,
  JsonObject,
  ManifestItemMetadata,
  Provenance,
  Result,
  RunRef,
  RuntimeView,
  SizeBoundary,
  SizeMeasurement,
  EvaluationServices,
} from "./contracts.js";
import { copyJsonData, type ResolvedComponent } from "./registry.js";

const MAX_ITEM_BYTES_COPY_DEPTH = 8;
const MAX_PLAIN_KEYS = 64;
const MAX_CONTENT_BLOCKS = 32;
const MAX_LABEL_CHARS = 512;
const BOUNDED_METHOD_PATTERN = /^[a-z][a-z0-9._:-]{0,63}$/;
const BOUNDED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;

export interface ContextProviderSummary {
  sourceId: string;
  required: boolean;
  selectionState: "included" | "omitted" | "unavailable" | "denied";
  resourceRefs: string[];
  sizes: SizeMeasurement[];
  omittedCount: number;
  reasonCode: string | null;
}

export interface AssembledContext {
  snapshot: ContextSnapshot;
  resources: AssessmentResources;
  providerSummaries: ContextProviderSummary[];
  manifest: ContextManifestData;
  manifestPart: ContextManifestPartData;
  manifestParts: ContextManifestPartData[];
  omittedItems: number;
  selectedBytes: number;
  issueCodes: string[];
}

export interface ContextAssemblyHooks {
  acceptsReasonCode: (componentId: string, code: string) => boolean;
  isAcceptedIdentity: (value: string) => boolean;
  /**
   * Returns the approved revision of a shipped builtin artifact at the owning
   * resolver/artifact boundary, or null when the URI is not a real shipped
   * artifact. A `builtin:` spelling alone proves nothing.
   */
  expectedBuiltinRevision: (uri: string) => string | null;
}

/**
 * Private engine-owned association from an admitted item occurrence to its
 * selected asset projection. It is attached non-enumerably to the exact
 * admitted object, so repeated admissions of equal raw input still keep
 * distinct occurrences and preparation joins the object, not a raw ID.
 */
export const ITEM_ASSET: unique symbol = Symbol("qe.context-item-asset");
export type ItemAssetEntry = NonNullable<AssessmentResources["assets"]>[number];

/**
 * Private engine-owned list of resource-provenance assets that belong to the
 * measurement boundary rather than to one admitted item occurrence.
 */
export const PROVENANCE_ASSETS: unique symbol = Symbol("qe.context-provenance-assets");

export interface ContextAssemblyInput {
  /** Prompt-scoped evidence facade bound to the declaring configuration. */
  promptEvidence?: EvidenceAccess | undefined;
  run: RunRef;
  plan: ContextPlan;
  promptBinding: { use: string; options: JsonObject };
  criterionIds: readonly string[];
  maxEvidenceBytes: number;
  view: RuntimeView;
  evidence: EvidenceAccess;
  /**
   * Run-owned issuer created before any acquisition and shared by assembly and
   * preparation. Direct callers without a run owner get a private issuer.
   */
  tokens?: ReferenceTokens | undefined;
  /**
   * Binds the run-owned evidence facade to the resolved component/binding for
   * private acquisition capture; it carries the read owner without a mutable
   * current-run pointer.
   */
  bindEvidence?: ((componentId: string, bindingId: string | null, evidence: EvidenceAccess) => EvidenceAccess) | undefined;
  models: Pick<EvaluationServices, "request">;
  hooks: ContextAssemblyHooks;
  resolve: (use: string, options: JsonObject) => Result<ResolvedComponent>;
}

export function sizeMeasurement(
  boundary: SizeBoundary,
  utf8Bytes: number | null,
  options: { unicodeScalars?: number | null; lines?: number | null; complete?: boolean } = {},
): SizeMeasurement {
  return {
    boundary,
    utf8Bytes,
    unicodeScalars: options.unicodeScalars ?? null,
    lines: options.lines ?? null,
    estimatedTokens: null,
    complete: options.complete ?? true,
  };
}

// ---------------------------------------------------------------------------
// Descriptor-only plain-data admission (no getters, toJSON or shared objects)
// ---------------------------------------------------------------------------

function dataAt(container: object, key: string): { present: boolean; value: unknown } {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) return { present: false, value: undefined };
  if (!("value" in descriptor)) return { present: true, value: undefined };
  return { present: true, value: descriptor.value };
}

function dataArray(value: unknown, max: number): unknown[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) return null;
    items.push(descriptor.value);
  }
  return items;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function copyPlainJson(value: unknown, depth: number): { ok: true; value: Json } | { ok: false } {
  if (value === null || typeof value === "boolean" || typeof value === "string") return { ok: true, value };
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (depth > MAX_ITEM_BYTES_COPY_DEPTH) return { ok: false };
  if (Array.isArray(value)) {
    const items = dataArray(value, MAX_PLAIN_KEYS);
    if (items === null) return { ok: false };
    const copied: Json[] = [];
    for (const item of items) {
      const nested = copyPlainJson(item, depth + 1);
      if (!nested.ok) return nested;
      copied.push(nested.value);
    }
    return { ok: true, value: copied };
  }
  if (!isPlainRecord(value)) return { ok: false };
  const toJson = dataAt(value, "toJSON");
  if (toJson.present && typeof toJson.value === "function") return { ok: false };
  const copied: JsonObject = {};
  let count = 0;
  for (const key of Object.keys(value)) {
    count += 1;
    if (count > MAX_PLAIN_KEYS) return { ok: false };
    const nested = copyPlainJson(dataAt(value, key).value, depth + 1);
    if (!nested.ok) return nested;
    copied[key] = nested.value;
  }
  return { ok: true, value: copied };
}

function boundedLabel(value: unknown, max = MAX_LABEL_CHARS): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function admitContentBlocks(value: unknown): ContentBlock[] | null {
  const rawBlocks = dataArray(value, MAX_CONTENT_BLOCKS);
  if (rawBlocks === null) return null;
  const blocks: ContentBlock[] = [];
  for (const raw of rawBlocks) {
    if (!isPlainRecord(raw)) return null;
    const type = dataAt(raw, "type").value;
    if (type === "text") {
      const text = dataAt(raw, "text").value;
      if (typeof text !== "string") return null;
      blocks.push({ type: "text", text });
    } else if (type === "json") {
      const copied = copyPlainJson(dataAt(raw, "value").value, 0);
      if (!copied.ok) return null;
      blocks.push({ type: "json", value: copied.value });
    } else if (type === "image") {
      const artifactId = boundedLabel(dataAt(raw, "artifactId").value);
      const mimeType = boundedLabel(dataAt(raw, "mimeType").value);
      const width = dataAt(raw, "width").value;
      const height = dataAt(raw, "height").value;
      if (artifactId === null || mimeType === null
        || typeof width !== "number" || !Number.isInteger(width) || width < 0
        || typeof height !== "number" || !Number.isInteger(height) || height < 0) return null;
      blocks.push({ type: "image", artifactId, mimeType, width, height });
    } else {
      return null;
    }
  }
  return blocks;
}

function admitSelection(value: unknown): Provenance["selection"] | null {
  if (!isPlainRecord(value)) return null;
  const kind = dataAt(value, "kind").value;
  if (kind === "full") return { kind: "full" };
  if (kind === "lines") {
    const start = dataAt(value, "start").value;
    const end = dataAt(value, "end").value;
    if (typeof start !== "number" || !Number.isInteger(start) || start < 0
      || typeof end !== "number" || !Number.isInteger(end) || end < start) return null;
    return { kind: "lines", start, end };
  }
  if (kind === "sections") {
    const rawHeadings = dataArray(dataAt(value, "headings").value, 16);
    if (rawHeadings === null) return null;
    const headings: string[] = [];
    for (const heading of rawHeadings) {
      if (typeof heading !== "string") return null;
      headings.push(heading);
    }
    return { kind: "sections", headings };
  }
  if (kind === "derived") {
    const rawIds = dataArray(dataAt(value, "inputIds").value, 16);
    const method = dataAt(value, "method").value;
    if (rawIds === null || typeof method !== "string" || method.length > 128) return null;
    const inputIds: string[] = [];
    for (const id of rawIds) {
      if (typeof id !== "string" || !BOUNDED_ID_PATTERN.test(id)) return null;
      inputIds.push(id);
    }
    return { kind: "derived", inputIds, method };
  }
  return null;
}

/** Admits one contributed context item as plain data, stamping the owning component. */
export function admitContextItem(raw: unknown, sourceId: string): { ok: true; item: ContextItem } | { ok: false; required: boolean } {
  if (!isPlainRecord(raw)) return { ok: false, required: false };
  const requiredValue = dataAt(raw, "required").value;
  const required = requiredValue === true;
  const id = boundedLabel(dataAt(raw, "id").value, 192);
  const role = dataAt(raw, "role").value;
  const roles = ["task", "requirement", "evidence", "reference", "prior-finding"];
  if (id === null || typeof role !== "string" || !roles.includes(role)
    || typeof requiredValue !== "boolean") return { ok: false, required: true };
  const content = admitContentBlocks(dataAt(raw, "content").value);
  if (content === null) return { ok: false, required };
  const rawProvenance = dataAt(raw, "provenance").value;
  if (!isPlainRecord(rawProvenance)) return { ok: false, required };
  const uri = boundedLabel(dataAt(rawProvenance, "uri").value, 2048);
  const revision = boundedLabel(dataAt(rawProvenance, "revision").value, 512);
  const acquiredAt = boundedLabel(dataAt(rawProvenance, "acquiredAt").value, 64);
  const selection = admitSelection(dataAt(rawProvenance, "selection").value);
  const changedDuringRead = dataAt(rawProvenance, "changedDuringRead").value;
  if (uri === null || revision === null || acquiredAt === null || selection === null
    || typeof changedDuringRead !== "boolean") return { ok: false, required };
  const rawTokenEstimate = dataAt(raw, "tokenEstimate").value;
  let tokenEstimate: ContextItem["tokenEstimate"] = null;
  if (rawTokenEstimate !== null && rawTokenEstimate !== undefined) {
    if (!isPlainRecord(rawTokenEstimate)) return { ok: false, required };
    const count = dataAt(rawTokenEstimate, "count").value;
    const method = boundedLabel(dataAt(rawTokenEstimate, "method").value, 64);
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0 || method === null) {
      return { ok: false, required };
    }
    tokenEstimate = { count, method };
  }
  const item: ContextItem = {
    id,
    role: role as ContextItem["role"],
    required,
    content,
    // The runtime owns the source identity; a provider cannot rename itself.
    provenance: { sourceId, uri, revision, acquiredAt, selection, changedDuringRead },
    bytes: 0,
    tokenEstimate,
  };
  item.bytes = Buffer.byteLength(JSON.stringify(item.content), "utf8");
  return { ok: true, item };
}

function admitEvidenceDependency(raw: unknown): EvidenceDependency | null {
  if (!isPlainRecord(raw)) return null;
  const evidenceId = dataAt(raw, "evidenceId").value;
  const revision = dataAt(raw, "revision").value;
  const relevance = dataAt(raw, "relevance").value;
  const check = dataAt(raw, "check").value;
  if (typeof evidenceId !== "string" || !BOUNDED_ID_PATTERN.test(evidenceId)) return null;
  if (typeof revision !== "string" || revision.length === 0 || revision.length > 512) return null;
  if (relevance !== "authority" && relevance !== "conclusion" && relevance !== "supporting") return null;
  if (check !== "content-fingerprint" && check !== "host-cursor" && check !== "external-revision" && check !== "unknown") return null;
  return { evidenceId, revision, relevance, check };
}

// ---------------------------------------------------------------------------
// Engine-issued opaque reference tokens (O1 §5.3 / §7.7 / §15.3-15.4)
// ---------------------------------------------------------------------------

export class ReferenceTokens {
  readonly #hooks: ContextAssemblyHooks;
  /** Constant-size session tokenization key; never logged, exported or authorized. */
  readonly #key: string;
  readonly #sectionRefs = new Map<string, string>();
  readonly #inputRefs = new Map<string, string>();
  readonly #methodRefs = new Map<string, string>();
  #sequence = 0;

  constructor(hooks: ContextAssemblyHooks, key?: string) {
    this.#hooks = hooks;
    this.#key = key ?? randomBytes(16).toString("hex");
  }

  #next(prefix: string): string {
    this.#sequence += 1;
    return `${prefix}-${this.#sequence}`;
  }

  /**
   * Domain-separated keyed issuance over the trusted resource/version
   * identity: equal resource+version yields the same opaque reference across
   * runs of one observed session without retaining a raw catalogue, and a new
   * version yields a new reference instead of overwriting a descriptor.
   */
  #token(prefix: string, domain: string, parts: readonly string[]): string {
    const digest = createHmac("sha256", this.#key)
      .update(`${domain}\u0000${parts.join("\u0000")}`, "utf8")
      .digest("hex")
      .slice(0, 24);
    return `${prefix}-${digest}`;
  }

  resource(sourceId: string, uri: string): string {
    // A literal identity is allowed only for a verified shipped artifact.
    if (this.#hooks.expectedBuiltinRevision(uri) !== null) return uri;
    return this.#token("res", "qe-resource", [sourceId, uri]);
  }

  revision(sourceId: string, uri: string, revision: string): string {
    if (this.#hooks.expectedBuiltinRevision(uri) === revision) return revision;
    if (this.#hooks.isAcceptedIdentity(revision)) return revision;
    return this.#token("rev", "qe-revision", [sourceId, uri, revision]);
  }

  section(sourceId: string, heading: string): string {
    const key = `${sourceId}\u0000${heading}`;
    const existing = this.#sectionRefs.get(key);
    if (existing !== undefined) return existing;
    const token = this.#next("sec");
    this.#sectionRefs.set(key, token);
    return token;
  }

  input(sourceId: string, inputId: string): string {
    if (this.#hooks.isAcceptedIdentity(inputId)) return inputId;
    const key = `${sourceId}\u0000${inputId}`;
    const existing = this.#inputRefs.get(key);
    if (existing !== undefined) return existing;
    const token = this.#next("ref");
    this.#inputRefs.set(key, token);
    return token;
  }

  method(sourceId: string, method: string): string {
    if (BOUNDED_METHOD_PATTERN.test(method)) return method;
    const key = `${sourceId}\u0000${method}`;
    const existing = this.#methodRefs.get(key);
    if (existing !== undefined) return existing;
    const token = this.#next("meth");
    this.#methodRefs.set(key, token);
    return token;
  }
}

type DerivedInputResolver = (sourceId: string, inputId: string) => string | null;

function manifestItem(item: ContextItem, tokens: ReferenceTokens, resolveInput: DerivedInputResolver): ManifestItemMetadata {
  const selection = item.provenance.selection;
  return {
    itemId: tokens.input(item.provenance.sourceId, item.id),
    resourceId: tokens.resource(item.provenance.sourceId, item.provenance.uri),
    sourceId: item.provenance.sourceId,
    role: item.role,
    required: item.required,
    revisionRef: tokens.revision(item.provenance.sourceId, item.provenance.uri, item.provenance.revision),
    selection: {
      kind: selection.kind,
      ranges: selection.kind === "lines" ? [{ start: selection.start, end: selection.end }] : [],
      sectionRefs: selection.kind === "sections"
        ? selection.headings.map(heading => tokens.section(item.provenance.sourceId, heading))
        : [],
      inputRefs: selection.kind === "derived"
        ? selection.inputIds.flatMap(inputId => {
          const resolved = resolveInput(item.provenance.sourceId, inputId);
          return resolved === null ? [] : [resolved];
        })
        : [],
      methodId: selection.kind === "derived" ? tokens.method(item.provenance.sourceId, selection.method) : "full",
    },
    disposition: "included",
    changedDuringRead: item.provenance.changedDuringRead,
    sizes: [sizeMeasurement("selected", item.bytes)],
    captureRefs: [],
  };
}

interface AssessmentMeasurement {
  totalBytes: number;
  instructionRefs: string[];
}

/**
 * Measures the whole normalized assessment resource package exactly as the
 * evaluator will receive it: instructions (content and provenance), questions,
 * the output contract and the criterion list share one boundary.
 */
function measureAssessmentResources(resources: AssessmentResources): { ok: true; value: AssessmentMeasurement } | { ok: false } {
  try {
    const totalBytes = Buffer.byteLength(JSON.stringify(resources), "utf8");
    return { ok: true, value: { totalBytes, instructionRefs: resources.instructions.map(instruction => instruction.provenance.uri) } };
  } catch {
    return { ok: false };
  }
}

export async function assembleContext(input: ContextAssemblyInput): Promise<Result<AssembledContext>> {
  const manifestId = `manifest-${input.run.runId}`;
  const snapshotId = `snapshot-${input.run.runId}`;
  const tokens = input.tokens ?? new ReferenceTokens(input.hooks);
  const items: ContextItem[] = [];
  const providerSummaries: ContextProviderSummary[] = [];
  const issueCodes = new Set<string>();
  const dependencies: EvidenceDependency[] = [];
  const issues: CoverageIssue[] = [];
  let requiredItems = 0;
  let includedRequiredItems = 0;
  let optionalItems = 0;
  let includedOptionalItems = 0;
  let omittedItems = 0;
  let selectedBytes = 0;
  let anyProviderPartial = false;
  let requiredMissing = false;

  const safeReasonCode = (componentId: string, code: unknown): string => {
    if (typeof code === "string" && code.length <= 96 && input.hooks.acceptsReasonCode(componentId, code)) return code;
    return "core.context-provider-issue";
  };

  const promptResolved = input.resolve(input.promptBinding.use, input.promptBinding.options);
  if (!promptResolved.ok || promptResolved.value.kind !== "prompt") {
    return {
      ok: false,
      error: {
        code: promptResolved.ok ? "core.component-failed" : promptResolved.error.code,
        retryable: false,
        field: "prompt",
      },
    };
  }
  const promptComponentId = promptResolved.value.componentId;
  const promptDefinition = promptResolved.value.definition;
  let resources: AssessmentResources;
  let promptChangedDuringRead = false;
  let promptInstructionRefs: string[] = [];
  let promptInstructions: ContextItem[] = [];
  let promptResourceProvenance: Array<{ kind: "instruction" | "questions" | "resultSchema"; uri: string; revision: string; changedDuringRead: boolean }> = [];
  let promptResourceProvenanceChanged = false;
  try {
    // Acquired prompt resources are captured through the same run-owned
    // boundary as context sources, before parsing or normalization can fail.
    const promptFacade = input.promptEvidence ?? input.evidence;
    const boundPromptEvidence = input.bindEvidence === undefined
      ? promptFacade
      : input.bindEvidence(promptComponentId, null, promptFacade);
    const built = await promptDefinition.build(input.promptBinding.options, {
      ...promptResolved.value.lifecycle(),
      run: input.run,
      view: input.view,
      evidence: boundPromptEvidence,
      models: input.models,
    });
    if (!isPlainRecord(built) || dataAt(built, "ok").value !== true) {
      return { ok: false, error: { code: "core.prompt-provider-error", retryable: false } };
    }
    const builtValue = dataAt(built, "value").value;
    if (!isPlainRecord(builtValue)) {
      return { ok: false, error: { code: "core.prompt-provider-error", retryable: false } };
    }
    const resourcesRevision = boundedLabel(dataAt(builtValue, "resourceRevision").value, 192);
    const rawInstructions = dataArray(dataAt(builtValue, "instructions").value, 16);
    const rawQuestions = dataAt(builtValue, "questions").value;
    if (resourcesRevision === null || rawInstructions === null) {
      return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false } };
    }
    const instructions: ContextItem[] = [];
    for (const rawInstruction of rawInstructions) {
      const admitted = admitContextItem(rawInstruction, promptComponentId);
      if (!admitted.ok) return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false } };
      instructions.push(admitted.item);
    }
    promptChangedDuringRead = instructions.some(instruction => instruction.provenance.changedDuringRead);
    promptInstructionRefs = instructions.map(instruction => tokens.resource(promptComponentId, instruction.provenance.uri));
    // Schemas describe nested C1 objects and are deeper than source JSON
    // content. Reuse descriptor-only admission (32 levels, 4096 nodes) with
    // the prompt-file resource ceiling, without raising final-input budgets.
    const copiedSchema = copyJsonData(dataAt(builtValue, "resultSchema").value, 262_144);
    if (!copiedSchema.ok) {
      return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false } };
    }
    let normalizedQuestions: AssessmentResources["questions"] = null;
    if (rawQuestions !== null && rawQuestions !== undefined) {
      const copiedQuestions = copyPlainJson(rawQuestions, 0);
      if (!copiedQuestions.ok || copiedQuestions.value === null || Array.isArray(copiedQuestions.value) || typeof copiedQuestions.value !== "object") {
        return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false } };
      }
      normalizedQuestions = copiedQuestions.value as unknown as AssessmentResources["questions"];
    }
    const rawProvenance = dataArray(dataAt(builtValue, "resourceProvenance").value, 16);
    const resourceProvenance: Array<{ kind: "instruction" | "questions" | "resultSchema"; uri: string; revision: string; changedDuringRead: boolean }> = [];
    if (rawProvenance !== null) {
      for (const rawEntry of rawProvenance) {
        if (!isPlainRecord(rawEntry)) continue;
        const kind = dataAt(rawEntry, "kind").value;
        const uri = dataAt(rawEntry, "uri").value;
        const revision = dataAt(rawEntry, "revision").value;
        const changed = dataAt(rawEntry, "changedDuringRead").value;
        if ((kind === "instruction" || kind === "questions" || kind === "resultSchema")
          && typeof uri === "string" && typeof revision === "string" && typeof changed === "boolean") {
          resourceProvenance.push({ kind, uri: uri.slice(0, 2048), revision: revision.slice(0, 512), changedDuringRead: changed });
        }
      }
    }
    promptResourceProvenanceChanged = resourceProvenance.some(entry => entry.changedDuringRead);
    promptInstructions = instructions;
    promptResourceProvenance = resourceProvenance;
    const configuredResources = dataAt(builtValue, "configuredResources").value;
    const configuredQuestions = isPlainRecord(configuredResources) && dataAt(configuredResources, "questions").value === true;
    const configuredSchema = isPlainRecord(configuredResources) && dataAt(configuredResources, "resultSchema").value === true;
    resources = {
      resourceRevision: resourcesRevision,
      instructions,
      questions: normalizedQuestions,
      resultSchema: copiedSchema.value as AssessmentResources["resultSchema"],
      configuredResources: { questions: configuredQuestions, resultSchema: configuredSchema },
      resourceProvenance,
      // The check owns the recognized criterion set; bind it before measuring so
      // the measured object is exactly what the evaluator receives.
      criteria: [...input.criterionIds],
    };
  } catch {
    return { ok: false, error: { code: "core.prompt-provider-error", retryable: false } };
  }
  const assessment = measureAssessmentResources(resources);
  if (!assessment.ok) {
    return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false, field: "prompt" } };
  }
  if (selectedBytes + assessment.value.totalBytes > input.plan.maxBytes
    || selectedBytes + assessment.value.totalBytes > input.maxEvidenceBytes) {
    // Required assessment resources cannot be evicted; the run is declined before
    // the evaluator is admitted instead of passing an oversized input through.
    return { ok: false, error: { code: "core.context-overflow", retryable: false, field: "prompt" } };
  }
  selectedBytes += assessment.value.totalBytes;
  const unstablePromptResource = promptChangedDuringRead || promptResourceProvenanceChanged;
  if (unstablePromptResource) {
    issueCodes.add("core.prompt-resource-changed");
    // An unstable required resource must never present as clean complete
    // coverage, whatever its kind.
    anyProviderPartial = true;
  }
  providerSummaries.push({
    sourceId: promptComponentId,
    required: true,
    selectionState: "included",
    resourceRefs: promptInstructionRefs.slice(0, 16),
    sizes: [sizeMeasurement("selected", assessment.value.totalBytes)],
    omittedCount: 0,
    reasonCode: unstablePromptResource ? "core.prompt-resource-changed" : null,
  });

  // Only actual known unambiguous owned items or accepted external identities
  // may back a derived input ref; unknown labels stay a truthful bounded
  // limitation instead of a freshly minted dangling reference.
  const ownedInputTokens = new Map<string, string>();
  const resolveInputRef: DerivedInputResolver = (sourceKey: string, inputId: string): string | null => {
    const owned = ownedInputTokens.get(inputId);
    if (owned !== undefined) return owned;
    if (input.hooks.isAcceptedIdentity(inputId)) return inputId;
    unresolvedDerivedInputs += 1;
    return null;
  };
  let unresolvedDerivedInputs = 0;
  const selectionTokens = (sourceKey: string, selection: ContextItem["provenance"]["selection"], change: boolean, bytes: number): Omit<NonNullable<AssessmentResources["assets"]>[number], "itemId" | "itemToken" | "resourceId" | "kind" | "revisionRef" | "sourceId"> => ({
    selection: {
      kind: selection.kind,
      ranges: selection.kind === "lines" ? [{ start: selection.start, end: selection.end }] : [],
      sectionRefs: selection.kind === "sections" ? selection.headings.map(heading => tokens.section(sourceKey, heading)) : [],
      inputRefs: selection.kind === "derived" ? selection.inputIds.flatMap(inputId => {
        const resolved = resolveInputRef(sourceKey, inputId);
        return resolved === null ? [] : [resolved];
      }) : [],
      methodId: selection.kind === "derived" ? tokens.method(sourceKey, selection.method) : selection.kind,
    },
    sizes: [{ boundary: "selected", utf8Bytes: bytes, unicodeScalars: null as null, lines: null as null, estimatedTokens: null as null, complete: true }],
    visibility: change ? "partial" : "complete",
    changedDuringRead: change,
  });
  for (const binding of input.plan.providers) {
    const resolved = input.resolve(binding.use, binding.options);
    if (!resolved.ok || resolved.value.kind !== "context") {
      return {
        ok: false,
        error: { code: resolved.ok ? "core.component-failed" : resolved.error.code, retryable: false, field: `context.${binding.id}` },
      };
    }
    const definition: ContextDefinition = resolved.value.definition;
    const componentId = resolved.value.componentId;
    // The evidence facade is bound to this actual component and binding, so
    // acquisitions are attributed to the call that produced them.
    const boundEvidence = input.bindEvidence === undefined
      ? input.evidence
      : input.bindEvidence(componentId, binding.id, input.evidence);
    const bindingItems: ContextItem[] = [];
    const providerField = `context.${binding.id}`;
    let rawBatch: Record<string, unknown>;
    try {
      const collected = await definition.collect(binding.options, {
        ...resolved.value.lifecycle(),
        run: input.run,
        view: input.view,
        evidence: boundEvidence,
        models: input.models,
      });
      if (!isPlainRecord(collected) || dataAt(collected, "ok").value !== true) {
        const code = safeReasonCode(componentId, isPlainRecord(collected) ? dataAt(dataAt(collected, "error").value ?? {}, "code").value : undefined);
        issues.push({ sourceId: componentId, reason: code, required: false, evidenceIds: [] });
        issueCodes.add(code);
        anyProviderPartial = true;
        providerSummaries.push({
          sourceId: componentId,
          required: input.plan.requiredCoverage === "complete",
          selectionState: "unavailable",
          resourceRefs: [],
          sizes: [sizeMeasurement("selected", 0)],
          omittedCount: 0,
          reasonCode: code,
        });
        continue;
      }
      const value = dataAt(collected, "value").value;
      if (!isPlainRecord(value)) throw new Error("invalid batch");
      rawBatch = value;
    } catch {
      issues.push({ sourceId: componentId, reason: "core.context-provider-error", required: false, evidenceIds: [] });
      issueCodes.add("core.context-provider-error");
      anyProviderPartial = true;
      providerSummaries.push({
        sourceId: componentId,
        required: input.plan.requiredCoverage === "complete",
        selectionState: "unavailable",
        resourceRefs: [],
        sizes: [sizeMeasurement("selected", 0)],
        omittedCount: 0,
        reasonCode: "core.context-provider-error",
      });
      continue;
    }

    const rawItems = dataArray(dataAt(rawBatch, "items").value, 128);
    const rawCoverage = dataAt(rawBatch, "coverage").value;
    const rawDependencies = dataArray(dataAt(rawBatch, "dependencies").value, 64);
    if (rawItems === null || !isPlainRecord(rawCoverage) || rawDependencies === null) {
      issues.push({ sourceId: componentId, reason: "core.context-batch-invalid", required: false, evidenceIds: [] });
      issueCodes.add("core.context-batch-invalid");
      anyProviderPartial = true;
      continue;
    }

    let providerBytes = 0;
    let providerOmitted = 0;
    let providerPartial = false;
    for (const rawItem of rawItems) {
      const admitted = admitContextItem(rawItem, componentId);
      if (!admitted.ok) {
        if (admitted.required) requiredMissing = true;
        omittedItems += 1;
        providerOmitted += 1;
        providerPartial = true;
        issues.push({ sourceId: componentId, reason: "core.context-item-invalid", required: admitted.required, evidenceIds: [] });
        issueCodes.add("core.context-item-invalid");
        continue;
      }
      const item = admitted.item;
      const bytes = item.bytes;
      if (item.required) requiredItems += 1;
      else optionalItems += 1;
      if (selectedBytes + bytes > input.plan.maxBytes || selectedBytes + bytes > input.maxEvidenceBytes) {
        omittedItems += 1;
        providerOmitted += 1;
        if (item.required) {
          requiredMissing = true;
          issues.push({ sourceId: item.provenance.sourceId, reason: "core.context-omitted", required: true, evidenceIds: [] });
        } else {
          issues.push({ sourceId: item.provenance.sourceId, reason: "core.context-omitted", required: false, evidenceIds: [] });
        }
        issueCodes.add("core.context-omitted");
        if (input.plan.overflow === "error" && item.required && input.plan.requiredCoverage === "complete") {
          return { ok: false, error: { code: "core.context-overflow", retryable: false, field: providerField } };
        }
        continue;
      }
      selectedBytes += bytes;
      providerBytes += bytes;
      if (item.required) includedRequiredItems += 1;
      else includedOptionalItems += 1;
      items.push(item);
      bindingItems.push(item);
    }
    for (const rawDependency of rawDependencies) {
      const dependency = admitEvidenceDependency(rawDependency);
      // Dependency identities must resolve to admitted context items or accepted
      // evidence identities; a provider cannot invent one for a finding reference.
      if (dependency === null
        || (!items.some(item => item.id === dependency.evidenceId)
          && !input.hooks.isAcceptedIdentity(dependency.evidenceId))) {
        providerPartial = true;
        issues.push({ sourceId: componentId, reason: "core.context-dependency-invalid", required: false, evidenceIds: [] });
        issueCodes.add("core.context-dependency-invalid");
        continue;
      }
      dependencies.push(dependency);
    }
    const coverageState = dataAt(rawCoverage, "state").value;
    if (coverageState !== "complete" && coverageState !== "partial" && coverageState !== "insufficient") {
      providerPartial = true;
      issues.push({ sourceId: componentId, reason: "core.context-batch-invalid", required: false, evidenceIds: [] });
      issueCodes.add("core.context-batch-invalid");
    } else if (coverageState !== "complete") {
      providerPartial = true;
      const rawIssues = dataArray(dataAt(rawCoverage, "issues").value, 16) ?? [];
      for (const rawIssue of rawIssues) {
        if (!isPlainRecord(rawIssue)) continue;
        const reason = safeReasonCode(componentId, dataAt(rawIssue, "reason").value);
        const required = dataAt(rawIssue, "required").value === true;
        if (required) requiredMissing = true;
        issues.push({ sourceId: componentId, reason, required, evidenceIds: [] });
        issueCodes.add(reason);
      }
    }
    // Only a partial provider that omits REQUIRED material degrades required
    // completeness; an optional omission stays recorded as metadata.
    if (providerPartial && requiredMissing) anyProviderPartial = true;
    const bindingRefs = bindingItems.map(item => tokens.resource(item.provenance.sourceId, item.provenance.uri));
    const refOmissions = Math.max(0, bindingRefs.length - 16);
    providerSummaries.push({
      sourceId: componentId,
      required: input.plan.requiredCoverage === "complete",
      selectionState: providerOmitted > 0 || providerPartial || refOmissions > 0 ? "omitted" : "included",
      resourceRefs: bindingRefs.slice(0, 16),
      sizes: [sizeMeasurement("selected", providerBytes)],
      omittedCount: providerOmitted + refOmissions,
      reasonCode: providerPartial || refOmissions > 0 ? "core.context-partial" : null,
    });
  }

  for (const item of items) ownedInputTokens.set(item.id, tokens.input(item.provenance.sourceId, item.id));
  for (const instruction of promptInstructions) ownedInputTokens.set(instruction.id, tokens.input(promptComponentId, instruction.id));
  const assetEntries: Array<NonNullable<AssessmentResources["assets"]>[number]> = [];
  const provenanceAssets: ItemAssetEntry[] = [];
  for (const instruction of promptInstructions) {
    const entry: ItemAssetEntry = {
      itemId: instruction.id,
      itemToken: tokens.input(promptComponentId, instruction.id),
      resourceId: tokens.resource(promptComponentId, instruction.provenance.uri),
      kind: "prompt",
      revisionRef: tokens.revision(promptComponentId, instruction.provenance.uri, instruction.provenance.revision),
      sourceId: instruction.provenance.sourceId,
      ...selectionTokens(promptComponentId, instruction.provenance.selection, instruction.provenance.changedDuringRead, instruction.bytes),
    };
    assetEntries.push(entry);
    // The exact admitted occurrence carries its own projection to preparation.
    Object.defineProperty(instruction, ITEM_ASSET, { value: entry, enumerable: false, configurable: true });
  }
  for (const item of items) {
    const entry: ItemAssetEntry = {
      itemId: item.id,
      itemToken: tokens.input(item.provenance.sourceId, item.id),
      resourceId: tokens.resource(item.provenance.sourceId, item.provenance.uri),
      kind: "document",
      revisionRef: tokens.revision(item.provenance.sourceId, item.provenance.uri, item.provenance.revision),
      sourceId: item.provenance.sourceId,
      ...selectionTokens(item.provenance.sourceId, item.provenance.selection, item.provenance.changedDuringRead, item.bytes),
    };
    assetEntries.push(entry);
    Object.defineProperty(item, ITEM_ASSET, { value: entry, enumerable: false, configurable: true });
  }
  for (const entry of promptResourceProvenance) {
    const asset: ItemAssetEntry = {
      itemId: `prompt-resource:${entry.kind}`,
      itemToken: tokens.input(promptComponentId, `prompt-resource:${entry.kind}`),
      resourceId: tokens.resource(promptComponentId, entry.uri),
      kind: entry.kind === "resultSchema" ? "result-schema" : entry.kind === "questions" ? "questions" : "prompt",
      revisionRef: tokens.revision(promptComponentId, entry.uri, entry.revision),
      sourceId: "core.prompt-files",
      selection: { kind: "full", ranges: [], sectionRefs: [], inputRefs: [], methodId: "full" },
      sizes: [],
      visibility: entry.changedDuringRead ? "partial" : "complete",
      changedDuringRead: entry.changedDuringRead,
    };
    assetEntries.push(asset);
    provenanceAssets.push(asset);
  }
  if (unresolvedDerivedInputs > 0) {
    // A derived input that resolves to no actual owned/accepted identity is an
    // explicit bounded limitation, never a fabricated complete association.
    anyProviderPartial = true;
    issueCodes.add("core.context-derived-input-unresolved");
    issues.push({ sourceId: "core.context", reason: "core.context-derived-input-unresolved", required: false, evidenceIds: [] });
  }
  Object.defineProperty(resources, "assets", { value: assetEntries, enumerable: false, writable: true, configurable: true });
  Object.defineProperty(resources, PROVENANCE_ASSETS, { value: provenanceAssets, enumerable: false, writable: false, configurable: true });

  const coverageState: Coverage["state"] = requiredMissing && input.plan.requiredCoverage === "complete"
    ? "insufficient"
    : (requiredMissing || anyProviderPartial)
      ? "partial"
      : "complete";
  if (requiredMissing && input.plan.requiredCoverage === "complete") {
    // C1 3.4: a complete plan refuses before evaluation when declared required
    // input is missing; per-source causes stay distinct in the acquisition facts.
    return { ok: false, error: { code: "core.context-incomplete", retryable: false, field: "context.requiredCoverage" } };
  }
  const coverage: Coverage = {
    state: coverageState,
    scopeDescription: `Assembled evidence from ${input.plan.providers.length} context provider(s) for check ${input.run.checkId}.`,
    issues: issues.slice(0, 32),
  };
  // Complete assembled resource-level dictionary: instruction/document items
  // plus the actual prompt resource-provenance entries (questions/schema) that
  // the manifest parts reference. Deduplicated by the issued resource ref.
  const resourceRefs = [...new Set([
    ...resources.instructions.map(instruction => tokens.resource(promptComponentId, instruction.provenance.uri)),
    ...items.map(item => tokens.resource(item.provenance.sourceId, item.provenance.uri)),
    ...promptResourceProvenance.map(entry => tokens.resource(promptComponentId, entry.uri)),
  ])];
  const snapshot: ContextSnapshot = {
    items,
    coverage,
    dependencies: dependencies,
    snapshotId,
    run: input.run,
    assembledAt: new Date().toISOString(),
    manifestId,
  };
  const manifestSizes = [sizeMeasurement("selected", selectedBytes, { complete: !requiredMissing })];
  const itemMetadataList: ManifestItemMetadata[] = [
    ...items.map(item => manifestItem(item, tokens, resolveInputRef)),
    ...promptInstructions.map(instruction => manifestItem(instruction, tokens, resolveInputRef)),
    ...promptResourceProvenance.map(entry => ({
      itemId: tokens.input(promptComponentId, `prompt-resource:${entry.kind}`),
      resourceId: tokens.resource(promptComponentId, entry.uri),
      sourceId: "core.prompt-files",
      role: "reference",
      required: true,
      revisionRef: tokens.revision(promptComponentId, entry.uri, entry.revision),
      selection: { kind: "full", ranges: [], sectionRefs: [], inputRefs: [], methodId: "full" },
      disposition: "included",
      changedDuringRead: entry.changedDuringRead,
      sizes: [],
      captureRefs: [],
    })) as unknown as ManifestItemMetadata[],
  ];
  const assembledPartBudget = Math.min(65_536 - 1_024, 60_000);
  const manifestParts: ContextManifestPartData[] = [];
  let partItems: ManifestItemMetadata[] = [];
  let partBytes = 0;
  for (const metadata of itemMetadataList) {
    const bytes = Buffer.byteLength(JSON.stringify(metadata), "utf8") + 1;
    if (partItems.length > 0 && (partItems.length >= 64 || partBytes + bytes > assembledPartBudget)) {
      manifestParts.push({ manifestId, partIndex: manifestParts.length, itemCount: partItems.length, items: partItems });
      partItems = [];
      partBytes = 0;
    }
    partItems.push(metadata);
    partBytes += bytes;
  }
  if (partItems.length > 0 || manifestParts.length === 0) {
    manifestParts.push({ manifestId, partIndex: manifestParts.length, itemCount: partItems.length, items: partItems });
  }
  const manifestPart: ContextManifestPartData = manifestParts[0]!;
  const manifest: ContextManifestData = {
    manifestId,
    snapshotId,
    boundary: "assembled-context",
    attemptId: null,
    profileId: null,
    parentManifestId: null,
    coverage: coverageState,
    inputVisibility: anyProviderPartial ? "partial" : "complete",
    requiredItems,
    includedRequiredItems,
    optionalItems,
    includedOptionalItems,
    omittedItems,
    contentTruncated: omittedItems > 0,
    manifestTruncated: false,
    itemCount: itemMetadataList.length,
    partCount: manifestParts.length,
    resourceRefs,
    issueCodes: [...issueCodes].slice(0, 16),
    sizes: manifestSizes,
  };
  return {
    ok: true,
    value: {
      snapshot,
      resources,
      providerSummaries,
      manifest,
      manifestPart,
      manifestParts,
      omittedItems,
      selectedBytes,
      issueCodes: manifest.issueCodes,
    },
  };
}
