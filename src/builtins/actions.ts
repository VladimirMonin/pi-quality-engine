// Built-in C1 actions.
//
// `core.feedback` delivers one bounded advisory note through the host feedback
// boundary. The runtime owns admission, the rendered text, the dispatch intent
// and the receipt reconciliation; this action only forwards an already admitted
// request and reports the strongest host-confirmed receipt state. It never
// renders reasoning, never impersonates operator input and never widens access.

import { feedbackRequestOf } from "../feedback.js";
import type { ActionContext, ActionDefinition, AdmittedAction, EffectReceipt } from "../contracts.js";

export const feedbackAction: ActionDefinition = {
  id: "core.feedback",
  apiMajor: 1,
  kind: "action",
  effects: ["primary.feedback"],
  optionsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      findingIds: { type: "array", items: { type: "string" } },
      delivery: { type: "string", enum: ["steer", "follow-up"] },
      allowIdleStart: { type: "boolean" },
      feedbackTemplate: { type: "string" },
      text: { type: "string" },
      bytes: { type: "integer" },
    },
  },
  requiredCapabilities: ["host.feedback.steer"],
  diagnosticCodes: ["core.feedback-delivered", "core.feedback-rejected", "core.feedback-unknown"],
  async execute(input: AdmittedAction, ctx: ActionContext): Promise<EffectReceipt> {
    const options = input.proposal.options;
    const text = typeof options["text"] === "string" ? options["text"] : null;
    const delivery = options["delivery"] === "follow-up" ? "follow-up" : "steer";
    const allowIdleStart = options["allowIdleStart"] === true;
    if (text === null || text.trim().length === 0) {
      return {
        actionId: input.actionId,
        state: "rejected",
        destinationId: null,
        evidenceIds: [],
        error: { code: "core.feedback-render-missing", retryable: false },
      };
    }
    const capability = delivery === "follow-up" ? "host.feedback.idle-start" : "host.feedback.steer";
    if (!ctx.host.capabilities().has(capability)) {
      return {
        actionId: input.actionId,
        state: "rejected",
        destinationId: null,
        evidenceIds: [],
        error: { code: "core.feedback-unsupported", retryable: false },
      };
    }
    return ctx.host.deliver(feedbackRequestOf({
      actionId: input.actionId,
      scope: input.run.scope,
      delivery,
      text,
      allowIdleStart,
    }), ctx.signal);
  },
};

/**
 * K07 C1 `core.request-check`: the ordinary expert escalation action. It asks the
 * runtime for one owned check run of the configured target and reports the actual
 * resulting run identity; it never claims that the expert completed.
 */
export const requestCheckAction: ActionDefinition = {
  id: "core.request-check",
  apiMajor: 1,
  kind: "action",
  effects: ["evaluation.request"],
  optionsSchema: {
    type: "object",
    additionalProperties: false,
    required: ["checkId"],
    properties: {
      checkId: { type: "string", minLength: 1, maxLength: 128 },
      hypothesis: { type: "string", maxLength: 800 },
    },
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.escalation-requested", "core.escalation-refused"],
  async execute(admitted, ctx): Promise<EffectReceipt> {
    const checkId = typeof admitted.proposal.options["checkId"] === "string"
      ? admitted.proposal.options["checkId"] as string
      : "";
    if (checkId.length === 0) {
      return {
        actionId: admitted.actionId,
        state: "rejected",
        destinationId: null,
        evidenceIds: [],
        error: { code: "core.escalation-target-missing", retryable: false },
      };
    }
    const requested = await ctx.requestCheck(checkId, {
      parentRunId: admitted.run.runId,
      findingIds: [...admitted.proposal.findingIds],
      evidenceIds: [...admitted.proposal.evidenceIds],
      ...(typeof admitted.proposal.options["hypothesis"] === "string"
        ? { hypothesis: (admitted.proposal.options["hypothesis"] as string).slice(0, 800) }
        : {}),
    });
    if (!requested.ok) {
      return {
        actionId: admitted.actionId,
        state: "rejected",
        destinationId: null,
        evidenceIds: [],
        error: requested.error,
      };
    }
    // A queue/coalescing receipt carries the actual resulting run identity; the
    // expert's own conclusion arrives later through its normal assessment.
    return {
      actionId: admitted.actionId,
      state: "queued",
      destinationId: requested.value.runId,
      evidenceIds: [],
    };
  },
};
