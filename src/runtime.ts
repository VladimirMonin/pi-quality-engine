// One session-owned engine runtime generation.
//
// The runtime owns exactly one check-run admission path. Primary observations
// and runtime deadlines both request the same `check.run` operation; admission,
// coalescing, cooldown, the bounded queue and the record-only policy live here.
// At this checkpoint no model request, primary feedback or action is ever
// dispatched.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { admitContextItem, assembleContext, type AssembledContext } from "./context.js";
import { DEFAULT_MAX_RECORD_BYTES, DiagnosticHistory } from "./diagnostics.js";
import { loadEffectiveConfiguration } from "./configuration.js";
import type { ConfigurationRejection } from "./configuration.js";
import { SessionJournal } from "./journal.js";
import type { JournalStatus } from "./journal.js";
import { ObservationStore } from "./observation.js";
import type { ObservationSnapshot, ObservationSource } from "./observation.js";
import { ComponentRegistry } from "./registry.js";
import type { PackageInventoryEntry, ResolvedComponent } from "./registry.js";
import { Scheduler, systemClock } from "./scheduling.js";
import type { EngineClock, SchedulerDue, TriggerBinding } from "./scheduling.js";
import { everyToolsTrigger, periodicTrigger } from "./builtins/triggers.js";
import { historyProvider, taskProvider, waitsProvider } from "./builtins/contexts.js";
import { createPromptFilesProvider } from "./builtins/prompts.js";
import { repeatedToolsEvaluator } from "./builtins/evaluators.js";
import { recordOnlyPolicy } from "./builtins/policies.js";
import type {
  AssessmentFindingMetadata,
  AssessmentResources,
  AssessmentResult,
  AssessmentResultData,
  AssessmentScoreMetadata,
  CheckAdmissionData,
  CheckDefinition,
  ComponentLifecycleData,
  ComponentNoteData,
  ConfigurationOrigin,
  ConfigurationSourceStatus,
  ContextItem,
  ContextSnapshot,
  DiagnosticRecordV1,
  EvaluationServices,
  EvidenceAccess,
  ExecutionState,
  Finding,
  JsonObject,
  LifecycleContext,
  Observation,
  PackageDefinition,
  PolicyDecision,
  RegistryQuery,
  ResolvedConfiguration,
  Result,
  RunRef,
  Scope,
  TriggerReason,
  WorkState,
} from "./contracts.js";

export const ENGINE_NAME = "pi-quality-engine";
export const ENGINE_VERSION = "0.0.2";
export const ENGINE_BUILD_REF = `${ENGINE_NAME}@${ENGINE_VERSION}`;
export const DATA_POLICY_REVISION = "o1-1";

const RUNTIME_OWNER_ID = "core.runtime";
const CHECKPOINT_REVISION = "none";
const RECENT_EVENTS_IN_STATUS = 16;

const RETIRE_CAUSES = new Set(["quit", "reload", "new", "resume", "fork", "replaced"]);

let generationCounter = 0;

export interface EngineSessionInput {
  observedSessionId: string;
  branchId: string;
  agentDir: string;
  projectConfigDir: string;
  projectTrusted: boolean;
  hostVersion: string;
  hostMode: string;
  /** Built-in assessment resource root, derived from the loaded package. */
  resourcesDir: string;
  /** Clock boundary; tests may supply a controlled clock. */
  clock?: EngineClock;
  /** Registry availability notification sink used by the composition root. */
  publishRegistryEndpoint?: (endpoint: ComponentRegistry["endpoint"]) => void;
  /** Same-session control state; the composition root preserves it across reload. */
  controlState?: SessionControlState;
}

/** Minimal scoped control state that survives same-session replacement. */
export interface SessionControlState {
  operatorStopped: boolean;
}
export type PrimaryHostEvent =
  | { type: "operator-input"; text: string; source: string; occurredAt: string }
  | { type: "operator-stop"; occurredAt: string }
  | { type: "model-started"; operationId: string; provider: string; model: string; occurredAt: string }
  | { type: "model-completed"; operationId: string; outcome: "success" | "failure" | "cancelled"; occurredAt: string }
  | { type: "tool-started"; operationId: string; toolName: string; parentOperationId: string | null; occurredAt: string }
  | {
    type: "tool-completed";
    operationId: string;
    toolName: string;
    parentOperationId: string | null;
    isError: boolean;
    durationMs: number | null;
    occurredAt: string;
  }
  | { type: "cycle-completed"; cycleId: string; operationIds: string[]; occurredAt: string };

export type CapabilityState = "available" | "unavailable";

export interface EngineCapabilities {
  configurationDiscovery: CapabilityState;
  yamlAuthoring: CapabilityState;
  sessionLifecycleDiagnostics: CapabilityState;
  recentHistory: CapabilityState;
  journalFiles: CapabilityState;
  functionalStatePersistence: CapabilityState;
  componentRegistry: CapabilityState;
  triggersAndScheduling: CapabilityState;
  contextEvidence: CapabilityState;
  contextManifests: CapabilityState;
  deterministicEvaluation: CapabilityState;
  modelEvaluation: CapabilityState;
  feedbackActions: CapabilityState;
  sessionConfigurationPatch: CapabilityState;
  statusExport: CapabilityState;
}

export interface CheckStatusSummary {
  checkId: string;
  enabled: boolean;
  state: "active" | "waiting" | "disabled";
  missing: string[];
  runs: number;
  lastOutcome: string | null;
  pendingIntent: boolean;
}

export interface EngineStatus {
  engine: { name: string; version: string; buildRef: string };
  runtime: {
    state: "active" | "retired" | "inactive";
    generation: string | null;
    startedAt: string | null;
    retiredAt: string | null;
    hostVersion: string;
    hostMode: string;
    executionState: ExecutionState;
    workState: WorkState;
    restored: boolean;
    checkpointRevision: string;
    operatorStopped: boolean;
    accountingCoverage: "complete";
  };
  configuration: {
    enabled: boolean;
    mode: "observe";
    revision: string;
    origins: readonly ConfigurationOrigin[];
    sources: ConfigurationSourceStatus;
    recentHistory: { maxEvents: number; maxBytes: number };
    rejection: { origin: ConfigurationOrigin; errorCode: string; field: string } | null;
  };
  activation: {
    coldActivation: "disabled" | "enabled";
    autonomousModelCalls: "unavailable";
    checkExecution: "available" | "unavailable";
    modelEvaluation: "unavailable";
    feedbackActions: "unavailable";
  };
  capabilities: EngineCapabilities;
  checks: {
    total: number;
    active: number;
    waiting: number;
    runs: number;
    pendingIntents: number;
    suppressedReasons: Record<string, number>;
    detail: CheckStatusSummary[];
  };
  observation: {
    completedPrimaryTools: number;
    completedPrimaryCycles: number;
    activeOperations: number;
    waits: number;
    lastActivityAt: string | null;
    lastProgressAt: string | null;
    rejectedObservations: number;
  };
  registry: { packages: PackageInventoryEntry[] };
  journal: JournalStatus | null;
  diagnostics: {
    detail: "standard";
    capture: "none";
    historyRecords: number;
    historyBytes: number;
    droppedRecords: number;
    recentEvents: DiagnosticRecordV1[];
  };
}

const CAPABILITY_STATES: EngineCapabilities = {
  configurationDiscovery: "available",
  yamlAuthoring: "available",
  sessionLifecycleDiagnostics: "available",
  recentHistory: "available",
  journalFiles: "available",
  functionalStatePersistence: "unavailable",
  componentRegistry: "available",
  triggersAndScheduling: "available",
  contextEvidence: "available",
  contextManifests: "available",
  deterministicEvaluation: "available",
  modelEvaluation: "unavailable",
  feedbackActions: "unavailable",
  sessionConfigurationPatch: "unavailable",
  statusExport: "unavailable",
};

/**
 * Truthful execution observation: the host reports whether the primary is idle.
 * Busy primary work cannot be classified further without a richer adapter.
 */
export function observedExecutionState(hostIdle: boolean): ExecutionState {
  return hostIdle ? "idle" : "unknown";
}

interface StatusHistoryView {
  records: readonly DiagnosticRecordV1[];
  recordCount: number;
  byteLength: number;
  droppedRecords: number;
}

interface StatusParts {
  runtimeState: "active" | "retired" | "inactive";
  generation: string | null;
  startedAt: string | null;
  retiredAt: string | null;
  executionState: ExecutionState;
  workState: WorkState;
  operatorStopped: boolean;
  hostVersion: string;
  hostMode: string;
  resolved: ResolvedConfiguration;
  rejection: ConfigurationRejection | null;
  history: StatusHistoryView | null;
  checks: EngineStatus["checks"];
  observation: EngineStatus["observation"];
  registry: PackageInventoryEntry[];
  journal: JournalStatus | null;
}

function buildStatus(parts: StatusParts): EngineStatus {
  const records = parts.history?.records.slice(-RECENT_EVENTS_IN_STATUS) ?? [];
  return {
    engine: { name: ENGINE_NAME, version: ENGINE_VERSION, buildRef: ENGINE_BUILD_REF },
    runtime: {
      state: parts.runtimeState,
      generation: parts.generation,
      startedAt: parts.startedAt,
      retiredAt: parts.retiredAt,
      hostVersion: parts.hostVersion,
      hostMode: parts.hostMode,
      executionState: parts.executionState,
      workState: parts.workState,
      restored: false,
      checkpointRevision: CHECKPOINT_REVISION,
      operatorStopped: parts.operatorStopped,
      accountingCoverage: "complete",
    },
    configuration: {
      enabled: parts.resolved.value.enabled,
      mode: "observe",
      revision: parts.resolved.revision,
      origins: [...parts.resolved.origins],
      sources: { ...parts.resolved.sources },
      recentHistory: { ...parts.resolved.value.observability.recentHistory },
      rejection: parts.rejection === null ? null : {
        origin: parts.rejection.origin,
        errorCode: parts.rejection.error.code,
        field: parts.rejection.error.field ?? "$",
      },
    },
    activation: {
      coldActivation: parts.resolved.value.enabled ? "enabled" : "disabled",
      autonomousModelCalls: "unavailable",
      checkExecution: parts.resolved.value.enabled ? "available" : "unavailable",
      modelEvaluation: "unavailable",
      feedbackActions: "unavailable",
    },
    capabilities: { ...CAPABILITY_STATES },
    checks: parts.checks,
    observation: parts.observation,
    registry: { packages: parts.registry },
    journal: parts.journal,
    diagnostics: {
      detail: "standard",
      capture: "none",
      historyRecords: parts.history?.recordCount ?? 0,
      historyBytes: parts.history?.byteLength ?? 0,
      droppedRecords: parts.history?.droppedRecords ?? 0,
      recentEvents: records,
    },
  };
}

function normalizeRetireCause(cause: string): string {
  return RETIRE_CAUSES.has(cause) ? cause : "unknown";
}

function nowIso(clock: EngineClock): string {
  return clock.nowUtc();
}

interface PendingIntent {
  intentId: string;
  reasons: TriggerReason[];
  bindingIds: string[];
  firstDueAt: string;
  evidenceCursor: number | null;
}

interface ActiveRun {
  runId: string;
  checkId: string;
  runRef: RunRef;
  intentRefs: string[];
  criterionIds: readonly string[];
  startedAt: string;
  startedMonoMs: number;
  configRevision: string;
}

interface SettledAssessment {
  result: AssessmentResult;
  validationState: "valid" | "invalid";
  terminalReason: string;
  findingCount: number;
}

const COVERAGE_STRENGTH: Record<"complete" | "partial" | "insufficient", number> = {
  complete: 2,
  partial: 1,
  insufficient: 0,
};

const BOUNDED_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const DEFECT_CODE_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Descriptor-only read: accessors and missing properties yield undefined. */
function readData(container: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
}

type FieldRead = { kind: "absent" } | { kind: "accessor" } | { kind: "data"; value: unknown };

/** Descriptor-only read that distinguishes absent/accessor/data for mandatory fields. */
function readField(container: object, key: string): FieldRead {
  const descriptor = Object.getOwnPropertyDescriptor(container, key);
  if (descriptor === undefined) return { kind: "absent" };
  return "value" in descriptor ? { kind: "data", value: descriptor.value } : { kind: "accessor" };
}

/**
 * Descriptor-only array read. An absent or accessor field returns null so a
 * mandatory array can never be manufactured as an empty default.
 */
function readArray(container: object, key: string, max: number): unknown[] | null {
  const value = readData(container, key);
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length > max) return null;
  const items: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor)) return null;
    items.push(descriptor.value);
  }
  return items;
}

function boundedId(value: unknown, fallback: string): string {
  return typeof value === "string" && BOUNDED_ID_PATTERN.test(value) ? value : fallback;
}

function invalidAssessmentResult(reasonCode: string): AssessmentResult {
  return {
    operational: "failed",
    coverage: { state: "insufficient", scopeDescription: "Evaluator result rejected at the validation boundary.", issues: [{ sourceId: "core.runtime", reason: reasonCode, required: true, evidenceIds: [] }] },
    conclusion: "undetermined",
    findings: [],
    scores: [],
    additionalEvidence: [],
    dependencies: [],
    usageAttemptIds: [],
  };
}

interface CheckRuntimeState {
  checkId: string;
  state: "active" | "waiting" | "disabled";
  missing: string[];
  runs: number;
  lastOutcome: string | null;
  lastAdmittedMonoMs: number | null;
}

export class EngineSession {
  static async start(input: EngineSessionInput & { hostIdleAtStart: boolean }): Promise<EngineSession> {
    const loaded = await loadEffectiveConfiguration({
      agentDir: input.agentDir,
      projectConfigDir: input.projectConfigDir,
      projectTrusted: input.projectTrusted,
    });
    const session = new EngineSession(input, input.hostIdleAtStart, loaded.resolved, loaded.rejection);
    await session.#activate();
    return session;
  }

  readonly #input: EngineSessionInput;
  readonly #configuration: ResolvedConfiguration;
  readonly #rejection: ConfigurationRejection | null;
  readonly #history: DiagnosticHistory;
  readonly #store: ObservationStore;
  readonly #clock: EngineClock;
  readonly #scheduler: Scheduler;
  readonly #registry: ComponentRegistry;
  #journal: SessionJournal | null = null;
  #journalFailureReported = false;
  readonly #generation = `gen-${++generationCounter}`;
  readonly #startedAt: string;
  #retiredAt: string | null = null;
  #state: "active" | "retired" = "active";
  #scope: Scope;
  #activationReady = false;

  readonly #checkStates = new Map<string, CheckRuntimeState>();
  readonly #pendingIntents = new Map<string, PendingIntent>();
  readonly #activeRuns = new Map<string, ActiveRun>();
  readonly #suppressedReasons = new Map<string, number>();
  #runCounter = 0;
  #intentCounter = 0;
  #rejectedObservations = 0;
  readonly #acceptedIdentities = new Set<string>();
  readonly #acceptedIdentityOrder: string[] = [];
  /** Owned model-attempt identities; empty until a model service issues them. */
  readonly #issuedAttemptIds = new Set<string>();
  readonly #builtinRevisionCache = new Map<string, string | null>();

  private constructor(
    input: EngineSessionInput,
    hostIdleAtStart: boolean,
    configuration: ResolvedConfiguration,
    rejection: ConfigurationRejection | null,
  ) {
    this.#input = { ...input };
    this.#configuration = configuration;
    this.#rejection = rejection;
    this.#clock = input.clock ?? systemClock();
    this.#startedAt = nowIso(this.#clock);
    this.#acceptedIdentities.add(configuration.revision);
    this.#scope = {
      observedSessionId: input.observedSessionId,
      branchId: input.branchId,
      runtimeGeneration: this.#generation,
      episodeId: null,
      authorizationRevision: "auth-0",
    };
    this.#store = new ObservationStore(this.#scope);
    if (input.controlState?.operatorStopped === true) this.#store.markOperatorStopped();
    this.#history = new DiagnosticHistory({
      observedSessionId: input.observedSessionId,
      scope: this.#scope,
      configRevision: configuration.revision,
      dataPolicyRevision: DATA_POLICY_REVISION,
      ownerId: RUNTIME_OWNER_ID,
    }, {
      maxEvents: configuration.value.observability.recentHistory.maxEvents,
      maxBytes: configuration.value.observability.recentHistory.maxBytes,
      maxRecordBytes: DEFAULT_MAX_RECORD_BYTES,
    });
    this.#scheduler = new Scheduler(this.#clock, {
      onTriggerDue: due => this.#handleTriggerDue(due),
      onAdmissionDue: checkId => this.#attemptAdmission(checkId),
      onTriggerDisabled: (checkId, _bindingId, componentId, reasonCode) => {
        this.#noteSuppressed(reasonCode);
        this.#emit({
          event: "quality.check.admission",
          level: "warn",
          reasonCodes: [reasonCode],
          data: {
            checkId,
            outcome: "skipped",
            runId: null,
            intentRefs: [],
            mergedIntoRunId: null,
            queuePosition: null,
            reasonCodes: [reasonCode],
            coveredByCheckId: null,
          },
          correlation: { operationId: componentId },
        });
      },
    }, () => this.#store.view());
    this.#registry = new ComponentRegistry({
      scope: this.#scope,
      generation: this.#generation,
      initTimeoutMs: configuration.value.runtime.componentInitTimeoutMs,
      lifecycle: data => this.#handleComponentLifecycle(data),
      emitNote: note => this.#emitComponentNote(note),
      acceptsReference: reference => this.#acceptsReference(reference),
    });

    if (rejection !== null) {
      this.#emit({
        event: "quality.config.rejected",
        level: "warn",
        reasonCodes: [],
        data: {
          candidateRevision: rejection.candidateRevision,
          fieldPaths: [rejection.error.field ?? "$"],
          errorCodes: [rejection.error.code],
          runtimeUnchanged: true,
        },
      });
    }
    if (configuration.value.enabled && configuration.value.observability.journal.enabled) {
      try {
        this.#journal = SessionJournal.open({
          directory: join(input.agentDir, "quality", "logs"),
          observedSessionId: input.observedSessionId,
          writerGeneration: this.#generation,
          maxFileBytes: configuration.value.observability.journal.maxFileBytes,
          recordPolicyRevision: configuration.revision,
        });
      } catch {
        this.#journal = null;
      }
    }
    if (this.#journal !== null) {
      this.#emit({
        event: "quality.journal.opened",
        level: "info",
        reasonCodes: [],
        data: {
          logicalJournalId: this.#journal.logicalJournalId,
          segmentOrdinal: 0,
          writerGeneration: this.#generation,
          previousSegmentOrdinal: null,
          openReason: "session-start",
          previousTailState: this.#journal.previousTailState,
          recordPolicyRevision: this.#configuration.revision,
        },
      });
    }
    this.#emit({
      event: "quality.runtime.started",
      level: "info",
      reasonCodes: [],
      data: {
        engineVersion: ENGINE_VERSION,
        engineBuildRef: ENGINE_BUILD_REF,
        hostVersion: input.hostVersion,
        hostMode: input.hostMode,
        restored: false,
        checkpointRevision: CHECKPOINT_REVISION,
        executionState: observedExecutionState(hostIdleAtStart),
        workState: input.controlState?.operatorStopped === true ? "waiting-operator" : "unknown",
        operatorStopped: input.controlState?.operatorStopped === true,
        accountingCoverage: "complete",
      },
    });
  }

  get generation(): string {
    return this.#generation;
  }

  get state(): "active" | "retired" {
    return this.#state;
  }

  get endpoint(): ComponentRegistry["endpoint"] {
    return this.#registry.endpoint;
  }

  // -------------------------------------------------------------------------
  // Activation
  // -------------------------------------------------------------------------

  async #activate(): Promise<void> {
    if (!this.#configuration.value.enabled) {
      this.#emit({
        event: "quality.config.applied",
        level: "info",
        reasonCodes: ["core.cold-inactive"],
        data: {
          configRevision: this.#configuration.revision,
          previousRevision: this.#configuration.revision,
          dataPolicyRevision: DATA_POLICY_REVISION,
          changedFieldPaths: [],
          captureWidened: false,
          destinationChanged: false,
          activeCheckCount: 0,
        },
      });
      this.#activationReady = true;
      return;
    }
    const builtins: PackageDefinition = {
      id: "core.builtins",
      version: ENGINE_VERSION,
      baseUri: "builtin:core",
      components: [
        everyToolsTrigger,
        periodicTrigger,
        taskProvider,
        historyProvider,
        waitsProvider,
        createPromptFilesProvider(this.#input.resourcesDir),
        repeatedToolsEvaluator,
        recordOnlyPolicy,
      ],
      resources: { "builtin:repetition-v1.md": { uri: "builtin:repetition-v1.md" } },
    };
    const registered = this.#registry.register(builtins);
    if (registered.ok) await registered.value.ready;
    this.#emit({
      event: "quality.config.applied",
      level: "info",
      reasonCodes: [],
      data: {
        configRevision: this.#configuration.revision,
        previousRevision: this.#configuration.revision,
        dataPolicyRevision: DATA_POLICY_REVISION,
        changedFieldPaths: [],
        captureWidened: false,
        destinationChanged: false,
        activeCheckCount: this.#activeCheckCount(),
      },
    });
    this.#activateChecks();
    this.#activationReady = true;
    this.#input.publishRegistryEndpoint?.(this.#registry.endpoint);
  }

  #activeCheckCount(): number {
    return [...this.#checkStates.values()].filter(state => state.state === "active").length;
  }

  #activateChecks(): void {
    for (const [checkId, check] of Object.entries(this.#configuration.value.checks)) {
      const existing = this.#checkStates.get(checkId);
      if (!check.enabled) {
        this.#scheduler.unregisterCheck(checkId);
        this.#checkStates.set(checkId, {
          checkId, state: "disabled", missing: [], runs: existing?.runs ?? 0,
          lastOutcome: existing?.lastOutcome ?? null, lastAdmittedMonoMs: existing?.lastAdmittedMonoMs ?? null,
        });
        continue;
      }
      const missing = this.#missingComponents(check, checkId);
      if (missing.length > 0) {
        // A retired dependency makes dependent checks visibly wait again.
        if (existing?.state === "active") this.#scheduler.unregisterCheck(checkId);
        this.#checkStates.set(checkId, {
          checkId, state: "waiting", missing, runs: existing?.runs ?? 0,
          lastOutcome: existing?.lastOutcome ?? null, lastAdmittedMonoMs: existing?.lastAdmittedMonoMs ?? null,
        });
        continue;
      }
      if (existing?.state === "active") continue;
      this.#acceptIdentity(checkId);
      this.#checkStates.set(checkId, {
        checkId, state: "active", missing: [], runs: existing?.runs ?? 0,
        lastOutcome: existing?.lastOutcome ?? null, lastAdmittedMonoMs: existing?.lastAdmittedMonoMs ?? null,
      });
      for (const trigger of check.triggers) {
        const resolved = this.#registry.resolve(trigger.use, trigger.options);
        if (!resolved.ok || resolved.value.kind !== "trigger") continue;
        const binding: TriggerBinding = {
          checkId,
          bindingId: trigger.id,
          componentId: trigger.use,
          definition: resolved.value.definition,
          options: trigger.options,
          eligibleWorkStates: check.workStates,
          state: resolved.value.definition.initialState(trigger.options),
          nextDueMonoMs: null,
        };
        this.#scheduler.register(binding);
      }
      this.#scheduler.activate(checkId, this.#store.view());
    }
  }

  #missingComponents(check: CheckDefinition, checkId: string): string[] {
    const missing: string[] = [];
    const plan = this.#configuration.value.contexts[check.context];
    if (plan === undefined) missing.push(`context:${check.context}`);
    else {
      for (const provider of plan.providers) {
        if (!this.#registry.resolve(provider.use, provider.options).ok) missing.push(`context:${provider.use}`);
      }
    }
    const prompt = this.#configuration.value.prompts[check.prompt];
    if (prompt === undefined || !this.#registry.resolve(prompt.use, prompt.options).ok) missing.push(`prompt:${check.prompt}`);
    const evaluator = this.#configuration.value.evaluators[check.evaluator];
    if (evaluator === undefined || !this.#registry.resolve(evaluator.use, evaluator.options).ok) missing.push(`evaluator:${check.evaluator}`);
    const policy = this.#configuration.value.policies[check.policy];
    if (policy === undefined || !this.#registry.resolve(policy.use, policy.options).ok) missing.push(`policy:${check.policy}`);
    for (const trigger of check.triggers) {
      if (!this.#registry.resolve(trigger.use, trigger.options).ok) missing.push(`trigger:${checkId}:${trigger.id}`);
    }
    return missing;
  }

  #emitComponentNote(note: ComponentNoteData): void {
    if (this.#state !== "active") return;
    const counts: JsonObject = {};
    for (const [key, value] of Object.entries(note.counts)) {
      if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
        counts[key] = value;
      }
    }
    const data: JsonObject = {
      componentId: note.componentId,
      registrationId: note.registrationId,
      code: note.code,
      refs: [...note.refs].slice(0, 16),
      counts,
    };
    this.#emit({
      event: "quality.component.note",
      level: note.code === "core.invalid-note" ? "warn" : "info",
      reasonCodes: [note.code],
      data,
    });
  }

  #acceptIdentity(identity: string): void {
    if (this.#acceptedIdentities.has(identity)) return;
    this.#acceptedIdentities.add(identity);
    this.#acceptedIdentityOrder.push(identity);
    while (this.#acceptedIdentityOrder.length > 256) {
      const evicted = this.#acceptedIdentityOrder.shift();
      if (evicted !== undefined) this.#acceptedIdentities.delete(evicted);
    }
  }

  /** Accepted identities a component note may reference (O1 §6.2). */
  #acceptsReference(reference: string): boolean {
    if (reference.length === 0 || reference.length > 192) return false;
    if (this.#acceptedIdentities.has(reference)) return true;
    return this.#store.hasObservation(reference);
  }

  /**
   * Verifies a claimed builtin artifact at the owning shipped-resource
   * boundary. Only a real file with the matching content digest yields an
   * approved revision; a `builtin:` spelling alone is never trusted.
   */
  #expectedBuiltinRevision(uri: string): string | null {
    const cached = this.#builtinRevisionCache.get(uri);
    if (cached !== undefined) return cached;
    let expected: string | null = null;
    const match = /^builtin:([a-z0-9][a-z0-9.-]*\.md)$/.exec(uri);
    if (match !== null) {
      try {
        const path = join(this.#input.resourcesDir, "prompts", match[1] as string);
        const stats = statSync(path);
        if (stats.isFile() && stats.size <= 262_144) {
          const digest = createHash("sha256").update(readFileSync(path)).digest("hex").slice(0, 16);
          expected = `sha-${digest}`;
        }
      } catch {
        expected = null;
      }
    }
    this.#builtinRevisionCache.set(uri, expected);
    return expected;
  }

  #handleComponentLifecycle(data: ComponentLifecycleData): void {
    if (data.phase === "registered" || data.phase === "ready") {
      this.#acceptIdentity(data.componentId);
      this.#acceptIdentity(data.registrationId);
    }
    const historyOnly = this.#state === "retired";
    this.#emit({
      event: "quality.component.lifecycle",
      level: data.phase === "failed" ? "warn" : "info",
      reasonCodes: [],
      data: { ...data },
    }, historyOnly);
    if (this.#state === "active" && this.#activationReady
      && (data.phase === "ready" || data.phase === "disposed" || data.phase === "failed")) {
      this.#activateChecks();
    }
  }

  // -------------------------------------------------------------------------
  // Primary observations and operator actions
  // -------------------------------------------------------------------------

  handlePrimaryEvent(event: PrimaryHostEvent): void {
    if (this.#state !== "active") return;
    const previousWork = this.#store.view().work;
    if (event.type === "operator-stop") {
      this.#store.markOperatorStopped();
      this.#publish(this.#primarySource(), {
        externalId: null,
        kind: "core.operator-stopped",
        occurredAt: event.occurredAt,
        visibility: "complete",
        facts: { operationIds: [] },
        evidenceIds: [],
      });
    } else if (event.type === "operator-input") {
      // Only established operator provenance can create task authority.
      const operator = event.source === "interactive";
      this.#publish(operator ? this.#primarySource("operator") : { ownerId: "adapter.pi-input", kind: "external" }, {
        externalId: null,
        kind: "core.operator-input",
        occurredAt: event.occurredAt,
        visibility: operator ? "complete" : "partial",
        facts: operator
          ? { inputKind: "new-work", text: event.text.slice(0, 256), source: event.source }
          : { inputKind: "unclear", source: event.source },
        evidenceIds: [],
      });
    } else if (event.type === "model-started") {
      this.#publish(this.#primarySource(), {
        externalId: `model-start:${event.operationId}`,
        kind: "core.model-started",
        occurredAt: event.occurredAt,
        visibility: "complete",
        facts: { operationId: event.operationId, provider: event.provider, model: event.model },
        evidenceIds: [],
      });
    } else if (event.type === "model-completed") {
      this.#publish(this.#primarySource(), {
        externalId: `model-end:${event.operationId}`,
        kind: "core.model-completed",
        occurredAt: event.occurredAt,
        visibility: "complete",
        facts: { operationId: event.operationId, outcome: event.outcome },
        evidenceIds: [],
      });
    } else if (event.type === "tool-started") {
      this.#publish(this.#primarySource(), {
        externalId: `tool-start:${event.operationId}`,
        kind: "core.tool-started",
        occurredAt: event.occurredAt,
        visibility: "complete",
        facts: { operationId: event.operationId, toolName: event.toolName },
        evidenceIds: [],
      }, event.parentOperationId);
    } else if (event.type === "tool-completed") {
      this.#publish(this.#primarySource(), {
        externalId: `tool-end:${event.operationId}`,
        kind: "core.tool-completed",
        occurredAt: event.occurredAt,
        visibility: event.durationMs === null ? "partial" : "complete",
        facts: {
          operationId: event.operationId,
          toolName: event.toolName,
          outcome: event.isError ? "failure" : "success",
          readOnly: null,
          outputBytes: null,
          durationMs: event.durationMs,
        },
        evidenceIds: [],
      }, event.parentOperationId);
    } else if (event.type === "cycle-completed") {
      this.#publish(this.#primarySource(), {
        externalId: `cycle:${event.cycleId}`,
        kind: "core.cycle-completed",
        occurredAt: event.occurredAt,
        visibility: "complete",
        facts: { cycleId: event.cycleId, toolOperationIds: event.operationIds },
        evidenceIds: [],
      });
    }
    const work = this.#store.view().work;
    if (work !== previousWork) {
      this.#emitRuntimeState(previousWork);
    }
    this.#scheduler.observe(this.#store.view(), this.#lastAcceptedObservation());
  }

  /** Explicit operator action through the Pi command surface. */
  requestOperatorStop(): void {
    if (this.#state !== "active") return;
    const previousWork = this.#store.view().work;
    this.#store.markOperatorStopped();
    if (this.#input.controlState !== undefined) this.#input.controlState.operatorStopped = true;
    this.#emitRuntimeState(previousWork);
  }

  #publish(source: ObservationSource, draft: Parameters<ObservationStore["publish"]>[1], parentOperationId: string | null = null): void {
    const result = this.#store.publish(source, draft, {
      receivedMonoMs: this.#clock.nowMonoMs(),
      parentOperationId,
    });
    if (!result.ok) {
      this.#rejectedObservations += 1;
      return;
    }
    if (result.value.duplicate) return;
    this.#acceptIdentity(result.value.observation.id);
    this.#lastObservation = result.value.observation;
  }

  #lastObservation: Observation | null = null;

  #lastAcceptedObservation(): Observation {
    return this.#lastObservation ?? {
      schemaVersion: 1,
      id: "obs-0",
      externalId: null,
      sequence: 0,
      scope: this.#scope,
      origin: { kind: "engine", ownerId: RUNTIME_OWNER_ID, parentOperationId: null },
      kind: "core.runtime.none",
      occurredAt: this.#startedAt,
      receivedMonoMs: this.#clock.nowMonoMs(),
      visibility: "unknown",
      facts: {},
      evidenceIds: [],
    };
  }

  #primarySource(kind: "primary" | "operator" = "primary"): ObservationSource {
    return { ownerId: kind === "operator" ? "adapter.pi-operator" : "adapter.pi-primary", kind };
  }

  #emitRuntimeState(previousWork: WorkState): void {
    const view = this.#store.view();
    this.#emit({
      event: "quality.runtime.state",
      level: "info",
      reasonCodes: [],
      data: {
        previousExecution: view.execution,
        execution: view.execution,
        previousWork,
        work: view.work,
        operatorStopped: view.operatorStopped,
        observerPaused: view.observerPaused,
        evidenceRefs: [],
      },
    });
  }

  // -------------------------------------------------------------------------
  // Admission
  // -------------------------------------------------------------------------

  #handleTriggerDue(due: SchedulerDue): void {
    if (this.#state !== "active") return;
    const check = this.#configuration.value.checks[due.checkId];
    if (check === undefined) return;
    this.#emit({
      event: "quality.trigger.due",
      level: "info",
      reasonCodes: due.reasons.map(reason => reason.code),
      data: {
        checkId: due.checkId,
        checkRevision: this.#configuration.revision,
        bindingId: due.bindingId,
        componentId: due.componentId,
        intentId: this.#pendingIntentId(due),
        basis: due.basis,
        firstDueAt: due.firstDueAt,
        measurements: due.measurements as unknown as JsonObject,
        evidenceCursor: this.#store.view().counters.primaryEvidenceRevision,
        workEligibility: this.#store.view().work,
      },
      correlation: { operationId: due.bindingId },
    });
    const pending = this.#mergeIntent(due);
    this.#emit({
      event: "quality.check.requested",
      level: "info",
      reasonCodes: due.reasons.map(reason => reason.code),
      data: {
        checkId: due.checkId,
        checkRevision: this.#configuration.revision,
        requestSource: "trigger",
        intentRefs: [pending.intentId],
        criterionIds: [...check.criteria],
      },
      correlation: { operationId: pending.intentId },
    });
    this.#attemptAdmission(due.checkId);
  }

  #pendingIntentId(due: SchedulerDue): string {
    const existing = this.#pendingIntents.get(due.checkId);
    if (existing !== undefined) return existing.intentId;
    this.#intentCounter += 1;
    const intentId = `intent-${this.#intentCounter}`;
    this.#acceptIdentity(intentId);
    return intentId;
  }

  #mergeIntent(due: SchedulerDue): PendingIntent {
    const existing = this.#pendingIntents.get(due.checkId);
    if (existing !== undefined) {
      const known = new Set(existing.reasons.map(reason => reason.code));
      for (const reason of due.reasons) {
        if (!known.has(reason.code)) existing.reasons.push(reason);
      }
      if (!existing.bindingIds.includes(due.bindingId)) existing.bindingIds.push(due.bindingId);
      return existing;
    }
    const intent: PendingIntent = {
      intentId: this.#pendingIntentId(due),
      reasons: [...due.reasons],
      bindingIds: [due.bindingId],
      firstDueAt: due.firstDueAt,
      evidenceCursor: this.#store.view().counters.primaryEvidenceRevision,
    };
    this.#pendingIntents.set(due.checkId, intent);
    return intent;
  }

  #attemptAdmission(checkId: string): void {
    if (this.#state !== "active") return;
    const check = this.#configuration.value.checks[checkId];
    const pending = this.#pendingIntents.get(checkId);
    if (pending === undefined) return;
    if (check === undefined || !check.enabled) {
      this.#admit(checkId, "skipped", ["core.check-disabled"], pending);
      this.#pendingIntents.delete(checkId);
      return;
    }
    const state = this.#checkStates.get(checkId);
    if (state === undefined || state.state !== "active") {
      this.#noteSuppressed(state?.state === "disabled" ? "core.check-disabled" : "core.waiting-for-component");
      this.#admit(checkId, "skipped", [state?.state === "disabled" ? "core.check-disabled" : "core.waiting-for-component"], pending);
      return;
    }
    if (this.#store.operatorStopped) {
      this.#noteSuppressed("core.operator-stopped");
      this.#admit(checkId, "denied", ["core.operator-stopped"], pending);
      this.#pendingIntents.delete(checkId);
      return;
    }
    if (!check.workStates.includes(this.#store.view().work)) {
      // Count and time reasons still respect the check's work-state eligibility.
      this.#noteSuppressed("core.work-state-ineligible");
      this.#admit(checkId, "skipped", ["core.work-state-ineligible"], pending);
      this.#pendingIntents.delete(checkId);
      return;
    }
    if (this.#activeRuns.has(checkId)) {
      this.#admit(checkId, "coalesced", ["core.run-active"], pending, this.#activeRuns.get(checkId)?.runId ?? null);
      return;
    }
    if (state.runs >= check.maxRunsPerEpisode) {
      this.#admit(checkId, "skipped", ["core.max-runs"], pending);
      this.#pendingIntents.delete(checkId);
      return;
    }
    const nowMonoMs = this.#clock.nowMonoMs();
    const cooldownRemaining = state.lastAdmittedMonoMs === null
      ? 0
      : state.lastAdmittedMonoMs + check.cooldownMs - nowMonoMs;
    if (cooldownRemaining > 0) {
      this.#noteSuppressed("core.cooldown");
      this.#admit(checkId, "queued", ["core.cooldown"], pending);
      this.#scheduler.scheduleAdmission(checkId, nowMonoMs + cooldownRemaining);
      return;
    }
    const maxConcurrent = this.#configuration.value.runtime.maxConcurrentEvaluations;
    if (this.#activeRuns.size >= maxConcurrent) {
      this.#noteSuppressed("core.capacity");
      this.#admit(checkId, "queued", ["core.capacity"], pending);
      return;
    }
    this.#pendingIntents.delete(checkId);
    this.#admit(checkId, "admitted", [], pending);
    this.#startRun(checkId, check, pending);
  }

  #admit(
    checkId: string,
    outcome: CheckAdmissionData["outcome"],
    reasonCodes: string[],
    pending: PendingIntent,
    mergedIntoRunId: string | null = null,
  ): void {
    this.#emit({
      event: "quality.check.admission",
      level: reasonCodes.length > 0 ? "warn" : "info",
      reasonCodes,
      data: {
        checkId,
        outcome,
        runId: null,
        intentRefs: [pending.intentId],
        mergedIntoRunId,
        queuePosition: outcome === "queued" ? 0 : null,
        reasonCodes,
        coveredByCheckId: null,
      },
      correlation: { operationId: pending.intentId },
    });
  }

  #noteSuppressed(reasonCode: string): void {
    this.#suppressedReasons.set(reasonCode, (this.#suppressedReasons.get(reasonCode) ?? 0) + 1);
  }

  #startRun(checkId: string, check: CheckDefinition, pending: PendingIntent): void {
    this.#runCounter += 1;
    const runId = `run-${this.#runCounter}`;
    const run: ActiveRun = {
      runId,
      checkId,
      runRef: {
        runId,
        checkId,
        checkRevision: this.#configuration.revision,
        rootRunId: runId,
        parentRunId: null,
        escalationDepth: 0,
        scope: this.#store.view().scope,
      },
      intentRefs: [pending.intentId],
      criterionIds: [...check.criteria],
      startedAt: nowIso(this.#clock),
      startedMonoMs: this.#clock.nowMonoMs(),
      configRevision: this.#configuration.revision,
    };
    this.#acceptIdentity(runId);
    this.#acceptIdentity(pending.intentId);
    this.#activeRuns.set(checkId, run);
    const state = this.#checkStates.get(checkId);
    if (state !== undefined) state.lastAdmittedMonoMs = run.startedMonoMs;
    this.#emit({
      event: "quality.check.started",
      level: "info",
      reasonCodes: [],
      data: {
        checkId,
        checkRevision: run.configRevision,
        intentRefs: [...run.intentRefs],
        evaluatorProfileId: check.evaluator,
        policyId: check.policy,
        configuredTimeoutMs: check.timeoutMs ?? this.#configuration.value.runtime.defaultRunTimeoutMs,
        queueWaitMs: Math.max(0, run.startedMonoMs - Date.parse(pending.firstDueAt)),
        mode: "observe",
      },
      correlation: { runId: run.runId, operationId: pending.intentId },
    });
    void this.#executeRun(run, check);
  }

  async #executeRun(run: ActiveRun, check: CheckDefinition): Promise<void> {
    const context = await this.#assemble(run, check);
    if (this.#state !== "active") return;
    if (!context.ok) {
      this.#settleRun(run, {
        result: invalidAssessmentResult(context.error.code),
        validationState: "valid",
        terminalReason: context.error.code,
        findingCount: 0,
      });
      return;
    }
    const assembled = context.value;
    this.#acceptIdentity(assembled.manifest.manifestId);
    this.#acceptIdentity(assembled.snapshot.snapshotId);
    for (const instruction of assembled.resources.instructions) {
      if (this.#expectedBuiltinRevision(instruction.provenance.uri) !== null) {
        this.#acceptIdentity(instruction.provenance.uri);
      }
    }
    for (const source of assembled.providerSummaries) {
      for (const ref of source.resourceRefs) this.#acceptIdentity(ref);
      this.#emit({
        event: "quality.context.source",
        level: source.selectionState === "included" ? "info" : "warn",
        reasonCodes: source.reasonCode === null ? [] : [source.reasonCode],
        data: {
          manifestId: assembled.manifest.manifestId,
          sourceId: source.sourceId,
          stage: "selected",
          resourceRefs: [...source.resourceRefs],
          required: source.required,
          selectionState: source.selectionState,
          sizes: source.sizes,
          omittedCount: source.omittedCount,
          reasonCode: source.reasonCode,
        },
        correlation: { runId: run.runId },
      });
    }
    this.#emit({
      event: "quality.context.manifest",
      level: "info",
      reasonCodes: assembled.issueCodes,
      data: assembled.manifest as unknown as JsonObject,
      correlation: { runId: run.runId },
    });
    this.#emit({
      event: "quality.context.manifest-part",
      level: "info",
      reasonCodes: [],
      data: assembled.manifestPart as unknown as JsonObject,
      correlation: { runId: run.runId },
    });
    const settled = await this.#evaluate(run, check, assembled);
    if (this.#state !== "active") return;
    this.#settleRun(run, settled);
  }

  async #assemble(run: ActiveRun, check: CheckDefinition): Promise<Result<AssembledContext>> {
    const plan = this.#configuration.value.contexts[check.context];
    const promptBinding = this.#configuration.value.prompts[check.prompt];
    if (plan === undefined || promptBinding === undefined) {
      return { ok: false, error: { code: "core.waiting-for-component", retryable: false } };
    }
    return assembleContext({
      run: run.runRef,
      plan,
      promptBinding,
      criterionIds: run.criterionIds,
      maxEvidenceBytes: this.#configuration.value.runtime.maxEvidenceBytes,
      view: this.#store.view(),
      evidence: this.#evidenceAccess(),
      models: this.#modelsFacet(),
      hooks: {
        acceptsReasonCode: (componentId, code) => this.#registry.acceptsDiagnosticCode(componentId, code),
        isAcceptedIdentity: value => this.#acceptsReference(value),
        expectedBuiltinRevision: uri => this.#expectedBuiltinRevision(uri),
      },
      resolve: (use, options) => this.#registry.resolve(use, options),
    });
  }

  async #evaluate(run: ActiveRun, check: CheckDefinition, assembled: AssembledContext): Promise<SettledAssessment> {
    const profile = this.#configuration.value.evaluators[check.evaluator];
    const policyProfile = this.#configuration.value.policies[check.policy];
    if (profile === undefined || policyProfile === undefined) {
      return {
        result: invalidAssessmentResult("core.waiting-for-component"),
        validationState: "valid",
        terminalReason: "core.waiting-for-component",
        findingCount: 0,
      };
    }
    const resolvedEvaluator = this.#registry.resolve(profile.use, profile.options);
    if (!resolvedEvaluator.ok || resolvedEvaluator.value.kind !== "evaluator") {
      const code = resolvedEvaluator.ok ? "core.component-failed" : resolvedEvaluator.error.code;
      return {
        result: invalidAssessmentResult(code),
        validationState: "valid",
        terminalReason: code,
        findingCount: 0,
      };
    }
    let raw: unknown;
    try {
      // Dispatch exactly the normalized, measured assessment object; nothing
      // may be enlarged after the budget admission.
      const evaluatorInput = {
        run: run.runRef,
        context: assembled.snapshot,
        assessment: assembled.resources,
        modelProfileId: null,
      };
      raw = await resolvedEvaluator.value.definition.evaluate(profile.options, evaluatorInput, {
        ...resolvedEvaluator.value.lifecycle(),
        run: run.runRef,
        services: { request: this.#modelsFacet().request },
      });
    } catch {
      return {
        result: invalidAssessmentResult("core.evaluator-error"),
        validationState: "valid",
        terminalReason: "core.evaluator-error",
        findingCount: 0,
      };
    }
    if (this.#state !== "active") {
      return {
        result: invalidAssessmentResult("core.retired-generation"),
        validationState: "valid",
        terminalReason: "core.retired-generation",
        findingCount: 0,
      };
    }
    const settled = this.#validateAssessment(raw, run, assembled);
    this.#emit({
      event: "quality.assessment.result",
      level: settled.result.operational === "failed" ? "warn" : "info",
      reasonCodes: settled.validationState === "invalid" ? ["core.invalid-result"] : [],
      data: this.#projectAssessment(run, settled) as unknown as JsonObject,
      correlation: { runId: run.runId },
    });
    const resolvedPolicy = this.#registry.resolve(policyProfile.use, policyProfile.options);
    if (!resolvedPolicy.ok || resolvedPolicy.value.kind !== "policy") {
      const code = resolvedPolicy.ok ? "core.component-failed" : resolvedPolicy.error.code;
      this.#emit({
        event: "quality.policy.decided",
        level: "warn",
        reasonCodes: [code],
        data: {
          policyId: check.policy, policyRevision: run.configRevision, disposition: "failed",
          findingRefs: [], proposalRefs: [], reasonCodes: [code],
        },
        correlation: { runId: run.runId },
      });
      return settled;
    }
    let decision: PolicyDecision;
    try {
      decision = resolvedPolicy.value.definition.decide(policyProfile.options, {
        run: run.runRef,
        result: settled.result,
        view: this.#store.view(),
        freshness: "current",
        previouslyDeliveredFindingIds: [],
        mode: "observe",
      });
    } catch {
      this.#emit({
        event: "quality.policy.decided",
        level: "warn",
        reasonCodes: ["core.policy-error"],
        data: {
          policyId: check.policy, policyRevision: run.configRevision, disposition: "failed",
          findingRefs: [], proposalRefs: [], reasonCodes: ["core.policy-error"],
        },
        correlation: { runId: run.runId },
      });
      return settled;
    }
    const outcomeOk = decision.outcome === "no-action" || decision.outcome === "propose";
    const disposition = !outcomeOk
      ? "failed"
      : decision.outcome === "propose"
        ? "propose"
        : "record-only";
    const reasonCodes = outcomeOk
      ? [boundedId(decision.reasonCode, "core.policy-reason-unavailable")]
      : ["core.invalid-policy-decision"];
    this.#emit({
      event: "quality.policy.decided",
      level: disposition === "failed" ? "warn" : "info",
      reasonCodes,
      data: {
        policyId: check.policy,
        policyRevision: run.configRevision,
        disposition,
        findingRefs: settled.result.findings.slice(0, 32).map(finding => boundedId(finding.id, "finding-ref-unavailable")),
        proposalRefs: Array.isArray(decision.actions)
          ? decision.actions.slice(0, 16).map(action => boundedId(action.localId, "proposal-ref-unavailable"))
          : [],
        reasonCodes,
      },
      correlation: { runId: run.runId },
    });
    return settled;
  }

  #validateAssessment(raw: unknown, run: ActiveRun, assembled: AssembledContext): SettledAssessment {
    const invalid = (code: string): SettledAssessment => ({
      result: invalidAssessmentResult(code),
      validationState: "invalid",
      terminalReason: code,
      findingCount: 0,
    });
    if (!isPlainRecord(raw)) return invalid("core.invalid-evaluation-result");
    const operational = readData(raw, "operational");
    if (!(operational === "completed" || operational === "unavailable" || operational === "failed" || operational === "cancelled")) {
      return invalid("core.invalid-evaluation-result");
    }
    const coverageInput = readData(raw, "coverage");
    if (!isPlainRecord(coverageInput)) return invalid("core.invalid-evaluation-result");
    const coverageState = readData(coverageInput, "state");
    if (coverageState !== "complete" && coverageState !== "partial" && coverageState !== "insufficient") {
      return invalid("core.invalid-evaluation-result");
    }
    const scopeDescription = readField(coverageInput, "scopeDescription");
    if (scopeDescription.kind !== "data" || typeof scopeDescription.value !== "string") {
      return invalid("core.invalid-evaluation-result");
    }
    if (readArray(coverageInput, "issues", 32) === null) return invalid("core.invalid-evaluation-result");
    const conclusion = readData(raw, "conclusion");
    if (conclusion !== "no-supported-finding" && conclusion !== "findings"
      && conclusion !== "conflicting-requirements" && conclusion !== "undetermined") {
      return invalid("core.invalid-evaluation-result");
    }
    const findingsInput = readArray(raw, "findings", 64);
    if (findingsInput === null) return invalid("core.invalid-evaluation-result");
    const knownReferences = new Set<string>(assembled.snapshot.items.map(item => item.id));
    for (const dependency of assembled.snapshot.dependencies) knownReferences.add(dependency.evidenceId);
    const findings: Finding[] = [];
    for (const findingInput of findingsInput) {
      if (!isPlainRecord(findingInput)) return invalid("core.invalid-evaluation-result");
      const criterion = readData(findingInput, "criterion");
      if (typeof criterion !== "string" || !run.criterionIds.includes(criterion)) {
        return invalid("core.invalid-evaluation-result");
      }
      const status = readData(findingInput, "status");
      if (status !== "suspected" && status !== "supported") return invalid("core.invalid-evaluation-result");
      const severity = readData(findingInput, "severity");
      if (severity !== "info" && severity !== "concern" && severity !== "critical") return invalid("core.invalid-evaluation-result");
      const defectCode = readData(findingInput, "defectCode");
      if (typeof defectCode !== "string" || !DEFECT_CODE_PATTERN.test(defectCode)) return invalid("core.invalid-evaluation-result");
      const refs: Record<"requirementRefs" | "evidenceIds" | "affectedItems", string[]> = {
        requirementRefs: [],
        evidenceIds: [],
        affectedItems: [],
      };
      for (const key of ["requirementRefs", "evidenceIds", "affectedItems"] as const) {
        const values = readArray(findingInput, key, 32);
        if (values === null) return invalid("core.invalid-evaluation-result");
        for (const ref of values) {
          if (typeof ref !== "string" || !BOUNDED_ID_PATTERN.test(ref)) return invalid("core.invalid-evaluation-result");
          // References must resolve to actual context items or evidence dependencies.
          if (!knownReferences.has(ref)) return invalid("core.invalid-evaluation-result");
          refs[key].push(ref);
        }
      }
      const idField = readField(findingInput, "id");
      if (idField.kind !== "data" || typeof idField.value !== "string" || !BOUNDED_ID_PATTERN.test(idField.value)) {
        return invalid("core.invalid-evaluation-result");
      }
      const explanationField = readField(findingInput, "explanation");
      if (explanationField.kind !== "data" || typeof explanationField.value !== "string") {
        return invalid("core.invalid-evaluation-result");
      }
      const correctionField = readField(findingInput, "proposedCorrection");
      if (correctionField.kind !== "data"
        || (correctionField.value !== null && typeof correctionField.value !== "string")) {
        return invalid("core.invalid-evaluation-result");
      }
      const limitationsInput = readArray(findingInput, "limitations", 16);
      if (limitationsInput === null) return invalid("core.invalid-evaluation-result");
      findings.push({
        id: idField.value,
        criterion,
        status,
        severity,
        requirementRefs: refs.requirementRefs,
        evidenceIds: refs.evidenceIds,
        affectedItems: refs.affectedItems,
        defectCode,
        explanation: explanationField.value,
        proposedCorrection: correctionField.value,
        limitations: limitationsInput.filter((entry): entry is string => typeof entry === "string"),
      });
    }
    const scoresInput = readArray(raw, "scores", 32);
    if (scoresInput === null) return invalid("core.invalid-evaluation-result");
    const scores = [];
    for (const scoreInput of scoresInput) {
      if (!isPlainRecord(scoreInput)) return invalid("core.invalid-evaluation-result");
      const kind = readData(scoreInput, "kind");
      if (kind !== "probability" && kind !== "ordinal" && kind !== "numeric" && kind !== "self-reported-confidence") {
        return invalid("core.invalid-evaluation-result");
      }
      const value = readData(scoreInput, "value");
      const minimum = readData(scoreInput, "minimum");
      const maximum = readData(scoreInput, "maximum");
      if (typeof value !== "number" || !Number.isFinite(value)
        || typeof minimum !== "number" || !Number.isFinite(minimum)
        || typeof maximum !== "number" || !Number.isFinite(maximum)
        || value < minimum || value > maximum) {
        return invalid("core.invalid-evaluation-result");
      }
      const criterion = readData(scoreInput, "criterion");
      // A score must resolve to a criterion recognized for this check.
      if (typeof criterion !== "string" || !run.criterionIds.includes(criterion)) {
        return invalid("core.invalid-evaluation-result");
      }
      const interpretationField = readField(scoreInput, "interpretation");
      if (interpretationField.kind !== "data" || typeof interpretationField.value !== "string") {
        return invalid("core.invalid-evaluation-result");
      }
      const calibrationField = readField(scoreInput, "calibrationRef");
      if (calibrationField.kind !== "data"
        || (calibrationField.value !== null && typeof calibrationField.value !== "string")) {
        return invalid("core.invalid-evaluation-result");
      }
      scores.push({
        criterion,
        kind: kind as AssessmentResult["scores"][number]["kind"],
        value,
        minimum,
        maximum,
        interpretation: interpretationField.value,
        calibrationRef: calibrationField.value,
      });
    }
    const additionalEvidenceInput = readArray(raw, "additionalEvidence", 64);
    if (additionalEvidenceInput === null) return invalid("core.invalid-evaluation-result");
    const additionalEvidence: ContextItem[] = [];
    for (const itemInput of additionalEvidenceInput) {
      // Untrusted evaluator metadata is admitted as plain descriptor data only.
      const admitted = admitContextItem(itemInput, "core.evaluator-additional");
      if (!admitted.ok) return invalid("core.invalid-evaluation-result");
      additionalEvidence.push(admitted.item);
    }
    const dependenciesInput = readArray(raw, "dependencies", 64);
    if (dependenciesInput === null) return invalid("core.invalid-evaluation-result");
    const dependencies = [];
    for (const dependencyInput of dependenciesInput) {
      if (!isPlainRecord(dependencyInput)) return invalid("core.invalid-evaluation-result");
      const evidenceId = readData(dependencyInput, "evidenceId");
      const revision = readData(dependencyInput, "revision");
      const relevance = readData(dependencyInput, "relevance");
      const check = readData(dependencyInput, "check");
      if (typeof evidenceId !== "string" || typeof revision !== "string"
        || (relevance !== "authority" && relevance !== "conclusion" && relevance !== "supporting")
        || (check !== "content-fingerprint" && check !== "host-cursor" && check !== "external-revision" && check !== "unknown")) {
        return invalid("core.invalid-evaluation-result");
      }
      dependencies.push({
        evidenceId,
        revision,
        relevance: relevance as AssessmentResult["dependencies"][number]["relevance"],
        check: check as AssessmentResult["dependencies"][number]["check"],
      });
    }
    const usageInput = readArray(raw, "usageAttemptIds", 16);
    if (usageInput === null) return invalid("core.invalid-evaluation-result");
    const usageAttemptIds: string[] = [];
    for (const attemptId of usageInput) {
      // Attempt references must resolve to attempts this engine actually issued.
      if (typeof attemptId !== "string" || !BOUNDED_ID_PATTERN.test(attemptId) || !this.#issuedAttemptIds.has(attemptId)) {
        return invalid("core.invalid-evaluation-result");
      }
      usageAttemptIds.push(attemptId);
    }
    if (conclusion === "no-supported-finding" && findings.length > 0) return invalid("core.invalid-evaluation-result");
    if (conclusion === "findings" && findings.length === 0) return invalid("core.invalid-evaluation-result");
    if (operational !== "completed" && conclusion !== "undetermined") return invalid("core.invalid-evaluation-result");
    // Committed coverage cannot be widened by the evaluator.
    const committedStrength = Math.min(COVERAGE_STRENGTH[coverageState], COVERAGE_STRENGTH[assembled.snapshot.coverage.state]);
    const committedState = committedStrength === 2 ? "complete" : committedStrength === 1 ? "partial" : "insufficient";
    let committedConclusion = conclusion;
    if (committedState !== "complete" && committedConclusion === "no-supported-finding") committedConclusion = "undetermined";
    if (operational !== "completed") committedConclusion = "undetermined";
    return {
      result: {
        operational,
        coverage: { ...assembled.snapshot.coverage, state: committedState },
        conclusion: committedConclusion as AssessmentResult["conclusion"],
        findings,
        scores,
        additionalEvidence,
        dependencies,
        usageAttemptIds,
      },
      validationState: "valid",
      terminalReason: "evaluated",
      findingCount: findings.length,
    };
  }

  #projectAssessment(run: ActiveRun, settled: SettledAssessment): AssessmentResultData {
    const result = settled.result;
    const findings: AssessmentFindingMetadata[] = result.findings.slice(0, 64).map((finding, index) => ({
      findingRef: `${run.runId}:finding-${index + 1}`,
      responseIdRef: boundedId(finding.id, "response-finding-ref"),
      criterionId: boundedId(finding.criterion, "criterion-unavailable"),
      status: finding.status,
      severity: finding.severity,
      defectCode: DEFECT_CODE_PATTERN.test(finding.defectCode) ? finding.defectCode : "core.unspecified-defect",
      requirementRefs: finding.requirementRefs.slice(0, 16).map(ref => boundedId(ref, "reference-unavailable")),
      evidenceRefs: finding.evidenceIds.slice(0, 16).map(ref => boundedId(ref, "reference-unavailable")),
      affectedRefs: finding.affectedItems.slice(0, 16).map(ref => boundedId(ref, "reference-unavailable")),
    }));
    const scores: AssessmentScoreMetadata[] = result.scores.slice(0, 32).map(score => ({
      criterionId: boundedId(score.criterion, "criterion-unavailable"),
      kind: score.kind,
      value: score.value,
      minimum: score.minimum,
      maximum: score.maximum,
      calibrationRef: score.calibrationRef === null ? null : boundedId(score.calibrationRef, "calibration-ref-unavailable"),
      interpretationRef: null,
    }));
    return {
      operational: result.operational,
      coverage: result.coverage.state,
      conclusion: result.conclusion,
      findings,
      scores,
      dependencyRefs: result.dependencies.slice(0, 32).map(dependency => boundedId(dependency.evidenceId, "dependency-ref-unavailable")),
      additionalEvidenceRefs: result.additionalEvidence.slice(0, 16).map(item => boundedId(item.id, "evidence-ref-unavailable")),
      attemptRefs: result.usageAttemptIds.slice(0, 16).map(id => boundedId(id, "attempt-ref-unavailable")),
      validationState: settled.validationState,
    };
  }

  #settleRun(run: ActiveRun, settled: SettledAssessment): void {
    const durationMs = Math.max(0, this.#clock.nowMonoMs() - run.startedMonoMs);
    this.#activeRuns.delete(run.checkId);
    const state = this.#checkStates.get(run.checkId);
    if (state !== undefined) {
      state.runs += 1;
      state.lastOutcome = settled.result.conclusion;
    }
    this.#emit({
      event: "quality.check.settled",
      level: settled.result.operational === "failed" ? "warn" : "info",
      reasonCodes: [settled.terminalReason],
      data: {
        operational: settled.result.operational,
        conclusion: settled.result.conclusion,
        coverage: settled.result.coverage.state,
        findingCount: settled.findingCount,
        actionCount: 0,
        usageAttemptRefs: settled.result.usageAttemptIds.slice(0, 16).map(id => boundedId(id, "attempt-ref-unavailable")),
        accountingCoverage: "complete",
        durationMs,
        terminalReason: settled.terminalReason,
      },
      correlation: { runId: run.runId },
    });
    if (this.#pendingIntents.has(run.checkId)) this.#attemptAdmission(run.checkId);
  }

  #evidenceAccess(): EvidenceAccess {
    const unavailable = async () => ({
      ok: false as const,
      error: { code: "core.capability-unavailable", retryable: false },
    });
    return {
      readSource: unavailable,
      readPermittedFile: unavailable,
      recentObservations: limit => this.#store.recentObservations(limit),
    };
  }

  #modelsFacet(): Pick<EvaluationServices, "request"> {
    return {
      request: async () => ({ ok: false, error: { code: "core.capability-unavailable", retryable: false } }),
    };
  }

  // -------------------------------------------------------------------------
  // Diagnostics
  // -------------------------------------------------------------------------

  #emit(input: Parameters<DiagnosticHistory["append"]>[0], historyOnly = false): DiagnosticRecordV1 | undefined {
    const record = this.#history.append(input);
    if (record === undefined || this.#journal === null || historyOnly) return record;
    const written = this.#journal.write(record);
    if (!written.written && !this.#journalFailureReported) {
      this.#journalFailureReported = true;
      this.#history.append({
        event: "quality.sink.health",
        level: "warn",
        reasonCodes: [written.reasonCode ?? "journal-write-failed"],
        data: {
          sinkId: this.#journal.logicalJournalId,
          previousState: "healthy",
          state: "failed",
          queuedRecords: 0,
          queuedBytes: 0,
          lostRecords: this.#journal.status.lostRecords,
          reasonCode: written.reasonCode ?? "journal-write-failed",
        },
      });
    }
    return record;
  }

  // -------------------------------------------------------------------------
  // Retirement and status
  // -------------------------------------------------------------------------

  /** Idempotent logical retirement: revokes admission first, then disposes. */
  retire(cause: string): void {
    if (this.#state === "retired") return;
    this.#state = "retired";
    this.#retiredAt = nowIso(this.#clock);
    this.#scheduler.dispose();
    this.#pendingIntents.clear();
    this.#registry.retire();
    void this.#registry.disposeAll();
    if (this.#journal !== null) {
      // The retirement record still belongs to the logical segment; the actual
      // close outcome is reported separately by journal.closed.
      const predicted = this.#journal.state === "healthy" ? "written" : "failed";
      this.#emit({
        event: "quality.runtime.retired",
        level: "info",
        reasonCodes: [],
        data: {
          cause: normalizeRetireCause(cause),
          unsettledOperations: 0,
          unresolvedAttempts: 0,
          pendingActions: 0,
          checkpointRevision: CHECKPOINT_REVISION,
          journalFlushState: predicted,
        },
      });
      const closed = this.#journal.close();
      // The closed segment cannot contain its own close record; it goes to the
      // retained history (and any future sinks) only.
      this.#history.append({
        event: "quality.journal.closed",
        level: closed.flushState === "written" ? "info" : "warn",
        reasonCodes: [],
        data: {
          logicalJournalId: this.#journal.logicalJournalId,
          segmentOrdinal: 0,
          closeReason: normalizeRetireCause(cause),
          recordCount: closed.recordCount,
          serializedBytes: closed.serializedBytes,
          flushState: closed.flushState,
          historyCoverage: this.#journal.status.lostRecords === 0 ? "complete" : "partial",
        },
      });
      return;
    }
    this.#emit({
      event: "quality.runtime.retired",
      level: "info",
      reasonCodes: [],
      data: {
        cause: normalizeRetireCause(cause),
        unsettledOperations: 0,
        unresolvedAttempts: 0,
        pendingActions: 0,
        checkpointRevision: CHECKPOINT_REVISION,
        journalFlushState: "disabled",
      },
    });
  }

  status(hostIdle: boolean): EngineStatus {
    const view = this.#store.view();
    return buildStatus({
      runtimeState: this.#state,
      generation: this.#generation,
      startedAt: this.#startedAt,
      retiredAt: this.#retiredAt,
      executionState: this.#state === "retired" ? "shutdown" : observedExecutionState(hostIdle),
      workState: view.work,
      operatorStopped: view.operatorStopped,
      hostVersion: this.#input.hostVersion,
      hostMode: this.#input.hostMode,
      resolved: this.#configuration,
      rejection: this.#rejection,
      history: {
        records: this.#history.records(),
        recordCount: this.#history.recordCount,
        byteLength: this.#history.byteLength,
        droppedRecords: this.#history.droppedRecords,
      },
      checks: {
        total: Object.keys(this.#configuration.value.checks).length,
        active: this.#activeCheckCount(),
        waiting: [...this.#checkStates.values()].filter(state => state.state === "waiting").length,
        runs: [...this.#checkStates.values()].reduce((sum, state) => sum + state.runs, 0),
        pendingIntents: this.#pendingIntents.size,
        suppressedReasons: Object.fromEntries(this.#suppressedReasons),
        detail: [...this.#checkStates.values()].map(state => ({
          checkId: state.checkId,
          enabled: this.#configuration.value.checks[state.checkId]?.enabled ?? false,
          state: state.state,
          missing: [...state.missing],
          runs: state.runs,
          lastOutcome: state.lastOutcome,
          pendingIntent: this.#pendingIntents.has(state.checkId),
        })),
      },
      observation: {
        completedPrimaryTools: view.counters.completedPrimaryTools,
        completedPrimaryCycles: view.counters.completedPrimaryCycles,
        activeOperations: view.activePrimaryOperations.length,
        waits: view.waits.length,
        lastActivityAt: this.#store.lastActivityAt,
        lastProgressAt: this.#store.lastProgressAt,
        rejectedObservations: this.#rejectedObservations,
      },
      registry: this.#registry.inventory(),
      journal: this.#journal?.status ?? null,
    });
  }

  handleRegistryQuery(query: RegistryQuery): void {
    if (this.#state !== "active") return;
    if (query.apiMajor !== 1) return;
    if (query.observedSessionId !== this.#input.observedSessionId) return;
    query.reply(this.#registry.endpoint);
  }
}

/** Read-only status for a command that runs before any runtime generation exists. */
export async function inspectInactiveSession(input: EngineSessionInput, hostIdle: boolean): Promise<EngineStatus> {
  const loaded = await loadEffectiveConfiguration({
    agentDir: input.agentDir,
    projectConfigDir: input.projectConfigDir,
    projectTrusted: input.projectTrusted,
  });
  return buildStatus({
    runtimeState: "inactive",
    generation: null,
    startedAt: null,
    retiredAt: null,
    executionState: observedExecutionState(hostIdle),
    workState: "unknown",
    operatorStopped: false,
    hostVersion: input.hostVersion,
    hostMode: input.hostMode,
    resolved: loaded.resolved,
    rejection: loaded.rejection,
    history: null,
    checks: {
      total: Object.keys(loaded.resolved.value.checks).length,
      active: 0,
      waiting: 0,
      runs: 0,
      pendingIntents: 0,
      suppressedReasons: {},
      detail: [],
    },
    observation: {
      completedPrimaryTools: 0,
      completedPrimaryCycles: 0,
      activeOperations: 0,
      waits: 0,
      lastActivityAt: null,
      lastProgressAt: null,
      rejectedObservations: 0,
    },
    registry: [],
    journal: null,
  });
}

export const ENGINE_SESSION_IMPLEMENTED = true;
