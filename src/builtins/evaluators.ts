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

// ---------------------------------------------------------------------------
// Direct model evaluators: structured chat and typed classifier assessment.
// Both dispatch only through the owned model service; no hidden route.
// ---------------------------------------------------------------------------

import type { AssessmentResult as DirectResult, EvaluationInput, JsonObject } from "../contracts.js";

function failedDirectResult(reasonCode: string): DirectResult {
  return {
    operational: "failed",
    coverage: { state: "insufficient", scopeDescription: "Direct model assessment did not produce a validated result.", issues: [{ sourceId: "core.runtime", reason: reasonCode, required: true, evidenceIds: [] }] },
    conclusion: "undetermined",
    findings: [],
    scores: [],
    additionalEvidence: [],
    dependencies: [],
    usageAttemptIds: [],
  };
}

function unavailableDirectResult(reasonCode: string): DirectResult {
  return { ...failedDirectResult(reasonCode), operational: "unavailable" };
}

export const chatEvaluator: EvaluatorDefinition = {
  id: "core.chat",
  apiMajor: 1,
  kind: "evaluator",
  mechanism: "direct-model",
  accepts: ["text", "json"],
  optionsSchema: {
    type: "object",
    properties: {
      maxOutputTokens: { type: "integer", minimum: 1 },
      repairAttempts: { type: "integer", minimum: 0, maximum: 1 },
    },
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.invalid-evaluation-result", "core.model-profile-required"],
  async evaluate(options, input, ctx): Promise<DirectResult> {
    if (input.modelProfileId === null) return unavailableDirectResult("core.model-profile-required");
    const maxOutputTokens = typeof options["maxOutputTokens"] === "number" ? options["maxOutputTokens"] : 4096;
    const repairAttempts = options["repairAttempts"] === 1 ? 1 : 0;
    let response = await ctx.services.request({
      runId: input.run.runId,
      profileId: input.modelProfileId,
      kind: "chat",
      context: input.context,
      assessment: input.assessment,
      maxOutputTokens,
    }, ctx.signal);
    if (!response.ok) return failedDirectResult(response.error.code);
    let output = response.value.output;
    if ((typeof output !== "object" || output === null || Array.isArray(output)) && repairAttempts === 1) {
      // One explicitly configured, separately billed repair attempt through the
      // same approved profile; it cannot add evidence or switch routes.
      response = await ctx.services.request({
        runId: input.run.runId,
        profileId: input.modelProfileId,
        kind: "chat",
        context: input.context,
        assessment: input.assessment,
        maxOutputTokens,
      }, ctx.signal);
      if (!response.ok) return failedDirectResult(response.error.code);
      output = response.value.output;
    }
    if (typeof output !== "object" || output === null || Array.isArray(output)) {
      return failedDirectResult("core.invalid-evaluation-result");
    }
    const result = output as unknown as DirectResult;
    // The runtime remains the validating boundary; attach the owned attempts
    // exactly as the model service issued them.
    return { ...result, usageAttemptIds: [...response.value.attemptIds] };
  },
};

export const classifierEvaluator: EvaluatorDefinition = {
  id: "core.classifier",
  apiMajor: 1,
  kind: "evaluator",
  mechanism: "direct-model",
  accepts: ["json"],
  optionsSchema: {
    type: "object",
    properties: {
      maxOutputTokens: { type: "integer", minimum: 1 },
      repairAttempts: { type: "integer", minimum: 0, maximum: 1 },
    },
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.classifier-questions-required", "core.invalid-evaluation-result"],
  async evaluate(options, input, ctx): Promise<DirectResult> {
    if (input.modelProfileId === null) return unavailableDirectResult("core.model-profile-required");
    if (input.assessment.questions === null) return failedDirectResult("core.classifier-questions-required");
    const response = await ctx.services.request({
      runId: input.run.runId,
      profileId: input.modelProfileId,
      kind: "classifier",
      context: input.context,
      assessment: input.assessment,
      maxOutputTokens: typeof options["maxOutputTokens"] === "number" ? options["maxOutputTokens"] : 1024,
    }, ctx.signal);
    if (!response.ok) return failedDirectResult(response.error.code);
    return mapProgressAnswers(response.value.output, input, response.value.attemptIds);
  },
};

/** progress-v1 mapping from C1 section 11.4; never manufactures evidence. */
function mapProgressAnswers(output: unknown, input: EvaluationInput, attemptIds: readonly string[]): DirectResult {
  if (typeof output !== "object" || output === null || Array.isArray(output)) {
    return failedDirectResult("core.invalid-evaluation-result");
  }
  const answers = output as Record<string, unknown>;
  const progress = answers["progress"] as Record<string, unknown> | undefined;
  const choice = progress !== undefined && typeof progress["choice"] === "string" ? progress["choice"] : null;
  const baseCoverage = input.context.coverage;
  if (choice === "repeating") {
    const evidenceIds = input.context.items.filter(item => item.provenance.sourceId === "core.history").map(item => item.id).slice(0, 8);
    const result: DirectResult = {
      operational: "completed",
      coverage: baseCoverage,
      conclusion: "findings",
      findings: [{
        id: "progress-repeating",
        criterion: input.assessment.criteria[0] ?? "efficiency.progress",
        status: "suspected",
        severity: "concern",
        requirementRefs: [],
        evidenceIds,
        affectedItems: [],
        defectCode: "efficiency.progress",
        explanation: "The typed progress classification reports substantially repeated ineffective activity without new evidence.",
        proposedCorrection: null,
        limitations: ["Classifier mapping is a suspicion, not a confirmed defect."],
      }],
      scores: [],
      additionalEvidence: [],
      dependencies: [],
      usageAttemptIds: [...attemptIds],
    };
    return result;
  }
  if (choice === "unclear") {
    return {
      operational: "completed",
      coverage: { ...baseCoverage, state: baseCoverage.state === "complete" ? "partial" : baseCoverage.state },
      conclusion: "undetermined",
      findings: [],
      scores: [],
      additionalEvidence: [],
      dependencies: [],
      usageAttemptIds: [...attemptIds],
    };
  }
  // progressing, waiting, or unresolved classification: no supported finding.
  return {
    operational: "completed",
    coverage: baseCoverage,
    conclusion: "no-supported-finding",
    findings: [],
    scores: [],
    additionalEvidence: [],
    dependencies: [],
    usageAttemptIds: [...attemptIds],
  };
}

void (0 as unknown as JsonObject);
