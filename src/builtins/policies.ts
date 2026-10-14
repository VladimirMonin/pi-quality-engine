// Built-in canonical C1 policy: preserve the validated outcome and propose no
// effect. The runtime maps this no-action outcome to the observe-mode
// record-only O1 disposition.

import type { PolicyDecision, PolicyDefinition } from "../contracts.js";

export const recordOnlyPolicy: PolicyDefinition = {
  id: "core.record-only",
  apiMajor: 1,
  kind: "policy",
  optionsSchema: { type: "object", additionalProperties: false },
  requiredCapabilities: [],
  diagnosticCodes: ["core.observe-mode"],
  decide: (): PolicyDecision => ({
    outcome: "no-action",
    reasonCode: "observation-only",
    actions: [],
  }),
};
