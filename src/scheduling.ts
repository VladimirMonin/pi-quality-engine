// Runtime-owned clock, trigger bindings and bounded admission deadlines.
//
// Triggers are small synchronous decision functions: they receive an immutable
// view, their own state and a clock reading, and return an optional intent plus
// a next monotonic deadline. The scheduler owns every timer. It validates
// trigger results, contains trigger spin, coalesces nothing by itself and never
// executes a check, model call or primary effect.

import type {
  ContractError,
  JsonObject,
  Observation,
  RuntimeView,
  TriggerDefinition,
  TriggerInput,
  TriggerMeasurements,
  TriggerReason,
  TriggerUpdate,
  WorkState,
} from "./contracts.js";

export interface EngineClock {
  nowMonoMs(): number;
  nowUtc(): string;
  setTimer(delayMs: number, callback: () => void): () => void;
}

export function systemClock(): EngineClock {
  return {
    nowMonoMs: () => performance.now(),
    nowUtc: () => new Date().toISOString(),
    setTimer: (delayMs, callback) => {
      const timer = setTimeout(callback, Math.max(0, delayMs));
      return () => clearTimeout(timer);
    },
  };
}

/** Built-in triggers can describe their own closed measurement union. */
export interface BuiltinTriggerDefinition extends TriggerDefinition {
  measure(state: JsonObject, view: RuntimeView, options: JsonObject, nowMonoMs: number): TriggerMeasurements;
}

export interface TriggerBinding {
  checkId: string;
  bindingId: string;
  componentId: string;
  definition: TriggerDefinition;
  options: JsonObject;
  eligibleWorkStates: readonly WorkState[];
  state: JsonObject;
  nextDueMonoMs: number | null;
}

export interface SchedulerDue {
  checkId: string;
  bindingId: string;
  componentId: string;
  basis: "count" | "time" | "evidence" | "completion";
  reasons: TriggerReason[];
  measurements: TriggerMeasurements;
  firstDueAt: string;
}

export interface ClockResynchronized {
  cause: string;
  overdueBindings: number;
  coalescedIntents: number;
  elapsedHistoryKnown: boolean;
}

export interface TriggerDeadline {
  checkId: string;
  bindingId: string;
  phase: "armed" | "rearmed" | "disarmed";
  dueMonoMs: number | null;
  delayMs: number | null;
  reasonCode: string;
}

export interface SchedulerHost {
  onTriggerDue(due: SchedulerDue): void;
  onAdmissionDue(checkId: string): void;
  onTriggerDisabled(checkId: string, bindingId: string, componentId: string, reasonCode: string): void;
  /** Debug-profile timing visibility; optional so small hosts stay valid. */
  onClockResynchronized?(data: ClockResynchronized): void;
  /** Trace-profile deadline arm/rearm/disarm visibility; optional. */
  onDeadline?(data: TriggerDeadline): void;
}

/** A timer callback later than this is recovered timing, not a normal tick. */
const RESYNC_THRESHOLD_MS = 1_000;

const MAX_TRIGGER_STATE_KEYS = 64;

function genericMeasurements(view: RuntimeView, nowMonoMs: number): TriggerMeasurements {
  return {
    counter: null,
    value: null,
    threshold: null,
    crossedThresholds: null,
    elapsedMs: null,
    thresholdMs: null,
    lastActivityAgeMs: view.lastActivityMonoMs === null ? null : Math.max(0, Math.round(nowMonoMs - view.lastActivityMonoMs)),
    lastProgressAgeMs: view.lastProgressMonoMs === null ? null : Math.max(0, Math.round(nowMonoMs - view.lastProgressMonoMs)),
    activeOperationCount: view.activePrimaryOperations.length,
  };
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateUpdate(update: unknown): { ok: true; value: TriggerUpdate } | { ok: false; error: ContractError } {
  if (!isPlainObject(update)) return { ok: false, error: { code: "core.invalid-trigger-update", retryable: false } };
  const state = (update as Record<string, unknown>)["state"];
  if (!isPlainObject(state) || Object.keys(state).length > MAX_TRIGGER_STATE_KEYS) {
    return { ok: false, error: { code: "core.invalid-trigger-update", retryable: false, field: "state" } };
  }
  const intent = (update as Record<string, unknown>)["intent"];
  if (intent !== null && intent !== undefined) {
    if (!isPlainObject(intent)) return { ok: false, error: { code: "core.invalid-trigger-update", retryable: false, field: "intent" } };
    const reasons = intent["reasons"];
    if (!Array.isArray(reasons) || reasons.length === 0 || reasons.length > 16) {
      return { ok: false, error: { code: "core.invalid-trigger-update", retryable: false, field: "intent.reasons" } };
    }
    for (const reason of reasons) {
      if (!isPlainObject(reason) || typeof reason["code"] !== "string") {
        return { ok: false, error: { code: "core.invalid-trigger-update", retryable: false, field: "intent.reasons" } };
      }
    }
  }
  const nextDueMonoMs = (update as Record<string, unknown>)["nextDueMonoMs"];
  if (nextDueMonoMs !== null && (typeof nextDueMonoMs !== "number" || !Number.isFinite(nextDueMonoMs) || nextDueMonoMs < 0)) {
    return { ok: false, error: { code: "core.invalid-trigger-update", retryable: false, field: "nextDueMonoMs" } };
  }
  return { ok: true, value: update as unknown as TriggerUpdate };
}

export class Scheduler {
  readonly #clock: EngineClock;
  readonly #host: SchedulerHost;
  readonly #viewSource: () => RuntimeView;
  readonly #bindings = new Map<string, TriggerBinding[]>();
  readonly #admissionDeadlines = new Map<string, number>();
  #timer: (() => void) | null = null;
  #timerTargetMonoMs: number | null = null;
  #disposed = false;

  constructor(clock: EngineClock, host: SchedulerHost, viewSource: () => RuntimeView) {
    this.#clock = clock;
    this.#host = host;
    this.#viewSource = viewSource;
  }

  get clock(): EngineClock {
    return this.#clock;
  }

  register(binding: TriggerBinding): void {
    const existing = this.#bindings.get(binding.checkId) ?? [];
    existing.push(binding);
    this.#bindings.set(binding.checkId, existing);
  }

  unregisterCheck(checkId: string): void {
    this.#bindings.delete(checkId);
    this.#admissionDeadlines.delete(checkId);
    this.#rearm();
  }

  activate(checkId: string, view: RuntimeView): void {
    this.#updateBindings(checkId, "activation", null, view);
  }

  observe(view: RuntimeView, observation: Observation): void {
    for (const checkId of [...this.#bindings.keys()]) {
      this.#updateBindings(checkId, "observation", observation, view);
    }
  }

  scheduleAdmission(checkId: string, atMonoMs: number): void {
    this.#admissionDeadlines.set(checkId, atMonoMs);
    this.#rearm();
  }

  cancelAdmission(checkId: string): void {
    this.#admissionDeadlines.delete(checkId);
    this.#rearm();
  }

  /** Drops every binding and admission deadline without disposing the scheduler. */
  clear(): void {
    this.#bindings.clear();
    this.#admissionDeadlines.clear();
    this.#rearm();
  }

  /** Clears the owned timer. Trigger bindings and pending intents live in the runtime. */
  dispose(): void {
    this.#disposed = true;
    if (this.#timer !== null) {
      this.#timer();
      this.#timer = null;
      this.#timerTargetMonoMs = null;
    }
    this.#bindings.clear();
    this.#admissionDeadlines.clear();
  }

  #updateBindings(
    checkId: string,
    cause: "observation" | "deadline" | "activation",
    observation: Observation | null,
    view: RuntimeView,
  ): void {
    if (this.#disposed) return;
    const bindings = this.#bindings.get(checkId);
    if (bindings === undefined) return;
    const nowMonoMs = this.#clock.nowMonoMs();
    const utc = this.#clock.nowUtc();
    for (const binding of bindings) {
      const previousState = binding.state;
      const input = {
        cause,
        observation,
        now: { utc, monoMs: nowMonoMs },
        view,
        state: binding.state,
        eligibleWorkStates: binding.eligibleWorkStates,
        nextDueMonoMs: binding.nextDueMonoMs,
      } as TriggerInput & { eligibleWorkStates: readonly WorkState[]; nextDueMonoMs: number | null };
      let update: unknown;
      try {
        update = binding.definition.update(binding.options, input);
      } catch {
        this.#disable(binding, "core.trigger-error");
        continue;
      }
      const validated = validateUpdate(update);
      if (!validated.ok) {
        this.#disable(binding, validated.error.code);
        continue;
      }
      const next = validated.value;
      if (cause === "deadline" && next.nextDueMonoMs !== null && next.nextDueMonoMs <= nowMonoMs
        && JSON.stringify(previousState) === JSON.stringify(next.state)) {
        // A trigger that immediately re-requests itself without consuming state
        // would spin the event loop; it is disabled instead.
        this.#disable(binding, "core.trigger-spin");
        continue;
      }
      binding.state = next.state;
      binding.nextDueMonoMs = next.nextDueMonoMs;
      if (next.intent !== null && next.intent !== undefined) {
        const measurements = "measure" in binding.definition
          ? (binding.definition as BuiltinTriggerDefinition).measure(next.state, view, binding.options, nowMonoMs)
          : genericMeasurements(view, nowMonoMs);
        this.#host.onTriggerDue({
          checkId: binding.checkId,
          bindingId: binding.bindingId,
          componentId: binding.componentId,
          basis: binding.componentId === "core.every-tools"
            ? "count"
            : binding.componentId === "core.evidence-change"
              ? "evidence"
              : binding.componentId === "core.before-completion"
                ? "completion"
                : "time",
          reasons: [...next.intent.reasons],
          measurements,
          firstDueAt: utc,
        });
      }
    }
    this.#rearm();
  }

  #disable(binding: TriggerBinding, reasonCode: string): void {
    this.#host.onTriggerDisabled(binding.checkId, binding.bindingId, binding.componentId, reasonCode);
    const remaining = (this.#bindings.get(binding.checkId) ?? []).filter(entry => entry !== binding);
    if (remaining.length === 0) this.#bindings.delete(binding.checkId);
    else this.#bindings.set(binding.checkId, remaining);
    this.#rearm();
  }

  #rearm(): void {
    if (this.#disposed) return;
    let target: number | null = null;
    let targetCheckId = "scheduler";
    let targetBindingId = "scheduler";
    for (const [checkId, bindings] of this.#bindings.entries()) {
      for (const binding of bindings) {
        if (binding.nextDueMonoMs === null) continue;
        if (target === null || binding.nextDueMonoMs < target) {
          target = binding.nextDueMonoMs;
          targetCheckId = checkId;
          targetBindingId = binding.bindingId;
        }
      }
    }
    for (const [checkId, deadline] of this.#admissionDeadlines.entries()) {
      if (target === null || deadline < target) {
        target = deadline;
        targetCheckId = checkId;
        targetBindingId = "admission";
      }
    }
    if (target === null) {
      if (this.#timer !== null) {
        this.#timer();
        this.#timer = null;
        this.#timerTargetMonoMs = null;
        this.#emitDeadline({
          checkId: targetCheckId,
          bindingId: targetBindingId,
          phase: "disarmed",
          dueMonoMs: null,
          delayMs: null,
          reasonCode: "core.deadline-disarmed",
        });
      }
      return;
    }
    if (this.#timer !== null && this.#timerTargetMonoMs === target) return;
    const previousTarget = this.#timerTargetMonoMs;
    if (this.#timer !== null) this.#timer();
    this.#timerTargetMonoMs = target;
    const delay = Math.max(0, target - this.#clock.nowMonoMs());
    this.#emitDeadline({
      checkId: targetCheckId,
      bindingId: targetBindingId,
      phase: previousTarget === null ? "armed" : "rearmed",
      dueMonoMs: target,
      delayMs: Math.round(delay),
      reasonCode: previousTarget === null ? "core.deadline-armed" : "core.deadline-rearmed",
    });
    this.#timer = this.#clock.setTimer(delay, () => {
      const scheduledTarget = this.#timerTargetMonoMs;
      this.#timer = null;
      this.#timerTargetMonoMs = null;
      const latenessMs = scheduledTarget === null ? 0 : Math.max(0, this.#clock.nowMonoMs() - scheduledTarget);
      this.#fire(latenessMs);
    });
  }

  #emitDeadline(data: TriggerDeadline): void {
    try {
      this.#host.onDeadline?.(data);
    } catch {
      // Trace projection must never break scheduling.
    }
  }

  #fire(latenessMs: number): void {
    if (this.#disposed) return;
    const nowMonoMs = this.#clock.nowMonoMs();
    const dueCheckIds = new Set<string>();
    for (const [checkId, bindings] of this.#bindings.entries()) {
      if (bindings.some(binding => binding.nextDueMonoMs !== null && binding.nextDueMonoMs <= nowMonoMs)) {
        dueCheckIds.add(checkId);
      }
    }
    const admissionDue: string[] = [];
    for (const [checkId, deadline] of this.#admissionDeadlines.entries()) {
      if (deadline <= nowMonoMs) admissionDue.push(checkId);
    }
    if (latenessMs >= RESYNC_THRESHOLD_MS && dueCheckIds.size + admissionDue.length > 0) {
      // Recovered timing (sleep/resume or a delayed callback) is reported once
      // and coalesced per check instead of replaying every nominal interval.
      try {
        this.#host.onClockResynchronized?.({
          cause: "late-wake",
          overdueBindings: dueCheckIds.size + admissionDue.length,
          coalescedIntents: dueCheckIds.size,
          elapsedHistoryKnown: true,
        });
      } catch {
        // Debug projection must never break scheduling.
      }
    }
    for (const checkId of dueCheckIds) {
      this.#updateBindings(checkId, "deadline", null, this.#viewSource());
    }
    for (const checkId of admissionDue) {
      this.#admissionDeadlines.delete(checkId);
      this.#host.onAdmissionDue(checkId);
    }
    this.#rearm();
  }
}
