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
  ContextItem,
  DecisionQuestion,
  JsonSchema,
  PromptDefinition,
  Result,
} from "../contracts.js";

const BUILTIN_RESOURCE_PATTERN = /^builtin:([a-z0-9][a-z0-9.-]*\.md)$/;
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
      properties: { instructions: { type: "array" } },
      required: ["instructions"],
      additionalProperties: false,
    },
    requiredCapabilities: [],
    diagnosticCodes: ["core.prompt-resource-missing"],
    async build(options): Promise<Result<AssessmentResources>> {
      const instructions = Array.isArray(options["instructions"]) ? options["instructions"] : [];
      const items: ContextItem[] = [];
      const revisionParts: string[] = [];
      for (const instruction of instructions) {
        if (typeof instruction !== "string") {
          return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false } };
        }
        const match = BUILTIN_RESOURCE_PATTERN.exec(instruction);
        const name = match?.[1];
        if (name === undefined) {
          return { ok: false, error: { code: "core.prompt-resource-invalid", retryable: false } };
        }
        const path = join(resourcesDir, "prompts", name);
        let text: string;
        try {
          const stats = await stat(path);
          if (!stats.isFile() || stats.size > MAX_RESOURCE_BYTES) {
            return { ok: false, error: { code: "core.prompt-resource-missing", retryable: false } };
          }
          text = await readFile(path, "utf8");
        } catch {
          return { ok: false, error: { code: "core.prompt-resource-missing", retryable: false } };
        }
        const digest = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
        revisionParts.push(`${instruction}:${digest}`);
        const content: ContentBlock[] = [{ type: "text", text }];
        items.push({
          id: `core.prompt-files:${name}`,
          role: "reference",
          required: true,
          content,
          provenance: {
            sourceId: "core.prompt-files",
            uri: instruction,
            revision: `sha-${digest}`,
            acquiredAt: new Date().toISOString(),
            selection: { kind: "full" },
            changedDuringRead: false,
          },
          bytes: Buffer.byteLength(JSON.stringify(content), "utf8"),
          tokenEstimate: null,
        });
      }
      if (items.length === 0) {
        return { ok: false, error: { code: "core.prompt-resource-missing", retryable: false } };
      }
      const resourceRevision = `prompt-${createHash("sha256").update(revisionParts.join("\n"), "utf8").digest("hex").slice(0, 16)}`;
      const questions: Readonly<Record<string, DecisionQuestion>> | null = null;
      return {
        ok: true,
        value: {
          resourceRevision,
          instructions: items,
          questions,
          resultSchema: CANONICAL_RESULT_SCHEMA,
          criteria: [],
        },
      };
    },
  };
}
