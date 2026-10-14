// C1 configuration discovery, restricted-format parsing and validation.
//
// The implemented slice resolves only the parts this package can really honor:
// cold activation flags, the operator permission ceiling and metadata-only
// observability. Valid C1 values outside that subset are rejected as
// unavailable instead of silently ignored. No raw configuration text or key
// name is copied into an error, a status snapshot or a diagnostic record.

import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from "yaml";
import type {
  ConfigurationFormat,
  ConfigurationOrigin,
  ConfigurationSourceStatus,
  ContractError,
  FoundationConfiguration,
  Json,
  JsonObject,
  RecentHistoryLimits,
  ResolvedConfiguration,
  Result,
} from "./contracts.js";

export const CONFIGURATION_FILE_MAX_BYTES = 1_048_576;
export const MAX_STRUCTURAL_DEPTH = 32;
export const MAX_MAP_ENTRIES = 256;

export const DEFAULT_RECENT_HISTORY: RecentHistoryLimits = { maxEvents: 512, maxBytes: 2_097_152 };

const IMPLEMENTED_ROOT_KEYS = new Set(["schemaVersion", "enabled", "mode", "permissions", "observability"]);
const UNIMPLEMENTED_ROOT_KEYS = [
  "runtime", "observationSources", "sources", "prompts", "modelProfiles",
  "contexts", "evaluators", "policies", "checks",
] as const;

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
  journal: {
    enabled: true,
    directory: "agent:quality/logs",
    maxFileBytes: 10_485_760,
    rotationIntervalMs: null,
    compressArchives: false,
  },
  retention: {
    maxArchivesPerSession: 4,
    maxAgeMs: 1_209_600_000,
    maxStorageBytes: 268_435_456,
  },
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

function validatePermissions(input: unknown): Result<true> {
  if (input === undefined) return { ok: true, value: true };
  if (!isPlainObject(input)) return reject("config.invalid-value", "$.permissions");
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(PERMISSION_DEFAULTS, key)) return reject("config.unknown-key", "$.permissions");
    if (!jsonEquals(input[key], PERMISSION_DEFAULTS[key])) {
      return reject("config.capability-unavailable", `$.permissions.${key}`);
    }
  }
  return { ok: true, value: true };
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

interface ObservabilitySubset {
  detail: "standard";
  capture: FoundationConfiguration["observability"]["capture"];
  recentHistory: Partial<RecentHistoryLimits>;
}

function validateObservability(input: unknown): Result<ObservabilitySubset> {
  const subset: ObservabilitySubset = {
    detail: "standard",
    capture: {
      documents: "none", prompts: "none", toolDescriptions: "none", toolArguments: "none",
      toolResults: "none", modelResponses: "none", images: "none", reasoning: "none",
    },
    recentHistory: {},
  };
  if (input === undefined) return { ok: true, value: subset };
  if (!isPlainObject(input)) return reject("config.invalid-value", "$.observability");
  for (const key of Object.keys(input)) {
    const supplied = input[key];
    if (key === "detail") {
      if (supplied !== "minimal" && supplied !== "standard" && supplied !== "debug" && supplied !== "trace") {
        return reject("config.invalid-value", "$.observability.detail");
      }
      if (supplied !== "standard") return reject("config.capability-unavailable", "$.observability.detail");
    } else if (key === "capture") {
      const capture = validateCapture(supplied);
      if (!capture.ok) return capture;
    } else if (key === "recentHistory") {
      const limits = validateRecentHistory(supplied);
      if (!limits.ok) return limits;
      subset.recentHistory = limits.value;
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

/**
 * Validates one already-parsed configuration document against the implemented
 * C1 subset. A valid document supplies cold inactive observation defaults plus
 * the limits it explicitly states; unset limits follow the earlier layer.
 */
export interface ConfigurationLayer {
  schemaVersion: 1;
  enabled: false;
  mode: "observe";
  permissions: FoundationConfiguration["permissions"];
  observability: ObservabilitySubset;
}

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
  if (enabled === true) return reject("config.capability-unavailable", "$.enabled");
  if (mode === "advise") return reject("config.capability-unavailable", "$.mode");
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      enabled: false,
      mode: "observe",
      permissions: { modelProfiles: [], actions: [] },
      observability: observability.value,
    },
  };
}

export function defaultConfiguration(): FoundationConfiguration {
  return {
    schemaVersion: 1,
    enabled: false,
    mode: "observe",
    permissions: { modelProfiles: [], actions: [] },
    observability: {
      detail: "standard",
      capture: {
        documents: "none", prompts: "none", toolDescriptions: "none", toolArguments: "none",
        toolResults: "none", modelResponses: "none", images: "none", reasoning: "none",
      },
      recentHistory: { ...DEFAULT_RECENT_HISTORY },
    },
  };
}

/** Stable semantic fingerprint of an effective configuration. */
export function configurationRevision(value: FoundationConfiguration): string {
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

function applyCandidate(previous: FoundationConfiguration, candidate: ConfigurationLayer): Result<FoundationConfiguration> {
  const previousLimits = previous.observability.recentHistory;
  const supplied = candidate.observability.recentHistory;
  return {
    ok: true,
    value: {
      schemaVersion: 1,
      enabled: candidate.enabled,
      mode: candidate.mode,
      permissions: candidate.permissions,
      observability: {
        detail: candidate.observability.detail,
        capture: candidate.observability.capture,
        recentHistory: {
          maxEvents: supplied.maxEvents ?? previousLimits.maxEvents,
          maxBytes: supplied.maxBytes ?? previousLimits.maxBytes,
        },
      },
    },
  };
}

function toResolved(
  effective: FoundationConfiguration,
  sources: ConfigurationSourceStatus,
  origins: ConfigurationOrigin[],
): ResolvedConfiguration {
  return {
    value: effective,
    revision: configurationRevision(effective),
    origins: [...origins],
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

  const userSpec: ConfigurationLocationSpec = { origin: "user", directory: join(locations.agentDir, "quality"), baseName: "config" };
  const projectSpec: ConfigurationLocationSpec = { origin: "project", directory: locations.projectConfigDir, baseName: "quality" };

  const userRead = await readConfigurationFile(userSpec);
  if (!userRead.ok) {
    sources.user = "rejected";
    return { resolved: toResolved(effective, sources, origins), rejection: { origin: "user", format: null, candidateRevision: rejectionReference("user"), error: userRead.error } };
  }
  if (userRead.value !== null) {
    const candidate = parseAndValidate(userRead.value);
    const applied = candidate.ok ? applyCandidate(effective, candidate.value) : candidate;
    if (!applied.ok) {
      sources.user = "rejected";
      return {
        resolved: toResolved(effective, sources, origins),
        rejection: { origin: "user", format: userRead.value.format, candidateRevision: rejectionReference("user"), error: applied.error },
      };
    }
    effective = applied.value;
    sources.user = "applied";
    origins.push("user");
  }

  if (!locations.projectTrusted) {
    if (await anyConfigurationFilePresent(projectSpec)) sources.project = "skipped-untrusted";
    return { resolved: toResolved(effective, sources, origins), rejection };
  }

  const projectRead = await readConfigurationFile(projectSpec);
  if (!projectRead.ok) {
    sources.project = "rejected";
    return { resolved: toResolved(effective, sources, origins), rejection: { origin: "project", format: null, candidateRevision: rejectionReference("project"), error: projectRead.error } };
  }
  if (projectRead.value !== null) {
    const candidate = parseAndValidate(projectRead.value);
    const applied = candidate.ok ? applyCandidate(effective, candidate.value) : candidate;
    if (!applied.ok) {
      sources.project = "rejected";
      return {
        resolved: toResolved(effective, sources, origins),
        rejection: { origin: "project", format: projectRead.value.format, candidateRevision: rejectionReference("project"), error: applied.error },
      };
    }
    effective = applied.value;
    sources.project = "applied";
    origins.push("project");
  }

  return { resolved: toResolved(effective, sources, origins), rejection };
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
