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

  const query = () => {
    if (sessionId === null) return;
    pi.events.emit(QUERY_CHANNEL, {
      apiMajor: 1,
      observedSessionId: sessionId,
      reply(candidate) {
        if (candidate === null || candidate === undefined) return;
        if (candidate.apiMajor !== 1 || candidate.observedSessionId !== sessionId) return;
        endpoint = candidate;
        register();
      },
    });
  };

  const register = () => {
    if (endpoint === null || registration !== null) return;
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
        if (input.cause !== "observation" || input.observation?.kind !== "core.tool-completed") {
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
    const result = endpoint.register({
      id: FIXTURE_PACKAGE_ID,
      version: "0.1.0",
      baseUri: new URL(".", import.meta.url).href,
      components: [trigger, context, evaluator, policy, action,
        projectedFileSink("fixture.mutating-sink"), projectedFileSink("fixture.projected-sink"), projectedFileSink("fixture.stalled-sink")],
      resources: { "k08-context": { uri: CONTEXT_RESOURCE.href }, "k08-prompt": { uri: PROMPT_RESOURCE.href } },
      async prepare(ctx) {
        document = await readFile(CONTEXT_RESOURCE, { encoding: "utf8", signal: ctx.signal });
        revision = "sha256:" + createHash("sha256").update(document, "utf8").digest("hex");
        acquiredAt = ctx.clock().utc;
      },
    });
    if (!result.ok) {
      registration = { ready: Promise.resolve(result), dispose: async () => {} };
      return;
    }
    registration = result.value;
  };

  pi.on("session_start", (_event, ctx) => {
    sessionId = ctx.sessionManager.getSessionId();
    endpoint = null;
    registration = null;
    unsubscribeAvailable?.();
    unsubscribeAvailable = pi.events.on(AVAILABLE_CHANNEL, candidate => {
      if (candidate === null || candidate === undefined) return;
      if (candidate.observedSessionId !== sessionId) return;
      endpoint = candidate;
      register();
    });
    query();
  });

  pi.on("session_shutdown", async () => {
    const current = registration;
    registration = null;
    endpoint = null;
    sessionId = null;
    unsubscribeAvailable?.();
    unsubscribeAvailable = null;
    if (current !== null) {
      try {
        await current.ready;
      } catch {
        // A failed preparation is disposed the same way.
      }
      await current.dispose();
    }
  });
}
