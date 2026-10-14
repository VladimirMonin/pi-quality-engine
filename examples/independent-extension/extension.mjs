// Independent C1 contribution used by real-boundary integration tests.
//
// This package intentionally imports nothing from the engine source tree. It
// discovers the session registry through the documented C1 event channels and
// registers one trigger and one context provider. It is loaded separately from
// the engine through Pi's ordinary extension mechanism.

const AVAILABLE_CHANNEL = "quality.registry.available.v1";
const QUERY_CHANNEL = "quality.registry.query.v1";
export const FIXTURE_PACKAGE_ID = "fixture.independent-extension";
export const FIXTURE_TRIGGER_ID = "fixture.burst-tools";
export const FIXTURE_CONTEXT_ID = "fixture.note";

export default function independentFixture(pi) {
  let subscribed = false;
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
      collect() {
        return {
          ok: true,
          value: {
            items: [{
              id: "fixture-note-item",
              role: "evidence",
              required: false,
              content: [{ type: "json", value: { note: "independent contribution" } }],
              provenance: {
                sourceId: FIXTURE_CONTEXT_ID,
                uri: "fixture:note",
                revision: "fixture-note-rev-1",
                acquiredAt: new Date().toISOString(),
                selection: { kind: "full" },
                changedDuringRead: false,
              },
              bytes: 24,
              tokenEstimate: null,
            }],
            coverage: { state: "complete", scopeDescription: "Independent fixture note source.", issues: [] },
            dependencies: [],
          },
        };
      },
    };
    const result = endpoint.register({
      id: FIXTURE_PACKAGE_ID,
      version: "0.1.0",
      baseUri: "fixture:independent-extension",
      components: [trigger, context],
      resources: {},
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
    if (!subscribed) {
      subscribed = true;
      pi.events.on(AVAILABLE_CHANNEL, candidate => {
        if (candidate === null || candidate === undefined) return;
        if (candidate.observedSessionId !== sessionId) return;
        endpoint = candidate;
        register();
      });
    }
    query();
  });

  pi.on("session_shutdown", async () => {
    const current = registration;
    registration = null;
    endpoint = null;
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
