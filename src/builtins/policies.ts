// Built-in canonical C1 policies.
//
// `core.record-only` preserves the validated outcome and proposes no effect.
// `core.engineering` is the first normal feedback policy: it is a synchronous,
// bounded decision function that turns supported findings into advice
// proposals and suspected findings into a configured escalation request. It
// performs no host I/O, no model call and no scheduling; runtime admission
// revalidates every proposal against mode, grants, freshness, Stop and limits.

import type { Finding, JsonObject, PolicyDecision, PolicyDefinition } from "../contracts.js";

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

const SEVERITY_RANK: Record<string, number> = { info: 0, concern: 1, critical: 2 };

export const engineeringPolicy: PolicyDefinition = {
  id: "core.engineering",
  apiMajor: 1,
  kind: "policy",
  optionsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      minimumSeverity: { type: "string", enum: ["info", "concern", "critical"] },
      requireCompleteCoverage: { type: "boolean" },
      maxFindingsPerMessage: { type: "integer", minimum: 1, maximum: 8 },
      allowIdleContinuation: { type: "boolean" },
      escalateTo: { type: "string" },
      escalateOnPartial: { type: "boolean" },
      feedbackTemplate: { type: "string" },
    },
  },
  requiredCapabilities: [],
  diagnosticCodes: [
    "core.feedback-proposed",
    "core.partial-evidence",
    "core.no-supported-finding",
    "core.conflicting-requirements",
  ],
  decide: (options: JsonObject, input): PolicyDecision => {
    const option = <T>(key: string, fallback: T): T => (options[key] === undefined ? fallback : options[key] as T);
    const minimumSeverity = option("minimumSeverity", "concern");
    const minimumRank = SEVERITY_RANK[minimumSeverity] ?? 1;
    const requireComplete = option("requireCompleteCoverage", true);
    const maxFindings = option("maxFindingsPerMessage", 2);
    const escalateTo = option<string | null>("escalateTo", null);
    const escalateOnPartial = option("escalateOnPartial", false);
    const feedbackTemplate = option("feedbackTemplate", "builtin:feedback-v1.md");
    const conclusion = input.result.conclusion;
    if (conclusion === "conflicting-requirements") {
      // A contradictory result is inspectable but is not categorical advice.
      return { outcome: "no-action", reasonCode: "conflicting-requirements", actions: [] };
    }
    if (conclusion !== "findings") {
      return { outcome: "no-action", reasonCode: "no-supported-finding", actions: [] };
    }
    const supported = input.result.findings
      .filter(finding => finding.status === "supported" && (SEVERITY_RANK[finding.severity] ?? 0) >= minimumRank)
      .slice(0, maxFindings);
    if (supported.length === 0) {
      const suspected = input.result.findings.filter(finding => finding.status === "suspected");
      if (escalateTo !== null && suspected.length > 0) {
        return {
          outcome: "propose",
          reasonCode: "suspected-escalation",
          actions: [escalationProposal(escalateTo, suspected)],
        };
      }
      return { outcome: "no-action", reasonCode: "no-supported-finding", actions: [] };
    }
    const coverage = input.result.coverage.state;
    if (requireComplete && coverage !== "complete") {
      // A partial preliminary assessment can justify an explicitly allowed
      // expert investigation, never a categorical correction.
      if (escalateOnPartial && escalateTo !== null) {
        return {
          outcome: "propose",
          reasonCode: "partial-escalation",
          actions: [escalationProposal(escalateTo, supported)],
        };
      }
      return { outcome: "no-action", reasonCode: "partial-evidence", actions: [] };
    }
    const findingIds = supported.map(finding => finding.id);
    const evidenceIds = [...new Set(supported.flatMap(finding => finding.evidenceIds))].slice(0, 16);
    // An explicitly allowed idle continuation is still only a proposal: runtime
    // admission independently requires the operator grant, real idle evidence
    // and supported unfinished work before any wake is created.
    // The optional idle continuation is chosen only for an actually eligible
    // phase: permission alone never restarts a natural completion.
    const idleStart = option<boolean>("allowIdleContinuation", false) === true
      && input.view.execution === "idle"
      && input.view.outstandingWork === "supported";
    return {
      outcome: "propose",
      reasonCode: "supported-concern",
      actions: [{
        localId: "feedback-1",
        action: "core.feedback",
        options: {
          findingIds,
          delivery: idleStart ? "follow-up" : "steer",
          allowIdleStart: idleStart,
          feedbackTemplate,
        } as JsonObject,
        findingIds,
        evidenceIds,
        reasonCode: "core.feedback-proposed",
      }],
    };
  },
};

function escalationProposal(checkId: string, findings: readonly Finding[]): PolicyDecision["actions"][number] {
  const findingIds = findings.slice(0, 8).map(finding => finding.id);
  const evidenceIds = [...new Set(findings.flatMap(finding => finding.evidenceIds))].slice(0, 16);
  return {
    localId: "escalate-1",
    action: "core.request-check",
    options: { checkId } as JsonObject,
    findingIds,
    evidenceIds,
    reasonCode: "core.escalation-requested",
  };
}
