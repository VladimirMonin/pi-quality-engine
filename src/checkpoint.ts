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

/**
 * Session-wide receipt aggregates, independent of bounded receipt details.
 */
export interface FinancialAggregate {
  knownTokens: number;
  tokensMissing: number;
  usageKnownCount: number;
  usagePartialCount: number;
  usageUnknownCount: number;
  settledCount: number;
  unresolvedCount: number;
  cancelledCount: number;
  byPurpose: Record<string, number>;
}

/** Immutable captured tariff for one owned attempt. */
export interface SnapshotPrice {
  currency: string;
  revision: string;
  inputPerMillion: string;
  outputPerMillion: string;
  cacheReadPerMillion?: string;
  cacheWritePerMillion?: string;
}

/** Bounded protected financial state; restored values may only constrain. */
export interface FinancialSnapshot {
  ledgerRevision: number;
  ownedRequestCount: number;
  reservedTokens: number;
  knownCostByCurrency: Record<string, string>;
  reservedCostByCurrency: Record<string, string>;
  unresolvedCount: number;
  aggregate?: FinancialAggregate;
  attempts: Array<{
    attemptId: string;
    state: string;
    purpose: string;
    profileId?: string;
    price?: "host-catalog" | "unknown" | SnapshotPrice | null;
    usageRevision: number;
    totalTokens: number | null;
    usageCoverage: string;
    costAmount: string | null;
    costCurrency: string | null;
    reservedTokens?: number;
    reservedCostAmount?: string | null;
    reservedCostCurrency?: string | null;
  }>;
}

export interface ControlCheckpointState {
  schemaVersion: 1;
  observedSessionId: string;
  ownerGeneration: string;
  operatorStopped: boolean;
  observerPaused: boolean;
  authorizationRevision: string;
  configurationRevision: string;
  financial: FinancialSnapshot | null;
  /** Sticky material-receipt persistence uncertainty; never implicitly cleared. */
  financialUncertain: boolean;
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
  financial: FinancialSnapshot | null;
  financialUncertain: boolean;
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

function stringMap(value: unknown): Record<string, string> {
  if (!isPlainObject(value)) return {};
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string" && /^[0-9]+(?:\.[0-9]+)?$/u.test(entry)) map[key] = entry;
  }
  return map;
}

/** Restores only bounded, typed financial facts; anything else stays unset. */
export function parseFinancialSnapshot(value: unknown): FinancialSnapshot | null {
  if (!isPlainObject(value)) return null;
  const ledgerRevision = value["ledgerRevision"];
  const ownedRequestCount = value["ownedRequestCount"];
  const reservedTokens = value["reservedTokens"];
  const unresolvedCount = value["unresolvedCount"];
  if (typeof ledgerRevision !== "number" || typeof ownedRequestCount !== "number"
    || typeof reservedTokens !== "number" || typeof unresolvedCount !== "number") {
    return null;
  }
  const aggregateInput = isPlainObject(value["aggregate"]) ? value["aggregate"] : null;
  const numberField = (source: Record<string, unknown>, key: string): number => {
    const entry = source[key];
    return typeof entry === "number" && Number.isFinite(entry) && entry >= 0 ? Math.floor(entry) : 0;
  };
  const countMap = (source: unknown): Record<string, number> => {
    if (!isPlainObject(source)) return {};
    const map: Record<string, number> = {};
    for (const [key, entry] of Object.entries(source)) {
      if (typeof entry === "number" && Number.isFinite(entry) && entry >= 0) map[key] = Math.floor(entry);
    }
    return map;
  };
  const aggregate: FinancialAggregate | undefined = aggregateInput === null ? undefined : {
    knownTokens: numberField(aggregateInput, "knownTokens"),
    tokensMissing: numberField(aggregateInput, "tokensMissing"),
    usageKnownCount: numberField(aggregateInput, "usageKnownCount"),
    usagePartialCount: numberField(aggregateInput, "usagePartialCount"),
    usageUnknownCount: numberField(aggregateInput, "usageUnknownCount"),
    settledCount: numberField(aggregateInput, "settledCount"),
    unresolvedCount: numberField(aggregateInput, "unresolvedCount"),
    cancelledCount: numberField(aggregateInput, "cancelledCount"),
    byPurpose: countMap(aggregateInput["byPurpose"]),
  };
  const attemptsInput = Array.isArray(value["attempts"]) ? value["attempts"] : [];
  const snapshotPrice = (value: unknown): "host-catalog" | "unknown" | SnapshotPrice | null => {
    if (value === "host-catalog" || value === "unknown") return value;
    if (!isPlainObject(value)) return null;
    const currency = value["currency"];
    const revision = value["revision"];
    const input = value["inputPerMillion"];
    const output = value["outputPerMillion"];
    const decimal = (entry: unknown): string | undefined =>
      typeof entry === "string" && /^[0-9]+(?:\.[0-9]+)?$/u.test(entry) ? entry : undefined;
    if (typeof currency !== "string" || typeof revision !== "string") return null;
    const inputRate = decimal(input);
    const outputRate = decimal(output);
    if (inputRate === undefined || outputRate === undefined) return null;
    const cacheRead = decimal(value["cacheReadPerMillion"]);
    const cacheWrite = decimal(value["cacheWritePerMillion"]);
    return {
      currency,
      revision,
      inputPerMillion: inputRate,
      outputPerMillion: outputRate,
      ...(cacheRead === undefined ? {} : { cacheReadPerMillion: cacheRead }),
      ...(cacheWrite === undefined ? {} : { cacheWritePerMillion: cacheWrite }),
    };
  };
  const parsedAttempts = attemptsInput.flatMap(entry => {
    if (!isPlainObject(entry) || typeof entry["attemptId"] !== "string" || typeof entry["state"] !== "string") return [];
    return [{
      attemptId: entry["attemptId"],
      state: entry["state"],
      purpose: typeof entry["purpose"] === "string" ? entry["purpose"] : "direct",
      ...(typeof entry["profileId"] === "string" ? { profileId: entry["profileId"] } : {}),
      price: snapshotPrice(entry["price"]),
      usageRevision: typeof entry["usageRevision"] === "number" ? entry["usageRevision"] : 0,
      totalTokens: typeof entry["totalTokens"] === "number" ? entry["totalTokens"] : null,
      usageCoverage: typeof entry["usageCoverage"] === "string" ? entry["usageCoverage"] : "unknown",
      costAmount: typeof entry["costAmount"] === "string" ? entry["costAmount"] : null,
      costCurrency: typeof entry["costCurrency"] === "string" ? entry["costCurrency"] : null,
      ...(typeof entry["reservedTokens"] === "number" ? { reservedTokens: entry["reservedTokens"] } : {}),
      reservedCostAmount: typeof entry["reservedCostAmount"] === "string" ? entry["reservedCostAmount"] : null,
      reservedCostCurrency: typeof entry["reservedCostCurrency"] === "string" ? entry["reservedCostCurrency"] : null,
    }];
  });
  const finalizedState = (state: string): boolean => state === "settled" || state === "cancelled" || state === "released";
  const attempts = [...parsedAttempts.filter(row => !finalizedState(row.state)), ...parsedAttempts.filter(row => finalizedState(row.state)).slice(-32)];
  return {
    ledgerRevision,
    ownedRequestCount,
    reservedTokens,
    knownCostByCurrency: stringMap(value["knownCostByCurrency"]),
    reservedCostByCurrency: stringMap(value["reservedCostByCurrency"]),
    unresolvedCount,
    ...(aggregate === undefined ? {} : { aggregate }),
    attempts,
  };
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
    let financial: FinancialSnapshot | null = null;
    let financialUncertain = false;
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
        financial = parseFinancialSnapshot(parsed["financial"]);
        financialUncertain = parsed["financialUncertain"] === true;
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
      checkpoint: new ControlCheckpoint(path, directory, lockPath, key, options, revision, owned, authorizationRevision, financial, financialUncertain),
      owned,
      restored,
      operatorStopped,
      observerPaused,
      authorizationRevision,
      financial,
      financialUncertain,
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
  #financial: FinancialSnapshot | null = null;
  #financialUncertain = false;
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
    financial: FinancialSnapshot | null,
    financialUncertain: boolean,
  ) {
    this.#financial = financial;
    this.#financialUncertain = financialUncertain;
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
    financial?: FinancialSnapshot | null;
    financialUncertain?: boolean;
  }): void {
    if (state.financial !== undefined) this.#financial = state.financial;
    if (state.financialUncertain !== undefined) this.#financialUncertain = state.financialUncertain;
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
      financial: this.#financial,
      financialUncertain: this.#financialUncertain,
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
