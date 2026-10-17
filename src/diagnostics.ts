// O1 diagnostic projection and bounded recent history.
//
// Only already-projected metadata reaches this history. Records are built from
// closed, engine-authored payload schemas; raw configuration text, tool
// arguments, task text and model prose have no path into this module. Unknown
// payload fields are omitted and reported in the record projection. The history
// is bounded by both record count and serialized UTF-8 bytes, and retained
// records are frozen so a reader cannot mutate what another reader sees.

import { randomUUID } from "node:crypto";
import type {
  DiagnosticCorrelation,
  DiagnosticEventName,
  DiagnosticLevel,
  DiagnosticProjection,
  DiagnosticRecordV1,
  DiagnosticScope,
  DetailProfile,
  Json,
  JsonObject,
} from "./contracts.js";

export const DEFAULT_MAX_RECORD_BYTES = 65_536;

export interface DiagnosticHistoryLimits {
  maxEvents: number;
  maxBytes: number;
  maxRecordBytes: number;
  /** Lowest ordinary detail selected; failures are elevated regardless. */
  detail?: DetailProfile;
}

export interface DiagnosticHistoryContext {
  observedSessionId: string;
  scope: DiagnosticScope;
  configRevision: string;
  dataPolicyRevision: string;
  ownerId: string;
  /**
   * Live scope source. Diagnostic record scopes must reflect the current
   * authority (restored or advanced), not the constructor snapshot.
   */
  currentScope?: () => DiagnosticScope;
}

export interface DiagnosticAppendInput {
  event: DiagnosticEventName;
  level: DiagnosticLevel;
  reasonCodes: readonly string[];
  data: JsonObject;
  ownerId?: string;
  correlation?: Partial<DiagnosticCorrelation>;
}

// ---------------------------------------------------------------------------
// Closed payload schemas
// ---------------------------------------------------------------------------

type ValueSpec =
  | { t: "string" }
  | { t: "integer" }
  | { t: "number" }
  | { t: "boolean" }
  | { t: "stringArray" }
  | { t: "nullableString" }
  | { t: "nullableInteger" }
  | { t: "jsonObject" }
  | { t: "measurements" }
  | { t: "sizes" }
  | { t: "findings" }
  | { t: "counts" }
  | { t: "selection" }
  | { t: "manifestItems" }
  | { t: "normalizedUsage" }
  | { t: "costObservation" }
  | { t: "route" }
  | { t: "decimalOrInteger" }
  | { t: "nullableBoolean" }
  | { t: "assessmentFindings" }
  | { t: "assessmentScores" }
  | { t: "countMap" };

type EventSchema = Record<string, ValueSpec>;

const NULLABLE_MEASUREMENT_FIELDS = [
  "value", "threshold", "crossedThresholds", "elapsedMs", "thresholdMs",
  "lastActivityAgeMs", "lastProgressAgeMs", "activeOperationCount",
] as const;

const EVENT_SCHEMAS: Record<DiagnosticEventName, EventSchema> = {
  "quality.runtime.started": {
    engineVersion: { t: "string" }, engineBuildRef: { t: "string" }, hostVersion: { t: "string" },
    hostMode: { t: "string" }, restored: { t: "boolean" }, checkpointRevision: { t: "string" },
    executionState: { t: "string" }, workState: { t: "string" }, operatorStopped: { t: "boolean" },
    accountingCoverage: { t: "string" },
  },
  "quality.runtime.retired": {
    cause: { t: "string" }, unsettledOperations: { t: "integer" }, unresolvedAttempts: { t: "integer" },
    pendingActions: { t: "integer" }, checkpointRevision: { t: "string" }, journalFlushState: { t: "string" },
  },
  "quality.runtime.state": {
    previousExecution: { t: "string" }, execution: { t: "string" }, previousWork: { t: "string" },
    work: { t: "string" }, operatorStopped: { t: "boolean" }, observerPaused: { t: "boolean" },
    evidenceRefs: { t: "stringArray" },
  },
  "quality.config.applied": {
    configRevision: { t: "string" }, previousRevision: { t: "string" }, dataPolicyRevision: { t: "string" },
    changedFieldPaths: { t: "stringArray" }, captureWidened: { t: "boolean" },
    destinationChanged: { t: "boolean" }, activeCheckCount: { t: "integer" },
  },
  "quality.config.rejected": {
    candidateRevision: { t: "string" }, fieldPaths: { t: "stringArray" },
    errorCodes: { t: "stringArray" }, runtimeUnchanged: { t: "boolean" },
  },
  "quality.component.lifecycle": {
    componentId: { t: "string" }, packageId: { t: "string" }, packageVersion: { t: "string" },
    registrationId: { t: "string" }, phase: { t: "string" }, capabilityRefs: { t: "stringArray" },
    durationMs: { t: "number" }, errorCode: { t: "nullableString" },
  },
  "quality.component.note": {
    componentId: { t: "string" }, registrationId: { t: "string" }, code: { t: "string" },
    refs: { t: "stringArray" }, counts: { t: "counts" },
  },
  "quality.trigger.due": {
    checkId: { t: "string" }, checkRevision: { t: "string" }, bindingId: { t: "string" },
    componentId: { t: "string" }, intentId: { t: "string" }, basis: { t: "string" },
    firstDueAt: { t: "string" }, measurements: { t: "measurements" },
    evidenceCursor: { t: "nullableInteger" }, workEligibility: { t: "string" },
  },
  "quality.check.requested": {
    checkId: { t: "string" }, checkRevision: { t: "string" }, requestSource: { t: "string" },
    intentRefs: { t: "stringArray" }, criterionIds: { t: "stringArray" },
  },
  "quality.check.admission": {
    checkId: { t: "string" }, outcome: { t: "string" }, runId: { t: "nullableString" },
    intentRefs: { t: "stringArray" }, mergedIntoRunId: { t: "nullableString" },
    queuePosition: { t: "nullableInteger" }, reasonCodes: { t: "stringArray" },
    coveredByCheckId: { t: "nullableString" },
  },
  "quality.check.started": {
    checkId: { t: "string" }, checkRevision: { t: "string" }, intentRefs: { t: "stringArray" },
    evaluatorProfileId: { t: "string" }, policyId: { t: "string" }, configuredTimeoutMs: { t: "integer" },
    queueWaitMs: { t: "number" }, mode: { t: "string" },
  },
  "quality.check.settled": {
    operational: { t: "string" }, conclusion: { t: "string" }, coverage: { t: "string" },
    findingCount: { t: "integer" }, actionCount: { t: "integer" }, usageAttemptRefs: { t: "stringArray" },
    accountingCoverage: { t: "string" }, durationMs: { t: "number" }, terminalReason: { t: "string" },
  },
  "quality.context.source": {
    manifestId: { t: "string" }, sourceId: { t: "string" }, stage: { t: "string" },
    resourceRefs: { t: "stringArray" }, required: { t: "boolean" }, selectionState: { t: "string" },
    sizes: { t: "sizes" }, omittedCount: { t: "integer" }, reasonCode: { t: "nullableString" },
  },
  "quality.resource.described": {
    resourceId: { t: "string" }, kind: { t: "string" }, revisionRef: { t: "string" },
    sourceId: { t: "nullableString" }, displayPath: { t: "nullableString" },
    sizes: { t: "sizes" }, visibility: { t: "string" }, repeated: { t: "boolean" },
  },
  "quality.context.manifest": {
    manifestId: { t: "string" }, snapshotId: { t: "string" }, boundary: { t: "string" },
    attemptId: { t: "nullableString" }, profileId: { t: "nullableString" },
    parentManifestId: { t: "nullableString" }, coverage: { t: "string" }, inputVisibility: { t: "string" },
    requiredItems: { t: "integer" }, includedRequiredItems: { t: "integer" }, optionalItems: { t: "integer" },
    includedOptionalItems: { t: "integer" }, omittedItems: { t: "integer" }, contentTruncated: { t: "boolean" },
    manifestTruncated: { t: "boolean" }, itemCount: { t: "integer" }, partCount: { t: "integer" },
    resourceRefs: { t: "stringArray" }, issueCodes: { t: "stringArray" }, sizes: { t: "sizes" },
  },
  "quality.context.manifest-part": {
    manifestId: { t: "string" }, partIndex: { t: "integer" }, itemCount: { t: "integer" },
    items: { t: "manifestItems" },
  },
  "quality.assessment.result": {
    operational: { t: "string" }, coverage: { t: "string" }, conclusion: { t: "string" },
    findings: { t: "assessmentFindings" }, scores: { t: "assessmentScores" },
    dependencyRefs: { t: "stringArray" }, additionalEvidenceRefs: { t: "stringArray" },
    attemptRefs: { t: "stringArray" }, validationState: { t: "string" },
  },
  "quality.policy.decided": {
    policyId: { t: "string" }, policyRevision: { t: "string" }, disposition: { t: "string" },
    findingRefs: { t: "stringArray" }, proposalRefs: { t: "stringArray" }, reasonCodes: { t: "stringArray" },
  },
  "quality.action.admission": {
    actionId: { t: "string" }, componentId: { t: "string" }, outcome: { t: "string" },
    effectKinds: { t: "stringArray" }, findingRefs: { t: "stringArray" },
    currentAuthority: { t: "string" }, freshness: { t: "string" }, reasonCodes: { t: "stringArray" },
  },
  "quality.action.dispatched": {
    actionId: { t: "string" }, componentId: { t: "string" }, effectKinds: { t: "stringArray" },
    destinationRef: { t: "nullableString" }, bodyDescriptor: { t: "string" }, checkpointRevision: { t: "string" },
  },
  "quality.action.receipt": {
    actionId: { t: "string" }, receiptRevision: { t: "integer" }, state: { t: "string" },
    destinationRef: { t: "nullableString" }, evidenceRefs: { t: "stringArray" }, errorCode: { t: "nullableString" },
  },
  "quality.feedback.observed": {
    actionId: { t: "string" }, classification: { t: "string" }, method: { t: "string" },
    evidenceRefs: { t: "stringArray" }, assessedAt: { t: "string" }, coverage: { t: "string" },
  },
  "quality.journal.opened": {
    logicalJournalId: { t: "string" }, segmentOrdinal: { t: "integer" }, writerGeneration: { t: "string" },
    previousSegmentOrdinal: { t: "nullableInteger" }, openReason: { t: "string" },
    previousTailState: { t: "string" }, recordPolicyRevision: { t: "string" },
  },
  "quality.journal.closed": {
    logicalJournalId: { t: "string" }, segmentOrdinal: { t: "integer" }, closeReason: { t: "string" },
    recordCount: { t: "integer" }, serializedBytes: { t: "integer" }, flushState: { t: "string" },
    historyCoverage: { t: "string" },
  },
  "quality.clock.resynchronized": {
    cause: { t: "string" }, overdueBindings: { t: "integer" }, coalescedIntents: { t: "integer" },
    elapsedHistoryKnown: { t: "boolean" },
  },
  "quality.trigger.deadline": {
    checkId: { t: "string" }, bindingId: { t: "string" }, phase: { t: "string" },
    dueMonoMs: { t: "nullableInteger" }, delayMs: { t: "nullableInteger" }, reasonCode: { t: "string" },
  },
  "quality.model.preflight": {
    profileId: { t: "string" }, outcome: { t: "string" }, capabilityRefs: { t: "stringArray" },
    manifestId: { t: "string" }, estimatedInputTokens: { t: "integer" }, reservedOutputTokens: { t: "integer" },
    errorCode: { t: "nullableString" },
  },
  "quality.model.dispatched": {
    attemptId: { t: "string" }, requestGroupId: { t: "string" }, ordinal: { t: "integer" },
    purpose: { t: "string" }, profileId: { t: "string" }, profileRevision: { t: "nullableString" },
    requestedRoute: { t: "route" }, actualRoute: { t: "route" }, destinationRef: { t: "nullableString" },
    manifestId: { t: "string" }, requestBoundary: { t: "string" }, retryVisibility: { t: "string" },
    priceBasisRef: { t: "nullableString" }, reservationRef: { t: "nullableString" },
    requestTimeoutMs: { t: "integer" }, maxOutputTokens: { t: "integer" },
    reasoningSetting: { t: "nullableString" }, accountingOwner: { t: "string" },
  },
  "quality.model.settled": {
    attemptId: { t: "string" }, attemptRevision: { t: "integer" }, outcome: { t: "string" },
    stopReasonCode: { t: "string" }, durationMs: { t: "number" }, responseSizes: { t: "sizes" },
    usage: { t: "normalizedUsage" }, cost: { t: "costObservation" },
    accountingCoverage: { t: "string" }, errorCode: { t: "nullableString" },
  },
  "quality.model.usage-updated": {
    attemptId: { t: "string" }, attemptRevision: { t: "integer" }, replacesRevision: { t: "nullableInteger" },
    usage: { t: "normalizedUsage" }, cost: { t: "costObservation" },
    accountingCoverage: { t: "string" }, late: { t: "boolean" }, source: { t: "string" },
  },
  "quality.budget.denied": {
    operationRef: { t: "string" }, limitKind: { t: "string" }, limitValue: { t: "decimalOrInteger" },
    knownValue: { t: "decimalOrInteger" }, reservedValue: { t: "decimalOrInteger" },
    unknownCoverage: { t: "string" }, reasonCode: { t: "string" },
  },
  "quality.usage.summary": {
    scopeKind: { t: "string" }, ledgerRevision: { t: "integer" }, ownedRequestCount: { t: "integer" },
    attemptVisibility: { t: "string" }, settledCount: { t: "integer" }, unresolvedCount: { t: "integer" },
    cancelledCount: { t: "integer" }, usageKnownCount: { t: "integer" }, usagePartialCount: { t: "integer" },
    usageUnknownCount: { t: "integer" }, normalizedTotalTokens: { t: "nullableInteger" },
    normalizedCoverage: { t: "string" }, historyCoverage: { t: "string" },
  },
  "quality.journal.rotation": {
    fromSegment: { t: "integer" }, toSegment: { t: "integer" }, reason: { t: "string" },
    thresholdBytes: { t: "nullableInteger" }, observedBytes: { t: "integer" },
    archiveCompression: { t: "string" }, outcome: { t: "string" },
  },
  "quality.retention.sweep": {
    scope: { t: "string" }, eligibleFiles: { t: "integer" }, removedFiles: { t: "integer" },
    removedBytes: { t: "integer" }, remainingOwnedBytes: { t: "integer" }, targetBytes: { t: "integer" },
    overTargetReason: { t: "string" }, historyCoverage: { t: "string" },
  },
  "quality.control.checkpoint": {
    revision: { t: "integer" }, outcome: { t: "string" }, serializedBytes: { t: "integer" },
    durationMs: { t: "number" }, protectedStateRef: { t: "string" },
  },
  "quality.diagnostic.gap": {
    sinkId: { t: "string" }, firstLostSequence: { t: "nullableInteger" },
    lastLostSequence: { t: "nullableInteger" }, lostCount: { t: "integer" },
    byEventFamily: { t: "countMap" }, cause: { t: "string" }, exact: { t: "boolean" },
  },
  "quality.sink.health": {
    sinkId: { t: "string" }, previousState: { t: "string" }, state: { t: "string" },
    queuedRecords: { t: "integer" }, queuedBytes: { t: "integer" }, lostRecords: { t: "integer" },
    reasonCode: { t: "string" },
  },
};

export function isDiagnosticEventName(event: string): event is DiagnosticEventName {
  return Object.hasOwn(EVENT_SCHEMAS, event);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function closeScalar(spec: ValueSpec, value: unknown): { ok: true; value: Json } | { ok: false } {
  switch (spec.t) {
    case "string":
      return typeof value === "string" ? { ok: true, value } : { ok: false };
    case "nullableString":
      return value === null || typeof value === "string" ? { ok: true, value: value as Json } : { ok: false };
    case "integer":
      return typeof value === "number" && Number.isInteger(value) ? { ok: true, value } : { ok: false };
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? { ok: true, value } : { ok: false };
    case "boolean":
      return typeof value === "boolean" ? { ok: true, value } : { ok: false };
    case "stringArray":
      return Array.isArray(value) && value.every(entry => typeof entry === "string")
        ? { ok: true, value: value as Json }
        : { ok: false };
    case "nullableInteger":
      return value === null || (typeof value === "number" && Number.isInteger(value))
        ? { ok: true, value: value as Json }
        : { ok: false };
    case "measurements": {
      if (!isJsonObject(value)) return { ok: false };
      const counter = closeScalar({ t: "nullableString" }, value["counter"]);
      if (!counter.ok) return { ok: false };
      const closed: JsonObject = { counter: counter.value };
      for (const field of NULLABLE_MEASUREMENT_FIELDS) {
        const entry = closeScalar({ t: "nullableInteger" }, value[field]);
        if (!entry.ok) return { ok: false };
        closed[field] = entry.value;
      }
      return { ok: true, value: closed };
    }
    case "sizes": {
      if (!Array.isArray(value) || value.length > 16) return { ok: false };
      const closed: Json[] = [];
      for (const entry of value) {
        if (!isJsonObject(entry)) return { ok: false };
        const boundary = closeScalar({ t: "string" }, entry["boundary"]);
        const utf8Bytes = closeScalar({ t: "nullableInteger" }, entry["utf8Bytes"]);
        const unicodeScalars = closeScalar({ t: "nullableInteger" }, entry["unicodeScalars"]);
        const lines = closeScalar({ t: "nullableInteger" }, entry["lines"]);
        const complete = closeScalar({ t: "boolean" }, entry["complete"]);
        if (!boundary.ok || !utf8Bytes.ok || !unicodeScalars.ok || !lines.ok || !complete.ok) return { ok: false };
        let estimatedTokens: Json = null;
        if (entry["estimatedTokens"] !== null && entry["estimatedTokens"] !== undefined) {
          const tokens = entry["estimatedTokens"];
          if (!isJsonObject(tokens)) return { ok: false };
          const count = closeScalar({ t: "integer" }, tokens["count"]);
          const methodId = closeScalar({ t: "string" }, tokens["methodId"]);
          const revision = closeScalar({ t: "nullableString" }, tokens["revision"]);
          if (!count.ok || !methodId.ok || !revision.ok) return { ok: false };
          estimatedTokens = { count: count.value, methodId: methodId.value, revision: revision.value };
        }
        closed.push({
          boundary: boundary.value,
          utf8Bytes: utf8Bytes.value,
          unicodeScalars: unicodeScalars.value,
          lines: lines.value,
          estimatedTokens,
          complete: complete.value,
        });
      }
      return { ok: true, value: closed };
    }
    case "nullableBoolean":
      return value === null || typeof value === "boolean" ? { ok: true, value: value as Json } : { ok: false };
    case "decimalOrInteger":
      if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return { ok: true, value };
      if (typeof value === "string" && /^[0-9]+(?:\.[0-9]+)?$/u.test(value)) return { ok: true, value };
      return { ok: false };
    case "route": {
      if (!isJsonObject(value)) return { ok: false };
      const provider = closeScalar({ t: "nullableString" }, value["provider"]);
      const model = closeScalar({ t: "nullableString" }, value["model"]);
      const revision = closeScalar({ t: "nullableString" }, value["revision"]);
      if (!provider.ok || !model.ok || !revision.ok) return { ok: false };
      return { ok: true, value: { provider: provider.value, model: model.value, revision: revision.value } };
    }
    case "normalizedUsage": {
      if (value === null || value === undefined) return { ok: true, value: null };
      if (!isJsonObject(value)) return { ok: false };
      const closed: JsonObject = {};
      for (const [key, spec] of Object.entries({
        revision: { t: "integer" }, observationSource: { t: "string" }, sourceSchemaId: { t: "nullableString" },
        adapterRevision: { t: "nullableString" }, inputTokens: { t: "nullableInteger" },
        uncachedInputTokens: { t: "nullableInteger" }, cacheReadTokens: { t: "nullableInteger" },
        cacheWriteTokens: { t: "nullableInteger" }, outputTokens: { t: "nullableInteger" },
        reasoningTokens: { t: "nullableInteger" }, totalTokens: { t: "nullableInteger" },
        inputPartition: { t: "string" }, outputIncludesReasoning: { t: "nullableBoolean" },
        totalBasis: { t: "string" }, coverage: { t: "string" }, finality: { t: "string" },
      } as Record<string, ValueSpec>)) {
        const entry = closeScalar(spec, value[key]);
        if (!entry.ok) return { ok: false };
        closed[key] = entry.value;
      }
      return { ok: true, value: closed };
    }
    case "costObservation": {
      if (value === null || value === undefined) return { ok: true, value: null };
      if (!isJsonObject(value)) return { ok: false };
      const amount = closeScalar({ t: "nullableString" }, value["amount"]);
      const currency = closeScalar({ t: "nullableString" }, value["currency"]);
      const basis = closeScalar({ t: "string" }, value["basis"]);
      const coverage = closeScalar({ t: "string" }, value["coverage"]);
      const priceBasisRef = closeScalar({ t: "nullableString" }, value["priceBasisRef"]);
      const usageRevision = closeScalar({ t: "integer" }, value["usageRevision"]);
      const source = closeScalar({ t: "string" }, value["source"]);
      const unknownComponentCount = closeScalar({ t: "integer" }, value["unknownComponentCount"]);
      const rawComponents = value["knownComponents"];
      if (!amount.ok || !currency.ok || !basis.ok || !coverage.ok || !priceBasisRef.ok
        || !usageRevision.ok || !source.ok || !unknownComponentCount.ok
        || !Array.isArray(rawComponents) || rawComponents.length > 16) return { ok: false };
      const components: Json[] = [];
      for (const entry of rawComponents) {
        if (!isJsonObject(entry)) return { ok: false };
        const category = closeScalar({ t: "string" }, entry["category"]);
        const componentAmount = closeScalar({ t: "string" }, entry["amount"]);
        if (!category.ok || !componentAmount.ok) return { ok: false };
        components.push({ category: category.value, amount: componentAmount.value });
      }
      return {
        ok: true,
        value: {
          amount: amount.value, currency: currency.value, basis: basis.value, coverage: coverage.value,
          priceBasisRef: priceBasisRef.value, usageRevision: usageRevision.value, source: source.value,
          knownComponents: components, unknownComponentCount: unknownComponentCount.value,
        },
      };
    }
    case "findings": {
      if (!Array.isArray(value) || value.length > 64) return { ok: false };
      const closed: Json[] = [];
      for (const entry of value) {
        if (!isJsonObject(entry)) return { ok: false };
        const findingId = closeScalar({ t: "string" }, entry["findingId"]);
        const criterionId = closeScalar({ t: "string" }, entry["criterionId"]);
        const code = closeScalar({ t: "string" }, entry["code"]);
        const severity = closeScalar({ t: "string" }, entry["severity"]);
        const occurrenceCount = closeScalar({ t: "integer" }, entry["occurrenceCount"]);
        const toolName = closeScalar({ t: "nullableString" }, entry["toolName"]);
        const evidenceRefs = closeScalar({ t: "stringArray" }, entry["evidenceRefs"]);
        if (!findingId.ok || !criterionId.ok || !code.ok || !severity.ok
          || !occurrenceCount.ok || !toolName.ok || !evidenceRefs.ok) return { ok: false };
        closed.push({
          findingId: findingId.value, criterionId: criterionId.value, code: code.value,
          severity: severity.value, occurrenceCount: occurrenceCount.value, toolName: toolName.value,
          evidenceRefs: evidenceRefs.value,
        });
      }
      return { ok: true, value: closed };
    }
    case "counts": {
      if (!isJsonObject(value) || Object.keys(value).length > 32) return { ok: false };
      const closed: JsonObject = {};
      for (const [key, entry] of Object.entries(value)) {
        if (entry === null || typeof entry === "boolean" || (typeof entry === "number" && Number.isFinite(entry))) {
          closed[key] = entry;
        } else {
          return { ok: false };
        }
      }
      return { ok: true, value: closed };
    }
    case "selection": {
      if (!isJsonObject(value)) return { ok: false };
      const kind = closeScalar({ t: "string" }, value["kind"]);
      const rangesRaw = value["ranges"];
      const sectionRefs = closeScalar({ t: "stringArray" }, value["sectionRefs"]);
      const inputRefs = closeScalar({ t: "stringArray" }, value["inputRefs"]);
      const methodId = closeScalar({ t: "nullableString" }, value["methodId"]);
      if (!kind.ok || !Array.isArray(rangesRaw) || rangesRaw.length > 32 || !sectionRefs.ok || !inputRefs.ok || !methodId.ok) {
        return { ok: false };
      }
      const ranges: Json[] = [];
      for (const range of rangesRaw) {
        if (!isJsonObject(range)) return { ok: false };
        const start = closeScalar({ t: "integer" }, range["start"]);
        const end = closeScalar({ t: "integer" }, range["end"]);
        if (!start.ok || !end.ok) return { ok: false };
        ranges.push({ start: start.value, end: end.value });
      }
      return { ok: true, value: { kind: kind.value, ranges, sectionRefs: sectionRefs.value, inputRefs: inputRefs.value, methodId: methodId.value } };
    }
    case "manifestItems": {
      if (!Array.isArray(value) || value.length > 128) return { ok: false };
      const closed: Json[] = [];
      for (const entry of value) {
        if (!isJsonObject(entry)) return { ok: false };
        const itemId = closeScalar({ t: "string" }, entry["itemId"]);
        const resourceId = closeScalar({ t: "string" }, entry["resourceId"]);
        const sourceId = closeScalar({ t: "string" }, entry["sourceId"]);
        const role = closeScalar({ t: "string" }, entry["role"]);
        const required = closeScalar({ t: "boolean" }, entry["required"]);
        const revisionRef = closeScalar({ t: "string" }, entry["revisionRef"]);
        const disposition = closeScalar({ t: "string" }, entry["disposition"]);
        const changedDuringRead = closeScalar({ t: "boolean" }, entry["changedDuringRead"]);
        const sizes = closeScalar({ t: "sizes" }, entry["sizes"]);
        const captureRefs = closeScalar({ t: "stringArray" }, entry["captureRefs"]);
        const selection = closeScalar({ t: "selection" }, entry["selection"]);
        if (!itemId.ok || !resourceId.ok || !sourceId.ok || !role.ok || !required.ok
          || !revisionRef.ok || !disposition.ok || !changedDuringRead.ok || !sizes.ok
          || !captureRefs.ok || !selection.ok) return { ok: false };
        closed.push({
          itemId: itemId.value, resourceId: resourceId.value, sourceId: sourceId.value, role: role.value,
          required: required.value, revisionRef: revisionRef.value, selection: selection.value,
          disposition: disposition.value, changedDuringRead: changedDuringRead.value, sizes: sizes.value,
          captureRefs: captureRefs.value,
        });
      }
      return { ok: true, value: closed };
    }
    case "assessmentFindings": {
      if (!Array.isArray(value) || value.length > 64) return { ok: false };
      const closed: Json[] = [];
      for (const entry of value) {
        if (!isJsonObject(entry)) return { ok: false };
        const findingRef = closeScalar({ t: "string" }, entry["findingRef"]);
        const responseIdRef = closeScalar({ t: "string" }, entry["responseIdRef"]);
        const criterionId = closeScalar({ t: "string" }, entry["criterionId"]);
        const status = closeScalar({ t: "string" }, entry["status"]);
        const severity = closeScalar({ t: "string" }, entry["severity"]);
        const defectCode = closeScalar({ t: "string" }, entry["defectCode"]);
        const requirementRefs = closeScalar({ t: "stringArray" }, entry["requirementRefs"]);
        const evidenceRefs = closeScalar({ t: "stringArray" }, entry["evidenceRefs"]);
        const affectedRefs = closeScalar({ t: "stringArray" }, entry["affectedRefs"]);
        if (!findingRef.ok || !responseIdRef.ok || !criterionId.ok || !status.ok || !severity.ok
          || !defectCode.ok || !requirementRefs.ok || !evidenceRefs.ok || !affectedRefs.ok) return { ok: false };
        closed.push({
          findingRef: findingRef.value, responseIdRef: responseIdRef.value, criterionId: criterionId.value,
          status: status.value, severity: severity.value, defectCode: defectCode.value,
          requirementRefs: requirementRefs.value, evidenceRefs: evidenceRefs.value, affectedRefs: affectedRefs.value,
        });
      }
      return { ok: true, value: closed };
    }
    case "countMap": {
      if (!isJsonObject(value) || Object.keys(value).length > 32) return { ok: false };
      const closed: JsonObject = {};
      for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0) closed[key] = entry;
        else return { ok: false };
      }
      return { ok: true, value: closed };
    }
    case "assessmentScores": {
      if (!Array.isArray(value) || value.length > 32) return { ok: false };
      const closed: Json[] = [];
      for (const entry of value) {
        if (!isJsonObject(entry)) return { ok: false };
        const criterionId = closeScalar({ t: "string" }, entry["criterionId"]);
        const kind = closeScalar({ t: "string" }, entry["kind"]);
        const scoreValue = closeScalar({ t: "number" }, entry["value"]);
        const minimum = closeScalar({ t: "number" }, entry["minimum"]);
        const maximum = closeScalar({ t: "number" }, entry["maximum"]);
        const calibrationRef = closeScalar({ t: "nullableString" }, entry["calibrationRef"]);
        const interpretationRef = closeScalar({ t: "nullableString" }, entry["interpretationRef"]);
        if (!criterionId.ok || !kind.ok || !scoreValue.ok || !minimum.ok || !maximum.ok
          || !calibrationRef.ok || !interpretationRef.ok) return { ok: false };
        closed.push({
          criterionId: criterionId.value, kind: kind.value, value: scoreValue.value,
          minimum: minimum.value, maximum: maximum.value, calibrationRef: calibrationRef.value,
          interpretationRef: interpretationRef.value,
        });
      }
      return { ok: true, value: closed };
    }
    case "jsonObject":
      return isJsonObject(value) ? { ok: true, value } : { ok: false };
  }
}

export interface ClosedPayload {
  data: JsonObject;
  omittedFields: string[];
}

/** Closes a payload to its declared fields; unknown fields are reported, not serialized. */
export function closeDiagnosticPayload(
  event: DiagnosticEventName,
  data: JsonObject,
): { ok: true; value: ClosedPayload } | { ok: false; missingField: string } {
  const schema = EVENT_SCHEMAS[event];
  const closed: JsonObject = {};
  const omittedFields: string[] = [];
  for (const [field, spec] of Object.entries(schema)) {
    const value = data[field];
    if (value === undefined) return { ok: false, missingField: field };
    const result = closeScalar(spec, value);
    if (!result.ok) return { ok: false, missingField: field };
    closed[field] = result.value;
  }
  for (const field of Object.keys(data)) {
    if (!Object.hasOwn(schema, field)) omittedFields.push(`data.${field}`);
  }
  return { ok: true, value: { data: closed, omittedFields } };
}

// ---------------------------------------------------------------------------
// Bounded recent history
// ---------------------------------------------------------------------------

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function serializedBytes(record: DiagnosticRecordV1): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8") + 1;
}

const PROFILE_RANK: Record<DetailProfile, number> = { minimal: 0, standard: 1, debug: 2, trace: 3 };

/** O1 section 7 catalogue profiles, lowest ordinary selection per event. */
const EVENT_PROFILE: Record<string, DetailProfile> = {
  "quality.runtime.started": "minimal",
  "quality.runtime.retired": "minimal",
  "quality.config.applied": "minimal",
  "quality.config.rejected": "minimal",
  "quality.check.started": "minimal",
  "quality.check.settled": "minimal",
  "quality.policy.decided": "minimal",
  "quality.action.admission": "minimal",
  "quality.action.dispatched": "minimal",
  "quality.action.receipt": "minimal",
  "quality.budget.denied": "minimal",
  "quality.usage.summary": "minimal",
  "quality.observation.gap": "minimal",
  "quality.journal.opened": "minimal",
  "quality.journal.closed": "minimal",
  "quality.sink.health": "minimal",
  "quality.diagnostic.gap": "minimal",
  "quality.diagnostic.omitted": "minimal",
  "quality.runtime.state": "debug",
  "quality.context.freshness": "debug",
  "quality.model.preflight": "debug",
  "quality.model.usage-updated": "debug",
  "quality.model.retry-planned": "debug",
  "quality.budget.changed": "debug",
  "quality.control.checkpoint": "debug",
  "quality.clock.resynchronized": "debug",
  "quality.trigger.deadline": "trace",
  "quality.observation.accepted": "trace",
};

export class DiagnosticHistory {
  readonly #context: DiagnosticHistoryContext;
  readonly #limits: DiagnosticHistoryLimits;
  readonly #openedMonoMs = performance.now();
  readonly #records: DiagnosticRecordV1[] = [];
  #sequence = 0;
  #bytes = 0;
  #droppedRecords = 0;

  constructor(context: DiagnosticHistoryContext, limits: DiagnosticHistoryLimits) {
    this.#context = {
      observedSessionId: context.observedSessionId,
      scope: { ...context.scope },
      configRevision: context.configRevision,
      dataPolicyRevision: context.dataPolicyRevision,
      ownerId: context.ownerId,
      ...(context.currentScope === undefined ? {} : { currentScope: context.currentScope }),
    };
    this.#limits = { ...limits, detail: limits.detail ?? "standard" };
  }

  /**
   * Projects one record. Returns undefined when the payload cannot be closed;
   * the caller reports the omission instead of writing an unrepresentable
   * record. The retained history is bounded by count and serialized bytes.
   */
  append(input: DiagnosticAppendInput): DiagnosticRecordV1 | undefined {
    // Detail selection happens before sequencing: an omitted profile event is
    // an intentional selection, not a lost-record range. Material failures
    // (warn/error) and an authority-affecting operator Stop are elevated into
    // the compact minimal record set.
    const selectedRank = PROFILE_RANK[this.#limits.detail ?? "standard"] ?? 1;
    const eventRank = PROFILE_RANK[EVENT_PROFILE[input.event] ?? "standard"] ?? 1;
    const elevated = input.level === "warn" || input.level === "error"
      || (input.event === "quality.runtime.state" && input.data["operatorStopped"] === true);
    if (eventRank > selectedRank && !elevated) return undefined;
    const closed = closeDiagnosticPayload(input.event, input.data);
    if (!closed.ok) {
      this.#droppedRecords += 1;
      return undefined;
    }
    this.#sequence += 1;
    const record = this.#project(input, closed.value);
    const bytes = serializedBytes(record);
    if (bytes > this.#limits.maxRecordBytes) {
      this.#droppedRecords += 1;
      return undefined;
    }
    this.#records.push(record);
    this.#bytes += bytes;
    while (this.#records.length > this.#limits.maxEvents || this.#bytes > this.#limits.maxBytes) {
      const removed = this.#records.shift();
      if (removed === undefined) break;
      this.#bytes -= serializedBytes(removed);
      this.#droppedRecords += 1;
    }
    return record;
  }

  /** A detached snapshot; retained records are frozen and never re-projected. */
  records(): readonly DiagnosticRecordV1[] {
    return this.#records.slice();
  }

  get recordCount(): number {
    return this.#records.length;
  }

  get byteLength(): number {
    return this.#bytes;
  }

  get droppedRecords(): number {
    return this.#droppedRecords;
  }

  #project(input: DiagnosticAppendInput, closed: ClosedPayload): DiagnosticRecordV1 {
    const recordedAt = new Date().toISOString();
    const monoMs = Math.max(0, Math.round(performance.now() - this.#openedMonoMs));
    const correlation: DiagnosticCorrelation = {
      runId: null,
      rootRunId: null,
      parentRunId: null,
      operationId: null,
      attemptId: null,
      actionId: null,
      reviewerSessionId: null,
      ...input.correlation,
    };
    const projection: DiagnosticProjection = {
      metadataTruncated: closed.omittedFields.length > 0,
      omittedFields: closed.omittedFields,
      omittedItems: 0,
      captureRefs: [],
    };
    const record: DiagnosticRecordV1 = {
      schemaVersion: 1,
      eventId: randomUUID(),
      sequence: this.#sequence,
      event: input.event,
      observedSessionId: this.#context.observedSessionId,
      fields: {
        time: { recordedAt, monoMs, occurredAt: null },
        scope: { ...(this.#context.currentScope?.() ?? this.#context.scope) },
        origin: { kind: "engine", ownerId: input.ownerId ?? this.#context.ownerId, parentOperationId: null },
        correlation,
        level: input.level,
        detail: "standard",
        configRevision: this.#context.configRevision,
        dataPolicyRevision: this.#context.dataPolicyRevision,
        reasonCodes: [...input.reasonCodes],
        data: closed.data,
        projection,
      },
    };
    return deepFreeze(record);
  }
}
