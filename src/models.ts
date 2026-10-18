// Owned model request service.
//
// This is the single accounting and admission owner for engine-dispatched
// model work: approved-route preflight, one shared reservation allowance,
// attempt identity created at the observable boundary, usage/price
// normalization with revision replacement, cancellation and late settlement.
// The transport is the managed Pi registry port; tests inject a scripted port
// through the same boundary, so no evaluator or fixture bypasses accounting.

import { createHash } from "node:crypto";
import type {
  ModelProfileDefinition,
  ModelResponse,
  Result,
} from "./contracts.js";
import type { FinancialAggregate, FinancialSnapshot } from "./checkpoint.js";

export interface ModelAttemptUsage {
  revision: number;
  observationSource: "provider" | "sdk-normalized" | "local-estimate";
  inputTokens: number | null;
  uncachedInputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  totalTokens: number | null;
  inputPartition: "disjoint-complete" | "partial" | "unknown";
  outputIncludesReasoning: boolean | null;
  totalBasis: "normalized-sum" | "reported-total" | "estimate" | "unknown";
  coverage: "complete" | "partial" | "unknown";
  finality: "provisional" | "final" | "unresolved";
}

export interface ModelCostObservation {
  amount: string | null;
  currency: string | null;
  basis: "reported" | "calculated" | "estimated" | "unknown";
  coverage: "complete" | "partial" | "unknown";
  priceBasisRef: string | null;
  usageRevision: number | null;
  source: "provider" | "sdk-estimate" | "engine-calculation" | "none";
  knownComponents: Array<{ category: string; amount: string }>;
  unknownComponentCount: number;
}

export type ModelAttemptState = "reserved" | "dispatched" | "settled" | "unresolved" | "released" | "cancelled";

export interface ModelAttemptRecord {
  attemptId: string;
  runId: string;
  profileId: string;
  kind: "classifier" | "chat";
  purpose: "direct" | "preparation" | "repair" | "reviewer";
  state: ModelAttemptState;
  reservedTokens: number;
  reservedCost: { currency: string; amount: string } | null;
  usage: ModelAttemptUsage | null;
  usageRevision: number;
  cost: ModelCostObservation | null;
  actualModel: { provider: string; id: string; revision: string | null } | null;
  visibility: "attempt-level" | "partial";
  /** K07 B.4: this row was restored from protected state (retired generation). */
  restored: boolean;
  /** K07 B.4: bounded known origin generation/branch of the owned operation. */
  originGeneration: string | null;
  branchRef: string | null;
  stopReason: string | null;
  errorCode: string | null;
  /** Bounded submitted-input manifest identity; never a body. */
  inputManifestRef: string | null;
  /** Exact O1 dispatch facts captured at admission. */
  profileRevision: string | null;
  requestedRoute: { provider: string; model: string } | null;
  actualRoute: { provider: string; model: string; revision: string | null } | null;
  destinationRef: string | null;
  retryVisibility: string;
  priceBasisRef: string | null;
  requestTimeoutMs: number;
  effectiveMaxOutputTokens: number;
  reasoningSetting: string | null;
  /** Observed response byte size; null until settle. */
  responseBytes: number | null;
  /** Digest of the exact serialized input; never a body. */
  inputSerializedDigest: string | null;
  /** Immutable tariff captured when the attempt was admitted. */
  capturedPrice: ModelProfileDefinition["price"] | null;
  createdAt: string;
  settledAt: string | null;
}

export interface ModelUsageSummary {
  scopeKind: "observed-session";
  ledgerRevision: number;
  ownedRequestCount: number;
  attemptVisibility: "attempt-level" | "mixed" | "partial";
  settledCount: number;
  unresolvedCount: number;
  cancelledCount: number;
  usageKnownCount: number;
  usagePartialCount: number;
  usageUnknownCount: number;
  normalizedTokens: { total: number | null; coverage: "complete" | "partial" | "unknown" };
  costByCurrency: Array<{ currency: string; knownAmount: string; reservedAmount: string; unresolvedCount: number; unknownCoverage: number }>;
  byPurpose: Record<string, number>;
  excluded: { primarySession: "excluded"; externalHandoffs: number };
  asOf: string;
  historyCoverage: "complete" | "partial";
}

export interface ChatTransportResult {
  text: string;
  model: { provider: string; id: string; revision: string | null };
  usage: Record<string, unknown> | null;
  stopReason: string | null;
  errorCode: string | null;
}

export interface ClassifierTransportResult {
  answers: Record<string, unknown>;
  model: { provider: string; id: string; revision: string | null };
  usage: Record<string, unknown> | null;
  stopReason: string | null;
  errorMessage: string | null;
}

export interface ModelRegistryPort {
  findChat(provider: string, model: string): Record<string, unknown> | null;
  findClassifier(provider: string, model: string): Record<string, unknown> | null;
  hasConfiguredAuth(model: Record<string, unknown>): boolean;
  completeChat(model: Record<string, unknown>, messages: readonly { role: string; content: string }[], options: Record<string, unknown>, signal: AbortSignal): Promise<ChatTransportResult>;
  classify(model: Record<string, unknown>, state: Record<string, unknown>, questions: Record<string, unknown>, options: Record<string, unknown>, signal: AbortSignal): Promise<ClassifierTransportResult>;
  /**
   * Optional native streaming transport used by the run-bound reviewer.
   * Admission/accounting stay in ModelService; this only produces the stream.
   */
  streamSimple?(model: Record<string, unknown>, context: unknown, options: unknown): unknown;
}

export interface ModelServiceBudget {
  maxRequestsPerSession: number;
  maxOwnedTokensPerSession: number;
  unknownCost: "allow-with-token-limits" | "deny";
  maxOwnedCost: { currency: string; amount: string } | null;
}

export interface ModelDispatchInput {
  runId: string;
  profileId: string;
  kind: "classifier" | "chat";
  purpose?: ModelAttemptRecord["purpose"];
  messages?: readonly { role: string; content: string }[];
  classifierState?: Record<string, unknown>;
  classifierQuestions?: Record<string, unknown>;
  maxOutputTokens: number;
  estimatedInputTokens: number;
  signal: AbortSignal;
  /** Bounded submitted-input manifest identity bound to this attempt. */
  inputManifestRef?: string;
  /** Digest of the exact serialized input bound to this attempt. */
  inputSerializedDigest?: string;
  /** Accepted configuration revision captured with the validated profile. */
  profileRevision?: string;
  /** K07 B.4: bounded origin generation/branch of the owning run. */
  originGeneration?: string;
  branchRef?: string;
  onDispatched?: (attempt: ModelAttemptRecord) => void;
  /**
   * Protected intent boundary. Called after reservation and before any actual
   * transport arrival; returning false suspends this dependent request.
   */
  onIntent?: (attempt: ModelAttemptRecord) => boolean | Promise<boolean>;
  /**
   * Last-moment revocation authority, rechecked after the awaited durable
   * intent and immediately before any transport arrival.
   */
  revoked?: () => boolean;
  /**
   * Reviewer streaming transport. When present, the approved model is passed to
   * this native stream boundary instead of the direct completeChat/classify
   * calls; admission, reservation, intent, revocation and settlement stay in
   * this same owner.
   */
  reviewTransport?: (model: Record<string, unknown>, signal: AbortSignal) => Promise<Result<ReviewerTurnTransport>>;
}

/** One bounded reviewer turn: the native stream plus its later completion. */
export interface ReviewerTurnTransport {
  stream: unknown;
  completion: Promise<{
    usage: Record<string, unknown> | null;
    stopReason?: string | null;
    errorCode?: string | null;
    model?: { provider: string; id: string; revision: string | null };
  }>;
}

export interface ReviewerTurnInput {
  runId: string;
  profileId: string;
  estimatedInputTokens: number;
  maxOutputTokens: number;
  inputManifestRef?: string;
  inputSerializedDigest?: string;
  profileRevision?: string;
  signal: AbortSignal;
  onIntent?: (attempt: ModelAttemptRecord) => boolean | Promise<boolean>;
  onDispatched?: (attempt: ModelAttemptRecord) => void;
  revoked?: () => boolean;
}

const DECIMAL_PATTERN = /^[0-9]+(?:\.[0-9]+)?$/u;

/** Parses a decimal string into millionths as a BigInt; returns null when invalid. */
function microUnits(value: string): bigint | null {
  if (!DECIMAL_PATTERN.test(value)) return null;
  const [whole = "0", fraction = ""] = value.split(".");
  const padded = `${fraction}000000`.slice(0, 6);
  return BigInt(whole) * 1_000_000n + BigInt(padded);
}

interface SessionFeedState {
  snapshot: FinancialSnapshot | null;
  /** Live or physically pending ownership must never be evicted or orphaned. */
  pinned: boolean;
  /** Live current-owner subscribers; the active receipt path. */
  listeners: Set<(snapshot: FinancialSnapshot) => void>;
  /**
   * Live ownership claims per reconciliation identity. An identity leaves the
   * feed only when every owning generation has finalized it, so bounded detail
   * compaction can never orphan a pending receipt, and fully served feeds
   * become disposable again.
   */
  liveOwners: Map<string, Set<object>>;
}

const SESSION_FEED_LIMIT = 16;
const sessionFeeds = new Map<string, SessionFeedState>();

/** Narrows the shared same-session accounting channel to a bounded window. */
function acquireSessionFeed(scope: string): SessionFeedState {
  const existing = sessionFeeds.get(scope);
  if (existing !== undefined) {
    sessionFeeds.delete(scope);
    sessionFeeds.set(scope, existing);
    return existing;
  }
  const feed: SessionFeedState = { snapshot: null, pinned: false, listeners: new Set(), liveOwners: new Map() };
  sessionFeeds.set(scope, feed);
  while (sessionFeeds.size > SESSION_FEED_LIMIT) {
    // Only non-pending feeds without a live subscriber are disposable. A feed
    // whose session has live or physically pending ownership is never evicted;
    // the soft cap may be exceeded while that many sessions remain live, and
    // disposal resumes as soon as such a feed reports no live ownership.
    const disposable = [...sessionFeeds.entries()].find(([key, entry]) =>
      key !== scope && !entry.pinned && entry.listeners.size === 0 && entry.liveOwners.size === 0);
    if (disposable === undefined) break;
    sessionFeeds.delete(disposable[0]);
  }
  return feed;
}

function emptyAggregate(): FinancialAggregate {
  return {
    knownTokens: 0,
    tokensMissing: 0,
    usageKnownCount: 0,
    usagePartialCount: 0,
    usageUnknownCount: 0,
    settledCount: 0,
    unresolvedCount: 0,
    cancelledCount: 0,
    byPurpose: {},
  };
}

function emptyCostMap(): Record<string, string> {
  return {};
}

function coverageClass(value: string): "complete" | "partial" | "unknown" {
  return value === "complete" ? "complete" : value === "partial" ? "partial" : "unknown";
}

function rowAggregate(rows: FinancialSnapshot["attempts"]): FinancialAggregate {
  const view = emptyAggregate();
  for (const row of rows) {
    if (row.totalTokens === null) view.tokensMissing += 1;
    else view.knownTokens += row.totalTokens;
    const coverage = coverageClass(row.usageCoverage);
    if (coverage === "complete") view.usageKnownCount += 1;
    else if (coverage === "partial") view.usagePartialCount += 1;
    else view.usageUnknownCount += 1;
    if (row.state === "settled") view.settledCount += 1;
    if (row.state === "unresolved") view.unresolvedCount += 1;
    if (row.state === "cancelled") view.cancelledCount += 1;
    view.byPurpose[row.purpose] = (view.byPurpose[row.purpose] ?? 0) + 1;
  }
  return view;
}

/** snapshot aggregate minus the bounded rows it also contains. */
function hiddenAggregate(snapshot: FinancialSnapshot): FinancialAggregate {
  const aggregate = snapshot.aggregate ?? rowAggregate(snapshot.attempts);
  const rows = rowAggregate(snapshot.attempts);
  return {
    knownTokens: Math.max(0, aggregate.knownTokens - rows.knownTokens),
    tokensMissing: Math.max(0, aggregate.tokensMissing - rows.tokensMissing),
    usageKnownCount: Math.max(0, aggregate.usageKnownCount - rows.usageKnownCount),
    usagePartialCount: Math.max(0, aggregate.usagePartialCount - rows.usagePartialCount),
    usageUnknownCount: Math.max(0, aggregate.usageUnknownCount - rows.usageUnknownCount),
    settledCount: Math.max(0, aggregate.settledCount - rows.settledCount),
    unresolvedCount: Math.max(0, aggregate.unresolvedCount - rows.unresolvedCount),
    cancelledCount: Math.max(0, aggregate.cancelledCount - rows.cancelledCount),
    byPurpose: (() => {
      const byPurpose: Record<string, number> = {};
      for (const [purpose, count] of Object.entries(aggregate.byPurpose)) {
        const remainder = Math.max(0, count - (rows.byPurpose[purpose] ?? 0));
        if (remainder > 0) byPurpose[purpose] = remainder;
      }
      return byPurpose;
    })(),
  };
}

/** Session cost aggregate minus the bounded rows the snapshot also carries. */
function attemptCounterOf(attemptId: string): number | null {
  const match = /^attempt-(\d+)$/u.exec(attemptId);
  return match === null ? null : Number(match[1]);
}

function hiddenCostMap(snapshot: FinancialSnapshot): Record<string, string> {
  const hidden: Record<string, string> = {};
  for (const [currency, amount] of Object.entries(snapshot.knownCostByCurrency)) {
    let rows = "0";
    for (const row of snapshot.attempts) {
      if (row.costCurrency === currency && row.costAmount !== null) rows = addAmounts(rows, row.costAmount);
    }
    const remainder = subtractAmount(amount, rows);
    if (remainder !== "0") hidden[currency] = remainder;
  }
  return hidden;
}

function receiptUsage(revision: number, coverage: "complete" | "partial" | "unknown", totalTokens: number | null): ModelAttemptUsage {
  return {
    revision,
    observationSource: "provider",
    inputTokens: null,
    uncachedInputTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    outputTokens: null,
    reasoningTokens: null,
    totalTokens,
    inputPartition: "unknown",
    outputIncludesReasoning: null,
    totalBasis: "reported-total",
    coverage,
    finality: "final",
  };
}

function subtractAmount(existing: string, delta: string): string {
  const left = microUnits(existing);
  const right = microUnits(delta);
  if (left === null || right === null) return existing;
  return fromMicroUnits(left > right ? left - right : 0n);
}

function fromMicroUnits(value: bigint): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${negative ? "-" : ""}${whole}${fraction.length === 0 ? "" : `.${fraction}`}`;
}

/** Multiplies a token quantity by a per-million rate with scaled decimal math. */
export function calculateAmount(quantity: number | null, perMillion: string | null): string | null {
  if (quantity === null || perMillion === null) return null;
  const rate = microUnits(perMillion);
  if (rate === null) return null;
  return fromMicroUnits(BigInt(quantity) * rate / 1_000_000n);
}

function addAmounts(left: string, right: string): string {
  const leftMicro = microUnits(left);
  const rightMicro = microUnits(right);
  if (leftMicro === null || rightMicro === null) return left;
  return fromMicroUnits(leftMicro + rightMicro);
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * O1 section 12.2 normalization. SDK `Usage.input` is treated as the inclusive
 * input total with cache counters as subsets; cache/reasoning values are never
 * added twice, and unknown fields stay null rather than becoming zero.
 */
export function normalizeUsage(raw: Record<string, unknown> | null, revision: number, finality: ModelAttemptUsage["finality"]): ModelAttemptUsage {
  if (raw === null) {
    return {
      revision,
      observationSource: "provider",
      inputTokens: null,
      uncachedInputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      totalTokens: null,
      inputPartition: "unknown",
      outputIncludesReasoning: null,
      totalBasis: "unknown",
      coverage: "unknown",
      finality,
    };
  }
  const input = numeric(raw["input"]);
  const output = numeric(raw["output"]);
  const cacheRead = numeric(raw["cacheRead"]);
  const cacheWrite = numeric(raw["cacheWrite"]);
  const total = numeric(raw["totalTokens"]);
  const reasoning = numeric(raw["reasoning"]);
  const uncached = input === null ? null : Math.max(0, input - (cacheRead ?? 0) - (cacheWrite ?? 0));
  const coverage: ModelAttemptUsage["coverage"] = input !== null && output !== null && total !== null ? "complete" : input !== null || output !== null ? "partial" : "unknown";
  return {
    revision,
    observationSource: "sdk-normalized",
    inputTokens: input,
    uncachedInputTokens: uncached,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: cacheWrite,
    outputTokens: output,
    reasoningTokens: reasoning,
    totalTokens: total,
    inputPartition: input !== null && cacheRead !== null ? "partial" : "unknown",
    outputIncludesReasoning: reasoning === null ? null : true,
    totalBasis: total === null ? "unknown" : "reported-total",
    coverage,
    finality,
  };
}

export function costFromUsage(raw: Record<string, unknown> | null, usage: ModelAttemptUsage, profile: ModelProfileDefinition): ModelCostObservation {
  if (profile.price === "unknown") {
    return {
      amount: null,
      currency: null,
      basis: "unknown",
      coverage: "unknown",
      priceBasisRef: null,
      usageRevision: usage.revision,
      source: "none",
      knownComponents: [],
      unknownComponentCount: 1,
    };
  }
  if (profile.price === "host-catalog") {
    const cost = raw === null ? undefined : raw["cost"];
    const total = typeof cost === "object" && cost !== null && !Array.isArray(cost) ? (cost as Record<string, unknown>)["total"] : undefined;
    if (typeof total === "number" && Number.isFinite(total) && total >= 0) {
      return {
        amount: total.toString(),
        currency: "USD",
        basis: "estimated",
        coverage: usage.coverage === "complete" ? "complete" : "partial",
        priceBasisRef: "host-catalog",
        usageRevision: usage.revision,
        source: "sdk-estimate",
        knownComponents: [],
        unknownComponentCount: 0,
      };
    }
    return {
      amount: null,
      currency: null,
      basis: "unknown",
      coverage: "unknown",
      priceBasisRef: "host-catalog",
      usageRevision: usage.revision,
      source: "none",
      knownComponents: [],
      unknownComponentCount: 1,
    };
  }
  const components: Array<{ category: string; amount: string }> = [];
  const uncached = calculateAmount(usage.uncachedInputTokens, profile.price.inputPerMillion);
  if (uncached !== null) components.push({ category: "uncached-input", amount: uncached });
  if (profile.price.cacheReadPerMillion !== undefined) {
    const cacheRead = calculateAmount(usage.cacheReadTokens, profile.price.cacheReadPerMillion);
    if (cacheRead !== null) components.push({ category: "cache-read", amount: cacheRead });
  }
  if (profile.price.cacheWritePerMillion !== undefined) {
    const cacheWrite = calculateAmount(usage.cacheWriteTokens, profile.price.cacheWritePerMillion);
    if (cacheWrite !== null) components.push({ category: "cache-write", amount: cacheWrite });
  }
  const output = calculateAmount(usage.outputTokens, profile.price.outputPerMillion);
  if (output !== null) components.push({ category: "output", amount: output });
  const complete = usage.inputTokens !== null && usage.outputTokens !== null;
  let amount: string | null = null;
  for (const component of components) amount = amount === null ? component.amount : addAmounts(amount, component.amount);
  return {
    amount,
    currency: profile.price.currency,
    basis: "calculated",
    coverage: complete ? "complete" : "partial",
    priceBasisRef: `${profile.price.currency}@${profile.price.revision}`,
    usageRevision: usage.revision,
    source: "engine-calculation",
    knownComponents: components,
    unknownComponentCount: complete ? 0 : 1,
  };
}

export class ModelService {
  #profiles: Readonly<Record<string, ModelProfileDefinition>>;
  #approved: ReadonlySet<string>;
  readonly #registry: ModelRegistryPort;
  #budget: ModelServiceBudget;
  readonly #now: () => string;
  readonly #attempts = new Map<string, ModelAttemptRecord>();
  #attemptCounter = 0;
  #ledgerRevision = 0;
  #reservedTokens = 0;
  #dispatchedCount = 0;
  #reservedCostByCurrency: Record<string, string> = {};
  /** Aggregate reservation liability of rows outside the bounded window. */
  #hiddenReservedTokens = 0;
  #hiddenReservedCost: Record<string, string> = {};
  #hidden: FinancialAggregate = emptyAggregate();
  #hiddenCost: Record<string, string> = emptyCostMap();
  readonly #feed: SessionFeedState | null;
  readonly #feedListener: ((snapshot: FinancialSnapshot) => void) | null;
  readonly #feedToken: object | null;
  readonly #onReceipt: ((attemptId: string) => void) | null;
  #lastFeedSnapshot: FinancialSnapshot | null = null;
  #unpersistedReceipts = 0;

  constructor(options: {
    profiles: Readonly<Record<string, ModelProfileDefinition>>;
    approved: readonly string[];
    registry: ModelRegistryPort;
    budget: ModelServiceBudget;
    now?: () => string;
    /** Same-session accounting scope; generations of one session share receipts. */
    scope?: string;
    /** Current-owner persistence hook for material late receipts. */
    onReceipt?: (attemptId: string) => void;
  }) {
    this.#profiles = options.profiles;
    this.#approved = new Set(options.approved);
    this.#registry = options.registry;
    this.#budget = options.budget;
    this.#now = options.now ?? (() => new Date().toISOString());
    this.#feed = options.scope === undefined ? null : acquireSessionFeed(options.scope);
    this.#onReceipt = options.onReceipt ?? null;
    if (this.#feed === null) {
      this.#feedListener = null;
      this.#feedToken = null;
    } else {
      this.#feedToken = {};
      this.#feedListener = snapshot => {
        this.#receive(snapshot);
      };
      this.#feed.listeners.add(this.#feedListener);
    }
  }

  get ledgerRevision(): number {
    return this.#ledgerRevision;
  }

  get attempts(): readonly ModelAttemptRecord[] {
    this.#syncFeed();
    return [...this.#attempts.values()].map(attempt => structuredClone(attempt));
  }

  attempt(attemptId: string): ModelAttemptRecord | null {
    const attempt = this.#attempts.get(attemptId);
    return attempt === undefined ? null : structuredClone(attempt);
  }

  /** Resolves the approved route and rejects unsupported capabilities before any dispatch. */
  preflight(profileId: string, kind: "classifier" | "chat"): Result<{ profile: ModelProfileDefinition; model: Record<string, unknown> }> {
    if (!this.#approved.has(profileId)) {
      return { ok: false, error: { code: "core.model-profile-unapproved", retryable: false } };
    }
    const profile = this.#profiles[profileId];
    if (profile === undefined) {
      return { ok: false, error: { code: "core.model-profile-unknown", retryable: false } };
    }
    const model = kind === "classifier"
      ? this.#registry.findClassifier(profile.provider, profile.model)
      : this.#registry.findChat(profile.provider, profile.model);
    if (model === null) {
      return { ok: false, error: { code: "core.model-route-unavailable", retryable: false } };
    }
    if (!this.#registry.hasConfiguredAuth(model)) {
      return { ok: false, error: { code: "core.model-route-unauthenticated", retryable: false } };
    }
    // Required input capability is validated against the actual selected model
    // kind before attempt/reservation/intent/transport. Only the represented
    // public capability array is consulted; an unrepresented capability keeps
    // the pre-existing explicit unavailable limitation and no fallback.
    const representedInputs = model["input"];
    if (Array.isArray(representedInputs)) {
      const actualInputs = new Set(representedInputs.filter((entry): entry is string => typeof entry === "string"));
      const missingInputs = profile.requiredInputs.filter(required => !actualInputs.has(required));
      if (missingInputs.length > 0) {
        return { ok: false, error: { code: "core.model-input-unsupported", retryable: false } };
      }
    }
    if (profile.reasoning !== "off") {
      // Actual capability admission before dispatch: a model that declares
      // reasoning unsupported (or exposes no thinking levels at all) must not
      // receive a reasoning option and then report the failure afterwards.
      const levels = model["thinkingLevels"];
      const declared = model["reasoning"];
      const supported = declared === true
        || (Array.isArray(levels) && levels.includes(profile.reasoning));
      if (!supported) {
        return { ok: false, error: { code: "core.model-reasoning-unsupported", retryable: false } };
      }
    }
    return { ok: true, value: { profile, model } };
  }

  /** Dispatches one owned attempt through the managed transport. */
  async dispatch(input: ModelDispatchInput): Promise<Result<ModelResponse>> {
    const preflight = this.preflight(input.profileId, input.kind);
    if (!preflight.ok) return preflight;
    const { profile, model } = preflight.value;
    const maxOutputTokens = Math.min(input.maxOutputTokens, profile.maxOutputTokens);
    const estimated = Math.max(0, input.estimatedInputTokens) + maxOutputTokens;
    // Actual route capacity is checked before dispatch: serialized input plus
    // the output allowance must fit the real context window, and the output
    // allowance must fit the model's own output ceiling.
    const contextWindow = model["contextWindow"];
    if (typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
      && Math.max(0, input.estimatedInputTokens) + maxOutputTokens > contextWindow) {
      return { ok: false, error: { code: "core.model-context-overflow", retryable: false } };
    }
    const modelMaxTokens = model["maxTokens"];
    if (typeof modelMaxTokens === "number" && Number.isFinite(modelMaxTokens) && maxOutputTokens > modelMaxTokens) {
      return { ok: false, error: { code: "core.model-output-ceiling", retryable: false } };
    }
    if (this.#dispatchedCount >= this.#budget.maxRequestsPerSession) {
      return { ok: false, error: { code: "core.budget-requests-exhausted", retryable: false } };
    }
    if (profile.price === "unknown" && this.#budget.unknownCost === "deny") {
      return { ok: false, error: { code: "core.budget-unknown-cost-denied", retryable: false } };
    }
    if (this.#reservedTokens + estimated > this.#budget.maxOwnedTokensPerSession) {
      return { ok: false, error: { code: "core.budget-tokens-exceeded", retryable: false } };
    }
    const estimatedCost = estimateRequestCost(profile, model, input.estimatedInputTokens, maxOutputTokens);
    if (this.#budget.maxOwnedCost !== null) {
      const cap = this.#budget.maxOwnedCost;
      if (estimatedCost !== null && estimatedCost.currency === cap.currency) {
        const capMicro = microUnits(cap.amount);
        const knownMicro = microUnits(this.#aggregateKnownCost()[cap.currency] ?? "0");
        const reservedMicro = microUnits(this.#reservedCostByCurrency[cap.currency] ?? "0");
        const estimateMicro = microUnits(estimatedCost.amount);
        if (capMicro !== null && knownMicro !== null && reservedMicro !== null && estimateMicro !== null
          && knownMicro + reservedMicro + estimateMicro > capMicro) {
          return { ok: false, error: { code: "core.budget-cost-exceeded", retryable: false } };
        }
      } else if (this.#budget.unknownCost === "deny") {
        // An unmatched currency or an unknown basis cannot be compared to this
        // cap without an approved conversion; it is unknown, not zero.
        return { ok: false, error: { code: "core.budget-unknown-cost-denied", retryable: false } };
      }
      const unknownCostFacts = [...this.#attempts.values()].some(attempt =>
        attempt.state !== "released"
        && (attempt.cost === null || attempt.cost.amount === null || attempt.cost.currency === null));
      if (unknownCostFacts && this.#budget.unknownCost === "deny") {
        // Missing/partial cost provenance must never be treated as affordable.
        return { ok: false, error: { code: "core.budget-unknown-cost-denied", retryable: false } };
      }
    }
    this.#attemptCounter += 1;
    while (this.#attempts.has(`attempt-${this.#attemptCounter}`)) this.#attemptCounter += 1;
    const attemptId = `attempt-${this.#attemptCounter}`;
    const attempt: ModelAttemptRecord = {
      attemptId,
      runId: input.runId,
      restored: false,
      originGeneration: input.originGeneration ?? null,
      branchRef: input.branchRef ?? null,
      profileId: input.profileId,
      kind: input.kind,
      purpose: input.purpose ?? "direct",
      state: "dispatched",
      reservedTokens: estimated,
      reservedCost: estimatedCost,
      usage: null,
      usageRevision: 0,
      cost: null,
      actualModel: null,
      visibility: "attempt-level",
      stopReason: null,
      errorCode: null,
      inputManifestRef: input.inputManifestRef ?? null,
      inputSerializedDigest: input.inputSerializedDigest ?? null,
      profileRevision: input.profileRevision ?? null,
      requestedRoute: { provider: profile.provider, model: profile.model },
      actualRoute: {
        provider: typeof model["provider"] === "string" ? model["provider"] : profile.provider,
        model: typeof model["model"] === "string" ? model["model"] : (typeof model["id"] === "string" ? model["id"] : profile.model),
        revision: typeof model["revision"] === "string" ? model["revision"] : null,
      },
      destinationRef: `profile:${input.profileId}`,
      retryVisibility: "attempt-level",
      priceBasisRef: typeof profile.price === "object" ? `${profile.price.currency}@${profile.price.revision}` : null,
      requestTimeoutMs: profile.requestTimeoutMs,
      effectiveMaxOutputTokens: maxOutputTokens,
      reasoningSetting: profile.reasoning === "off" ? null : profile.reasoning,
      responseBytes: null,
      capturedPrice: profile.price,
      createdAt: this.#now(),
      settledAt: null,
    };
    this.#attempts.set(attemptId, attempt);
    this.#reservedTokens += estimated;
    this.#dispatchedCount += 1;
    if (estimatedCost !== null) {
      this.#reservedCostByCurrency[estimatedCost.currency] =
        addAmounts(this.#reservedCostByCurrency[estimatedCost.currency] ?? "0", estimatedCost.amount);
    }
    this.#ledgerRevision += 1;
    this.#pinFeed();
    if (input.onIntent !== undefined) {
      let safe = false;
      try {
        safe = await input.onIntent(structuredClone(attempt));
      } catch {
        safe = false;
      }
      if (!safe) {
        // Persistence is unsafe: release only this un-dispatched reservation
        // and suspend the dependent request before any provider arrival.
        this.#releaseReservation(attempt, estimated, estimatedCost, "core.financial-intent-unsafe");
        return { ok: false, error: { code: "core.financial-intent-unsafe", retryable: true } };
      }
    }
    if (input.revoked?.() === true || input.signal.aborted) {
      // Accepted revocation after the awaited durable intent: revalidate
      // current run/signal/Stop/generation authority immediately before
      // transport. The reservation is proven un-dispatched and released.
      this.#releaseReservation(attempt, estimated, estimatedCost, "core.run-revoked");
      return { ok: false, error: { code: "core.run-revoked", retryable: false } };
    }
    input.onDispatched?.(structuredClone(attempt));
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">(resolvePromise => {
      timer = setTimeout(() => resolvePromise("timeout"), profile.requestTimeoutMs);
    });
    try {
      const transportPromise: Promise<Result<ModelResponse>> = (async () => {
        if (input.reviewTransport !== undefined) {
          const admitted = await input.reviewTransport(model, input.signal);
          if (!admitted.ok) {
            return this.#settle(attempt, "settled", {
              output: "",
              model: {
                provider: typeof model["provider"] === "string" ? model["provider"] : profile.provider,
                id: typeof model["id"] === "string" ? model["id"] : profile.model,
                revision: typeof model["revision"] === "string" ? model["revision"] : null,
              },
              usage: null,
              stopReason: "error",
              errorCode: admitted.error.code,
              profile,
            });
          }
          // The stream is delivered to the caller through the shared closure;
          // its completion settles this exact owned attempt once, later.
          // The stream is delivered to the caller promptly, but the request
          // deadline stays alive across real streaming completion: a held turn
          // becomes a truthful unresolved attempt without refunding physical
          // work, and the late authoritative completion still settles THIS
          // attempt once through the shared ledger.
          let requestTimer: ReturnType<typeof setTimeout> | null = null;
          const clearRequestTimer = (): void => {
            if (requestTimer !== null) clearTimeout(requestTimer);
            requestTimer = null;
          };
          requestTimer = setTimeout(() => {
            if (attempt.state === "dispatched") {
              attempt.state = "unresolved";
              attempt.errorCode = "core.model-request-timeout";
              attempt.visibility = "partial";
              attempt.settledAt = this.#now();
              this.#ledgerRevision += 1;
              this.#publish();
            }
          }, profile.requestTimeoutMs);
          void admitted.value.completion.then(completion => {
            clearRequestTimer();
            this.#settle(attempt, "settled", {
              output: "",
              model: completion.model ?? {
                provider: typeof model["provider"] === "string" ? model["provider"] : profile.provider,
                id: typeof model["id"] === "string" ? model["id"] : profile.model,
                revision: typeof model["revision"] === "string" ? model["revision"] : null,
              },
              usage: completion.usage,
              stopReason: completion.stopReason ?? null,
              errorCode: completion.errorCode ?? null,
              profile,
            });
          }, () => {
            clearRequestTimer();
            attempt.state = "unresolved";
            attempt.errorCode = attempt.errorCode ?? "core.model-request-unresolved";
            attempt.visibility = "partial";
            attempt.settledAt = this.#now();
            this.#ledgerRevision += 1;
            this.#publish();
          });
          return {
            ok: true,
            value: {
              attemptIds: [attempt.attemptId],
              actualModel: attempt.actualModel ?? {
                provider: profile.provider,
                id: profile.model,
                revision: null,
              },
              output: null,
              manifestId: `model-${attempt.attemptId}`,
              accounting: "unknown",
            },
          };
        }
        if (input.kind === "chat") {
          const transport = await this.#registry.completeChat(model, input.messages ?? [], {
            maxOutputTokens,
            requestTimeoutMs: profile.requestTimeoutMs,
            reasoning: profile.reasoning,
          }, input.signal);
          return this.#settle(attempt, "settled", {
            output: transport.text,
            model: transport.model,
            usage: transport.usage,
            stopReason: transport.stopReason,
            errorCode: transport.errorCode,
            profile,
          });
        }
        const transport = await this.#registry.classify(model, input.classifierState ?? {}, input.classifierQuestions ?? {}, {
          maxOutputTokens,
          requestTimeoutMs: profile.requestTimeoutMs,
        }, input.signal);
        return this.#settle(attempt, "settled", {
          output: JSON.stringify(transport.answers),
          model: transport.model,
          usage: transport.usage,
          stopReason: transport.stopReason,
          errorCode: transport.errorMessage ?? null,
          profile,
          classifierAnswers: transport.answers,
        });
      })();
      // A late transport result still reconciles the same owned attempt.
      void transportPromise.catch(() => undefined);
      const outcome = await Promise.race([transportPromise, timeout]);
      if (outcome === "timeout") {
        attempt.state = "unresolved";
        attempt.errorCode = "core.model-request-timeout";
        attempt.visibility = "partial";
        attempt.settledAt = this.#now();
        this.#ledgerRevision += 1;
        this.#publish();
        return { ok: false, error: { code: "core.model-request-timeout", retryable: true } };
      }
      return outcome;
    } catch {
      attempt.state = input.signal.aborted ? "cancelled" : "unresolved";
      attempt.errorCode = input.signal.aborted ? "core.model-request-cancelled" : "core.model-request-unresolved";
      attempt.visibility = "partial";
      attempt.settledAt = this.#now();
      this.#ledgerRevision += 1;
      this.#publish();
      return { ok: false, error: { code: attempt.errorCode, retryable: true } };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /**
   * Admits one bounded reviewer turn through the same shared owner and returns
   * its native stream. Denied turns create no attempt and never reach the
   * transport; an admitted turn reserves, awaits protected intent, rechecks
   * revocation and settles from the actual completion.
   */
  async dispatchReviewTurn(
    input: ReviewerTurnInput,
    transport: (model: Record<string, unknown>, signal: AbortSignal) => Promise<Result<ReviewerTurnTransport>>,
  ): Promise<Result<{ attemptId: string; stream: unknown }>> {
    let stream: unknown = null;
    const outcome = await this.dispatch({
      runId: input.runId,
      profileId: input.profileId,
      kind: "chat",
      purpose: "reviewer",
      estimatedInputTokens: input.estimatedInputTokens,
      maxOutputTokens: input.maxOutputTokens,
      ...(input.inputManifestRef === undefined ? {} : { inputManifestRef: input.inputManifestRef }),
      ...(input.inputSerializedDigest === undefined ? {} : { inputSerializedDigest: input.inputSerializedDigest }),
      ...(input.profileRevision === undefined ? {} : { profileRevision: input.profileRevision }),
      ...(input.onIntent === undefined ? {} : { onIntent: input.onIntent }),
      ...(input.onDispatched === undefined ? {} : { onDispatched: input.onDispatched }),
      ...(input.revoked === undefined ? {} : { revoked: input.revoked }),
      signal: input.signal,
      reviewTransport: async (model, signal) => {
        const admitted = await transport(model, signal);
        if (admitted.ok) stream = admitted.value.stream;
        return admitted;
      },
    });
    if (!outcome.ok) return { ok: false, error: outcome.error };
    return { ok: true, value: { attemptId: outcome.value.attemptIds[0] ?? "", stream } };
  }

  #settle(
    attempt: ModelAttemptRecord,
    state: "settled",
    result: {
      output: string;
      model: { provider: string; id: string; revision: string | null };
      usage: Record<string, unknown> | null;
      stopReason: string | null;
      errorCode: string | null;
      profile: ModelProfileDefinition;
      classifierAnswers?: Record<string, unknown>;
    },
  ): Result<ModelResponse> {
    attempt.state = state;
    if (attempt.reservedTokens > 0) {
      this.#reservedTokens = Math.max(0, this.#reservedTokens - attempt.reservedTokens);
      attempt.reservedTokens = 0;
    }
    attempt.responseBytes = Buffer.byteLength(result.output, "utf8");
    attempt.actualModel = { ...result.model };
    attempt.capturedPrice = result.profile.price;
    attempt.stopReason = result.stopReason;
    attempt.errorCode = result.errorCode;
    attempt.settledAt = this.#now();
    attempt.usageRevision = 1;
    attempt.usage = normalizeUsage(result.usage, 1, "final");
    const operationalError = result.errorCode !== null || result.stopReason === "error";
    let declaredZero = false;
    if (operationalError) {
      // A terminal provider error with a synthetic zero-filled usage record is
      // not proof of a genuinely free complete request.
      const values = result.usage === null
        ? null
        : ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].map(key => result.usage?.[key]);
      declaredZero = values === null || values.every(value => value === undefined || value === null || value === 0);
      if (declaredZero) {
        attempt.usage = { ...attempt.usage, coverage: "unknown", totalTokens: null };
      } else if (attempt.usage.coverage === "complete") {
        attempt.usage = { ...attempt.usage, coverage: "partial" };
      }
    }
    attempt.cost = costFromUsage(result.usage, attempt.usage, result.profile);
    if (operationalError && declaredZero) attempt.cost = null;
    if (attempt.reservedCost !== null) {
      const reserved = attempt.reservedCost;
      const remaining = microUnits(this.#reservedCostByCurrency[reserved.currency] ?? "0");
      const released = microUnits(reserved.amount);
      if (remaining !== null && released !== null) {
        this.#reservedCostByCurrency[reserved.currency] = fromMicroUnits(remaining > released ? remaining - released : 0n);
      }
    }
    attempt.reservedCost = null;
    attempt.visibility = "attempt-level";
    this.#ledgerRevision += 1;
    const accounting: ModelResponse["accounting"] = attempt.usage.coverage === "complete" && attempt.cost?.coverage === "complete" ? "complete" : "partial";
    const output: unknown = (() => {
      if (result.classifierAnswers !== undefined) return result.classifierAnswers;
      try {
        return JSON.parse(result.output) as unknown;
      } catch {
        return result.output;
      }
    })();
    if (result.errorCode !== null || result.stopReason === "error") {
      this.#publish();
      return { ok: false, error: { code: result.errorCode ?? "core.model-provider-error", retryable: stopReasonRetryable(result.stopReason) } };
    }
    this.#publish();
    return {
      ok: true,
      value: {
        attemptIds: [attempt.attemptId],
        actualModel: { ...result.model },
        output: output as ModelResponse["output"],
        manifestId: `model-${attempt.attemptId}`,
        accounting,
      },
    };
  }

  /** Releases a reservation proven to have never reached the provider. */
  #releaseReservation(
    attempt: ModelAttemptRecord,
    estimated: number,
    estimatedCost: { currency: string; amount: string } | null,
    errorCode: string,
  ): void {
    attempt.state = "released";
    attempt.errorCode = errorCode;
    attempt.settledAt = this.#now();
    // An un-dispatched release clears the attempt's own reservation too, so a
    // released record never reports a lingering reserved amount.
    attempt.reservedTokens = 0;
    attempt.reservedCost = null;
    this.#reservedTokens = Math.max(0, this.#reservedTokens - estimated);
    this.#dispatchedCount = Math.max(0, this.#dispatchedCount - 1);
    if (estimatedCost !== null) {
      const reserved = microUnits(this.#reservedCostByCurrency[estimatedCost.currency] ?? "0");
      const amount = microUnits(estimatedCost.amount);
      if (reserved !== null && amount !== null) {
        this.#reservedCostByCurrency[estimatedCost.currency] = fromMicroUnits(reserved > amount ? reserved - amount : 0n);
      }
    }
    this.#ledgerRevision += 1;
    this.#publish();
  }

  /** Late usage reconciliation: a final observation replaces a provisional one once. */
  reconcile(attemptId: string, usage: Record<string, unknown> | null, finality: "provisional" | "final"): boolean {
    this.#syncFeed();
    const attempt = this.#attempts.get(attemptId);
    if (attempt === undefined) return false;
    if (finality === "provisional" && attempt.usage?.finality === "final") return false;
    attempt.usageRevision += 1;
    attempt.usage = normalizeUsage(usage, attempt.usageRevision, finality);
    if (attempt.capturedPrice != null) {
      // The immutable request-captured tariff is the only admissible basis,
      // even when a different live profile exists now. An admissible
      // correction replaces the owning amount with the tariff-derived amount.
      attempt.cost = costFromUsage(usage, attempt.usage, { price: attempt.capturedPrice } as ModelProfileDefinition);
    } else {
      // Missing basis stays unknown and fails closed under policy.
      attempt.cost = null;
    }
    if (attempt.state === "unresolved") {
      attempt.state = "settled";
      attempt.errorCode = null;
      attempt.visibility = "partial";
      if (attempt.reservedTokens > 0) {
        this.#reservedTokens = Math.max(0, this.#reservedTokens - attempt.reservedTokens);
        attempt.reservedTokens = 0;
      }
    }
    this.#ledgerRevision += 1;
    this.#publish();
    return true;
  }

  cancelUnsettled(): number {
    let cancelled = 0;
    for (const attempt of this.#attempts.values()) {
      if (attempt.state === "dispatched" || attempt.state === "reserved") {
        attempt.state = "unresolved";
        attempt.errorCode = "core.model-request-cancelled";
        attempt.visibility = "partial";
        cancelled += 1;
      }
    }
    if (cancelled > 0) {
      this.#ledgerRevision += 1;
      this.#publish();
    }
    return cancelled;
  }

  /** Restores bounded protected financial facts; restored values may only constrain. */
  /**
   * K07: retired physically unsettled owned operations. A restored row carries
   * the explicit `restored` placeholder rather than invented original
   * attribution; while its state is unresolved it keeps blocking dependent work.
   */
  /**
   * K07 233-B.4: one deduplicated physical/uncertain operation count. A live
   * attempt whose raw transport is still dispatched counts once (its own row);
   * a restored unknown row counts once. The same operation never counts twice.
   */
  /**
   * K07 B.4: physically/uncertain unsettled operations with their bounded known
   * attribution. One row is one operation; an unknown origin/profile stays null.
   */
  unsettledOperations(): Array<{ profileId: string | null; originRunId: string | null; restored: boolean; routeKey: string | null }> {
    const result: Array<{ profileId: string | null; originRunId: string | null; restored: boolean; routeKey: string | null }> = [];
    for (const attempt of this.#attempts.values()) {
      const restoredUnknown = attempt.runId === "restored" && (attempt.state === "reserved" || attempt.state === "dispatched" || attempt.state === "unresolved");
      const liveUnsettled = attempt.state === "dispatched" || attempt.state === "unresolved";
      if (!liveUnsettled && !restoredUnknown) continue;
      const profileId = typeof attempt.profileId === "string" && attempt.profileId !== "restored" ? attempt.profileId : null;
      const route = attempt.actualRoute ?? attempt.requestedRoute;
      const routeKey = route === null ? null : `${route.provider}|${route.model}`;
      result.push({ profileId, originRunId: attempt.runId === "restored" ? null : attempt.runId, restored: attempt.restored, routeKey });
    }
    return result;
  }

  physicalUnsettledCount(): number {
    let count = 0;
    for (const attempt of this.#attempts.values()) {
      // One row is one physical/uncertain operation. A live transport whose
      // dispatch returned by timeout stays `unresolved` (reservations retained);
      // a restored unknown row may still be reserved/dispatched/unresolved. The
      // same operation is never counted twice, and settled/cancelled/released
      // rows release the barrier.
      const restoredUnknown = attempt.runId === "restored" && attempt.state === "reserved";
      const liveUnsettled = attempt.state === "dispatched" || attempt.state === "unresolved";
      if (liveUnsettled || restoredUnknown) count += 1;
    }
    return count;
  }

  /** True while this attempt's raw transport is physically unsettled. */
  isPhysicallyDispatched(attemptId: string): boolean {
    const state = this.#attempts.get(attemptId)?.state;
    return state === "dispatched" || state === "unresolved";
  }

  unsettledRetiredCount(): number {
    return [...this.#attempts.values()].filter(attempt =>
      attempt.runId === "restored"
      && (attempt.state === "reserved" || attempt.state === "dispatched" || attempt.state === "unresolved")).length;
  }

  /**
   * K07-B.04: an accepted configuration reload must reach new work through the
   * CURRENT owner without resetting ledger, receipts, reservations or origin.
   */
  reconfigure(profiles: Readonly<Record<string, ModelProfileDefinition>>, approved: ReadonlySet<string> | readonly string[], budget: ModelServiceBudget): void {
    this.#profiles = profiles;
    this.#approved = approved instanceof Set ? approved : new Set(approved);
    this.#budget = budget;
  }

  restore(snapshot: FinancialSnapshot | null): number {
    if (snapshot === null) return 0;
    this.#ledgerRevision = Math.max(this.#ledgerRevision, snapshot.ledgerRevision);
    this.#dispatchedCount = Math.max(this.#dispatchedCount, snapshot.ownedRequestCount);
    // Session-wide aggregates are preserved independently of the bounded
    // receipt details: hidden facts are the aggregate minus the rows it also
    // carries, so nothing known is dropped merely to fit 32 details.
    this.#hidden = this.#hiddenFrom(snapshot);
    this.#hiddenCost = this.#hiddenCostFrom(snapshot);
    for (const entry of snapshot.attempts) {
      const match = /^attempt-(\d+)$/u.exec(entry.attemptId);
      if (match !== null) this.#attemptCounter = Math.max(this.#attemptCounter, Number(match[1]));
    }
    let applied = 0;
    for (const entry of snapshot.attempts) {
      if (this.#applyReceiptRow(entry)) applied += 1;
    }
    // Equal-ledger snapshots can be ordered only by their rows: reconcile the
    // aggregate reservation from the current row facts plus the honest hidden
    // liability (aggregate minus what its own rows carried), so a stale
    // pre-settlement copy cannot resurrect a reservation while real unresolved
    // work and out-of-window liabilities stay reserved.
    this.#reconcileReservations(snapshot);
    this.#pinFeed();
    return applied;
  }

  #reconcileReservations(snapshot: FinancialSnapshot): void {
    let visibleTokens = 0;
    let snapshotVisibleTokens = 0;
    const visibleCost: Record<string, string> = {};
    const snapshotVisibleCost: Record<string, string> = {};
    for (const attempt of this.#attempts.values()) visibleTokens += attempt.reservedTokens;
    for (const entry of snapshot.attempts) snapshotVisibleTokens += Number(entry.reservedTokens ?? 0);
    for (const attempt of this.#attempts.values()) {
      const reserved = attempt.reservedCost;
      if (reserved === null) continue;
      const current = microUnits(visibleCost[reserved.currency] ?? "0") ?? 0n;
      visibleCost[reserved.currency] = fromMicroUnits(current + (microUnits(reserved.amount) ?? 0n));
    }
    for (const entry of snapshot.attempts) {
      if (entry.reservedCostAmount === null || entry.reservedCostAmount === undefined) continue;
      if (entry.reservedCostCurrency === null || entry.reservedCostCurrency === undefined) continue;
      const current = microUnits(snapshotVisibleCost[entry.reservedCostCurrency] ?? "0") ?? 0n;
      snapshotVisibleCost[entry.reservedCostCurrency] = fromMicroUnits(current + (microUnits(entry.reservedCostAmount) ?? 0n));
    }
    this.#hiddenReservedTokens = Math.max(this.#hiddenReservedTokens, Math.max(0, Number(snapshot.reservedTokens) - snapshotVisibleTokens));
    this.#reservedTokens = visibleTokens + this.#hiddenReservedTokens;
    for (const [currency, amount] of Object.entries(snapshot.reservedCostByCurrency)) {
      const hiddenRaw = (microUnits(amount) ?? 0n) - (microUnits(snapshotVisibleCost[currency] ?? "0") ?? 0n);
      const hidden = hiddenRaw > 0n ? hiddenRaw : 0n;
      const known = microUnits(this.#hiddenReservedCost[currency] ?? "0") ?? 0n;
      this.#hiddenReservedCost[currency] = fromMicroUnits(hidden > known ? hidden : known);
    }
    this.#reservedCostByCurrency = {};
    for (const [currency, amount] of Object.entries(visibleCost)) this.#reservedCostByCurrency[currency] = amount;
    for (const [currency, amount] of Object.entries(this.#hiddenReservedCost)) {
      const current = microUnits(this.#reservedCostByCurrency[currency] ?? "0") ?? 0n;
      this.#reservedCostByCurrency[currency] = fromMicroUnits(current + (microUnits(amount) ?? 0n));
    }
  }

  /**
   * Hidden facts are the snapshot aggregate minus its bounded rows, further
   * reduced by ledger rows inside the snapshot session that its window no
   * longer carried: re-applying an older bounded snapshot must never
   * double count an attempt that is now explicitly in the ledger.
   */
  #hiddenFrom(snapshot: FinancialSnapshot): FinancialAggregate {
    const hidden = hiddenAggregate(snapshot);
    const rowIds = new Set(snapshot.attempts.map(row => row.attemptId));
    for (const [attemptId, attempt] of this.#attempts) {
      if (rowIds.has(attemptId)) continue;
      const counter = attemptCounterOf(attemptId);
      if (counter === null || counter > snapshot.ownedRequestCount) continue;
      const total = attempt.usage?.totalTokens ?? null;
      if (total === null) hidden.tokensMissing = Math.max(0, hidden.tokensMissing - 1);
      else hidden.knownTokens = Math.max(0, hidden.knownTokens - total);
      const coverage = attempt.usage?.coverage ?? "unknown";
      if (coverage === "complete") hidden.usageKnownCount = Math.max(0, hidden.usageKnownCount - 1);
      else if (coverage === "partial") hidden.usagePartialCount = Math.max(0, hidden.usagePartialCount - 1);
      else hidden.usageUnknownCount = Math.max(0, hidden.usageUnknownCount - 1);
      if (attempt.state === "settled") hidden.settledCount = Math.max(0, hidden.settledCount - 1);
      if (attempt.state === "unresolved") hidden.unresolvedCount = Math.max(0, hidden.unresolvedCount - 1);
      if (attempt.state === "cancelled") hidden.cancelledCount = Math.max(0, hidden.cancelledCount - 1);
      const remaining = (hidden.byPurpose[attempt.purpose] ?? 0) - 1;
      if (remaining > 0) hidden.byPurpose[attempt.purpose] = remaining;
      else delete hidden.byPurpose[attempt.purpose];
    }
    return hidden;
  }

  #hiddenCostFrom(snapshot: FinancialSnapshot): Record<string, string> {
    const hidden = hiddenCostMap(snapshot);
    const rowIds = new Set(snapshot.attempts.map(row => row.attemptId));
    for (const [attemptId, attempt] of this.#attempts) {
      if (rowIds.has(attemptId)) continue;
      const counter = attemptCounterOf(attemptId);
      if (counter === null || counter > snapshot.ownedRequestCount) continue;
      const currency = attempt.cost?.currency ?? null;
      const current = currency === null ? undefined : hidden[currency];
      if (attempt.cost?.amount != null && currency !== null && current !== undefined) {
        hidden[currency] = subtractAmount(current, attempt.cost.amount);
      }
    }
    return hidden;
  }

  /** Applies one receipt revision to the owned ledger; results are never restored. */
  #applyReceiptRow(entry: FinancialSnapshot["attempts"][number]): boolean {
    const coverage = coverageClass(entry.usageCoverage);
    const existing = this.#attempts.get(entry.attemptId);
    if (existing !== undefined) {
      if (entry.usageRevision < existing.usageRevision) return false;
      // Dispatched and unresolved are one functional uncertainty: the receiver
      // normalizes them on admission, so an identical replay must compare
      // through the same normalization instead of reporting a false advance.
      const replayStateMap: Record<string, ModelAttemptState> = {
        reserved: "reserved", dispatched: "unresolved", settled: "settled",
        unresolved: "unresolved", released: "released", cancelled: "cancelled",
      };
      const entryState = replayStateMap[entry.state] ?? entry.state;
      const same = entry.usageRevision === existing.usageRevision
        && (existing.usage?.totalTokens ?? null) === entry.totalTokens
        && (existing.cost?.amount ?? null) === entry.costAmount
        && (existing.cost?.currency ?? null) === entry.costCurrency
        && existing.state === entryState;
      if (same) return false;
      // Replacement, not addition: an admissible correction atomically
      // replaces the functional aggregate for this identity.
      existing.usageRevision = entry.usageRevision;
      existing.usage = entry.totalTokens !== null
        ? receiptUsage(entry.usageRevision, coverage, entry.totalTokens)
        : (coverage === "partial" ? receiptUsage(entry.usageRevision, "partial", null) : null);
      existing.cost = entry.costAmount !== null && entry.costCurrency !== null
        ? {
          amount: entry.costAmount,
          currency: entry.costCurrency,
          basis: existing.cost?.basis ?? "reported",
          coverage: coverage === "complete" ? "complete" : "partial",
          priceBasisRef: existing.cost?.priceBasisRef ?? null,
          usageRevision: entry.usageRevision,
          source: existing.cost?.source ?? "provider",
          knownComponents: existing.cost?.knownComponents ?? [],
          unknownComponentCount: existing.cost?.unknownComponentCount ?? 1,
        }
        : null;
      const stateMap: Record<string, ModelAttemptState> = {
        reserved: "reserved", dispatched: "dispatched", settled: "settled",
        unresolved: "unresolved", released: "released", cancelled: "cancelled",
      };
      const finalized = entry.state === "settled" || entry.state === "cancelled" || entry.state === "released";
      if (finalized && existing.reservedTokens > 0) {
        // The owning attempt settled: release exactly its stale aggregate
        // reservation; unknown/pending attempts stay conservatively reserved.
        this.#reservedTokens = Math.max(0, this.#reservedTokens - existing.reservedTokens);
        existing.reservedTokens = 0;
      }
      if (finalized && existing.reservedCost !== null) {
        const reserved = microUnits(this.#reservedCostByCurrency[existing.reservedCost.currency] ?? "0");
        const amount = microUnits(existing.reservedCost.amount);
        if (reserved !== null && amount !== null) {
          this.#reservedCostByCurrency[existing.reservedCost.currency] = fromMicroUnits(reserved > amount ? reserved - amount : 0n);
        }
        existing.reservedCost = null;
      }
      existing.state = stateMap[entry.state] ?? existing.state;
      existing.visibility = "partial";
      if (entry.state === "settled" && entry.totalTokens !== null) existing.errorCode = null;
      if (typeof entry.profileId === "string" && entry.profileId !== "restored") existing.profileId = entry.profileId;
      if (entry.price !== undefined) existing.capturedPrice = entry.price;
      // Known immutable attribution is retained (never rebuilt from current config).
      if (existing.requestedRoute === null && entry.requestedRoute !== undefined) existing.requestedRoute = entry.requestedRoute;
      if (existing.actualRoute === null && entry.actualRoute !== undefined && entry.actualRoute !== null) {
        existing.actualRoute = { provider: entry.actualRoute.provider, model: entry.actualRoute.model, revision: entry.actualRoute.revision ?? null };
      }
      if (existing.originGeneration === null && typeof entry.originGeneration === "string") existing.originGeneration = entry.originGeneration;
      if (existing.branchRef === null && typeof entry.branchRef === "string") existing.branchRef = entry.branchRef;
      return true;
    }
    this.#attempts.set(entry.attemptId, {
      attemptId: entry.attemptId,
      restored: true,
      // Known original attribution survives; only a genuinely unknown row falls
      // back to the explicit placeholder.
      runId: entry.originRunId ?? "restored",
      originGeneration: entry.originGeneration ?? null,
      branchRef: entry.branchRef ?? null,
      profileId: entry.profileId ?? "restored",
      kind: "chat",
      purpose: entry.purpose === "repair" ? "repair" : "direct",
      state: entry.state === "unresolved" ? "unresolved" : entry.state === "settled" ? "settled" : "unresolved",
      reservedTokens: entry.reservedTokens ?? 0,
      reservedCost: entry.reservedCostAmount != null && entry.reservedCostCurrency != null
        ? { currency: entry.reservedCostCurrency, amount: entry.reservedCostAmount }
        : null,
      usage: entry.totalTokens === null ? null : receiptUsage(entry.usageRevision, coverage, entry.totalTokens),
      usageRevision: entry.usageRevision,
      cost: entry.costAmount === null ? null : {
        amount: entry.costAmount,
        currency: entry.costCurrency,
        basis: "reported",
        coverage: "partial",
        priceBasisRef: null,
        usageRevision: entry.usageRevision,
        source: "provider",
        knownComponents: [],
        unknownComponentCount: 1,
      },
      actualModel: null,
      visibility: "partial",
      stopReason: null,
      errorCode: null,
      inputManifestRef: null,
      inputSerializedDigest: null,
      profileRevision: null,
      requestedRoute: entry.requestedRoute ?? null,
      actualRoute: entry.actualRoute === undefined || entry.actualRoute === null
        ? null
        : { provider: entry.actualRoute.provider, model: entry.actualRoute.model, revision: entry.actualRoute.revision ?? null },
      destinationRef: null,
      retryVisibility: "attempt-level",
      priceBasisRef: null,
      requestTimeoutMs: 0,
      effectiveMaxOutputTokens: 0,
      reasoningSetting: null,
      responseBytes: null,
      capturedPrice: entry.price ?? null,
      createdAt: this.#now(),
      settledAt: null,
    });
    return true;
  }

  /** Same-session receipt channel: late work from retired generations. */
  #publish(): void {
    if (this.#feed === null) return;
    if (this.#feedToken !== null) {
      // Refresh this generation's claims: only live/pending identities stay
      // claimed, and a served identity is released once every owner finalized.
      for (const owners of this.#feed.liveOwners.values()) owners.delete(this.#feedToken);
      for (const attempt of this.#attempts.values()) {
        if (attempt.state === "settled" || attempt.state === "cancelled" || attempt.state === "released") continue;
        let owners = this.#feed.liveOwners.get(attempt.attemptId);
        if (owners === undefined) {
          owners = new Set<object>();
          this.#feed.liveOwners.set(attempt.attemptId, owners);
        }
        owners.add(this.#feedToken);
      }
      for (const [attemptId, owners] of [...this.#feed.liveOwners]) {
        if (owners.size === 0) this.#feed.liveOwners.delete(attemptId);
      }
    }
    const snapshot = this.financialSnapshot();
    this.#feed.snapshot = snapshot;
    this.#feed.pinned = this.#hasLiveOwnership();
    // Active notification: the current owner receives the material receipt
    // immediately, independent of status/inspection or any scheduler.
    for (const listener of [...this.#feed.listeners]) {
      try {
        listener(snapshot);
      } catch {
        // One isolated listener can never break the settling transport path.
      }
    }
  }

  /** Live or physically pending ownership must never be evicted or orphaned. */
  #hasLiveOwnership(): boolean {
    for (const attempt of this.#attempts.values()) {
      if (attempt.state === "reserved" || attempt.state === "dispatched" || attempt.state === "unresolved") return true;
    }
    return false;
  }

  #pinFeed(): void {
    if (this.#feed !== null && this.#hasLiveOwnership()) this.#feed.pinned = true;
  }

  #receive(snapshot: FinancialSnapshot): void {
    if (snapshot === this.#lastFeedSnapshot) return;
    this.#lastFeedSnapshot = snapshot;
    const applied = this.restore(snapshot);
    if (applied > 0) {
      this.#pinFeed();
      this.#unpersistedReceipts += applied;
      // Persist the material receipt through the CURRENT owner immediately;
      // the retired generation can no longer safely write protected state.
      this.#onReceipt?.(`receipt-${applied}`);
    }
  }

  #syncFeed(): void {
    const snapshot = this.#feed?.snapshot ?? null;
    if (snapshot !== null) this.#receive(snapshot);
  }

  /** Detaches this service from the same-session receipt channel on retire. */
  disposeFeed(): void {
    const feed = this.#feed;
    if (feed === null) return;
    if (this.#feedToken !== null) {
      const finalizedState = (state: ModelAttemptState): boolean =>
        state === "settled" || state === "cancelled" || state === "released";
      for (const [attemptId, owners] of feed.liveOwners) {
        const attempt = this.#attempts.get(attemptId);
        // A retired generation that still owns a physically pending request
        // keeps its claim until that receipt is actually finalized.
        if (attempt === undefined || finalizedState(attempt.state)) owners.delete(this.#feedToken);
      }
      for (const [attemptId, owners] of [...feed.liveOwners]) {
        if (owners.size === 0) feed.liveOwners.delete(attemptId);
      }
    }
    if (this.#feedListener !== null) feed.listeners.delete(this.#feedListener);
  }

  /** Receipt revisions awaiting protected persistence through the current owner. */
  takeUnpersistedReceipts(): number {
    const pending = this.#unpersistedReceipts;
    this.#unpersistedReceipts = 0;
    return pending;
  }

  syncReceipts(): number {
    this.#syncFeed();
    return this.takeUnpersistedReceipts();
  }

  /** Session-wide receipt aggregate: ledger plus hidden session facts. */
  #aggregate(): FinancialAggregate {
    const view: FinancialAggregate = { ...this.#hidden, byPurpose: { ...this.#hidden.byPurpose } };
    for (const attempt of this.#attempts.values()) {
      const total = attempt.usage?.totalTokens ?? null;
      if (total === null) view.tokensMissing += 1;
      else view.knownTokens += total;
      const coverage = attempt.usage?.coverage ?? "unknown";
      if (coverage === "complete") view.usageKnownCount += 1;
      else if (coverage === "partial") view.usagePartialCount += 1;
      else view.usageUnknownCount += 1;
      if (attempt.state === "settled") view.settledCount += 1;
      if (attempt.state === "unresolved") view.unresolvedCount += 1;
      if (attempt.state === "cancelled") view.cancelledCount += 1;
      view.byPurpose[attempt.purpose] = (view.byPurpose[attempt.purpose] ?? 0) + 1;
    }
    return view;
  }

  /** Session-wide known cost: ledger rows plus hidden session facts. */
  #aggregateKnownCost(): Record<string, string> {
    const known: Record<string, string> = { ...this.#hiddenCost };
    for (const attempt of this.#attempts.values()) {
      if (attempt.cost?.amount != null && attempt.cost.currency != null) {
        known[attempt.cost.currency] = addAmounts(known[attempt.cost.currency] ?? "0", attempt.cost.amount);
      }
    }
    return known;
  }

  /** Bounded protected financial snapshot for the control checkpoint. */
  financialSnapshot(): FinancialSnapshot {
    this.#syncFeed();
    const view = this.#aggregate();
    // Bounded finalized detail never discards live/pending reconciliation
    // identities: unresolved/reserved/dispatched rows are always retained.
    const all = [...this.#attempts.values()];
    const finalizedState = (state: ModelAttemptState): boolean => state === "settled" || state === "cancelled" || state === "released";
    const pendingDetail = all.filter(attempt => !finalizedState(attempt.state));
    const reconcileIds = this.#feed?.liveOwners ?? null;
    const reconcileDetail = reconcileIds === null
      ? []
      : all.filter(attempt => finalizedState(attempt.state) && reconcileIds.has(attempt.attemptId));
    const finalizedDetail = all
      .filter(attempt => finalizedState(attempt.state) && (reconcileIds === null || !reconcileIds.has(attempt.attemptId)))
      .slice(-32);
    return {
      ledgerRevision: this.#ledgerRevision,
      ownedRequestCount: this.#dispatchedCount,
      reservedTokens: this.#reservedTokens,
      knownCostByCurrency: this.#aggregateKnownCost(),
      reservedCostByCurrency: { ...this.#reservedCostByCurrency },
      unresolvedCount: view.unresolvedCount,
      aggregate: {
        knownTokens: view.knownTokens,
        tokensMissing: view.tokensMissing,
        usageKnownCount: view.usageKnownCount,
        usagePartialCount: view.usagePartialCount,
        usageUnknownCount: view.usageUnknownCount,
        settledCount: view.settledCount,
        unresolvedCount: view.unresolvedCount,
        cancelledCount: view.cancelledCount,
        byPurpose: { ...view.byPurpose },
      },
      attempts: [...pendingDetail, ...reconcileDetail, ...finalizedDetail].map(attempt => ({
        attemptId: attempt.attemptId,
        state: attempt.state,
        purpose: attempt.purpose,
        profileId: attempt.profileId,
        price: attempt.capturedPrice,
        usageRevision: attempt.usageRevision,
        totalTokens: attempt.usage?.totalTokens ?? null,
        usageCoverage: attempt.usage?.coverage ?? "unknown",
        costAmount: attempt.cost?.amount ?? null,
        costCurrency: attempt.cost?.currency ?? null,
        reservedTokens: attempt.reservedTokens,
        reservedCostAmount: attempt.reservedCost?.amount ?? null,
        reservedCostCurrency: attempt.reservedCost?.currency ?? null,
        originRunId: attempt.runId,
        originGeneration: attempt.originGeneration,
        branchRef: attempt.branchRef,
        requestedRoute: attempt.requestedRoute,
        actualRoute: attempt.actualRoute,
      })),
    };
  }

  summary(): ModelUsageSummary {
    this.#syncFeed();
    const view = this.#aggregate();
    const coverage: "complete" | "partial" | "unknown" = view.tokensMissing > 0
      ? (view.usageUnknownCount > 0 ? "unknown" : "partial")
      : (view.usageUnknownCount > 0 || view.usagePartialCount > 0 ? "partial" : "complete");
    const unresolvedByCurrency = new Map<string, number>();
    for (const attempt of this.#attempts.values()) {
      if (attempt.state === "unresolved" && attempt.cost?.currency != null) {
        unresolvedByCurrency.set(attempt.cost.currency, (unresolvedByCurrency.get(attempt.cost.currency) ?? 0) + 1);
      }
    }
    const knownCostByCurrency = this.#aggregateKnownCost();
    return {
      scopeKind: "observed-session",
      ledgerRevision: this.#ledgerRevision,
      ownedRequestCount: this.#dispatchedCount,
      attemptVisibility: "attempt-level",
      settledCount: view.settledCount,
      unresolvedCount: view.unresolvedCount,
      cancelledCount: view.cancelledCount,
      usageKnownCount: view.usageKnownCount,
      usagePartialCount: view.usagePartialCount,
      usageUnknownCount: view.usageUnknownCount,
      normalizedTokens: { total: view.knownTokens, coverage },
      costByCurrency: Object.entries(knownCostByCurrency).map(([currency, knownAmount]) => ({
        currency,
        knownAmount,
        reservedAmount: this.#reservedCostByCurrency[currency] ?? "0",
        unresolvedCount: unresolvedByCurrency.get(currency) ?? 0,
        unknownCoverage: 0,
      })),
      byPurpose: { ...view.byPurpose },
      excluded: { primarySession: "excluded", externalHandoffs: 0 },
      asOf: this.#now(),
      historyCoverage: "complete",
    };
  }
}

/** Conservative pre-dispatch USD estimate when the route exposes a known basis. */
function estimateRequestCost(
  profile: ModelProfileDefinition,
  model: Record<string, unknown>,
  inputTokens: number,
  outputTokens: number,
): { currency: string; amount: string } | null {
  if (profile.price === "host-catalog") {
    const cost = model["cost"];
    if (typeof cost !== "object" || cost === null || Array.isArray(cost)) return null;
    const rates = cost as Record<string, unknown>;
    const inputRate = typeof rates["input"] === "number" ? rates["input"] : null;
    const outputRate = typeof rates["output"] === "number" ? rates["output"] : null;
    if (inputRate === null || outputRate === null) return null;
    const inputPart = calculateAmount(inputTokens, String(inputRate));
    const outputPart = calculateAmount(outputTokens, String(outputRate));
    if (inputPart === null || outputPart === null) return null;
    const amount = addAmounts(inputPart, outputPart);
    return microUnits(amount) === 0n ? null : { currency: "USD", amount };
  }
  if (profile.price === "unknown") return null;
  const inputPart = calculateAmount(inputTokens, profile.price.inputPerMillion);
  const outputPart = calculateAmount(outputTokens, profile.price.outputPerMillion);
  if (inputPart === null || outputPart === null) return null;
  const amount = addAmounts(inputPart, outputPart);
  return microUnits(amount) === 0n ? null : { currency: profile.price.currency, amount };
}

function stopReasonRetryable(stopReason: string | null): boolean {
  return stopReason === "error";
}

// ---------------------------------------------------------------------------
// Canonical input rendering from the assembled context and assessment
// resources. These are the exact bytes handed to the transport boundary.
// ---------------------------------------------------------------------------

function textOf(item: { content: readonly { type: string; text?: string; value?: unknown }[] }): string {
  const parts: string[] = [];
  for (const block of item.content) {
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "json") parts.push(JSON.stringify(block.value));
  }
  return parts.join("\n");
}

export interface RenderedModelInput {
  messages: Array<{ role: string; content: string }>;
  estimatedInputTokens: number;
  /** Bounded submitted-input manifest identity; never a body. */
  inputManifestRef: string;
  /** Digest of the earlier flat role/content domain (prepared input). */
  inputSerializedDigest: string;
  /** Final observable SDK message-array measurement: bytes and digest. */
  finalInputBytes: number;
  finalInputDigest: string;
  /** Internal assessment/resource facts bound into the manifest identity. */
  manifestBase: Record<string, unknown>;
}

export function renderChatInput(
  context: { items: readonly { id: string; role: string; content: readonly { type: string; text?: string; value?: unknown }[] }[] },
  assessment: {
    resourceRevision?: string;
    instructions: readonly {
      content: readonly { type: string; text?: string; value?: unknown }[];
      provenance?: { revision?: string };
    }[];
    questions?: Readonly<Record<string, unknown>> | null;
    resultSchema?: unknown;
    criteria?: readonly string[];
    configuredResources?: { questions: boolean; resultSchema: boolean };
    resourceProvenance?: ReadonlyArray<{ kind: string; uri: string; revision: string; changedDuringRead: boolean }>;
  },
): RenderedModelInput {
  const instructionText = assessment.instructions.map(instruction => textOf(instruction)).join("\n\n");
  const sections = context.items.map(item => `## ${item.role} ${item.id}\n${textOf(item)}`);
  // The complete configured resource package is serialized into the same
  // representation that is measured and dispatched: instructions, labeled
  // context, typed questions, result schema and check-owned criteria.
  if (assessment.configuredResources?.questions === true && assessment.questions !== undefined && assessment.questions !== null) {
    sections.push(`## configured questions\n${JSON.stringify(assessment.questions)}`);
  }
  if (assessment.resultSchema !== undefined && assessment.resultSchema !== null) {
    sections.push(`## configured result schema\n${JSON.stringify(assessment.resultSchema)}`);
  }
  if (assessment.criteria !== undefined && assessment.criteria.length > 0) {
    sections.push(`## check criteria\n${assessment.criteria.map(criterion => `- ${criterion}`).join("\n")}`);
  }
  const messages = [
    { role: "system", content: `${instructionText}\n\nReturn only the configured structured result. Do not modify the repository or launch another reviewer.` },
    { role: "user", content: sections.join("\n\n") },
  ];
  const instructionRevisions = assessment.instructions.map(instruction => instruction.provenance?.revision ?? null);
  const rendered: RenderedModelInput = {
    messages,
    estimatedInputTokens: 0,
    inputManifestRef: "",
    inputSerializedDigest: "",
    finalInputBytes: 0,
    finalInputDigest: "",
    manifestBase: {
      resourceRevision: assessment.resourceRevision ?? null,
      instructionRevisions,
      resourceProvenance: (assessment.resourceProvenance ?? []).map(entry => ({ kind: entry.kind, uri: entry.uri, revision: entry.revision, changed: entry.changedDuringRead })),
      criteria: assessment.criteria ?? [],
    },
  };
  finalizeRenderedInput(rendered);
  return rendered;
}

/** Digest of the exact serialized chat messages handed to the transport. */
export function serializedInputDigest(messages: ReadonlyArray<{ role: string; content: string }>): string {
  return createHash("sha256").update(JSON.stringify(messages), "utf8").digest("hex");
}

/**
 * Rebinds estimate/digest/manifest identity to the final dispatched
 * representation (observable role/content serialization, suffix included).
 */
export function finalizeRenderedInput(rendered: RenderedModelInput): void {
  // Earlier prepared domain: flat role/content strings.
  const flat = JSON.stringify(rendered.messages);
  rendered.inputSerializedDigest = createHash("sha256").update(flat, "utf8").digest("hex");
  // Final observable SDK-input domain: the message array with text blocks as
  // handed to the route. It governs final capacity, estimate/reservation and
  // the submitted manifest identity.
  const sdkMessages = rendered.messages.map(message => ({
    role: message.role,
    content: [{ type: "text", text: message.content }],
  }));
  const sdkSerialized = JSON.stringify(sdkMessages);
  rendered.finalInputBytes = Buffer.byteLength(sdkSerialized, "utf8");
  rendered.finalInputDigest = createHash("sha256").update(sdkSerialized, "utf8").digest("hex");
  rendered.estimatedInputTokens = Math.ceil(rendered.finalInputBytes / 4);
  rendered.inputManifestRef = `input-${createHash("sha256").update(JSON.stringify({
    ...rendered.manifestBase,
    preparedBytes: Buffer.byteLength(flat, "utf8"),
    preparedDigest: rendered.inputSerializedDigest,
    sdkInputBytes: rendered.finalInputBytes,
    sdkInputDigest: rendered.finalInputDigest,
  }), "utf8").digest("hex").slice(0, 16)}`;
}

export function renderClassifierState(context: { items: readonly { id: string; role: string }[]; coverage: { state: string } }): Record<string, unknown> {
  return {
    coverage: context.coverage.state,
    itemCount: context.items.length,
    evidenceIds: context.items.filter(item => item.role === "evidence").map(item => item.id).slice(0, 16),
    requiredPresent: context.items.some(item => item.role === "requirement"),
  };
}
