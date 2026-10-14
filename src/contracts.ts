// Implemented public C1 declarations. This module is inert: importing it performs
// no file access, starts no timer, loads no credential and creates no session.
//
// Only the subset actually implemented by this package is declared here. The full
// proposed C1 SDK in Document 02 remains the contract; unimplemented families are
// reported as unavailable by runtime status rather than declared as working stubs.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export interface ContractError {
  code: string;
  retryable: boolean;
  field?: string;
  details?: JsonObject;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractError };

// ---------------------------------------------------------------------------
// Configuration subset (C1)
// ---------------------------------------------------------------------------

export type ConfigurationOrigin = "user" | "project";
export type ConfigurationFormat = "json" | "yaml";

/** Outcome of one configuration location for the current resolution. */
export type ConfigurationSourceState = "absent" | "applied" | "skipped-untrusted" | "rejected";

export interface ConfigurationSourceStatus {
  user: ConfigurationSourceState;
  project: ConfigurationSourceState;
}

export interface CapturePermissions {
  documents: "none";
  prompts: "none";
  toolDescriptions: "none";
  toolArguments: "none";
  toolResults: "none";
  modelResponses: "none";
  images: "none";
  reasoning: "none";
}

export interface RecentHistoryLimits {
  maxEvents: number;
  maxBytes: number;
}

export interface FoundationConfiguration {
  schemaVersion: 1;
  enabled: false;
  mode: "observe";
  permissions: { modelProfiles: readonly string[]; actions: readonly string[] };
  observability: {
    detail: "standard";
    capture: CapturePermissions;
    recentHistory: RecentHistoryLimits;
  };
}

export interface ResolvedConfiguration {
  value: FoundationConfiguration;
  revision: string;
  origins: readonly ConfigurationOrigin[];
  sources: ConfigurationSourceStatus;
}

// ---------------------------------------------------------------------------
// O1 diagnostic envelope subset
// ---------------------------------------------------------------------------

export type ExecutionState =
  | "idle" | "model-active" | "tools-active" | "retrying"
  | "compacting" | "interrupted" | "shutdown" | "unknown";

export type WorkState =
  | "work-expected" | "waiting-dependency" | "waiting-operator"
  | "completion-candidate" | "complete" | "unknown";

export type DiagnosticLevel = "info" | "warn" | "error";
export type DiagnosticDetail = "minimal" | "standard" | "debug" | "trace";
export type DiagnosticOriginKind = "operator" | "primary" | "owned-reviewer" | "engine" | "external";

export interface DiagnosticTime {
  recordedAt: string;
  monoMs: number;
  occurredAt: string | null;
}

export interface DiagnosticScope {
  branchId: string;
  runtimeGeneration: string;
  episodeId: string | null;
  authorizationRevision: string;
}

export interface DiagnosticOrigin {
  kind: DiagnosticOriginKind;
  ownerId: string;
  parentOperationId: string | null;
}

export interface DiagnosticCorrelation {
  runId: string | null;
  rootRunId: string | null;
  parentRunId: string | null;
  operationId: string | null;
  attemptId: string | null;
  actionId: string | null;
  reviewerSessionId: string | null;
}

export interface DiagnosticProjection {
  metadataTruncated: boolean;
  omittedFields: readonly string[];
  omittedItems: number;
  captureRefs: readonly string[];
}

export interface DiagnosticFieldsV1 {
  time: DiagnosticTime;
  scope: DiagnosticScope;
  origin: DiagnosticOrigin;
  correlation: DiagnosticCorrelation;
  level: DiagnosticLevel;
  detail: DiagnosticDetail;
  configRevision: string;
  dataPolicyRevision: string;
  reasonCodes: readonly string[];
  data: JsonObject;
  projection: DiagnosticProjection;
}

export interface DiagnosticRecordV1 {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  event: string;
  observedSessionId: string;
  fields: DiagnosticFieldsV1;
}

// Closed payloads for the event families implemented at this checkpoint.

export type RuntimeStartedData = {
  engineVersion: string;
  engineBuildRef: string;
  hostVersion: string;
  hostMode: string;
  restored: boolean;
  checkpointRevision: string;
  executionState: ExecutionState;
  workState: WorkState;
  operatorStopped: boolean;
  accountingCoverage: "complete";
};

export type RuntimeRetiredData = {
  cause: string;
  unsettledOperations: number;
  unresolvedAttempts: number;
  pendingActions: number;
  checkpointRevision: string;
  journalFlushState: "not-implemented";
};

export type ConfigRejectedData = {
  candidateRevision: string;
  fieldPaths: string[];
  errorCodes: string[];
  runtimeUnchanged: true;
};

export type DiagnosticEventName =
  | "quality.runtime.started"
  | "quality.runtime.retired"
  | "quality.config.rejected";
