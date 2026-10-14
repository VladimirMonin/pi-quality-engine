// Implemented public C1 declarations. This module is inert: importing it performs
// no file access, starts no timer, loads no credential and creates no session.
//
// Only the subset actually implemented by this package is declared here. The full
// proposed C1 SDK in Document 02 remains the contract; unimplemented families are
// reported as unavailable by runtime status rather than declared as working stubs.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export type JsonSchema = boolean | JsonObject;
export type MaybePromise<T> = T | Promise<T>;

export interface ContractError {
  code: string;
  retryable: boolean;
  field?: string;
  details?: JsonObject;
}

export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: ContractError };

export interface ResourceRef {
  uri: string;
}

// ---------------------------------------------------------------------------
// Functional C1 identity and observation data
// ---------------------------------------------------------------------------

export interface Scope {
  observedSessionId: string;
  branchId: string;
  runtimeGeneration: string;
  episodeId: string | null;
  authorizationRevision: string;
}

export interface RunRef {
  runId: string;
  checkId: string;
  checkRevision: string;
  rootRunId: string;
  parentRunId: string | null;
  escalationDepth: number;
  scope: Scope;
}

export type OriginKind = "operator" | "primary" | "owned-reviewer" | "engine" | "external";

export interface Origin {
  kind: OriginKind;
  ownerId: string;
  parentOperationId: string | null;
}

export interface ObservationDraft {
  externalId: string | null;
  kind: string;
  occurredAt: string;
  visibility: "complete" | "partial" | "unknown";
  facts: JsonObject;
  evidenceIds: readonly string[];
}

export interface Observation extends ObservationDraft {
  schemaVersion: 1;
  id: string;
  sequence: number;
  scope: Scope;
  origin: Origin;
  receivedMonoMs: number;
}

export type ExecutionState =
  | "idle" | "model-active" | "tools-active" | "retrying"
  | "compacting" | "interrupted" | "shutdown" | "unknown";

export type WorkState =
  | "work-expected" | "waiting-dependency" | "waiting-operator"
  | "completion-candidate" | "complete" | "unknown";

export interface WaitRecord {
  id: string;
  ownerId: string;
  operationId: string | null;
  state: "pending" | "satisfied" | "failed" | "unknown";
  reviewDueMonoMs: number | null;
  lastObservationId: string;
}

export interface RuntimeView {
  scope: Scope;
  execution: ExecutionState;
  work: WorkState;
  operatorStopped: boolean;
  observerPaused: boolean;
  outstandingWork: "supported" | "none" | "unknown";
  activePrimaryOperations: readonly string[];
  waits: readonly WaitRecord[];
  lastActivityMonoMs: number | null;
  lastProgressMonoMs: number | null;
  lastCompletionMonoMs: number | null;
  progressEvidenceIds: readonly string[];
  counters: {
    completedPrimaryTools: number;
    completedPrimaryCycles: number;
    primaryEvidenceRevision: number;
    completionBoundaries: number;
  };
}

export interface ClockReading {
  utc: string;
  monoMs: number;
}

export interface DiagnosticNote {
  code: string;
  refs?: readonly string[];
  counts?: Readonly<Record<string, number | boolean | null>>;
}

export interface DiagnosticWriter {
  note(note: DiagnosticNote): void;
}

export interface LifecycleContext {
  scope: Scope;
  signal: AbortSignal;
  clock(): ClockReading;
  diagnostics: DiagnosticWriter;
}

export interface DisposableComponent {
  dispose?(): MaybePromise<void>;
}

// ---------------------------------------------------------------------------
// Component and registration contracts (implemented roles only)
// ---------------------------------------------------------------------------

export type ComponentKind =
  | "observation" | "trigger" | "context" | "prompt"
  | "evaluator" | "policy" | "action" | "sink";

export interface ComponentMeta {
  id: string;
  apiMajor: 1;
  optionsSchema: JsonSchema;
  requiredCapabilities: readonly string[];
  diagnosticCodes: readonly string[];
}

export interface TriggerReason {
  code: string;
  evidenceIds: readonly string[];
}

export interface TriggerInput {
  cause: "observation" | "deadline" | "activation" | "restoration";
  observation: Observation | null;
  now: ClockReading;
  view: RuntimeView;
  state: JsonObject;
}

export interface TriggerUpdate {
  state: JsonObject;
  intent: { reasons: readonly TriggerReason[] } | null;
  nextDueMonoMs: number | null;
}

export interface TriggerDefinition extends ComponentMeta {
  kind: "trigger";
  initialState(options: JsonObject): JsonObject;
  update(options: JsonObject, input: TriggerInput): TriggerUpdate;
}

export type MaterialRole = "task" | "requirement" | "evidence" | "reference" | "prior-finding";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "json"; value: Json }
  | { type: "image"; artifactId: string; mimeType: string; width: number; height: number };

export type ProvenanceSelection =
  | { kind: "full" }
  | { kind: "lines"; start: number; end: number }
  | { kind: "sections"; headings: readonly string[] }
  | { kind: "derived"; inputIds: readonly string[]; method: string };

export interface Provenance {
  sourceId: string;
  uri: string;
  revision: string;
  acquiredAt: string;
  selection: ProvenanceSelection;
  changedDuringRead: boolean;
}

export interface ContextItem {
  id: string;
  role: MaterialRole;
  required: boolean;
  content: readonly ContentBlock[];
  provenance: Provenance;
  bytes: number;
  tokenEstimate: { count: number; method: string } | null;
}

export interface CoverageIssue {
  sourceId: string;
  reason: string;
  required: boolean;
  evidenceIds: readonly string[];
}

export interface Coverage {
  state: "complete" | "partial" | "insufficient";
  scopeDescription: string;
  issues: readonly CoverageIssue[];
}

export interface EvidenceDependency {
  evidenceId: string;
  revision: string;
  relevance: "authority" | "conclusion" | "supporting";
  check: "content-fingerprint" | "host-cursor" | "external-revision" | "unknown";
}

export interface ContextBatch {
  items: readonly ContextItem[];
  coverage: Coverage;
  dependencies: readonly EvidenceDependency[];
}

export interface ContextSnapshot extends ContextBatch {
  snapshotId: string;
  run: RunRef;
  assembledAt: string;
  manifestId: string;
}

export interface ModelRequest {
  runId: string;
  profileId: string;
  kind: "classifier" | "chat";
  context: ContextSnapshot;
  assessment: AssessmentResources;
  maxOutputTokens: number;
}

export interface ModelResponse {
  attemptIds: readonly string[];
  actualModel: { provider: string; id: string; revision: string | null };
  output: Json;
}

export interface EvaluationServices {
  request(input: ModelRequest, signal: AbortSignal): Promise<Result<ModelResponse>>;
}

export interface EvidenceAccess {
  readSource(sourceId: string, signal: AbortSignal): Promise<Result<ContextBatch>>;
  recentObservations(limit: number): readonly Observation[];
  readPermittedFile(path: string, signal: AbortSignal): Promise<Result<ContextBatch>>;
}

export interface ContextProviderContext extends LifecycleContext {
  run: RunRef;
  view: RuntimeView;
  evidence: EvidenceAccess;
  models: Pick<EvaluationServices, "request">;
}

export interface ContextDefinition extends ComponentMeta {
  kind: "context";
  produces: readonly ("text" | "json" | "image")[];
  collect(options: JsonObject, ctx: ContextProviderContext): Promise<Result<ContextBatch>>;
}

export type DecisionQuestion =
  | { type: "bool"; instructions: string; criteria: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Readonly<Record<string, string>> }
  | { type: "score"; instructions: string; criteria: readonly string[] };

export interface AssessmentResources {
  resourceRevision: string;
  instructions: readonly ContextItem[];
  questions: Readonly<Record<string, DecisionQuestion>> | null;
  resultSchema: JsonSchema;
  criteria: readonly string[];
}

export interface PromptContext extends LifecycleContext {
  run: RunRef;
  view: RuntimeView;
  evidence: EvidenceAccess;
  models: Pick<EvaluationServices, "request">;
}

export interface PromptDefinition extends ComponentMeta {
  kind: "prompt";
  build(options: JsonObject, ctx: PromptContext): Promise<Result<AssessmentResources>>;
}

export type Severity = "info" | "concern" | "critical";

export interface AssessmentScore {
  criterion: string;
  kind: "probability" | "ordinal" | "numeric" | "self-reported-confidence";
  value: number;
  minimum: number;
  maximum: number;
  interpretation: string;
  calibrationRef: string | null;
}

export interface Finding {
  id: string;
  criterion: string;
  status: "suspected" | "supported";
  severity: Severity;
  requirementRefs: readonly string[];
  evidenceIds: readonly string[];
  affectedItems: readonly string[];
  defectCode: string;
  explanation: string;
  proposedCorrection: string | null;
  limitations: readonly string[];
}

export interface WorkInterpretation {
  proposedState: WorkState;
  outstandingWork: "supported" | "none" | "unknown";
  evidenceIds: readonly string[];
  rationale: string;
}

export interface AssessmentResult {
  operational: "completed" | "unavailable" | "failed" | "cancelled";
  coverage: Coverage;
  conclusion: "no-supported-finding" | "findings" | "conflicting-requirements" | "undetermined";
  findings: readonly Finding[];
  scores: readonly AssessmentScore[];
  additionalEvidence: readonly ContextItem[];
  dependencies: readonly EvidenceDependency[];
  usageAttemptIds: readonly string[];
  workInterpretation?: WorkInterpretation;
  extensions?: Readonly<Record<string, Json>>;
  error?: ContractError;
}

export interface EvaluationInput {
  run: RunRef;
  context: ContextSnapshot;
  assessment: AssessmentResources;
  modelProfileId: string | null;
}

export interface EvaluatorContext extends LifecycleContext {
  run: RunRef;
  services: EvaluationServices;
}

export interface EvaluatorDefinition extends ComponentMeta {
  kind: "evaluator";
  mechanism: "deterministic" | "direct-model" | "pi-session" | "external";
  accepts: readonly ("text" | "json" | "image")[];
  resultExtensions?: Readonly<Record<string, JsonSchema>>;
  evaluate(options: JsonObject, input: EvaluationInput, ctx: EvaluatorContext): Promise<AssessmentResult>;
}

export interface ActionProposal {
  localId: string;
  action: string;
  options: JsonObject;
  findingIds: readonly string[];
  evidenceIds: readonly string[];
  reasonCode: string;
}

export interface PolicyDecision {
  outcome: "no-action" | "propose";
  reasonCode: string;
  actions: readonly ActionProposal[];
}

export interface PolicyInput {
  run: RunRef;
  result: AssessmentResult;
  view: RuntimeView;
  freshness: "current" | "stale" | "unknown";
  previouslyDeliveredFindingIds: readonly string[];
  mode: "observe" | "advise";
}

export interface PolicyDefinition extends ComponentMeta {
  kind: "policy";
  decide(options: JsonObject, input: PolicyInput): PolicyDecision;
}

export type RegisteredComponentDefinition =
  | TriggerDefinition
  | ContextDefinition
  | PromptDefinition
  | EvaluatorDefinition
  | PolicyDefinition;

export interface PackageDefinition {
  id: string;
  version: string;
  baseUri: string;
  components: readonly RegisteredComponentDefinition[];
  resources: Readonly<Record<string, ResourceRef>>;
  prepare?: (ctx: LifecycleContext) => Promise<void>;
}

export interface PackageRegistration {
  registrationId: string;
  generation: string;
  ready: Promise<Result<void>>;
  dispose(): Promise<void>;
}

export interface RegistryEndpoint {
  apiMajor: 1;
  engineGeneration: string;
  observedSessionId: string;
  register(definition: PackageDefinition): Result<PackageRegistration>;
}

export interface RegistryQuery {
  apiMajor: 1;
  observedSessionId: string;
  reply(endpoint: RegistryEndpoint): void;
}

export const REGISTRY_AVAILABLE_CHANNEL = "quality.registry.available.v1";
export const REGISTRY_QUERY_CHANNEL = "quality.registry.query.v1";

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

export interface JournalSettings {
  enabled: boolean;
  directory: string;
  maxFileBytes: number;
  rotationIntervalMs: number | null;
  compressArchives: boolean;
}

export interface RetentionSettings {
  maxArchivesPerSession: number;
  maxAgeMs: number;
  maxStorageBytes: number;
}

export interface RuntimeSettings {
  maxConcurrentEvaluations: number;
  maxPendingChecks: number;
  maxEvidenceBytes: number;
  defaultRunTimeoutMs: number;
  maxRunTimeoutMs: number;
  componentInitTimeoutMs: number;
  componentStopTimeoutMs: number;
}

export interface PermissionSettings {
  modelProfiles: readonly string[];
  actions: readonly string[];
}

export interface PromptBinding {
  use: string;
  options: JsonObject;
}

export interface ContextProviderBinding {
  id: string;
  use: string;
  options: JsonObject;
}

export interface ContextPlan {
  providers: readonly ContextProviderBinding[];
  maxBytes: number;
  maxEstimatedTokens: number;
  reserveOutputTokens: number;
  requiredCoverage: "complete" | "partial";
  overflow: "omit-optional" | "error";
}

export interface EvaluatorProfile {
  use: string;
  options: JsonObject;
}

export interface PolicyProfile {
  use: string;
  options: JsonObject;
}

export interface TriggerBinding {
  id: string;
  use: string;
  options: JsonObject;
}

export interface CheckDefinition {
  enabled: boolean;
  mode: "inherit" | "observe" | "advise";
  triggers: readonly TriggerBinding[];
  context: string;
  prompt: string;
  evaluator: string;
  policy: string;
  workStates: readonly WorkState[];
  priority: "low" | "normal" | "high";
  cooldownMs: number;
  /** Null means the effective `runtime.defaultRunTimeoutMs`. */
  timeoutMs: number | null;
  maxRunsPerEpisode: number;
  freshness: "dependencies";
  criteria: readonly string[];
  supersedes: readonly string[];
}

export type DetailProfile = "minimal" | "standard" | "debug" | "trace";

export interface ObservabilityConfiguration {
  detail: DetailProfile;
  capture: CapturePermissions;
  recentHistory: RecentHistoryLimits;
  journal: JournalSettings;
  retention: RetentionSettings;
}

export interface EngineConfiguration {
  schemaVersion: 1;
  enabled: boolean;
  mode: "observe";
  runtime: RuntimeSettings;
  permissions: PermissionSettings;
  prompts: Readonly<Record<string, PromptBinding>>;
  contexts: Readonly<Record<string, ContextPlan>>;
  evaluators: Readonly<Record<string, EvaluatorProfile>>;
  policies: Readonly<Record<string, PolicyProfile>>;
  checks: Readonly<Record<string, CheckDefinition>>;
  observability: ObservabilityConfiguration;
}

export interface ResolvedConfiguration {
  value: EngineConfiguration;
  revision: string;
  origins: readonly ConfigurationOrigin[];
  sources: ConfigurationSourceStatus;
}

// ---------------------------------------------------------------------------
// O1 diagnostic envelope subset
// ---------------------------------------------------------------------------

export type DiagnosticLevel = "info" | "warn" | "error";
export type DiagnosticDetail = "minimal" | "standard" | "debug" | "trace";
export type DiagnosticOriginKind = OriginKind;

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
  journalFlushState: "written" | "failed" | "disabled";
};

export type RuntimeStateData = {
  previousExecution: ExecutionState;
  execution: ExecutionState;
  previousWork: WorkState;
  work: WorkState;
  operatorStopped: boolean;
  observerPaused: boolean;
  evidenceRefs: string[];
};

export type ConfigAppliedData = {
  configRevision: string;
  previousRevision: string;
  dataPolicyRevision: string;
  changedFieldPaths: string[];
  captureWidened: boolean;
  destinationChanged: boolean;
  activeCheckCount: number;
};

export type ConfigRejectedData = {
  candidateRevision: string;
  fieldPaths: string[];
  errorCodes: string[];
  runtimeUnchanged: true;
};

export type ComponentLifecycleData = {
  componentId: string;
  packageId: string;
  packageVersion: string;
  registrationId: string;
  phase: "registered" | "ready" | "failed" | "disposed";
  capabilityRefs: string[];
  durationMs: number;
  errorCode: string | null;
};

export type TriggerMeasurements = {
  counter: string | null;
  value: number | null;
  threshold: number | null;
  crossedThresholds: number | null;
  elapsedMs: number | null;
  thresholdMs: number | null;
  lastActivityAgeMs: number | null;
  lastProgressAgeMs: number | null;
  activeOperationCount: number | null;
};

export type TriggerDueData = {
  checkId: string;
  checkRevision: string;
  bindingId: string;
  componentId: string;
  intentId: string;
  basis: "count" | "time" | "evidence" | "completion" | "external";
  firstDueAt: string;
  measurements: TriggerMeasurements;
  evidenceCursor: number | null;
  workEligibility: string;
};

export type CheckRequestedData = {
  checkId: string;
  checkRevision: string;
  requestSource: "trigger" | "operator" | "policy";
  intentRefs: string[];
  criterionIds: string[];
};

export type CheckAdmissionData = {
  checkId: string;
  outcome: "admitted" | "queued" | "coalesced" | "skipped" | "denied";
  runId: string | null;
  intentRefs: string[];
  mergedIntoRunId: string | null;
  queuePosition: number | null;
  reasonCodes: string[];
  coveredByCheckId: string | null;
};

export type CheckStartedData = {
  checkId: string;
  checkRevision: string;
  intentRefs: string[];
  evaluatorProfileId: string;
  policyId: string;
  configuredTimeoutMs: number;
  queueWaitMs: number;
  mode: "observe" | "advise";
};

export type SizeBoundary = "source" | "selected" | "prepared" | "sdk-input" | "transport-input"
  | "tool-result" | "captured" | "serialized-record";

export type SizeMeasurement = {
  boundary: "source" | "selected" | "prepared" | "sdk-input" | "transport-input"
    | "tool-result" | "captured" | "serialized-record";
  utf8Bytes: number | null;
  unicodeScalars: number | null;
  lines: number | null;
  estimatedTokens: { count: number; methodId: string; revision: string | null } | null;
  complete: boolean;
};

export type ComponentNoteData = {
  componentId: string;
  registrationId: string;
  code: string;
  refs: string[];
  counts: { [key: string]: number | boolean | null };
};

export type CheckSettledData = {
  operational: "completed" | "unavailable" | "failed" | "cancelled";
  conclusion: "no-supported-finding" | "findings" | "conflicting-requirements" | "undetermined";
  coverage: "complete" | "partial" | "insufficient";
  findingCount: number;
  actionCount: number;
  usageAttemptRefs: string[];
  accountingCoverage: "complete";
  durationMs: number;
  terminalReason: string;
};

export type ContextSourceData = {
  manifestId: string;
  sourceId: string;
  stage: "configured" | "retrieved" | "selected";
  resourceRefs: string[];
  required: boolean;
  selectionState: "included" | "omitted" | "unavailable" | "denied";
  sizes: SizeMeasurement[];
  omittedCount: number;
  reasonCode: string | null;
};

export type ContextManifestData = {
  manifestId: string;
  snapshotId: string;
  boundary: "assembled-context" | "prepared-request" | "sdk-input" | "transport-input";
  attemptId: string | null;
  profileId: string | null;
  parentManifestId: string | null;
  coverage: "complete" | "partial" | "insufficient";
  inputVisibility: "complete" | "partial" | "unknown";
  requiredItems: number;
  includedRequiredItems: number;
  optionalItems: number;
  includedOptionalItems: number;
  omittedItems: number;
  contentTruncated: boolean;
  manifestTruncated: boolean;
  itemCount: number;
  partCount: number;
  resourceRefs: string[];
  issueCodes: string[];
  sizes: SizeMeasurement[];
};

export type ManifestItemMetadata = {
  itemId: string;
  resourceId: string;
  sourceId: string;
  role: "task" | "requirement" | "evidence" | "reference" | "prior-finding";
  required: boolean;
  revisionRef: string;
  selection: {
    kind: "full" | "lines" | "sections" | "derived";
    ranges: Array<{ start: number; end: number }>;
    sectionRefs: string[];
    inputRefs: string[];
    methodId: string | null;
  };
  disposition: "included" | "omitted" | "unavailable" | "denied";
  changedDuringRead: boolean;
  sizes: SizeMeasurement[];
  captureRefs: string[];
};

export type ContextManifestPartData = {
  manifestId: string;
  partIndex: number;
  itemCount: number;
  items: ManifestItemMetadata[];
};

export type AssessmentFindingMetadata = {
  findingRef: string;
  responseIdRef: string;
  criterionId: string;
  status: "suspected" | "supported";
  severity: "info" | "concern" | "critical";
  defectCode: string;
  requirementRefs: string[];
  evidenceRefs: string[];
  affectedRefs: string[];
};

export type AssessmentScoreMetadata = {
  criterionId: string;
  kind: "probability" | "ordinal" | "numeric" | "self-reported-confidence";
  value: number;
  minimum: number;
  maximum: number;
  calibrationRef: string | null;
  interpretationRef: string | null;
};

export type AssessmentResultData = {
  operational: "completed" | "unavailable" | "failed" | "cancelled";
  coverage: "complete" | "partial" | "insufficient";
  conclusion: "no-supported-finding" | "findings" | "conflicting-requirements" | "undetermined";
  findings: AssessmentFindingMetadata[];
  scores: AssessmentScoreMetadata[];
  dependencyRefs: string[];
  additionalEvidenceRefs: string[];
  attemptRefs: string[];
  validationState: "valid" | "invalid";
};

export type PolicyDecidedData = {
  policyId: string;
  policyRevision: string;
  disposition: "no-action" | "record-only" | "propose" | "failed";
  findingRefs: string[];
  proposalRefs: string[];
  reasonCodes: string[];
};

export type JournalOpenedData = {
  logicalJournalId: string;
  segmentOrdinal: number;
  writerGeneration: string;
  previousSegmentOrdinal: number | null;
  openReason: "session-start" | "rotation" | "tail-repair";
  previousTailState: "absent" | "clean" | "damaged" | "unknown";
  recordPolicyRevision: string;
};

export type JournalClosedData = {
  logicalJournalId: string;
  segmentOrdinal: number;
  closeReason: string;
  recordCount: number;
  serializedBytes: number;
  flushState: "written" | "failed";
  historyCoverage: "complete" | "partial";
};

export type JournalRotationData = {
  fromSegment: number;
  toSegment: number;
  reason: "size" | "elapsed" | "close" | "tail-repair";
  thresholdBytes: number | null;
  observedBytes: number;
  archiveCompression: "none" | "gzip" | "failed";
  outcome: "completed" | "failed";
};

export type RetentionSweepData = {
  scope: "closed-journal-history";
  eligibleFiles: number;
  removedFiles: number;
  removedBytes: number;
  remainingOwnedBytes: number;
  targetBytes: number;
  overTargetReason: "none" | "active-data" | "protected-history";
  historyCoverage: "complete" | "partial";
};

export type ControlCheckpointData = {
  revision: number;
  outcome: "committed" | "failed";
  serializedBytes: number;
  durationMs: number;
  protectedStateRef: string;
};

export type DiagnosticGapData = {
  sinkId: string;
  firstLostSequence: number | null;
  lastLostSequence: number | null;
  lostCount: number;
  byEventFamily: { [key: string]: number };
  cause: string;
  exact: boolean;
};

export type SinkHealthData = {
  sinkId: string;
  previousState: "healthy" | "degraded" | "failed";
  state: "healthy" | "degraded" | "failed";
  queuedRecords: number;
  queuedBytes: number;
  lostRecords: number;
  reasonCode: string;
};

export type ClockResynchronizedData = {
  cause: string;
  overdueBindings: number;
  coalescedIntents: number;
  elapsedHistoryKnown: boolean;
};

export type TriggerDeadlineData = {
  checkId: string;
  bindingId: string;
  phase: "armed" | "rearmed" | "disarmed";
  dueMonoMs: number | null;
  delayMs: number | null;
  reasonCode: string;
};

export type DiagnosticEventName =
  | "quality.runtime.started"
  | "quality.runtime.retired"
  | "quality.runtime.state"
  | "quality.config.applied"
  | "quality.config.rejected"
  | "quality.component.lifecycle"
  | "quality.component.note"
  | "quality.trigger.due"
  | "quality.check.requested"
  | "quality.check.admission"
  | "quality.check.started"
  | "quality.check.settled"
  | "quality.context.source"
  | "quality.context.manifest"
  | "quality.context.manifest-part"
  | "quality.assessment.result"
  | "quality.policy.decided"
  | "quality.clock.resynchronized"
  | "quality.trigger.deadline"
  | "quality.journal.opened"
  | "quality.journal.closed"
  | "quality.journal.rotation"
  | "quality.retention.sweep"
  | "quality.control.checkpoint"
  | "quality.diagnostic.gap"
  | "quality.sink.health";
