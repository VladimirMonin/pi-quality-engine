// Acknowledged canonical C1 component registry.
//
// Registration validates package and component manifests synchronously and
// returns a handle immediately; asynchronous preparation finishes through
// `ready`. Built-ins and independent contributions use this same path. Each
// registration owns a cancellation generation and a bound lifecycle context;
// disposal and retirement revoke that authority before anything else. Component
// notes are admitted against declared codes, accepted identities and a stable
// bounded counter vocabulary before any destination sees them.

import type {
  ComponentLifecycleData,
  ComponentNoteData,
  ContextDefinition,
  ContractError,
  EvaluatorDefinition,
  Json,
  JsonObject,
  JsonSchema,
  LifecycleContext,
  ObservationDefinition,
  PackageDefinition,
  PackageRegistration,
  ActionDefinition,
  PolicyDefinition,
  PromptDefinition,
  RegistryEndpoint,
  Result,
  Scope,
  SinkDefinition,
  TriggerDefinition,
} from "./contracts.js";

export type ResolvedComponent =
  | { kind: "observation"; registrationId: string; componentId: string; definition: ObservationDefinition; lifecycle(): LifecycleContext }
  | { kind: "trigger"; registrationId: string; componentId: string; definition: TriggerDefinition; lifecycle(): LifecycleContext }
  | { kind: "context"; registrationId: string; componentId: string; definition: ContextDefinition; lifecycle(): LifecycleContext }
  | { kind: "prompt"; registrationId: string; componentId: string; definition: PromptDefinition; lifecycle(): LifecycleContext }
  | { kind: "evaluator"; registrationId: string; componentId: string; definition: EvaluatorDefinition; lifecycle(): LifecycleContext }
  | { kind: "policy"; registrationId: string; componentId: string; definition: PolicyDefinition; lifecycle(): LifecycleContext }
  | { kind: "action"; registrationId: string; componentId: string; definition: ActionDefinition; lifecycle(): LifecycleContext }
  | { kind: "sink"; registrationId: string; componentId: string; definition: SinkDefinition; lifecycle(): LifecycleContext };

/** Narrowed action component used by runtime admission and dispatch. */
export type ActionComponent = Extract<ResolvedComponent, { kind: "action" }>;

export interface PackageInventoryEntry {
  packageId: string;
  version: string;
  registrationId: string;
  phase: "pending" | "ready" | "failed" | "disposed";
  components: string[];
  readyComponents: number;
  failedComponents: number;
}

export interface ComponentRegistryOptions {
  scope: Scope;
  generation: string;
  initTimeoutMs: number;
  lifecycle: (data: ComponentLifecycleData) => void;
  emitNote: (note: ComponentNoteData) => void;
  acceptsReference: (reference: string) => boolean;
}

interface RegistrationRuntime {
  controller: AbortController;
  revoked: boolean;
  declaredCodes: Set<string>;
}

interface RegistrationRecord {
  registrationId: string;
  definition: PackageDefinition;
  componentIds: string[];
  status: "pending" | "ready" | "failed" | "disposed";
  startedMonoMs: number;
  runtime: RegistrationRuntime;
}

interface RegisteredComponent {
  registrationId: string;
  componentId: string;
  kind: ResolvedComponent["kind"];
  definition: ResolvedComponent["definition"];
  status: "pending" | "ready" | "failed";
  declaredCodes: ReadonlySet<string>;
}

const SUPPORTED_KINDS: ReadonlySet<ResolvedComponent["kind"]> = new Set([
  "observation", "trigger", "context", "prompt", "evaluator", "policy", "action", "sink",
]);

/** Stable bounded counter vocabulary for component notes (O1 §6.2). */
const NOTE_COUNTER_NAMES: ReadonlySet<string> = new Set([
  "ready", "items", "bytes", "records", "calls", "errors", "omitted",
  "retained", "dropped", "completed", "failed", "pending", "late", "count", "rejected",
]);

const NOTE_CODE_PATTERN = /^[a-z][a-z0-9._:-]{0,95}$/;

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema", "title", "description", "type", "properties", "required",
  "additionalProperties", "items", "enum", "minimum", "maximum",
  "minLength", "maxLength", "default", "pattern", "minItems", "maxItems", "anyOf", "allOf",
]);
const SUPPORTED_TYPES = new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);

type Validator = (value: unknown) => boolean;

function schemaFailure(code: string): { ok: false; error: { code: string; retryable: boolean } } {
  return { ok: false, error: { code, retryable: false } };
}

/**
 * Compiles the JSON Schema subset the registry can actually enforce. A schema
 * using unsupported keywords is rejected at registration rather than silently
 * ignored.
 */
export function compileOptionsSchema(schema: unknown): Result<Validator> {
  if (schema === true) return { ok: true, value: () => true };
  if (schema === false) return { ok: true, value: () => false };
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return schemaFailure("core.options-schema-unsupported");
  }
  const record = schema as Record<string, unknown>;
  for (const keyword of Object.keys(record)) {
    if (!SUPPORTED_SCHEMA_KEYWORDS.has(keyword)) return schemaFailure("core.options-schema-unsupported");
  }
  const type = record["type"];
  let typeNames: string[] = [];
  if (type !== undefined) {
    if (typeof type === "string" && SUPPORTED_TYPES.has(type)) {
      typeNames = [type];
    } else if (Array.isArray(type) && type.length > 0
      && type.every(entry => typeof entry === "string" && SUPPORTED_TYPES.has(entry))) {
      typeNames = [...new Set(type as string[])];
    } else {
      return schemaFailure("core.options-schema-unsupported");
    }
  }
  const enumValues = record["enum"];
  if (enumValues !== undefined && (!Array.isArray(enumValues) || enumValues.length === 0)) {
    return schemaFailure("core.options-schema-unsupported");
  }
  const alternatives: Validator[][] = [];
  for (const keyword of ["anyOf", "allOf"]) {
    const branches = record[keyword];
    if (branches === undefined) { alternatives.push([]); continue; }
    if (!Array.isArray(branches) || branches.length === 0) return schemaFailure("core.options-schema-unsupported");
    const validators: Validator[] = [];
    for (const branch of branches) {
      const compiled = compileOptionsSchema(branch);
      if (!compiled.ok) return compiled;
      validators.push(compiled.value);
    }
    alternatives.push(validators);
  }
  let pattern: RegExp | null = null;
  if (record["pattern"] !== undefined) {
    if (typeof record["pattern"] !== "string") return schemaFailure("core.options-schema-unsupported");
    try { pattern = new RegExp(record["pattern"], "u"); } catch { return schemaFailure("core.options-schema-unsupported"); }
  }
  for (const keyword of ["minItems", "maxItems"]) {
    if (record[keyword] !== undefined && (!Number.isInteger(record[keyword]) || (record[keyword] as number) < 0)) {
      return schemaFailure("core.options-schema-unsupported");
    }
  }
  const propertiesInput = record["properties"];
  if (propertiesInput !== undefined && (typeof propertiesInput !== "object" || propertiesInput === null || Array.isArray(propertiesInput))) {
    return schemaFailure("core.options-schema-unsupported");
  }
  const compiledProperties = new Map<string, Validator>();
  if (propertiesInput !== undefined) {
    for (const [name, subSchema] of Object.entries(propertiesInput as Record<string, unknown>)) {
      const compiled = compileOptionsSchema(subSchema);
      if (!compiled.ok) return compiled;
      compiledProperties.set(name, compiled.value);
    }
  }
  let compiledItems: Validator | null = null;
  if (record["items"] !== undefined) {
    const compiled = compileOptionsSchema(record["items"]);
    if (!compiled.ok) return compiled;
    compiledItems = compiled.value;
  }
  const required = Array.isArray(record["required"])
    ? (record["required"] as unknown[]).filter((entry): entry is string => typeof entry === "string")
    : [];
  const additionalProperties = record["additionalProperties"] === false ? false : true;
  const minimum = typeof record["minimum"] === "number" ? record["minimum"] : null;
  const maximum = typeof record["maximum"] === "number" ? record["maximum"] : null;
  const minLength = typeof record["minLength"] === "number" ? record["minLength"] : null;
  const maxLength = typeof record["maxLength"] === "number" ? record["maxLength"] : null;

  const validator: Validator = value => {
    // Scalar enums (including all C1 enums) never serialize untrusted data.
    if (Array.isArray(enumValues) && !enumValues.some(entry => entry !== null && typeof entry === "object"
      ? JSON.stringify(entry) === JSON.stringify(value) : entry === value)) return false;
    const anyOf = alternatives[0] ?? [], allOf = alternatives[1] ?? [];
    if (anyOf.length > 0 && !anyOf.some(check => check(value))) return false;
    if (!allOf.every(check => check(value))) return false;
    const isObject = typeof value === "object" && value !== null && !Array.isArray(value);
    if (typeNames.length > 0 && !typeNames.some(name =>
      name === "object" ? isObject : name === "array" ? Array.isArray(value)
        : name === "integer" ? typeof value === "number" && Number.isInteger(value)
        : name === "null" ? value === null : typeof value === name)) return false;
    if (isObject) {
      for (const name of required) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (descriptor === undefined || !("value" in descriptor)) return false;
      }
      for (const [name, subValidator] of compiledProperties) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (descriptor !== undefined && (!("value" in descriptor) || !subValidator(descriptor.value))) return false;
      }
      if (!additionalProperties && Object.keys(value).some(name => !compiledProperties.has(name))) return false;
    }
    if (Array.isArray(value)) {
      if (typeof record["minItems"] === "number" && value.length < record["minItems"]) return false;
      if (typeof record["maxItems"] === "number" && value.length > record["maxItems"]) return false;
      if (compiledItems !== null) for (let i = 0; i < value.length; i += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (descriptor === undefined || !("value" in descriptor) || !compiledItems(descriptor.value)) return false;
      }
    }
    if (typeof value === "string") {
      if (minLength !== null && value.length < minLength) return false;
      if (maxLength !== null && value.length > maxLength) return false;
      if (pattern !== null && !pattern.test(value)) return false;
    }
    if (typeof value === "number" && (!Number.isFinite(value)
      || (minimum !== null && value < minimum) || (maximum !== null && value > maximum))) return false;
    return true;
  };
  return { ok: true, value: validator };
}

/** Reads an own data property without invoking accessors. */
/** Copy bounded JSON data without invoking accessors/toJSON or retaining caller aliases. */
export function copyJsonData(input: unknown, maxBytes = 65_536): Result<Json> {
  let nodes = 0, bytes = 0;
  const seen = new Set<object>();
  const charge = (size: number): void => { bytes += size; if (bytes > maxBytes) throw new Error("bounded-json"); };
  const copy = (value: unknown, depth: number): Json => {
    if (++nodes > 4096 || depth > 32) throw new Error("bounded-json");
    if (value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) {
      charge(Buffer.byteLength(JSON.stringify(value), "utf8")); return value;
    }
    if (typeof value !== "object" || value === null || seen.has(value)) throw new Error("bounded-json");
    const array = Array.isArray(value), prototype = Object.getPrototypeOf(value);
    if (prototype !== (array ? Array.prototype : Object.prototype) && prototype !== null) throw new Error("bounded-json");
    const keys = Reflect.ownKeys(value); if (keys.length > 4096) throw new Error("bounded-json");
    seen.add(value); charge(2);
    let result: Json;
    if (array) {
      const length = readDataProperty(value, "length");
      if (typeof length !== "number" || keys.length !== length + 1) throw new Error("bounded-json");
      const entries: Json[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined || !("value" in descriptor)) throw new Error("bounded-json");
        charge(1); entries.push(copy(descriptor.value, depth + 1));
      }
      result = entries;
    } else {
      const object: { [key: string]: Json } = Object.create(null) as { [key: string]: Json };
      for (const key of keys) {
        if (typeof key !== "string") throw new Error("bounded-json");
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor)) throw new Error("bounded-json");
        charge(Buffer.byteLength(JSON.stringify(key), "utf8") + 2); object[key] = copy(descriptor.value, depth + 1);
      }
      result = object;
    }
    seen.delete(value); return result;
  };
  try { return { ok: true, value: copy(input, 0) }; }
  catch { return { ok: false, error: { code: "core.invalid-json", retryable: false } }; }
}

function readDataProperty(target: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(target, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function isFunctionProperty(target: object, key: string): boolean {
  return typeof readDataProperty(target, key) === "function";
}

function validateComponentShape(component: unknown): { ok: true; kind: ResolvedComponent["kind"] } | { ok: false; error: ContractError } {
  if (typeof component !== "object" || component === null) {
    return { ok: false, error: { code: "core.invalid-component", retryable: false } };
  }
  const record = component as Record<string, unknown>;
  const kind = readDataProperty(record, "kind");
  if (typeof kind !== "string" || !SUPPORTED_KINDS.has(kind as ResolvedComponent["kind"])) {
    return { ok: false, error: { code: "core.component-kind-unavailable", retryable: false } };
  }
  if (readDataProperty(record, "apiMajor") !== 1) {
    return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "apiMajor" } };
  }
  const declared = readDataProperty(record, "diagnosticCodes");
  if (declared !== undefined && (!Array.isArray(declared) || declared.some(entry => typeof entry !== "string"))) {
    return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "diagnosticCodes" } };
  }
  switch (kind) {
    case "observation": {
      const schemas = copyJsonData(readDataProperty(record, "observationSchemas"));
      if (!isFunctionProperty(record, "start") || !schemas.ok || typeof schemas.value !== "object" || schemas.value === null || Array.isArray(schemas.value)
        || Object.keys(schemas.value).length > 256) {
        return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "observationSchemas" } };
      }
      for (const [name, schema] of Object.entries(schemas.value)) {
        if (name.length > 128 || !/^[^.\s]+\.[^\s]+$/u.test(name) || name.startsWith("core.") || !compileOptionsSchema(schema).ok) {
          return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "observationSchemas" } };
        }
      }
      break;
    }
    case "trigger":
      if (!isFunctionProperty(record, "initialState") || !isFunctionProperty(record, "update")) {
        return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "update" } };
      }
      break;
    case "context":
      if (!Array.isArray(readDataProperty(record, "produces")) || !isFunctionProperty(record, "collect")) {
        return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "collect" } };
      }
      break;
    case "prompt":
      if (!isFunctionProperty(record, "build")) {
        return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "build" } };
      }
      break;
    case "evaluator": {
      const mechanism = readDataProperty(record, "mechanism");
      const accepts = readDataProperty(record, "accepts");
      if (typeof mechanism !== "string" || !["deterministic", "direct-model", "pi-session", "external"].includes(mechanism)
        || !Array.isArray(accepts) || !isFunctionProperty(record, "evaluate")) {
        return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "evaluate" } };
      }
      break;
    }
    case "policy":
      if (!isFunctionProperty(record, "decide")) {
        return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "decide" } };
      }
      break;
    case "action": {
      const effects = readDataProperty(record, "effects");
      if (!Array.isArray(effects) || effects.length === 0 || effects.length > 8
        || effects.some(entry => typeof entry !== "string" || !/^[a-z][a-z0-9.-]*\.[a-z][a-z0-9.-]*$/u.test(entry))
        || !isFunctionProperty(record, "execute")) {
        return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "effects" } };
      }
      break;
    }
    case "sink":
      if (!isFunctionProperty(record, "create")) {
        return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "create" } };
      }
      break;
    default:
      return { ok: false, error: { code: "core.component-kind-unavailable", retryable: false } };
  }
  return { ok: true, kind: kind as ResolvedComponent["kind"] };
}

export class ComponentRegistry {
  readonly #options: ComponentRegistryOptions;
  readonly #registrations = new Map<string, RegistrationRecord>();
  readonly #components = new Map<string, RegisteredComponent>();
  readonly #byDefinition = new WeakMap<PackageDefinition, RegistrationRecord>();
  readonly #validators = new Map<string, Validator>();
  #registrationCounter = 0;
  #retired = false;

  readonly endpoint: RegistryEndpoint;

  constructor(options: ComponentRegistryOptions) {
    this.#options = options;
    this.endpoint = {
      apiMajor: 1,
      engineGeneration: options.generation,
      observedSessionId: options.scope.observedSessionId,
      register: definition => this.register(definition),
    };
  }

  get retired(): boolean {
    return this.#retired;
  }

  register(definition: PackageDefinition): Result<PackageRegistration> {
    if (this.#retired) {
      return { ok: false, error: { code: "core.retired-generation", retryable: false } };
    }
    if (typeof definition !== "object" || definition === null) {
      return { ok: false, error: { code: "core.invalid-package", retryable: false } };
    }
    const existing = this.#byDefinition.get(definition);
    if (existing !== undefined && existing.status !== "disposed") {
      return { ok: true, value: this.#handle(existing) };
    }
    const packageId = readDataProperty(definition as object, "id");
    const packageVersion = readDataProperty(definition as object, "version");
    const componentsInput = readDataProperty(definition as object, "components");
    if (typeof packageId !== "string" || packageId.length === 0 || packageId.length > 128) {
      return { ok: false, error: { code: "core.invalid-package", retryable: false, field: "id" } };
    }
    if (typeof packageVersion !== "string" || packageVersion.length === 0 || packageVersion.length > 64) {
      return { ok: false, error: { code: "core.invalid-package", retryable: false, field: "version" } };
    }
    if (!Array.isArray(componentsInput)) {
      return { ok: false, error: { code: "core.invalid-package", retryable: false, field: "components" } };
    }
    const componentIds: string[] = [];
    const declaredCodes = new Set<string>();
    const prepared: Array<{ id: string; component: ResolvedComponent; declaredCodes: Set<string> }> = [];
    const seen = new Set<string>();
    for (const original of componentsInput) {
      let component = original;
      if (typeof original === "object" && original !== null && readDataProperty(original, "kind") === "observation") {
        const copied = copyJsonData({
          id: readDataProperty(original, "id"), apiMajor: readDataProperty(original, "apiMajor"), kind: "observation",
          optionsSchema: readDataProperty(original, "optionsSchema"), observationSchemas: readDataProperty(original, "observationSchemas"),
          requiredCapabilities: readDataProperty(original, "requiredCapabilities"), diagnosticCodes: readDataProperty(original, "diagnosticCodes"),
        });
        const start = readDataProperty(original, "start");
        if (!copied.ok || typeof copied.value !== "object" || copied.value === null || Array.isArray(copied.value) || typeof start !== "function") {
          return { ok: false, error: { code: "core.invalid-component", retryable: false } };
        }
        const snapshot = copied.value;
        if (!Array.isArray(snapshot["requiredCapabilities"]) || snapshot["requiredCapabilities"].some(value => typeof value !== "string")
          || !Array.isArray(snapshot["diagnosticCodes"]) || snapshot["diagnosticCodes"].some(value => typeof value !== "string")) {
          return { ok: false, error: { code: "core.invalid-component", retryable: false } };
        }
        component = {
          id: snapshot["id"] as string, kind: "observation", apiMajor: snapshot["apiMajor"] as 1,
          optionsSchema: snapshot["optionsSchema"] as JsonSchema, observationSchemas: snapshot["observationSchemas"] as Record<string, JsonSchema>,
          requiredCapabilities: snapshot["requiredCapabilities"] as string[], diagnosticCodes: snapshot["diagnosticCodes"] as string[],
          start: (options, context) => (start as ObservationDefinition["start"]).call(original, options, context),
        } satisfies ObservationDefinition;
      }
      const shape = validateComponentShape(component);
      if (!shape.ok) return { ok: false, error: shape.error };
      const meta = component as Record<string, unknown>;
      const id = readDataProperty(meta, "id");
      if (typeof id !== "string" || id.length === 0 || id.length > 192) {
        return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "id" } };
      }
      if (seen.has(id)) {
        return { ok: false, error: { code: "core.duplicate-component", retryable: false, details: { componentId: id } } };
      }
      seen.add(id);
      if (this.#components.has(id)) {
        return { ok: false, error: { code: "core.duplicate-component", retryable: false, details: { componentId: id } } };
      }
      const optionsSchema = readDataProperty(meta, "optionsSchema");
      const copiedOptions = shape.kind === "observation" ? copyJsonData(optionsSchema) : { ok: true as const, value: optionsSchema };
      if (!copiedOptions.ok) return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "optionsSchema" } };
      const compiled = compileOptionsSchema(copiedOptions.value);
      if (!compiled.ok) {
        return { ok: false, error: { code: compiled.error.code, retryable: false, details: { componentId: id } } };
      }
      const componentCodes = new Set<string>();
      const codes = readDataProperty(meta, "diagnosticCodes");
      if (Array.isArray(codes)) {
        for (const code of codes) {
          if (typeof code === "string") {
            componentCodes.add(code);
            declaredCodes.add(code);
          }
        }
      }
      if (shape.kind === "observation" && id.length > 128) return { ok: false, error: { code: "core.invalid-component", retryable: false, field: "id" } };
      const admitted = component as ResolvedComponent["definition"];
      componentIds.push(id);
      prepared.push({
        id,
        component: { kind: shape.kind, registrationId: "", componentId: id, definition: admitted, lifecycle: () => this.#lifecycle(id) } as ResolvedComponent,
        declaredCodes: componentCodes,
      });
    }

    this.#registrationCounter += 1;
    const registrationId = `reg-${this.#registrationCounter}`;
    const runtime: RegistrationRuntime = {
      controller: new AbortController(),
      revoked: false,
      declaredCodes,
    };
    const record: RegistrationRecord = {
      registrationId,
      definition,
      componentIds,
      status: "pending",
      startedMonoMs: performance.now(),
      runtime,
    };
    this.#registrations.set(registrationId, record);
    this.#byDefinition.set(definition, record);
    for (const entry of prepared) {
      const bound = { ...entry.component, registrationId, lifecycle: () => this.#lifecycle(entry.id) } as ResolvedComponent;
      this.#components.set(entry.id, {
        registrationId,
        componentId: entry.id,
        kind: bound.kind,
        definition: bound.definition,
        status: "pending",
        declaredCodes: entry.declaredCodes,
      });
      const compiled = compileOptionsSchema((entry.component.definition as { optionsSchema?: unknown }).optionsSchema);
      if (compiled.ok) this.#validators.set(entry.id, compiled.value);
    }
    this.#emit(record, "registered", 0, null);
    void this.#prepare(record);
    return { ok: true, value: this.#handle(record) };
  }

  /** True when the component declared this diagnostic/reason code (O1 §6.2). */
  /**
   * K07: the accepted effect declaration of a registered action component. The
   * approval pin needs the declaration itself, not option-dependent resolution
   * of a concrete proposal.
   */
  actionEffects(componentId: string): readonly string[] | null {
    const component = this.#components.get(componentId);
    if (component === undefined || component.definition.kind !== "action") return null;
    return [...component.definition.effects];
  }

  acceptsDiagnosticCode(componentId: string, code: string): boolean {
    return this.#components.get(componentId)?.declaredCodes.has(code) ?? false;
  }

  /** Resolves a configured component reference to a ready definition. */
  resolve(use: string, options: JsonObject): Result<ResolvedComponent> {
    const registered = this.#components.get(use);
    if (registered === undefined) return { ok: false, error: { code: "core.waiting-for-component", retryable: false } };
    if (registered.status !== "ready") {
      return {
        ok: false,
        error: {
          code: registered.status === "failed" ? "core.component-failed" : "core.waiting-for-component",
          retryable: false,
        },
      };
    }
    const validator = this.#validators.get(use);
    if (validator !== undefined && !validator(options)) {
      return { ok: false, error: { code: "core.options-invalid", retryable: false } };
    }
    return {
      ok: true,
      value: {
        kind: registered.kind,
        registrationId: registered.registrationId,
        componentId: registered.componentId,
        definition: registered.definition,
        lifecycle: () => this.#lifecycle(registered.componentId),
      } as ResolvedComponent,
    };
  }

  /** Ready contributed diagnostic sinks for bounded post-projection delivery. */
  sinkComponents(): Array<{ componentId: string; definition: SinkDefinition; lifecycle(): LifecycleContext }> {
    const sinks: Array<{ componentId: string; definition: SinkDefinition; lifecycle(): LifecycleContext }> = [];
    for (const registered of this.#components.values()) {
      if (registered.kind !== "sink" || registered.status !== "ready") continue;
      sinks.push({
        componentId: registered.componentId,
        definition: registered.definition as SinkDefinition,
        lifecycle: () => this.#lifecycle(registered.componentId),
      });
    }
    return sinks;
  }

  inventory(): PackageInventoryEntry[] {
    return [...this.#registrations.values()].map(record => {
      const components = record.componentIds.map(id => this.#components.get(id))
        .filter(component => component?.registrationId === record.registrationId);
      const ready = components.filter(component => component?.status === "ready").length;
      const failed = components.filter(component => component?.status === "failed").length;
      return {
        packageId: record.definition.id,
        version: record.definition.version,
        registrationId: record.registrationId,
        phase: record.status,
        components: [...record.componentIds],
        readyComponents: ready,
        failedComponents: failed,
      };
    });
  }

  /** Retires the endpoint generation; new registrations fail immediately. */
  retire(): void {
    this.#retired = true;
    for (const record of this.#registrations.values()) {
      if (record.status === "disposed") continue;
      record.runtime.revoked = true;
      record.runtime.controller.abort();
    }
  }

  async disposeAll(): Promise<void> {
    await Promise.all([...this.#registrations.values()].map(record => this.#dispose(record)));
  }

  /** Bound lifecycle context for one ready component; revoked on disposal. */
  #lifecycle(componentId: string): LifecycleContext {
    const registered = this.#components.get(componentId);
    const record = registered === undefined ? undefined : this.#registrations.get(registered.registrationId);
    return this.#lifecycleFor(record, componentId);
  }

  #lifecycleFor(record: RegistrationRecord | undefined, componentId: string): LifecycleContext {
    const registrationId = record?.registrationId ?? componentId;
    const runtime = record?.runtime ?? { controller: new AbortController(), revoked: true, declaredCodes: new Set<string>() };
    const declaredCodes = runtime.declaredCodes;
    return {
      scope: this.#options.scope,
      signal: runtime.controller.signal,
      clock: () => ({ utc: new Date().toISOString(), monoMs: performance.now() }),
      diagnostics: {
        note: note => {
          if (runtime.revoked) return;
          this.#admitNote(registrationId, componentId, declaredCodes, note);
        },
      },
    };
  }

  #admitNote(registrationId: string, componentId: string, declaredCodes: ReadonlySet<string>, note: unknown): void {
    const invalid = () => {
      this.#options.emitNote({
        componentId,
        registrationId,
        code: "core.invalid-note",
        refs: [],
        counts: { rejected: 1 },
      });
    };
    if (typeof note !== "object" || note === null) {
      invalid();
      return;
    }
    const code = readDataProperty(note, "code");
    if (typeof code !== "string" || !NOTE_CODE_PATTERN.test(code) || !declaredCodes.has(code)) {
      invalid();
      return;
    }
    const refsInput = readDataProperty(note, "refs");
    const refs: string[] = [];
    if (refsInput !== undefined) {
      if (!Array.isArray(refsInput)) {
        invalid();
        return;
      }
      for (let index = 0; index < refsInput.length && index < 16; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(refsInput, String(index));
        const ref = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined;
        if (typeof ref !== "string" || !this.#options.acceptsReference(ref)) {
          invalid();
          return;
        }
        refs.push(ref);
      }
    }
    const countsInput = readDataProperty(note, "counts");
    const counts: Record<string, number | boolean | null> = {};
    if (countsInput !== undefined) {
      if (typeof countsInput !== "object" || countsInput === null || Array.isArray(countsInput)) {
        invalid();
        return;
      }
      const descriptors = Object.getOwnPropertyDescriptors(countsInput);
      const keys = Object.keys(descriptors);
      if (keys.length > 32) {
        invalid();
        return;
      }
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (descriptor === undefined || !("value" in descriptor) || !NOTE_COUNTER_NAMES.has(key)) {
          invalid();
          return;
        }
        const value = descriptor.value;
        if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
          counts[key] = value;
        } else {
          invalid();
          return;
        }
      }
    }
    this.#options.emitNote({ componentId, registrationId, code, refs, counts });
  }

  #handle(record: RegistrationRecord): PackageRegistration {
    return {
      registrationId: record.registrationId,
      generation: this.#options.generation,
      ready: this.#readyPromises.get(record.registrationId) ?? Promise.resolve({ ok: true, value: undefined }),
      dispose: () => this.#dispose(record),
    };
  }

  readonly #readyPromises = new Map<string, Promise<Result<void>>>();

  async #prepare(record: RegistrationRecord): Promise<void> {
    const startedMonoMs = performance.now();
    const promise = this.#runPreparation(record, startedMonoMs);
    this.#readyPromises.set(record.registrationId, promise);
    await promise;
  }

  async #runPreparation(record: RegistrationRecord, startedMonoMs: number): Promise<Result<void>> {
    const prepare = (record.definition as { prepare?: unknown }).prepare;
    if (typeof prepare === "function") {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const preparation = Promise.resolve((prepare as (ctx: LifecycleContext) => Promise<void>)(
          this.#lifecycleFor(record, `${record.definition.id}:package`),
        ));
        const timeoutPromise = new Promise<"timeout">(resolve => {
          timeout = setTimeout(() => resolve("timeout"), this.#options.initTimeoutMs);
          timeout.unref?.();
        });
        const outcome = await Promise.race([preparation.then(() => "ready" as const), timeoutPromise]);
        if (outcome === "timeout") {
          this.#fail(record, startedMonoMs, "core.prepare-timeout");
          return { ok: false, error: { code: "core.prepare-timeout", retryable: false } };
        }
      } catch {
        this.#fail(record, startedMonoMs, "core.prepare-failed");
        return { ok: false, error: { code: "core.prepare-failed", retryable: false } };
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    }
    if (this.#retired || record.status === "disposed" || record.runtime.revoked) {
      this.#fail(record, startedMonoMs, "core.retired-generation");
      return { ok: false, error: { code: "core.retired-generation", retryable: false } };
    }
    record.status = "ready";
    for (const id of record.componentIds) {
      const component = this.#components.get(id);
      if (component !== undefined) component.status = "ready";
    }
    this.#emit(record, "ready", performance.now() - startedMonoMs, null);
    return { ok: true, value: undefined };
  }

  #fail(record: RegistrationRecord, startedMonoMs: number, errorCode: string): void {
    if (record.status === "disposed") return;
    record.status = "failed";
    record.runtime.revoked = true;
    if (!record.runtime.controller.signal.aborted) record.runtime.controller.abort();
    for (const id of record.componentIds) {
      const component = this.#components.get(id);
      if (component !== undefined) component.status = "failed";
    }
    this.#emit(record, "failed", performance.now() - startedMonoMs, errorCode);
  }

  async #dispose(record: RegistrationRecord): Promise<void> {
    if (record.status === "disposed") return;
    // Revoke first: retained callbacks cannot append, write or observe signals.
    record.runtime.revoked = true;
    if (!record.runtime.controller.signal.aborted) record.runtime.controller.abort();
    record.status = "disposed";
    for (const id of record.componentIds) {
      this.#components.delete(id);
      this.#validators.delete(id);
    }
    this.#emit(record, "disposed", 0, null);
  }

  #emit(record: RegistrationRecord, phase: ComponentLifecycleData["phase"], durationMs: number, errorCode: string | null): void {
    for (const id of record.componentIds.length > 0 ? record.componentIds : [`${record.definition.id}:package`]) {
      const component = this.#components.get(id);
      const requiredCapabilities = component !== undefined
        ? ((component.definition as { requiredCapabilities?: readonly string[] }).requiredCapabilities ?? [])
        : [];
      this.#options.lifecycle({
        componentId: id,
        packageId: record.definition.id,
        packageVersion: record.definition.version,
        registrationId: record.registrationId,
        phase,
        capabilityRefs: [...requiredCapabilities],
        durationMs,
        errorCode,
      });
    }
  }
}
