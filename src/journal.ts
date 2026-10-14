// Append-oriented session journal.
//
// One logical journal belongs to each observed session. Records reaching this
// module are already projected O1 metadata; no functional body, command value or
// exception text is serialized here. The segment is bounded by
// `observability.journal.maxFileBytes`; rotation and retention belong to the
// next checkpoint, so an oversized segment stops accepting records and reports
// the loss instead of silently truncating.

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { DiagnosticRecordV1 } from "./contracts.js";

export type JournalState = "healthy" | "failed" | "closed" | "disabled";

export interface SessionJournalOptions {
  directory: string;
  observedSessionId: string;
  writerGeneration: string;
  maxFileBytes: number;
  recordPolicyRevision: string;
}

export interface JournalStatus {
  sinkId: string;
  state: JournalState;
  logicalJournalId: string;
  segmentOrdinal: number;
  recordCount: number;
  serializedBytes: number;
  lostRecords: number;
  reasonCode: string | null;
}

export interface JournalWriteResult {
  written: boolean;
  reasonCode: string | null;
}

function sessionKey(observedSessionId: string): string {
  const sanitized = observedSessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "session";
  const digest = createHash("sha256").update(observedSessionId, "utf8").digest("hex").slice(0, 8);
  return `${sanitized}-${digest}`;
}

export class SessionJournal {
  static open(options: SessionJournalOptions): SessionJournal {
    const key = sessionKey(options.observedSessionId);
    mkdirSync(options.directory, { recursive: true });
    const path = join(options.directory, `${key}.ndjson`);
    const existingBytes = existsSync(path) ? statSync(path).size : 0;
    const descriptor = openSync(path, "a");
    return new SessionJournal(options, key, path, descriptor, existingBytes);
  }

  readonly #options: SessionJournalOptions;
  readonly #key: string;
  readonly #path: string;
  readonly #previousTailState: "absent" | "unknown";
  #descriptor: number;
  #state: JournalState = "healthy";
  #recordCount = 0;
  #serializedBytes = 0;
  #lostRecords = 0;
  #reasonCode: string | null = null;

  private constructor(options: SessionJournalOptions, key: string, path: string, descriptor: number, existingBytes: number) {
    this.#options = options;
    this.#key = key;
    this.#path = path;
    this.#descriptor = descriptor;
    this.#serializedBytes = existingBytes;
    this.#previousTailState = existingBytes > 0 ? "unknown" : "absent";
  }

  get previousTailState(): "absent" | "unknown" {
    return this.#previousTailState;
  }

  get logicalJournalId(): string {
    return `journal-${this.#key}`;
  }

  get path(): string {
    return this.#path;
  }

  get state(): JournalState {
    return this.#state;
  }

  get reasonCode(): string | null {
    return this.#reasonCode;
  }

  get status(): JournalStatus {
    return {
      sinkId: this.logicalJournalId,
      state: this.#state,
      logicalJournalId: this.logicalJournalId,
      segmentOrdinal: 0,
      recordCount: this.#recordCount,
      serializedBytes: this.#serializedBytes,
      lostRecords: this.#lostRecords,
      reasonCode: this.#reasonCode,
    };
  }

  write(record: DiagnosticRecordV1): JournalWriteResult {
    if (this.#state !== "healthy") {
      this.#lostRecords += 1;
      return { written: false, reasonCode: this.#reasonCode ?? "journal-not-open" };
    }
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    if (this.#serializedBytes + bytes > this.#options.maxFileBytes) {
      this.#state = "failed";
      this.#reasonCode = "journal-size-limit";
      this.#lostRecords += 1;
      return { written: false, reasonCode: this.#reasonCode };
    }
    try {
      writeSync(this.#descriptor, line);
    } catch {
      this.#state = "failed";
      this.#reasonCode = "journal-write-failed";
      this.#lostRecords += 1;
      return { written: false, reasonCode: this.#reasonCode };
    }
    this.#recordCount += 1;
    this.#serializedBytes += bytes;
    return { written: true, reasonCode: null };
  }

  /** Flushes and closes the owned descriptor. A failed close is reported, not retried. */
  close(): { flushState: "written" | "failed"; recordCount: number; serializedBytes: number } {
    if (this.#state === "closed") {
      return { flushState: "written", recordCount: this.#recordCount, serializedBytes: this.#serializedBytes };
    }
    let flushState: "written" | "failed" = "written";
    try {
      fsyncSync(this.#descriptor);
    } catch {
      flushState = "failed";
    }
    try {
      closeSync(this.#descriptor);
    } catch {
      flushState = "failed";
    }
    this.#state = "closed";
    if (flushState === "failed") {
      this.#reasonCode = "journal-close-failed";
    }
    return { flushState, recordCount: this.#recordCount, serializedBytes: this.#serializedBytes };
  }
}
