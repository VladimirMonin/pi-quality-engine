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
  JsonObject,
  LifecycleContext,
  PackageDefinition,
  PackageRegistration,
  PolicyDefinition,
  PromptDefinition,
  RegistryEndpoint,
  Result,
  Scope,
  TriggerDefinition,
} from "./contracts.js";

export type ResolvedComponent =
  | { kind: "trigger"; registrationId: string; componentId: string; definition: TriggerDefinition; lifecycle(): LifecycleContext }
  | { kind: "context"; registrationId: string; componentId: string; definition: ContextDefinition; lifecycle(): LifecycleContext }
  | { kind: "prompt"; registrationId: string; componentId: string; definition: PromptDefinition; lifecycle(): LifecycleContext }
  | { kind: "evaluator"; registrationId: string; componentId: string; definition: EvaluatorDefinition; lifecycle(): LifecycleContext }
  | { kind: "policy"; registrationId: string; componentId: string; definition: PolicyDefinition; lifecycle(): LifecycleContext };

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
  "trigger", "context", "prompt", "evaluator", "policy",
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
  "minLength", "maxLength", "default",
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
  if (type !== undefined && (typeof type !== "string" || !SUPPORTED_TYPES.has(type))) {
    return schemaFailure("core.options-schema-unsupported");
  }
  const enumValues = record["enum"];
  if (enumValues !== undefined && (!Array.isArray(enumValues) || enumValues.length === 0)) {
    return schemaFailure("core.options-schema-unsupported");
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
    if (Array.isArray(enumValues) && !enumValues.some(entry => JSON.stringify(entry) === JSON.stringify(value))) return false;
    if (type === "object" || (type === undefined && compiledProperties.size > 0 && typeof value === "object" && value !== null && !Array.isArray(value))) {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
      const objectValue = value as Record<string, unknown>;
      for (const name of required) {
        if (!Object.hasOwn(objectValue, name)) return false;
      }
      for (const [name, subValidator] of compiledProperties) {
        if (Object.hasOwn(objectValue, name) && !subValidator(objectValue[name])) return false;
      }
      if (!additionalProperties) {
        for (const name of Object.keys(objectValue)) {
          if (!compiledProperties.has(name)) return false;
        }
      }
      return true;
    }
    if (type === "array") {
      if (!Array.isArray(value)) return false;
      return compiledItems === null || value.every(entry => compiledItems(entry));
    }
    if (type === "string") {
      if (typeof value !== "string") return false;
      if (minLength !== null && value.length < minLength) return false;
      if (maxLength !== null && value.length > maxLength) return false;
      return true;
    }
    if (type === "integer") return typeof value === "number" && Number.isInteger(value) && (minimum === null || value >= minimum) && (maximum === null || value <= maximum);
    if (type === "number") return typeof value === "number" && Number.isFinite(value) && (minimum === null || value >= minimum) && (maximum === null || value <= maximum);
    if (type === "boolean") return typeof value === "boolean";
    if (type === "null") return value === null;
    return true;
  };
  return { ok: true, value: validator };
}

/** Reads an own data property without invoking accessors. */
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
    for (const component of componentsInput) {
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
      const compiled = compileOptionsSchema(readDataProperty(meta, "optionsSchema"));
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
      componentIds.push(id);
      prepared.push({
        id,
        component: { kind: shape.kind, registrationId: "", componentId: id, definition: component as ResolvedComponent["definition"], lifecycle: () => this.#lifecycle(id) } as ResolvedComponent,
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

  inventory(): PackageInventoryEntry[] {
    return [...this.#registrations.values()].map(record => {
      const components = record.componentIds.map(id => this.#components.get(id));
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
