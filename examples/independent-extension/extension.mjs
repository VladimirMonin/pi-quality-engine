// Independent C1 contribution used by real-boundary integration tests.
//
// This package intentionally imports nothing from the engine source tree. It
// discovers the session registry through the documented C1 event channels and
// registers its own trigger, context, evaluator, policy and action. It is loaded
// separately from the engine through Pi's ordinary extension mechanism.

import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { openSync, writeSync, writeFileSync, closeSync, fsyncSync } from "node:fs";

const AVAILABLE_CHANNEL = "quality.registry.available.v1";
const QUERY_CHANNEL = "quality.registry.query.v1";
export const FIXTURE_PACKAGE_ID = "fixture.independent-extension";
export const FIXTURE_TRIGGER_ID = "fixture.burst-tools";
export const FIXTURE_CONTEXT_ID = "fixture.note";
export const FIXTURE_EVALUATOR_ID = "fixture.audit-evaluator";
export const FIXTURE_POLICY_ID = "fixture.audit-policy";
export const FIXTURE_ACTION_ID = "fixture.audit-file";
export const FIXTURE_OBSERVATION_ID = "fixture.observation";
const OBSERVATION_CHANNEL = "fixture.observation.input.v1";
const CONTEXT_RESOURCE = new URL("./resources/k08-context.md", import.meta.url);
const PROMPT_RESOURCE = new URL("./resources/k08-prompt.md", import.meta.url);

// One ordinary sink implementation, independently instantiated under three IDs
// so each diagnostic destination has its own acknowledgement and lifetime.
function projectedFileSink(id) {
  return {
    id, apiMajor: 1, kind: "sink", requiredCapabilities: [], diagnosticCodes: [],
    optionsSchema: { type: "object", properties: { destination: { type: "string" }, mutate: { type: "boolean" }, stallMs: { type: "integer", minimum: 0, maximum: 10000 } }, required: ["destination"], additionalProperties: false },
    create(options) {
      const destination = new URL(options.destination);
      if (destination.protocol !== "file:") throw new Error("Projected sink destination must be a file URI");
      const lifecycle = new URL(destination.href + ".lifecycle.json"), entries = new URL(destination.href + ".entries.jsonl");
      const fd = openSync(destination, "wx"), entryFd = openSync(entries, "wx");
      let disposed = false, calls = 0, completed = 0, pending = 0, mutationAttempts = 0, mutationsApplied = 0, releasedAt = null, blocked = Number(options.stallMs ?? 0) > 0;
      const gate = blocked ? new Promise(resolvePromise => setTimeout(() => { blocked = false; releasedAt = Date.now(); resolvePromise(); }, options.stallMs)) : null;
      const snapshot = () => writeFileSync(lifecycle, JSON.stringify({ id, disposed, calls, completed, pending, mutationAttempts, mutationsApplied, releasedAt }) + "\n", "utf8");
      snapshot();
      return {
        write(record) {
          if (disposed) throw new Error("Projected sink is disposed");
          calls += 1;
          writeSync(entryFd, JSON.stringify({ eventId: record.eventId, sequence: record.sequence, held: blocked, enteredAt: Date.now() }) + "\n");
          const before = structuredClone(record);
          const deliver = () => {
            let mutationApplied = false;
            if (options.mutate === true) {
              mutationAttempts += 1;
              // Deliberately mutate the RECEIVED object, not a private test copy.
              // A protected representation may reject this harmless attempt.
              try { record.fields.data.fixtureMutation = "K08_MUTATOR_ONLY"; mutationApplied = record.fields.data.fixtureMutation === "K08_MUTATOR_ONLY"; } catch { /* protected snapshot */ }
              if (mutationApplied) mutationsApplied += 1;
            }
            writeSync(fd, JSON.stringify({ before, after: structuredClone(record), mutationAttempted: options.mutate === true, mutationApplied, writtenAt: Date.now() }) + "\n");
            completed += 1;
          };
          if (blocked && gate !== null) {
            pending += 1;
            return gate.then(() => { try { deliver(); } finally { pending -= 1; } });
          }
          deliver();
        },
        async flush() { if (gate !== null) await gate; fsyncSync(fd); },
        async dispose() { if (disposed) return; if (gate !== null) await gate; disposed = true; closeSync(fd); closeSync(entryFd); snapshot(); },
      };
    },
  };
}

export default function independentFixture(pi) {
  let unsubscribeAvailable = null;
  let endpoint = null;
  let sessionId = null;
  let registration = null;
  let currentInstance = null, previousInstance = null, instanceNumber = 0;
  let holdNext = false, lastFailure = null, lastRepeat = null;
  let currentSource = null, previousSource = null, sourceNumber = 0;
  const sourceStatus = source => source === null ? null : ({
    number: source.number, packageNumber: source.packageNumber, scope: source.context.scope,
    signalAborted: source.context.signal.aborted, startReturned: source.startReturned,
    callbacks: source.callbacks, disposals: source.disposals, results: [...source.results],
  });
  const instanceStatus = value => value === null ? null : ({
    number: value.number, registrationId: value.handle?.registrationId ?? null,
    generation: value.handle?.generation ?? null, scope: value.lifecycle?.scope ?? null,
    signalAborted: value.lifecycle?.signal.aborted ?? null, held: value.held,
    prepareCalls: value.prepareCalls, resourceReadStarts: value.resourceReadStarts,
    resourceReads: value.resourceReads, readyCallbacks: value.readyCallbacks,
    ready: value.ready, disposeCalls: value.disposeCalls, noteOffers: value.noteOffers,
  });
  const snapshot = () => ({
    current: instanceStatus(currentInstance), previous: instanceStatus(previousInstance),
    currentSource: sourceStatus(currentSource), previousSource: sourceStatus(previousSource),
    endpointGeneration: endpoint?.engineGeneration ?? null, holdNext, lastFailure, lastRepeat,
    sameDefinitionAsPrevious: currentInstance !== null && previousInstance !== null && currentInstance.definition === previousInstance.definition,
    sameLifecycleAsPrevious: currentInstance?.lifecycle !== undefined && currentInstance.lifecycle === previousInstance?.lifecycle,
  });

  const query = () => {
    if (sessionId === null) return;
    pi.events.emit(QUERY_CHANNEL, {
      apiMajor: 1,
      observedSessionId: sessionId,
      reply(candidate) {
        accept(candidate);
      },
    });
  };

  const register = () => {
    if (endpoint === null || registration !== null) return;
    const held = holdNext;
    holdNext = false;
    let release = () => {};
    const gate = held ? new Promise(resolvePromise => { release = resolvePromise; }) : null;
    const instance = { number: ++instanceNumber, held, release, prepareCalls: 0,
      resourceReadStarts: 0, resourceReads: 0, readyCallbacks: 0, ready: null,
      disposeCalls: 0, noteOffers: 0, handle: null, definition: null };
    let document = null;
    let revision = null;
    let acquiredAt = null;
    const trigger = {
      id: FIXTURE_TRIGGER_ID,
      apiMajor: 1,
      kind: "trigger",
      optionsSchema: {
        type: "object",
        properties: { count: { type: "integer", minimum: 1 } },
        required: ["count"],
        additionalProperties: false,
      },
      requiredCapabilities: ["fixture.contribution"],
      diagnosticCodes: ["fixture.burst"],
      initialState: () => ({ seen: 0 }),
      update(options, input) {
        if (input.cause !== "observation" || (input.observation?.kind !== "core.tool-completed"
          && !(input.observation?.kind === "fixture.signal" && input.observation.origin.ownerId === FIXTURE_OBSERVATION_ID))) {
          return { state: input.state, intent: null, nextDueMonoMs: null };
        }
        const seen = Number((input.state && input.state.seen) || 0) + 1;
        const count = Number(options.count);
        if (seen >= count) {
          return {
            state: { seen: 0 },
            intent: { reasons: [{ code: "fixture.burst", evidenceIds: [input.observation.id] }] },
            nextDueMonoMs: null,
          };
        }
        return { state: { seen }, intent: null, nextDueMonoMs: null };
      },
    };
    const context = {
      id: FIXTURE_CONTEXT_ID,
      apiMajor: 1,
      kind: "context",
      produces: ["json"],
      optionsSchema: { type: "object", additionalProperties: false },
      requiredCapabilities: [],
      diagnosticCodes: ["fixture.note"],
      async collect() {
        if (document === null) throw new Error("Independent context resource is not ready");
        const value = { note: "independent contribution", document };
        return {
          ok: true,
          value: {
            items: [{
              id: "fixture-note-item",
              role: "evidence",
              required: false,
              content: [{ type: "json", value }],
              provenance: {
                sourceId: FIXTURE_CONTEXT_ID,
                uri: CONTEXT_RESOURCE.href,
                revision,
                acquiredAt,
                selection: { kind: "full" },
                changedDuringRead: false,
              },
              bytes: Buffer.byteLength(JSON.stringify(value), "utf8"),
              tokenEstimate: null,
            }],
            coverage: { state: "complete", scopeDescription: "Independent fixture note source.", issues: [] },
            dependencies: [],
          },
        };
      },
    };
    const evaluator = {
      id: FIXTURE_EVALUATOR_ID, apiMajor: 1, kind: "evaluator", mechanism: "direct-model",
      accepts: ["text", "json"], requiredCapabilities: [],
      diagnosticCodes: ["fixture.audit-request", "fixture.audit-response", "fixture.audit-model-unbound", "fixture.audit-scope-refused"],
      optionsSchema: { type: "object", properties: { maxOutputTokens: { type: "integer", minimum: 1 }, requestProfile: { type: "string" }, requestRun: { type: "string" } }, required: ["maxOutputTokens"], additionalProperties: false },
      async evaluate(options, input, ctx) {
        ctx.diagnostics.note({ code: "fixture.audit-request", counts: { calls: 1 } });
        const unavailable = error => ({
          operational: "unavailable", coverage: { state: "insufficient", scopeDescription: "The managed assessment request was unavailable.", issues: [] },
          conclusion: "undetermined", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [], error,
        });
        if (input.modelProfileId === null) return unavailable({ code: "fixture.audit-model-unbound", retryable: false });
        const response = await ctx.services.request({
          // A requested override is still subordinate to the run's selected
          // binding; the public service, never this component, grants it.
          runId: options.requestRun ?? input.run.runId, profileId: options.requestProfile ?? input.modelProfileId, kind: "chat",
          context: input.context, assessment: input.assessment, maxOutputTokens: options.maxOutputTokens,
        }, ctx.signal);
        ctx.diagnostics.note({ code: "fixture.audit-response", counts: { completed: response.ok, records: response.ok ? response.value.attemptIds.length : 0 } });
        if (!response.ok) {
          if (response.error.code === "core.model-request-scope-mismatch") ctx.diagnostics.note({ code: "fixture.audit-scope-refused", counts: { rejected: 1 } });
          return unavailable(response.error);
        }
        const result = typeof response.value.output === "string" ? JSON.parse(response.value.output) : response.value.output;
        // Normal runtime validation still owns canonical validity and references.
        return { ...result, usageAttemptIds: [...response.value.attemptIds] };
      },
    };
    const policy = {
      id: FIXTURE_POLICY_ID, apiMajor: 1, kind: "policy", requiredCapabilities: [],
      diagnosticCodes: ["fixture.audit-record", "fixture.audit-ineligible"],
      optionsSchema: { type: "object", properties: { destination: { type: "string" } }, required: ["destination"], additionalProperties: false },
      decide(options, input) {
        if (input.mode !== "advise" || input.freshness !== "current" || input.result.operational !== "completed" || input.result.coverage.state !== "complete") {
          return { outcome: "no-action", reasonCode: "fixture.audit-ineligible", actions: [] };
        }
        // An audit record is not primary feedback or an engineering accusation.
        // This synchronous proposal performs no file or model operation.
        return { outcome: "propose", reasonCode: "fixture.audit-record", actions: [{
          localId: "audit-record", action: FIXTURE_ACTION_ID, reasonCode: "fixture.audit-record", findingIds: [], evidenceIds: [],
          options: { destination: options.destination, summary: { operational: input.result.operational, coverage: input.result.coverage.state, conclusion: input.result.conclusion, usageAttemptIds: [...input.result.usageAttemptIds] } },
        }] };
      },
    };
    const action = {
      id: FIXTURE_ACTION_ID, apiMajor: 1, kind: "action", effects: ["fixture.audit-file"], requiredCapabilities: [], diagnosticCodes: ["fixture.audit-written"],
      optionsSchema: { type: "object", properties: { destination: { type: "string" }, summary: { type: "object" } }, required: ["destination", "summary"], additionalProperties: false },
      async execute(input, ctx) {
        const destination = new URL(input.proposal.options.destination);
        if (destination.protocol !== "file:") throw new Error("Audit destination must be a file URI");
        const record = { actionId: input.actionId, run: input.run, authorizationRevision: input.authorizationRevision, summary: input.proposal.options.summary };
        // Creation is exclusive; completion is returned only after the real write.
        await writeFile(destination, JSON.stringify(record, null, 2) + "\n", { encoding: "utf8", flag: "wx", signal: ctx.signal });
        ctx.diagnostics.note({ code: "fixture.audit-written", counts: { records: 1 } });
        return { actionId: input.actionId, state: "completed", destinationId: null, evidenceIds: [] };
      },
    };
    const observation = {
      id: FIXTURE_OBSERVATION_ID, apiMajor: 1, kind: "observation", requiredCapabilities: [], diagnosticCodes: [],
      optionsSchema: { type: "object", properties: { holdStart: { type: "boolean" } }, additionalProperties: false },
      observationSchemas: { "fixture.signal": { type: "object", properties: { changed: { type: "boolean" } }, required: ["changed"], additionalProperties: false } },
      async start(options, context) {
        let release = () => {};
        const gate = options.holdStart === true ? new Promise(resolvePromise => { release = resolvePromise; }) : null;
        const source = { number: ++sourceNumber, packageNumber: instance.number, context, release,
          startReturned: false, callbacks: 0, disposals: 0, results: [] };
        source.publish = event => {
          source.callbacks += 1;
          const result = context.publish({ externalId: event.externalId, kind: event.kind ?? "fixture.signal",
            occurredAt: context.clock().utc, visibility: "complete", facts: event.facts ?? { changed: true }, evidenceIds: event.evidenceIds ?? [] });
          source.results.push(result.ok ? { ok: true, observationId: result.value.observationId } : { ok: false, errorCode: result.error.code });
          if (source.results.length > 8) source.results.shift();
          return result;
        };
        previousSource?.release();
        previousSource = currentSource;
        currentSource = source;
        if (gate !== null) await gate;
        const unsubscribe = pi.events.on(OBSERVATION_CHANNEL, source.publish);
        source.startReturned = true;
        return { dispose() { source.disposals += 1; unsubscribe(); } };
      },
    };
    const definition = {
      id: FIXTURE_PACKAGE_ID,
      version: "0.1.0",
      baseUri: new URL(".", import.meta.url).href,
      components: [trigger, context, evaluator, policy, action, observation,
        projectedFileSink("fixture.mutating-sink"), projectedFileSink("fixture.projected-sink"), projectedFileSink("fixture.stalled-sink")],
      resources: { "k08-context": { uri: CONTEXT_RESOURCE.href }, "k08-prompt": { uri: PROMPT_RESOURCE.href } },
      async prepare(ctx) {
        instance.prepareCalls += 1;
        instance.lifecycle = ctx;
        if (gate !== null) {
          await gate;
          instance.noteOffers += 1;
          ctx.diagnostics.note({ code: "fixture.note", counts: { records: instance.number } });
        }
        instance.resourceReadStarts += 1;
        document = await readFile(CONTEXT_RESOURCE, { encoding: "utf8", signal: ctx.signal });
        instance.resourceReads += 1;
        revision = "sha256:" + createHash("sha256").update(document, "utf8").digest("hex");
        acquiredAt = ctx.clock().utc;
      },
    };
    instance.definition = definition;
    const result = endpoint.register(definition);
    if (!result.ok) {
      lastFailure = result.error.code;
      return;
    }
    previousInstance?.release();
    previousInstance = currentInstance;
    currentInstance = instance;
    instance.handle = result.value;
    registration = result.value;
    lastFailure = null;
    registration.ready.then(value => {
      instance.readyCallbacks += 1;
      instance.ready = value.ok ? { ok: true } : { ok: false, errorCode: value.error.code };
    });
  };

  const accept = candidate => {
    if (candidate?.apiMajor !== 1 || candidate.observedSessionId !== sessionId) return;
    if (registration !== null && candidate.engineGeneration !== registration.generation) return;
    endpoint = candidate;
    register();
  };

  // An ordinary demo command controls only this package's owned C1 handles and
  // bounded local preparation gates. It grants no engine/model/effect authority.
  pi.registerCommand("fixture-lifecycle", {
    description: "Inspect, hold, release or dispose the independent example's C1 registration",
    async handler(args, ctx) {
      const [operation, number, externalId] = args.trim().split(/\s+/u);
      const instance = [currentInstance, previousInstance].find(value => value !== null && value.number === Number(number));
      const source = [currentSource, previousSource].find(value => value !== null && value.number === Number(number));
      if (operation === "observe") pi.events.emit(OBSERVATION_CHANNEL, { externalId: number });
      else if (operation === "observe-bad") pi.events.emit(OBSERVATION_CHANNEL, { externalId: number, facts: { changed: "invalid" } });
      else if (operation === "observe-foreign") pi.events.emit(OBSERVATION_CHANNEL, { externalId: number, evidenceIds: ["obs-999999"] });
      else if (operation === "publish-source") source?.publish({ externalId: externalId });
      else if (operation === "release-source") source?.release();
      else if (operation === "hold-next") holdNext = true;
      else if (operation === "release") instance?.release();
      else if (operation === "dispose" && currentInstance !== null) {
        currentInstance.disposeCalls += 1;
        await currentInstance.handle.dispose();
        registration = null;
      } else if (operation === "register") query();
      else if (operation === "repeat" && currentInstance !== null && endpoint !== null) {
        const result = endpoint.register(currentInstance.definition);
        lastRepeat = result.ok ? { ok: true, registrationId: result.value.registrationId,
          generation: result.value.generation, sameReadyPromise: result.value.ready === currentInstance.handle.ready }
          : { ok: false, errorCode: result.error.code };
      } else if (operation === "note" && instance?.lifecycle !== undefined) {
        instance.noteOffers += 1;
        instance.lifecycle.diagnostics.note({ code: "fixture.note", counts: { records: instance.number } });
      }
      ctx.ui.notify(JSON.stringify(snapshot()), "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    endpoint = null;
    registration = null;
    unsubscribeAvailable?.();
    unsubscribeAvailable = pi.events.on(AVAILABLE_CHANNEL, accept);
    query();
  });

  pi.on("session_shutdown", async () => {
    currentSource?.release(); previousSource?.release();
    registration = null;
    endpoint = null;
    sessionId = null;
    unsubscribeAvailable?.();
    unsubscribeAvailable = null;
    for (const instance of [currentInstance, previousInstance]) {
      if (instance === null) continue;
      instance.release();
      instance.disposeCalls += 1;
      await instance.handle.dispose();
      await instance.handle.ready;
    }
  });
}
