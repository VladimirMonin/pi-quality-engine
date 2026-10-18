// K07 recovery child: a real separate Node process that starts the actual
// EngineSession with the selected checkpoint writer, admits one contributed
// action and stops inside a controlled window so the parent can kill it.
//
// Not a production hook: this is an offline test fixture using only the public
// EngineSession surface. argv: <root> <mode> <sessionId>; mode is one of
// "intent" (before dispatch), "dispatch" (after the receiver accepted, before
// the receipt settles) or "receipt" (after the effect returned).

import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [root, mode, sessionId] = process.argv.slice(2);
const repo = process.env.QE_K07_REPO;
if (!root || !mode || !sessionId || !repo) {
  console.error("usage: root mode sessionId (QE_K07_REPO)");
  process.exit(64);
}
const { EngineSession } = await import(pathToFileURL(join(repo, "dist/runtime.js")).href);
const agentDir = join(root, "agent");
const projectConfigDir = join(root, "project", ".pi");
const marker = join(root, `marker-${mode}.txt`);
const accepted = join(root, "accepted.txt");

// K07 233-B.3: a real fresh process reopens the actual protected checkpoint of a
// retired generation with no inherited in-memory feed, witnesses the same
// unknown model attempt/reservations, proves useful same-route work stays denied
// with spare capacity, writes its receipt and exits natively before C opens.
if (mode === "model-unknown") {
  const arrivalsFile = join(root, "child-model-arrivals.txt");
  const receiptFile = join(root, "child-model-receipt.json");
  const noFinding = {
    operational: "completed",
    coverage: { state: "complete", scopeDescription: "child unexpected direct assessment", issues: [] },
    conclusion: "no-supported-finding",
    findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
  };
  const childPort = {
    findChat: () => ({ provider: "fixture", model: "scripted-1" }),
    findClassifier: () => ({ provider: "fixture", model: "scripted-1" }),
    hasConfiguredAuth: () => true,
    async completeChat() {
      appendFileSync(arrivalsFile, "1" + String.fromCharCode(10));
      return { text: JSON.stringify(noFinding), model: { provider: "fixture", id: "scripted-1", revision: null }, usage: null, stopReason: "stop", errorCode: null };
    },
    async classify() { throw new Error("child classifier is not used"); },
  };
  const childSession = await EngineSession.start({
    observedSessionId: sessionId,
    branchId: "unresolved",
    agentDir,
    projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: join(repo, "resources"),
    hostIdleAtStart: true,
    modelRegistry: childPort,
  });
  try {
    const stateDir = join(agentDir, "quality", "state");
    let checkpoint = null;
    for (const name of await readdir(stateDir).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const parsed = JSON.parse(await readFile(join(stateDir, name), "utf8"));
      if (parsed["observedSessionId"] === sessionId) checkpoint = parsed;
    }
    const attempts = checkpoint?.financial?.attempts ?? [];
    const target = attempts.find(entry => entry.state === "unresolved" || entry.state === "dispatched") ?? attempts[0] ?? null;
    const at = new Date().toISOString();
    childSession.handlePrimaryEvent({ type: "operator-input", text: "child dependent work", source: "interactive", occurredAt: at });
    childSession.handlePrimaryEvent({ type: "tool-started", operationId: "child-1", toolName: "read", parentOperationId: null, occurredAt: at });
    childSession.handlePrimaryEvent({ type: "tool-completed", operationId: "child-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 1_500));
    let journal = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl")) journal += await readFile(join(agentDir, "quality", "logs", name), "utf8");
    }
    const denials = journal.split(String.fromCharCode(10)).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean)
      .filter(record => record.event === "quality.check.admission" && record.fields?.data?.outcome === "denied")
      .flatMap(record => record.fields?.data?.reasonCodes ?? []);
    let arrivals = 0;
    try { arrivals = readFileSync(arrivalsFile, "utf8").split(String.fromCharCode(10)).filter(Boolean).length; } catch { arrivals = 0; }
    const receipt = {
      attemptId: target?.attemptId ?? null,
      state: target?.state ?? null,
      reservedTokens: target?.reservedTokens ?? null,
      totalTokens: target?.totalTokens ?? null,
      denialReasons: denials,
      arrivals,
    };
    writeFileSync(receiptFile, JSON.stringify(receipt), "utf8");
    await childSession.retire("child-complete");
    process.exit(target !== null && arrivals === 0 && denials.includes("core.retired-unsettled-limit") ? 0 : 1);
  } catch (error) {
    console.error("child model-unknown failed", String(error));
    process.exit(1);
  }
}

// K07-B.04/B.07: a real fresh process reopens the actual protected checkpoint of
// a retired generation, with a registry port that truly represents the configured
// R_A/R_B routes, and witnesses that the original attempt keeps its run identity,
// original generation, branch, captured route and price while its dependent work
// stays denied. It writes its receipt and exits natively before C opens.
if (mode === "known-origin") {
  const deadline = Math.min(Number(process.env.QE_K07_FIXTURE_DEADLINE ?? Date.now() + 85_000), Date.now() + 85_000);
  const workDeadline = Math.min(Number(process.env.QE_K07_FIXTURE_WORK_DEADLINE ?? deadline - 10_000), deadline - 10_000);
  let pending = 0;
  const withinOriginDeadline = async (operation, cleanup = false) => {
    const remaining = (cleanup ? deadline : workDeadline) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error("known-origin child deadline exhausted");
    const actual = Promise.resolve().then(operation);
    pending += 1;
    actual.then(() => { pending -= 1; }, () => { pending -= 1; });
    let timer;
    try {
      return await Promise.race([actual, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("known-origin child operation deadline")), remaining);
      })]);
    } finally { clearTimeout(timer); }
  };
  const arrivalsFile = join(root, "child-origin-arrivals.txt");
  const receiptFile = join(root, "child-origin-receipt.json");
  const noFinding = {
    operational: "completed",
    coverage: { state: "complete", scopeDescription: "child known-origin assessment", issues: [] },
    conclusion: "no-supported-finding",
    findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
  };
  const childPort = {
    findChat: (provider) => ({ provider, model: provider === "fixture-a" ? "a-1" : "b-1" }),
    findClassifier: () => null,
    hasConfiguredAuth: () => true,
    async completeChat(model) {
      appendFileSync(arrivalsFile, String(model?.provider ?? "unknown") + String.fromCharCode(10));
      return { text: JSON.stringify(noFinding), model: { provider: model?.provider ?? "fixture-a", id: model?.id ?? "a-1", revision: null }, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, totalTokens: 110 }, stopReason: "stop", errorCode: null };
    },
    async classify() { throw new Error("child classifier is not used"); },
  };
  let childSession = null;
  try {
    childSession = await withinOriginDeadline(() => EngineSession.start({
    observedSessionId: sessionId,
    branchId: "unresolved",
    agentDir,
    projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: join(repo, "resources"),
    hostIdleAtStart: true,
    modelRegistry: childPort,
  }));
    const stateDir = join(agentDir, "quality", "state");
    let checkpoint = null;
    for (const name of await withinOriginDeadline(() => (readdir(stateDir).catch(() => [])))) {
      if (!name.endsWith(".json")) continue;
      const parsed = JSON.parse(await withinOriginDeadline(() => (readFile(join(stateDir, name), "utf8"))));
      if (parsed["observedSessionId"] === sessionId) checkpoint = parsed;
    }
    const attempts = checkpoint?.financial?.attempts ?? [];
    const target = attempts.find(entry => entry.state === "unresolved" || entry.state === "dispatched") ?? attempts[0] ?? null;
    const at = new Date().toISOString();
    childSession.handlePrimaryEvent({ type: "operator-input", text: "child known-origin dependent work", source: "interactive", occurredAt: at });
    childSession.handlePrimaryEvent({ type: "tool-started", operationId: "child-origin-1", toolName: "read", parentOperationId: null, occurredAt: at });
    childSession.handlePrimaryEvent({ type: "tool-completed", operationId: "child-origin-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
    await withinOriginDeadline(() => (new Promise(resolvePromise => setTimeout(resolvePromise, 1_500))));
    let journal = "";
    for (const name of await withinOriginDeadline(() => (readdir(join(agentDir, "quality", "logs")).catch(() => [])))) {
      if (name.endsWith(".jsonl")) journal += await withinOriginDeadline(() => (readFile(join(agentDir, "quality", "logs", name), "utf8")));
    }
    const denials = journal.split(String.fromCharCode(10)).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean)
      .filter(record => record.event === "quality.check.admission" && record.fields?.data?.outcome === "denied")
      .flatMap(record => record.fields?.data?.reasonCodes ?? []);
    let arrivals = 0;
    try { arrivals = readFileSync(arrivalsFile, "utf8").split(String.fromCharCode(10)).filter(Boolean).length; } catch { arrivals = 0; }
    const receipt = {
      generation: childSession.status(true).scope?.runtimeGeneration ?? null,
      target: target ?? null,
      arrivalCount: arrivals,
      denialReasons: denials,
    };
    writeFileSync(receiptFile, JSON.stringify(receipt), "utf8");
    const originKept = target !== null
      && typeof target.originRunId === "string" && target.originRunId.length > 0
      && typeof target.originGeneration === "string" && target.originGeneration.length > 0
      && typeof target.branchRef === "string" && target.branchRef.length > 0;
    process.exitCode = originKept && arrivals === 0 && denials.includes("core.retired-unsettled-limit") ? 0 : 1;
  } catch (error) {
    console.error("child known-origin failed", String(error));
    process.exitCode = 1;
  } finally {
    // Early exceptions must not bypass disposal; a failed retirement is visible
    // in the child's own exit code, not swallowed.
    try {
      await withinOriginDeadline(() => childSession?.retire("child-complete"), true);
    } catch (error) {
      console.error("child known-origin retire failed", String(error));
      process.exitCode = 1;
    }
    if (pending !== 0) process.exitCode = 1;
    writeFileSync(join(root, "child-origin-cleanup.json"), JSON.stringify({ deadline, workDeadline, finishedAt: Date.now(), pending, exitCode: process.exitCode ?? 0 }), "utf8");
  }
} else {
const receiver = {
  capabilities: () => new Set(["host.feedback.steer"]),
  deliver: async request => {
    appendFileSync(accepted, `${request.actionId}\n`, "utf8");
    return { actionId: request.actionId, state: "queued", destinationId: "fixture.primary", evidenceIds: [] };
  },
  reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
};

const session = await EngineSession.start({
  observedSessionId: sessionId,
  branchId: "unresolved",
  agentDir,
  projectConfigDir,
  projectTrusted: true,
  hostVersion: "1.1.0",
  hostMode: "rpc",
  resourcesDir: join(repo, "resources"),
  hostIdleAtStart: true,
  feedbackHost: receiver,
});

const blockingAction = {
  id: "fixture.blocking",
  apiMajor: 1,
  kind: "action",
  effects: ["primary.feedback"],
  optionsSchema: { type: "object", additionalProperties: true },
  requiredCapabilities: [],
  diagnosticCodes: ["fixture.blocking-note"],
  execute: async (admitted, ctx) => {
    writeFileSync(marker, admitted.actionId, "utf8");
    if (mode === "intent") {
      // Intent committed, no observable effect yet: stop here.
      await new Promise(() => {});
    }
    const receipt = await ctx.host.deliver({
      actionId: admitted.actionId,
      scope: admitted.run.scope,
      mode: "steer",
      text: "recovery bounded note",
      allowIdleStart: false,
    }, ctx.signal);
    if (mode === "dispatch") {
      // The receiver accepted; the receipt has not settled yet.
      await new Promise(() => {});
    }
    // Receipt window: the effect returned; keep the process alive for the kill.
    await new Promise(() => {});
    return receipt;
  },
};

const blockingPolicy = {
  id: "fixture.blocking-policy",
  apiMajor: 1,
  kind: "policy",
  optionsSchema: { type: "object", additionalProperties: false },
  requiredCapabilities: [],
  diagnosticCodes: ["fixture.blocking-proposed"],
  decide: () => ({
    outcome: "propose",
    reasonCode: "supported-concern",
    actions: [{
      localId: "blocking-1",
      action: "fixture.blocking",
      options: { delivery: "steer" },
      findingIds: [],
      evidenceIds: [],
      reasonCode: "fixture.blocking-proposed",
    }],
  }),
};

const registered = session.endpoint.register({
  id: "fixture.blocking-package",
  version: "0.1.0",
  baseUri: "fixture:blocking",
  components: [blockingAction, blockingPolicy],
  resources: {},
});
if (!registered.ok) {
  console.error("fixture registration failed", registered.error.code);
  process.exit(65);
}
await registered.value.ready;
await session.reloadConfiguration();

const at = new Date().toISOString();
session.handlePrimaryEvent({ type: "operator-input", text: "recovery fixture work", source: "interactive", occurredAt: at });
session.handlePrimaryEvent({ type: "tool-started", operationId: "rec-1", toolName: "read", parentOperationId: null, occurredAt: at });
session.handlePrimaryEvent({ type: "tool-completed", operationId: "rec-1", toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
setInterval(() => {}, 1_000);
}
