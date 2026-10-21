// Built-in canonical C1 prompt resource provider.
//
// It resolves declared built-in assessment resources to shipped files, returns
// them as canonical instruction ContextItems with content fingerprints, and
// supplies the engine's canonical evaluator-result schema. Prompt bodies are
// functional input for the evaluator and are never copied into diagnostics.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  AssessmentResources,
  ContentBlock,
  ContextBatch,
  ContextItem,
  DecisionQuestion,
  JsonSchema,
  JsonObject,
  PromptContext,
  PromptDefinition,
  Result,
} from "../contracts.js";

const BUILTIN_RESOURCE_PATTERN = /^builtin:([a-z0-9][a-z0-9.-]*\.(?:md|json))$/;
const MAX_RESOURCE_BYTES = 262_144;

// One structural contract for the default prompt AND the canonical boundary.
// The shipped JSON resource is its checked serialization (see contract tests).
// Reference existence, criterion ownership, score ranges and evidence authority
// remain contextual C1 checks; a matching string is not an issued reference.
const object = (properties: JsonObject, optional: readonly string[] = []): JsonObject => ({
  type: "object", properties, required: Object.keys(properties).filter(key => !optional.includes(key)), additionalProperties: false,
});
const array = (items: JsonSchema, maxItems?: number): JsonObject => ({
  type: "array", items, ...(maxItems === undefined ? {} : { maxItems }),
});
const string: JsonObject = { type: "string" };
const reference: JsonObject = {
  type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$",
  description: "Copy an actual issued context/evidence ID; never invent a source label, path or reference. Existence is checked separately.",
};
const contentBlock: JsonSchema = { anyOf: [
  object({ type: { enum: ["text"] }, text: string }),
  object({ type: { enum: ["json"] }, value: true }),
  object({ type: { enum: ["image"] }, artifactId: string, mimeType: string, width: { type: "integer", minimum: 0 }, height: { type: "integer", minimum: 0 } }),
] };
const selection: JsonSchema = { anyOf: [
  object({ kind: { enum: ["full"] } }),
  object({ kind: { enum: ["lines"] }, start: { type: "integer", minimum: 1 }, end: { type: "integer", minimum: 1 } }),
  object({ kind: { enum: ["sections"] }, headings: array(string) }),
  object({ kind: { enum: ["derived"] }, inputIds: array(string), method: string }),
] };

export const CANONICAL_RESULT_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "Canonical C1 assessment result",
  description: "Return this JSON object, not prose or a fenced fragment. Empty arrays are valid. Only report supplied criteria and issued references. Numeric scores must lie between their own minimum and maximum. Schema validity is not semantic truth, coverage authority or permission to act.",
  ...object({
    operational: { enum: ["completed", "unavailable", "failed", "cancelled"] },
    coverage: object({
      state: { enum: ["complete", "partial", "insufficient"] },
      scopeDescription: string,
      issues: array(object({ sourceId: string, reason: string, required: { type: "boolean" }, evidenceIds: array(reference) }), 32),
    }),
    conclusion: { enum: ["no-supported-finding", "findings", "conflicting-requirements", "undetermined"] },
    findings: array(object({
      id: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$", description: "Response-local finding ID, not an engine finding reference." },
      criterion: { type: "string", description: "Exactly one of this check's declared criteria." },
      status: { enum: ["suspected", "supported"] },
      severity: { enum: ["info", "concern", "critical"] },
      requirementRefs: array(reference, 32), evidenceIds: array(reference, 32), affectedItems: array(reference, 32),
      defectCode: { type: "string", pattern: "^[a-z][a-z0-9._:-]{0,95}$" },
      explanation: string, proposedCorrection: { type: ["string", "null"] }, limitations: array(string, 16),
    }), 64),
    scores: array(object({
      criterion: string, kind: { enum: ["probability", "ordinal", "numeric", "self-reported-confidence"] },
      value: { type: "number" }, minimum: { type: "number" }, maximum: { type: "number" },
      interpretation: string, calibrationRef: { type: ["string", "null"] },
    }), 32),
    additionalEvidence: array(object({
      id: string, role: { enum: ["task", "requirement", "evidence", "reference", "prior-finding"] }, required: { type: "boolean" },
      content: array(contentBlock),
      provenance: object({ sourceId: string, uri: string, revision: string, acquiredAt: string, selection, changedDuringRead: { type: "boolean" } }),
      bytes: { type: "number" },
      tokenEstimate: { anyOf: [{ type: "null" }, object({ count: { type: "integer", minimum: 0 }, method: string })] },
    }), 64),
    dependencies: array(object({ evidenceId: string, revision: string, relevance: { enum: ["authority", "conclusion", "supporting"] }, check: { enum: ["content-fingerprint", "host-cursor", "external-revision", "unknown"] } }), 64),
    usageAttemptIds: { ...array(reference, 16), description: "Owned attempt IDs only. For core.chat return []; the engine attaches the actual attempts, never model-invented billing IDs." },
    workInterpretation: object({ proposedState: { enum: ["work-expected", "waiting-dependency", "waiting-operator", "completion-candidate", "complete", "unknown"] }, outstandingWork: { enum: ["supported", "none", "unknown"] }, evidenceIds: array(reference), rationale: string }),
    extensions: { type: "object", description: "Optional namespaced data only under the evaluator's declared resultExtensions; never action authority.", additionalProperties: true },
    error: object({ code: string, retryable: { type: "boolean" }, field: string, details: { type: "object", additionalProperties: true } }, ["field", "details"]),
  }, ["workInterpretation", "extensions", "error"]),
  allOf: [
    { anyOf: [{ properties: { operational: { enum: ["completed"] } } }, { properties: { conclusion: { enum: ["undetermined"] } } }] },
    { anyOf: [
      { properties: { conclusion: { enum: ["findings"] }, findings: { minItems: 1 } } },
      { properties: { conclusion: { enum: ["no-supported-finding"] }, findings: { maxItems: 0 } } },
      { properties: { conclusion: { enum: ["conflicting-requirements", "undetermined"] } } },
    ] },
  ],
};

export function createPromptFilesProvider(resourcesDir: string): PromptDefinition {
  return {
    id: "core.prompt-files",
    apiMajor: 1,
    kind: "prompt",
    optionsSchema: {
      type: "object",
      properties: {
        instructions: { type: "array" },
        questions: { type: "string" },
        resultSchema: { type: "string" },
      },
      required: ["instructions"],
      additionalProperties: false,
    },
    requiredCapabilities: [],
    diagnosticCodes: ["core.prompt-resource-missing"],
    async build(options, ctx): Promise<Result<AssessmentResources>> {
      const instructions = Array.isArray(options["instructions"]) ? options["instructions"] : [];
      const items: ContextItem[] = [];
      const revisionParts: string[] = [];
      const resourceProvenance: Array<{ kind: "instruction" | "questions" | "resultSchema"; uri: string; revision: string; changedDuringRead: boolean }> = [];
      const readResource = async (uri: unknown, purpose: "instruction" | "questions" | "resultSchema"): Promise<{ text: string; uri: string; revision: string; acquiredAt: string; selection: ContextItem["provenance"]["selection"]; changedDuringRead: boolean } | null> => {
        if (typeof uri !== "string" || uri.length === 0) return null;
        const match = BUILTIN_RESOURCE_PATTERN.exec(uri);
        if (match !== null) {
          const name = match[1];
          if (name === undefined) return null;
          try {
            const path = join(resourcesDir, "prompts", name);
            const stats = await stat(path);
            if (!stats.isFile() || stats.size > MAX_RESOURCE_BYTES) return null;
            const text = await readFile(path, "utf8");
            const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
            return {
              text,
              uri,
              revision: `sha-${digest}`,
              acquiredAt: new Date().toISOString(),
              selection: { kind: "full" as const },
              changedDuringRead: false,
            };
          } catch {
            return null;
          }
        }
        // Local permitted resource: the canonical read path resolves the
        // target, applies protected/symlink exclusions before any bytes are
        // read, and reports the exact content revision.
        const batch = await (ctx.evidence.readPermittedFile as (p: string, s: AbortSignal, purpose?: "instruction" | "questions" | "resultSchema") => Promise<Result<ContextBatch>>)(uri, ctx.signal, purpose);
        if (!batch.ok) return null;
        const item = batch.value.items[0];
        if (item === undefined) return null;
        const text = item.content.map((block: ContentBlock) => (block.type === "text" ? (block.text ?? "") : "")).join("");
        // Acquisition facts are carried with the resource rather than rebuilt:
        // a true changed-during-read can never be rewritten as clean.
        return {
          text,
          uri: item.provenance.uri,
          revision: item.provenance.revision,
          acquiredAt: item.provenance.acquiredAt,
          selection: item.provenance.selection,
          changedDuringRead: item.provenance.changedDuringRead,
        };
      };
      for (const instruction of instructions) {
        if (typeof instruction !== "string") {
          return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false } };
        }
        const resource = await readResource(instruction, "instruction");
        if (resource === null) {
          return { ok: false, error: { code: "core.prompt-resource-missing", retryable: false } };
        }
        revisionParts.push(`${resource.uri}:${resource.revision}`);
        resourceProvenance.push({ kind: "instruction", uri: resource.uri, revision: resource.revision, changedDuringRead: resource.changedDuringRead });
        const content: ContentBlock[] = [{ type: "text", text: resource.text }];
        items.push({
          id: `core.prompt-files:${resource.revision}`,
          role: "reference",
          required: true,
          content,
          provenance: {
            sourceId: "core.prompt-files",
            uri: resource.uri,
            revision: resource.revision,
            acquiredAt: resource.acquiredAt,
            selection: resource.selection,
            changedDuringRead: resource.changedDuringRead,
          },
          bytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
          tokenEstimate: null,
        });
      }
      if (items.length === 0) {
        return { ok: false, error: { code: "core.prompt-resource-missing", retryable: false } };
      }
      let questions: Readonly<Record<string, DecisionQuestion>> | null = null;
      if (options["questions"] !== undefined) {
        const resource = await readResource(options["questions"], "questions");
        if (resource === null) return { ok: false, error: { code: "core.prompt-resource-missing", retryable: false } };
        revisionParts.push(`${resource.uri}:${resource.revision}`);
        resourceProvenance.push({ kind: "questions", uri: resource.uri, revision: resource.revision, changedDuringRead: resource.changedDuringRead });
        try {
          const parsed: unknown = JSON.parse(resource.text);
          if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
            return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false } };
          }
          questions = parsed as Readonly<Record<string, DecisionQuestion>>;
        } catch {
          return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false } };
        }
      }
      let resultSchema: JsonSchema = structuredClone(CANONICAL_RESULT_SCHEMA);
      const configuredSchema = options["resultSchema"] !== undefined;
      if (configuredSchema) {
        const resource = await readResource(options["resultSchema"], "resultSchema");
        if (resource === null) return { ok: false, error: { code: "core.prompt-resource-missing", retryable: false } };
        revisionParts.push(`${resource.uri}:${resource.revision}`);
        resourceProvenance.push({ kind: "resultSchema", uri: resource.uri, revision: resource.revision, changedDuringRead: resource.changedDuringRead });
        try {
          const parsed: unknown = JSON.parse(resource.text);
          if (typeof parsed !== "object" || parsed === null) {
            return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false } };
          }
          resultSchema = parsed as JsonSchema;
        } catch {
          return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false } };
        }
      } else {
        // Omitted configuration selects the canonical output contract; it is
        // an identified selected resource, not an absent one.
        const digest = createHash("sha256").update(JSON.stringify(resultSchema), "utf8").digest("hex").slice(0, 16);
        resourceProvenance.push({ kind: "resultSchema", uri: "builtin:evaluation-v1.schema.json", revision: `sha-${digest}`, changedDuringRead: false });
        revisionParts.push(`builtin:evaluation-v1.schema.json:sha-${digest}`);
      }
      const resourceRevision = `prompt-${createHash("sha256").update(revisionParts.join("\n"), "utf8").digest("hex").slice(0, 16)}`;
      return {
        ok: true,
        value: {
          resourceRevision,
          instructions: items,
          questions,
          resultSchema,
          criteria: [],
          configuredResources: {
            questions: options["questions"] !== undefined,
            resultSchema: options["resultSchema"] !== undefined,
          },
          resourceProvenance,
        },
      };
    },
  };
}
