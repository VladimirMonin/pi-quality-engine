// Built-in C1 triggers: count, periodic, inactivity, no-progress, wait,
// evidence-change and completion eligibility.
//
// All are synchronous decision functions. They never start a timer, read a
// file or call a model; the scheduler owns deadlines and admission. A trigger
// that cannot observe its condition from the runtime view stays unavailable
// instead of guessing.

import type {
  JsonObject,
  RuntimeView,
  TriggerInput,
  TriggerMeasurements,
  TriggerUpdate,
  WorkState,
} from "../contracts.js";
import type { BuiltinTriggerDefinition } from "../scheduling.js";

export interface BuiltinTriggerInput extends TriggerInput {
  eligibleWorkStates: readonly WorkState[];
  nextDueMonoMs: number | null;
}

function eligible(input: TriggerInput): boolean {
  const workStates = (input as BuiltinTriggerInput).eligibleWorkStates;
  return workStates.includes(input.view.work);
}

function currentNextDue(input: TriggerInput): number | null {
  return (input as BuiltinTriggerInput).nextDueMonoMs;
}

export const everyToolsTrigger: BuiltinTriggerDefinition = {
  id: "core.every-tools",
  apiMajor: 1,
  kind: "trigger",
  optionsSchema: {
    type: "object",
    properties: {
      count: { type: "integer", minimum: 1 },
      includeNested: { type: "boolean" },
    },
    required: ["count"],
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.threshold-crossed"],
  initialState: () => ({ cursor: 0, lastCrossed: 0 }),
  update(options, input): TriggerUpdate {
    const count = Number(options["count"]);
    const state = input.state as { cursor?: number; lastCrossed?: number };
    const total = input.view.counters.completedPrimaryTools;
    if (input.cause === "activation") {
      // Existing completions are not newly due work for this binding.
      return { state: { cursor: total, lastCrossed: 0 }, intent: null, nextDueMonoMs: null };
    }
    const consumed = typeof state.cursor === "number" ? state.cursor : total;
    const delta = total - consumed;
    if (input.cause === "observation" && delta >= count) {
      const crossed = Math.floor(delta / count);
      return {
        state: { cursor: consumed + crossed * count, lastCrossed: crossed },
        intent: {
          reasons: [{
            code: "core.threshold-crossed",
            evidenceIds: input.observation === null ? [] : [input.observation.id],
          }],
        },
        nextDueMonoMs: null,
      };
    }
    return { state: { cursor: consumed, lastCrossed: typeof state.lastCrossed === "number" ? state.lastCrossed : 0 }, intent: null, nextDueMonoMs: null };
  },
  measure(state: JsonObject, view: RuntimeView, options: JsonObject, _nowMonoMs: number): TriggerMeasurements {
    const lastCrossed = typeof state["lastCrossed"] === "number" ? state["lastCrossed"] : null;
    return {
      counter: "completedPrimaryTools",
      value: view.counters.completedPrimaryTools,
      threshold: Number(options["count"]),
      crossedThresholds: lastCrossed,
      elapsedMs: null,
      thresholdMs: null,
      lastActivityAgeMs: null,
      lastProgressAgeMs: null,
      activeOperationCount: view.activePrimaryOperations.length,
    };
  },
};

export const periodicTrigger: BuiltinTriggerDefinition = {
  id: "core.periodic",
  apiMajor: 1,
  kind: "trigger",
  optionsSchema: {
    type: "object",
    properties: {
      everyMs: { type: "integer", minimum: 1 },
      requireNewEvidence: { type: "boolean" },
    },
    required: ["everyMs"],
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.interval-elapsed"],
  initialState: () => ({ evidenceCursor: 0, lastIntentMonoMs: null }),
  update(options, input): TriggerUpdate {
    const everyMs = Number(options["everyMs"]);
    const requireNewEvidence = options["requireNewEvidence"] !== false;
    const state = input.state as { evidenceCursor?: number; lastIntentMonoMs?: number | null };
    if (input.cause === "activation") {
      return {
        state: {
          evidenceCursor: typeof state.evidenceCursor === "number" ? state.evidenceCursor : 0,
          lastIntentMonoMs: typeof state.lastIntentMonoMs === "number" ? state.lastIntentMonoMs : null,
        },
        intent: null,
        nextDueMonoMs: eligible(input) ? input.now.monoMs + everyMs : null,
      };
    }
    if (input.cause === "observation") {
      const pending = currentNextDue(input);
      if (pending === null && eligible(input)) {
        return { state: input.state, intent: null, nextDueMonoMs: input.now.monoMs + everyMs };
      }
      return { state: input.state, intent: null, nextDueMonoMs: pending };
    }
    // Deadline. Eligibility follows the live work state, never the clock alone.
    if (!eligible(input)) {
      if (input.view.operatorStopped) {
        // The deadline still ran; the denied admission must be observable even
        // though stopped work is not eligible for autonomous evaluation.
        return {
          state: input.state,
          intent: { reasons: [{ code: "core.operator-stopped", evidenceIds: [] }] },
          nextDueMonoMs: null,
        };
      }
      return { state: input.state, intent: null, nextDueMonoMs: null };
    }
    const evidenceCursor = typeof state.evidenceCursor === "number" ? state.evidenceCursor : 0;
    if (requireNewEvidence && input.view.counters.primaryEvidenceRevision <= evidenceCursor) {
      return { state: input.state, intent: null, nextDueMonoMs: input.now.monoMs + everyMs };
    }
    return {
      state: { evidenceCursor: input.view.counters.primaryEvidenceRevision, lastIntentMonoMs: input.now.monoMs },
      intent: { reasons: [{ code: "core.interval-elapsed", evidenceIds: [] }] },
      nextDueMonoMs: input.now.monoMs + everyMs,
    };
  },
  measure(state: JsonObject, view: RuntimeView, options: JsonObject, nowMonoMs: number): TriggerMeasurements {
    const lastIntent = typeof state["lastIntentMonoMs"] === "number" ? state["lastIntentMonoMs"] : null;
    return {
      counter: null,
      value: null,
      threshold: null,
      crossedThresholds: null,
      elapsedMs: lastIntent === null ? null : Math.max(0, Math.round(nowMonoMs - lastIntent)),
      thresholdMs: Number(options["everyMs"]),
      lastActivityAgeMs: view.lastActivityMonoMs === null ? null : Math.max(0, Math.round(nowMonoMs - view.lastActivityMonoMs)),
      lastProgressAgeMs: view.lastProgressMonoMs === null ? null : Math.max(0, Math.round(nowMonoMs - view.lastProgressMonoMs)),
      activeOperationCount: view.activePrimaryOperations.length,
    };
  },
};


function timeMeasure(
  view: RuntimeView,
  nowMonoMs: number,
  elapsedMs: number | null,
  thresholdMs: number,
): TriggerMeasurements {
  return {
    counter: null,
    value: null,
    threshold: null,
    crossedThresholds: null,
    elapsedMs: elapsedMs === null ? null : Math.max(0, Math.round(elapsedMs)),
    thresholdMs,
    lastActivityAgeMs: view.lastActivityMonoMs === null ? null : Math.max(0, Math.round(nowMonoMs - view.lastActivityMonoMs)),
    lastProgressAgeMs: view.lastProgressMonoMs === null ? null : Math.max(0, Math.round(nowMonoMs - view.lastProgressMonoMs)),
    activeOperationCount: view.activePrimaryOperations.length,
  };
}

export const inactivityTrigger: BuiltinTriggerDefinition = {
  id: "core.inactivity",
  apiMajor: 1,
  kind: "trigger",
  optionsSchema: {
    type: "object",
    properties: {
      afterMs: { type: "integer", minimum: 1 },
      repeatAfterMs: { type: ["integer", "null"], minimum: 1 },
    },
    required: ["afterMs"],
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.inactivity-due"],
  initialState: () => ({ baselineMonoMs: null, lastFiredMonoMs: null }),
  update(options, input): TriggerUpdate {
    const afterMs = Number(options["afterMs"]);
    const repeat = typeof options["repeatAfterMs"] === "number" ? options["repeatAfterMs"] : null;
    const state = input.state as { baselineMonoMs?: number | null; lastFiredMonoMs?: number | null };
    const baseline = typeof state.baselineMonoMs === "number" ? state.baselineMonoMs : null;
    const lastFired = typeof state.lastFiredMonoMs === "number" ? state.lastFiredMonoMs : null;
    if (!eligible(input)) return { state: { baselineMonoMs: baseline, lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: null };
    if (input.cause === "observation") {
      const current = currentNextDue(input);
      const activity = input.view.lastActivityMonoMs;
      // Newer activity refreshes the deadline instead of leaving an old due
      // time to fire too early.
      if (activity !== null && (baseline === null || activity > baseline)) {
        return { state: { baselineMonoMs: activity, lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: activity + afterMs };
      }
      if (current === null && (activity === null || lastFired === null || activity > lastFired)) {
        const base = activity ?? input.now.monoMs;
        return { state: { baselineMonoMs: base, lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: base + afterMs };
      }
      return { state: { baselineMonoMs: baseline, lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: current };
    }
    const base = baseline ?? input.now.monoMs;
    if (input.now.monoMs - base < afterMs) {
      return { state: { baselineMonoMs: base, lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: base + afterMs };
    }
    return {
      state: { baselineMonoMs: base, lastFiredMonoMs: input.now.monoMs },
      intent: { reasons: [{ code: "core.inactivity-due", evidenceIds: [] }] },
      nextDueMonoMs: repeat === null ? null : input.now.monoMs + repeat,
    };
  },
  measure(state: JsonObject, view: RuntimeView, options: JsonObject, nowMonoMs: number): TriggerMeasurements {
    const baseline = typeof state["baselineMonoMs"] === "number" ? state["baselineMonoMs"] : null;
    return timeMeasure(view, nowMonoMs, baseline === null ? null : nowMonoMs - baseline, Number(options["afterMs"]));
  },
};

export const noProgressTrigger: BuiltinTriggerDefinition = {
  id: "core.no-progress",
  apiMajor: 1,
  kind: "trigger",
  optionsSchema: {
    type: "object",
    properties: {
      afterMs: { type: "integer", minimum: 1 },
      repeatAfterMs: { type: ["integer", "null"], minimum: 1 },
      minimumTools: { type: "integer", minimum: 0 },
    },
    required: ["afterMs"],
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.no-progress-due"],
  initialState: () => ({ baselineMonoMs: null, lastFiredMonoMs: null }),
  update(options, input): TriggerUpdate {
    const afterMs = Number(options["afterMs"]);
    const repeat = typeof options["repeatAfterMs"] === "number" ? options["repeatAfterMs"] : null;
    const minimumTools = typeof options["minimumTools"] === "number" ? options["minimumTools"] : 0;
    const state = input.state as { baselineMonoMs?: number | null; lastFiredMonoMs?: number | null };
    const baseline = typeof state.baselineMonoMs === "number" ? state.baselineMonoMs : null;
    const lastFired = typeof state.lastFiredMonoMs === "number" ? state.lastFiredMonoMs : null;
    if (!eligible(input) || input.view.counters.completedPrimaryTools < minimumTools) {
      return { state: { baselineMonoMs: baseline, lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: null };
    }
    if (input.cause === "observation") {
      const current = currentNextDue(input);
      const progress = input.view.lastProgressMonoMs;
      // Supported progress refreshes the deadline; ordinary read activity
      // still does not, because it never advances lastProgressMonoMs.
      if (progress !== null && (baseline === null || progress > baseline)) {
        return { state: { baselineMonoMs: progress, lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: progress + afterMs };
      }
      if (current === null && (progress === null || lastFired === null || progress > lastFired)) {
        const base = progress ?? input.now.monoMs;
        return { state: { baselineMonoMs: base, lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: base + afterMs };
      }
      return { state: { baselineMonoMs: baseline, lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: current };
    }
    const base = baseline ?? input.now.monoMs;
    if (input.now.monoMs - base < afterMs) {
      return { state: { baselineMonoMs: base, lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: base + afterMs };
    }
    return {
      state: { baselineMonoMs: base, lastFiredMonoMs: input.now.monoMs },
      intent: { reasons: [{ code: "core.no-progress-due", evidenceIds: [] }] },
      nextDueMonoMs: repeat === null ? null : input.now.monoMs + repeat,
    };
  },
  measure(state: JsonObject, view: RuntimeView, options: JsonObject, nowMonoMs: number): TriggerMeasurements {
    const baseline = typeof state["baselineMonoMs"] === "number" ? state["baselineMonoMs"] : null;
    return timeMeasure(view, nowMonoMs, baseline === null ? null : nowMonoMs - baseline, Number(options["afterMs"]));
  },
};

export const waitDeadlineTrigger: BuiltinTriggerDefinition = {
  id: "core.wait-deadline",
  apiMajor: 1,
  kind: "trigger",
  optionsSchema: {
    type: "object",
    properties: {
      recheckAfterMs: { type: "integer", minimum: 1 },
      repeatAfterMs: { type: ["integer", "null"], minimum: 1 },
    },
    required: [],
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.wait-unresolved"],
  initialState: () => ({ lastFiredMonoMs: null }),
  update(options, input): TriggerUpdate {
    const recheckAfterMs = typeof options["recheckAfterMs"] === "number" ? options["recheckAfterMs"] : 60_000;
    const repeat = typeof options["repeatAfterMs"] === "number" ? options["repeatAfterMs"] : null;
    const state = input.state as { lastFiredMonoMs?: number | null };
    const lastFired = typeof state.lastFiredMonoMs === "number" ? state.lastFiredMonoMs : null;
    const pending = input.view.waits.filter(wait => wait.state === "pending");
    if (!eligible(input) || pending.length === 0) {
      return { state: { lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: null };
    }
    const observedSince = pending
      .map(wait => wait.reviewDueMonoMs)
      .filter((value): value is number => typeof value === "number");
    const since = observedSince.length > 0 ? Math.min(...observedSince) : input.now.monoMs;
    if (lastFired !== null && since <= lastFired) {
      const next = since + recheckAfterMs;
      return { state: { lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: next > input.now.monoMs ? next : input.now.monoMs + recheckAfterMs };
    }
    if (input.cause !== "deadline") {
      const next = since + recheckAfterMs;
      return { state: { lastFiredMonoMs: lastFired }, intent: null, nextDueMonoMs: next > input.now.monoMs ? next : input.now.monoMs + recheckAfterMs };
    }
    return {
      state: { lastFiredMonoMs: input.now.monoMs },
      intent: {
        reasons: [{
          code: "core.wait-unresolved",
          evidenceIds: pending.map(wait => wait.id).slice(0, 8),
        }],
      },
      nextDueMonoMs: repeat === null ? null : input.now.monoMs + repeat,
    };
  },
  measure(state: JsonObject, view: RuntimeView, options: JsonObject, nowMonoMs: number): TriggerMeasurements {
    void state;
    const pending = view.waits.filter(wait => wait.state === "pending");
    const observedSince = pending
      .map(wait => wait.reviewDueMonoMs)
      .filter((value): value is number => typeof value === "number");
    const since = observedSince.length > 0 ? Math.min(...observedSince) : null;
    return timeMeasure(view, nowMonoMs, since === null ? null : nowMonoMs - since, Number(options["recheckAfterMs"]));
  },
};

export const evidenceChangeTrigger: BuiltinTriggerDefinition = {
  id: "core.evidence-change",
  apiMajor: 1,
  kind: "trigger",
  optionsSchema: {
    type: "object",
    properties: {
      sourceIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 128 }, minLength: 1, maxLength: 16 },
      debounceMs: { type: "integer", minimum: 0 },
      maxWaitMs: { type: "integer", minimum: 1 },
    },
    required: ["sourceIds"],
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.evidence-changed"],
  initialState: () => ({ observedRevision: 0, lastFiredRevision: 0, pendingSinceMonoMs: null }),
  update(options, input): TriggerUpdate {
    const debounceMs = typeof options["debounceMs"] === "number" ? options["debounceMs"] : 1_000;
    const maxWaitMs = typeof options["maxWaitMs"] === "number" ? options["maxWaitMs"] : 10_000;
    const state = input.state as { observedRevision?: number; lastFiredRevision?: number; pendingSinceMonoMs?: number | null };
    const revision = input.view.counters.primaryEvidenceRevision;
    const observed = typeof state.observedRevision === "number" ? state.observedRevision : 0;
    const lastFired = typeof state.lastFiredRevision === "number" ? state.lastFiredRevision : 0;
    const pendingSince = typeof state.pendingSinceMonoMs === "number" ? state.pendingSinceMonoMs : null;
    const selectedSources = Array.isArray(options["sourceIds"]) ? (options["sourceIds"] as readonly unknown[]) : [];
    if (!eligible(input)) {
      return { state: { observedRevision: revision, lastFiredRevision: lastFired, pendingSinceMonoMs: null }, intent: null, nextDueMonoMs: null };
    }
    if (input.cause === "deadline") {
      // A deadline may only fire the coalescing window that was actually armed
      // by a selected evidence change; an unselected source change never arms it.
      if (pendingSince !== null && revision > lastFired) {
        return {
          state: { observedRevision: revision, lastFiredRevision: revision, pendingSinceMonoMs: null },
          intent: { reasons: [{ code: "core.evidence-changed", evidenceIds: [...input.view.progressEvidenceIds].slice(0, 8) }] },
          nextDueMonoMs: null,
        };
      }
      return { state: { observedRevision: revision, lastFiredRevision: lastFired, pendingSinceMonoMs: null }, intent: null, nextDueMonoMs: null };
    }
    const observation = input.observation;
    if (observation !== null && observation.kind === "core.source-changed") {
      const changedSource = observation.facts["sourceId"];
      const selected = typeof changedSource === "string" && selectedSources.includes(changedSource);
      if (!selected) {
        // `sourceIds` is a real selection scope: a change from another source
        // must not arm or fire this binding through the aggregate revision.
        return {
          state: { observedRevision: observed, lastFiredRevision: lastFired, pendingSinceMonoMs: pendingSince },
          intent: null,
          nextDueMonoMs: currentNextDue(input),
        };
      }
      if (pendingSince === null) {
        return {
          state: { observedRevision: revision, lastFiredRevision: lastFired, pendingSinceMonoMs: input.now.monoMs },
          intent: null,
          nextDueMonoMs: input.now.monoMs + debounceMs,
        };
      }
      if (input.now.monoMs - pendingSince >= maxWaitMs) {
        return {
          state: { observedRevision: revision, lastFiredRevision: revision, pendingSinceMonoMs: null },
          intent: { reasons: [{ code: "core.evidence-changed", evidenceIds: [...input.view.progressEvidenceIds].slice(0, 8) }] },
          nextDueMonoMs: null,
        };
      }
      return {
        state: { observedRevision: revision, lastFiredRevision: lastFired, pendingSinceMonoMs: pendingSince },
        intent: null,
        nextDueMonoMs: Math.min(pendingSince + debounceMs, pendingSince + maxWaitMs),
      };
    }
    // Ordinary primary evidence belongs to the implemented aggregate history
    // scope. A binding that selects only other named scopes has no observable
    // evidence stream in S1, so the global counter must not bypass sourceIds.
    if (!selectedSources.includes("core.history")) {
      return {
        state: { observedRevision: observed, lastFiredRevision: lastFired, pendingSinceMonoMs: pendingSince },
        intent: null,
        nextDueMonoMs: currentNextDue(input),
      };
    }
    if (revision <= observed) {
      return { state: { observedRevision: observed, lastFiredRevision: lastFired, pendingSinceMonoMs: pendingSince }, intent: null, nextDueMonoMs: currentNextDue(input) };
    }
    if (pendingSince === null) {
      return { state: { observedRevision: revision, lastFiredRevision: lastFired, pendingSinceMonoMs: input.now.monoMs }, intent: null, nextDueMonoMs: input.now.monoMs + debounceMs };
    }
    if (input.now.monoMs - pendingSince >= maxWaitMs) {
      return {
        state: { observedRevision: revision, lastFiredRevision: revision, pendingSinceMonoMs: null },
        intent: { reasons: [{ code: "core.evidence-changed", evidenceIds: [...input.view.progressEvidenceIds].slice(0, 8) }] },
        nextDueMonoMs: null,
      };
    }
    return {
      state: { observedRevision: revision, lastFiredRevision: lastFired, pendingSinceMonoMs: pendingSince },
      intent: null,
      nextDueMonoMs: Math.min(pendingSince + debounceMs, pendingSince + maxWaitMs),
    };
  },
  measure(state: JsonObject, view: RuntimeView, options: JsonObject, nowMonoMs: number): TriggerMeasurements {
    void options;
    void nowMonoMs;
    void state;
    return {
      counter: "primaryEvidenceRevision",
      value: view.counters.primaryEvidenceRevision,
      threshold: null,
      crossedThresholds: null,
      elapsedMs: null,
      thresholdMs: null,
      lastActivityAgeMs: null,
      lastProgressAgeMs: null,
      activeOperationCount: view.activePrimaryOperations.length,
    };
  },
};

export const beforeCompletionTrigger: BuiltinTriggerDefinition = {
  id: "core.before-completion",
  apiMajor: 1,
  kind: "trigger",
  optionsSchema: {
    type: "object",
    properties: {
      requireChanges: { type: "boolean" },
    },
    required: [],
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.completion-boundary-reached"],
  initialState: () => ({ seenBoundaries: 0, evidenceAtLastFire: -1 }),
  update(options, input): TriggerUpdate {
    const requireChanges = options["requireChanges"] === true;
    const state = input.state as { seenBoundaries?: number; evidenceAtLastFire?: number };
    const seen = typeof state.seenBoundaries === "number" ? state.seenBoundaries : 0;
    const evidenceAtLastFire = typeof state.evidenceAtLastFire === "number" ? state.evidenceAtLastFire : -1;
    const boundaries = input.view.counters.completionBoundaries;
    if (boundaries <= seen) {
      return { state: { seenBoundaries: seen, evidenceAtLastFire }, intent: null, nextDueMonoMs: null };
    }
    if (requireChanges && input.view.counters.primaryEvidenceRevision <= evidenceAtLastFire) {
      return { state: { seenBoundaries: boundaries, evidenceAtLastFire }, intent: null, nextDueMonoMs: null };
    }
    return {
      state: { seenBoundaries: boundaries, evidenceAtLastFire: input.view.counters.primaryEvidenceRevision },
      intent: { reasons: [{ code: "core.completion-boundary-reached", evidenceIds: [] }] },
      nextDueMonoMs: null,
    };
  },
  measure(state: JsonObject, view: RuntimeView, _options: JsonObject, _nowMonoMs: number): TriggerMeasurements {
    void state;
    return {
      counter: "completionBoundaries",
      value: view.counters.completionBoundaries,
      threshold: null,
      crossedThresholds: null,
      elapsedMs: null,
      thresholdMs: null,
      lastActivityAgeMs: null,
      lastProgressAgeMs: null,
      activeOperationCount: view.activePrimaryOperations.length,
    };
  },
};
