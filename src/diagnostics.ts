// O1 diagnostic projection and bounded recent history.
//
// Only already-projected metadata reaches this history. Records are built from
// closed, engine-authored fields; raw configuration text, tool arguments, task
// text and model prose have no path into this module. The history is bounded by
// both record count and serialized UTF-8 bytes, and retained records are frozen
// so a reader cannot mutate what another reader sees.

import { randomUUID } from "node:crypto";
import type {
  DiagnosticCorrelation,
  DiagnosticEventName,
  DiagnosticLevel,
  DiagnosticProjection,
  DiagnosticRecordV1,
  DiagnosticScope,
  JsonObject,
} from "./contracts.js";

export const DEFAULT_MAX_RECORD_BYTES = 65_536;

export interface DiagnosticHistoryLimits {
  maxEvents: number;
  maxBytes: number;
  maxRecordBytes: number;
}

export interface DiagnosticHistoryContext {
  observedSessionId: string;
  scope: DiagnosticScope;
  configRevision: string;
  dataPolicyRevision: string;
  ownerId: string;
}

export interface DiagnosticAppendInput {
  event: DiagnosticEventName;
  level: DiagnosticLevel;
  reasonCodes: readonly string[];
  data: JsonObject;
}

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
    };
    this.#limits = { ...limits };
  }

  append(input: DiagnosticAppendInput): void {
    this.#sequence += 1;
    const record = this.#project(input);
    const bytes = serializedBytes(record);
    if (bytes > this.#limits.maxRecordBytes) {
      this.#droppedRecords += 1;
      return;
    }
    this.#records.push(record);
    this.#bytes += bytes;
    while (this.#records.length > this.#limits.maxEvents || this.#bytes > this.#limits.maxBytes) {
      const removed = this.#records.shift();
      if (removed === undefined) break;
      this.#bytes -= serializedBytes(removed);
      this.#droppedRecords += 1;
    }
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

  #project(input: DiagnosticAppendInput): DiagnosticRecordV1 {
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
    };
    const projection: DiagnosticProjection = {
      metadataTruncated: false,
      omittedFields: [],
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
        scope: { ...this.#context.scope },
        origin: { kind: "engine", ownerId: this.#context.ownerId, parentOperationId: null },
        correlation,
        level: input.level,
        detail: "standard",
        configRevision: this.#context.configRevision,
        dataPolicyRevision: this.#context.dataPolicyRevision,
        reasonCodes: [...input.reasonCodes],
        data: input.data,
        projection,
      },
    };
    return deepFreeze(record);
  }
}
