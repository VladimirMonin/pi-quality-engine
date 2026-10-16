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
  PromptContext,
  PromptDefinition,
  Result,
} from "../contracts.js";

const BUILTIN_RESOURCE_PATTERN = /^builtin:([a-z0-9][a-z0-9.-]*\.(?:md|json))$/;
const MAX_RESOURCE_BYTES = 262_144;

/** Canonical evaluator-result schema for the deterministic builtin path. */
const CANONICAL_RESULT_SCHEMA: JsonSchema = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  required: ["operational", "coverage", "conclusion", "findings", "scores", "additionalEvidence", "dependencies", "usageAttemptIds"],
  additionalProperties: true,
  properties: {
    operational: { type: "string" },
    coverage: { type: "object" },
    conclusion: { type: "string" },
    findings: { type: "array" },
    scores: { type: "array" },
    additionalEvidence: { type: "array" },
    dependencies: { type: "array" },
    usageAttemptIds: { type: "array" },
  },
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
      let resultSchema: JsonSchema = CANONICAL_RESULT_SCHEMA;
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
