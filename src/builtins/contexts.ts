// Built-in canonical C1 context providers: current task, bounded recent primary
// work and identified waits. They return functional evidence items through the
// public ContextDefinition.collect contract; diagnostics only ever receive the
// projected metadata of what actually entered the run.

import { Buffer } from "node:buffer";
import type {
  ContentBlock,
  ContextBatch,
  ContextDefinition,
  ContextItem,
  CoverageIssue,
  EvidenceDependency,
  Json,
  JsonObject,
  Provenance,
  Result,
} from "../contracts.js";

const HISTORY_ITEM_CAP = 64;

export function contentBytes(content: readonly ContentBlock[]): number {
  return Buffer.byteLength(JSON.stringify(content), "utf8");
}

function itemBytes(content: readonly ContentBlock[]): number {
  return contentBytes(content);
}

function derivedProvenance(sourceId: string, uri: string, revision: string, acquiredAt: string, method: string, inputIds: string[] = []): Provenance {
  return {
    sourceId,
    uri,
    revision,
    acquiredAt,
    selection: { kind: "derived", inputIds, method },
    changedDuringRead: false,
  };
}

function makeItem(input: {
  id: string;
  role: ContextItem["role"];
  required: boolean;
  content: ContentBlock[];
  provenance: Provenance;
}): ContextItem {
  return {
    id: input.id,
    role: input.role,
    required: input.required,
    content: input.content,
    provenance: input.provenance,
    bytes: itemBytes(input.content),
    tokenEstimate: null,
  };
}

function boundedLimit(options: JsonObject, fallback: number, max: number): number {
  const supplied = options["limit"];
  return typeof supplied === "number" && Number.isInteger(supplied) && supplied > 0
    ? Math.min(supplied, max)
    : fallback;
}

export const taskProvider: ContextDefinition = {
  id: "core.task",
  apiMajor: 1,
  kind: "context",
  produces: ["json"],
  optionsSchema: { type: "object", additionalProperties: false },
  requiredCapabilities: [],
  diagnosticCodes: ["core.context.task-unavailable"],
  async collect(_options, ctx): Promise<Result<ContextBatch>> {
    const scope = ctx.view.scope;
    if (scope.episodeId === null) {
      return {
        ok: true,
        value: {
          items: [],
          coverage: {
            state: "partial",
            scopeDescription: "No authorized task episode is currently tracked.",
            issues: [{
              sourceId: "core.task",
              reason: "core.context.task-unavailable",
              required: false,
              evidenceIds: [],
            }],
          },
          dependencies: [],
        },
      };
    }
    const content: ContentBlock[] = [{
      type: "json",
      value: { presence: "present", episodeId: scope.episodeId, authorizationRevision: scope.authorizationRevision },
    }];
    return {
      ok: true,
      value: {
        items: [makeItem({
          id: `core.task:${scope.episodeId}`,
          role: "task",
          required: true,
          content,
          provenance: derivedProvenance("core.task", `episode:${scope.episodeId}`, scope.authorizationRevision, new Date().toISOString(), "core.task-episode"),
        })],
        coverage: { state: "complete", scopeDescription: "Current authorized task episode metadata.", issues: [] },
        dependencies: [],
      },
    };
  },
};

export const historyProvider: ContextDefinition = {
  id: "core.history",
  apiMajor: 1,
  kind: "context",
  produces: ["json"],
  optionsSchema: {
    type: "object",
    properties: {
      limit: { type: "integer", minimum: 1 },
      includeToolBodies: { type: "boolean" },
      maxBodyBytes: { type: "integer", minimum: 1 },
    },
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.context.history-window"],
  async collect(options, ctx): Promise<Result<ContextBatch>> {
    const limit = boundedLimit(options, 12, HISTORY_ITEM_CAP);
    const observations = ctx.evidence.recentObservations(limit);
    const items: ContextItem[] = [];
    const dependencies: EvidenceDependency[] = [];
    for (const observation of observations) {
      if (observation.kind !== "core.tool-completed") continue;
      if (observation.origin.kind !== "primary") continue;
      const toolName = typeof observation.facts["toolName"] === "string" ? observation.facts["toolName"] : null;
      const outcome = typeof observation.facts["outcome"] === "string" ? observation.facts["outcome"] : null;
      if (toolName === null || outcome === null) continue;
      const durationMs = typeof observation.facts["durationMs"] === "number" ? observation.facts["durationMs"] : null;
      const content: ContentBlock[] = [{
        type: "json",
        value: { toolName, outcome, durationMs } satisfies JsonObject,
      }];
      items.push(makeItem({
        id: `core.history:${observation.id}`,
        role: "evidence",
        required: false,
        content,
        provenance: derivedProvenance(
          "core.history",
          `observation:${observation.id}`,
          observation.id,
          observation.occurredAt,
          "core.history-window",
          [observation.id],
        ),
      }));
      dependencies.push({
        evidenceId: observation.id,
        revision: observation.id,
        relevance: "supporting",
        check: "host-cursor",
      });
    }
    return {
      ok: true,
      value: {
        items,
        coverage: {
          state: "complete",
          scopeDescription: `Bounded window of the last ${limit} primary tool completions.`,
          issues: [],
        },
        dependencies,
      },
    };
  },
};

export const waitsProvider: ContextDefinition = {
  id: "core.waits",
  apiMajor: 1,
  kind: "context",
  produces: ["json"],
  optionsSchema: { type: "object", additionalProperties: false },
  requiredCapabilities: [],
  diagnosticCodes: ["core.context.wait-record"],
  async collect(_options, ctx): Promise<Result<ContextBatch>> {
    const waits = ctx.view.waits.slice(0, 16);
    const items = waits.map(wait => makeItem({
      id: `core.waits:${wait.id}`,
      role: "evidence",
      required: false,
      content: [{ type: "json", value: { waitId: wait.id, state: wait.state, ownerId: wait.ownerId } satisfies JsonObject }],
      provenance: derivedProvenance("core.waits", `wait:${wait.id}`, wait.lastObservationId, new Date().toISOString(), "core.waits-view", [wait.lastObservationId]),
    }));
    return {
      ok: true,
      value: {
        items,
        coverage: {
          state: "complete",
          scopeDescription: "Identified waits and active operations for the current runtime view.",
          issues: [],
        },
        dependencies: [],
      },
    };
  },
};

export function contentValue(block: ContentBlock): Json {
  if (block.type === "text") return block.text;
  if (block.type === "json") return block.value;
  return { artifactId: block.artifactId, mimeType: block.mimeType, width: block.width, height: block.height };
}

export const filesProvider: ContextDefinition = {
  id: "core.files",
  apiMajor: 1,
  kind: "context",
  produces: ["text", "json"],
  optionsSchema: {
    type: "object",
    properties: {
      sourceIds: { type: "array", items: { type: "string", minLength: 1, maxLength: 128 }, minLength: 1, maxLength: 16 },
    },
    required: ["sourceIds"],
    additionalProperties: false,
  },
  requiredCapabilities: [],
  diagnosticCodes: ["core.source-missing", "core.source-denied", "core.source-truncated", "core.source-changed-during-read"],
  async collect(options, ctx): Promise<Result<ContextBatch>> {
    const sourceIds = options["sourceIds"];
    if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
      return { ok: false, error: { code: "core.context-batch-invalid", retryable: false } };
    }
    const items: ContextItem[] = [];
    const issues: CoverageIssue[] = [];
    const dependencies: EvidenceDependency[] = [];
    let requiredMissing = false;
    let partial = false;
    for (const sourceId of sourceIds) {
      if (typeof sourceId !== "string") continue;
      const batch = await ctx.evidence.readSource(sourceId, ctx.signal);
      if (!batch.ok) {
        partial = true;
        requiredMissing = true;
        issues.push({ sourceId, reason: batch.error.code, required: true, evidenceIds: [] });
        continue;
      }
      for (const item of batch.value.items) items.push(item);
      for (const dependency of batch.value.dependencies) dependencies.push(dependency);
      for (const issue of batch.value.coverage.issues) {
        issues.push(issue);
        if (issue.required) requiredMissing = true;
        else partial = true;
      }
      if (batch.value.coverage.state !== "complete") partial = true;
    }
    return {
      ok: true,
      value: {
        items,
        coverage: {
          state: requiredMissing ? "insufficient" : partial ? "partial" : "complete",
          scopeDescription: `Declared original sources: ${sourceIds.join(", ")}.`,
          issues: issues.slice(0, 16),
        },
        dependencies,
      },
    };
  },
};

export function createChangesProvider(collect: (options: JsonObject) => Result<ContextBatch>): ContextDefinition {
  return {
    id: "core.changes",
    apiMajor: 1,
    kind: "context",
    produces: ["text", "json"],
    optionsSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string", minLength: 1, maxLength: 256 }, minLength: 0, maxLength: 32 },
        includeUntracked: { type: "boolean" },
        maxFiles: { type: "integer", minimum: 1 },
        maxBytes: { type: "integer", minimum: 1 },
      },
      additionalProperties: false,
    },
    requiredCapabilities: [],
    diagnosticCodes: ["core.git-unavailable", "core.git-baseline-partial", "core.git-shared-worktree-attribution-uncertain"],
    async collect(options, _ctx): Promise<Result<ContextBatch>> {
      const paths = Array.isArray(options["paths"]) ? (options["paths"] as string[]) : ["**"];
      const includeUntracked = options["includeUntracked"] !== false;
      const maxFiles = typeof options["maxFiles"] === "number" ? Math.min(options["maxFiles"], 32) : 32;
      const maxBytes = typeof options["maxBytes"] === "number" ? Math.min(options["maxBytes"], 262_144) : 65_536;
      return collect({ paths, includeUntracked, maxFiles, maxBytes });
    },
  };
}
