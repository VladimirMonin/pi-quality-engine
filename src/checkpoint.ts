// Functional control checkpoint (O1 section 14).
//
// The checkpoint is the small protected control-state file that survives
// reloads and diagnostic-sink changes. It stores identity, stop/pause
// authority, the accepted authorization revision and a monotonic revision
// only - never prompt, source, tool or model bodies.
//
// Ownership is independent of the optional diagnostic journal: the first
// writer holds an exclusive local lock and a conflicting writer remains
// inspect-only. Writes are serialized, use temp-file + rename, and close every
// handle on every path. A directory fsync is attempted where the platform
// supports it; an unsupported directory sync is not a failed commitment. A
// missing checkpoint with prior session evidence fails closed instead of
// resetting operator Stop.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

const CHECKPOINT_MAX_BYTES = 65_536;

/** Directory sync errors that mean "the platform does not offer it here". */
const UNSUPPORTED_DIRECTORY_SYNC = new Set(["EPERM", "EACCES", "EISDIR", "EINVAL", "ENOTSUP", "ENOSYS", "EBADF"]);

export interface CheckpointClock {
  nowUtc(): string;
}

export interface ControlCheckpointState {
  schemaVersion: 1;
  observedSessionId: string;
  ownerGeneration: string;
  operatorStopped: boolean;
  observerPaused: boolean;
  authorizationRevision: string;
  configurationRevision: string;
  revision: number;
  updatedAt: string;
}

export interface ControlCheckpointCommit {
  ok: boolean;
  revision: number;
  serializedBytes: number;
  durationMs: number;
  errorCode: string | null;
}

export interface ControlCheckpointOpen {
  checkpoint: ControlCheckpoint;
  owned: boolean;
  restored: boolean;
  operatorStopped: boolean;
  observerPaused: boolean;
  authorizationRevision: string | null;
  degraded: boolean;
  errorCode: string | null;
}

function sessionKey(observedSessionId: string): string {
  const sanitized = observedSessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "session";
  const digest = createHash("sha256").update(observedSessionId, "utf8").digest("hex").slice(0, 8);
  return `${sanitized}-${digest}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Any owned evidence that this logical session existed before this generation. */
function priorSessionEvidence(agentDir: string, key: string): boolean {
  const stateDirectory = join(agentDir, "quality", "state");
  const logsDirectory = join(agentDir, "quality", "logs");
  if (existsSync(join(stateDirectory, `${key}.lock`))) return true;
  const patterns = [
    new RegExp(`^${key}\\.p\\d{8}\\.jsonl(?:\\.gz)?$`),
    new RegExp(`^${key}\\.jsonl$`),
    new RegExp(`^${key}\\.journal-index\\.json$`),
  ];
  try {
    for (const name of readdirSync(logsDirectory)) {
      if (patterns.some(pattern => pattern.test(name))) return true;
    }
  } catch {
    // A missing log directory means no journal evidence.
  }
  return false;
}

export class ControlCheckpoint {
  static async open(options: {
    agentDir: string;
    observedSessionId: string;
    ownerGeneration: string;
    configurationRevision: string;
    clock: CheckpointClock;
  }): Promise<ControlCheckpointOpen> {
    const directory = join(options.agentDir, "quality", "state");
    const key = sessionKey(options.observedSessionId);
    const path = join(directory, `${key}.json`);
    const lockPath = join(directory, `${key}.lock`);
    const evidenceBefore = priorSessionEvidence(options.agentDir, key);
    let restored = false;
    let operatorStopped = false;
    let observerPaused = false;
    let authorizationRevision: string | null = null;
    let degraded = false;
    let errorCode: string | null = null;
    let revision = 0;
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
      if (isPlainObject(parsed)
        && parsed["schemaVersion"] === 1
        && parsed["observedSessionId"] === options.observedSessionId
        && typeof parsed["revision"] === "number"
        && typeof parsed["operatorStopped"] === "boolean"
        && typeof parsed["observerPaused"] === "boolean") {
        restored = true;
        operatorStopped = parsed["operatorStopped"];
        observerPaused = parsed["observerPaused"];
        revision = parsed["revision"];
        authorizationRevision = typeof parsed["authorizationRevision"] === "string" ? parsed["authorizationRevision"] : null;
      } else {
        // Unreadable control state must not silently resume; keep the
        // conservative stop and surface the corruption.
        degraded = true;
        errorCode = "core.control-checkpoint-invalid";
        operatorStopped = true;
        observerPaused = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (evidenceBefore) {
          // A previous generation of this session left evidence but the
          // protected state is gone: fail closed rather than clearing Stop.
          degraded = true;
          errorCode = "core.control-checkpoint-missing";
          operatorStopped = true;
          observerPaused = true;
        }
      } else {
        degraded = true;
        errorCode = "core.control-checkpoint-unreadable";
        operatorStopped = true;
        observerPaused = true;
      }
    }
    let owned = false;
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      await writeFile(lockPath, JSON.stringify({
        generation: options.ownerGeneration,
        pid: process.pid,
        startedAt: options.clock.nowUtc(),
      }), { encoding: "utf8", flag: "wx", mode: 0o600 });
      owned = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        owned = false;
        errorCode ??= "core.control-owner-conflict";
      } else {
        degraded = true;
        errorCode = "core.control-directory-unavailable";
      }
    }
    return {
      checkpoint: new ControlCheckpoint(path, directory, lockPath, key, options, revision, owned, authorizationRevision),
      owned,
      restored,
      operatorStopped,
      observerPaused,
      authorizationRevision,
      degraded,
      errorCode,
    };
  }

  readonly #path: string;
  readonly #directory: string;
  readonly #lockPath: string;
  readonly #key: string;
  readonly #options: { observedSessionId: string; ownerGeneration: string; configurationRevision: string; clock: CheckpointClock };
  #revision: number;
  #closed = false;
  #stop = false;
  #paused = false;
  #authorizationRevision = "auth-0";
  #degraded = false;
  #errorCode: string | null = null;
  #counter = 0;
  #commitChain: Promise<unknown> = Promise.resolve();
  readonly #ownsLock: boolean;

  private constructor(
    path: string,
    directory: string,
    lockPath: string,
    key: string,
    options: { observedSessionId: string; ownerGeneration: string; configurationRevision: string; clock: CheckpointClock },
    revision: number,
    ownsLock: boolean,
    authorizationRevision: string | null,
  ) {
    this.#ownsLock = ownsLock;
    if (authorizationRevision !== null) this.#authorizationRevision = authorizationRevision;
    this.#path = path;
    this.#directory = directory;
    this.#lockPath = lockPath;
    this.#key = key;
    this.#options = options;
    this.#revision = revision;
  }

  get key(): string {
    return this.#key;
  }

  get revision(): number {
    return this.#revision;
  }

  get degraded(): boolean {
    return this.#degraded;
  }

  get errorCode(): string | null {
    return this.#errorCode;
  }

  get operatorStopped(): boolean {
    return this.#stop;
  }

  get observerPaused(): boolean {
    return this.#paused;
  }

  get protectedStateRef(): string {
    return `control-${this.#key}@${this.#revision}`;
  }

  setLocalState(state: {
    operatorStopped: boolean;
    observerPaused: boolean;
    authorizationRevision?: string;
    configurationRevision?: string;
  }): void {
    this.#stop = state.operatorStopped;
    this.#paused = state.observerPaused;
    if (state.authorizationRevision !== undefined) this.#authorizationRevision = state.authorizationRevision;
    if (state.configurationRevision !== undefined) {
      this.#options.configurationRevision = state.configurationRevision;
    }
  }

  /**
   * Commits the control state atomically. Returns a failed result when the
   * protected destination could not be committed; callers must then suspend
   * dependent autonomy instead of pretending the state is safe. Commits are
   * serialized so concurrent stop/reload/retire paths cannot corrupt one
   * another or abandon an open handle.
   */
  async commit(): Promise<ControlCheckpointCommit> {
    const run = this.#commitChain.then(() => this.#commitOnce());
    this.#commitChain = run.then(() => undefined, () => undefined);
    return run;
  }

  async #commitOnce(): Promise<ControlCheckpointCommit> {
    const startedMono = performance.now();
    if (this.#closed) {
      return { ok: false, revision: this.#revision, serializedBytes: 0, durationMs: 0, errorCode: "core.control-checkpoint-closed" };
    }
    if (!this.#ownsLock) {
      // An inspect-only instance must never write into another owner's
      // protected control state.
      return { ok: false, revision: this.#revision, serializedBytes: 0, durationMs: 0, errorCode: "core.control-not-owner" };
    }
    this.#revision += 1;
    const payload: ControlCheckpointState = {
      schemaVersion: 1,
      observedSessionId: this.#options.observedSessionId,
      ownerGeneration: this.#options.ownerGeneration,
      operatorStopped: this.#stop,
      observerPaused: this.#paused,
      authorizationRevision: this.#authorizationRevision,
      configurationRevision: this.#options.configurationRevision,
      revision: this.#revision,
      updatedAt: this.#options.clock.nowUtc(),
    };
    const serialized = JSON.stringify(payload);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    if (serializedBytes > CHECKPOINT_MAX_BYTES) {
      this.#degrade("core.control-checkpoint-overflow");
      return { ok: false, revision: this.#revision, serializedBytes, durationMs: performance.now() - startedMono, errorCode: "core.control-checkpoint-overflow" };
    }
    this.#counter += 1;
    const tempPath = join(this.#directory, `.${this.#key}.json.${process.pid}.${this.#counter}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(tempPath, "w", 0o600);
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(tempPath, this.#path);
      await this.#syncDirectory();
      this.#degraded = false;
      this.#errorCode = null;
      return { ok: true, revision: this.#revision, serializedBytes, durationMs: performance.now() - startedMono, errorCode: null };
    } catch {
      this.#degrade("core.control-checkpoint-commit-failed");
      return { ok: false, revision: this.#revision, serializedBytes, durationMs: performance.now() - startedMono, errorCode: this.#errorCode };
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // The committed result already reflects the failure; the handle must
          // still be closed so garbage collection never owns it.
        }
      }
      try {
        await unlink(tempPath);
      } catch {
        // Only a stale temp file remains; it is inert and bounded.
      }
    }
  }

  async #syncDirectory(): Promise<void> {
    let handle: Awaited<ReturnType<typeof open>> | null = null;
    try {
      handle = await open(this.#directory, "r");
      await handle.sync();
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // The rename is the demonstrated local commitment boundary where the
      // platform does not support opening/syncing a directory handle.
      if (code !== undefined && !UNSUPPORTED_DIRECTORY_SYNC.has(code)) throw error;
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          // Closing a directory handle that never synced changes nothing.
        }
      }
    }
  }

  #degrade(errorCode: string): void {
    this.#degraded = true;
    this.#errorCode = errorCode;
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#commitChain.catch(() => undefined);
    if (!this.#ownsLock) {
      // Disposing an inspect-only instance must not remove the first live
      // owner's lock or otherwise mutate its protected state.
      return;
    }
    try {
      await unlink(this.#lockPath);
    } catch {
      // A failed lock release is visible through status; it is never retried
      // forever and never authorizes takeover.
    }
  }
}

export { sessionKey as controlSessionKey };
