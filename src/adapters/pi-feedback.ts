// K06 feedback courier: turns one admitted engine action into one actual Pi
// boundary draft.
//
// The courier is engine/adapter owned bounded state. It never sends midway
// through a tool batch and never calls an opaque send API: the note leaves it
// only as a public boundary draft (`turn_end` / `agent_before_settle`) or as the
// `before_agent_start` message of the next run. Returning a draft is not
// "included"; inclusion is reported only after the note is observed in the
// actual transcript the provider receives.

import type { CustomMessageEntryDraft, SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import type { EffectReceipt, FeedbackRequest, HostFeedback, ReceiptState, Scope } from "../contracts.js";

/** Extension identifier used to recognize our own bounded note on reload. */
export const FEEDBACK_CUSTOM_TYPE = "pi-quality-engine.feedback.v1";

const DESTINATIONS = {
  "turn-end": "pi.primary.turn-end",
  "before-settle": "pi.primary.before-settle",
  "next-run": "pi.primary.next-run",
} as const;

type BoundaryKind = keyof typeof DESTINATIONS;

interface PendingNote {
  actionId: string;
  delivery: "steer" | "follow-up";
  content: string;
  allowIdleStart: boolean;
  /** The admitted owning scope; revalidated before every draft or message. */
  scope: Scope;
}

export interface FeedbackObservation {
  actionId: string;
  classification: "unknown";
  method: string;
  coverage: string;
}

export interface FeedbackCourierOptions {
  /** Reports the strongest host-observed receipt to the engine. */
  onReceipt: (receipt: EffectReceipt) => void;
  /** Reports a bounded feedback observation to the engine. */
  onObserved: (observation: FeedbackObservation) => void;
  /** Whether the owning engine generation still accepts receipts. */
  isActive: () => boolean;
  /** Configured bounded wait inside a boundary callback. */
  boundaryWaitMs: () => number;
  /** Waits, bounded, for owned checks already in flight to settle. */
  awaitBoundaryReady: (timeoutMs: number) => Promise<{ quiescent: boolean; waitedMs: number }>;
  /** Maximum pending notes held at once (bounded memory). */
  maxPending?: number;
  /** Revalidates an admitted scope at queue-to-draft time (runtime-owned fact). */
  revalidate?: (scope: Scope) => boolean;
}

/** Bounded text view of a provider payload: messages when present, else a capped stringify. */
function boundedPayloadText(payload: unknown, maxBytes = 262_144): string {
  if (typeof payload === "string") return payload.slice(0, maxBytes);
  if (typeof payload !== "object" || payload === null) return "";
  const messages = (payload as { messages?: unknown }).messages;
  if (Array.isArray(messages)) {
    let text = "";
    for (const message of messages.slice(0, 512)) {
      if (typeof message === "string") {
        text += `${message}\n`;
      } else if (typeof message === "object" && message !== null) {
        const content = (message as { content?: unknown }).content;
        if (typeof content === "string") text += `${content}\n`;
        else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null && typeof (block as { text?: unknown }).text === "string") {
              text += `${(block as { text: string }).text}\n`;
            }
          }
        }
      }
      if (text.length >= maxBytes) return text.slice(0, maxBytes);
    }
    return text.slice(0, maxBytes);
  }
  try {
    return JSON.stringify(payload).slice(0, maxBytes);
  } catch {
    return "";
  }
}

function receipt(actionId: string, state: ReceiptState, destinationId: string | null, errorCode: string | null = null): EffectReceipt {
  const base: EffectReceipt = { actionId, state, destinationId, evidenceIds: [] };
  return errorCode === null ? base : { ...base, error: { code: errorCode, retryable: false } };
}

/** Takes the first pending note matching the predicate; undefined when none is ready. */
function takeNote(queue: PendingNote[], predicate: (note: PendingNote) => boolean): PendingNote | undefined {
  const index = queue.findIndex(predicate);
  if (index < 0) return undefined;
  const [note] = queue.splice(index, 1);
  return note;
}

export class FeedbackCourier {
  readonly #options: FeedbackCourierOptions;
  readonly #maxPending: number;
  readonly #pending: PendingNote[] = [];
  readonly #appended = new Map<string, BoundaryKind>();
  readonly #observed = new Set<string>();
  readonly #terminal = new Map<string, ReceiptState>();

  constructor(options: FeedbackCourierOptions) {
    this.#options = options;
    this.#maxPending = Math.max(1, options.maxPending ?? 4);
  }

  /** C1 `HostFeedback` binding handed to the engine session input. */
  bindHost(): HostFeedback {
    return {
      capabilities: () => new Set<string>(["host.feedback.steer", "host.feedback.idle-start"]),
      deliver: async (request: FeedbackRequest): Promise<EffectReceipt> => this.accept(request),
      reconcile: async (actionId: string): Promise<EffectReceipt> => {
        const strong = this.#appended.get(actionId);
        if (strong !== undefined) return receipt(actionId, "dispatched", DESTINATIONS[strong]);
        const terminal = this.#terminal.get(actionId);
        if (terminal !== undefined) return receipt(actionId, terminal, null);
        if (this.#pending.some(note => note.actionId === actionId)) return receipt(actionId, "queued", null);
        return receipt(actionId, "unknown", null);
      },
    };
  }

  /** Host-side admission; the real effect happens later at a public boundary. */
  accept(request: FeedbackRequest): EffectReceipt {
    const text = typeof request.text === "string" ? request.text : "";
    if (!this.#options.isActive()) return receipt(request.actionId, "rejected", null, "core.feedback-stopped");
    if (request.actionId.length === 0 || text.trim().length === 0) {
      return receipt(request.actionId, "rejected", null, "core.feedback-empty-note");
    }
    if (this.#appended.has(request.actionId)) {
      const kind = this.#appended.get(request.actionId) as BoundaryKind;
      return receipt(request.actionId, "dispatched", DESTINATIONS[kind]);
    }
    if (this.#observed.has(request.actionId)) return receipt(request.actionId, "included", DESTINATIONS["next-run"]);
    if (this.#pending.some(note => note.actionId === request.actionId)) {
      // One owned operation identity: a duplicate delivery is the same pending note.
      return receipt(request.actionId, "queued", null);
    }
    if (this.#pending.length >= this.#maxPending) {
      return receipt(request.actionId, "rejected", null, "core.feedback-queue-full");
    }
    if (this.#options.revalidate !== undefined && !this.#options.revalidate(request.scope)) {
      // The admitted authority is already stale; the note never enters the queue.
      return receipt(request.actionId, "rejected", null, "core.feedback-scope-stale");
    }
    this.#pending.push({
      actionId: request.actionId,
      delivery: request.mode === "follow-up" ? "follow-up" : "steer",
      content: text,
      allowIdleStart: request.allowIdleStart === true,
      scope: request.scope,
    });
    return receipt(request.actionId, "queued", null);
  }

  /**
   * Draft for the `turn_end` boundary: steering notes wait for the actual end of
   * the current tool batch. Returns null when nothing is ready.
   */
  async turnEndDraft(eligibleForContinuation = true, abortedNow?: () => boolean): Promise<{ draft: CustomMessageEntryDraft; continue: boolean } | null> {
    if (abortedNow?.() === true) {
      this.cancel();
      return null;
    }
    const bound = this.#options.boundaryWaitMs();
    if (bound > 0) await this.#options.awaitBoundaryReady(bound);
    // Re-check after the awaited readiness wait: an abort during the wait must
    // not let an old-scope note be adopted or appended.
    if (abortedNow?.() === true) {
      this.cancel();
      return null;
    }
    if (!eligibleForContinuation) return null;
    const note = this.#takeCurrent("steer");
    if (note === undefined) return null;
    this.#appended.set(note.actionId, "turn-end");
    this.#report(note.actionId, "dispatched", DESTINATIONS["turn-end"]);
    // A busy steering note rides a turn that is already continuing; a naturally
    // ending turn is never forced to produce another provider request by a
    // queued steer - that note waits for the next actual run instead.
    return { draft: this.#entry(note), continue: true };
  }

  /** Message injected by `before_agent_start`; the note reaches the next run's first request. */
  nextRunMessage(): Pick<CustomMessageEntryDraft, "customType" | "content" | "display" | "details"> | null {
    const note = this.#takeCurrent("steer");
    if (note === undefined) return null;
    this.#appended.set(note.actionId, "next-run");
    this.#report(note.actionId, "dispatched", DESTINATIONS["next-run"]);
    const { type: _type, ...message } = this.#entry(note);
    return message;
  }

  /**
   * Draft for the `agent_before_settle` boundary. Only a separately granted
   * follow-up uses it, and only for a real continuation opportunity.
   */
  async beforeSettleDraft(context: { canContinue: boolean; aborted: boolean }): Promise<{ draft: CustomMessageEntryDraft; continue: boolean } | null> {
    if (context.aborted) {
      this.cancel();
      return null;
    }
    // A natural completion has no runnable context after the final assistant
    // message; appending the granted note is what makes the SDK continuation
    // valid. Admission already required both grants, current supported
    // unfinished work and a remaining allowance, so the boundary only has to
    // confirm that this was not an abort.
    const note = this.#takeCurrent("follow-up");
    if (note === undefined) return null;
    this.#appended.set(note.actionId, "before-settle");
    this.#report(note.actionId, "dispatched", DESTINATIONS["before-settle"]);
    return { draft: this.#entry(note), continue: true };
  }

  /**
   * Real inclusion evidence from the actual provider request payload. The note
   * carries its opaque action identity, so the payload that the provider is
   * about to receive either contains that identity or the receipt stays at its
   * narrower queued/dispatched strength. Preparation or transcript state alone
   * is never promoted to inclusion.
   */
  observeProviderInput(payload: unknown): void {
    if (!this.#options.isActive()) return;
    const text = boundedPayloadText(payload);
    if (text.length === 0) return;
    for (const actionId of this.#appended.keys()) {
      if (this.#observed.has(actionId)) continue;
      if (!text.includes(`[quality-advice ${actionId}]`)) continue;
      this.#observed.add(actionId);
      this.#report(actionId, "included", DESTINATIONS[this.#appended.get(actionId) ?? "next-run"]);
      this.#options.onObserved({
        actionId,
        classification: "unknown",
        method: "pi.provider-request-inclusion",
        coverage: "unknown",
      });
    }
  }

  /** A real abort or shutdown of undelivered notes; never a fabrication of progress. */
  cancel(): void {
    for (const note of this.#pending.splice(0, this.#pending.length)) {
      this.#report(note.actionId, "cancelled", null);
    }
  }

  /** Retire the courier; pending notes are cancelled, observed notes are untouched. */
  retire(): void {
    this.cancel();
  }

  pendingCount(): number {
    return this.#pending.length;
  }

  /** Drops notes whose admitted scope is no longer current and returns the next live one. */
  #takeCurrent(delivery: "steer" | "follow-up"): PendingNote | undefined {
    for (;;) {
      const note = takeNote(this.#pending, candidate => candidate.delivery === delivery);
      if (note === undefined) return undefined;
      if (this.#options.revalidate !== undefined && !this.#options.revalidate(note.scope)) {
        this.#report(note.actionId, "cancelled", null);
        continue;
      }
      return note;
    }
  }

  #entry(note: PendingNote): CustomMessageEntryDraft {
    return {
      type: "custom_message",
      customType: FEEDBACK_CUSTOM_TYPE,
      content: note.content,
      display: true,
      details: { actionId: note.actionId, delivery: note.delivery, allowIdleStart: note.allowIdleStart },
    };
  }

  #report(actionId: string, state: ReceiptState, destinationId: string | null): void {
    if (state === "cancelled" || state === "rejected" || state === "failed") this.#terminal.set(actionId, state);
    this.#options.onReceipt(receipt(actionId, state, destinationId));
  }
}

/** Boundary draft union member produced by this module. */
export type FeedbackBoundaryDraft = Extract<SessionBoundaryDraft, { type: "custom_message" }>;
