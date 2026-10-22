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

function failedDirectResult(reasonCode: string, detailReason?: string): DirectResult {
  return {
    operational: "failed",
    coverage: { state: "insufficient", scopeDescription: "Direct model assessment did not produce a validated result.", issues: [{ sourceId: "core.runtime", reason: reasonCode, required: true, evidenceIds: [] }] },
    ...(detailReason === undefined ? {} : { error: { code: reasonCode, retryable: false, details: { reasonCode: detailReason } } }),
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
      return { ...failedDirectResult("core.invalid-evaluation-result", typeof output === "string" ? "core.assessment.parse" : "core.assessment.non-object"), usageAttemptIds: [...response.value.attemptIds] };
    }
    const result = output as unknown as DirectResult;
    // The runtime remains the validating boundary; attach the owned attempts
    // exactly as the model service issued them.
    return { ...result, usageAttemptIds: [...response.value.attemptIds] };
  },
};

import { admitClassifierAnswers, admitClassifierQuestions } from "../models.js";
import type { EvaluatorContext, JsonSchema } from "../contracts.js";

const PROGRESS_CHOICES = ["progressing", "repeating", "waiting", "unclear"] as const;
const QUALITY_CHOICES = ["concern", "not-established", "conflict", "insufficient"] as const;
const probabilitySchema = { type: "number", minimum: 0, maximum: 1 };
const choiceMetadataSchema = (choices: readonly string[], revision: string, progress: boolean): JsonSchema => ({
  type: "object", additionalProperties: false,
  required: ["revision", "choice", "probabilities", "nativeConfidence", ...(progress ? ["unfinished"] : ["scopeReferenceBasis"])],
  properties: {
    revision: { enum: [revision] }, choice: { enum: [...choices] },
    probabilities: { type: "object", additionalProperties: false, required: [...choices], properties: Object.fromEntries(choices.map(k => [k, probabilitySchema])) },
    nativeConfidence: { type: "number" },
    ...(progress ? { unfinished: { anyOf: [
      { type: "object", additionalProperties: false, required: ["state"], properties: { state: { enum: ["not-asked"] } } },
      { type: "object", additionalProperties: false, required: ["state", "probability"], properties: { state: { enum: ["asked"] }, probability: probabilitySchema } },
    ] } } : { scopeReferenceBasis: { enum: ["adapter-supplied-scope"] } }),
  },
});
const typedOptions = { type: "object", properties: { maxOutputTokens: { type: "integer", minimum: 1 }, repairAttempts: { type: "integer", minimum: 0, maximum: 0 }, mapping: { enum: ["progress-v1"] } }, additionalProperties: false } satisfies JsonSchema;
const typedCodes = ["core.classifier-questions-invalid", "core.classifier-answer-invalid", "core.classifier-mapping-incompatible", "core.classifier-scope-limit", "core.invalid-evaluation-result"];
function compatibleQuestions(input: EvaluationInput, quality: boolean): ReturnType<typeof admitClassifierQuestions> {
  const admitted = admitClassifierQuestions(input.assessment.questions);
  if (!admitted.ok) return admitted;
  const qs = admitted.value, primary = qs[quality ? "quality" : "progress"], wanted: readonly string[] = quality ? QUALITY_CHOICES : PROGRESS_CHOICES;
  const extra = Object.keys(qs).some(k => quality ? k !== "quality" : k !== "progress" && k !== "unfinished");
  if (extra || primary?.type !== "choice" || Object.keys(primary.criteria).length !== wanted.length || wanted.some(k => !(k in primary.criteria)) || (!quality && qs["unfinished"] !== undefined && qs["unfinished"].type !== "bool") || input.assessment.criteria.length !== 1) {
    return { ok: false, error: { code: "core.classifier-mapping-incompatible", retryable: false } };
  }
  return admitted;
}
function limited(result: DirectResult, reason: string): DirectResult {
  return { ...result, coverage: { ...result.coverage, state: result.coverage.state === "complete" ? "partial" : result.coverage.state, issues: [...result.coverage.issues, { sourceId: "core.classifier", reason, required: false, evidenceIds: [] }] }, conclusion: "undetermined" };
}
async function evaluateTyped(input: EvaluationInput, ctx: EvaluatorContext, quality: boolean): Promise<DirectResult> {
  if (input.modelProfileId === null) return unavailableDirectResult("core.model-profile-required");
  const questions = compatibleQuestions(input, quality);
  if (!questions.ok) return failedDirectResult(questions.error.code, "core.assessment.typed-answer");
  const requirements = input.context.items.filter(i => i.role === "requirement").map(i => i.id);
  const evidence = input.context.items.filter(i => i.role === "evidence" || i.role === "task").map(i => i.id);
  if (quality && (requirements.length > 32 || evidence.length > 32 || input.context.items.length > 64)) return failedDirectResult("core.classifier-scope-limit", "core.assessment.typed-answer");
  const response = await ctx.services.request({ runId: input.run.runId, profileId: input.modelProfileId, kind: "classifier", context: input.context, assessment: input.assessment, maxOutputTokens: 0 }, ctx.signal);
  if (!response.ok) return failedDirectResult(response.error.code, response.error.code === "core.classifier-answer-invalid" ? "core.assessment.typed-answer" : ctx.signal.aborted ? "core.assessment.cancelled" : "core.assessment.transport");
  const admitted = admitClassifierAnswers(response.value.output, questions.value);
  if (!admitted.ok) return { ...failedDirectResult(admitted.error.code, "core.assessment.typed-answer"), usageAttemptIds: [...response.value.attemptIds] };
  const answer = admitted.value[quality ? "quality" : "progress"] as JsonObject;
  const choice = answer["choice"] as string, probabilities = answer["probabilities"] as JsonObject;
  const metadata: JsonObject = { revision: quality ? "quality-decision-v1" : "progress-v1", choice, probabilities, nativeConfidence: answer["confidence"] ?? null };
  if (quality) metadata["scopeReferenceBasis"] = "adapter-supplied-scope";
  else metadata["unfinished"] = admitted.value["unfinished"] === undefined ? { state: "not-asked" } : { state: "asked", probability: (admitted.value["unfinished"] as JsonObject)["probability"] ?? null };
  const criterion = input.assessment.criteria[0] as string;
  let result: DirectResult = { operational: "completed", coverage: input.context.coverage, conclusion: input.context.coverage.state === "complete" ? "no-supported-finding" : "undetermined", findings: [],
    scores: [{ criterion, kind: "probability", value: probabilities[choice] as number, minimum: 0, maximum: 1, interpretation: "Normalized SDK selected-class probability; uncalibrated and distinct from native confidence.", calibrationRef: null }],
    additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [...response.value.attemptIds], extensions: { [quality ? "core.quality-decision-v1" : "core.progress-v1"]: metadata } };
  if (!quality && admitted.value["unfinished"] !== undefined) result = { ...result, scores: [...result.scores, { criterion, kind: "probability", value: (admitted.value["unfinished"] as JsonObject)["probability"] as number, minimum: 0, maximum: 1, interpretation: "Normalized SDK probability of unfinished=true; not task completion or continuation authority.", calibrationRef: null }] };
  if (quality && choice === "conflict") return { ...result, conclusion: "conflicting-requirements" };
  if (choice === "unclear" || choice === "insufficient") return limited(result, "core.classifier-limited");
  if (choice === "repeating" || (quality && choice === "concern")) {
    const refs = quality ? evidence : input.context.items.filter(i => i.role === "evidence" && i.provenance.sourceId === "core.history").map(i => i.id);
    if (refs.length === 0 || refs.length > 32) return limited(result, "core.classifier-evidence-missing");
    return { ...result, conclusion: "findings", findings: [{ id: quality ? "quality-packet-concern" : "progress-repeating", criterion, status: "suspected", severity: "concern", requirementRefs: quality ? requirements : [], evidenceIds: refs, affectedItems: [], defectCode: quality ? "core.quality-decision" : "efficiency.progress",
      explanation: quality ? "The whole-packet typed decision raises a suspicion requiring review; scope references were supplied by the adapter, not selected or explained by the classifier." : "The typed progress decision raises a suspicion of repeated ineffective activity in the supplied recent evidence.",
      proposedCorrection: null, limitations: ["Uncalibrated classifier suspicion, not a supported defect, line-level explanation, restart instruction or action grant."] }] };
  }
  return result;
}

export const classifierEvaluator: EvaluatorDefinition = {
  id: "core.classifier", apiMajor: 1, kind: "evaluator", mechanism: "direct-model", accepts: ["text", "json"], optionsSchema: typedOptions,
  requiredCapabilities: [], diagnosticCodes: typedCodes,
  resultExtensions: { "core.progress-v1": choiceMetadataSchema(PROGRESS_CHOICES, "progress-v1", true) },
  async evaluate(_options, input, ctx) { return evaluateTyped(input, ctx, false); },
};
export const qualityDecisionEvaluator: EvaluatorDefinition = {
  id: "core.quality-decision", apiMajor: 1, kind: "evaluator", mechanism: "direct-model", accepts: ["text", "json"],
  optionsSchema: { type: "object", properties: { repairAttempts: { type: "integer", minimum: 0, maximum: 0 }, mapping: { enum: ["quality-decision-v1"] } }, additionalProperties: false },
  requiredCapabilities: [], diagnosticCodes: typedCodes,
  resultExtensions: { "core.quality-decision-v1": choiceMetadataSchema(QUALITY_CHOICES, "quality-decision-v1", false) },
  async evaluate(_options, input, ctx) { return evaluateTyped(input, ctx, true); },
};

void (0 as unknown as JsonObject);

/** K05 clean Pi reviewer evaluator: a run-bound fresh session via services.review. */
export const piSessionEvaluator: EvaluatorDefinition = {
  id: "core.pi-session",
  apiMajor: 1,
  kind: "evaluator",
  mechanism: "pi-session",
  accepts: ["text", "json"],
  optionsSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      tools: { type: "array", items: { type: "string" } },
      readSources: { type: "array", items: { type: "string" } },
      allowProjectReads: { type: "boolean" },
      maxModelRequests: { type: "integer", minimum: 1, maximum: 16 },
      maxToolCalls: { type: "integer", minimum: 1, maximum: 64 },
      timeoutMs: { type: "integer", minimum: 1_000, maximum: 600_000 },
      maxOutputTokens: { type: "integer", minimum: 1, maximum: 65_536 },
      maxAdditionalReadBytes: { type: "integer", minimum: 0, maximum: 16_777_216 },
      compaction: { type: "string" },
      extensions: { type: "array", items: { type: "string" } },
      skills: { type: "array", items: { type: "string" } },
      resultMode: { type: "string" },
      repairAttempts: { type: "integer", minimum: 0, maximum: 1 },
    },
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.review-unavailable", "core.review-failed", "core.review-result-invalid", "core.reviewer-tool-admitted", "core.reviewer-tool-denied", "core.reviewer-tool-failed", "core.reviewer-tool-acquired", "core.reviewer-result-submitted"],
  async evaluate(options, input, ctx): Promise<DirectResult> {
    if (input.modelProfileId === null) return unavailableDirectResult("core.model-profile-required");
    if (ctx.services.review === undefined) return unavailableDirectResult("core.review-unavailable");
    // Exact C1 defaults, overridable only by the already-validated option set.
    const option = <T>(key: string, fallback: T): T => (options[key] === undefined ? fallback : options[key] as T);
    const reviewed = await ctx.services.review({
      run: input.run,
      context: input.context,
      profileId: input.modelProfileId,
      tools: option("tools", ["read", "grep", "find", "ls"] as string[]),
      readSources: option("readSources", [] as string[]),
      allowProjectReads: option("allowProjectReads", true),
      maxModelRequests: option("maxModelRequests", 4),
      maxToolCalls: option("maxToolCalls", 8),
      timeoutMs: option("timeoutMs", 120_000),
      maxOutputTokens: option("maxOutputTokens", Math.min(4_096, 4_096)),
      maxAdditionalReadBytes: option("maxAdditionalReadBytes", 262_144),
      compaction: "disabled",
      extensions: option("extensions", [] as string[]),
      skills: option("skills", [] as string[]),
      resultMode: "structured",
      repairAttempts: option<number>("repairAttempts", 0) === 1 ? 1 : 0,
    }, ctx.signal);
    if (!reviewed.ok) return failedDirectResult(reviewed.error.code);
    if (reviewed.value.validation !== "valid" || reviewed.value.output === null) {
      const reason = reviewed.value.terminalReason;
      const canonicalRejection = ["core.assessment.parse", "core.assessment.non-object", "core.assessment.structure", "core.assessment.consistency", "core.assessment.reference", "core.assessment.criterion", "core.assessment.score", "core.assessment.extension"].includes(reason);
      // Preserve the shared validator's safe category through the local FAILED
      // envelope. It remains failed, not a successful model abstention.
      return failedDirectResult(canonicalRejection ? "core.invalid-evaluation-result" : reason, canonicalRejection ? reason : undefined);
    }
    return reviewed.value.output as DirectResult;
  },
};
