// Built-in C1 triggers: count threshold and periodic deadline.
//
// Both are synchronous decision functions. They never start a timer, read a
// file or call a model; the scheduler owns deadlines and admission.

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
