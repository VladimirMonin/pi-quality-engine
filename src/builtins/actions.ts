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
