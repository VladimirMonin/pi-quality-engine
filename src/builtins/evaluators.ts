// Built-in deterministic canonical evaluator: repeated top-level tool usage.
//
// The logic is real and data-driven over the assembled canonical context. It
// reports findings only for evidence present in the committed snapshot and
// keeps free-form prose out of the diagnostic projection by construction.

import type {
  AssessmentResult,
  ContextItem,
  EvaluatorDefinition,
  Finding,
} from "../contracts.js";

const REPEATED_TOOLS_DEFECT_CODE = "core.repeated-tools";

function toolNameOf(item: ContextItem): string | null {
  for (const block of item.content) {
    if (block.type !== "json") continue;
    const value = block.value;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const toolName = (value as Record<string, unknown>)["toolName"];
      if (typeof toolName === "string") return toolName;
    }
  }
  return null;
}

export const repeatedToolsEvaluator: EvaluatorDefinition = {
  id: "core.repeated-tools",
  apiMajor: 1,
  kind: "evaluator",
  mechanism: "deterministic",
  accepts: ["json"],
  optionsSchema: {
    type: "object",
    properties: {
      window: { type: "integer", minimum: 1 },
      minimumRepeats: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: [REPEATED_TOOLS_DEFECT_CODE],
  async evaluate(options, input): Promise<AssessmentResult> {
    const minimumRepeats = typeof options["minimumRepeats"] === "number" ? options["minimumRepeats"] : 3;
    const history = input.context.items.filter(item =>
      item.provenance.sourceId === "core.history" && item.role === "evidence");
    const groups = new Map<string, { count: number; items: string[] }>();
    for (const item of history) {
      const toolName = toolNameOf(item);
      if (toolName === null) continue;
      const group = groups.get(toolName) ?? { count: 0, items: [] };
      group.count += 1;
      group.items.push(item.id);
      groups.set(toolName, group);
    }
    const criterion = input.assessment.criteria[0] ?? "efficiency.repetition";
    const findings: Finding[] = [];
    let findingIndex = 0;
    for (const [toolName, group] of groups) {
      if (group.count < minimumRepeats) continue;
      findingIndex += 1;
      findings.push({
        id: `${input.run.runId}:finding-${findingIndex}`,
        criterion,
        status: "supported",
        severity: "concern",
        requirementRefs: [],
        evidenceIds: group.items.slice(0, 16),
        affectedItems: group.items.slice(0, 16),
        defectCode: REPEATED_TOOLS_DEFECT_CODE,
        explanation: `Tool "${toolName}" repeated ${group.count} times in the observed primary window.`,
        proposedCorrection: null,
        limitations: [],
      });
    }
    const coverage = input.context.coverage;
    const conclusion = coverage.state !== "complete"
      ? "undetermined"
      : findings.length > 0
        ? "findings"
        : "no-supported-finding";
    return {
      operational: "completed",
      coverage,
      conclusion,
      findings,
      scores: [],
      additionalEvidence: [],
      dependencies: input.context.dependencies,
      usageAttemptIds: [],
    };
  },
};
