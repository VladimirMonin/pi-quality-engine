// One session-owned engine runtime generation.
//
// The runtime is created from the real Pi session lifecycle and owns exactly one
// diagnostic history generation. At this checkpoint it starts no timer, opens no
// credential, dispatches no model request and performs no primary effect: cold
// activation is disabled and the default mode is observation.

import { DiagnosticHistory, DEFAULT_MAX_RECORD_BYTES } from "./diagnostics.js";
import { loadEffectiveConfiguration } from "./configuration.js";
import type { ConfigurationRejection } from "./configuration.js";
import type {
  ConfigurationOrigin,
  ConfigurationSourceStatus,
  DiagnosticRecordV1,
  ExecutionState,
  RecentHistoryLimits,
  ResolvedConfiguration,
  WorkState,
} from "./contracts.js";

export const ENGINE_NAME = "pi-quality-engine";
export const ENGINE_VERSION = "0.0.1";
export const ENGINE_BUILD_REF = `${ENGINE_NAME}@${ENGINE_VERSION}`;
export const DATA_POLICY_REVISION = "o1-1";

const RUNTIME_OWNER_ID = "core.runtime";
const AUTHORIZATION_REVISION = "no-grants";
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
}

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
  modelEvaluation: CapabilityState;
  feedbackActions: CapabilityState;
  sessionConfigurationPatch: CapabilityState;
  statusExport: CapabilityState;
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
    enabled: false;
    mode: "observe";
    revision: string;
    origins: readonly ConfigurationOrigin[];
    sources: ConfigurationSourceStatus;
    recentHistory: RecentHistoryLimits;
    rejection: { origin: ConfigurationOrigin; errorCode: string; field: string } | null;
  };
  activation: {
    coldActivation: "disabled";
    autonomousModelCalls: "unavailable";
    checkExecution: "unavailable";
  };
  capabilities: EngineCapabilities;
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
  journalFiles: "unavailable",
  functionalStatePersistence: "unavailable",
  componentRegistry: "unavailable",
  triggersAndScheduling: "unavailable",
  contextEvidence: "unavailable",
  modelEvaluation: "unavailable",
  feedbackActions: "unavailable",
  sessionConfigurationPatch: "unavailable",
  statusExport: "unavailable",
};

interface StatusHistoryView {
  records: readonly DiagnosticRecordV1[];
  recordCount: number;
  byteLength: number;
  droppedRecords: number;
}

/**
 * Truthful execution observation available at this checkpoint: the host reports
 * whether the primary is idle. Busy primary work cannot be classified further
 * without the K02 observation subsystem, so it stays C1 `unknown`.
 */
export function observedExecutionState(hostIdle: boolean): ExecutionState {
  return hostIdle ? "idle" : "unknown";
}

interface StatusParts {
  runtimeState: "active" | "retired" | "inactive";
  generation: string | null;
  startedAt: string | null;
  retiredAt: string | null;
  executionState: ExecutionState;
  hostVersion: string;
  hostMode: string;
  resolved: ResolvedConfiguration;
  rejection: ConfigurationRejection | null;
  history: StatusHistoryView | null;
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
      workState: "unknown",
      restored: false,
      checkpointRevision: CHECKPOINT_REVISION,
      operatorStopped: false,
      accountingCoverage: "complete",
    },
    configuration: {
      enabled: parts.resolved.value.enabled,
      mode: parts.resolved.value.mode,
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
      coldActivation: "disabled",
      autonomousModelCalls: "unavailable",
      checkExecution: "unavailable",
    },
    capabilities: { ...CAPABILITY_STATES },
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

export class EngineSession {
  static async start(input: EngineSessionInput & { hostIdle: boolean }): Promise<EngineSession> {
    const loaded = await loadEffectiveConfiguration({
      agentDir: input.agentDir,
      projectConfigDir: input.projectConfigDir,
      projectTrusted: input.projectTrusted,
    });
    return new EngineSession(input, input.hostIdle, loaded.resolved, loaded.rejection);
  }

  readonly #input: EngineSessionInput;
  readonly #configuration: ResolvedConfiguration;
  readonly #rejection: ConfigurationRejection | null;
  readonly #history: DiagnosticHistory;
  readonly #generation = `gen-${++generationCounter}`;
  readonly #startedAt = new Date().toISOString();
  #retiredAt: string | null = null;
  #state: "active" | "retired" = "active";

  private constructor(
    input: EngineSessionInput,
    hostIdleAtStart: boolean,
    configuration: ResolvedConfiguration,
    rejection: ConfigurationRejection | null,
  ) {
    this.#input = { ...input };
    this.#configuration = configuration;
    this.#rejection = rejection;
    this.#history = new DiagnosticHistory({
      observedSessionId: input.observedSessionId,
      scope: {
        branchId: input.branchId,
        runtimeGeneration: this.#generation,
        episodeId: null,
        authorizationRevision: AUTHORIZATION_REVISION,
      },
      configRevision: configuration.revision,
      dataPolicyRevision: DATA_POLICY_REVISION,
      ownerId: RUNTIME_OWNER_ID,
    }, {
      maxEvents: configuration.value.observability.recentHistory.maxEvents,
      maxBytes: configuration.value.observability.recentHistory.maxBytes,
      maxRecordBytes: DEFAULT_MAX_RECORD_BYTES,
    });

    if (rejection !== null) {
      this.#history.append({
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
    this.#history.append({
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
        workState: "unknown",
        operatorStopped: false,
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

  /** Idempotent logical retirement: it emits the retirement record once. */
  retire(cause: string): void {
    if (this.#state === "retired") return;
    this.#state = "retired";
    this.#retiredAt = new Date().toISOString();
    this.#history.append({
      event: "quality.runtime.retired",
      level: "info",
      reasonCodes: [],
      data: {
        cause: normalizeRetireCause(cause),
        unsettledOperations: 0,
        unresolvedAttempts: 0,
        pendingActions: 0,
        checkpointRevision: CHECKPOINT_REVISION,
        journalFlushState: "not-implemented",
      },
    });
  }

  /**
   * Status snapshot from the live host observation. `hostIdle` comes from the
   * actual primary context at read time; unobserved work stays `unknown`.
   */
  status(hostIdle: boolean): EngineStatus {
    return buildStatus({
      runtimeState: this.#state,
      generation: this.#generation,
      startedAt: this.#startedAt,
      retiredAt: this.#retiredAt,
      executionState: this.#state === "retired" ? "shutdown" : observedExecutionState(hostIdle),
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
    });
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
    hostVersion: input.hostVersion,
    hostMode: input.hostMode,
    resolved: loaded.resolved,
    rejection: loaded.rejection,
    history: null,
  });
}
