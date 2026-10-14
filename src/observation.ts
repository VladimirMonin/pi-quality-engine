// Accepted primary observation state.
//
// This store owns the accepted observation sequence, primary counters, waits,
// operator stop and the current work/episode snapshot. It keeps only bounded
// derived state; observation bodies are not retained. Origins are stamped here,
// so a source cannot impersonate the operator, the primary adapter or a reviewer.

import type {
  ExecutionState,
  JsonObject,
  Observation,
  ObservationDraft,
  Origin,
  OriginKind,
  Result,
  RuntimeView,
  Scope,
  WaitRecord,
  WorkState,
} from "./contracts.js";

export const MAX_RECENT_TOOL_COMPLETIONS = 32;
export const MAX_RECENT_OBSERVATIONS = 64;
export const MAX_ACTIVE_OPERATIONS = 32;
export const MAX_TASK_CHARACTERS = 4096;

export interface ObservationSource {
  ownerId: string;
  kind: OriginKind;
}

export interface PublishOptions {
  receivedMonoMs: number;
  /** Host parent operation for a nested primary operation; runtime-assigned. */
  parentOperationId?: string | null;
}

export interface AcceptedObservation {
  observation: Observation;
  duplicate: boolean;
}

export interface ToolCompletionFact {
  observationId: string;
  operationId: string;
  toolName: string;
  outcome: "success" | "failure" | "cancelled";
  isError: boolean;
  occurredAt: string;
  durationMs: number | null;
}

export interface ObservationSnapshot {
  view: RuntimeView;
  recentToolCompletions: readonly ToolCompletionFact[];
}

const ALLOWED_ORIGIN_KINDS: ReadonlySet<string> = new Set([
  "operator", "primary", "owned-reviewer", "engine", "external",
]);

const TOOL_OUTCOMES = new Set(["success", "failure", "cancelled"]);
const WAIT_STATES = new Set(["pending", "satisfied", "failed", "unknown"]);

function isValidIdentifier(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function isValidOccurredAt(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(code: string, field: string): { ok: false; error: { code: string; retryable: boolean; field: string } } {
  return { ok: false, error: { code, retryable: false, field } };
}

export class ObservationStore {
  readonly #scope: Scope;
  readonly #sequenceByKey = new Map<string, string>();
  #sequence = 0;
  #completedPrimaryTools = 0;
  #completedPrimaryCycles = 0;
  #primaryEvidenceRevision = 0;
  #activeOperations = new Map<string, { kind: "tool" | "model"; name: string; parentOperationId: string | null }>();
  #waits = new Map<string, WaitRecord>();
  #recentTools: ToolCompletionFact[] = [];
  #episodeId: string | null = null;
  #authorizationRevision = 0;
  #taskText: string | null = null;
  #operatorStopped = false;
  #lastActivityMonoMs: number | null = null;
  #lastActivityAt: string | null = null;
  #lastProgressMonoMs: number | null = null;
  #lastProgressAt: string | null = null;
  #progressEvidenceIds: string[] = [];
  readonly #recentObservations: Observation[] = [];
  readonly #operationParents = new Map<string, string | null>();

  constructor(scope: Scope) {
    this.#scope = { ...scope, episodeId: null, authorizationRevision: "auth-0" };
  }

  get episodeId(): string | null {
    return this.#episodeId;
  }

  get operatorStopped(): boolean {
    return this.#operatorStopped;
  }

  get lastActivityAt(): string | null {
    return this.#lastActivityAt;
  }

  get lastProgressAt(): string | null {
    return this.#lastProgressAt;
  }

  get taskText(): string | null {
    return this.#taskText;
  }

  /** Origin kinds a source may claim; engine-owned sources use the same rule. */
  publish(source: ObservationSource, draft: ObservationDraft, options: PublishOptions): Result<AcceptedObservation> {
    if (!ALLOWED_ORIGIN_KINDS.has(source.kind)) return fail("core.invalid-origin", "$.origin");
    if (!isValidIdentifier(source.ownerId, 128)) return fail("core.invalid-origin", "$.origin");
    if (!isValidIdentifier(draft.kind, 128)) return fail("core.invalid-observation", "$.kind");
    if (!isValidOccurredAt(draft.occurredAt)) return fail("core.invalid-observation", "$.occurredAt");
    if (draft.visibility !== "complete" && draft.visibility !== "partial" && draft.visibility !== "unknown") {
      return fail("core.invalid-observation", "$.visibility");
    }
    if (!isJsonObject(draft.facts) || Object.keys(draft.facts).length > 32) {
      return fail("core.invalid-observation", "$.facts");
    }
    if (!Array.isArray(draft.evidenceIds) || draft.evidenceIds.length > 16
      || draft.evidenceIds.some(id => !isValidIdentifier(id, 128))) {
      return fail("core.invalid-observation", "$.evidenceIds");
    }
    if (draft.externalId !== null && !isValidIdentifier(draft.externalId, 128)) {
      return fail("core.invalid-observation", "$.externalId");
    }

    const duplicateKey = draft.externalId === null ? null : `${source.ownerId}\u0000${draft.externalId}`;
    if (duplicateKey !== null) {
      const existing = this.#sequenceByKey.get(duplicateKey);
      if (existing !== undefined) {
        const observation = this.#buildObservation(source, draft, options, this.#sequenceOf(existing));
        return { ok: true, value: { observation, duplicate: true } };
      }
    }

    const kindCheck = this.#validateKindFacts(source, draft);
    if (!kindCheck.ok) return kindCheck;

    this.#sequence += 1;
    const observation = this.#buildObservation(source, draft, options, this.#sequence);
    this.#recentObservations.unshift(observation);
    this.#recentObservations.length = Math.min(this.#recentObservations.length, MAX_RECENT_OBSERVATIONS);
    if (duplicateKey !== null) this.#sequenceByKey.set(duplicateKey, observation.id);
    this.#lastActivityMonoMs = options.receivedMonoMs;
    this.#lastActivityAt = observation.occurredAt;
    this.#applyFacts(observation, source);
    return { ok: true, value: { observation, duplicate: false } };
  }

  /** Idempotent operator stop; no timer or later observation clears it. */
  markOperatorStopped(): void {
    this.#operatorStopped = true;
  }

  view(): RuntimeView {
    const activePrimaryOperations = [...this.#activeOperations.entries()]
      .filter(([, operation]) => operation.kind === "tool" || operation.kind === "model")
      .map(([operationId]) => operationId)
      .slice(0, MAX_ACTIVE_OPERATIONS);
    return {
      scope: {
        ...this.#scope,
        episodeId: this.#episodeId,
        authorizationRevision: this.#authorizationRevision === 0 ? "auth-0" : `auth-${this.#authorizationRevision}`,
      },
      execution: this.#executionState(),
      work: this.#workState(),
      operatorStopped: this.#operatorStopped,
      observerPaused: false,
      outstandingWork: this.#episodeId === null ? "none" : "supported",
      activePrimaryOperations,
      waits: [...this.#waits.values()].slice(0, MAX_ACTIVE_OPERATIONS).map(wait => ({ ...wait })),
      lastActivityMonoMs: this.#lastActivityMonoMs,
      lastProgressMonoMs: this.#lastProgressMonoMs,
      progressEvidenceIds: [...this.#progressEvidenceIds],
      counters: {
        completedPrimaryTools: this.#completedPrimaryTools,
        completedPrimaryCycles: this.#completedPrimaryCycles,
        primaryEvidenceRevision: this.#primaryEvidenceRevision,
      },
    };
  }

  snapshot(): ObservationSnapshot {
    return { view: this.view(), recentToolCompletions: this.#recentTools.map(entry => ({ ...entry })) };
  }

  /** Bounded accepted observation windows for canonical context providers. */
  recentObservations(limit: number): readonly Observation[] {
    const bounded = Number.isInteger(limit) && limit > 0 ? Math.min(limit, MAX_RECENT_OBSERVATIONS) : 0;
    return this.#recentObservations.slice(0, bounded);
  }

  hasObservation(observationId: string): boolean {
    const match = /^obs-(\d+)$/.exec(observationId);
    if (match !== null) return Number(match[1]) <= this.#sequence;
    return this.#recentObservations.some(observation => observation.id === observationId);
  }

  #sequenceOf(observationId: string): number {
    return Number.parseInt(observationId.replace(/^obs-/, ""), 10) || this.#sequence;
  }

  #executionState(): ExecutionState {
    for (const operation of this.#activeOperations.values()) {
      if (operation.kind === "model") return "model-active";
    }
    if (this.#activeOperations.size > 0) return "tools-active";
    return "idle";
  }

  #workState(): WorkState {
    if (this.#operatorStopped) return "waiting-operator";
    if (this.#episodeId !== null) return "work-expected";
    return "unknown";
  }

  #buildObservation(source: ObservationSource, draft: ObservationDraft, options: PublishOptions, sequence: number): Observation {
    const origin: Origin = {
      kind: source.kind,
      ownerId: source.ownerId,
      parentOperationId: options.parentOperationId ?? null,
    };
    return {
      schemaVersion: 1,
      id: `obs-${sequence}`,
      externalId: draft.externalId,
      sequence,
      scope: { ...this.#scope, episodeId: this.#episodeId, authorizationRevision: this.#authorizationRevision === 0 ? "auth-0" : `auth-${this.#authorizationRevision}` },
      origin,
      kind: draft.kind,
      occurredAt: draft.occurredAt,
      receivedMonoMs: options.receivedMonoMs,
      visibility: draft.visibility,
      facts: draft.facts,
      evidenceIds: [...draft.evidenceIds],
    };
  }

  #validateKindFacts(source: ObservationSource, draft: ObservationDraft): Result<true> {
    const facts = draft.facts;
    if (draft.kind === "core.progress-supported" && draft.evidenceIds.length === 0) {
      return fail("core.invalid-observation", "$.evidenceIds");
    }
    if (draft.kind.startsWith("core.tool-")) {
      if (!isValidIdentifier(facts["operationId"], 128)) return fail("core.invalid-observation", "$.facts.operationId");
      if (!isValidIdentifier(facts["toolName"], 128)) return fail("core.invalid-observation", "$.facts.toolName");
    }
    if (draft.kind === "core.tool-completed") {
      const outcome = facts["outcome"];
      if (typeof outcome !== "string" || !TOOL_OUTCOMES.has(outcome)) {
        return fail("core.invalid-observation", "$.facts.outcome");
      }
    }
    if (draft.kind === "core.wait-changed") {
      if (!isValidIdentifier(facts["waitId"], 128)) return fail("core.invalid-observation", "$.facts.waitId");
      const state = facts["state"];
      if (typeof state !== "string" || !WAIT_STATES.has(state)) {
        return fail("core.invalid-observation", "$.facts.state");
      }
      if (!isValidIdentifier(facts["ownerId"], 128)) return fail("core.invalid-observation", "$.facts.ownerId");
    }
    if (draft.kind === "core.cycle-completed" && !isValidIdentifier(facts["cycleId"], 128)) {
      return fail("core.invalid-observation", "$.facts.cycleId");
    }
    if (draft.kind === "core.operator-input" && typeof facts["inputKind"] !== "string") {
      return fail("core.invalid-observation", "$.facts.inputKind");
    }
    return { ok: true, value: true };
  }

  #applyFacts(observation: Observation, source: ObservationSource): void {
    const facts = observation.facts;
    const primary = observation.origin.kind === "primary";
    switch (observation.kind) {
      case "core.operator-input": {
        // Only established operator provenance can open or extend an episode.
        if (observation.origin.kind !== "operator") break;
        const text = typeof facts["text"] === "string" ? facts["text"].slice(0, MAX_TASK_CHARACTERS) : null;
        if (this.#episodeId === null) {
          this.#episodeId = `ep-${observation.sequence}`;
          this.#authorizationRevision += 1;
        }
        if (text !== null) this.#taskText = text;
        break;
      }
      case "core.operator-stopped": {
        this.#operatorStopped = true;
        break;
      }
      case "core.model-started": {
        if (!primary) break;
        const operationId = String(facts["operationId"]);
        this.#activeOperations.set(operationId, { kind: "model", name: "model", parentOperationId: observation.origin.parentOperationId });
        break;
      }
      case "core.model-completed": {
        if (!primary) break;
        this.#activeOperations.delete(String(facts["operationId"]));
        break;
      }
      case "core.tool-started": {
        if (!primary) break;
        const operationId = String(facts["operationId"]);
        this.#operationParents.set(operationId, observation.origin.parentOperationId);
        this.#activeOperations.set(operationId, {
          kind: "tool",
          name: String(facts["toolName"]),
          parentOperationId: observation.origin.parentOperationId,
        });
        this.#upsertWait(`wait:${operationId}`, String(facts["toolName"]), "pending", observation);
        break;
      }
      case "core.tool-completed": {
        if (!primary) break;
        const operationId = String(facts["operationId"]);
        const started = this.#activeOperations.get(operationId);
        const endParent = observation.origin.parentOperationId;
        const startParent = this.#operationParents.get(operationId) ?? null;
        this.#operationParents.delete(operationId);
        this.#activeOperations.delete(operationId);
        const outcome = String(facts["outcome"]) as ToolCompletionFact["outcome"];
        this.#upsertWait(
          `wait:${operationId}`,
          String(facts["toolName"]),
          outcome === "success" ? "satisfied" : "failed",
          observation,
        );
        // Known start ownership is retained when the optional end parent field is
        // absent; conflicting parent facts never grant stronger counting authority.
        const nested = endParent !== null || startParent !== null;
        if (!nested) {
          this.#completedPrimaryTools += 1;
          this.#primaryEvidenceRevision += 1;
          this.#recentTools.unshift({
            observationId: observation.id,
            operationId,
            toolName: String(facts["toolName"]),
            outcome,
            isError: outcome !== "success",
            occurredAt: observation.occurredAt,
            durationMs: typeof facts["durationMs"] === "number" ? facts["durationMs"] : null,
          });
          this.#recentTools = this.#recentTools.slice(0, MAX_RECENT_TOOL_COMPLETIONS);
        } else if (started === undefined) {
          // A nested completion without its start remains observable activity.
          this.#primaryEvidenceRevision += 1;
        }
        break;
      }
      case "core.cycle-completed": {
        if (!primary) break;
        this.#completedPrimaryCycles += 1;
        break;
      }
      case "core.wait-changed": {
        const waitId = String(facts["waitId"]);
        this.#waits.set(waitId, {
          id: waitId,
          ownerId: String(facts["ownerId"]),
          operationId: typeof facts["operationId"] === "string" ? facts["operationId"] : null,
          state: facts["state"] as WaitRecord["state"],
          reviewDueMonoMs: null,
          lastObservationId: observation.id,
        });
        break;
      }
      case "core.progress-supported": {
        this.#lastProgressMonoMs = observation.receivedMonoMs;
        this.#lastProgressAt = observation.occurredAt;
        this.#progressEvidenceIds = [...observation.evidenceIds].slice(0, 16);
        break;
      }
      default:
        break;
    }
    void source;
  }

  #upsertWait(waitId: string, ownerName: string, state: WaitRecord["state"], observation: Observation): void {
    this.#waits.set(waitId, {
      id: waitId,
      ownerId: `primary:${ownerName}`,
      operationId: waitId.replace(/^wait:/, ""),
      state,
      reviewDueMonoMs: null,
      lastObservationId: observation.id,
    });
  }
}
