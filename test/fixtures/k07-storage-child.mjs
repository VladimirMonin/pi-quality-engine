// K07 T07 storage child — deliberately isolated real process.
// mode "native-write": captures the owned append handle before any ESM import of
// node:fs/promises, runs a useful paid session, closes that handle and lets the
// next record hit a genuine native write failure.
// mode "gzip": holds the product's validated `.jsonl.gz.tmp` -> `.jsonl.gz`
// promotion after real gzip/round-trip, so the parent can interrupt or release.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const fsp = require("node:fs/promises");
const [root, sessionId, mode = "native-write"] = process.argv.slice(2);
const repo = process.env.QE_K07_REPO;
if (!root || !sessionId || !repo) {
  console.error("usage: root sessionId [native-write|gzip] (QE_K07_REPO)");
  process.exit(64);
}

if (mode === "retention") {
  const evidence = { statCalls: 0, reopenOk: false, archiveSurvived: false, bActive: false };
  const originalStat = fsp.stat;
  let aArchivePath = null;
  let reopened = false;
  let reopenHandle = null;
  fsp.stat = async function patchedStat(path, ...rest) {
    const result = await originalStat.call(this, path, ...rest);
    if (aArchivePath !== null && String(path) === aArchivePath) {
      evidence.statCalls += 1;
      if (evidence.statCalls === 2 && !reopened) {
        reopened = true;
        const { SessionJournal } = await import(pathToFileURL(join(repo, "dist", "journal.js")).href);
        const reopen = await SessionJournal.open({
          directory: join(root, "journal"), observedSessionId: sessionId + "-A", writerGeneration: "gen-A-reopen",
          recordPolicyRevision: "cfg-retention", maxFileBytes: 4096, rotationIntervalMs: null, compressArchives: false,
          retention: { maxArchivesPerSession: 32, maxAgeMs: 86_400_000, maxStorageBytes: 8 * 1024 * 1024 },
          maxPendingRecords: 64, maxPendingBytes: 64 * 1024,
          clock: { nowMonoMs: () => Date.now(), nowUtc: () => new Date().toISOString(), setTimer: () => () => {} },
          emit: () => {},
        });
        evidence.reopenOk = reopen.ok;
        if (reopen.ok) {
          // Keep the reopened owner alive (lock held) while the old sweep finishes.
          reopenHandle = reopen.value;
          reopenHandle.write({ schemaVersion: 1, eventId: "reopen-1", sequence: 0, event: "quality.fixture.storage", observedSessionId: sessionId + "-A", fields: { payload: "reopen" } });
          await reopenHandle.drain();
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
      }
    }
    return result;
  };
  const { SessionJournal } = await import(pathToFileURL(join(repo, "dist", "journal.js")).href);
  const journalRoot = join(root, "journal");
  mkdirSync(journalRoot, { recursive: true });
  const clock = { nowMonoMs: () => Date.now(), nowUtc: () => new Date().toISOString(), setTimer: () => () => {} };
  const record = index => ({ schemaVersion: 1, eventId: `ret-${index}`, sequence: index, event: "quality.fixture.storage", observedSessionId: sessionId, fields: { payload: "retention-" + index + "-" + "é".repeat(16) } });
  let failure = null;
  try {
    const a = await SessionJournal.open({
      directory: journalRoot, observedSessionId: sessionId + "-A", writerGeneration: "gen-A",
      recordPolicyRevision: "cfg-retention", maxFileBytes: 4096, rotationIntervalMs: null, compressArchives: false,
      retention: { maxArchivesPerSession: 32, maxAgeMs: 86_400_000, maxStorageBytes: 8 * 1024 * 1024 },
      maxPendingRecords: 64, maxPendingBytes: 64 * 1024, clock, emit: () => {},
    });
    if (!a.ok) throw new Error("owner A did not open");
    for (let index = 0; index < 3; index += 1) a.value.write(record(index));
    await a.value.drain();
    await a.value.close("A-close");
    const archived = readdirSync(journalRoot).filter(name => name.includes(".p"));
    aArchivePath = archived.length > 0 ? join(journalRoot, archived[0]) : null;
    if (aArchivePath === null) throw new Error("owner A produced no archived segment");
    evidence.aArchive = aArchivePath;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 30));
    const b = await SessionJournal.open({
      directory: journalRoot, observedSessionId: sessionId + "-B", writerGeneration: "gen-B",
      recordPolicyRevision: "cfg-retention", maxFileBytes: 1024, rotationIntervalMs: null, compressArchives: false,
      retention: { maxArchivesPerSession: 32, maxAgeMs: 1, maxStorageBytes: 8 * 1024 * 1024 },
      maxPendingRecords: 64, maxPendingBytes: 64 * 1024, clock, emit: () => {},
    });
    if (!b.ok) throw new Error("owner B did not open");
    for (let index = 0; index < 30; index += 1) b.value.write(record(100 + index));
    await b.value.drain();
    evidence.bActive = readdirSync(journalRoot).some(name => name.endsWith(".jsonl"));
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    await b.value.close("B-close");
    await new Promise(resolvePromise => setTimeout(resolvePromise, 100));
    evidence.archiveSurvived = existsSync(aArchivePath);
    evidence.aLockPresent = readdirSync(journalRoot).some(name => name.endsWith(".lock"));
    if (reopenHandle !== null) {
      await reopenHandle.close("reopen-complete").catch(() => undefined);
      reopenHandle = null;
    }
    writeFileSync(join(root, "retention-evidence.json"), JSON.stringify(evidence), "utf8");
    process.exitCode = evidence.reopenOk && evidence.archiveSurvived && evidence.bActive ? 0 : 1;
  } catch (error) {
    failure = error;
    writeFileSync(join(root, "retention-error.txt"), String(error), "utf8");
    process.exitCode = 1;
  }
} else if (mode === "gzip") {
  const markerPath = join(root, "gzip-marker.json");
  const releasePath = join(root, "gzip-release");
  const originalRename = fsp.rename;
  let heldOnce = false;
  fsp.rename = async function patchedRename(from, to) {
    const fromName = String(from);
    const toName = String(to);
    if (!heldOnce && fromName.endsWith(".jsonl.gz.tmp") && toName.endsWith(".jsonl.gz")) {
      heldOnce = true;
      const rawPath = toName.slice(0, -".gz".length);
      const raw = readFileSync(rawPath);
      const temp = readFileSync(fromName);
      writeFileSync(markerPath, JSON.stringify({
        rawPath, tmpPath: fromName, finalPath: toName,
        rawBytes: raw.length, rawSha256: createHash("sha256").update(raw).digest("hex"),
        tempBytes: temp.length,
      }), "utf8");
      // Hold the real promotion until the parent either releases it or kills us.
      const deadline = Date.now() + 30_000;
      while (!existsSync(releasePath) && Date.now() < deadline) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
      }
    }
    return originalRename.call(this, from, to);
  };
  const { SessionJournal } = await import(pathToFileURL(join(repo, "dist", "journal.js")).href);
  const journalRoot = join(root, "journal");
  mkdirSync(journalRoot, { recursive: true });
  const clock = { nowMonoMs: () => Date.now(), nowUtc: () => new Date().toISOString(), setTimer: () => () => {} };
  const opened = await SessionJournal.open({
    directory: journalRoot,
    observedSessionId: sessionId,
    writerGeneration: "gen-gzip-1",
    recordPolicyRevision: "cfg-gzip-1",
    maxFileBytes: 1024,
    rotationIntervalMs: null,
    compressArchives: true,
    retention: { maxArchivesPerSession: 32, maxAgeMs: 86_400_000, maxStorageBytes: 8 * 1024 * 1024 },
    maxPendingRecords: 64,
    maxPendingBytes: 64 * 1024,
    clock,
    emit: () => {},
  });
  if (!opened.ok) {
    writeFileSync(join(root, "gzip-error.txt"), JSON.stringify(opened.error), "utf8");
    process.exit(1);
  }
  let failure = null;
  try {
    const payload = "gzip-work-" + "é".repeat(20);
    for (let index = 0; index < 40; index += 1) {
      opened.value.write({ schemaVersion: 1, eventId: `gz-${index}`, sequence: index, event: "quality.fixture.storage", observedSessionId: sessionId, fields: { payload: payload + index } });
    }
    await opened.value.drain();
    await opened.value.close("gzip-complete");
    writeFileSync(join(root, "gzip-done.json"), JSON.stringify({ state: opened.value.state, markerHeld: heldOnce }), "utf8");
    process.exitCode = 0;
  } catch (error) {
    failure = error;
    writeFileSync(join(root, "gzip-error.txt"), String(error), "utf8");
    try { await opened.value.close("gzip-failed"); } catch (closeError) { console.error("gzip close failed", String(closeError)); }
    process.exitCode = 1;
  }
} else {
  const captured = [];
  const originalOpen = fsp.open;
  fsp.open = async function patchedOpen(path, ...rest) {
    const handle = await originalOpen.call(this, path, ...rest);
    if (String(path).endsWith(".jsonl")) captured.push({ path: String(path), handle });
    return handle;
  };
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  mkdirSync(join(agentDir, "quality"), { recursive: true });
  mkdirSync(projectConfigDir, { recursive: true });
  const priceA = { currency: "USD", revision: "price-A", inputPerMillion: "0.20", outputPerMillion: "0.80", cacheReadPerMillion: "0.02", cacheWritePerMillion: "0" };
  writeFileSync(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1, enabled: true, mode: "advise",
    runtime: { maxConcurrentEvaluations: 2, maxRetiredUnsettledOperations: 1, restore: "reconcile-only", boundaryWaitMs: 0, defaultRunTimeoutMs: 30_000 },
    modelProfiles: { "route-a": { provider: "fixture-a", model: "a-1", maxAttempts: 1, price: { ...priceA } } },
    permissions: { modelProfiles: ["route-a"] },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { "chat-a": { use: "core.chat", modelProfile: "route-a", options: {} } },
    policies: { record: { use: "core.record-only" } },
    checks: { "route-a": { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-a", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
    observability: {},
  }), "utf8");
  const state = { entered: 0, active: 0 };
  const noFinding = { operational: "completed", coverage: { state: "complete", scopeDescription: "native write witness", issues: [] }, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };
  const port = {
    findChat: (provider) => ({ provider, model: "a-1" }),
    findClassifier: () => null, hasConfiguredAuth: () => true,
    async completeChat(model) {
      state.entered += 1; state.active += 1;
      try {
        return { text: JSON.stringify(noFinding), model: { provider: model?.provider ?? "fixture-a", id: "a-1", revision: null }, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, totalTokens: 110 }, stopReason: "stop", errorCode: null };
      } finally {
        state.active -= 1;
      }
    },
    async classify() { throw new Error("unused"); },
  };
  const { EngineSession } = await import(pathToFileURL(join(repo, "dist", "runtime.js")).href);
  const session = await EngineSession.start({
    observedSessionId: sessionId, branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: join(repo, "resources"), hostIdleAtStart: true,
    modelRegistry: port,
    feedbackHost: {
      capabilities: () => new Set(),
      deliver: async request => ({ actionId: request.actionId, state: "rejected", destinationId: null, evidenceIds: [], error: { code: "core.feedback-unsupported", retryable: false } }),
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
  });
  const settle = async (ms = 25) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  const drive = serial => {
    const at = new Date().toISOString();
    session.handlePrimaryEvent({ type: "operator-input", text: `native write ${serial}`, source: "interactive", occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-started", operationId: `nw-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: `nw-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
  };
  try {
    const ready = Date.now() + 15_000;
    while (session.status(true).checks.active < 1 && Date.now() < ready) await settle();
    drive(1);
    const enteredDeadline = Date.now() + 20_000;
    while (state.entered === 0 && Date.now() < enteredDeadline) await settle();
    if (state.entered < 1) throw new Error("the useful paid positive never reached the provider");
    await settle(200);
    const capturedTarget = captured.find(entry => entry.path.includes(join("quality", "logs")));
    if (capturedTarget === undefined) {
      writeFileSync(join(root, "native-write-captured.txt"), JSON.stringify(captured.map(entry => entry.path)), "utf8");
      throw new Error("the owned append handle was not captured before import");
    }
    const logsDir = join(agentDir, "quality", "logs");
    const beforeSizes = readdirSync(logsDir).map(name => readFileSync(join(logsDir, name)).length);
    await capturedTarget.handle.close();
    drive(2);
    const faultDeadline = Date.now() + 20_000;
    while (state.entered < 2 && Date.now() < faultDeadline) await settle();
    await settle(300);
    const afterSizes = readdirSync(logsDir).map(name => readFileSync(join(logsDir, name)).length);
    const status = session.status(true);
    const evidence = {
      entered: state.entered, active: state.active, capturedPath: capturedTarget.path,
      beforeSizes, afterSizes, journal: status.journal ?? null, health: status.diagnostics?.health ?? null,
      lostRecords: status.journal?.lostRecords ?? null, reasonCode: status.journal?.reasonCode ?? null,
    };
    writeFileSync(join(root, "native-write-evidence.json"), JSON.stringify(evidence), "utf8");
    const grew = afterSizes.some((size, index) => size > (beforeSizes[index] ?? 0));
    const degraded = JSON.stringify(evidence.journal ?? {}).includes("degrad")
      || JSON.stringify(evidence.health ?? {}).includes("degrad")
      || JSON.stringify(evidence.journal ?? {}).includes("failed")
      || (evidence.lostRecords ?? 0) > 0
      || (evidence.reasonCode ?? null) !== null;
    await session.retire("child-complete");
    process.exitCode = state.entered >= 2 && !grew && degraded ? 0 : 1;
  } catch (error) {
    writeFileSync(join(root, "native-write-error.txt"), String(error), "utf8");
    try { await session.retire("child-failed"); } catch (retireError) { console.error("child retire failed", String(retireError)); }
    process.exitCode = 1;
  }
}
