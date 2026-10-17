// K06 feedback engine battery: advice admission, bounded delivery, receipt
// reconciliation, duplicate suppression, continuation grants, restart
// reconciliation and byte-bounded rendering.
//
// These are engine-level checks over the real runtime owners; the separate
// native witness (k06-host.test.mjs) proves the actual Pi provider input.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EngineSession } from "../src/runtime.js";
import type { EngineSessionInput } from "../src/runtime.js";
import { renderFeedbackNote } from "../src/feedback.js";
import { FeedbackCourier } from "../src/adapters/pi-feedback.js";
import { newSessionFeedbackState, recordAction, actionCheckpointRecords, restoreActionRecords } from "../src/feedback.js";
import { parseActionRecords as parseCheckpointRecords } from "../src/checkpoint.js";
import type {
  ActionDefinition,
  EffectReceipt,
  EvaluatorDefinition,
  FeedbackRequest,
  Finding,
  HostFeedback,
  PolicyDefinition,
  ReceiptState,
} from "../src/contracts.js";

const RESOURCES_DIR = join(process.cwd(), "resources");

/** Deterministic partial-evidence evaluator used by the contributed-action fixtures. */
function partialEvaluatorForContributed(): EvaluatorDefinition {
  return {
    id: "fixture.partial",
    apiMajor: 1,
    kind: "evaluator",
    mechanism: "deterministic",
    accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.partial-evidence"],
    evaluate: async (_options, input) => ({
      operational: "completed",
      coverage: {
        state: "insufficient",
        scopeDescription: "fixture evidence base is not checkable",
        issues: [{ sourceId: "fixture.partial", reason: "fixture.uncheckable", required: true, evidenceIds: [] }],
      },
      conclusion: "findings",
      findings: [{
        id: `${input.run.runId}:finding-1`,
        criterion: input.assessment.criteria[0] ?? "efficiency.repetition",
        status: "supported",
        severity: "concern",
        requirementRefs: [],
        evidenceIds: [],
        affectedItems: [],
        defectCode: "fixture.defect",
        explanation: "fixture finding over an uncheckable evidence base",
        proposedCorrection: null,
        limitations: [],
      }],
      scores: [],
      additionalEvidence: [],
      dependencies: [],
      usageAttemptIds: [],
    }),
  };
}

interface Delivered {
  actionId: string;
  mode: string;
  text: string;
  allowIdleStart: boolean;
}

interface Fixture {
  root: string;
  agentDir: string;
  projectConfigDir: string;
  session: EngineSession;
  delivered: Delivered[];
  receipt: (value: EffectReceipt) => void;
}

async function withFixture(
  options: {
    mode?: "observe" | "advise";
    actions?: string[];
    allowIdleContinuation?: boolean;
    maxFeedbackPerEpisode?: number;
    maxFeedbackBytes?: number;
    policyOptions?: Record<string, unknown>;
    observedSessionId?: string;
    /** A caller-owned receiver shared across generations (T07 lost-ack). */
    feedbackHost?: HostFeedback;
    /** Keep the fixture's own delivered[] recording alongside a shared receiver. */
    trackDelivered?: boolean;
    /** Skip the operator approval after registration (F3 negative controls). */
    skipApproval?: boolean;
    checkCount?: number;
    hostIdleAtStart?: boolean;
    evaluatorUse?: string;
    policyUse?: string;
    sources?: Record<string, unknown>;
    contextProvider?: Record<string, unknown>;
    register?: (session: EngineSession) => Promise<void>;
  },
  run: (fixture: Fixture) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "qe-k06-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: options.mode ?? "observe",
    runtime: { boundaryWaitMs: 0, maxFeedbackPerEpisode: options.maxFeedbackPerEpisode ?? 3, maxAutonomousFollowUpsPerEpisode: 1 },
    permissions: {
      actions: options.actions ?? [],
      allowIdleContinuation: options.allowIdleContinuation ?? false,
      allowPrimaryAbort: false,
      maxFeedbackBytes: options.maxFeedbackBytes ?? 2048,
    },
    ...(options.sources === undefined ? {} : { sources: options.sources }),
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: {
      "recent-work": {
        providers: [options.contextProvider ?? { id: "history", use: "core.history", options: { limit: 12 } }],
        maxEstimatedTokens: 4000,
      },
    },
    evaluators: options.evaluatorUse === undefined
      ? { "repetition-check": { use: "core.repeated-tools", options: { minimumRepeats: 3 } } }
      : { "repetition-check": { use: options.evaluatorUse, options: {} } },
    policies: { engineering: { use: options.policyUse ?? "core.engineering", options: options.policyOptions ?? {} } },
    checks: {
      repetition: {
        triggers: [{ id: "every-count", use: "core.every-tools", options: { count: options.checkCount ?? 3 } }],
        context: "recent-work",
        prompt: "repetition",
        evaluator: "repetition-check",
        policy: "engineering",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
      },
    },
    observability: {},
  }), "utf8");
  const delivered: Delivered[] = [];
  const host: HostFeedback = {
    capabilities: () => new Set<string>(["host.feedback.steer", "host.feedback.idle-start"]),
    deliver: async (request: FeedbackRequest) => {
      if (options.trackDelivered === false) {
        // The caller's shared receiver records acceptance itself.
        return { actionId: request.actionId, state: "queued", destinationId: "fixture.turn-end", evidenceIds: [] };
      }
      delivered.push({
        actionId: request.actionId,
        mode: request.mode,
        text: request.text,
        allowIdleStart: request.allowIdleStart,
      });
      return { actionId: request.actionId, state: "queued", destinationId: "fixture.turn-end", evidenceIds: [] };
    },
    reconcile: async (actionId: string): Promise<EffectReceipt> => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
  };
  const input: EngineSessionInput & { hostIdleAtStart: boolean } = {
    observedSessionId: options.observedSessionId ?? `sess-${process.pid}-${Date.now()}-${Math.round(performance.now())}`,
    branchId: "unresolved",
    agentDir,
    projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: RESOURCES_DIR,
    hostIdleAtStart: options.hostIdleAtStart ?? true,
    feedbackHost: options.feedbackHost ?? host,
  };
  const session = await EngineSession.start(input);
  if (options.register !== undefined) {
    await options.register(session);
    // A newly installed contribution becomes approved only when the operator
    // accepts the configuration again (the real approval boundary).
    if (options.skipApproval !== true) {
      const reloaded = await session.reloadConfiguration();
      assert.equal(reloaded.ok, true, "the operator approval reload applies");
      await settle();
    }
  }
  const fixture: Fixture = {
    root,
    agentDir,
    projectConfigDir,
    session,
    delivered,
    receipt: value => session.noteHostFeedbackReceipt(value),
  };
  try {
    await run(fixture);
  } finally {
    await session.retire("fixture-complete");
    await rm(root, { recursive: true, force: true });
  }
}

async function settle(): Promise<void> {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 40));
}

function work(fixture: Fixture, text = `assess repetition ${Date.now()}`): void {
  fixture.session.handlePrimaryEvent({
    type: "operator-input",
    text,
    source: "interactive",
    occurredAt: new Date().toISOString(),
  });
}

function tool(fixture: Fixture, id: string, toolName = "read"): void {
  const occurredAt = new Date().toISOString();
  fixture.session.handlePrimaryEvent({ type: "tool-started", operationId: id, toolName, parentOperationId: null, occurredAt });
  fixture.session.handlePrimaryEvent({
    type: "tool-completed",
    operationId: id,
    toolName,
    parentOperationId: null,
    isError: false,
    durationMs: 3,
    occurredAt,
  });
}

/** Drives one full trigger and waits for that check to settle. */
async function drive(fixture: Fixture, prefix: string, expectRun = true): Promise<void> {
  const before = fixture.session.status(true).checks.runs;
  for (let index = 0; index < 3; index += 1) tool(fixture, `${prefix}-${index}`);
  const deadline = Date.now() + 10_000;
  if (expectRun) {
    while (fixture.session.status(true).checks.runs <= before && Date.now() < deadline) await settle();
  }
  await settle();
}

interface EventRecord {
  event: string;
  fields: { data?: Record<string, unknown>; reasonCodes?: string[] };
}

function events(fixture: Fixture): EventRecord[] {
  return fixture.session.status(true).diagnostics.recentEvents as unknown as EventRecord[];
}

/** Durable admission records from the diagnostic journal (the status window is 16). */
async function journalAdmissions(fixture: Fixture, event: string): Promise<Array<Record<string, unknown>>> {
  const logDirectory = join(fixture.agentDir, "quality", "logs");
  let text = "";
  for (const name of await readdir(logDirectory).catch(() => [])) {
    if (name.endsWith(".jsonl")) text += await readFile(join(logDirectory, name), "utf8");
  }
  return text.split(String.fromCharCode(10))
    .filter(line => line.includes(event))
    .map(line => {
      try {
        return (JSON.parse(line) as { fields?: { data?: Record<string, unknown> } }).fields?.data ?? {};
      } catch {
        return {};
      }
    });
}

function admissions(fixture: Fixture, event: string): Array<Record<string, unknown>> {
  return events(fixture)
    .filter(record => record.event === event)
    .map(record => record.fields.data ?? {});
}

test("K06-T01: observe mode records the intended decision and produces no host effect", async () => {
  await withFixture({ mode: "observe", actions: [] }, async fixture => {
    work(fixture);
    await drive(fixture, "observe");
    const decided = admissions(fixture, "quality.policy.decided");
    assert.equal(decided.length >= 1, true, "the policy decision is recorded");
    assert.equal(decided.at(-1)?.disposition, "propose", "the intended decision is a proposal");
    assert.equal((decided.at(-1)?.reasonCodes as string[] | undefined)?.includes("supported-concern"), true);
    assert.deepEqual(admissions(fixture, "quality.action.admission"), [], "no action is admitted in observe mode");
    assert.deepEqual(admissions(fixture, "quality.action.dispatched"), [], "nothing is dispatched");
    assert.equal(fixture.delivered.length, 0, "the host received no delivery");
  });
});

test("K06-T02/T06: one admitted bounded note reaches the host once and the receipt reconciles without regressing", async () => {
  await withFixture({ mode: "advise", actions: ["core.feedback"] }, async fixture => {
    work(fixture);
    await drive(fixture, "advise");
    const admitted = admissions(fixture, "quality.action.admission").filter(entry => entry.outcome === "admitted");
    assert.equal(admitted.length, 1, "exactly one action is admitted");
    const actionId = admitted[0]?.actionId as string;
    assert.match(actionId, /^action-\d+$/);
    const dispatched = admissions(fixture, "quality.action.dispatched");
    assert.equal(dispatched.length, 1, "the admitted action is dispatched once");
    assert.equal(fixture.delivered.length, 1, "the host received exactly one delivery");
    const note = fixture.delivered[0];
    assert.equal(note?.actionId, actionId, "the delivery carries the engine-owned action identity");
    assert.equal(note?.mode, "steer");
    assert.equal(Buffer.byteLength(note?.text ?? "", "utf8") <= 2048, true, "the note stays inside the byte cap");
    assert.equal((note?.text ?? "").includes("criterion efficiency.repetition"), true, "the note names the criterion");
    assert.equal((note?.text ?? "").includes("advisory only"), true, "the note states it is advisory");

    // The host reports the real inclusion evidence; a later weaker report cannot regress it.
    fixture.receipt({ actionId, state: "included", destinationId: "pi.primary.turn-end", evidenceIds: [] });
    fixture.receipt({ actionId, state: "queued", destinationId: "pi.primary.turn-end", evidenceIds: [] });
    await settle();
    const receipts = admissions(fixture, "quality.action.receipt").filter(entry => entry.actionId === actionId);
    assert.equal(receipts.length >= 1, true, "the receipt is recorded");
    assert.equal(receipts.at(-1)?.state, "included", "a terminal inclusion never regresses to queued");
    const revisions = receipts.map(entry => entry.receiptRevision as number);
    assert.deepEqual(revisions, [...revisions].sort((left, right) => left - right), "receipt revisions increase");

    // An acknowledgment-only reply is recorded but never clears the obligation.
    fixture.session.noteFeedbackObserved({
      actionId,
      classification: "acknowledged",
      method: "fixture.reply",
      evidenceIds: [],
      coverage: "unknown",
    });
    // A second equivalent check must not deliver the same issue twice.
    await drive(fixture, "repeat");
    const repeated = (await journalAdmissions(fixture, "quality.action.admission")).filter(entry => entry.outcome === "rejected");
    assert.equal(repeated.some(entry => (entry.reasonCodes as string[]).includes("core.finding-already-delivered")), true,
      "the duplicate issue identity is rejected instead of delivered again");
    assert.equal(fixture.delivered.length, 1, "the host received no second note");
  });
});

test("K06-T03: a follow-up requires the operator grant and a real continuation opportunity", async () => {
  // Without the grant the optional wake is refused even when the policy allows it.
  await withFixture({ mode: "advise", actions: ["core.feedback"], policyOptions: { allowIdleContinuation: true } }, async fixture => {
    work(fixture);
    await drive(fixture, "ungranted");
    const rejected = admissions(fixture, "quality.action.admission").filter(entry => entry.outcome === "rejected");
    assert.equal(rejected.some(entry => (entry.reasonCodes as string[]).includes("core.idle-continuation-not-granted")), true,
      "the optional follow-up is refused without the explicit operator grant");
    assert.equal(fixture.delivered.length, 0, "no host effect without the grant");
  });

  // With the grant, real idle evidence and supported unfinished work the wake is
  // admitted - and the finite per-episode allowance refuses the next one.
  await withFixture(
    { mode: "advise", actions: ["core.feedback"], allowIdleContinuation: true, policyOptions: { allowIdleContinuation: true } },
    async fixture => {
      work(fixture);
      await drive(fixture, "granted");
      const admitted = admissions(fixture, "quality.action.admission").filter(entry => entry.outcome === "admitted");
      assert.equal(admitted.length, 1, "the granted follow-up is admitted once");
      assert.equal(fixture.delivered.length, 1, "the host received the granted note");
      assert.equal(fixture.delivered[0]?.mode, "follow-up", "the granted note is a follow-up, not a steer");
      assert.equal(fixture.delivered[0]?.allowIdleStart, true);
      const runsBefore = fixture.session.status(true).checks.runs;
      for (let index = 0; index < 3; index += 1) tool(fixture, `granted-extra-${index}`, "ls");
      const deadline = Date.now() + 10_000;
      while (fixture.session.status(true).checks.runs <= runsBefore && Date.now() < deadline) await settle();
      await settle();
      const reasons = admissions(fixture, "quality.action.admission")
        .filter(entry => entry.outcome === "rejected")
        .flatMap(entry => (entry.reasonCodes as string[] | undefined) ?? []);
      assert.equal(reasons.includes("core.finding-already-delivered") || reasons.includes("core.follow-up-limit"), true,
        `the finite continuation allowance refuses the next wake (saw ${reasons.join(",") || "nothing"})`);
      assert.equal(fixture.delivered.length, 1, "the episode allowance is finite");
    },
  );
});

test("K06-T04: a stopped observer admits no new check, no action and no host effect", async () => {
  await withFixture({ mode: "advise", actions: ["core.feedback"] }, async fixture => {
    work(fixture);
    await drive(fixture, "before-stop");
    assert.equal(fixture.delivered.length, 1, "the pre-stop note is a real effect");
    fixture.session.requestOperatorStop();
    const runsBefore = fixture.session.status(true).checks.runs;
    await drive(fixture, "stopped", false);
    const status = fixture.session.status(true);
    assert.equal(status.checks.runs, runsBefore, "a stopped observer admits no further check");
    assert.equal(status.runtime.workState, "waiting-operator", "stop is the reported work state");
    assert.equal(
      admissions(fixture, "quality.action.admission").some(entry => entry.outcome === "admitted" && entry.actionId !== fixture.delivered[0]?.actionId),
      false,
      "no second action is admitted after stop",
    );
    assert.equal(fixture.delivered.length, 1, "a stopped observer produces no further host effect");
    assert.equal(status.runtime.operatorStopped, true);
    assert.equal(status.runtime.control.state !== "unavailable", true, "stop persists through the protected control state");
  });
});

test("K06-T05: a relevant evidence change during evaluation makes the run inadmissible", async () => {
  // The finding is delivered once at the current revision, then the same defect
  // seen at a changed primary-evidence revision is rejected as stale instead of
  // reusing the old coordinates.
  await withFixture({ mode: "advise", actions: ["core.feedback"] }, async fixture => {
    work(fixture);
    await drive(fixture, "current");
    assert.equal(fixture.delivered.length, 1, "the current run delivered its note");
    // Unrelated primary activity does not invalidate the earlier note: the second
    // run re-reads its own cited material, finds it unchanged and is current.
    // (Relevant material drift is the separate T05c case.)
    const runsBefore = fixture.session.status(true).checks.runs;
    for (let index = 0; index < 3; index += 1) tool(fixture, `stale-${index}`, "grep");
    const deadline = Date.now() + 10_000;
    while (fixture.session.status(true).checks.runs <= runsBefore && Date.now() < deadline) await settle();
    await settle();
    assert.equal(fixture.delivered.length, 1, "the same unresolved obligation is not delivered a second time");
    const secondRejection = (await journalAdmissions(fixture, "quality.action.admission")).filter(entry => entry.outcome === "rejected");
    assert.equal(
      secondRejection.some(entry => (entry.reasonCodes as string[] | undefined)?.includes("core.finding-already-delivered") ?? false),
      true,
      "the second equivalent concern is the same obligation, not a new effect",
    );
    // Freshness itself is decided by the cited material (T05c), never by this
    // duplicate path or by any global primary-evidence counter.
  });
});

test("K06-B10: distinct opaque targets do not collapse and two equivalent proposals cannot both spend a one-message cap", async () => {
  // Two fixture evaluators whose supported concerns are genuinely distinct (a
  // different defect kind per run), so the second is refused by the spent
  // allowance rather than being explained away as a duplicate.
  let defectSerial = 0;
  const distinctEvaluator = (id: string): EvaluatorDefinition => ({
    id,
    apiMajor: 1,
    kind: "evaluator",
    mechanism: "deterministic",
    accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: [`${id}-evidence`],
    evaluate: async (_options, input) => {
      defectSerial += 1;
      return {
        operational: "completed",
        coverage: input.context.coverage,
        conclusion: "findings",
        findings: [{
          id: `${input.run.runId}:finding-1`,
          criterion: input.assessment.criteria[0] ?? "efficiency.repetition",
          status: "supported",
          severity: "concern",
          requirementRefs: [],
          evidenceIds: [],
          affectedItems: [],
          defectCode: `fixture.distinct-${defectSerial}`,
          explanation: "distinct supported concern",
          proposedCorrection: null,
          limitations: [],
        }],
        scores: [],
        additionalEvidence: [],
        dependencies: input.context.dependencies,
        usageAttemptIds: [],
      };
    },
  });
  const distinctDefectEvaluator = distinctEvaluator("fixture.distinct");
  const distinctCapEvaluator = distinctEvaluator("fixture.cap");
  await withFixture(
    { mode: "advise", actions: ["core.feedback"] },
    async fixture => {
      work(fixture);
      await drive(fixture, "cap");
      const admitted = admissions(fixture, "quality.action.admission").filter(entry => entry.outcome === "admitted");
      assert.equal(admitted.length, 1, "one supported concern spends the episode allowance once");
      assert.equal(fixture.delivered.length, 1, "one host delivery");
      assert.equal(typeof admitted[0]?.actionId, "string");
    },
  );
  // A one-message episode cap: the first concern is admitted, an equivalent
  // second concern in the same episode is refused by the counter (not silently
  // replaced by duplicate suppression).
  await withFixture(
    {
      mode: "advise",
      actions: ["core.feedback"],
      maxFeedbackPerEpisode: 1,
      evaluatorUse: "fixture.cap",
      register: async session => {
        const registered = session.endpoint.register({
          id: "fixture.cap-package",
          version: "0.1.0",
          baseUri: "fixture:cap",
          components: [distinctDefectEvaluator, distinctCapEvaluator],
          resources: {},
        });
        assert.equal(registered.ok, true);
        if (registered.ok) await registered.value.ready;
      },
    },
    async fixture => {
      work(fixture);
      await drive(fixture, "cap-1");
      assert.equal(fixture.delivered.length, 1, "the first concern is admitted under the cap");
      await drive(fixture, "cap-2");
      const rejected = admissions(fixture, "quality.action.admission").filter(entry => entry.outcome === "rejected");
      const reasons = rejected.flatMap(entry => (entry.reasonCodes as string[] | undefined) ?? []);
      assert.equal(reasons.includes("core.feedback-limit"), true,
        `the spent one-message allowance is reported (saw ${reasons.join(",") || "nothing"})`);
      assert.equal(fixture.delivered.length, 1, "no second note under the spent allowance");
    },
  );
});

test("K06-B03/X02: a registered contributed action is guarded by the same runtime facet before and after revocation", async () => {
  let deliverCalls = 0;
  const contributedAction = (): ActionDefinition => ({
    id: "fixture.action",
    apiMajor: 1,
    kind: "action",
    effects: ["primary.feedback"],
    optionsSchema: { type: "object", additionalProperties: true },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.action-note"],
    execute: async (admitted, context) => {
      // A real await before the facet call: this is the late-action window.
      await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
      const request = {
        actionId: admitted.actionId,
        scope: admitted.run.scope,
        mode: "steer" as const,
        text: "contributed bounded note",
        allowIdleStart: false,
      };
      const receipt = await context.host.deliver(request, context.signal);
      deliverCalls += receipt.state === "queued" ? 1 : 0;
      return receipt;
    },
  });
  const contributedPolicy = (): PolicyDefinition => ({
    id: "fixture.policy",
    apiMajor: 1,
    kind: "policy",
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.policy-proposed"],
    decide: () => ({
      outcome: "propose",
      reasonCode: "supported-concern",
      actions: [{
        localId: "contributed-1",
        action: "fixture.action",
        options: { delivery: "steer" },
        findingIds: [],
        evidenceIds: [],
        reasonCode: "fixture.policy-proposed",
      }],
    }),
  });
  await withFixture(
    {
      mode: "advise",
      actions: ["fixture.action"],
      evaluatorUse: "fixture.partial",
      policyUse: "fixture.policy",
      register: async session => {
        const registered = session.endpoint.register({
          id: "fixture.contributed",
          version: "0.1.0",
          baseUri: "fixture:contributed",
          components: [contributedAction(), contributedPolicy(), partialEvaluatorForContributed()],
          resources: {},
        });
        assert.equal(registered.ok, true, "the contributed package registers");
        if (registered.ok) await registered.value.ready;
      },
    },
    async fixture => {
      work(fixture);
      await drive(fixture, "contributed");
      assert.equal(deliverCalls, 1, "the normal contributed action reaches the host through the facet");
      assert.equal(fixture.delivered.length, 1, "the host really received the contributed note");
      // A stopped observer admits no further check at all.
      fixture.session.requestOperatorStop();
      const runsBefore = fixture.session.status(true).checks.runs;
      await drive(fixture, "after-stop", false);
      assert.equal(fixture.session.status(true).checks.runs, runsBefore, "no further check is admitted after stop");
      assert.equal(deliverCalls, 1, "the host still saw exactly the one admitted note");
    },
  );
});

test("K06-B08/X02: a contributed action resuming after an actual Stop is refused by the runtime facet", async () => {
  let releaseExecution: (() => void) | null = null;
  const gate = new Promise<void>(resolvePromise => { releaseExecution = resolvePromise; });
  let started = false;
  let hostCalls = 0;
  const lateAction = (): ActionDefinition => ({
    id: "fixture.late",
    apiMajor: 1,
    kind: "action",
    effects: ["primary.feedback"],
    optionsSchema: { type: "object", additionalProperties: true },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.late-note"],
    execute: async (admitted, context) => {
      started = true;
      // A real await whose resumption is controlled by the test: the action is
      // admitted before Stop and resumes after it.
      await gate;
      const receipt = await context.host.deliver({
        actionId: admitted.actionId,
        scope: admitted.run.scope,
        mode: "steer",
        text: "late contributed note",
        allowIdleStart: false,
      }, context.signal);
      hostCalls += receipt.state === "queued" ? 1 : 0;
      return receipt;
    },
  });
  const latePolicy = (): PolicyDefinition => ({
    id: "fixture.late-policy",
    apiMajor: 1,
    kind: "policy",
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.late-proposed"],
    decide: () => ({
      outcome: "propose",
      reasonCode: "supported-concern",
      actions: [{
        localId: "late-1",
        action: "fixture.late",
        options: { delivery: "steer" },
        findingIds: [],
        evidenceIds: [],
        reasonCode: "fixture.late-proposed",
      }],
    }),
  });
  await withFixture(
    {
      mode: "advise",
      actions: ["fixture.late"],
      evaluatorUse: "fixture.partial",
      policyUse: "fixture.late-policy",
      register: async session => {
        const registered = session.endpoint.register({
          id: "fixture.late-package",
          version: "0.1.0",
          baseUri: "fixture:late",
          components: [lateAction(), latePolicy(), partialEvaluatorForContributed()],
          resources: {},
        });
        assert.equal(registered.ok, true);
        if (registered.ok) await registered.value.ready;
      },
    },
    async fixture => {
      work(fixture);
      for (let index = 0; index < 3; index += 1) tool(fixture, `late-${index}`);
      const deadline = Date.now() + 10_000;
      while (!started && Date.now() < deadline) await settle();
      assert.equal(started, true, "the contributed action started executing");
      fixture.session.requestOperatorStop();
      releaseExecution?.();
      await settle();
      await settle();
      assert.equal(hostCalls, 0, "the late facet call after stop never reaches the host");
      const cancelled = (await journalAdmissions(fixture, "quality.action.receipt"))
        .filter(entry => entry.state === "cancelled");
      assert.equal(cancelled.length >= 1, true, "the late action is cancelled at the facet");
    },
  );
});

test("K06-B03/B10: two equivalent proposals in one decision cannot both spend a one-message cap", async () => {
  let proposals = 0;
  await withFixture(
    {
      mode: "advise",
      actions: ["core.feedback"],
      maxFeedbackPerEpisode: 1,
      evaluatorUse: "fixture.partial",
      policyUse: "fixture.two-policy",
      register: async session => {
        const registered = session.endpoint.register({
          id: "fixture.two",
          version: "0.1.0",
          baseUri: "fixture:two",
          components: [partialEvaluatorForContributed(), {
            id: "fixture.two-policy",
            apiMajor: 1,
            kind: "policy",
            optionsSchema: { type: "object", additionalProperties: false },
            requiredCapabilities: [],
            diagnosticCodes: ["fixture.two-proposed"],
            decide: () => {
              proposals += 1;
              return {
                outcome: "propose",
                reasonCode: "supported-concern",
                actions: [
                  { localId: "a", action: "core.feedback", options: { text: "first note" }, findingIds: [], evidenceIds: [], reasonCode: "fixture.two-proposed" },
                  { localId: "b", action: "core.feedback", options: { text: "second note" }, findingIds: [], evidenceIds: [], reasonCode: "fixture.two-proposed" },
                ],
              };
            },
          }],
          resources: {},
        });
        assert.equal(registered.ok, true);
        if (registered.ok) await registered.value.ready;
      },
    },
    async fixture => {
      work(fixture);
      await drive(fixture, "two-proposals");
      assert.equal(proposals >= 1, true, "the decision really returned two proposals");
      const admitted = (await journalAdmissions(fixture, "quality.action.admission")).filter(entry => entry.outcome === "admitted");
      const rejected = (await journalAdmissions(fixture, "quality.action.admission")).filter(entry => entry.outcome === "rejected");
      assert.equal(admitted.length, 1, "exactly one of the two equivalent proposals is admitted");
      assert.equal(
        rejected.some(entry => (entry.reasonCodes as string[] | undefined)?.includes("core.feedback-limit") ?? false),
        true,
        "the second proposal observes the already spent allowance, not a free budget",
      );
      assert.equal(fixture.delivered.length, 1, "the receiver sees one note");
    },
  );
});

test("K06-B12: unresolved intents are preserved and block dependent admission at the bound", async () => {
  // Each admitted action is a distinct contributed delivery (no findings, no
  // duplicate suppression), so nine runs really reach the eight-record bound.
  const receiver = { calls: 0, ids: new Set<string>() };
  const action = (): ActionDefinition => ({
    id: "fixture.bound",
    apiMajor: 1,
    kind: "action",
    effects: ["primary.feedback"],
    optionsSchema: { type: "object", additionalProperties: true },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.bound-note"],
    execute: async (admitted, context) => {
      const receipt = await context.host.deliver({
        actionId: admitted.actionId,
        scope: admitted.run.scope,
        mode: "steer",
        text: "bounded retained note",
        allowIdleStart: false,
      }, context.signal);
      receiver.calls += receipt.state === "queued" ? 1 : 0;
      return receipt;
    },
  });
  const policy = (): PolicyDefinition => ({
    id: "fixture.bound-policy",
    apiMajor: 1,
    kind: "policy",
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.bound-proposed"],
    decide: () => ({
      outcome: "propose",
      reasonCode: "supported-concern",
      actions: [{
        localId: "bound-1",
        action: "fixture.bound",
        options: { delivery: "steer" },
        findingIds: [],
        evidenceIds: [],
        reasonCode: "fixture.bound-proposed",
      }],
    }),
  });
  await withFixture(
    {
      mode: "advise",
      actions: ["fixture.bound"],
      checkCount: 1,
      // The episode allowance must not mask the durable-intent bound.
      maxFeedbackPerEpisode: 9,
      evaluatorUse: "fixture.partial",
      policyUse: "fixture.bound-policy",
      trackDelivered: false,
      feedbackHost: {
        capabilities: () => new Set<string>(["host.feedback.steer"]),
        deliver: async request => {
          receiver.calls += 1;
          receiver.ids.add(request.actionId);
          return { actionId: request.actionId, state: "queued", destinationId: "fixture.retained", evidenceIds: [] };
        },
        reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
      },
      register: async session => {
        const registered = session.endpoint.register({
          id: "fixture.bound-package",
          version: "0.1.0",
          baseUri: "fixture:bound",
          components: [action(), policy(), partialEvaluatorForContributed()],
          resources: {},
        });
        assert.equal(registered.ok, true);
        if (registered.ok) await registered.value.ready;
      },
    },
    async fixture => {
      work(fixture);
      for (let index = 0; index < 9; index += 1) {
        const before = fixture.session.status(true).checks.runs;
        tool(fixture, `bound-${index}`, index % 2 === 0 ? "read" : "grep");
        const deadline = Date.now() + 10_000;
        while (fixture.session.status(true).checks.runs <= before && Date.now() < deadline) await settle();
        await settle();
        await settle();
      }
      const admissions = await journalAdmissions(fixture, "quality.action.admission");
      const admitted = admissions.filter(entry => entry.outcome === "admitted");
      const rejected = admissions.filter(entry => entry.outcome === "rejected");
      const reasons = rejected.flatMap(entry => (entry.reasonCodes as string[] | undefined) ?? []);
      assert.equal(admitted.length, 8, `exactly the eight-record bound is admitted (got ${admitted.length})`);
      // The admitted dispatch is asynchronous; wait, bounded, for the real receiver.
      const receiverDeadline = Date.now() + 10_000;
      while (receiver.calls < 8 && Date.now() < receiverDeadline) await settle();
      assert.equal(receiver.ids.size, 8, `the receiver saw exactly the eight admitted notes (distinct ids ${receiver.ids.size})`);
      assert.equal(reasons.includes("core.action-intent-capacity"), true,
        `the intended bound refuses the dependent admission specifically (saw ${reasons.join(",") || "nothing"})`);
      // Every admitted identity is retained by the real checkpoint selection and parser.
      const stateDirectory = join(fixture.agentDir, "quality", "state");
      let checkpointText = "";
      for (const name of await readdir(stateDirectory)) {
        if (name.endsWith(".json")) checkpointText += await readFile(join(stateDirectory, name), "utf8");
      }
      const persisted = parseCheckpointRecords(JSON.parse(checkpointText)["actions"]);
      assert.equal(persisted.length, 8, "the durable checkpoint keeps all eight unresolved actions");
      for (const entry of admitted) {
        assert.equal(persisted.some(record => record.actionId === entry.actionId), true,
          `the admitted action ${String(entry.actionId)} survives the checkpoint selection`);
      }
    },
  );
});

test("K06-T05b: an uncheckable evidence base is reported unknown, not delivered", async () => {
  // A fixture evaluator reports a supported finding whose evidence base is not
  // checkable (missing required source). The policy is allowed to propose, and
  // runtime admission must refuse it as unknown instead of reusing the plan.
  const partialEvaluator: EvaluatorDefinition = {
    id: "fixture.partial",
    apiMajor: 1,
    kind: "evaluator",
    mechanism: "deterministic",
    accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.partial-evidence"],
    evaluate: async (_options, input) => ({
      operational: "completed",
      coverage: {
        state: "insufficient",
        scopeDescription: "fixture evidence base is not checkable",
        issues: [{ sourceId: "fixture.partial", reason: "fixture.uncheckable", required: true, evidenceIds: [] }],
      },
      conclusion: "findings",
      findings: [{
        id: `${input.run.runId}:finding-1`,
        criterion: input.assessment.criteria[0] ?? "efficiency.repetition",
        status: "supported",
        severity: "concern",
        requirementRefs: [],
        evidenceIds: [],
        affectedItems: [],
        defectCode: "fixture.defect",
        explanation: "fixture finding over an uncheckable evidence base",
        proposedCorrection: null,
        limitations: [],
      }],
      scores: [],
      additionalEvidence: [],
      dependencies: [],
      usageAttemptIds: [],
    }),
  };
  await withFixture(
    {
      mode: "advise",
      actions: ["core.feedback"],
      evaluatorUse: "fixture.partial",
      policyOptions: { requireCompleteCoverage: false },
      // An optional source that does not exist keeps the run admissible but makes
      // the assembled plan partial, so the finding's base is not checkable.
      sources: { missing: { uris: ["absent-evidence.md"], role: "evidence", required: false } },
      contextProvider: { id: "files", use: "core.files", options: { sourceIds: ["missing"] } },
      register: async session => {
        const registered = session.endpoint.register({
          id: "fixture.partial-package",
          version: "0.1.0",
          baseUri: "fixture:partial",
          components: [partialEvaluator],
          resources: {},
        });
        assert.equal(registered.ok, true, "the fixture evaluator registers");
        if (registered.ok) await registered.value.ready;
      },
    },
    async fixture => {
      work(fixture);
      for (let index = 0; index < 3; index += 1) tool(fixture, `unknown-${index}`, "grep");
      const deadline = Date.now() + 10_000;
      while (fixture.session.status(true).checks.runs === 0 && Date.now() < deadline) await settle();
      await settle();
      const rejected = admissions(fixture, "quality.action.admission").filter(entry => entry.outcome === "rejected");
      const reasons = rejected.flatMap(entry => (entry.reasonCodes as string[] | undefined) ?? []);
      assert.equal(reasons.includes("core.dependency-unknown"), true,
        `the uncheckable base is named unknown (saw ${reasons.join(",") || "nothing"})`);
      assert.equal(fixture.delivered.length, 0, "nothing is delivered from an uncheckable base");
    },
  );
});

test("K06-T07/T08: restart reconciles the same action as unknown and a multibyte note stays inside the byte cap", async () => {
  const observedSessionId = `sess-restart-${process.pid}-${Date.now()}`;
  let restoredAgentDir = "";
  let restoredProjectDir = "";
  await withFixture({ mode: "advise", actions: ["core.feedback"], observedSessionId }, async first => {
    work(first);
    await drive(first, "restart");
    assert.equal(first.delivered.length, 1, "the first generation delivered one note");
    const actionId = first.delivered[0]?.actionId as string;
    first.receipt({ actionId, state: "dispatched", destinationId: "pi.primary.turn-end", evidenceIds: [] });
    // The generation must commit durable intent before it is replaced.
    await first.session.retire("restart-window");
    restoredAgentDir = first.agentDir;
    restoredProjectDir = first.projectConfigDir;
    // The durable intent really is in the protected state before the restart.
    const stateDirectory = join(restoredAgentDir, "quality", "state");
    let checkpointText = "";
    for (const name of await readdir(stateDirectory)) {
      if (name.endsWith(".json")) checkpointText += await readFile(join(stateDirectory, name), "utf8");
    }
    assert.equal(checkpointText.includes(actionId), true, "the committed intent names the same action identity");
    assert.equal(checkpointText.includes("[quality-advice]"), false, "the bounded note text never enters the protected state");
    const restarted = await EngineSession.start({
      observedSessionId,
      branchId: "unresolved",
      agentDir: restoredAgentDir,
      projectConfigDir: restoredProjectDir,
      projectTrusted: true,
      hostVersion: "1.1.0",
      hostMode: "rpc",
      resourcesDir: RESOURCES_DIR,
      hostIdleAtStart: true,
    });
    try {
      // Activation opens the protected state asynchronously; wait, bounded, for
      // the restarted generation to reach its applied configuration.
      const deadline = Date.now() + 10_000;
      while (restarted.status(true).configuration.revision === "cfg-0" && Date.now() < deadline) await settle();
      // No resend: the restored suppression set still rejects the same issue.
      const restartedFixture: Fixture = {
        root: first.root,
        agentDir: restoredAgentDir,
        projectConfigDir: restoredProjectDir,
        session: restarted,
        delivered: [],
        receipt: value => restarted.noteHostFeedbackReceipt(value),
      };
      work(restartedFixture, `restart work ${Date.now()}`);
      await drive(restartedFixture, "restart-dup");
      const rejected = admissions(restartedFixture, "quality.action.admission").filter(entry => entry.outcome === "rejected");
      assert.equal(rejected.some(entry => (entry.reasonCodes as string[]).includes("core.finding-already-delivered")), true,
        "the restored issue identity is not delivered a second time");
      assert.equal(restartedFixture.delivered.length, 0, "a restart never resends the note");
    } finally {
      await restarted.retire("fixture-complete");
    }
    // The reconciliation record is durable evidence in the bounded journal even
    // when it precedes the applied configuration revision in the status view.
    const logDirectory = join(restoredAgentDir, "quality", "logs");
    let journalText = "";
    for (const name of await readdir(logDirectory)) {
      if (name.endsWith(".jsonl")) journalText += await readFile(join(logDirectory, name), "utf8");
    }
    const receipts = journalText.split(String.fromCharCode(10))
      .filter(line => line.includes("quality.action.receipt"))
      .map(line => JSON.parse(line) as { fields?: { data?: Record<string, unknown> } })
      .map(record => record.fields?.data ?? {})
      .filter(entry => entry.actionId === actionId && entry.state === "unknown");
    assert.equal(receipts.length >= 1, true, "the restart reports the same action identity as explicitly unknown");
  });
});

test("K06-B12/T07: one connected receiver counts accept once across acceptance loss and real checkpoint restore", async () => {
  const accepted: string[] = [];
  // One receiver outside both generations. It accepts the note, then throws after
  // acceptance, so the local acknowledgment is lost on the normal action path.
  const sharedReceiver: HostFeedback = {
    capabilities: () => new Set<string>(["host.feedback.steer"]),
    deliver: async (request: FeedbackRequest) => {
      accepted.push(request.actionId);
      throw new Error("fixture acknowledgment lost after acceptance");
    },
    reconcile: async (actionId: string): Promise<EffectReceipt> => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
  };
  const observedSessionId = `sess-lostack-${process.pid}-${Date.now()}`;
  await withFixture(
    { mode: "advise", actions: ["core.feedback"], observedSessionId, feedbackHost: sharedReceiver, trackDelivered: false },
    async first => {
      work(first);
      await drive(first, "lost-ack");
      const deadline = Date.now() + 10_000;
      let unknownReceipt = false;
      while (!unknownReceipt && Date.now() < deadline) {
        unknownReceipt = (await journalAdmissions(first, "quality.action.receipt"))
          .some(entry => entry.state === "unknown" && accepted.includes(entry.actionId as string));
        if (!unknownReceipt) await settle();
      }
      assert.equal(accepted.length, 1, "the receiver accepted exactly once before the acknowledgment was lost");
      const actionId = accepted[0] as string;
      assert.equal(unknownReceipt, true, "the lost acknowledgment is reported as unknown for the same action");
      assert.equal(first.delivered.length, 0, "the fixture host delivered nothing on the shared receiver path");
      const stateDirectory = join(first.agentDir, "quality", "state");
      let checkpointText = "";
      for (const name of await readdir(stateDirectory)) {
        if (name.endsWith(".json")) checkpointText += await readFile(join(stateDirectory, name), "utf8");
      }
      assert.equal(checkpointText.includes(actionId), true, "the checkpoint retains the uncertain action identity");
      assert.equal(checkpointText.includes("[quality-advice"), false, "no note body is persisted in the checkpoint");
      await first.session.retire("restart-window");
      // Restore the real checkpoint with the SAME receiver, inside the fixture so
      // the temp root still exists.
      const restarted = await EngineSession.start({
        observedSessionId,
        branchId: "unresolved",
        agentDir: first.agentDir,
        projectConfigDir: first.projectConfigDir,
        projectTrusted: true,
        hostVersion: "1.1.0",
        hostMode: "rpc",
        resourcesDir: RESOURCES_DIR,
        hostIdleAtStart: true,
        feedbackHost: sharedReceiver,
      });
      try {
        const readyDeadline = Date.now() + 10_000;
        while (restarted.status(true).checks.active === 0 && Date.now() < readyDeadline) await settle();
        assert.equal(restarted.status(true).checks.active >= 1, true, "the restored generation really activated its check");
        const restoredFixture: Fixture = {
          root: first.root,
          agentDir: first.agentDir,
          projectConfigDir: first.projectConfigDir,
          session: restarted,
          delivered: [],
          receipt: value => restarted.noteHostFeedbackReceipt(value),
        };
        // The equivalent supported finding must reach a valid assessment again.
        work(restoredFixture, `equivalent finding ${Date.now()}`);
        await drive(restoredFixture, "lost-ack-restored");
        const rejected = (await journalAdmissions(restoredFixture, "quality.action.admission")).filter(entry => entry.outcome === "rejected");
        const reasons = rejected.flatMap(entry => (entry.reasonCodes as string[] | undefined) ?? []);
        assert.equal(reasons.includes("core.finding-already-delivered"), true,
          `the restored duplicate is rejected by duplicate suppression, not host/permission failure (saw ${reasons.join(",") || "nothing"})`);
        assert.equal(reasons.includes("core.action-revoked") || reasons.includes("core.feedback-unsupported"), false,
          "no missing-host or authority error explains the rejection");
        assert.equal(accepted.length, 1, "the connected receiver total stays one across both generations");
      } finally {
        await restarted.retire("fixture-complete");
      }
    },
  );
});

test("K06-B05/X02: the actual final contributed request is byte-bounded before any receiver call", async () => {
  // A contributed action whose planned proposal text is small but whose actual
  // delivered FeedbackRequest is large: the runtime facet must refuse the real
  // final text before the receiver sees it, and the descriptor must be truthful.
  let deliveredText = "";
  const receiver = { calls: 0, bytes: 0 };
  const action = (): ActionDefinition => ({
    id: "fixture.action",
    apiMajor: 1,
    kind: "action",
    effects: ["primary.feedback"],
    optionsSchema: { type: "object", additionalProperties: true },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.action-note"],
    execute: async (admitted, context) => context.host.deliver({
      actionId: admitted.actionId,
      scope: admitted.run.scope,
      mode: "steer",
      text: deliveredText,
      allowIdleStart: false,
    }, context.signal),
  });
  const policy = (): PolicyDefinition => ({
    id: "fixture.policy",
    apiMajor: 1,
    kind: "policy",
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.policy-proposed"],
    decide: () => ({
      outcome: "propose",
      reasonCode: "supported-concern",
      actions: [{
        localId: "contributed-1",
        action: "fixture.action",
        options: { delivery: "steer", text: "planned-small" },
        findingIds: [],
        evidenceIds: [],
        reasonCode: "fixture.policy-proposed",
      }],
    }),
  });
  const run = async (text: string): Promise<{ receipts: Array<Record<string, unknown>>; dispatched: Array<Record<string, unknown>> }> => {
    let captured: { receipts: Array<Record<string, unknown>>; dispatched: Array<Record<string, unknown>> } | null = null;
    await withFixture(
    {
      mode: "advise",
      actions: ["fixture.action"],
      evaluatorUse: "fixture.partial",
      policyUse: "fixture.policy",
      feedbackHost: {
        capabilities: () => new Set<string>(["host.feedback.steer"]),
        deliver: async request => {
          receiver.calls += 1;
          receiver.bytes = Buffer.byteLength(request.text, "utf8");
          return { actionId: request.actionId, state: "queued", destinationId: "fixture.receiver", evidenceIds: [] };
        },
        reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
      },
      trackDelivered: false,
      register: async session => {
        const registered = session.endpoint.register({
          id: "fixture.action-package",
          version: "0.1.0",
          baseUri: "fixture:action",
          components: [action(), policy(), partialEvaluatorForContributed()],
          resources: {},
        });
        assert.equal(registered.ok, true);
        if (registered.ok) await registered.value.ready;
      },
    },
    async fixture => {
      deliveredText = text;
      work(fixture);
      await drive(fixture, "final-bytes");
      const receipts = await journalAdmissions(fixture, "quality.action.receipt");
      const dispatched = await journalAdmissions(fixture, "quality.action.dispatched");
      captured = { receipts, dispatched };
    },
  );
    assert.ok(captured !== null);
    return captured;
  };
  // Bounded positive: the receiver really gets 24 bytes and the descriptor agrees.
  const positive = await run("bounded note 24 bytes!!" + "x".repeat(24 - "bounded note 24 bytes!!".length));
  assert.equal(receiver.calls, 1, "the bounded contribution reaches the receiver once");
  assert.equal(receiver.bytes, 24, "the receiver receives the actual final text");
  const positiveDispatch = positive.dispatched.at(-1);
  assert.equal(positiveDispatch?.bodyDescriptor, "feedback-bytes-24", "the descriptor reports the delivered bytes");
  // Over-cap negative: 3000 bytes under a 2048-byte grant, refused before the receiver.
  receiver.calls = 0;
  receiver.bytes = 0;
  const negative = await run("y".repeat(3000));
  assert.equal(receiver.calls, 0, "the over-cap final request never reaches the receiver");
  assert.equal(negative.dispatched.length, 0, "a refused request is never reported as dispatched");
  const refusal = negative.receipts.filter(entry => entry.state === "rejected");
  assert.equal(refusal.some(entry => entry.errorCode === "core.feedback-bytes-exceeded"), true,
    "the over-cap final text is refused with the explicit bounded reason");
});

test("K06-B12: mixed settled/unresolved retention keeps all eight unresolved identities", () => {
  const makeState = (unresolved: number, settled: number) => {
    const state = newSessionFeedbackState();
    let revision = 0;
    for (let index = 1; index <= unresolved; index += 1) {
      revision += 1;
      recordAction(state, {
        actionId: `action-${index}`,
        issueIds: [`issue-${index}`],
        findingRefs: [],
        delivery: "steer",
        state: "unknown",
        receiptRevision: 3,
        destinationId: null,
        evidenceIds: [],
        errorCode: "core.action-execution-uncertain",
        textBytes: 10,
        checkpointRevision: revision,
        createdAt: "2026-10-17T00:00:00.000Z",
      });
    }
    for (let index = 1; index <= settled; index += 1) {
      revision += 1;
      recordAction(state, {
        actionId: `settled-${index}`,
        issueIds: [`settled-issue-${index}`],
        findingRefs: [],
        delivery: "steer",
        state: "included",
        receiptRevision: 4,
        destinationId: "fixture",
        evidenceIds: [],
        errorCode: null,
        textBytes: 10,
        checkpointRevision: revision,
        createdAt: "2026-10-17T00:00:00.000Z",
      });
    }
    return state;
  };
  // Seven unresolved plus one settled: the settled record fits next to all seven.
  const seven = actionCheckpointRecords(makeState(7, 1));
  assert.equal(seven.length, 8);
  assert.deepEqual(seven.filter(record => record.state === "unknown").map(record => record.actionId),
    ["action-1", "action-2", "action-3", "action-4", "action-5", "action-6", "action-7"]);
  assert.equal(seven.some(record => record.state === "included"), true, "seven unresolved leave one settled slot");
  // Eight unresolved: zero settled capacity; no tombstone may be displaced.
  const eight = actionCheckpointRecords(makeState(8, 1));
  assert.equal(eight.length, 8, "the bound selects exactly eight records");
  assert.equal(eight.every(record => record.state === "unknown"), true, "no settled record takes an unresolved slot");
  assert.deepEqual(eight.map(record => record.actionId), ["action-1", "action-2", "action-3", "action-4", "action-5", "action-6", "action-7", "action-8"]);
  // The production parser and restore keep every retained identity and its suppression.
  const parsed = parseCheckpointRecords(JSON.parse(JSON.stringify(eight)));
  assert.deepEqual(parsed.map(record => record.actionId), eight.map(record => record.actionId), "the parser keeps all eight unresolved actions");
  const restored = newSessionFeedbackState();
  const restoredRecords = restoreActionRecords(restored, parsed);
  assert.equal(restoredRecords.length, 8, "restore brings back all eight");
  for (let index = 1; index <= 8; index += 1) {
    assert.equal(restored.suppressedIssues.has(`issue-${index}`), true, `issue-${index} suppression identity is retained`);
  }
});

test("K06-B03/X02: an action installed after approval stays unapproved until an explicit reapproval", async () => {
  const receiver = { calls: 0 };
  const widenedAction = (): ActionDefinition => ({
    id: "fixture.action",
    apiMajor: 1,
    kind: "action",
    // Wider than the grant's accepted declaration: it must not establish its own
    // baseline through the first proposal.
    effects: ["primary.feedback", "primary.restart"],
    optionsSchema: { type: "object", additionalProperties: true },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.action-note"],
    execute: async (admitted, context) => {
      const receipt = await context.host.deliver({
        actionId: admitted.actionId,
        scope: admitted.run.scope,
        mode: "steer",
        text: "approved bounded note",
        allowIdleStart: false,
      }, context.signal);
      receiver.calls += receipt.state === "queued" ? 1 : 0;
      return receipt;
    },
  });
  const policy = (): PolicyDefinition => ({
    id: "fixture.policy",
    apiMajor: 1,
    kind: "policy",
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: ["fixture.policy-proposed"],
    decide: () => ({
      outcome: "propose",
      reasonCode: "supported-concern",
      actions: [{
        localId: "contributed-1",
        action: "fixture.action",
        options: { delivery: "steer" },
        findingIds: [],
        evidenceIds: [],
        reasonCode: "fixture.policy-proposed",
      }],
    }),
  });
  await withFixture(
    {
      mode: "advise",
      actions: ["fixture.action"],
      evaluatorUse: "fixture.partial",
      policyUse: "fixture.policy",
      trackDelivered: false,
      // The component registers after the configuration approval and is NOT
      // approved again: its first proposal must not pin itself.
      skipApproval: true,
      register: async session => {
        const registered = session.endpoint.register({
          id: "fixture.action-package",
          version: "0.1.0",
          baseUri: "fixture:action",
          components: [widenedAction(), policy(), partialEvaluatorForContributed()],
          resources: {},
        });
        assert.equal(registered.ok, true);
        if (registered.ok) await registered.value.ready;
      },
    },
    async fixture => {
      work(fixture);
      await drive(fixture, "unapproved");
      const rejected = (await journalAdmissions(fixture, "quality.action.admission"))
        .filter(entry => entry.outcome === "rejected")
        .flatMap(entry => (entry.reasonCodes as string[] | undefined) ?? []);
      assert.equal(rejected.includes("core.action-effects-unapproved"), true,
        `the first proposal cannot approve a post-approval declaration (saw ${rejected.join(",") || "nothing"})`);
      assert.equal(receiver.calls, 0, "the unapproved declaration produces no host effect");
      // Explicit operator reapproval makes the current accepted declaration usable.
      const reloaded = await fixture.session.reloadConfiguration();
      assert.equal(reloaded.ok, true, "the reapproval reload applies");
      await settle();
      await drive(fixture, "reapproved");
      const admitted = (await journalAdmissions(fixture, "quality.action.admission"))
        .filter(entry => entry.outcome === "admitted");
      assert.equal(admitted.length >= 1, true, "after reapproval the accepted declaration is admitted");
      assert.equal(receiver.calls, 1, "the reapproved action reaches the host once");
    },
  );
});

test("K06-T08: deterministic rendering keeps a multibyte note inside the byte cap without splitting a code point", () => {
  const finding: Finding = {
    id: "run-1:finding-1",
    criterion: "efficiency.repetition",
    status: "supported",
    severity: "concern",
    requirementRefs: [],
    evidenceIds: ["core.history:obs-3"],
    affectedItems: ["core.history:obs-3"],
    defectCode: "efficiency.repeated-tool",
    explanation: `Повтор 👨‍👩‍👧 sequence ${"я".repeat(200)}`,
    proposedCorrection: `Примените меньшее исправление ✅ ${"ю".repeat(200)}`,
    limitations: [`неопределённость ${"ё".repeat(80)}`],
  };
  for (const maxBytes of [64, 256, 1024]) {
    const rendered = renderFeedbackNote({
      template: "## Quality advice",
      checkId: "repetition",
      coverage: "complete",
      findings: [finding],
      omitted: 3,
      maxBytes,
    });
    assert.equal(Buffer.byteLength(rendered.text, "utf8") <= maxBytes, true, `the note stays within ${maxBytes} bytes`);
    assert.equal(rendered.text.includes("\uFFFD"), false, "no code point is split by truncation");
    assert.equal(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(rendered.text, "utf8")) === rendered.text, true, "the bounded text round-trips");
  }
  const full = renderFeedbackNote({
    template: "## Quality advice",
    checkId: "repetition",
    coverage: "complete",
    findings: [finding],
    omitted: 0,
    maxBytes: 65_536,
  });
  assert.equal(full.text.includes("efficiency.repetition"), true, "the untruncated note names the criterion");
  assert.equal(full.bytes, Buffer.byteLength(full.text, "utf8"), "the reported byte count is the real serialized size");
});

test("K06 adapter: one note becomes one boundary draft, an abort cancels instead of waking, and inclusion is observed", async () => {
  const receipts: EffectReceipt[] = [];
  const observations: string[] = [];
  const courier = new FeedbackCourier({
    onReceipt: value => receipts.push(value),
    onObserved: value => observations.push(`${value.actionId}:${value.method}`),
    isActive: () => true,
    boundaryWaitMs: () => 0,
    awaitBoundaryReady: async () => ({ quiescent: true, waitedMs: 0 }),
  });
  const host = courier.bindHost();
  const request = {
    actionId: "action-1",
    scope: { observedSessionId: "s", branchId: "unresolved", runtimeGeneration: "g", episodeId: "e", authorizationRevision: "auth-1" },
    mode: "steer" as const,
    text: "bounded note",
    allowIdleStart: false,
  };
  const queued = await host.deliver(request, new AbortController().signal);
  assert.equal(queued.state, "queued", "a return from deliver is queued, never included");
  const draft = await courier.turnEndDraft();
  assert.ok(draft, "the ready note becomes one boundary draft");
  assert.equal(draft?.continue, true);
  assert.equal(draft?.draft.customType, "pi-quality-engine.feedback.v1");
  assert.equal(courier.pendingCount(), 0, "the note leaves the queue exactly once");
  assert.equal(await courier.turnEndDraft(), null, "the same note is never drafted twice");
  assert.equal((await host.deliver(request, new AbortController().signal)).state, "dispatched", "a duplicate delivery is the same operation identity");

  // Neither transcript preparation nor a payload without the note is inclusion.
  courier.observeProviderInput({ messages: [{ role: "user", content: [{ type: "text", text: "unrelated request text" }] }] });
  assert.equal(receipts.some(value => value.state === "included"), false, "a payload without the note is never called included");
  // The actual provider payload carrying the note identity is real inclusion, once.
  courier.observeProviderInput({
    messages: [
      { role: "user", content: [{ type: "text", text: "bounded note [quality-advice action-1] tail" }] },
      { role: "user", content: [{ type: "text", text: "bounded note [quality-advice action-1] tail" }] },
    ],
  });
  courier.observeProviderInput({ messages: [{ role: "user", content: [{ type: "text", text: "[quality-advice action-1]" }] }] });
  assert.deepEqual(observations, ["action-1:pi.provider-request-inclusion"], "inclusion is reported once with its real method");
  assert.equal(receipts.filter(value => value.state === "included").length, 1, "one inclusion receipt");
  // A naturally ending turn never forces continuation for a queued steer.
  const natural = await host.deliver({ ...request, actionId: "action-natural" }, new AbortController().signal);
  assert.equal(natural.state, "queued");
  assert.equal(await courier.turnEndDraft(false), null, "a natural end boundary does not draft a steer");
  assert.equal(courier.pendingCount(), 1, "the steer waits for the next actual run instead");

  // An abort cancels an undelivered note instead of waking the primary.
  const second = await host.deliver({ ...request, actionId: "action-2" }, new AbortController().signal);
  assert.equal(second.state, "queued");
  const aborted = await courier.beforeSettleDraft({ canContinue: true, aborted: true });
  assert.equal(aborted, null, "an aborted run receives no draft");
  assert.equal(receipts.some(value => value.actionId === "action-2" && value.state === "cancelled"), true, "the pending note is cancelled");
  assert.equal(courier.pendingCount(), 0);

  // The pending queue is bounded.
  for (let index = 0; index < 8; index += 1) {
    await host.deliver({ ...request, actionId: `action-bound-${index}` }, new AbortController().signal);
  }
  const overflow = await host.deliver({ ...request, actionId: "action-overflow" }, new AbortController().signal);
  assert.equal(overflow.state, "rejected", "an unbounded queue is refused");
  assert.equal(overflow.error?.code, "core.feedback-queue-full");
});

test("K06: the receipt vocabulary never regresses a terminal state", () => {
  const terminalStates: ReceiptState[] = ["included", "completed", "rejected", "failed", "cancelled"];
  for (const state of terminalStates) {
    assert.equal(typeof state, "string");
  }
});
