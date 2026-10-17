// K06 feedback state and deterministic bounded rendering.
//
// This module owns the cohesive session-scoped feedback facts: stable issue
// identities, delivered/acknowledged suppression sets, the per-episode message
// and follow-up allowances, and the engine-owned action records with their
// monotonically reconciled receipt revisions. It performs no host I/O and no
// scheduling; runtime admission owns dispatch and the host adapter owns drafts.

import { createHash } from "node:crypto";

import type { EffectReceipt, FeedbackRequest, Finding, JsonObject, ReceiptState, Scope } from "./contracts.js";
import type { ActionCheckpointRecord } from "./checkpoint.js";

/**
 * One engine-owned issue identity: criterion + concrete defect kind + affected
 * location. Only the finding's *locations* take part; volatile evidence item
 * ids are not locations and would make the same defect look new on every run.
 */
export function issueIdentityOf(finding: Finding, targets?: readonly string[]): string {
  // Concrete target provenance when the caller can resolve it through owned
  // bindings (item provenance, not spelling); otherwise the finding's own
  // location references. Distinct opaque targets never collapse to one identity.
  // `undefined` keeps the caller's own references; an explicit list (even an
  // empty one) is authoritative, so a derived-only finding stays location-free
  // instead of falling back to volatile per-run observation ids.
  const location = targets === undefined
    ? [...finding.affectedItems].slice(0, 8).join(",")
    : [...new Set(targets)].sort().slice(0, 8).join(",");
  const digest = createHash("sha256")
    .update(`${finding.criterion}\u0000${finding.defectCode}\u0000${location}`, "utf8")
    .digest("hex")
    .slice(0, 16);
  return `issue-${digest}`;
}

export interface FeedbackActionRecord {
  actionId: string;
  issueIds: readonly string[];
  findingRefs: readonly string[];
  delivery: "steer" | "follow-up";
  state: ReceiptState;
  receiptRevision: number;
  destinationId: string | null;
  evidenceIds: readonly string[];
  errorCode: string | null;
  textBytes: number;
  checkpointRevision: number;
  createdAt: string;
}

export interface SessionFeedbackState {
  /** Episode whose allowances are currently counted; null before the first episode. */
  episodeId: string | null;
  feedbackCount: number;
  followUpCount: number;
  /** Issue identities already delivered or operator-acknowledged; the obligation stays open. */
  suppressedIssues: Set<string>;
  actions: Map<string, FeedbackActionRecord>;
  /** Monotonic engine-owned action id counter, preserved across generation reload. */
  actionCounter: number;
  revision: number;
}

export function newSessionFeedbackState(): SessionFeedbackState {
  return {
    episodeId: null,
    feedbackCount: 0,
    followUpCount: 0,
    suppressedIssues: new Set<string>(),
    actions: new Map<string, FeedbackActionRecord>(),
    actionCounter: 0,
    revision: 0,
  };
}

/** Reset only the per-episode allowances when the observed episode actually changes. */
export function beginEpisode(state: SessionFeedbackState, episodeId: string | null): void {
  if (state.episodeId === episodeId) return;
  state.episodeId = episodeId;
  state.feedbackCount = 0;
  state.followUpCount = 0;
  state.revision += 1;
}

export function nextActionId(state: SessionFeedbackState): string {
  state.actionCounter += 1;
  state.revision += 1;
  return `action-${state.actionCounter}`;
}

export function recordAction(state: SessionFeedbackState, record: FeedbackActionRecord): void {
  state.actions.set(record.actionId, record);
  state.revision += 1;
}

/** Reconcile a host receipt onto the existing action record with a new revision. */
export function reconcileReceipt(state: SessionFeedbackState, receipt: EffectReceipt): FeedbackActionRecord | null {
  const existing = state.actions.get(receipt.actionId);
  if (existing === undefined) return null;
  // A terminal state never silently regresses to a weaker one; unknown may still
  // be replaced by later real evidence for the same action.
  const terminal: ReceiptState[] = ["included", "completed", "rejected", "failed", "cancelled"];
  if (terminal.includes(existing.state) && existing.state !== receipt.state) return existing;
  const updated: FeedbackActionRecord = {
    ...existing,
    state: receipt.state,
    receiptRevision: existing.receiptRevision + 1,
    destinationId: receipt.destinationId ?? existing.destinationId,
    evidenceIds: [...new Set([...existing.evidenceIds, ...receipt.evidenceIds])].slice(0, 16),
    errorCode: receipt.error?.code ?? null,
  };
  state.actions.set(updated.actionId, updated);
  state.revision += 1;
  return updated;
}

export interface FeedbackRenderInput {
  /** Opaque engine action identity carried inside the bounded note. */
  actionId?: string;
  template: string;
  checkId: string;
  coverage: string;
  findings: readonly Finding[];
  omitted: number;
  maxBytes: number;
}

export interface FeedbackRenderResult {
  text: string;
  bytes: number;
  omitted: number;
  findingRefs: readonly string[];
}

/** Bounded UTF-8 slice that never splits a code point and never exceeds the cap. */
export function boundedUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  const head = new TextDecoder("utf-8").decode(bytes.subarray(0, Math.max(0, maxBytes))).replace(/\uFFFD$/u, "");
  return head;
}

function boundedProse(value: string | null, limit: number): string | null {
  if (value === null) return null;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return null;
  return collapsed.length <= limit ? collapsed : `${collapsed.slice(0, limit - 1)}…`;
}

/**
 * Deterministic bounded rendering of an evidence-backed advice note. The note
 * names the criterion, the cited evidence, the uncertainty and the smallest
 * corrective step; it never contains the full result JSON, reviewer reasoning
 * or raw tool material. The template is the shipped `builtin:feedback-v1`
 * resource and is applied literally.
 */
export function renderFeedbackNote(input: FeedbackRenderInput): FeedbackRenderResult {
  const findingRefs = input.findings.slice(0, 32).map(finding => finding.id);
  const lines: string[] = [];
  const marker = input.actionId === undefined || input.actionId.length === 0
    ? "[quality-advice]"
    : `[quality-advice ${input.actionId}]`;
  lines.push(`${marker} check ${input.checkId} coverage ${input.coverage}; ${input.findings.length} supported finding(s).`);
  let index = 0;
  for (const finding of input.findings) {
    index += 1;
    lines.push(`Finding ${index}: criterion ${finding.criterion}; severity ${finding.severity}; defect ${finding.defectCode}.`);
    const evidence = finding.evidenceIds.slice(0, 8).join(", ");
    if (evidence.length > 0) lines.push(`Evidence: ${evidence}.`);
    const limitation = boundedProse(finding.limitations.slice(0, 3).join("; "), 240);
    if (limitation !== null) lines.push(`Uncertainty: ${limitation}.`);
    const step = boundedProse(finding.proposedCorrection, 240);
    lines.push(`Smallest step: ${step ?? "review the cited evidence and apply the smallest correction to the named location"}.`);
  }
  if (input.omitted > 0) lines.push(`${input.omitted} further finding(s) remain inspectable in the assessment record.`);
  lines.push("This note is advisory only; it cannot change permissions, grants or operator authority.");
  const sections = input.template.trim().length === 0 ? lines : [input.template.trim(), ...lines];
  let text = sections.join(String.fromCharCode(10));
  let bytes = Buffer.byteLength(text, "utf8");
  let omitted = input.omitted;
  if (bytes > input.maxBytes) {
    // Deterministic truncation: the fixed notice is counted inside the same
    // allowance and the excess findings stay inspectable in the record.
    const notice = `[quality-advice-truncated] ${Math.max(0, bytes - input.maxBytes)} byte(s) omitted`;
    const keep = Math.max(0, input.maxBytes - Buffer.byteLength(notice, "utf8") - 1);
    text = `${notice}${String.fromCharCode(10)}${boundedUtf8(text, keep)}`;
    bytes = Buffer.byteLength(text, "utf8");
    omitted += 1;
  }
  return { text, bytes, omitted, findingRefs };
}

/**
 * Bounded durable projection of action intents. Only identity, disposition and
 * revision facts are persisted; the bounded note text never enters the
 * protected control state.
 */
export function actionCheckpointRecords(state: SessionFeedbackState, limit = 8): ActionCheckpointRecord[] {
  const unresolvedStates: readonly ReceiptState[] = ["queued", "dispatched", "unknown"];
  const unresolved = [...state.actions.values()]
    .filter(record => unresolvedStates.includes(record.state))
    .sort((left, right) => left.checkpointRevision - right.checkpointRevision)
    .slice(0, limit);
  // Zero remaining capacity means zero settled records: `slice(-0)` would select
  // the whole settled history and displace the oldest unresolved tombstone.
  const room = Math.max(0, limit - unresolved.length);
  const settled = room === 0
    ? []
    : [...state.actions.values()]
      .filter(record => !unresolvedStates.includes(record.state))
      .sort((left, right) => left.checkpointRevision - right.checkpointRevision)
      .slice(-room);
  return [...unresolved, ...settled]
    .map(record => ({
      actionId: record.actionId,
      issueIds: [...record.issueIds].slice(0, 8),
      delivery: record.delivery,
      state: record.state,
      receiptRevision: record.receiptRevision,
      checkpointRevision: record.checkpointRevision,
      updatedAt: record.createdAt,
    }));
}

/**
 * Restart reconciliation: durable intents return the same action identity and
 * suppression set. The pending note itself is never recreated, so a restart
 * cannot resend a note the host may already have delivered.
 */
export function restoreActionRecords(state: SessionFeedbackState, records: readonly ActionCheckpointRecord[]): FeedbackActionRecord[] {
  const restored: FeedbackActionRecord[] = [];
  for (const record of records) {
    if (state.actions.has(record.actionId)) continue;
    const suffix = Number.parseInt(record.actionId.replace(/^action-/u, ""), 10);
    if (Number.isFinite(suffix)) state.actionCounter = Math.max(state.actionCounter, suffix);
    for (const issue of record.issueIds) state.suppressedIssues.add(issue);
    const restoredRecord: FeedbackActionRecord = {
      actionId: record.actionId,
      issueIds: [...record.issueIds],
      findingRefs: [],
      delivery: record.delivery,
      state: record.state,
      receiptRevision: record.receiptRevision,
      destinationId: null,
      evidenceIds: [],
      errorCode: null,
      textBytes: 0,
      checkpointRevision: record.checkpointRevision,
      createdAt: record.updatedAt,
    };
    state.actions.set(restoredRecord.actionId, restoredRecord);
    restored.push(restoredRecord);
  }
  return restored;
}

/** Number of durable intents whose outcome is not yet resolved. */
export function unresolvedActionCount(state: SessionFeedbackState): number {
  const unresolvedStates: readonly ReceiptState[] = ["queued", "dispatched", "unknown"];
  return [...state.actions.values()].filter(record => unresolvedStates.includes(record.state)).length;
}

/** Bounded projection used for one action record in diagnostics (metadata only). */
export function actionRecordProjection(record: FeedbackActionRecord): JsonObject {
  return {
    actionId: record.actionId,
    state: record.state,
    receiptRevision: record.receiptRevision,
    delivery: record.delivery,
    destinationId: record.destinationId,
    textBytes: record.textBytes,
    checkpointRevision: record.checkpointRevision,
    issueRefs: [...record.issueIds].slice(0, 8),
    findingRefs: [...record.findingRefs].slice(0, 8),
    evidenceRefs: [...record.evidenceIds].slice(0, 8),
    errorCode: record.errorCode,
  } as JsonObject;
}

/** Host-facing request built from one admitted feedback action. */
export function feedbackRequestOf(input: {
  actionId: string;
  scope: Scope;
  delivery: "steer" | "follow-up";
  text: string;
  allowIdleStart: boolean;
}): FeedbackRequest {
  return {
    actionId: input.actionId,
    scope: input.scope,
    mode: input.delivery,
    text: input.text,
    allowIdleStart: input.allowIdleStart,
  };
}
