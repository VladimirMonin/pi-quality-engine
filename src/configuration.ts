// C1 configuration discovery, restricted-format parsing and validation.
//
// The implemented slice resolves cold activation flags, the operator permission
// ceiling, metadata-only observability, the bounded runtime limits and the S1
// deterministic check profile (prompts, contexts, evaluators, policies, checks).
// Valid C1 values outside that subset are rejected as unavailable instead of
// silently ignored. No raw configuration text or key name is copied into an
// error, a status snapshot or a diagnostic record.

import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";
import type {
  CheckDefinition,
  ConfigurationFormat,
  ConfigurationOrigin,
  ConfigurationSourceStatus,
  ContextPlan,
  ContextProviderBinding,
  ContractError,
  EngineConfiguration,
  EvaluatorProfile,
  Json,
  JsonObject,
  JournalSettings,
  ModelProfileDefinition,
  PermissionSettings,
  PolicyProfile,
  SourceDefinition,
  PromptBinding,
  SinkBinding,
  RecentHistoryLimits,
  DetailProfile,
  ResolvedConfiguration,
  RetentionSettings,
  Result,
  RuntimeSettings,
  TriggerBinding,
  WorkState,
} from "./contracts.js";

export const CONFIGURATION_FILE_MAX_BYTES = 1_048_576;
export const MAX_STRUCTURAL_DEPTH = 32;
export const MAX_MAP_ENTRIES = 256;

export const DEFAULT_RECENT_HISTORY: RecentHistoryLimits = { maxEvents: 512, maxBytes: 2_097_152 };
export const DEFAULT_JOURNAL_SETTINGS: JournalSettings = {
  enabled: true,
  directory: "agent:quality/logs",
  maxFileBytes: 10_485_760,
  rotationIntervalMs: null,
  compressArchives: false,
};
export const DEFAULT_RETENTION_SETTINGS: RetentionSettings = {
  maxArchivesPerSession: 4,
  maxAgeMs: 1_209_600_000,
  maxStorageBytes: 268_435_456,
};
export const DEFAULT_RUNTIME_SETTINGS: RuntimeSettings = {
  maxConcurrentEvaluations: 2,
  maxPendingChecks: 32,
  maxRequestsPerSession: 200,
  maxOwnedTokensPerSession: 400_000,
  unknownCost: "allow-with-token-limits",
  maxOwnedCost: null,
  maxEvidenceBytes: 16_777_216,
  defaultRunTimeoutMs: 180_000,
  maxRunTimeoutMs: 600_000,
  componentInitTimeoutMs: 10_000,
  componentStopTimeoutMs: 2_000,
};

const IMPLEMENTED_ROOT_KEYS = new Set([
  "schemaVersion", "enabled", "mode", "runtime", "permissions", "sources",
  "modelProfiles", "prompts", "contexts", "evaluators", "policies", "checks", "observability",
]);
const UNIMPLEMENTED_ROOT_KEYS = ["observationSources"] as const;

const RUNTIME_LIMITS: Record<string, { min: number; max: number }> = {
  maxConcurrentEvaluations: { min: 1, max: 16 },
  maxPendingChecks: { min: 1, max: 512 },
  maxRequestsPerSession: { min: 1, max: 10_000 },
  maxOwnedTokensPerSession: { min: 1_000, max: 1_000_000_000 },
  maxEvidenceBytes: { min: 65_536, max: 1_073_741_824 },
  defaultRunTimeoutMs: { min: 1_000, max: 600_000 },
  maxRunTimeoutMs: { min: 1_000, max: 600_000 },
  componentInitTimeoutMs: { min: 100, max: 60_000 },
  componentStopTimeoutMs: { min: 100, max: 60_000 },
};

const PERMISSION_DEFAULTS: Record<string, unknown> = {
  modelProfiles: [],
  actions: [],
  readRoots: ["project"],
  protectedPaths: [],
  externalSourceHosts: [],
  reviewTools: ["read", "grep", "find", "ls"],
  reviewExtensions: [],
  allowIdleContinuation: false,
  allowPrimaryAbort: false,
  maxFeedbackBytes: 2048,
};

const OBSERVABILITY_DEFAULTS: Record<string, unknown> = {
  pathDisclosure: "relative",
  maxRecordBytes: 65_536,
  maxCapturedBodyBytes: 8_192,
  maxSnapshotBytesPerRun: 1_048_576,
  presentation: "summary",
  sinks: [],
};

const CAPTURE_CATEGORIES = [
  "documents", "prompts", "toolDescriptions", "toolArguments",
  "toolResults", "modelResponses", "images", "reasoning",
] as const;

// Explicit standard YAML 1.2 core tags. Everything else, including tags that
// merely borrow the standard namespace prefix, is a custom tag.
const ALLOWED_YAML_TAGS = new Set([
  "tag:yaml.org,2002:str",
  "tag:yaml.org,2002:int",
  "tag:yaml.org,2002:float",
  "tag:yaml.org,2002:bool",
  "tag:yaml.org,2002:null",
  "tag:yaml.org,2002:map",
  "tag:yaml.org,2002:seq",
]);

function tagAllowed(tag: unknown): boolean {
  return tag === undefined || (typeof tag === "string" && ALLOWED_YAML_TAGS.has(tag));
}

const TEXT_CAPTURE_VALUES = new Set(["none", "excerpt", "full"]);
const IMAGE_CAPTURE_VALUES = new Set(["none", "full"]);
const WORK_STATES = new Set<WorkState>([
  "work-expected", "waiting-dependency", "waiting-operator",
  "completion-candidate", "complete", "unknown",
]);
const PRIORITIES = new Set(["low", "normal", "high"]);
const BUILTIN_PROMPT_RESOURCES = new Set([
  "builtin:repetition-v1.md", "builtin:progress-v1.md", "builtin:progress-v1.questions.json",
  "builtin:engineering-v1.md", "builtin:evaluation-v1.schema.json",
]);
const BUILTIN_CONTEXT_PROVIDERS = new Set(["core.task", "core.history", "core.waits", "core.files", "core.changes"]);
const BUILTIN_TRIGGERS = new Set([
  "core.every-tools", "core.periodic", "core.inactivity", "core.no-progress",
  "core.wait-deadline", "core.evidence-change", "core.before-completion",
]);
const BUILTIN_EVALUATORS = new Set(["core.repeated-tools", "core.chat", "core.classifier"]);
const MODEL_BACKED_EVALUATORS = new Set(["core.chat", "core.classifier"]);
const BUILTIN_POLICIES = new Set(["core.record-only"]);

const CONFIG_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const COMPONENT_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const CRITERION_ID_PATTERN = /^[a-z][a-z0-9.-]{0,127}$/;

const YAML_PARSE_OPTIONS = {
  schema: "core",
  uniqueKeys: true,
  maxAliasCount: 0,
  merge: false,
  prettyErrors: false,
} as const;

function reject(code: string, field: string, details?: JsonObject): { ok: false; error: ContractError } {
  if (details === undefined) return { ok: false, error: { code, retryable: false, field } };
  return { ok: false, error: { code, retryable: false, field, details } };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function jsonEquals(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isConfigId(value: unknown): value is string {
  return typeof value === "string" && CONFIG_ID_PATTERN.test(value);
}

function isComponentId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 192 && COMPONENT_ID_PATTERN.test(value);
}

function yamlErrorCode(code: string | undefined): string {
  switch (code) {
    case "DUPLICATE_KEY": return "config.duplicate-key";
    case "MULTIPLE_DOCS": return "config.multiple-documents";
    case "TAG_RESOLVE_FAILED": return "config.tag-not-allowed";
    default: return "config.invalid-syntax";
  }
}

/**
 * Inspects the YAML node tree for restrictions the C1 authoring form keeps:
 * no aliases, no custom tags on keys or values, string keys only, bounded depth
 * and map size. The walk runs before conversion so an unresolved construct
 * cannot be silently reinterpreted by the schema resolver.
 */
function inspectYamlNode(node: unknown, depth: number): ContractError | undefined {
  if (node === null || node === undefined) return undefined;
  if (isAlias(node)) return { code: "config.alias-not-allowed", retryable: false, field: "$" };
  if (!isNode(node)) return undefined;
  if (!tagAllowed((node as { tag?: unknown }).tag)) {
    return { code: "config.tag-not-allowed", retryable: false, field: "$" };
  }
  if (depth > MAX_STRUCTURAL_DEPTH) return { code: "config.too-deep", retryable: false, field: "$" };
  if (isMap(node)) {
    if (node.items.length > MAX_MAP_ENTRIES) {
      return { code: "config.too-many-entries", retryable: false, field: "$" };
    }
    for (const item of node.items) {
      if (!isScalar(item.key) || typeof item.key.value !== "string") {
        return { code: "config.non-string-key", retryable: false, field: "$" };
      }
      if (!tagAllowed(item.key.tag)) {
        return { code: "config.tag-not-allowed", retryable: false, field: "$" };
      }
      const nested = inspectYamlNode(item.value, depth + 1);
      if (nested !== undefined) return nested;
    }
    return undefined;
  }
  if (isSeq(node)) {
    for (const item of node.items) {
      const nested = inspectYamlNode(item, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** Converts a resolved YAML/JSON value into the plain JSON data model. */
function asJsonValue(value: unknown, depth: number): Result<Json> {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return { ok: true, value };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return reject("config.invalid-value", "$");
    return { ok: true, value };
  }
  if (depth > MAX_STRUCTURAL_DEPTH) return reject("config.too-deep", "$");
  if (Array.isArray(value)) {
    const items: Json[] = [];
    for (const item of value) {
      const nested = asJsonValue(item, depth + 1);
      if (!nested.ok) return nested;
      items.push(nested.value);
    }
    return { ok: true, value: items };
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length > MAX_MAP_ENTRIES) return reject("config.too-many-entries", "$");
    const result: JsonObject = {};
    for (const key of keys) {
      const nested = asJsonValue(value[key], depth + 1);
      if (!nested.ok) return nested;
      // Own properties are defined explicitly so a `__proto__` key survives the
      // copy and reaches validation instead of mutating the result prototype.
      Object.defineProperty(result, key, {
        value: nested.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { ok: true, value: result };
  }
  return reject("config.invalid-value", "$");
}

/**
 * Parses one configuration document with the restricted C1 authoring rules.
 * JSON is accepted because it is a subset of the same YAML 1.2 data model.
 */
export function parseConfigurationText(text: string): Result<JsonObject> {
  if (Buffer.byteLength(text, "utf8") > CONFIGURATION_FILE_MAX_BYTES) {
    return reject("config.too-large", "$");
  }
  let document;
  try {
    document = parseDocument(text, YAML_PARSE_OPTIONS);
  } catch {
    return reject("config.invalid-syntax", "$");
  }
  const firstError = document.errors[0];
  if (firstError !== undefined) return reject(yamlErrorCode(firstError.code), "$");
  const structure = inspectYamlNode(document.contents, 0);
  if (structure !== undefined) return { ok: false, error: structure };
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: 0 });
  } catch {
    return reject("config.alias-not-allowed", "$");
  }
  const json = asJsonValue(value, 0);
  if (!json.ok) return json;
  if (!isPlainObject(json.value)) return reject("config.invalid-object", "$");
  return { ok: true, value: json.value };
}

// ---------------------------------------------------------------------------
// Per-family validation
// ---------------------------------------------------------------------------

function validatePermissions(input: unknown): Result<Partial<PermissionSettings>> {
  if (input === undefined) return { ok: true, value: {} };
  if (!isPlainObject(input)) return reject("config.invalid-value", "$.permissions");
  const settings: Partial<PermissionSettings> = {};
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(PERMISSION_DEFAULTS, key)) return reject("config.unknown-key", "$.permissions");
    if (key === "modelProfiles") {
      const supplied = input[key];
      if (!Array.isArray(supplied) || supplied.length > 32
        || supplied.some(entry => typeof entry !== "string" || !isConfigId(entry))) {
        return reject("config.invalid-value", "$.permissions.modelProfiles");
      }
      settings.modelProfiles = [...new Set(supplied as string[])];
      continue;
    }
    if (!jsonEquals(input[key], PERMISSION_DEFAULTS[key])) {
      return reject("config.capability-unavailable", `$.permissions.${key}`);
    }
  }
  return { ok: true, value: settings };
}

function validateCapture(input: unknown): Result<true> {
  if (!isPlainObject(input)) return reject("config.invalid-value", "$.observability.capture");
  for (const key of Object.keys(input)) {
    if (!(CAPTURE_CATEGORIES as readonly string[]).includes(key)) {
      return reject("config.unknown-key", "$.observability.capture");
    }
    const supplied = input[key];
    const allowed = key === "images" ? IMAGE_CAPTURE_VALUES : TEXT_CAPTURE_VALUES;
    if (typeof supplied !== "string" || !allowed.has(supplied)) {
      return reject("config.invalid-value", `$.observability.capture.${key}`);
    }
    if (supplied !== "none") {
      return reject("config.capability-unavailable", `$.observability.capture.${key}`);
    }
  }
  return { ok: true, value: true };
}

function validateRecentHistory(input: unknown): Result<Partial<RecentHistoryLimits>> {
  if (!isPlainObject(input)) return reject("config.invalid-value", "$.observability.recentHistory");
  const limits: Partial<RecentHistoryLimits> = {};
  for (const key of Object.keys(input)) {
    if (key !== "maxEvents" && key !== "maxBytes") {
      return reject("config.unknown-key", "$.observability.recentHistory");
    }
    const supplied = input[key];
    // O1 24.8: a zero event/byte allowance means no retained recent history.
    // It is valid configuration and must not be redefined as invalid or unlimited.
    if (typeof supplied !== "number" || !Number.isInteger(supplied) || supplied < 0) {
      return reject("config.invalid-value", `$.observability.recentHistory.${key}`);
    }
    limits[key] = supplied;
  }
  return { ok: true, value: limits };
}

function validateJournalSettings(input: unknown): Result<Partial<JournalSettings>> {
  if (!isPlainObject(input)) return reject("config.invalid-value", "$.observability.journal");
  const settings: Partial<JournalSettings> = {};
  for (const key of Object.keys(input)) {
    const supplied = input[key];
    if (key === "enabled") {
      if (typeof supplied !== "boolean") return reject("config.invalid-value", "$.observability.journal.enabled");
      settings.enabled = supplied;
    } else if (key === "directory") {
      if (supplied !== DEFAULT_JOURNAL_SETTINGS.directory) {
        return reject("config.capability-unavailable", "$.observability.journal.directory");
      }
      settings.directory = DEFAULT_JOURNAL_SETTINGS.directory;
    } else if (key === "maxFileBytes") {
      if (typeof supplied !== "number" || !Number.isInteger(supplied) || supplied < 4_096 || supplied > 1_073_741_824) {
        return reject("config.invalid-value", "$.observability.journal.maxFileBytes");
      }
      settings.maxFileBytes = supplied;
    } else if (key === "rotationIntervalMs") {
      if (supplied !== null && (typeof supplied !== "number" || !Number.isInteger(supplied) || supplied < 250 || supplied > 86_400_000)) {
        return reject("config.invalid-value", "$.observability.journal.rotationIntervalMs");
      }
      settings.rotationIntervalMs = supplied as number | null;
    } else if (key === "compressArchives") {
      if (typeof supplied !== "boolean") return reject("config.invalid-value", "$.observability.journal.compressArchives");
      settings.compressArchives = supplied;
    } else {
      return reject("config.unknown-key", "$.observability.journal");
    }
  }
  return { ok: true, value: settings };
}

interface ObservabilitySubset {
  detail: DetailProfile;
  capture: EngineConfiguration["observability"]["capture"];
  recentHistory: Partial<RecentHistoryLimits>;
  journal: Partial<JournalSettings>;
  retention: Partial<RetentionSettings>;
  sinks: SinkBinding[];
}

function validateRetentionSettings(input: unknown): Result<Partial<RetentionSettings>> {
  if (!isPlainObject(input)) return reject("config.invalid-value", "$.observability.retention");
  const settings: Partial<RetentionSettings> = {};
  for (const key of Object.keys(input)) {
    if (key !== "maxArchivesPerSession" && key !== "maxAgeMs" && key !== "maxStorageBytes") {
      return reject("config.unknown-key", "$.observability.retention");
    }
    const supplied = input[key];
    if (typeof supplied !== "number" || !Number.isInteger(supplied) || supplied < 0) {
      return reject("config.invalid-value", `$.observability.retention.${key}`);
    }
    settings[key] = supplied;
  }
  return { ok: true, value: settings };
}

function validateObservability(input: unknown): Result<ObservabilitySubset> {
  const subset: ObservabilitySubset = {
    detail: "standard",
    capture: {
      documents: "none", prompts: "none", toolDescriptions: "none", toolArguments: "none",
      toolResults: "none", modelResponses: "none", images: "none", reasoning: "none",
    },
    recentHistory: {},
    journal: {},
    retention: {},
    sinks: [],
  };
  if (input === undefined) return { ok: true, value: subset };
  if (!isPlainObject(input)) return reject("config.invalid-value", "$.observability");
  for (const key of Object.keys(input)) {
    const supplied = input[key];
    if (key === "detail") {
      if (supplied !== "minimal" && supplied !== "standard" && supplied !== "debug" && supplied !== "trace") {
        return reject("config.invalid-value", "$.observability.detail");
      }
      subset.detail = supplied;
    } else if (key === "capture") {
      const capture = validateCapture(supplied);
      if (!capture.ok) return capture;
    } else if (key === "recentHistory") {
      const limits = validateRecentHistory(supplied);
      if (!limits.ok) return limits;
      subset.recentHistory = limits.value;
    } else if (key === "journal") {
      const journal = validateJournalSettings(supplied);
      if (!journal.ok) return journal;
      subset.journal = journal.value;
    } else if (key === "retention") {
      const retention = validateRetentionSettings(supplied);
      if (!retention.ok) return retention;
      subset.retention = retention.value;
    } else if (key === "sinks") {
      if (!Array.isArray(supplied) || supplied.length > 16) {
        return reject("config.invalid-value", "$.observability.sinks");
      }
      const sinks: SinkBinding[] = [];
      for (const [index, entry] of supplied.entries()) {
        if (!isPlainObject(entry)) return reject("config.invalid-value", `$.observability.sinks[${index}]`);
        for (const field of Object.keys(entry)) {
          if (field !== "id" && field !== "options") return reject("config.unknown-key", `$.observability.sinks[${index}]`);
        }
        const id = entry["id"];
        if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id)) {
          return reject("config.invalid-value", `$.observability.sinks[${index}].id`);
        }
        const options = entry["options"];
        if (options !== undefined && !isPlainObject(options)) {
          return reject("config.invalid-value", `$.observability.sinks[${index}].options`);
        }
        sinks.push({ id, ...(options === undefined ? {} : { options: options as JsonObject }) });
      }
      subset.sinks = sinks;
    } else if (Object.hasOwn(OBSERVABILITY_DEFAULTS, key)) {
      if (!jsonEquals(supplied, OBSERVABILITY_DEFAULTS[key])) {
        return reject("config.capability-unavailable", `$.observability.${key}`);
      }
    } else {
      return reject("config.unknown-key", "$.observability");
    }
  }
  return { ok: true, value: subset };
}

function validateRuntimeSettings(input: unknown): Result<Partial<RuntimeSettings>> {
  if (input === undefined) return { ok: true, value: {} };
  if (!isPlainObject(input)) return reject("config.invalid-value", "$.runtime");
  const settings: Partial<RuntimeSettings> = {};
  for (const key of Object.keys(input)) {
    if (key === "unknownCost") {
      const supplied = input[key];
      if (supplied !== "allow-with-token-limits" && supplied !== "deny") {
        return reject("config.invalid-value", "$.runtime.unknownCost");
      }
      settings.unknownCost = supplied;
      continue;
    }
    if (key === "maxOwnedCost") {
      const supplied = input[key];
      if (supplied === null || supplied === undefined) {
        settings.maxOwnedCost = null;
        continue;
      }
      if (!isPlainObject(supplied)) return reject("config.invalid-value", "$.runtime.maxOwnedCost");
      for (const field of Object.keys(supplied)) {
        if (field !== "currency" && field !== "amount") return reject("config.unknown-key", "$.runtime.maxOwnedCost");
      }
      const currency = supplied["currency"];
      const amount = supplied["amount"];
      if (typeof currency !== "string" || !/^[A-Z]{3,8}$/u.test(currency)) {
        return reject("config.invalid-value", "$.runtime.maxOwnedCost.currency");
      }
      if (typeof amount !== "string" || !/^[0-9]+(?:\.[0-9]+)?$/u.test(amount)) {
        return reject("config.invalid-value", "$.runtime.maxOwnedCost.amount");
      }
      settings.maxOwnedCost = { currency, amount };
      continue;
    }
    const limits = RUNTIME_LIMITS[key];
    if (limits === undefined) return reject("config.capability-unavailable", `$.runtime.${key}`);
    const supplied = input[key];
    if (typeof supplied !== "number" || !Number.isInteger(supplied) || supplied < limits.min || supplied > limits.max) {
      return reject("config.invalid-value", `$.runtime.${key}`);
    }
    (settings as Record<string, number>)[key] = supplied;
  }
  if (settings.defaultRunTimeoutMs !== undefined && settings.maxRunTimeoutMs !== undefined
    && settings.defaultRunTimeoutMs > settings.maxRunTimeoutMs) {
    return reject("config.invalid-value", "$.runtime.defaultRunTimeoutMs");
  }
  return { ok: true, value: settings };
}

function validateComponentRef(use: unknown, field: string): Result<string> {
  if (!isComponentId(use)) return reject("config.invalid-value", field);
  return { ok: true, value: use };
}

function validateTriggerBinding(input: unknown, field: string): Result<TriggerBinding> {
  if (!isPlainObject(input)) return reject("config.invalid-value", field);
  const allowed = new Set(["id", "use", "options"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return reject("config.unknown-key", field);
  }
  if (!isConfigId(input["id"])) return reject("config.invalid-value", `${field}.id`);
  const use = validateComponentRef(input["use"], `${field}.use`);
  if (!use.ok) return use;
  const options = input["options"] ?? {};
  if (!isPlainObject(options)) return reject("config.invalid-value", `${field}.options`);
  let normalized: JsonObject = options as JsonObject;
  if (BUILTIN_TRIGGERS.has(use.value)) {
    if (use.value === "core.every-tools") {
      for (const key of Object.keys(options)) {
        if (key !== "count" && key !== "includeNested") return reject("config.unknown-key", `${field}.options`);
      }
      const count = options["count"];
      if (typeof count !== "number" || !Number.isInteger(count) || count <= 0 || count > 1_000) {
        return reject("config.invalid-value", `${field}.options.count`);
      }
      if (options["includeNested"] !== undefined && options["includeNested"] !== false) {
        return reject("config.capability-unavailable", `${field}.options.includeNested`);
      }
    } else if (use.value === "core.periodic") {
      const allowed = new Set(["everyMs", "requireNewEvidence"]);
      for (const key of Object.keys(options)) {
        if (!allowed.has(key)) return reject("config.unknown-key", `${field}.options`);
      }
      const everyMs = options["everyMs"];
      if (typeof everyMs !== "number" || !Number.isInteger(everyMs) || everyMs <= 0 || everyMs > 86_400_000) {
        return reject("config.invalid-value", `${field}.options.everyMs`);
      }
      if (options["requireNewEvidence"] !== undefined && typeof options["requireNewEvidence"] !== "boolean") {
        return reject("config.invalid-value", `${field}.options.requireNewEvidence`);
      }
    } else if (use.value === "core.inactivity" || use.value === "core.no-progress") {
      const allowed = new Set(["afterMs", "repeatAfterMs", "minimumTools"]);
      for (const key of Object.keys(options)) {
        if (!allowed.has(key)) return reject("config.unknown-key", `${field}.options`);
      }
      const afterMs = options["afterMs"];
      if (typeof afterMs !== "number" || !Number.isInteger(afterMs) || afterMs <= 0 || afterMs > 86_400_000) {
        return reject("config.invalid-value", `${field}.options.afterMs`);
      }
      const repeat = options["repeatAfterMs"];
      if (repeat !== undefined && repeat !== null
        && (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat <= 0 || repeat > 86_400_000)) {
        return reject("config.invalid-value", `${field}.options.repeatAfterMs`);
      }
      if (options["minimumTools"] !== undefined && use.value !== "core.no-progress") {
        return reject("config.unknown-key", `${field}.options`);
      }
      const minimumTools = options["minimumTools"];
      if (minimumTools !== undefined
        && (typeof minimumTools !== "number" || !Number.isInteger(minimumTools) || minimumTools < 0 || minimumTools > 10_000)) {
        return reject("config.invalid-value", `${field}.options.minimumTools`);
      }
      normalized = {
        afterMs,
        repeatAfterMs: repeat === undefined ? null : repeat,
        ...(use.value === "core.no-progress" ? { minimumTools: typeof minimumTools === "number" ? minimumTools : 0 } : {}),
      };
    } else if (use.value === "core.wait-deadline") {
      const allowed = new Set(["recheckAfterMs", "repeatAfterMs"]);
      for (const key of Object.keys(options)) {
        if (!allowed.has(key)) return reject("config.unknown-key", `${field}.options`);
      }
      const recheck = options["recheckAfterMs"];
      if (recheck !== undefined
        && (typeof recheck !== "number" || !Number.isInteger(recheck) || recheck <= 0 || recheck > 86_400_000)) {
        return reject("config.invalid-value", `${field}.options.recheckAfterMs`);
      }
      const repeat = options["repeatAfterMs"];
      if (repeat !== undefined && repeat !== null
        && (typeof repeat !== "number" || !Number.isInteger(repeat) || repeat <= 0 || repeat > 86_400_000)) {
        return reject("config.invalid-value", `${field}.options.repeatAfterMs`);
      }
      // C1 gives recheckAfterMs a canonical 60,000 ms default and no required options.
      normalized = {
        recheckAfterMs: typeof recheck === "number" ? recheck : 60_000,
        repeatAfterMs: repeat === undefined ? null : repeat,
      };
    } else if (use.value === "core.evidence-change") {
      const allowed = new Set(["sourceIds", "debounceMs", "maxWaitMs"]);
      for (const key of Object.keys(options)) {
        if (!allowed.has(key)) return reject("config.unknown-key", `${field}.options`);
      }
      const sourceIds = options["sourceIds"];
      if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.length > 16
        || sourceIds.some(entry => typeof entry !== "string" || !/^[A-Za-z0-9._:-]{1,128}$/u.test(entry))) {
        return reject("config.invalid-value", `${field}.options.sourceIds`);
      }
      if (sourceIds.some(entry => entry !== "core.history")) {
        // S1 implements one aggregate primary-history evidence scope. Other
        // named observation scopes are honestly unavailable before dispatch
        // rather than accepted and silently ignored.
        return reject("config.capability-unavailable", `${field}.options.sourceIds`);
      }
      const debounceMs = options["debounceMs"];
      const maxWaitMs = options["maxWaitMs"];
      if (debounceMs !== undefined
        && (typeof debounceMs !== "number" || !Number.isInteger(debounceMs) || debounceMs < 0 || debounceMs > 86_400_000)) {
        return reject("config.invalid-value", `${field}.options.debounceMs`);
      }
      if (maxWaitMs !== undefined
        && (typeof maxWaitMs !== "number" || !Number.isInteger(maxWaitMs) || maxWaitMs < 0 || maxWaitMs > 86_400_000)) {
        return reject("config.invalid-value", `${field}.options.maxWaitMs`);
      }
      const resolvedDebounce = typeof debounceMs === "number" ? debounceMs : 1_000;
      const resolvedMaxWait = typeof maxWaitMs === "number" ? maxWaitMs : 10_000;
      if (resolvedMaxWait < resolvedDebounce) return reject("config.invalid-value", `${field}.options.maxWaitMs`);
      normalized = { sourceIds: [...sourceIds], debounceMs: resolvedDebounce, maxWaitMs: resolvedMaxWait };
    } else {
      for (const key of Object.keys(options)) {
        if (key !== "requireChanges") return reject("config.unknown-key", `${field}.options`);
      }
      if (options["requireChanges"] !== undefined && typeof options["requireChanges"] !== "boolean") {
        return reject("config.invalid-value", `${field}.options.requireChanges`);
      }
      normalized = { requireChanges: options["requireChanges"] === true };
    }
  }
  return { ok: true, value: { id: input["id"], use: use.value, options: options as JsonObject } };
}

function validateContextPlan(id: string, input: unknown): Result<ContextPlan> {
  const field = `$.contexts.${id}`;
  if (!isPlainObject(input)) return reject("config.invalid-value", field);
  const allowed = new Set(["providers", "maxBytes", "maxEstimatedTokens", "reserveOutputTokens", "requiredCoverage", "overflow"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return reject("config.unknown-key", field);
  }
  const providersInput = input["providers"];
  if (!Array.isArray(providersInput) || providersInput.length === 0 || providersInput.length > 32) {
    return reject("config.invalid-value", `${field}.providers`);
  }
  const providers: ContextProviderBinding[] = [];
  const seen = new Set<string>();
  for (const [index, providerInput] of providersInput.entries()) {
    const providerField = `${field}.providers[${index}]`;
    if (!isPlainObject(providerInput)) return reject("config.invalid-value", providerField);
    for (const key of Object.keys(providerInput)) {
      if (key !== "id" && key !== "use" && key !== "options") return reject("config.unknown-key", providerField);
    }
    if (!isConfigId(providerInput["id"])) return reject("config.invalid-value", `${providerField}.id`);
    if (seen.has(providerInput["id"])) return reject("config.duplicate-id", `${providerField}.id`);
    seen.add(providerInput["id"]);
    const use = validateComponentRef(providerInput["use"], `${providerField}.use`);
    if (!use.ok) return use;
    const options = providerInput["options"] ?? {};
    if (!isPlainObject(options)) return reject("config.invalid-value", `${providerField}.options`);
    if (use.value === "core.history") {
      for (const key of Object.keys(options)) {
        if (key !== "limit" && key !== "includeToolBodies") return reject("config.unknown-key", `${providerField}.options`);
      }
      const limit = options["limit"] ?? 12;
      if (typeof limit !== "number" || !Number.isInteger(limit) || limit <= 0 || limit > 64) {
        return reject("config.invalid-value", `${providerField}.options.limit`);
      }
      if (options["includeToolBodies"] !== undefined && options["includeToolBodies"] !== false) {
        return reject("config.capability-unavailable", `${providerField}.options.includeToolBodies`);
      }
    } else if (use.value === "core.files") {
      for (const key of Object.keys(options)) {
        if (key !== "sourceIds") return reject("config.unknown-key", `${providerField}.options`);
      }
      const sourceIds = options["sourceIds"];
      if (!Array.isArray(sourceIds) || sourceIds.length === 0 || sourceIds.length > 16
        || sourceIds.some(entry => typeof entry !== "string" || !isConfigId(entry))) {
        return reject("config.invalid-value", `${providerField}.options.sourceIds`);
      }
    } else if (use.value === "core.changes") {
      for (const key of Object.keys(options)) {
        if (key !== "paths" && key !== "includeUntracked" && key !== "maxFiles" && key !== "maxBytes") {
          return reject("config.unknown-key", `${providerField}.options`);
        }
      }
      const paths = options["paths"];
      if (paths !== undefined && (!Array.isArray(paths) || paths.length > 32
        || paths.some(entry => typeof entry !== "string" || entry.length === 0 || entry.length > 256))) {
        return reject("config.invalid-value", `${providerField}.options.paths`);
      }
      if (options["includeUntracked"] !== undefined && typeof options["includeUntracked"] !== "boolean") {
        return reject("config.invalid-value", `${providerField}.options.includeUntracked`);
      }
      for (const key of ["maxFiles", "maxBytes"] as const) {
        const value = options[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value <= 0)) {
          return reject("config.invalid-value", `${providerField}.options.${key}`);
        }
      }
    } else if (BUILTIN_CONTEXT_PROVIDERS.has(use.value) && Object.keys(options).length > 0) {
      return reject("config.unknown-key", `${providerField}.options`);
    }
    providers.push({ id: providerInput["id"], use: use.value, options: options as JsonObject });
  }
  const maxBytes = input["maxBytes"] ?? 262_144;
  if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > 16_777_216) {
    return reject("config.invalid-value", `${field}.maxBytes`);
  }
  const maxEstimatedTokens = input["maxEstimatedTokens"] ?? 16_000;
  if (typeof maxEstimatedTokens !== "number" || !Number.isInteger(maxEstimatedTokens) || maxEstimatedTokens <= 0) {
    return reject("config.invalid-value", `${field}.maxEstimatedTokens`);
  }
  const reserveOutputTokens = input["reserveOutputTokens"] ?? 2_048;
  if (typeof reserveOutputTokens !== "number" || !Number.isInteger(reserveOutputTokens) || reserveOutputTokens < 0) {
    return reject("config.invalid-value", `${field}.reserveOutputTokens`);
  }
  const requiredCoverage = input["requiredCoverage"] ?? "complete";
  if (requiredCoverage !== "complete" && requiredCoverage !== "partial") {
    return reject("config.invalid-value", `${field}.requiredCoverage`);
  }
  const overflow = input["overflow"] ?? "omit-optional";
  if (overflow !== "omit-optional" && overflow !== "error") {
    return reject("config.invalid-value", `${field}.overflow`);
  }
  return {
    ok: true,
    value: {
      providers,
      maxBytes,
      maxEstimatedTokens,
      reserveOutputTokens,
      requiredCoverage,
      overflow,
    },
  };
}

function validateEvaluatorProfile(id: string, input: unknown): Result<EvaluatorProfile> {
  const field = `$.evaluators.${id}`;
  if (!isPlainObject(input)) return reject("config.invalid-value", field);
  for (const key of Object.keys(input)) {
    if (key !== "use" && key !== "modelProfile" && key !== "options") return reject("config.unknown-key", field);
  }
  const use = validateComponentRef(input["use"], `${field}.use`);
  if (!use.ok) return use;
  const modelProfile = input["modelProfile"];
  if (modelProfile !== undefined && (typeof modelProfile !== "string" || !isConfigId(modelProfile))) {
    return reject("config.invalid-value", `${field}.modelProfile`);
  }
  const options = input["options"] ?? {};
  if (!isPlainObject(options)) return reject("config.invalid-value", `${field}.options`);
  if (use.value === "core.chat" || use.value === "core.classifier") {
    for (const key of Object.keys(options)) {
      if (key !== "maxOutputTokens" && key !== "repairAttempts") return reject("config.unknown-key", `${field}.options`);
    }
    const maxOutputTokens = options["maxOutputTokens"];
    if (maxOutputTokens !== undefined
      && (typeof maxOutputTokens !== "number" || !Number.isInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > 65_536)) {
      return reject("config.invalid-value", `${field}.options.maxOutputTokens`);
    }
    const repairAttempts = options["repairAttempts"];
    if (repairAttempts !== undefined
      && (typeof repairAttempts !== "number" || !Number.isInteger(repairAttempts) || repairAttempts < 0 || repairAttempts > 1)) {
      return reject("config.invalid-value", `${field}.options.repairAttempts`);
    }
  } else if (BUILTIN_EVALUATORS.has(use.value)) {
    for (const key of Object.keys(options)) {
      if (key !== "window" && key !== "minimumRepeats") return reject("config.unknown-key", `${field}.options`);
    }
    const window = options["window"] ?? 12;
    if (typeof window !== "number" || !Number.isInteger(window) || window <= 0 || window > 64) {
      return reject("config.invalid-value", `${field}.options.window`);
    }
    const minimumRepeats = options["minimumRepeats"] ?? 3;
    if (typeof minimumRepeats !== "number" || !Number.isInteger(minimumRepeats) || minimumRepeats <= 0 || minimumRepeats > window) {
      return reject("config.invalid-value", `${field}.options.minimumRepeats`);
    }
  }
  return {
    ok: true,
    value: {
      use: use.value,
      ...(modelProfile === undefined ? {} : { modelProfile: modelProfile as string }),
      options: options as JsonObject,
    },
  };
}

function validatePolicyProfile(id: string, input: unknown): Result<PolicyProfile> {
  const field = `$.policies.${id}`;
  if (!isPlainObject(input)) return reject("config.invalid-value", field);
  for (const key of Object.keys(input)) {
    if (key !== "use" && key !== "options") return reject("config.unknown-key", field);
  }
  const use = validateComponentRef(input["use"], `${field}.use`);
  if (!use.ok) return use;
  const options = input["options"] ?? {};
  if (!isPlainObject(options)) return reject("config.invalid-value", `${field}.options`);
  if (BUILTIN_POLICIES.has(use.value) && Object.keys(options).length > 0) {
    return reject("config.unknown-key", `${field}.options`);
  }
  return { ok: true, value: { use: use.value, options: options as JsonObject } };
}

/** Local resource references permitted for prompt replacement (C1 §10.2). */
function isLocalResourceReference(entry: unknown): boolean {
  if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0")) return false;
  if (/^[A-Za-z]:[\\/]/u.test(entry)) return true;
  if (entry.startsWith("file:") || entry.startsWith("project:") || entry.startsWith("agent:")) {
    return entry.length > entry.indexOf(":") + 1;
  }
  return !entry.includes(":");
}

function validatePromptBinding(id: string, input: unknown): Result<PromptBinding> {
  const field = `$.prompts.${id}`;
  if (!isPlainObject(input)) return reject("config.invalid-value", field);
  for (const key of Object.keys(input)) {
    if (key !== "use" && key !== "options") return reject("config.unknown-key", field);
  }
  const use = validateComponentRef(input["use"], `${field}.use`);
  if (!use.ok) return use;
  const options = input["options"] ?? {};
  if (!isPlainObject(options)) return reject("config.invalid-value", `${field}.options`);
  if (use.value === "core.prompt-files") {
    for (const key of Object.keys(options)) {
      if (key !== "instructions" && key !== "questions" && key !== "resultSchema") {
        return reject("config.unknown-key", `${field}.options`);
      }
    }
    const instructions = options["instructions"];
    if (!Array.isArray(instructions) || instructions.length === 0) {
      return reject("config.invalid-value", `${field}.options.instructions`);
    }
    const availableResource = (entry: unknown): boolean =>
      typeof entry === "string" && (BUILTIN_PROMPT_RESOURCES.has(entry) || isLocalResourceReference(entry));
    for (const entry of instructions) {
      if (typeof entry !== "string") return reject("config.invalid-value", `${field}.options.instructions`);
      if (!availableResource(entry)) {
        return reject("config.unresolved-resource", `${field}.options.instructions`);
      }
    }
    for (const key of ["questions", "resultSchema"] as const) {
      const entry = options[key];
      if (entry !== undefined && !availableResource(entry)) {
        return reject("config.unresolved-resource", `${field}.options.${key}`);
      }
    }
  }
  return { ok: true, value: { use: use.value, options: options as JsonObject } };
}

function validateCheckDefinition(
  id: string,
  input: unknown,
  localIds: { contexts: Set<string>; prompts: Set<string>; evaluators: Set<string>; policies: Set<string> },
): Result<CheckDefinition> {
  const field = `$.checks.${id}`;
  if (!isPlainObject(input)) return reject("config.invalid-value", field);
  const allowed = new Set([
    "enabled", "mode", "triggers", "context", "prompt", "evaluator", "policy",
    "workStates", "priority", "cooldownMs", "timeoutMs", "maxRunsPerEpisode",
    "freshness", "criteria", "supersedes",
  ]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return reject("config.unknown-key", field);
  }
  const enabled = input["enabled"] ?? true;
  if (typeof enabled !== "boolean") return reject("config.invalid-value", `${field}.enabled`);
  const mode = input["mode"] ?? "inherit";
  if (mode !== "inherit" && mode !== "observe" && mode !== "advise") {
    return reject("config.invalid-value", `${field}.mode`);
  }
  if (mode === "advise") return reject("config.capability-unavailable", `${field}.mode`);

  const triggersInput = input["triggers"] ?? [];
  if (!Array.isArray(triggersInput)) return reject("config.invalid-value", `${field}.triggers`);
  const triggers: TriggerBinding[] = [];
  const seenBindings = new Set<string>();
  for (const [index, triggerInput] of triggersInput.entries()) {
    const binding = validateTriggerBinding(triggerInput, `${field}.triggers[${index}]`);
    if (!binding.ok) return binding;
    if (seenBindings.has(binding.value.id)) return reject("config.duplicate-id", `${field}.triggers[${index}].id`);
    seenBindings.add(binding.value.id);
    triggers.push(binding.value);
  }

  for (const [key, known] of [
    ["context", localIds.contexts],
    ["prompt", localIds.prompts],
    ["evaluator", localIds.evaluators],
    ["policy", localIds.policies],
  ] as const) {
    const supplied = input[key];
    if (!isConfigId(supplied) || !known.has(supplied)) {
      return reject("config.unresolved-reference", `${field}.${key}`);
    }
  }

  const workStatesInput = input["workStates"] ?? ["work-expected", "completion-candidate"];
  if (!Array.isArray(workStatesInput) || workStatesInput.length === 0) {
    return reject("config.invalid-value", `${field}.workStates`);
  }
  const workStates: WorkState[] = [];
  for (const entry of workStatesInput) {
    if (typeof entry !== "string" || !WORK_STATES.has(entry as WorkState)) {
      return reject("config.invalid-value", `${field}.workStates`);
    }
    workStates.push(entry as WorkState);
  }

  const priority = input["priority"] ?? "normal";
  if (typeof priority !== "string" || !PRIORITIES.has(priority)) {
    return reject("config.invalid-value", `${field}.priority`);
  }
  const cooldownMs = input["cooldownMs"] ?? 30_000;
  if (typeof cooldownMs !== "number" || !Number.isInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > 3_600_000) {
    return reject("config.invalid-value", `${field}.cooldownMs`);
  }
  const timeoutMs = input["timeoutMs"];
  if (timeoutMs !== undefined && (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    return reject("config.invalid-value", `${field}.timeoutMs`);
  }
  const maxRunsPerEpisode = input["maxRunsPerEpisode"] ?? 20;
  if (typeof maxRunsPerEpisode !== "number" || !Number.isInteger(maxRunsPerEpisode) || maxRunsPerEpisode <= 0 || maxRunsPerEpisode > 1_000) {
    return reject("config.invalid-value", `${field}.maxRunsPerEpisode`);
  }
  const freshness = input["freshness"] ?? "dependencies";
  if (freshness !== "dependencies") return reject("config.capability-unavailable", `${field}.freshness`);

  const criteriaInput = input["criteria"];
  if (!Array.isArray(criteriaInput) || criteriaInput.length === 0 || criteriaInput.length > 64) {
    return reject("config.invalid-value", `${field}.criteria`);
  }
  const criteria: string[] = [];
  for (const entry of criteriaInput) {
    if (typeof entry !== "string" || !CRITERION_ID_PATTERN.test(entry)) {
      return reject("config.invalid-value", `${field}.criteria`);
    }
    if (criteria.includes(entry)) return reject("config.duplicate-id", `${field}.criteria`);
    criteria.push(entry);
  }

  const supersedesInput = input["supersedes"] ?? [];
  if (!Array.isArray(supersedesInput)) return reject("config.invalid-value", `${field}.supersedes`);
  const supersedes: string[] = [];
  for (const entry of supersedesInput) {
    if (!isConfigId(entry)) return reject("config.invalid-value", `${field}.supersedes`);
    supersedes.push(entry);
  }

  return {
    ok: true,
    value: {
      enabled,
      mode: "inherit",
      triggers,
      context: input["context"] as string,
      prompt: input["prompt"] as string,
      evaluator: input["evaluator"] as string,
      policy: input["policy"] as string,
      workStates,
      priority: priority as CheckDefinition["priority"],
      cooldownMs,
      timeoutMs: timeoutMs ?? null,
      maxRunsPerEpisode,
      freshness: "dependencies",
      criteria,
      supersedes,
    },
  };
}

// ---------------------------------------------------------------------------
// Configuration layer validation and resolution
// ---------------------------------------------------------------------------

export interface ConfigurationLayer {
  schemaVersion: 1;
  enabled: boolean | undefined;
  mode: "observe" | undefined;
  runtime: Partial<RuntimeSettings>;
  permissions: Partial<PermissionSettings>;
  sources: Record<string, SourceDefinition>;
  modelProfiles: Record<string, ModelProfileDefinition>;
  observability: ObservabilitySubset;
  prompts: Record<string, PromptBinding>;
  contexts: Record<string, ContextPlan>;
  evaluators: Record<string, EvaluatorProfile>;
  policies: Record<string, PolicyProfile>;
  checks: Record<string, CheckDefinition>;
}

function validateSourceDefinition(id: string, input: unknown): Result<SourceDefinition> {
  const field = `$.sources.${id}`;
  if (!isPlainObject(input)) return reject("config.invalid-value", field);
  const allowed = new Set(["uris", "globs", "role", "required", "revisionPolicy", "include", "sections", "maxFiles", "maxBytes", "exclude"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return reject("config.unknown-key", field);
  }
  const strings = (value: unknown, maximum: number): string[] | null => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > maximum) return null;
    const entries: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 512) return null;
      entries.push(entry);
    }
    return entries;
  };
  const uris = strings(input["uris"], 32);
  const globs = strings(input["globs"], 32);
  const sections = strings(input["sections"], 32);
  const exclude = strings(input["exclude"], 64);
  if (uris === null) return reject("config.invalid-value", `${field}.uris`);
  if (globs === null) return reject("config.invalid-value", `${field}.globs`);
  if (sections === null) return reject("config.invalid-value", `${field}.sections`);
  if (exclude === null) return reject("config.invalid-value", `${field}.exclude`);
  if (uris.length === 0 && globs.length === 0) return reject("config.invalid-value", field);
  const role = input["role"] ?? "evidence";
  if (role !== "requirement" && role !== "evidence" && role !== "reference") {
    return reject("config.invalid-value", `${field}.role`);
  }
  if (input["required"] !== undefined && typeof input["required"] !== "boolean") {
    return reject("config.invalid-value", `${field}.required`);
  }
  const revisionPolicy = input["revisionPolicy"] ?? (role === "requirement" ? "pin-at-episode" : "refresh-at-check");
  if (revisionPolicy !== "pin-at-episode" && revisionPolicy !== "refresh-at-check") {
    return reject("config.invalid-value", `${field}.revisionPolicy`);
  }
  const include = input["include"] ?? "full";
  if (include !== "full" && include !== "selected") return reject("config.invalid-value", `${field}.include`);
  if (include === "selected" && sections.length === 0) return reject("config.invalid-value", `${field}.sections`);
  const numeric = (key: string, fallback: number, minimum: number, maximum: number): number | null => {
    const supplied = input[key];
    if (supplied === undefined) return fallback;
    if (typeof supplied !== "number" || !Number.isInteger(supplied) || supplied < minimum || supplied > maximum) return null;
    return supplied;
  };
  const maxFiles = numeric("maxFiles", 32, 1, 256);
  const maxBytes = numeric("maxBytes", 262_144, 1, 16_777_216);
  if (maxFiles === null) return reject("config.invalid-value", `${field}.maxFiles`);
  if (maxBytes === null) return reject("config.invalid-value", `${field}.maxBytes`);
  return {
    ok: true,
    value: {
      uris,
      globs,
      role,
      required: input["required"] === true,
      revisionPolicy,
      include,
      sections,
      maxFiles,
      maxBytes,
      exclude,
    },
  };
}

function validateModelProfileDefinition(id: string, input: unknown): Result<ModelProfileDefinition> {
  const field = `$.modelProfiles.${id}`;
  if (!isPlainObject(input)) return reject("config.invalid-value", field);
  const allowed = new Set(["provider", "model", "reasoning", "requestTimeoutMs", "maxAttempts", "retryDelayMs", "maxOutputTokens", "price", "requiredInputs"]);
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) return reject("config.unknown-key", field);
  }
  const identifier = (value: unknown): string | null =>
    typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
  const provider = identifier(input["provider"]);
  const model = identifier(input["model"]);
  if (provider === null) return reject("config.invalid-value", `${field}.provider`);
  if (model === null) return reject("config.invalid-value", `${field}.model`);
  const reasoning = input["reasoning"] ?? "off";
  const reasoningLevels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  if (typeof reasoning !== "string" || !reasoningLevels.has(reasoning)) {
    return reject("config.invalid-value", `${field}.reasoning`);
  }
  const numeric = (key: string, fallback: number, minimum: number, maximum: number): number | null => {
    const supplied = input[key];
    if (supplied === undefined) return fallback;
    if (typeof supplied !== "number" || !Number.isInteger(supplied) || supplied < minimum || supplied > maximum) return null;
    return supplied;
  };
  const requestTimeoutMs = numeric("requestTimeoutMs", 30_000, 1_000, 600_000);
  const maxAttempts = numeric("maxAttempts", 1, 1, 5);
  const retryDelayMs = numeric("retryDelayMs", 1_000, 0, 60_000);
  const maxOutputTokens = numeric("maxOutputTokens", 4_096, 1, 65_536);
  if (requestTimeoutMs === null) return reject("config.invalid-value", `${field}.requestTimeoutMs`);
  if (maxAttempts === null) return reject("config.invalid-value", `${field}.maxAttempts`);
  if (retryDelayMs === null) return reject("config.invalid-value", `${field}.retryDelayMs`);
  if (maxOutputTokens === null) return reject("config.invalid-value", `${field}.maxOutputTokens`);
  const priceInput = input["price"] ?? "host-catalog";
  let price: ModelProfileDefinition["price"];
  if (priceInput === "host-catalog" || priceInput === "unknown") {
    price = priceInput;
  } else if (isPlainObject(priceInput)) {
    const priceAllowed = new Set(["currency", "revision", "inputPerMillion", "outputPerMillion", "cacheReadPerMillion", "cacheWritePerMillion"]);
    for (const key of Object.keys(priceInput)) {
      if (!priceAllowed.has(key)) return reject("config.unknown-key", `${field}.price`);
    }
    const decimal = (value: unknown): string | null =>
      typeof value === "string" && /^[0-9]+(?:\.[0-9]+)?$/u.test(value) ? value : null;
    const currency = identifier(priceInput["currency"]);
    const revision = identifier(priceInput["revision"]);
    const inputPerMillion = decimal(priceInput["inputPerMillion"]);
    const outputPerMillion = decimal(priceInput["outputPerMillion"]);
    const cacheReadPerMillion = priceInput["cacheReadPerMillion"] === undefined ? undefined : decimal(priceInput["cacheReadPerMillion"]);
    const cacheWritePerMillion = priceInput["cacheWritePerMillion"] === undefined ? undefined : decimal(priceInput["cacheWritePerMillion"]);
    if (currency === null || revision === null || inputPerMillion === null || outputPerMillion === null
      || cacheReadPerMillion === null || cacheWritePerMillion === null) {
      return reject("config.invalid-value", `${field}.price`);
    }
    price = {
      currency,
      revision,
      inputPerMillion,
      outputPerMillion,
      ...(cacheReadPerMillion === undefined ? {} : { cacheReadPerMillion }),
      ...(cacheWritePerMillion === undefined ? {} : { cacheWritePerMillion }),
    };
  } else {
    return reject("config.invalid-value", `${field}.price`);
  }
  const requiredInputsInput = input["requiredInputs"] ?? ["text"];
  if (!Array.isArray(requiredInputsInput) || requiredInputsInput.length === 0 || requiredInputsInput.length > 2
    || requiredInputsInput.some(entry => entry !== "text" && entry !== "image")) {
    return reject("config.invalid-value", `${field}.requiredInputs`);
  }
  if ((requiredInputsInput as readonly string[]).includes("image")) {
    return reject("config.capability-unavailable", `${field}.requiredInputs`);
  }
  return {
    ok: true,
    value: {
      provider,
      model,
      reasoning: reasoning as ModelProfileDefinition["reasoning"],
      requestTimeoutMs,
      maxAttempts,
      retryDelayMs,
      maxOutputTokens,
      price,
      requiredInputs: [...new Set(requiredInputsInput as readonly ("text" | "image")[])],
    },
  };
}

function validateNamedMap(
  input: unknown,
  field: string,
  validateEntry: (id: string, value: unknown) => Result<unknown>,
): Result<Record<string, unknown>> {
  if (input === undefined) return { ok: true, value: {} };
  if (!isPlainObject(input)) return reject("config.invalid-value", field);
  if (Object.keys(input).length > MAX_MAP_ENTRIES) return reject("config.too-many-entries", field);
  const entries: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if (!isConfigId(key)) return reject("config.invalid-value", field);
    const entry = validateEntry(key, input[key]);
    if (!entry.ok) return entry;
    entries[key] = entry.value;
  }
  return { ok: true, value: entries };
}

/**
 * Validates one already-parsed configuration document against the implemented
 * C1 subset. A valid document supplies cold inactive-compatible defaults plus
 * the values it explicitly states; unset fields follow the earlier layer.
 */
export function validateConfiguration(value: JsonObject): Result<ConfigurationLayer> {
  for (const key of Object.keys(value)) {
    if (!IMPLEMENTED_ROOT_KEYS.has(key) && !(UNIMPLEMENTED_ROOT_KEYS as readonly string[]).includes(key)) {
      return reject("config.unknown-key", "$");
    }
  }
  if (value["schemaVersion"] !== 1) return reject("config.invalid-schema", "$.schemaVersion");
  const enabled = value["enabled"];
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return reject("config.invalid-value", "$.enabled");
  }
  const mode = value["mode"];
  if (mode !== undefined && mode !== "observe" && mode !== "advise") {
    return reject("config.invalid-value", "$.mode");
  }
  if (mode === "advise") return reject("config.capability-unavailable", "$.mode");

  const runtime = validateRuntimeSettings(value["runtime"]);
  if (!runtime.ok) return runtime;
  const permissions = validatePermissions(value["permissions"]);
  if (!permissions.ok) return permissions;
  const observability = validateObservability(value["observability"]);
  if (!observability.ok) return observability;

  for (const key of UNIMPLEMENTED_ROOT_KEYS) {
    const supplied = value[key];
    if (supplied === undefined) continue;
    if (!isPlainObject(supplied) || Object.keys(supplied).length > 0) {
      return reject("config.capability-unavailable", `$.${key}`);
    }
  }

  const sources = validateNamedMap(value["sources"], "$.sources", validateSourceDefinition);
  if (!sources.ok) return sources;
  const modelProfiles = validateNamedMap(value["modelProfiles"] ?? {}, "$.modelProfiles", validateModelProfileDefinition);
  if (!modelProfiles.ok) return modelProfiles;
  const prompts = validateNamedMap(value["prompts"], "$.prompts", validatePromptBinding);
  if (!prompts.ok) return prompts;
  const contexts = validateNamedMap(value["contexts"], "$.contexts", validateContextPlan);
  if (!contexts.ok) return contexts;
  const evaluators = validateNamedMap(value["evaluators"], "$.evaluators", validateEvaluatorProfile);
  if (!evaluators.ok) return evaluators;
  const policies = validateNamedMap(value["policies"], "$.policies", validatePolicyProfile);
  if (!policies.ok) return policies;

  const localIds = {
    contexts: new Set(Object.keys(contexts.value)),
    prompts: new Set(Object.keys(prompts.value)),
    evaluators: new Set(Object.keys(evaluators.value)),
    policies: new Set(Object.keys(policies.value)),
  };
  const checks = validateNamedMap(value["checks"], "$.checks", (id, entry) => validateCheckDefinition(id, entry, localIds));
  if (!checks.ok) return checks;

  return {
    ok: true,
    value: {
      schemaVersion: 1,
      enabled,
      mode: mode === "observe" ? "observe" : undefined,
      runtime: runtime.value,
      permissions: permissions.value,
      sources: sources.value as Record<string, SourceDefinition>,
      modelProfiles: modelProfiles.value as Record<string, ModelProfileDefinition>,
      observability: observability.value,
      prompts: prompts.value as Record<string, PromptBinding>,
      contexts: contexts.value as Record<string, ContextPlan>,
      evaluators: evaluators.value as Record<string, EvaluatorProfile>,
      policies: policies.value as Record<string, PolicyProfile>,
      checks: checks.value as Record<string, CheckDefinition>,
    },
  };
}

export function defaultConfiguration(): EngineConfiguration {
  return {
    schemaVersion: 1,
    enabled: false,
    mode: "observe",
    runtime: { ...DEFAULT_RUNTIME_SETTINGS },
    permissions: { modelProfiles: [], actions: [] },
    sources: {},
    modelProfiles: {},
    prompts: {},
    contexts: {},
    evaluators: {},
    policies: {},
    checks: {},
    observability: {
      detail: "standard",
      capture: {
        documents: "none", prompts: "none", toolDescriptions: "none", toolArguments: "none",
        toolResults: "none", modelResponses: "none", images: "none", reasoning: "none",
      },
      recentHistory: { ...DEFAULT_RECENT_HISTORY },
      journal: { ...DEFAULT_JOURNAL_SETTINGS },
      retention: { ...DEFAULT_RETENTION_SETTINGS },
      sinks: [],
    },
  };
}

/** Stable semantic fingerprint of an effective configuration. */
export function configurationRevision(value: EngineConfiguration): string {
  const digest = createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
  return `cfg-${digest.slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Discovery and layered resolution
// ---------------------------------------------------------------------------

export interface ConfigurationLocations {
  agentDir: string;
  projectConfigDir: string;
  projectTrusted: boolean;
}

/** Internal declaration origin for one configured prompt resource binding. */
export interface PromptOrigin {
  origin: ConfigurationOrigin;
  directory: string;
}

export interface ConfigurationLocationSpec {
  origin: ConfigurationOrigin;
  directory: string;
  baseName: string;
}

interface ReadConfigurationFile {
  origin: ConfigurationOrigin;
  format: ConfigurationFormat;
  text: string;
}

export interface ConfigurationRejection {
  origin: ConfigurationOrigin;
  format: ConfigurationFormat | null;
  candidateRevision: string;
  error: ContractError;
}

export interface LoadedConfiguration {
  resolved: ResolvedConfiguration;
  rejection: ConfigurationRejection | null;
}

async function statOrReject(path: string): Promise<Result<{ present: boolean; size: number }>> {
  try {
    const stats = await stat(path);
    return { ok: true, value: { present: stats.isFile(), size: stats.size } };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, value: { present: false, size: 0 } };
    return reject("config.unreadable", "$");
  }
}

async function readConfigurationFile(spec: ConfigurationLocationSpec): Promise<Result<ReadConfigurationFile | null>> {
  const yamlPath = join(spec.directory, `${spec.baseName}.yaml`);
  const jsonPath = join(spec.directory, `${spec.baseName}.json`);
  const yaml = await statOrReject(yamlPath);
  if (!yaml.ok) return yaml;
  const json = await statOrReject(jsonPath);
  if (!json.ok) return json;
  if (yaml.value.present && json.value.present) {
    return reject("config.ambiguous-format", "$", { origin: spec.origin });
  }
  if (!yaml.value.present && !json.value.present) return { ok: true, value: null };
  const format: ConfigurationFormat = yaml.value.present ? "yaml" : "json";
  const size = yaml.value.present ? yaml.value.size : json.value.size;
  if (size > CONFIGURATION_FILE_MAX_BYTES) {
    return reject("config.too-large", "$", { origin: spec.origin, format });
  }
  let text: string;
  try {
    text = await readFile(yaml.value.present ? yamlPath : jsonPath, "utf8");
  } catch {
    return reject("config.unreadable", "$", { origin: spec.origin, format });
  }
  return { ok: true, value: { origin: spec.origin, format, text } };
}

async function anyConfigurationFilePresent(spec: ConfigurationLocationSpec): Promise<boolean> {
  const yaml = await statOrReject(join(spec.directory, `${spec.baseName}.yaml`));
  if (yaml.ok && yaml.value.present) return true;
  const json = await statOrReject(join(spec.directory, `${spec.baseName}.json`));
  return json.ok && json.value.present;
}

function rejectionReference(origin: ConfigurationOrigin): string {
  // O1 15.4: a bare hash of rejected content can be guessed offline. Rejected
  // candidates get a bounded engine-issued opaque reference instead; the safe
  // field path and error code carry the diagnostic meaning.
  return `rejected-${origin}-${randomUUID()}`;
}

function applyUserLayer(previous: EngineConfiguration, layer: ConfigurationLayer): EngineConfiguration {
  const previousLimits = previous.observability.recentHistory;
  const supplied = layer.observability.recentHistory;
  const previousJournal = previous.observability.journal;
  const suppliedJournal = layer.observability.journal;
  const previousRetention = previous.observability.retention;
  const suppliedRetention = layer.observability.retention;
  return {
    ...previous,
    enabled: layer.enabled ?? previous.enabled,
    mode: "observe",
    runtime: { ...previous.runtime, ...layer.runtime },
    permissions: {
      modelProfiles: layer.permissions.modelProfiles ?? previous.permissions.modelProfiles,
      actions: previous.permissions.actions,
    },
    sources: { ...previous.sources, ...layer.sources },
    modelProfiles: { ...previous.modelProfiles, ...layer.modelProfiles },
    observability: {
      detail: layer.observability.detail,
      capture: layer.observability.capture,
      sinks: layer.observability.sinks ?? previous.observability.sinks,
      recentHistory: {
        maxEvents: supplied.maxEvents ?? previousLimits.maxEvents,
        maxBytes: supplied.maxBytes ?? previousLimits.maxBytes,
      },
      journal: {
        enabled: suppliedJournal.enabled ?? previousJournal.enabled,
        directory: suppliedJournal.directory ?? previousJournal.directory,
        maxFileBytes: suppliedJournal.maxFileBytes ?? previousJournal.maxFileBytes,
        rotationIntervalMs: suppliedJournal.rotationIntervalMs === undefined
          ? previousJournal.rotationIntervalMs
          : suppliedJournal.rotationIntervalMs,
        compressArchives: suppliedJournal.compressArchives ?? previousJournal.compressArchives,
      },
      retention: {
        maxArchivesPerSession: suppliedRetention.maxArchivesPerSession ?? previousRetention.maxArchivesPerSession,
        maxAgeMs: suppliedRetention.maxAgeMs ?? previousRetention.maxAgeMs,
        maxStorageBytes: suppliedRetention.maxStorageBytes ?? previousRetention.maxStorageBytes,
      },
    },
    prompts: { ...previous.prompts, ...layer.prompts },
    contexts: { ...previous.contexts, ...layer.contexts },
    evaluators: { ...previous.evaluators, ...layer.evaluators },
    policies: { ...previous.policies, ...layer.policies },
    checks: { ...previous.checks, ...layer.checks },
  };
}

/**
 * Project configuration may add new named entries but cannot redefine a user
 * entry, override user-owned runtime/observability policy, or widen the
 * implemented numeric ceilings. Larger or redefining values are errors.
 */
function applyProjectLayer(previous: EngineConfiguration, layer: ConfigurationLayer): Result<EngineConfiguration> {
  if (Object.keys(layer.runtime).length > 0) {
    return reject("config.capability-unavailable", "$.runtime");
  }
  for (const [family, entries] of [
    ["sources", layer.sources],
    ["modelProfiles", layer.modelProfiles],
    ["prompts", layer.prompts],
    ["contexts", layer.contexts],
    ["evaluators", layer.evaluators],
    ["policies", layer.policies],
    ["checks", layer.checks],
  ] as const) {
    for (const id of Object.keys(entries)) {
      if (Object.hasOwn(previous[family], id)) return reject("config.project-redefinition", `$.${family}.${id}`);
    }
  }
  for (const [id, check] of Object.entries(layer.checks)) {
    if (check.timeoutMs !== null && check.timeoutMs > previous.runtime.maxRunTimeoutMs) {
      return reject("config.widens-limit", `$.checks.${id}.timeoutMs`);
    }
  }
  return { ok: true, value: applyUserLayer(previous, layer) };
}

function validateResolvedReferences(configuration: EngineConfiguration): Result<true> {
  for (const [planId, plan] of Object.entries(configuration.contexts)) {
    for (const provider of plan.providers) {
      if (provider.use !== "core.files" && provider.use !== "core.changes") continue;
      const sourceIds = provider.options["sourceIds"];
      if (provider.use === "core.files") {
        if (!Array.isArray(sourceIds) || sourceIds.length === 0) {
          return reject("config.invalid-value", `$.contexts.${planId}.providers.${provider.id}.options.sourceIds`);
        }
        for (const sourceId of sourceIds) {
          if (typeof sourceId !== "string" || !Object.hasOwn(configuration.sources, sourceId)) {
            return reject("config.unresolved-reference", `$.contexts.${planId}.providers.${provider.id}.options.sourceIds`);
          }
        }
      }
    }
  }
  for (const [evaluatorId, evaluator] of Object.entries(configuration.evaluators)) {
    if (MODEL_BACKED_EVALUATORS.has(evaluator.use)) {
      if (evaluator.modelProfile === undefined) {
        return reject("config.invalid-value", `$.evaluators.${evaluatorId}.modelProfile`);
      }
    } else if (evaluator.modelProfile !== undefined) {
      return reject("config.invalid-value", `$.evaluators.${evaluatorId}.modelProfile`);
    }
    if (evaluator.modelProfile === undefined) continue;
    if (!Object.hasOwn(configuration.modelProfiles, evaluator.modelProfile)) {
      return reject("config.unresolved-reference", `$.evaluators.${evaluatorId}.modelProfile`);
    }
    if (!configuration.permissions.modelProfiles.includes(evaluator.modelProfile)) {
      return reject("config.capability-unavailable", `$.evaluators.${evaluatorId}.modelProfile`);
    }
  }
  for (const [checkId, check] of Object.entries(configuration.checks)) {
    const field = `$.checks.${checkId}`;
    if (!Object.hasOwn(configuration.contexts, check.context)) return reject("config.unresolved-reference", `${field}.context`);
    if (!Object.hasOwn(configuration.prompts, check.prompt)) return reject("config.unresolved-reference", `${field}.prompt`);
    if (!Object.hasOwn(configuration.evaluators, check.evaluator)) return reject("config.unresolved-reference", `${field}.evaluator`);
    if (!Object.hasOwn(configuration.policies, check.policy)) return reject("config.unresolved-reference", `${field}.policy`);
    if (check.timeoutMs !== null && check.timeoutMs > configuration.runtime.maxRunTimeoutMs) {
      return reject("config.widens-limit", `${field}.timeoutMs`);
    }
    for (const superseded of check.supersedes) {
      if (!Object.hasOwn(configuration.checks, superseded)) {
        return reject("config.unresolved-reference", `${field}.supersedes`);
      }
    }
  }
  return { ok: true, value: true };
}

function toResolved(
  effective: EngineConfiguration,
  sources: ConfigurationSourceStatus,
  origins: ConfigurationOrigin[],
  sourceOrigins: Record<string, ConfigurationOrigin>,
  promptOrigins: Record<string, PromptOrigin>,
): ResolvedConfiguration {
  return {
    value: effective,
    revision: configurationRevision(effective),
    origins: [...origins],
    sourceOrigins: { ...sourceOrigins },
    promptOrigins: { ...promptOrigins },
    sources: { ...sources },
  };
}

/**
 * Resolves built-in defaults, the user file and the trusted project file. An
 * invalid file leaves the previously accepted layer effective; a cold invalid
 * user file leaves the engine inactive on defaults instead of partially applied.
 */
export async function loadEffectiveConfiguration(locations: ConfigurationLocations): Promise<LoadedConfiguration> {
  const sources: ConfigurationSourceStatus = { user: "absent", project: "absent" };
  const origins: ConfigurationOrigin[] = [];
  let effective = defaultConfiguration();
  let rejection: ConfigurationRejection | null = null;
  const sourceOrigins: Record<string, ConfigurationOrigin> = {};
  const promptOrigins: Record<string, PromptOrigin> = {};

  const userSpec: ConfigurationLocationSpec = { origin: "user", directory: join(locations.agentDir, "quality"), baseName: "config" };
  const projectSpec: ConfigurationLocationSpec = { origin: "project", directory: locations.projectConfigDir, baseName: "quality" };

  const userRead = await readConfigurationFile(userSpec);
  if (!userRead.ok) {
    sources.user = "rejected";
    return { resolved: toResolved(effective, sources, origins, sourceOrigins, promptOrigins), rejection: { origin: "user", format: null, candidateRevision: rejectionReference("user"), error: userRead.error } };
  }
  if (userRead.value !== null) {
    const candidate = parseAndValidate(userRead.value);
    if (!candidate.ok) {
      sources.user = "rejected";
      return {
        resolved: toResolved(effective, sources, origins, sourceOrigins, promptOrigins),
        rejection: { origin: "user", format: userRead.value.format, candidateRevision: rejectionReference("user"), error: candidate.error },
      };
    }
    const applied = applyUserLayer(effective, candidate.value);
    const references = validateResolvedReferences(applied);
    if (!references.ok) {
      sources.user = "rejected";
      return {
        resolved: toResolved(effective, sources, origins, sourceOrigins, promptOrigins),
        rejection: { origin: "user", format: userRead.value.format, candidateRevision: rejectionReference("user"), error: references.error },
      };
    }
    effective = applied;
    for (const id of Object.keys(candidate.value.sources)) sourceOrigins[id] = "user";
    for (const id of Object.keys(candidate.value.prompts)) promptOrigins[id] = { origin: "user", directory: userSpec.directory };
    sources.user = "applied";
    origins.push("user");
  }

  if (!locations.projectTrusted) {
    if (await anyConfigurationFilePresent(projectSpec)) sources.project = "skipped-untrusted";
    return { resolved: toResolved(effective, sources, origins, sourceOrigins, promptOrigins), rejection };
  }

  const projectRead = await readConfigurationFile(projectSpec);
  if (!projectRead.ok) {
    sources.project = "rejected";
    return { resolved: toResolved(effective, sources, origins, sourceOrigins, promptOrigins), rejection: { origin: "project", format: null, candidateRevision: rejectionReference("project"), error: projectRead.error } };
  }
  if (projectRead.value !== null) {
    const candidate = parseAndValidate(projectRead.value);
    const projectSourceIds = candidate.ok ? Object.keys(candidate.value.sources) : [];
    const projectPromptIds = candidate.ok ? Object.keys(candidate.value.prompts) : [];
    const applied = candidate.ok ? applyProjectLayer(effective, candidate.value) : candidate;
    if (applied.ok) {
      const references = validateResolvedReferences(applied.value);
      if (!references.ok) {
        sources.project = "rejected";
        return {
          resolved: toResolved(effective, sources, origins, sourceOrigins, promptOrigins),
          rejection: { origin: "project", format: projectRead.value.format, candidateRevision: rejectionReference("project"), error: references.error },
        };
      }
      effective = applied.value;
      for (const id of projectSourceIds) sourceOrigins[id] = "project";
      for (const id of projectPromptIds) promptOrigins[id] = { origin: "project", directory: projectSpec.directory };
      sources.project = "applied";
      origins.push("project");
    } else {
      sources.project = "rejected";
      return {
        resolved: toResolved(effective, sources, origins, sourceOrigins, promptOrigins),
        rejection: { origin: "project", format: projectRead.value.format, candidateRevision: rejectionReference("project"), error: applied.error },
      };
    }
  }

  return { resolved: toResolved(effective, sources, origins, sourceOrigins, promptOrigins), rejection };
}

function parseAndValidate(file: ReadConfigurationFile): Result<ConfigurationLayer> {
  const parsed = parseConfigurationText(file.text);
  if (!parsed.ok) return parsed;
  // C1 2.2 / O1 24.8: the project layer cannot override the user-owned
  // observability policy at all, including a nominally narrower value.
  if (file.origin === "project" && Object.hasOwn(parsed.value, "observability")) {
    return reject("config.project-observability-override", "$.observability");
  }
  return validateConfiguration(parsed.value);
}
