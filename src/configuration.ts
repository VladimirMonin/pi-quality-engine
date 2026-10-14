import type { FoundationConfiguration, Result } from "./contracts.js";

export function resolveConfiguration(input: unknown): Result<FoundationConfiguration> {
  if (input !== undefined) {
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      return { ok: false, error: { code: "config.invalid-object", retryable: false, field: "$" } };
    }
    const keys = Object.keys(input);
    if (keys.some(key => !["schemaVersion", "enabled", "mode"].includes(key))) {
      return { ok: false, error: { code: "config.unknown-key", retryable: false, field: "$" } };
    }
    const candidate = input as Record<string, unknown>;
    if (candidate.schemaVersion !== 1) {
      return { ok: false, error: { code: "config.invalid-schema", retryable: false, field: "schemaVersion" } };
    }
    if (candidate.enabled !== undefined && typeof candidate.enabled !== "boolean") {
      return { ok: false, error: { code: "config.invalid-value", retryable: false, field: "enabled" } };
    }
    if (candidate.mode !== undefined && candidate.mode !== "observe" && candidate.mode !== "advise") {
      return { ok: false, error: { code: "config.invalid-value", retryable: false, field: "mode" } };
    }
    if (candidate.enabled === true || candidate.mode === "advise") {
      return { ok: false, error: { code: "config.capability-unavailable", retryable: false,
        field: candidate.enabled === true ? "enabled" : "mode" } };
    }
  }
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      enabled: false,
      mode: "observe",
      permissions: { modelProfiles: [], actions: [] },
      observability: {
        detail: "standard",
        capture: {
          documents: "none", prompts: "none", toolDescriptions: "none",
          toolArguments: "none", toolResults: "none", modelResponses: "none",
          images: "none", reasoning: "none",
        },
      },
    },
  };
}
