// K05 clean Pi reviewer runner (engine side).
//
// The runner never talks to the SDK directly: the production adapter owns the
// concrete AgentSession construction and exposes it through this host contract.
// Every provider turn is admitted by the shared ModelService owner through
// `streamTurn`, and every tool call stays inside the C1 reviewer limits. This is
// ordinary integration code, not a replacement requirements database.

import { realpathSync } from "node:fs";
import { resolve, sep } from "node:path";

import type { Json, Result } from "../contracts.js";

/** One provider turn request forwarded to the shared admission owner. */
export interface ReviewerTurnRequest {
  runId: string;
  /** 1-based ordinal of this provider request inside the reviewer session. */
  turn: number;
  /** Native SDK stream context/options, forwarded unchanged. */
  context: unknown;
  options: unknown;
  signal: AbortSignal;
  /** F01: actual post-transform input manifest/digest for THIS turn. */
  inputManifestRef?: string;
  inputSerializedDigest?: string;
}

/** Admits and streams one provider turn through the shared owner. */
export type ReviewerStreamTurn = (request: ReviewerTurnRequest) => Promise<Result<{ stream: unknown }>>;

export interface ReviewerSessionHooks {
  /** Admits the next provider turn; a denial means no transport is reached. */
  beginTurn(context: unknown, options: unknown, binding?: { inputManifestRef?: string; inputSerializedDigest?: string }): Promise<Result<{ stream: unknown }>>;
  /** Counts and gates one actual tool-call attempt before it executes. */
  allowToolCall(toolName: string, args?: Record<string, unknown>, operationId?: string): boolean;
  /**
   * Accounts bounded material returned by a permitted investigative tool. The
   * operation descriptor carries the real owned call identity, the actual target,
   * the content-derived version, the selection and the result disposition so the
   * run owner can mint truthful evidence references before the next request.
   */
  noteToolResult(toolName: string, bytes: number, operation?: ReviewerAcquisitionOperation): void;
  /** True once a valid canonical result has been submitted and the turn may end. */
  shouldEndTurn(): boolean;
  /**
   * True once a limit/denial closed this session. The adapter's finishTurn ends
   * the SDK loop before another provider request, so a denied turn is prevented
   * at the real boundary instead of being answered with an error stream.
   */
  isTerminated(): boolean;
  /** Package-owned structured result submission. */
  submit(payload: unknown, operationId?: string): void;
  /** Latches an engine refusal discovered inside the native stream bridge. */
  noteRefusal?(reasonCode: string): void;
  /** Bounded issued-evidence identity of material really acquired in this session. */
  issuedEvidence?(): readonly ReviewerIssuedEvidence[];
}

/** One real adopted acquisition reported by the production adapter. */
export interface ReviewerAcquisitionDescriptor {
  toolName: string;
  bytes: number;
  /** UTF-8 bytes of the selected material actually returned, when observed. */
  selectedBytes?: number;
  toolCallId?: string;
  /** Actual requested target, project-relative as the tool received it. */
  path?: string;
  /** Digest of the exact selected result that was returned. */
  selectedDigest?: string;
  /** Whole-source content version for a complete untruncated read; null = unobserved. */
  sourceVersion?: string | null;
  /** Requested selection as asked ("full" | "range:<offset>+<limit>" | "result-set"). */
  requested?: string;
  /** Actual returned selection ("full" | "range:<n>" | "result-set" | "truncated:<n>" | "empty"). */
  actual?: string;
  /** True when the returned material is a truncated view, not the complete source. */
  truncated?: boolean;
  /** Whole-source bytes when observed by the tool result; null = unknown. */
  sourceBytes?: number | null;
  /** Serialized SDK content bytes, distinct from selected and source bytes. */
  serializedBytes?: number;
  /** A failed call returned no material and is never successful evidence. */
  isError?: boolean;
}

/** The operation facts a host reports alongside the tool name and byte count. */
export interface ReviewerAcquisitionOperation extends Omit<ReviewerAcquisitionDescriptor, "toolName" | "bytes"> {
  /** Engine-owned identity of the actual call this result belongs to. */
  operationId?: string;
  /** The call was refused at admission and never executed; its terminal event is not a failure. */
  denied?: boolean;
}

/** Bounded owner-issued identity of one real acquisition, citable at the canonical boundary. */
export interface ReviewerIssuedEvidence {
  token: string;
  revision: string;
  source: string;
  sourceVersion: string | null;
  selectedDigest: string;
  selection: string;
  role: "evidence";
  disposition: "acquired";
  bytes: number;
}

/** Bounded actual tool-operation fact reported at the existing boundary. */
export interface ReviewerToolOperation {
  /** One engine-owned identity joining the admission and result phases of the same call. */
  operationId: string;
  /** Engine-owned bounded tool identity (tool-read, tool-grep, tool-find, tool-ls, tool-result, tool-other). */
  toolRef: string;
  toolName: string;
  outcome: "denied" | "admitted" | "failed" | "acquired" | "submitted";
  ordinal: number;
  bytes?: number;
  /** Owner-issued refs for an acquired operation, when already minted. */
  refs?: readonly string[];
}

export interface ReviewerSession {
  dispose(): void;
}

export interface ReviewerHost {
  createSession(input: {
    cwd: string;
    agentDir: string;
    tools: readonly string[];
    hooks: ReviewerSessionHooks;
    /** Run-scoped aggregate additional-byte allowance for ADOPTED evidence. */
    deliveryBudget: { maxAdditionalReadBytes: number; delivered: number };
    /** F08/F09: acquire a physical lease for a real owned backend operation. */
    holdPhysical?: () => () => void;
    /** P1: narrow sticky revocation view for acquisition gates. */
    isRevoked?: () => boolean;
  }): Promise<ReviewerSession>;
  prompt(session: ReviewerSession, text: string): Promise<void>;
  abort(session: ReviewerSession): Promise<void>;
}

export interface ReviewerRunInput {
  runId: string;
  cwd: string;
  agentDir: string;
  promptText: string;
  tools: readonly string[];
  /** C1 §12.1 accepted read policy: named source ids and project-read permission. */
  readSources?: readonly string[];
  allowProjectReads?: boolean;
  /** Resolved targets of the explicitly granted sources, canonicalized by the caller. */
  permittedReadUris?: readonly string[];
  maxModelRequests: number;
  maxToolCalls: number;
  maxAdditionalReadBytes: number;
  timeoutMs: number;
  /** Configured single repair submission after an invalid result (0 or 1). */
  repairAttempts: number;
  signal: AbortSignal;
  /** F08/F09: run-owned physical lease bridge for real backend operations. */
  holdPhysical?: () => () => void;
  /** P1: narrow sticky revocation view for acquisition gates. */
  isRevoked?: () => boolean;
  /** Admits/streams one provider turn through the shared owner. */
  streamTurn: ReviewerStreamTurn;
  /** Validates a submitted payload as the canonical assessment result. */
  validate(payload: unknown): { valid: boolean; reason: string };
  /**
   * Mints the run-owned evidence references for an actual acquisition BEFORE the
   * next provider request and before submission validation; returns the opaque
   * references the canonical result may cite.
   */
  onAdoptedEvidence?: (descriptor: ReviewerAcquisitionDescriptor) => readonly string[];
  /** Reports bounded actual reviewer tool-operation facts for owner observation. */
  onToolOperation?: (operation: ReviewerToolOperation) => void;
}

export interface ReviewerRunOutcome {
  output: Json | null;
  validation: "valid" | "invalid";
  modelRequests: number;
  toolCalls: number;
  additionalReadBytes: number;
  terminalReason: string;
  /** F01: descriptors for actually adopted acquisitions; the run owner mints
   * the genuine owned evidence references from them. */
  adoptedAcquisitions?: readonly ReviewerAcquisitionDescriptor[];
  /** Bounded owner-issued identities of the acquisitions adopted in this run. */
  issuedEvidence?: readonly ReviewerIssuedEvidence[];
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const PATH_TOOLS = new Set(["read", "grep", "find", "ls"]);
function canonicalPath(base: string, requested: string): string {
  const resolved = resolve(base, requested);
  return realpathOf(resolved) ?? resolved;
}

function isInside(candidate: string, root: string): boolean {
  const realRoot = realpathOf(root) ?? resolve(root);
  return candidate === realRoot || candidate.startsWith(realRoot + sep);
}

function withinRoot(root: string, requested: string): boolean {
  const realRoot = realpathOf(root);
  if (realRoot === null) return false;
  const resolved = resolve(realRoot, requested);
  if (resolved !== realRoot && !resolved.startsWith(realRoot + sep)) return false;
  const realTarget = realpathOf(resolved);
  if (realTarget === null) return true; // non-existent target cannot be read anyway
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep);
}

function realpathOf(target: string): string | null {
  try {
    return realpathSync.native(target);
  } catch {
    return null;
  }
}

const RESULT_TOOL = "submit_result";

/**
 * Runs one bounded fresh reviewer session. Model requests, tool calls and
 * additional read bytes are enforced at the real boundaries; the session is
 * aborted on timeout and disposed exactly once. A denial or limit returns an
 * explicit terminal reason and never a fabricated success.
 */
export async function runReviewerSession(input: ReviewerRunInput, host: ReviewerHost): Promise<Result<ReviewerRunOutcome>> {
  let modelRequests = 0;
  let toolCalls = 0;
  let additionalReadBytes = 0;
  let submitted: unknown = null;
  let submittedValidation: { valid: boolean; reason: string } | null = null;
  let terminalReason: string | null = null;
  let repaired = false;

  const adoptedAcquisitions: ReviewerAcquisitionDescriptor[] = [];
  const issuedEvidence: ReviewerIssuedEvidence[] = [];
  let operationOrdinal = 0;
  const toolRefOf = (toolName: string): string => toolName === "read" ? "tool-read"
    : toolName === "grep" ? "tool-grep"
      : toolName === "find" ? "tool-find"
        : toolName === "ls" ? "tool-ls"
          : toolName === RESULT_TOOL ? "tool-result"
            : "tool-other";
  const reportOperation = (operation: ReviewerToolOperation) => {
    input.onToolOperation?.(operation);
  };

  const allowToolCallInner = (toolName: string, args?: Record<string, unknown>): boolean => {
      // 163: the owned effective deadline/revocation view is authority at this boundary even when no
      // timer or poll callback has run yet; the refusal is latched as the bounded non-success.
      if (input.signal.aborted || input.isRevoked?.() === true) {
        terminalReason = terminalReason ?? "core.run-revoked";
        return false;
      }
      // Permission boundary (C1 §12.1/§17.1): the permitted investigative tools
      // may only touch the reviewer's admitted project root. Absolute paths,
      // ../ escapes and symlinks whose real target leaves the root are denied
      // BEFORE any physical read; the denial is the engine's own code.
      if (PATH_TOOLS.has(toolName) && args !== undefined) {
        const requested = typeof args["path"] === "string" ? args["path"] as string : null;
        if (requested !== null) {
          const target = canonicalPath(input.cwd, requested);
          if (!withinRoot(input.cwd, requested)) {
            terminalReason = terminalReason ?? "core.review-tool-denied";
            return false;
          }
          // Engine-owned protected roots stay excluded even when they live
          // INSIDE an otherwise permitted project root: a direct target is
          // denied, and a walker root that is an ancestor of a protected root
          // is denied before any search child can be spawned (a post-filter
          // cannot undo acquisition by rg/fd).
          const protectedRoot = canonicalPath(input.cwd, input.agentDir);
          if (isInside(target, protectedRoot)) {
            terminalReason = terminalReason ?? "core.review-tool-denied";
            return false;
          }
          // Ancestor roots are handled by the adapter's bounded admitted-leaf
          // enumeration, so an ordinary root search stays useful while the
          // protected subtree is never visited by a search child.
        }
      }
      // 201-F1 / C1 §12.1: the accepted read policy is operative at this admission
      // boundary. With `allowProjectReads:false` only the explicitly granted sources
      // may be read and search/list acquisition is denied outright; an unresolved
      // grant grants nothing, so the narrowing fails closed instead of being ignored.
      if (PATH_TOOLS.has(toolName) && (input.allowProjectReads ?? true) === false) {
        const requested = args !== undefined && typeof args["path"] === "string" ? args["path"] as string : null;
        const permitted = requested !== null
          && (input.permittedReadUris ?? []).some(uri => canonicalPath(input.cwd, uri) === canonicalPath(input.cwd, requested));
        if (toolName !== "read" || !permitted) {
          terminalReason = terminalReason ?? "core.review-tool-denied";
          return false;
        }
      }
      // Sticky terminal state: a completed result or ANY terminal reason
      // (operator Stop, deadline, limits, refusal) blocks every newly starting
      // tool in the same batch, including the result tool. Authority revocation
      // must deny a queued result start, not just later non-result work; the
      // configured single repair is unaffected because an invalid first
      // submission leaves terminalReason null.
      if (terminalReason !== null || submittedValidation?.valid === true) {
        return false;
      }
      // F06: the canonical internal result mechanism is not an investigative
      // attempt; it never consumes the tool-call quota. Terminal/Stop/deadline
      // authority still gates it above, so this is not a bypass.
      if (toolName !== RESULT_TOOL && toolCalls + 1 > input.maxToolCalls) {
        terminalReason = terminalReason ?? "core.review-tool-limit";
        return false;
      }
      if (toolName !== RESULT_TOOL && !input.tools.includes(toolName)) {
        terminalReason = terminalReason ?? "core.review-tool-denied";
        return false;
      }
      if (toolName !== RESULT_TOOL) {
        if (additionalReadBytes > input.maxAdditionalReadBytes) {
          // A call denied at the real boundary never executed and is not
          // counted as a completed attempt.
          terminalReason = terminalReason ?? "core.review-read-bytes-limit";
          return false;
        }
        toolCalls += 1;
      }
      return true;
  };

const hooks: ReviewerSessionHooks = {
    beginTurn: async (context, options, binding) => {
      // 163: consult the same effective deadline/revocation view at turn admission, independent of any
      // timer or poll callback.
      if (input.signal.aborted || input.isRevoked?.() === true) {
        terminalReason = terminalReason ?? "core.run-revoked";
        return { ok: false, error: { code: terminalReason, retryable: false } };
      }
      // A terminal reviewer (deadline, refusal, valid submission or exhausted
      // limit) must refuse any later provider turn before the shared transport,
      // so a late SDK continuation cannot regain result authority or arrive at
      // the provider. Late native usage already incurred still settles its own
      // attempt through the shared ledger.
      if (terminalReason !== null) {
        return { ok: false, error: { code: terminalReason, retryable: false } };
      }
      const turn = modelRequests + 1;
      if (turn > input.maxModelRequests) {
        terminalReason = "core.review-request-limit";
        return { ok: false, error: { code: "core.review-request-limit", retryable: false } };
      }
      modelRequests = turn;
      const admitted = await input.streamTurn({
        runId: input.runId,
        turn,
        context,
        options,
        signal: input.signal,
        ...(binding?.inputManifestRef === undefined ? {} : { inputManifestRef: binding.inputManifestRef }),
        ...(binding?.inputSerializedDigest === undefined ? {} : { inputSerializedDigest: binding.inputSerializedDigest }),
      });
      if (!admitted.ok) {
        // The bounded engine-owned refusal reason survives in the returned
        // outcome; it is sticky and never becomes a clean assessment.
        terminalReason = terminalReason ?? admitted.error.code;
      }
      return admitted;
    },
    allowToolCall: (toolName, args, operationId) => {
      const admitted = allowToolCallInner(toolName, args);
      operationOrdinal += 1;
      reportOperation({
        operationId: operationId ?? `reviewer-call-${operationOrdinal}`,
        toolRef: toolRefOf(toolName),
        toolName,
        outcome: admitted ? "admitted" : "denied",
        ordinal: operationOrdinal,
      });
      return admitted;
    },
    noteToolResult: (toolName, bytes, operation) => {
      if (input.signal.aborted || input.isRevoked?.() === true) return; // 173/S2: expired content is never adopted as fresh evidence
      // 201-F2: a failed or errored call returned no material; it is never adopted
      // as successful inspected evidence and never accounted as read bytes, but the
      // actual failed operation is still reported to the owner observation boundary.
      // 205-F4/208: a call refused at admission reports the SAME owned identity with the
      // truthful not-executed disposition; the blocked terminal event is not an executed failure.
      if (operation?.denied === true) {
        operationOrdinal += 1;
        reportOperation({
          operationId: operation?.operationId ?? `reviewer-call-${operationOrdinal}`,
          toolRef: toolRefOf(toolName),
          toolName,
          outcome: "denied",
          ordinal: operationOrdinal,
        });
        return;
      }
      if (operation?.isError === true) {
        operationOrdinal += 1;
        reportOperation({
          operationId: operation?.operationId ?? `reviewer-call-${operationOrdinal}`,
          toolRef: toolRefOf(toolName),
          toolName,
          outcome: "failed",
          ordinal: operationOrdinal,
        });
        return;
      }
      if (!READ_TOOLS.has(toolName) || !Number.isFinite(bytes) || bytes <= 0) return;
      additionalReadBytes += bytes;
      // F01/201-F2/203 custody: record the real operation identity, canonical target, selected and
      // source versions, requested versus actual selection, and the distinct size domains; the
      // run-owned custody issuer mints the genuine evidence references, so nothing is fabricated.
      const descriptor: ReviewerAcquisitionDescriptor = {
        toolName,
        bytes,
        ...(operation?.selectedBytes === undefined ? {} : { selectedBytes: operation.selectedBytes }),
        ...(operation?.toolCallId === undefined || operation.toolCallId.length === 0 ? {} : { toolCallId: operation.toolCallId }),
        ...(operation?.path === undefined || operation.path.length === 0 ? {} : { path: operation.path }),
        ...(operation?.selectedDigest === undefined || operation.selectedDigest.length === 0 ? {} : { selectedDigest: operation.selectedDigest }),
        ...(operation?.sourceVersion === undefined ? {} : { sourceVersion: operation.sourceVersion }),
        ...(operation?.requested === undefined ? {} : { requested: operation.requested }),
        ...(operation?.actual === undefined ? {} : { actual: operation.actual }),
        ...(operation?.truncated === true ? { truncated: true } : {}),
        ...(operation?.sourceBytes === undefined ? {} : { sourceBytes: operation.sourceBytes }),
        ...(operation?.serializedBytes === undefined ? {} : { serializedBytes: operation.serializedBytes }),
      };
      if (adoptedAcquisitions.length < 16) adoptedAcquisitions.push(descriptor);
      // Mint the run-owned references NOW, before the next provider request and before
      // submission validation, so the material actually acquired during the session is
      // citable at the canonical result boundary instead of only observed afterwards.
      const refs = input.onAdoptedEvidence?.(descriptor) ?? [];
      if (refs.length >= 2 && issuedEvidence.length < 16) {
        issuedEvidence.push({
          token: refs[0] as string,
          revision: refs[1] as string,
          source: descriptor.path ?? descriptor.toolName,
          sourceVersion: descriptor.sourceVersion ?? null,
          selectedDigest: descriptor.selectedDigest ?? `selected-${descriptor.bytes}-bytes`,
          selection: descriptor.actual ?? "unknown",
          role: "evidence",
          disposition: "acquired",
          bytes: descriptor.selectedBytes ?? descriptor.bytes,
        });
      }
      operationOrdinal += 1;
      reportOperation({
        operationId: operation?.operationId ?? `reviewer-call-${operationOrdinal}`,
        toolRef: toolRefOf(toolName),
        toolName,
        outcome: "acquired",
        ordinal: operationOrdinal,
        bytes,
        refs: refs.slice(0, 2),
      });
    },
    issuedEvidence: () => issuedEvidence,
    noteRefusal: (reasonCode) => {
      terminalReason = terminalReason ?? reasonCode;
    },
    shouldEndTurn: () => submittedValidation?.valid === true,
    isTerminated: () => {
      // No further provider turn may be admitted once the request cap is
      // reached: the SDK loop ends here, so the disallowed turn produces zero
      // provider arrivals instead of being answered or thrown at the bridge.
      if (terminalReason === null && modelRequests >= input.maxModelRequests) terminalReason = "core.review-request-limit";
      return terminalReason !== null || submittedValidation?.valid === true;
    },
    submit: (payload, operationId) => {
      operationOrdinal += 1;
      reportOperation({
        operationId: operationId ?? `reviewer-result-${operationOrdinal}`,
        toolRef: toolRefOf(RESULT_TOOL),
        toolName: RESULT_TOOL,
        outcome: "submitted",
        ordinal: operationOrdinal,
      });
      if (submittedValidation?.valid === true) return;
      // 173/S1-S2: the direct submission boundary consults the same owned effective deadline/
      // revocation view even when no earlier guard latched a terminal, so an expired run cannot
      // acquire fresh result authority by submitting. A timely valid submission stays accepted.
      if (input.signal.aborted || input.isRevoked?.() === true) {
        terminalReason = terminalReason ?? "core.run-revoked";
        return;
      }
      // A revoked run can never acquire fresh result authority by submitting
      // after the terminal state latched (Stop/deadline/limit/refusal).
      if (terminalReason !== null) return;
      const validation = input.validate(payload);
      const firstSubmission = submittedValidation === null;
      submitted = payload;
      submittedValidation = validation;
      if (validation.valid) return;
      // An invalid result is never success. Exactly one further submission is
      // admitted only when the configured repair allows it and it has not been
      // used yet; otherwise the invalid result is terminal.
      // F07: repairAttempts:1 permits the initial invalid submission plus
      // exactly ONE repair. The opportunity is consumed by the initial invalid
      // submission, so a second invalid submission ends result authority.
      if (firstSubmission && input.repairAttempts === 1) {
        repaired = true;
        return;
      }
      terminalReason = terminalReason ?? validation.reason;
    },
  };

  // Closure-written state must be read through accessors: TypeScript's control
  // flow analysis cannot see assignments made inside the session hooks.
  const validationOf = (): { valid: boolean; reason: string } | null => submittedValidation;
  const reasonOf = (): string | null => terminalReason;

  let session: ReviewerSession | null = null;
  let timedOut = false;
  let abortRequested = false;
  // Whole-run/Stop revocation must reach the real session promptly, not only
  // when the later review deadline happens to expire. The abort is requested
  // once; physical ownership stays until genuine settlement.
  const requestAbort = () => {
    if (abortRequested) return;
    abortRequested = true;
    terminalReason = terminalReason ?? "core.run-revoked";
    if (session !== null) void host.abort(session).catch(() => undefined);
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = new Promise<"timeout">(resolvePromise => {
    timer = setTimeout(() => { timedOut = true; resolvePromise("timeout"); }, Math.max(1, input.timeoutMs));
  });
  // 151 repair: the runner's relative budget must not renew itself for factory/preparation
  // time. The owner's absolute review deadline already sits inside input.isRevoked, so it is
  // watched monotonically here and terminates the run boundedly - no second scheduler, no new
  // public field, and a delayed timer callback can no longer admit expired work.
  let revocationWatcher: ReturnType<typeof setInterval> | null = null;
  const ownerRevoked = new Promise<"revoked">(resolvePromise => {
    if (input.isRevoked?.() === true) { timedOut = true; resolvePromise("revoked"); return; }
    revocationWatcher = setInterval(() => {
      if (input.isRevoked?.() === true) { timedOut = true; resolvePromise("revoked"); }
    }, 25);
    if (typeof revocationWatcher.unref === "function") revocationWatcher.unref();
  });
  try {
    // P2: the construction itself is an owned producer — hold a creation lease
    // before it starts and release it only when creation truly settles (or its
    // late cleanup finishes), so a delayed creation cannot run on an already
    // released slot.
    const releaseCreation = input.holdPhysical?.();
    let creationReleased = false;
    const releaseCreationOnce = () => { if (!creationReleased) { creationReleased = true; releaseCreation?.(); } };
    const createdPromise = host.createSession({
        cwd: input.cwd,
        agentDir: input.agentDir,
        tools: input.tools,
        hooks,
        deliveryBudget: { maxAdditionalReadBytes: input.maxAdditionalReadBytes, delivered: 0 },
        ...(input.holdPhysical === undefined ? {} : { holdPhysical: input.holdPhysical }),
        ...(input.isRevoked === undefined ? {} : { isRevoked: input.isRevoked }),
      });
    const creationTracked = createdPromise.then(
      session => { releaseCreationOnce(); return session; },
      error => { releaseCreationOnce(); throw error; },
    );
    const created = await Promise.race([creationTracked, deadline, ownerRevoked]);
    if (created === "timeout" || created === "revoked") {
      // A session created after the logical deadline is still owned: abort and
      // dispose it exactly once, without ever prompting it.
      void createdPromise.then(late => {
        try { late.dispose(); } catch { /* bounded */ }
      }).catch(() => undefined);
      return { ok: true, value: { output: null, validation: "invalid", modelRequests, toolCalls, additionalReadBytes, terminalReason: reasonOf() ?? "core.review-timeout" } };
    }
    session = created;
    if (input.signal.aborted) requestAbort();
    else input.signal.addEventListener("abort", requestAbort, { once: true });
    // Astra133 §3/§6: a handle returned by a DELAYED creation must never receive its first
    // task once the run is already revoked (trusted operator Stop, whole-run deadline,
    // cancellation, inactive generation). The narrow revocation view is revalidated here at
    // the adoption boundary; the handle stays with the existing once-owned abort/cleanup so
    // physical and accounting ownership is kept until genuine settlement, and the run
    // returns a bounded non-success instead of starting work under revoked authority.
    if (input.signal.aborted || input.isRevoked?.() === true) {
      requestAbort();
      return {
        ok: true,
        value: {
          output: null,
          validation: "invalid",
          modelRequests,
          toolCalls,
          additionalReadBytes,
          terminalReason: reasonOf() ?? "core.run-revoked",
        },
      };
    }
    const prompted = await Promise.race([
      host.prompt(session, input.promptText).then(() => "done" as const, () => "failed" as const),
      deadline,
      ownerRevoked,
    ]);
    if (prompted === "timeout" || prompted === "revoked") {
      // 163: latch the bounded non-success authority stickily and abort once, so a later
      // callback cannot reopen hooks or adopt expired evidence.
      terminalReason = reasonOf() ?? (timedOut ? "core.review-timeout" : "core.run-revoked");
      requestAbort();
      // Bounded logical completion at the absolute review deadline; the public
      // abort/dispose below detach authority once, while real late native work
      // stays owned by the shared attempt/ledger until genuine settlement.
      return { ok: true, value: { output: null, validation: "invalid", modelRequests, toolCalls, additionalReadBytes, terminalReason: reasonOf() ?? "core.review-timeout" } };
    }
    // 163: revalidate the effective deadline/revocation view at the successful-return boundary.
    if (input.signal.aborted || input.isRevoked?.() === true) {
      terminalReason = reasonOf() ?? "core.run-revoked";
      requestAbort();
      return {
        ok: true,
        value: { output: null, validation: "invalid", modelRequests, toolCalls, additionalReadBytes, terminalReason: reasonOf() ?? "core.run-revoked" },
      };
    }
    const valid = validationOf()?.valid === true;
    if (timedOut && !valid && reasonOf() === null) terminalReason = "core.review-timeout";
    return {
      ok: true,
      value: {
        output: (submitted ?? null) as Json | null,
        validation: valid ? "valid" : "invalid",
        modelRequests,
        toolCalls,
        additionalReadBytes,
        terminalReason: valid ? "core.review-submitted" : (reasonOf() ?? (submitted === null ? "core.review-no-result" : "core.review-invalid-result")),
        ...(adoptedAcquisitions.length === 0 ? {} : { adoptedAcquisitions: adoptedAcquisitions.slice(0, 16) }),
      },
    };
  } catch {
    return { ok: false, error: { code: timedOut ? "core.review-timeout" : "core.review-failed", retryable: false } };
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (revocationWatcher !== null) clearInterval(revocationWatcher);
    input.signal.removeEventListener("abort", requestAbort);
    if (session !== null) {
      // A non-cooperative session keeps its physical lifetime; the bounded
      // abort is attempted once and disposal runs exactly once. The shared
      // attempt reservation settles late from the actual completion.
      // Bounded cleanup: public AgentSession.abort awaits idle and must not be
      // awaited indefinitely while a non-cooperative provider is still held.
      // The logical outcome is already final; real late work stays owned by the
      // shared attempt/ledger until genuine settlement.
      if (!abortRequested) {
        try {
          await Promise.race([
            host.abort(session),
            new Promise<void>(resolvePromise => setTimeout(resolvePromise, 250)),
          ]);
        } catch {
          // A throwing or hanging abort does not change physical ownership.
        }
      }
      try {
        session.dispose();
      } catch {
        // Disposal is bounded and once-only; a throwing dispose is not retried.
      }
    }
  }
}
