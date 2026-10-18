// Session-owned O1 journal destination.
//
// One logical journal per observed session: a stable active JSONL segment plus
// ordinal closed segments, optional gzip archives and bounded retention. The
// writer owns an exclusive lock, validates the append tail as complete valid
// UTF-8 JSON belonging to this logical session, keeps a bounded queue with
// explicit loss accounting, serializes rotation against records, waits for
// real file completion up to a bounded cleanup deadline, and never treats a
// library flush callback as proof of durability. Raw functional data cannot
// reach this module: callers hand over already-projected O1 records only.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { open, readdir, readFile, rename, stat, unlink, writeFile, type FileHandle } from "node:fs/promises";
import { gunzip, gzip } from "node:zlib";
import { promisify } from "node:util";
import { join } from "node:path";
import type {
  DiagnosticGapData,
  DiagnosticRecordV1,
  JournalClosedData,
  JournalOpenedData,
  JournalRotationData,
  RetentionSettings,
  RetentionSweepData,
  Result,
  SinkHealthData,
} from "./contracts.js";

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const TAIL_WINDOW_BYTES = 131_072;
const HEAD_WINDOW_BYTES = 65_536;
const CLOSE_TIMEOUT_DEFAULT_MS = 2_000;

export interface JournalClock {
  nowMonoMs(): number;
  nowUtc(): string;
  setTimer(delayMs: number, callback: () => void): () => void;
}

export interface JournalEvent {
  opened: JournalOpenedData;
  preclose: { segmentOrdinal: number; recordCount: number; serializedBytes: number; historyCoverage: "complete" | "partial" };
  closed: JournalClosedData;
  rotation: JournalRotationData;
  retention: RetentionSweepData;
  health: SinkHealthData;
  gap: DiagnosticGapData;
}

export interface SessionJournalOptions {
  directory: string;
  observedSessionId: string;
  writerGeneration: string;
  recordPolicyRevision: string;
  maxFileBytes: number;
  rotationIntervalMs: number | null;
  compressArchives: boolean;
  retention: RetentionSettings;
  maxPendingRecords: number;
  maxPendingBytes: number;
  closeTimeoutMs?: number;
  clock: JournalClock;
  emit: <K extends keyof JournalEvent>(kind: K, data: JournalEvent[K]) => void;
  /**
   * Called once the destination handle exists and before the first-opening
   * record is projected, so the owning runtime can assign this journal and
   * route required initial lifecycle/retention evidence into the stream.
   */
  attach?: (journal: SessionJournal) => void;
}

export type JournalState = "healthy" | "degraded" | "failed" | "closed";

export interface JournalStatus {
  sinkId: string;
  logicalJournalId: string;
  state: JournalState;
  activeSegment: number;
  closedSegments: number;
  recordCount: number;
  serializedBytes: number;
  pendingRecords: number;
  pendingBytes: number;
  lostRecords: number;
  reasonCode: string | null;
  historyCoverage: "complete" | "partial";
  lastRotation: { reason: string; at: string } | null;
}

interface SegmentIndexEntry {
  ordinal: number;
  closedAt: string;
  bytes: number;
  compressed: boolean;
  recordCount: number;
}

interface JournalIndex {
  schemaVersion: 1;
  nextOrdinal: number;
  segments: SegmentIndexEntry[];
}

type JournalCommand =
  | { kind: "record"; line: string; bytes: number; lifecycle: boolean; prefix: ReadonlyArray<{ key: string; line: string; bytes: number }>; descriptorKeys: ReadonlyArray<string>; accountedBytes: number }
  | { kind: "rotate"; reason: "size" | "elapsed" }
  | { kind: "sweep" }
  | { kind: "close"; resolve: (result: CloseResult) => void };

interface CloseResult {
  flushState: "written" | "failed";
  recordCount: number;
  serializedBytes: number;
  segmentRecordCount: number;
  segmentBytes: number;
  historyCoverage: "complete" | "partial";
}

interface OwnedFile {
  path: string;
  name: string;
  key: string;
  active: boolean;
  ordinal: number | null;
  compressed: boolean;
  bytes: number;
  closedAtMs: number | null;
  known: boolean;
}

function sessionKey(observedSessionId: string): string {
  const sanitized = observedSessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "session";
  const digest = createHash("sha256").update(observedSessionId, "utf8").digest("hex").slice(0, 8);
  return `${sanitized}-${digest}`;
}

const OWNED_FILE_PATTERN = /^(?<key>[A-Za-z0-9._-]+-[0-9a-f]{8})\.(?<segment>jsonl|p(?<ordinal>\d{8})\.jsonl)(?<gz>\.gz)?$/u;
const INDEX_PATTERN = /^(?<key>[A-Za-z0-9._-]+-[0-9a-f]{8})\.journal-index\.json$/u;

function archiveName(key: string, ordinal: number, compressed: boolean): string {
  return `${key}.p${String(ordinal).padStart(8, "0")}.jsonl${compressed ? ".gz" : ""}`;
}

export class SessionJournal {
  static async open(options: SessionJournalOptions): Promise<Result<SessionJournal>> {
    const journal = new SessionJournal(options);
    return journal.#initialize();
  }

  readonly #options: SessionJournalOptions;
  readonly #key: string;
  readonly #logicalJournalId: string;
  readonly #directory: string;
  readonly #queue: JournalCommand[] = [];
  readonly #index = new Map<number, SegmentIndexEntry>();
  #state: JournalState = "healthy";
  #reasonCode: string | null = null;
  #activeHandle: FileHandle | null = null;
  #activeOrdinal = 1;
  #ordinalHighWater = 0;
  #activeBytes = 0;
  #activeRecords = 0;
  #segmentOpenedMonoMs = 0;
  #totalRecords = 0;
  #totalBytes = 0;
  readonly #segmentDescriptorKeys = new Set<string>();
  #pendingRecords = 0;
  #pendingBytes = 0;
  #lostRecords = 0;
  #lastHealthState: SinkHealthData["state"] = "healthy";
  #lastRotation: { reason: string; at: string } | null = null;
  #rotationTimer: (() => void) | null = null;
  #rotationPending = false;
  #pumping = false;
  #emitting = false;
  #historyPartial = false;
  #closedSegments = 0;
  #closeRequested: ((result: CloseResult) => void) | null = null;
  #closeResolved = false;
  #closeTimedOut = false;
  #sweepPending = false;
  #occupiedEstimate = 0;
  #sweepActiveBytes = 0;
  #pressureBlocked = false;

  private constructor(options: SessionJournalOptions) {
    this.#options = options;
    this.#key = sessionKey(options.observedSessionId);
    this.#logicalJournalId = `journal-${this.#key}`;
    this.#directory = options.directory;
  }

  get logicalJournalId(): string {
    return this.#logicalJournalId;
  }

  get state(): JournalState {
    return this.#state;
  }

  get reasonCode(): string | null {
    return this.#reasonCode;
  }

  get status(): JournalStatus {
    return {
      sinkId: this.#logicalJournalId,
      logicalJournalId: this.#logicalJournalId,
      state: this.#state,
      activeSegment: this.#activeOrdinal,
      closedSegments: this.#closedSegments,
      recordCount: this.#activeRecords,
      serializedBytes: this.#activeBytes,
      pendingRecords: this.#pendingRecords,
      pendingBytes: this.#pendingBytes,
      lostRecords: this.#lostRecords,
      reasonCode: this.#reasonCode,
      historyCoverage: this.#historyPartial || this.#lostRecords > 0 ? "partial" : "complete",
      lastRotation: this.#lastRotation,
    };
  }

  /** Enqueues one already-projected record; the bounded pump never blocks callers. */
  /**
   * Ordinary write. `prefix` carries approved safe descriptor records that must
   * physically precede this record in the same segment; the serialized write
   * path decides rotation and membership, so ordering is not an enqueue-time
   * guess. `descriptorKeys` registers descriptor identities for this segment.
   */
  write(record: DiagnosticRecordV1, prefix: ReadonlyArray<{ key: string; line: string; bytes: number }> = [], descriptorKeys: ReadonlyArray<string> = []): void {
    this.#enqueue(record, false, prefix, descriptorKeys);
  }

  /**
   * Journal lifecycle/health records are required physical evidence, but they
   * must not recursively trigger ordinary size/elapsed rotation of their own
   * output. They are bounded metadata and never become a rotation cause.
   */
  writeLifecycle(record: DiagnosticRecordV1): void {
    this.#enqueue(record, true, [], []);
  }

  #enqueue(record: DiagnosticRecordV1, lifecycle: boolean, prefix: ReadonlyArray<{ key: string; line: string; bytes: number }>, descriptorKeys: ReadonlyArray<string>): void {
    if (this.#state === "closed" || this.#state === "failed") {
      this.#lostRecords += 1;
      return;
    }
    const line = `${JSON.stringify(record)}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    const accountedBytes = bytes + prefix.reduce((n, entry) => n + entry.bytes, 0);
    if (this.#pendingRecords + 1 > this.#options.maxPendingRecords
      || (this.#pendingBytes + accountedBytes > this.#options.maxPendingBytes && this.#pendingRecords > 0)) {
      this.#lostRecords += 1;
      this.#degrade("queue-overflow");
      return;
    }
    this.#queue.push({ kind: "record", line, bytes, lifecycle, prefix, descriptorKeys, accountedBytes });
    this.#pendingRecords += 1;
    this.#pendingBytes += accountedBytes;
    void this.#pump();
  }

  /** Waits until every queued record has reached the file handle. */
  async drain(): Promise<void> {
    await this.#pump();
    while (this.#queue.length > 0 || this.#pumping) {
      await new Promise(resolvePromise => setTimeout(resolvePromise, 5));
      await this.#pump();
    }
  }

  async close(reason: string): Promise<CloseResult> {
    if (this.#state === "closed") {
      return {
        flushState: "written",
        recordCount: this.#totalRecords,
        serializedBytes: this.#totalBytes,
        segmentRecordCount: 0,
        segmentBytes: 0,
        historyCoverage: this.#historyPartial ? "partial" : "complete",
      };
    }
    if (this.#closeTimedOut) {
      // A previous bounded close already returned; do not enqueue a second
      // finalization. Ownership stays with this writer until the real IO
      // settles and the first close completes.
      return {
        flushState: "failed",
        recordCount: this.#totalRecords,
        serializedBytes: this.#totalBytes,
        segmentRecordCount: this.#activeRecords,
        segmentBytes: this.#activeBytes,
        historyCoverage: "partial",
      };
    }
    const closePromise = new Promise<CloseResult>(resolve => {
      this.#queue.push({ kind: "close", resolve });
      void this.#pump();
    });
    const timeoutMs = this.#options.closeTimeoutMs ?? CLOSE_TIMEOUT_DEFAULT_MS;
    const timedOut = await this.#waitWithTimeout(closePromise, timeoutMs);
    this.#disarmRotation();
    if (timedOut) {
      // Bounded cleanup returns control to the host, but logical timeout is not
      // physical termination: exclusive ownership is retained until the real
      // file IO settles and the first close can finalize safely. Queued
      // records stay queued (not counted as loss) and drain afterwards.
      this.#closeTimedOut = true;
      this.#degrade("close-timeout");
      return {
        flushState: "failed",
        recordCount: this.#totalRecords,
        serializedBytes: this.#totalBytes,
        segmentRecordCount: this.#activeRecords,
        segmentBytes: this.#activeBytes,
        historyCoverage: "partial",
      };
    }
    const result = await closePromise;
    return result;
  }

  async #waitWithTimeout(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>(resolvePromise => {
      let settled = false;
      const cancel = this.#options.clock.setTimer(Math.max(0, timeoutMs), () => {
        if (settled) return;
        settled = true;
        resolvePromise(true);
      });
      promise.then(() => {
        if (settled) return;
        settled = true;
        cancel();
        resolvePromise(false);
      }, () => {
        if (settled) return;
        settled = true;
        cancel();
        resolvePromise(false);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Initialization: ownership, tail validation, first segment
  // -------------------------------------------------------------------------

  async #initialize(): Promise<Result<SessionJournal>> {
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
    } catch {
      return { ok: false, error: { code: "core.journal-directory-unavailable", retryable: false } };
    }
    const lockPath = join(this.#directory, `${this.#key}.lock`);
    try {
      await writeFile(lockPath, JSON.stringify({
        generation: this.#options.writerGeneration,
        pid: process.pid,
        startedAt: this.#options.clock.nowUtc(),
      }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return {
        ok: false,
        error: { code: code === "EEXIST" ? "core.journal-owner-conflict" : "core.journal-lock-failed", retryable: false },
      };
    }
    this.#lockPath = lockPath;

    await this.#loadIndex();
    const activePath = join(this.#directory, `${this.#key}.jsonl`);
    let previousTailState: JournalOpenedData["previousTailState"] = "absent";
    let openReason: JournalOpenedData["openReason"] = "session-start";
    if (existsSync(activePath)) {
      const tail = await this.#inspectActiveFile(activePath);
      if (tail.state === "clean") {
        previousTailState = "clean";
      } else {
        // Preserve a damaged, foreign or non-UTF8 segment rather than
        // truncating it; a new segment opens with the next ordinal.
        previousTailState = "damaged";
        openReason = "tail-repair";
        this.#historyPartial = true;
        const repairOrdinal = this.#allocateOrdinal();
        const repairPath = join(this.#directory, archiveName(this.#key, repairOrdinal, false));
        try {
          await rename(activePath, repairPath);
          const repairBytes = (await stat(repairPath)).size;
          this.#index.set(repairOrdinal, {
            ordinal: repairOrdinal,
            closedAt: this.#options.clock.nowUtc(),
            bytes: repairBytes,
            compressed: false,
            recordCount: 0,
          });
          this.#closedSegments = this.#index.size;
        } catch {
          // A failed quarantine must not fall through to appending after the
          // damaged bytes. Preserve the original file and stop unsafe writer
          // admission instead.
          await this.#releaseLock();
          return { ok: false, error: { code: "core.journal-quarantine-failed", retryable: false } };
        }
        this.#lastRotation = { reason: "tail-repair", at: this.#options.clock.nowUtc() };
      }
    }
    this.#segmentDescriptorKeys.clear();
    this.#activeOrdinal = this.#allocateOrdinal();
    try {
      this.#activeHandle = await open(activePath, "a", 0o600);
      const stats = await this.#activeHandle.stat();
      this.#activeBytes = stats.size;
      this.#segmentOpenedMonoMs = this.#options.clock.nowMonoMs();
    } catch {
      await this.#releaseLock();
      return { ok: false, error: { code: "core.journal-open-failed", retryable: false } };
    }
    await this.#saveIndex();
    this.#options.attach?.(this);
    this.#emit("opened", {
      logicalJournalId: this.#logicalJournalId,
      segmentOrdinal: this.#activeOrdinal,
      writerGeneration: this.#options.writerGeneration,
      previousSegmentOrdinal: previousTailState === "absent" ? null : this.#activeOrdinal - 1,
      openReason,
      previousTailState,
      recordPolicyRevision: this.#options.recordPolicyRevision,
    });
    this.#armRotation();
    await this.#detectUnknownOwnedFiles();
    await this.#sweepRetention("startup");
    return { ok: true, value: this };
  }

  #lockPath: string | null = null;

  /**
   * Reads the active file with bounded windows and establishes whether it ends
   * with a complete, valid UTF-8 JSON record belonging to this session. A bare
   * LF is not proof: the final complete line is parsed, and the first record's
   * logical identity is checked before any append.
   */
  async #inspectActiveFile(path: string): Promise<{ state: "clean" | "damaged" }> {
    let handle: FileHandle | null = null;
    try {
      handle = await open(path, "r");
      const stats = await handle.stat();
      if (stats.size === 0) return { state: "clean" };
      const headLength = Math.min(stats.size, HEAD_WINDOW_BYTES);
      const head = Buffer.alloc(headLength);
      await handle.read(head, 0, headLength, 0);
      if (head.length >= 3 && head[0] === 0xEF && head[1] === 0xBB && head[2] === 0xBF) return { state: "damaged" };
      const headText = this.#decodeUtf8(head);
      if (headText === null) return { state: "damaged" };
      const firstLineEnd = headText.indexOf("\n");
      if (firstLineEnd === -1 && stats.size <= HEAD_WINDOW_BYTES) return { state: "damaged" };
      const firstLine = firstLineEnd === -1 ? "" : headText.slice(0, firstLineEnd);
      if (!this.#recordBelongsToSession(firstLine)) return { state: "damaged" };

      const tailLength = Math.min(stats.size, TAIL_WINDOW_BYTES);
      const tail = Buffer.alloc(tailLength);
      await handle.read(tail, 0, tailLength, stats.size - tailLength);
      if (tail[tail.length - 1] !== 0x0A) return { state: "damaged" };
      const tailText = this.#decodeUtf8(tail);
      if (tailText === null) return { state: "damaged" };
      const withoutFinalNewline = tailText.slice(0, -1);
      const lastNewline = withoutFinalNewline.lastIndexOf("\n");
      const lastLine = withoutFinalNewline.slice(lastNewline + 1);
      if (lastLine.length === 0) return { state: "damaged" };
      return this.#validRecordLine(lastLine) ? { state: "clean" } : { state: "damaged" };
    } catch {
      return { state: "damaged" };
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // Closing a read handle that failed to stat changes nothing.
        }
      }
    }
  }

  #decodeUtf8(bytes: Buffer): string | null {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return null;
    }
  }

  #validRecordLine(line: string): boolean {
    try {
      const parsed: unknown = JSON.parse(line);
      return typeof parsed === "object" && parsed !== null;
    } catch {
      return false;
    }
  }

  #recordBelongsToSession(line: string): boolean {
    try {
      const parsed = JSON.parse(line) as { observedSessionId?: unknown };
      return parsed.observedSessionId === this.#options.observedSessionId;
    } catch {
      return false;
    }
  }

  #allocateOrdinal(): number {
    this.#ordinalHighWater += 1;
    return this.#ordinalHighWater;
  }

  async #loadIndex(): Promise<void> {
    const indexPath = join(this.#directory, `${this.#key}.journal-index.json`);
    try {
      const parsed = JSON.parse(await readFile(indexPath, "utf8")) as JournalIndex;
      for (const entry of parsed.segments ?? []) {
        if (typeof entry.ordinal === "number" && typeof entry.closedAt === "string" && typeof entry.bytes === "number") {
          this.#index.set(entry.ordinal, {
            ordinal: entry.ordinal,
            closedAt: entry.closedAt,
            bytes: entry.bytes,
            compressed: entry.compressed === true,
            recordCount: typeof entry.recordCount === "number" ? entry.recordCount : 0,
          });
        }
      }
      if (typeof parsed.nextOrdinal === "number" && Number.isFinite(parsed.nextOrdinal)) {
        this.#ordinalHighWater = Math.max(this.#ordinalHighWater, parsed.nextOrdinal - 1);
      }
      this.#closedSegments = this.#index.size;
    } catch {
      // A missing or unreadable index means no owned segment is eligible for
      // age-based cleanup until a fresh index is written.
    }
    try {
      const names = await readdir(this.#directory);
      for (const name of names) {
        const match = OWNED_FILE_PATTERN.exec(name);
        if (match !== null && match.groups?.["key"] === this.#key && match.groups?.["ordinal"] !== undefined) {
          this.#ordinalHighWater = Math.max(this.#ordinalHighWater, Number(match.groups["ordinal"]));
        }
      }
    } catch {
      this.#historyPartial = true;
    }
  }

  async #saveIndex(): Promise<void> {
    const indexPath = join(this.#directory, `${this.#key}.journal-index.json`);
    const tempPath = `${indexPath}.tmp`;
    const payload: JournalIndex = {
      schemaVersion: 1,
      nextOrdinal: this.#ordinalHighWater + 1,
      segments: [...this.#index.values()],
    };
    try {
      await writeFile(tempPath, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, indexPath);
    } catch {
      this.#degrade("index-write-failed");
    }
  }

  async #releaseLock(): Promise<void> {
    if (this.#lockPath === null) return;
    const lockPath = this.#lockPath;
    this.#lockPath = null;
    try {
      await unlink(lockPath);
    } catch {
      // A failed lock release is reported through status, never retried
      // forever and never authorizes another writer to take over.
      this.#reasonCode ??= "lock-release-failed";
    }
  }

  // -------------------------------------------------------------------------
  // Bounded pump: records, rotation, retention and close are serialized here.
  // -------------------------------------------------------------------------

  async #pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      for (;;) {
        const command = this.#queue.shift();
        if (command === undefined) {
          if (this.#closeRequested !== null && !this.#closeResolved) {
            const resolve = this.#closeRequested;
            const result = await this.#finalize();
            this.#closeResolved = true;
            this.#state = "closed";
            await this.#sweepRetention("session-close");
            await this.#releaseLock();
            // Resolve only after ownership is released so a reopen cannot race
            // the still-present lock file.
            resolve(result);
          }
          break;
        }
        if (command.kind === "record") {
          this.#pendingRecords -= 1;
          this.#pendingBytes -= command.accountedBytes;
          await this.#writeRecord(command.line, command.bytes, command.lifecycle, command.prefix, command.descriptorKeys);
        } else if (command.kind === "rotate") {
          await this.#rotate(command.reason);
        } else if (command.kind === "sweep") {
          this.#sweepPending = false;
          await this.#sweepRetention("pressure");
        } else {
          this.#closeRequested = command.resolve;
          // A pre-close marker reports only bytes/records known before the
          // marker; it is written through the normal projected path and then
          // sealed with the segment.
          if (this.#state !== "failed" && this.#activeHandle !== null) {
            this.#emit("preclose", {
              segmentOrdinal: this.#activeOrdinal,
              recordCount: this.#activeRecords,
              serializedBytes: this.#activeBytes,
              historyCoverage: this.#historyPartial || this.#lostRecords > 0 ? "partial" : "complete",
            });
          }
        }
      }
    } finally {
      this.#pumping = false;
    }
  }

  /** Writes one encoded record to completion; false means it was lost. */
  async #appendEncoded(line: string, bytes: number): Promise<boolean> {
    if (this.#activeHandle === null) {
      this.#lostRecords += 1;
      return false;
    }
    try {
      // A short FileHandle acknowledgement is not a completed record: write
      // the encoded bytes to completion (or fail the record), never count a
      // partial write as full serialized bytes.
      const buffer = Buffer.from(line, "utf8");
      let offset = 0;
      while (offset < buffer.length) {
        const outcome = await this.#activeHandle.write(buffer, offset, buffer.length - offset);
        if (!Number.isInteger(outcome.bytesWritten) || outcome.bytesWritten <= 0) {
          throw new Error("short write acknowledgement");
        }
        offset += outcome.bytesWritten;
      }
      this.#activeBytes += bytes;
      this.#activeRecords += 1;
      this.#totalRecords += 1;
      this.#totalBytes += bytes;
      return true;
    } catch {
      this.#lostRecords += 1;
      this.#degrade("write-failed");
      return false;
    }
  }

  async #writeRecord(line: string, bytes: number, lifecycle = false, prefix: ReadonlyArray<{ key: string; line: string; bytes: number }> = [], descriptorKeys: ReadonlyArray<string> = []): Promise<void> {
    if (this.#state === "failed" || this.#activeHandle === null) {
      this.#lostRecords += 1;
      return;
    }
    // Reference-local preparation: only descriptors actually referenced by this
    // record are required, and they must physically precede it in the SAME
    // segment. The rotation decision comes FIRST and includes the prefix bytes;
    // membership is then resolved against the segment that will actually
    // receive the group, so a record can never land in a fresh segment without
    // the descriptors it references.
    if (!lifecycle) {
      const candidates = prefix.filter(entry => !this.#segmentDescriptorKeys.has(entry.key));
      const candidateBytes = candidates.reduce((n, entry) => n + entry.bytes, 0);
      if (this.#activeBytes > 0 && this.#activeBytes + candidateBytes + bytes > this.#options.maxFileBytes) {
        await this.#rotate("size");
      }
      if (this.#activeHandle === null) {
        this.#lostRecords += 1;
        return;
      }
      const needed = prefix.filter(entry => !this.#segmentDescriptorKeys.has(entry.key));
      for (const entry of needed) {
        if (!await this.#appendEncoded(entry.line, entry.bytes)) return;
        this.#segmentDescriptorKeys.add(entry.key);
      }
      if (!await this.#appendEncoded(line, bytes)) return;
      for (const key of descriptorKeys) this.#segmentDescriptorKeys.add(key);
    } else {
      if (this.#activeHandle === null) {
        this.#lostRecords += 1;
        return;
      }
      if (!await this.#appendEncoded(line, bytes)) return;
    }
    if (lifecycle || this.#rotationPending) return;
    // Storage pressure is detected from the last known directory occupancy
    // plus this writer's growth since that sweep. A sweep is coalesced, and a
    // sweep that could not remove anything stops re-arming until the next
    // closure/rotation pass.
    const estimate = this.#occupiedEstimate + (this.#activeBytes - this.#sweepActiveBytes);
    if (!this.#sweepPending && !this.#pressureBlocked && estimate > this.#options.retention.maxStorageBytes) {
      this.#sweepPending = true;
      this.#queue.push({ kind: "sweep" });
    }
    const interval = this.#options.rotationIntervalMs;
    if (this.#activeBytes >= this.#options.maxFileBytes
      || (interval !== null && this.#options.clock.nowMonoMs() - this.#segmentOpenedMonoMs >= interval)) {
      this.#rotationPending = true;
      this.#queue.push({ kind: "rotate", reason: this.#activeBytes >= this.#options.maxFileBytes ? "size" : "elapsed" });
    }
  }

  #armRotation(): void {
    this.#disarmRotation();
    const interval = this.#options.rotationIntervalMs;
    if (interval === null || this.#state === "closed" || this.#state === "failed") return;
    this.#rotationTimer = this.#options.clock.setTimer(interval, () => {
      this.#rotationTimer = null;
      if (this.#state === "closed" || this.#state === "failed") return;
      if (!this.#rotationPending) {
        this.#rotationPending = true;
        this.#queue.push({ kind: "rotate", reason: "elapsed" });
      }
      void this.#pump();
    });
  }

  #disarmRotation(): void {
    if (this.#rotationTimer !== null) {
      this.#rotationTimer();
      this.#rotationTimer = null;
    }
  }

  async #rotate(reason: JournalRotationData["reason"], segmentOrdinal = this.#activeOrdinal): Promise<void> {
    if (this.#state === "failed" || this.#activeHandle === null) return;
    const observedBytes = this.#activeBytes;
    const observedRecords = this.#activeRecords;
    let flushState: "written" | "failed" = "written";
    try {
      await this.#activeHandle.sync();
      await this.#activeHandle.close();
    } catch {
      flushState = "failed";
    }
    this.#activeHandle = null;
    this.#rotationPending = false;
    const plainPath = join(this.#directory, `${this.#key}.jsonl`);
    let targetPath = join(this.#directory, archiveName(this.#key, segmentOrdinal, false));
    let archiveCompression: JournalRotationData["archiveCompression"] = "none";
    let outcome: JournalRotationData["outcome"] = "completed";
    try {
      await rename(plainPath, targetPath);
      if (this.#options.compressArchives) {
        try {
          const raw = await readFile(targetPath);
          const compressed = await gzipAsync(raw);
          const tempPath = `${targetPath}.gz.tmp`;
          await writeFile(tempPath, compressed, { mode: 0o600 });
          const roundTrip = await gunzipAsync(await readFile(tempPath));
          if (!roundTrip.equals(raw)) throw new Error("gzip round-trip mismatch");
          const gzPath = `${targetPath}.gz`;
          await rename(tempPath, gzPath);
          await unlink(targetPath);
          targetPath = gzPath;
          archiveCompression = "gzip";
        } catch {
          // The complete uncompressed segment is preserved; compression
          // failure is visible and never destroys the only copy.
          archiveCompression = "failed";
          this.#degrade("compression-failed");
        }
      }
      const archiveBytes = (await stat(targetPath)).size;
      this.#index.set(segmentOrdinal, {
        ordinal: segmentOrdinal,
        closedAt: this.#options.clock.nowUtc(),
        bytes: archiveBytes,
        compressed: archiveCompression === "gzip",
        recordCount: observedRecords,
      });
      this.#closedSegments = this.#index.size;
      await this.#saveIndex();
    } catch {
      outcome = "failed";
      this.#degrade("rotation-failed");
      await this.#saveIndex();
    }
    this.#segmentDescriptorKeys.clear();
    this.#activeOrdinal = this.#allocateOrdinal();
    this.#activeBytes = 0;
    this.#activeRecords = 0;
    this.#segmentOpenedMonoMs = this.#options.clock.nowMonoMs();
    try {
      this.#activeHandle = await open(plainPath, "a", 0o600);
    } catch {
      this.#degrade("open-failed");
      return;
    }
    await this.#saveIndex();
    this.#emit("opened", {
      logicalJournalId: this.#logicalJournalId,
      segmentOrdinal: this.#activeOrdinal,
      writerGeneration: this.#options.writerGeneration,
      previousSegmentOrdinal: segmentOrdinal,
      openReason: "rotation",
      previousTailState: "clean",
      recordPolicyRevision: this.#options.recordPolicyRevision,
    });
    // Post-close markers report the actual completed file and reach the new
    // segment through the normal projected path.
    this.#emit("closed", {
      logicalJournalId: this.#logicalJournalId,
      segmentOrdinal,
      closeReason: reason,
      recordCount: observedRecords,
      serializedBytes: observedBytes,
      flushState,
      historyCoverage: this.#historyPartial || this.#lostRecords > 0 ? "partial" : "complete",
    });
    this.#emit("rotation", {
      fromSegment: segmentOrdinal,
      toSegment: this.#activeOrdinal,
      reason,
      thresholdBytes: reason === "size" || reason === "elapsed" ? this.#options.maxFileBytes : null,
      observedBytes,
      archiveCompression,
      outcome,
    });
    this.#lastRotation = { reason, at: this.#options.clock.nowUtc() };
    this.#armRotation();
    await this.#sweepRetention(reason);
  }

  async #finalize(): Promise<CloseResult> {
    this.#disarmRotation();
    let flushState: "written" | "failed" = "written";
    if (this.#activeHandle !== null) {
      try {
        await this.#activeHandle.sync();
        await this.#activeHandle.close();
      } catch {
        flushState = "failed";
      }
      this.#activeHandle = null;
    }
    if (this.#activeBytes > 0) {
      const activePath = join(this.#directory, `${this.#key}.jsonl`);
      try {
        await rename(activePath, join(this.#directory, archiveName(this.#key, this.#activeOrdinal, false)));
        this.#index.set(this.#activeOrdinal, {
          ordinal: this.#activeOrdinal,
          closedAt: this.#options.clock.nowUtc(),
          bytes: this.#activeBytes,
          compressed: false,
          recordCount: this.#activeRecords,
        });
        this.#closedSegments = this.#index.size;
        await this.#saveIndex();
      } catch {
        this.#historyPartial = true;
      }
    }
    return {
      flushState,
      recordCount: this.#totalRecords,
      serializedBytes: this.#totalBytes,
      segmentRecordCount: this.#activeRecords,
      segmentBytes: this.#activeBytes,
      historyCoverage: this.#historyPartial || this.#lostRecords > 0 ? "partial" : "complete",
    };
  }

  // -------------------------------------------------------------------------
  // Retention: configured-root occupied bytes over owned closed history. Live
  // active segments, unknown files and lock owners are counted but never
  // deletion candidates.
  // -------------------------------------------------------------------------

  async #discoverOwnedFiles(): Promise<OwnedFile[]> {
    const files: OwnedFile[] = [];
    let names: string[];
    try {
      names = await readdir(this.#directory);
    } catch {
      this.#historyPartial = true;
      return files;
    }
    const foreignClosure = await this.#loadForeignClosureTimes(names);
    for (const name of names) {
      const match = OWNED_FILE_PATTERN.exec(name);
      if (match === null) continue;
      const key = match.groups?.["key"];
      if (key === undefined) continue;
      const ordinalText = match.groups?.["ordinal"];
      const path = join(this.#directory, name);
      let bytes = 0;
      try {
        const stats = await stat(path);
        if (!stats.isFile()) continue;
        bytes = stats.size;
      } catch {
        continue;
      }
      const compressed = name.endsWith(".gz");
      const knownEntry = key === this.#key
        ? this.#index.get(Number(ordinalText ?? -1))
        : foreignClosure.get(`${key}:${ordinalText === undefined ? "active" : Number(ordinalText)}`);
      const closedAtMs = knownEntry !== undefined && knownEntry !== null ? Date.parse(knownEntry.closedAt) : Number.NaN;
      files.push({
        path,
        name,
        key,
        active: ordinalText === undefined,
        ordinal: ordinalText === undefined ? null : Number(ordinalText),
        compressed,
        bytes,
        closedAtMs: Number.isFinite(closedAtMs) ? closedAtMs : null,
        known: knownEntry !== undefined && knownEntry !== null,
      });
    }
    return files.sort((left, right) => (left.closedAtMs ?? 0) - (right.closedAtMs ?? 0)
      || (left.key + String(left.ordinal ?? "")).localeCompare(right.key + String(right.ordinal ?? "")));
  }

  async #loadForeignClosureTimes(names: readonly string[]): Promise<Map<string, SegmentIndexEntry>> {
    const entries = new Map<string, SegmentIndexEntry>();
    for (const name of names) {
      const match = INDEX_PATTERN.exec(name);
      if (match === null) continue;
      const key = match.groups?.["key"];
      if (key === undefined || key === this.#key) continue;
      try {
        const parsed = JSON.parse(await readFile(join(this.#directory, name), "utf8")) as JournalIndex;
        for (const entry of parsed.segments ?? []) {
          if (typeof entry.ordinal === "number" && typeof entry.closedAt === "string") {
            entries.set(`${key}:${Number(entry.ordinal)}`, entry);
          }
        }
      } catch {
        // Incomplete foreign metadata leaves its files preserved.
        this.#historyPartial = true;
      }
    }
    return entries;
  }

  async #sweepRetention(_reason: string): Promise<void> {
    const retention = this.#options.retention;
    const discovery = await this.#discoverOwnedFiles();
    let eligibleFiles = 0;
    let removedFiles = 0;
    let removedBytes = 0;
    let occupied = discovery.reduce((sum, file) => sum + file.bytes, 0);
    const unknownOwned = discovery.some(file => !file.active && !file.known);
    if (unknownOwned) this.#historyPartial = true;
    const isProtected = (file: OwnedFile): boolean => {
      if (file.key === this.#key) {
        // The current writer's stable active basename is never a candidate.
        return file.active;
      }
      return existsSync(join(this.#directory, `${file.key}.lock`));
    };
    const candidates = discovery.filter(file => !file.active && file.known && file.closedAtMs !== null && !isProtected(file));
    eligibleFiles = candidates.length;
    // Age, count and directory pressure share one finite attempt per path in
    // this pass. A failed/changed candidate is not a reason to busy-retry it.
    const attempted = new Set<string>();
    const remove = async (file: OwnedFile): Promise<boolean> => {
      if (attempted.has(file.path)) return false;
      attempted.add(file.path);
      // Revalidate before unlinking: the file must still be a closed owned
      // segment and no resumed session may have taken ownership meanwhile.
      if (file.key !== this.#key && existsSync(join(this.#directory, `${file.key}.lock`))) return false;
      try {
        const stats = await stat(file.path);
        if (!stats.isFile()) {
          this.#historyPartial = true;
          return false;
        }
      } catch {
        this.#historyPartial = true;
        return false;
      }
      try {
        await unlink(file.path);
        removedFiles += 1;
        removedBytes += file.bytes;
        occupied -= file.bytes;
        if (file.key === this.#key && file.ordinal !== null) {
          this.#index.delete(file.ordinal);
        }
        return true;
      } catch {
        this.#historyPartial = true;
        return false;
      }
    };
    const nowMs = Date.parse(this.#options.clock.nowUtc());
    if (candidates.some(file => file.closedAtMs !== null && file.closedAtMs > nowMs)) {
      // Closure time in the future means the wall clock moved backward; age
      // cannot be established, so uncertain files are preserved and the
      // maintenance result reports partial/unknown coverage.
      this.#historyPartial = true;
    }
    for (const file of [...candidates]) {
      if (file.closedAtMs === null) continue;
      const age = nowMs - file.closedAtMs;
      if (Number.isFinite(age) && age > retention.maxAgeMs) await remove(file);
    }
    // Per-session archive count applies to this writer's logical session.
    for (;;) {
      const ownClosed = [...this.#index.values()]
        .filter(entry => existsSync(join(this.#directory, archiveName(this.#key, entry.ordinal, entry.compressed))));
      if (ownClosed.length <= retention.maxArchivesPerSession) break;
      ownClosed.sort((left, right) => Date.parse(left.closedAt) - Date.parse(right.closedAt) || left.ordinal - right.ordinal);
      const oldest = ownClosed[0];
      if (oldest === undefined) break;
      const file = discovery.find(entry => entry.key === this.#key && entry.ordinal === oldest.ordinal);
      if (file === undefined) {
        // Discovery/revalidation was inconclusive: preserve the index rather
        // than inventing a deletion to make the count appear satisfied.
        this.#historyPartial = true;
        break;
      }
      if (!await remove(file)) break;
    }
    if (occupied > retention.maxStorageBytes) {
      const ordered = [...candidates]
        .filter(file => (file.key === this.#key ? this.#index.has(file.ordinal ?? -1) : existsSync(file.path)))
        .sort((left, right) => (left.closedAtMs ?? 0) - (right.closedAtMs ?? 0) || (left.key + String(left.ordinal ?? "")).localeCompare(right.key + String(right.ordinal ?? "")));
      for (const file of ordered) {
        if (occupied <= retention.maxStorageBytes) break;
        await remove(file);
      }
    }
    if (removedFiles > 0) {
      await this.#saveIndex();
      this.#closedSegments = this.#index.size;
    }
    const overTargetReason: RetentionSweepData["overTargetReason"] = occupied > retention.maxStorageBytes ? "active-data" : "none";
    this.#occupiedEstimate = Math.max(0, occupied);
    this.#sweepActiveBytes = this.#activeBytes;
    this.#pressureBlocked = occupied > retention.maxStorageBytes && removedFiles === 0;
    this.#emit("retention", {
      scope: "closed-journal-history",
      eligibleFiles,
      removedFiles,
      removedBytes,
      remainingOwnedBytes: Math.max(0, occupied),
      targetBytes: retention.maxStorageBytes,
      overTargetReason,
      historyCoverage: this.#historyPartial ? "partial" : "complete",
    });
  }

  async #detectUnknownOwnedFiles(): Promise<void> {
    try {
      const files = await this.#discoverOwnedFiles();
      const presentOrdinals = new Set(files.filter(file => file.key === this.#key && !file.active).map(file => file.ordinal));
      // The index can outlive deleted diagnostics. Missing indexed segments are
      // history loss, not a fresh complete journal or a new financial scope.
      if (files.some(file => !file.active && !file.known)
        || [...this.#index.keys()].some(ordinal => !presentOrdinals.has(ordinal))) this.#historyPartial = true;
    } catch {
      this.#historyPartial = true;
    }
  }

  #degrade(reasonCode: string): void {
    if (this.#state === "healthy") this.#state = "degraded";
    this.#reasonCode = reasonCode;
    this.#emitHealth();
  }

  #emitHealth(): void {
    const state: SinkHealthData["state"] = this.#state === "failed" ? "failed" : this.#state === "degraded" ? "degraded" : "healthy";
    if (state === this.#lastHealthState) return;
    const previousState = this.#lastHealthState;
    this.#lastHealthState = state;
    this.#emit("health", {
      sinkId: this.#logicalJournalId,
      previousState,
      state,
      queuedRecords: this.#pendingRecords,
      queuedBytes: this.#pendingBytes,
      lostRecords: this.#lostRecords,
      reasonCode: this.#reasonCode ?? "unknown",
    });
  }

  #emit<K extends keyof JournalEvent>(kind: K, data: JournalEvent[K]): void {
    if (this.#emitting) return;
    this.#emitting = true;
    try {
      this.#options.emit(kind, data);
    } catch {
      // A failing diagnostic projection must never break the journal pump.
    } finally {
      this.#emitting = false;
    }
  }
}
