import assert from "node:assert/strict";
import test from "node:test";
import { ComponentRegistry } from "../src/registry.js";
import type { LifecycleContext } from "../src/contracts.js";
import type { ContextDefinition, PackageDefinition, TriggerDefinition } from "../src/contracts.js";
import type { ComponentLifecycleData } from "../src/contracts.js";

function makeTrigger(id = "fixture.trigger"): TriggerDefinition {
  return {
    id,
    apiMajor: 1,
    kind: "trigger",
    optionsSchema: { type: "object", properties: { count: { type: "integer", minimum: 1 } }, required: ["count"], additionalProperties: false },
    requiredCapabilities: ["fixture.capability"],
    diagnosticCodes: ["fixture.due"],
    initialState: () => ({ seen: 0 }),
    update: (_options, input) => ({ state: input.state, intent: null, nextDueMonoMs: null }),
  };
}

function makeProvider(id = "fixture.context"): ContextDefinition {
  return {
    id,
    apiMajor: 1,
    kind: "context",
    produces: ["json"],
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: [],
    collect: async () => ({
      ok: true,
      value: {
        items: [],
        coverage: { state: "complete", scopeDescription: "Empty fixture source.", issues: [] },
        dependencies: [],
      },
    }),
  };
}

function makeRegistry(lifecycle: ComponentLifecycleData[] = [], initTimeoutMs = 500): ComponentRegistry {
  return new ComponentRegistry({
    scope: {
      observedSessionId: "sess-registry",
      branchId: "unresolved",
      runtimeGeneration: "gen-registry",
      episodeId: null,
      authorizationRevision: "auth-0",
    },
    generation: "gen-registry",
    initTimeoutMs,
    lifecycle: data => lifecycle.push(data),
    emitNote: () => {},
    acceptsReference: () => true,
  });
}

test("registration is acknowledged immediately and components resolve only after ready", async () => {
  const registry = makeRegistry();
  let releasePrepare: () => void = () => {};
  const gate = new Promise<void>(resolve => {
    releasePrepare = resolve;
  });
  const definition: PackageDefinition = {
    id: "fixture.package",
    version: "1.0.0",
    baseUri: "fixture:package",
    components: [makeTrigger()],
    resources: {},
    prepare: async () => {
      await gate;
    },
  };
  const registration = registry.register(definition);
  assert.equal(registration.ok, true);
  if (!registration.ok) return;
  assert.equal(registry.resolve("fixture.trigger", { count: 1 }).ok, false);
  releasePrepare();
  const ready = await registration.value.ready;
  assert.equal(ready.ok, true);
  const resolved = registry.resolve("fixture.trigger", { count: 1 });
  assert.equal(resolved.ok, true);
  if (resolved.ok) assert.equal(resolved.value.kind, "trigger");
});

test("prepare failure leaves other packages usable and reports the failed component", async () => {
  const lifecycle: ComponentLifecycleData[] = [];
  const registry = makeRegistry(lifecycle);
  const failing: PackageDefinition = {
    id: "fixture.failing",
    version: "1.0.0",
    baseUri: "fixture:failing",
    components: [makeTrigger("fixture.failing-trigger")],
    resources: {},
    prepare: async () => {
      throw new Error("fixture failure");
    },
  };
  const healthy: PackageDefinition = {
    id: "fixture.healthy",
    version: "1.0.0",
    baseUri: "fixture:healthy",
    components: [makeProvider("fixture.healthy-context")],
    resources: {},
  };
  const failedRegistration = registry.register(failing);
  const healthyRegistration = registry.register(healthy);
  assert.equal(failedRegistration.ok, true);
  assert.equal(healthyRegistration.ok, true);
  if (!failedRegistration.ok || !healthyRegistration.ok) return;
  const failedReady = await failedRegistration.value.ready;
  assert.equal(failedReady.ok, false);
  if (!failedReady.ok) assert.equal(failedReady.error.code, "core.prepare-failed");
  assert.equal((await healthyRegistration.value.ready).ok, true);
  assert.equal(registry.resolve("fixture.failing-trigger", {}).ok, false);
  assert.equal(registry.resolve("fixture.healthy-context", {}).ok, true);
  assert.ok(lifecycle.some(entry => entry.componentId === "fixture.failing-trigger" && entry.phase === "failed"));
});

test("a duplicate component id from another owner is rejected while the same instance is idempotent", async () => {
  const registry = makeRegistry();
  const definition: PackageDefinition = {
    id: "fixture.first",
    version: "1.0.0",
    baseUri: "fixture:first",
    components: [makeTrigger("fixture.shared-trigger")],
    resources: {},
  };
  const first = registry.register(definition);
  const repeat = registry.register(definition);
  assert.equal(first.ok, true);
  assert.equal(repeat.ok, true);
  if (first.ok && repeat.ok) assert.equal(repeat.value.registrationId, first.value.registrationId);

  const conflicting = registry.register({
    id: "fixture.second",
    version: "1.0.0",
    baseUri: "fixture:second",
    components: [makeTrigger("fixture.shared-trigger")],
    resources: {},
  });
  assert.equal(conflicting.ok, false);
  if (!conflicting.ok) assert.equal(conflicting.error.code, "core.duplicate-component");
});

test("component options are validated against the declared schema", async () => {
  const registry = makeRegistry();
  const registration = registry.register({
    id: "fixture.options",
    version: "1.0.0",
    baseUri: "fixture:options",
    components: [makeTrigger()],
    resources: {},
  });
  assert.equal(registration.ok, true);
  if (!registration.ok) return;
  await registration.value.ready;
  const invalid = registry.resolve("fixture.trigger", { count: 0 });
  assert.equal(invalid.ok, false);
  if (!invalid.ok) assert.equal(invalid.error.code, "core.options-invalid");
  assert.equal(registry.resolve("fixture.trigger", { count: 2 }).ok, true);

  const unsupported = registry.register({
    id: "fixture.unsupported-schema",
    version: "1.0.0",
    baseUri: "fixture:unsupported",
    components: [{ ...makeTrigger("fixture.unsupported-trigger"), optionsSchema: { type: "object", oneOf: [] } }],
    resources: {},
  });
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.error.code, "core.options-schema-unsupported");
});

test("observation declarations snapshot schemas and reject accessor metadata before invocation", async () => {
  const registry = makeRegistry();
  let starts = 0, getters = 0;
  const schema = { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"], additionalProperties: false };
  const definition = {
    id: "fixture.source", apiMajor: 1 as const, kind: "observation" as const,
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: [],
    observationSchemas: { "fixture.signal": schema }, start() { starts += 1; return {}; },
  };
  const admitted = registry.register({ id: "fixture.sources", version: "1.0.0", baseUri: "fixture:sources", components: [definition], resources: {} });
  assert.equal(admitted.ok, true);
  if (!admitted.ok) return;
  assert.equal((await admitted.value.ready).ok, true);
  schema.properties.changed.type = "string";
  const resolved = registry.resolve("fixture.source", {});
  assert.equal(resolved.ok, true);
  if (resolved.ok && resolved.value.kind === "observation") {
    assert.ok(JSON.stringify(resolved.value.definition.observationSchemas).includes("boolean"), "caller mutation cannot widen an admitted schema");
  }
  const codes: string[] = [];
  Object.defineProperty(codes, "0", { enumerable: true, configurable: true, get() { getters += 1; return "fixture.raw"; } });
  const bad = registry.register({ id: "fixture.accessor-source", version: "1.0.0", baseUri: "fixture:bad", resources: {}, components: [{ ...definition, id: "fixture.bad-source", diagnosticCodes: codes }] });
  assert.equal(bad.ok, false); assert.equal(getters, 0); assert.equal(starts, 0, "acknowledged readiness is not source activation");
  await admitted.value.dispose();
});

test("disposed registration provenance never borrows replacement component readiness", async () => {
  const registry = makeRegistry();
  const first = registry.register({
    id: "fixture.replacement", version: "1.0.0", baseUri: "fixture:replacement",
    components: [makeTrigger()], resources: {},
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal((await first.value.ready).ok, true);
  await first.value.dispose();
  const replacement = registry.register({
    id: "fixture.replacement", version: "1.0.0", baseUri: "fixture:replacement",
    components: [makeTrigger()], resources: {},
  });
  assert.equal(replacement.ok, true);
  if (!replacement.ok) return;
  assert.equal((await replacement.value.ready).ok, true);
  assert.notEqual(replacement.value.registrationId, first.value.registrationId);
  const old = registry.inventory().find(entry => entry.registrationId === first.value.registrationId);
  const current = registry.inventory().find(entry => entry.registrationId === replacement.value.registrationId);
  assert.equal(old?.phase, "disposed");
  assert.equal(old?.readyComponents, 0, "a matching component ID does not confer replacement ownership");
  assert.equal(old?.failedComponents, 0);
  assert.equal(current?.readyComponents, 1);
  await first.value.dispose();
  assert.equal(registry.resolve("fixture.trigger", { count: 1 }).ok, true, "repeated old disposal cannot remove the replacement");
  await replacement.value.dispose();
});

test("disposal is idempotent, revokes bound contexts and removes the component", async () => {
  const lifecycle: ComponentLifecycleData[] = [];
  const registry = makeRegistry(lifecycle);
  let boundContext: LifecycleContext | undefined;
  const registration = registry.register({
    id: "fixture.dispose",
    version: "1.0.0",
    baseUri: "fixture:dispose",
    components: [makeProvider()],
    resources: {},
    prepare: async context => {
      boundContext = context;
    },
  });
  assert.equal(registration.ok, true);
  if (!registration.ok) return;
  await registration.value.ready;
  assert.equal(boundContext?.signal.aborted, false);
  await registration.value.dispose();
  await registration.value.dispose();
  assert.equal(boundContext?.signal.aborted, true, "disposal revokes the retained lifecycle context");
  assert.equal(registry.resolve("fixture.context", {}).ok, false);
  assert.equal(lifecycle.filter(entry => entry.phase === "disposed").length, 1);
});

test("a retired generation rejects new registrations and late preparation", async () => {
  const registry = makeRegistry();
  let releasePrepare: () => void = () => {};
  const gate = new Promise<void>(resolve => {
    releasePrepare = resolve;
  });
  const registration = registry.register({
    id: "fixture.late",
    version: "1.0.0",
    baseUri: "fixture:late",
    components: [makeProvider("fixture.late-context")],
    resources: {},
    prepare: async () => {
      await gate;
    },
  });
  assert.equal(registration.ok, true);
  if (!registration.ok) return;
  registry.retire();
  const later = registry.register({
    id: "fixture.after-retire",
    version: "1.0.0",
    baseUri: "fixture:after",
    components: [makeProvider("fixture.after-context")],
    resources: {},
  });
  assert.equal(later.ok, false);
  if (!later.ok) assert.equal(later.error.code, "core.retired-generation");
  releasePrepare();
  const ready = await registration.value.ready;
  assert.equal(ready.ok, false);
  if (!ready.ok) assert.equal(ready.error.code, "core.retired-generation");
  assert.equal(registry.resolve("fixture.late-context", {}).ok, false);
});

test("a preparation that never settles is bounded by the init timeout", async () => {
  const registry = makeRegistry([], 100);
  const registration = registry.register({
    id: "fixture.never",
    version: "1.0.0",
    baseUri: "fixture:never",
    components: [makeProvider("fixture.never-context")],
    resources: {},
    prepare: async () => {
      await new Promise(() => {});
    },
  });
  assert.equal(registration.ok, true);
  if (!registration.ok) return;
  const ready = await registration.value.ready;
  assert.equal(ready.ok, false);
  if (!ready.ok) assert.equal(ready.error.code, "core.prepare-timeout");
  assert.equal(registry.resolve("fixture.never-context", {}).ok, false);
});
