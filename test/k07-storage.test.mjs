// K07 S3 storage family — first executed slice (T05 threshold/interval accounting,
// T06 damaged-tail preservation across resume). Real SessionJournal physical files
// under an owned disposable root; no provider/SDK/shell compression/test modes.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { SessionJournal } from "../dist/journal.js";
import { EngineSession } from "../dist/runtime.js";

const NL = String.fromCharCode(10);
const RESOURCES_DIR = join(process.cwd(), "resources");
const gunzipAsync = promisify(gunzip);

class ControlledClock {
  #mono = 1_000;
  #timers = [];
  nowMonoMs() { return this.#mono; }
  nowUtc() { return new Date(this.#mono).toISOString(); }
  setTimer(delayMs, callback) {
    const entry = { at: this.#mono + Math.max(0, delayMs), callback, cancelled: false };
    this.#timers.push(entry);
    return () => { entry.cancelled = true; };
  }
  advance(ms) {
    const target = this.#mono + ms;
    for (;;) {
      const due = this.#timers.filter(timer => !timer.cancelled && timer.at <= target).sort((left, right) => left.at - right.at)[0];
      if (due === undefined) break;
      due.cancelled = true;
      this.#mono = due.at;
      due.callback();
    }
    this.#mono = target;
  }
}

const retention = { maxStorageBytes: 8 * 1024 * 1024, maxAgeMs: 24 * 60 * 60 * 1_000, maxArchivesPerSession: 32 };

async function openJournal(directory, clock, overrides = {}) {
  const events = [];
  const opened = await SessionJournal.open({
    directory,
    observedSessionId: "sess-k07-storage",
    writerGeneration: "gen-storage-1",
    recordPolicyRevision: "cfg-storage-1",
    maxFileBytes: 320,
    rotationIntervalMs: 50,
    compressArchives: false,
    retention,
    maxPendingRecords: 64,
    maxPendingBytes: 64 * 1024,
    clock,
    emit: (kind, data) => { events.push({ kind, data }); },
    ...overrides,
  });
  assert.equal(opened.ok, true, "the physical journal opens under the owned root");
  return { journal: opened.value, events };
}

const journalFiles = async directory => (await readdir(directory)).filter(name => name.endsWith(".jsonl") || name.includes(".jsonl.")).sort();

let sequence = 0;
function record(payload) {
  sequence += 1;
  return {
    schemaVersion: 1,
    eventId: `evt-storage-${sequence}`,
    sequence,
    event: "quality.fixture.storage",
    observedSessionId: "sess-k07-storage",
    fields: { payload },
  };
}

// Original T06/B.13 maintenance boundary: a real Windows reader denies native
// deletion. No injected errno, fake success or held-attempt safeguard.
for (const combined of [false, true]) for (const fault of [false, true]) {
  test(`K07-T06-storage-retention-bounded: ${combined ? "age/count/storage" : "count"} ${fault ? "locked archive" : "healthy deletion"}`, { timeout: 20_000, skip: fault && process.platform !== "win32" }, async () => {
    const root = await mkdtemp(join(tmpdir(), "qe-k07-retention-bounded-"));
    const deadline = Date.now() + 15_000;
    const evidence = { root, combined, fault, events: [], errors: [], attemptsByPass: {}, cleanup: [] };
    const digest = bytes => createHash("sha256").update(bytes).digest("hex");
    let utc = 1_000, completedPasses = 0, attempts = 0, child = null, childClose = null, ready = null;
    let childOut = "", childErr = "", stdoutEnd = false, stderrEnd = false, childExit = null;
    let archive = null, archiveBytes = null, journal = null, failure = null;
    const originalUnlink = fs.unlink;
    const bounded = async (promise, label) => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`retention deadline: ${label}`)), Math.max(0, deadline - Date.now())); })]); }
      finally { clearTimeout(timer); }
    };
    const until = async (read, accepts, label) => {
      for (;;) {
        const value = await bounded(read(), label);
        if (accepts(value)) return value;
        await bounded(new Promise(resolvePromise => setTimeout(resolvePromise, 5)), label);
      }
    };
    fs.unlink = async function(path, ...args) {
      if (typeof path === "string" && path.startsWith(root + "/") || typeof path === "string" && path.startsWith(root + "\\")) {
        if (/\.p\d+\.jsonl$/u.test(path)) {
          attempts += 1;
          evidence.attemptsByPass[completedPasses] = (evidence.attemptsByPass[completedPasses] ?? 0) + 1;
          if (archive === null) {
            archive = path;
            archiveBytes = await readFile(path);
            if (fault) {
              child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", join(process.cwd(), "test", "fixtures", "k07-retention", "lock-file.ps1"), archive], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
              ready = new Promise((resolvePromise, reject) => {
                child.once("error", reject);
                child.stdout.on("data", bytes => { childOut = (childOut + String(bytes)).slice(-2048); if (childOut.includes("READY")) resolvePromise(); });
                child.once("close", (code, signal) => { if (!childOut.includes("READY")) reject(new Error(`reader closed before READY (${code}/${signal})`)); });
              });
              child.stderr.on("data", bytes => { childErr = (childErr + String(bytes)).slice(-2048); });
              child.stdin.on("error", error => { evidence.stdinError = error.code; });
              child.stdout.once("end", () => { stdoutEnd = true; });
              child.stderr.once("end", () => { stderrEnd = true; });
              child.once("exit", (code, signal) => { childExit = { code, signal }; });
              childClose = new Promise((resolvePromise, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolvePromise({ code, signal })); });
              await bounded(ready, "real archive reader ready");
            }
          }
          try { return await Reflect.apply(originalUnlink, this, [path, ...args]); }
          catch (error) {
            if (evidence.errors.length < 8) evidence.errors.push({ code: error.code, errno: error.errno, syscall: error.syscall });
            throw error;
          }
        }
      }
      return Reflect.apply(originalUnlink, this, [path, ...args]);
    };
    syncBuiltinESMExports();
    try {
      const opened = await SessionJournal.open({
        directory: root, observedSessionId: "sess-k07-storage", writerGeneration: "gen-retention-bounded", recordPolicyRevision: "cfg-retention-bounded",
        maxFileBytes: 4096, rotationIntervalMs: null, compressArchives: false,
        retention: { maxArchivesPerSession: 0, maxAgeMs: combined ? 0 : 86_400_000, maxStorageBytes: combined ? 4096 : 8_388_608 },
        maxPendingRecords: 256, maxPendingBytes: 1_048_576, closeTimeoutMs: 2000,
        clock: { nowMonoMs: () => performance.now(), nowUtc: () => new Date(utc++).toISOString(), setTimer: (ms, callback) => { const timer = setTimeout(callback, ms); return () => clearTimeout(timer); } },
        emit: (kind, data) => { evidence.events.push({ kind, data }); if (kind === "retention") completedPasses += 1; },
      });
      assert.equal(opened.ok, true);
      journal = opened.value;
      journal.write(record("x".repeat(4500)));
      await until(async () => fault ? evidence.errors.length : attempts, value => value > 0, "actual native archive deletion boundary");
      evidence.firstClose = await bounded(journal.close("retention-bounded-case"), "physical journal close with reader still held");
      evidence.attemptsBeforeReaderRelease = attempts;
      evidence.statusBeforeReaderRelease = journal.status;
      evidence.filesBeforeReaderRelease = await readdir(root);
      const indexName = evidence.filesBeforeReaderRelease.find(name => name.endsWith(".journal-index.json"));
      evidence.indexBeforeReaderRelease = JSON.parse(await readFile(join(root, indexName), "utf8"));
      assert.equal(evidence.firstClose.flushState, "written", "nonfatal retention failure cannot prevent actual destination close");
      assert.equal(journal.state, "closed");
      assert.equal(evidence.filesBeforeReaderRelease.some(name => name.endsWith(".lock")), false, "writer ownership is physically released before fixture obstruction ends");
      assert.equal(Object.values(evidence.attemptsByPass).every(count => count === 1), true, "age/count/storage never retry the same archive in one completed maintenance pass");
      if (fault) {
        assert.equal(childExit, null, "real reader is still holding the archive at physical journal close");
        assert.equal(digest(await readFile(archive)), digest(archiveBytes), "undeletable archive remains byte-identical");
        assert.equal(evidence.indexBeforeReaderRelease.segments.some(segment => segment.bytes === archiveBytes.length && segment.recordCount === 1), true, "failed cleanup retains truthful archive/index facts");
        assert.equal(journal.status.historyCoverage, "partial");
        const sweeps = evidence.events.filter(event => event.kind === "retention");
        assert.equal(sweeps.at(-1).data.historyCoverage, "partial");
        assert.equal(sweeps.every(event => event.data.removedFiles === 0), true, "no failed unlink is counted as deletion");
        evidence.preservedArchive = { bytes: archiveBytes.length, sha256: digest(archiveBytes) };
      } else {
        assert.equal(evidence.errors.length, 0);
        assert.equal(existsSync(archive), false, "healthy retention actually removes the closed archive");
        assert.equal(evidence.indexBeforeReaderRelease.segments.length, 0);
        assert.equal(evidence.events.some(event => event.kind === "retention" && event.data.removedFiles === 1 && event.data.removedBytes === archiveBytes.length), true);
      }
    } catch (error) { failure = error; evidence.failure = { name: error.name, message: error.message }; }
    finally {
      const errors = [];
      const cleanup = async (label, action) => {
        try { await bounded(action(), label); evidence.cleanup.push({ label, returned: true }); }
        catch (error) { errors.push(error); evidence.cleanup.push({ label, returned: false, message: error.message }); }
      };
      if (child !== null) await cleanup("reader native exit/close and pipes", async () => {
        child.stdin.end("\n");
        const closed = await childClose;
        assert.deepEqual(closed, { code: 0, signal: null });
        assert.deepEqual(childExit, closed);
        assert.equal(stdoutEnd && stderrEnd, true);
      });
      if (journal !== null) await cleanup("final journal close and actual lock release", async () => {
        await journal.close("retention-bounded-cleanup");
        await until(() => readdir(root), names => !names.some(name => name.endsWith(".lock")), "final writer lock release");
      });
      fs.unlink = originalUnlink;
      syncBuiltinESMExports();
      evidence.reader = { childExit, stdoutEnd, stderrEnd, stdout: childOut, stderr: childErr };
      evidence.attemptsAfterCleanup = attempts;
      evidence.finalStatus = journal?.status ?? null;
      evidence.finalFiles = await readdir(root);
      evidence.result = failure === null && errors.length === 0 ? "AUTHOR_PASS" : "FAIL";
      const out = process.env.QE_EVIDENCE_DIR ?? root;
      await mkdir(out, { recursive: true });
      await writeFile(join(out, `retention-bounded-${combined ? "combined" : "count"}-${fault ? "locked" : "healthy"}.json`), JSON.stringify(evidence, null, 2), "utf8");
      if (errors.length > 0) failure = new AggregateError(failure === null ? errors : [failure, ...errors], "retention case/cleanup failures");
    }
    if (failure !== null) throw failure;
  });
}

test("K07-T05-storage: UTF-8/LF threshold accounting rotates at the edge and the interval resynchronizes once", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-storage-t05-"));
  const clock = new ControlledClock();
  const { journal, events } = await openJournal(root, clock);
  const assertClosedFiles = async () => {
    const closed = events.filter(event => event.kind === "closed");
    assert.equal(closed.some(event => event.data.closeReason === "size" && event.data.recordCount > 0), true, "a nonempty size-rotated segment is observed");
    for (const event of closed) {
      const key = event.data.logicalJournalId.slice("journal-".length);
      const path = join(root, `${key}.p${String(event.data.segmentOrdinal).padStart(8, "0")}.jsonl`);
      const raw = await readFile(path);
      const records = raw.toString("utf8").split(NL).filter(Boolean).map(line => JSON.parse(line));
      assert.equal(event.data.recordCount, records.length, "closed count equals independently parsed physical records");
      assert.equal(event.data.serializedBytes, raw.length, "closed bytes equal the actual UTF-8/LF archive");
    }
  };
  try {
    const payload = "é".repeat(24); // multi-byte UTF-8, deterministic physical size
    for (let index = 0; index < 6; index += 1) journal.write(record(payload));
    await journal.drain();
    const files = await journalFiles(root);
    assert.equal(files.length >= 1, true, "the owner exposes physical segments after the writes");
    const lines = [];
    let physical = 0;
    for (const name of files) {
      const raw = await readFile(join(root, name), "utf8");
      physical += Buffer.byteLength(raw, "utf8");
      for (const line of raw.split(NL).filter(Boolean)) {
        assert.equal(JSON.parse(line).observedSessionId === "sess-k07-storage", true, "every physical line is an intact owned record");
        lines.push(line);
      }
    }
    const expected = lines.reduce((sum, line) => sum + Buffer.byteLength(line, "utf8") + 1, 0);
    assert.equal(physical, expected, "physical bytes equal the LF-inclusive serialized record bytes");
    assert.equal(lines.length, 6, "all six records are physically present across segments");
    assert.equal(journal.status.lostRecords, 0, "no record is lost at the threshold edge");
    assert.equal(journal.status.activeSegment >= 2, true, `the size threshold rotated the segment (active ${journal.status.activeSegment})`);
    assert.equal(journal.status.lastRotation?.reason, "size", "the rotation reason is the size threshold");
    await assertClosedFiles();
    const rotationsBefore = events.filter(event => event.kind === "rotation").length;
    const segmentBefore = journal.status.activeSegment;
    clock.advance(60);
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
    await journal.drain();
    const rotationsAfter = events.filter(event => event.kind === "rotation").length;
    assert.equal(rotationsAfter - rotationsBefore, 1, "the elapsed interval produces exactly one resynchronizing rotation");
    assert.equal(journal.status.activeSegment, segmentBefore + 1, "the elapsed rotation advances the active segment once");
    await assertClosedFiles();
    assert.equal(journal.state === "healthy" || journal.state === "degraded", true, "the journal stays usable after both rotations");
  } finally {
    await journal.close("fixture-complete").catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("K07-T06-storage: a damaged tail and intact records survive graceful close and resume", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-storage-t06-"));
  const clock = new ControlledClock();
  const first = await openJournal(root, clock, { rotationIntervalMs: null });
  const intact = [];
  const damaged = "{\"partial\":true,\"payload\":\"truncated-tail";
  try {
    for (let index = 0; index < 3; index += 1) {
      const entry = record("intact-" + index);
      intact.push(entry);
      first.journal.write(entry);
    }
    await first.journal.drain();
    // Deliberately damage the physical tail while the owner still holds the file.
    const active = (await readdir(root)).find(name => name.endsWith(".jsonl") && !name.includes(".p"));
    assert.ok(active, "the owner exposes its open physical segment before close");
    const activePath = join(root, active);
    const before = await readFile(activePath, "utf8");
    await writeFile(activePath, before + damaged, "utf8");
    assert.equal((await readFile(activePath, "utf8")).endsWith(damaged), true, "the damaged tail is physically present before close");
  } finally {
    await first.journal.close("fixture-close").catch(() => undefined);
  }
  // Locate the closed physical destination under the owner's actual close semantics
  // (plain rotated segment or gzip archive) and read it back without guessing.
  const files = (await readdir(root)).filter(name => name.includes(".jsonl") || name.includes(".jsonl."));
  assert.equal(files.length >= 1, true, `close retained a physical destination (${files.join(",") || "none"})`);
  const readDestination = async name => {
    const raw = await readFile(join(root, name));
    if (name.endsWith(".gz")) return (await gunzipAsync(raw)).toString("utf8");
    return raw.toString("utf8");
  };
  let preserved = false;
  let intactCount = 0;
  for (const name of files) {
    const text = await readDestination(name);
    if (text.includes(damaged)) preserved = true;
    const lines = text.split(NL).filter(Boolean);
    for (const line of lines) {
      try { if (JSON.parse(line).observedSessionId === "sess-k07-storage") intactCount += 1; } catch { /* damaged tail stays unparsable */ }
    }
  }
  assert.equal(preserved, true, "the damaged tail survives the owner's graceful close");
  assert.equal(intactCount >= 3, true, `intact records survive beside the damaged tail (${intactCount})`);
  // Real reopen/owner change: a new owner instance writes again without erasing history.
  const second = await openJournal(root, clock);
  try {
    second.journal.write(record("after-resume"));
    await second.journal.drain();
  } finally {
    await second.journal.close("fixture-complete").catch(() => undefined);
  }
  const after = (await readdir(root)).filter(name => name.includes(".jsonl") || name.includes(".jsonl."));
  let stillPreserved = false;
  for (const name of after) {
    const text = await readDestination(name);
    if (text.includes(damaged)) stillPreserved = true;
  }
  assert.equal(stillPreserved, true, "the damaged tail is not erased by the reopening owner");
  await rm(root, { recursive: true, force: true });
});

// K07-T08 / B.12: the real control-checkpoint commit is obstructed at the owned
// canonical path immediately before a new paid intent. The before-dispatch
// refusal must be visible, the provider must not advance, and ordinary primary
// work must keep progressing while new dependent admissions are suppressed.
test("K07-T08-storage: a control-checkpoint failure before dispatch refuses the paid intent", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-t08-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-t08-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  const priceA = { currency: "USD", revision: "price-A", inputPerMillion: "0.20", outputPerMillion: "0.80", cacheReadPerMillion: "0.02", cacheWritePerMillion: "0" };
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
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
  const state = { entered: 0, returned: 0, active: 0 };
  const noFinding = { operational: "completed", coverage: { state: "complete", scopeDescription: "t08 witness", issues: [] }, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };
  const port = {
    findChat: (provider) => ({ provider, model: "a-1" }),
    findClassifier: () => null, hasConfiguredAuth: () => true,
    async completeChat(model) {
      state.entered += 1; state.active += 1;
      try {
        return { text: JSON.stringify(noFinding), model: { provider: model?.provider ?? "fixture-a", id: "a-1", revision: null }, usage: { input: 100, cacheRead: 0, cacheWrite: 0, output: 10, totalTokens: 110 }, stopReason: "stop", errorCode: null };
      } finally {
        state.active -= 1; state.returned += 1;
      }
    },
    async classify() { throw new Error("unused"); },
  };
  const session = await EngineSession.start({ observedSessionId: sessionId, branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true, hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true, modelRegistry: port });
  const settle = async (ms = 25) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  const journal = async () => {
    let text = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl") || name.includes(".jsonl.")) text += await readFile(join(agentDir, "quality", "logs", name), "utf8").catch(() => "");
    }
    return text;
  };
  const checkpointRows = async () => {
    for (const name of await readdir(join(agentDir, "quality", "state")).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      const text = await readFile(join(agentDir, "quality", "state", name), "utf8").catch(() => "");
      try {
        const parsed = JSON.parse(text);
        if (parsed?.observedSessionId === sessionId && parsed?.financial?.attempts !== undefined) return parsed.financial.attempts;
      } catch { /* obstruction directory has no body */ }
    }
    return null;
  };
  const drive = serial => {
    const at = new Date().toISOString();
    session.handlePrimaryEvent({ type: "operator-input", text: `t08 work ${serial}`, source: "interactive", occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-started", operationId: `t08-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: `t08-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
  };
  let firstFailure = null;
  try {
    const ready = Date.now() + 15_000;
    while (session.status(true).checks.active < 1 && Date.now() < ready) await settle();
    drive(1);
    const enteredDeadline = Date.now() + 20_000;
    while (state.entered === 0 && Date.now() < enteredDeadline) await settle();
    assert.equal(state.entered, 1, "the fitting positive really reaches the scripted provider once");
    const settledDeadline = Date.now() + 20_000;
    let settledRow = null;
    while (settledRow === null && Date.now() < settledDeadline) {
      const rows = await checkpointRows();
      settledRow = rows?.find(entry => entry.state === "settled" && entry.usageRevision >= 1) ?? null;
      if (settledRow === null) await settle();
    }
    assert.ok(settledRow, "the positive settles with a real financial row");
    assert.equal(settledRow.costAmount, "0.000028", "the positive is charged at price A");
    const baselineEntered = state.entered;
    const stateDir = join(agentDir, "quality", "state");
    const canonicalName = (await readdir(stateDir)).find(name => name.endsWith(".json"));
    assert.ok(canonicalName, "the owned canonical checkpoint file is discoverable");
    const canonicalPath = join(stateDir, canonicalName);
    const backupPath = join(root, "checkpoint-backup.json");
    await rename(canonicalPath, backupPath);
    await mkdir(canonicalPath);
    // The next paid intent's real commit cannot rename over the directory.
    drive(2);
    const refusalDeadline = Date.now() + 20_000;
    let refused = false;
    while (!refused && Date.now() < refusalDeadline) {
      refused = (await journal()).includes("core.financial-intent-unsafe");
      if (!refused) await settle();
    }
    assert.equal(refused, true, "the paid intent is refused before transport by the failed commit");
    assert.equal(state.entered, baselineEntered, "the before-dispatch refusal makes no provider entry");
    assert.equal(state.active, 0, "no provider call stays active after the refusal");
    const degradedDeadline = Date.now() + 20_000;
    drive(3);
    let degraded = false;
    while (!degraded && Date.now() < degradedDeadline) {
      const text = await journal();
      degraded = text.includes("core.control-degraded") || text.includes("core.control-checkpoint-commit-failed");
      if (!degraded) await settle();
    }
    assert.equal(degraded, true, "control degradation is visible to subsequent dependent work");
    assert.equal(state.entered, baselineEntered, "primary progress does not create extra paid entries");
  } catch (error) {
    firstFailure = error;
    throw error;
  } finally {
    try { await session.retire("fixture-complete"); }
    catch (error) { console.error("K07-T08-CLEANUP", String(error)); }
    if (firstFailure === null && state.active === 0) await rm(root, { recursive: true, force: true });
    else console.error("K07-T08-SCRATCH", root);
  }
});

// K07-T08 / B.12 (effect counterpart): a genuinely queued feedback action whose
// real control-checkpoint commit fails must be refused at the before-execute
// boundary (core.action-intent-unsafe) with zero receiver deliveries, while the
// earlier paid spend and ordinary primary work stay intact.
test("K07-T08-storage-effect: a failed action-intent checkpoint refuses the feedback effect", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-t08e-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-t08e-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  const priceA = { currency: "USD", revision: "price-A", inputPerMillion: "0.20", outputPerMillion: "0.80", cacheReadPerMillion: "0.02", cacheWritePerMillion: "0" };
  const configFor = (supportedEnabled) => ({
    schemaVersion: 1, enabled: true, mode: "advise",
    runtime: { maxConcurrentEvaluations: 2, maxRetiredUnsettledOperations: 1, restore: "reconcile-only", boundaryWaitMs: 0, defaultRunTimeoutMs: 30_000 },
    modelProfiles: { "route-a": { provider: "fixture-a", model: "a-1", maxAttempts: 1, price: { ...priceA } } },
    permissions: { modelProfiles: ["route-a"], actions: ["core.feedback"], maxFeedbackBytes: 2048 },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { "chat-a": { use: "core.chat", modelProfile: "route-a", options: {} }, supported: { use: "fixture.supported", options: {} } },
    policies: { record: { use: "core.record-only" }, engineering: { use: "core.engineering", options: {} } },
    checks: {
      "route-a": { enabled: !supportedEnabled, triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-a", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] },
      supported: { enabled: supportedEnabled, triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "supported", policy: "engineering", cooldownMs: 0, criteria: ["efficiency.repetition"] },
    },
    observability: {},
  });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configFor(false)), "utf8");
  const state = { entered: 0, active: 0 };
  const delivered = [];
  const noFinding = { operational: "completed", coverage: { state: "complete", scopeDescription: "t08e footing", issues: [] }, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };
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
  let releaseEvaluation = null;
  const evaluationGate = new Promise(resolvePromise => { releaseEvaluation = resolvePromise; });
  let evaluationEntered = 0;
  const session = await EngineSession.start({
    observedSessionId: sessionId, branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
    modelRegistry: port,
    feedbackHost: {
      capabilities: () => new Set(["host.feedback.steer"]),
      deliver: async request => { delivered.push(request.actionId); return { actionId: request.actionId, state: "queued", destinationId: "fixture.primary", evidenceIds: [] }; },
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
  });
  const settle = async (ms = 25) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  const journal = async () => {
    let text = "";
    for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
      if (name.endsWith(".jsonl") || name.includes(".jsonl.")) text += await readFile(join(agentDir, "quality", "logs", name), "utf8").catch(() => "");
    }
    return text;
  };
  const checkpointRows = async () => {
    for (const name of await readdir(join(agentDir, "quality", "state")).catch(() => [])) {
      if (!name.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(await readFile(join(agentDir, "quality", "state", name), "utf8"));
        if (parsed?.observedSessionId === sessionId && parsed?.financial?.attempts !== undefined) return parsed.financial.attempts;
      } catch { /* obstruction directory has no body */ }
    }
    return null;
  };
  const drive = serial => {
    const at = new Date().toISOString();
    session.handlePrimaryEvent({ type: "operator-input", text: `t08e work ${serial}`, source: "interactive", occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-started", operationId: `t08e-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: `t08e-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
  };
  let firstFailure = null;
  try {
    const ready = Date.now() + 15_000;
    while (session.status(true).checks.active < 1 && Date.now() < ready) await settle();
    drive(1);
    const enteredDeadline = Date.now() + 20_000;
    while (state.entered === 0 && Date.now() < enteredDeadline) await settle();
    assert.equal(state.entered, 1, "the paid record-only footing really reaches the provider once");
    const settledDeadline = Date.now() + 20_000;
    let settledRow = null;
    while (settledRow === null && Date.now() < settledDeadline) {
      const rows = await checkpointRows();
      settledRow = rows?.find(entry => entry.state === "settled" && entry.usageRevision >= 1) ?? null;
      if (settledRow === null) await settle();
    }
    assert.ok(settledRow, "the footing settles with a real financial row");
    assert.equal(settledRow.costAmount, "0.000028", "the footing keeps its price-A charge");
    const footingAttemptId = settledRow.attemptId;
    // Accepted reload: the supported-finding check replaces the paid one, grants kept.
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify(configFor(true)), "utf8");
    assert.equal((await session.reloadConfiguration()).ok, true, "the supported-finding configuration reload is accepted");
    await settle(200);
    // Register the deterministic supported evaluator (real registered component).
    const registered = session.endpoint.register({ id: "fixture.k07-t08e", version: "0.1.0", baseUri: "fixture:t08e", resources: {}, components: [{
      id: "fixture.supported", apiMajor: 1, kind: "evaluator", mechanism: "deterministic", accepts: ["json"],
      optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: ["fixture.supported"],
      evaluate: async (_options, input) => {
        evaluationEntered += 1;
        await evaluationGate;
        const item = input.context.items.find(entry => entry.provenance.sourceId === "core.history") ?? input.context.items[0];
        assert.ok(item, "the supported finding cites real assembled evidence");
        return {
          operational: "completed", coverage: input.context.coverage, conclusion: "findings",
          findings: [{
            id: `${input.run.runId}:finding-1`, criterion: "efficiency.repetition", status: "supported", severity: "concern",
            requirementRefs: [], evidenceIds: [item.id], affectedItems: [], defectCode: "fixture.supported-t08e",
            explanation: "supported finding for the effect-intent witness", proposedCorrection: null, limitations: [],
          }],
          scores: [], additionalEvidence: [], dependencies: input.context.dependencies, usageAttemptIds: [],
        };
      },
    }] });
    assert.equal(registered.ok, true, "the supported evaluator package registers");
    if (registered.ok) assert.equal((await registered.value.ready).ok, true, "the supported evaluator package is ready");
    assert.equal((await session.reloadConfiguration()).ok, true, "the evaluator activation reload is accepted");
    await settle(200);
    drive(2);
    const evalDeadline = Date.now() + 20_000;
    while (evaluationEntered === 0 && Date.now() < evalDeadline) await settle();
    assert.equal(evaluationEntered, 1, "the supported evaluation really enters and is held");
    // Obstruct the owned canonical checkpoint while the evaluation is held.
    const stateDir = join(agentDir, "quality", "state");
    const canonicalName = (await readdir(stateDir)).find(name => name.endsWith(".json"));
    assert.ok(canonicalName, "the owned canonical checkpoint file is discoverable");
    const canonicalPath = join(stateDir, canonicalName);
    await rename(canonicalPath, join(root, "checkpoint-backup.json"));
    await mkdir(canonicalPath);
    releaseEvaluation();
    const refusalDeadline = Date.now() + 20_000;
    let refused = false;
    while (!refused && Date.now() < refusalDeadline) {
      refused = (await journal()).includes("core.action-intent-unsafe");
      if (!refused) await settle();
    }
    assert.equal(refused, true, "the queued feedback intent is refused before execute by the failed commit");
    assert.equal(delivered.length, 0, "no receiver delivery occurs for the refused action intent");
    const rowsAfter = await checkpointRows();
    assert.equal(rowsAfter?.find(entry => entry.attemptId === footingAttemptId)?.costAmount ?? null, null, "the canonical checkpoint is obstructed (no fresh readable row)");
    const preserved = JSON.parse(await readFile(join(root, "checkpoint-backup.json"), "utf8"));
    const footing = preserved.financial.attempts.find(entry => entry.attemptId === footingAttemptId);
    assert.equal(footing.costAmount, "0.000028", "the prior paid charge is preserved in the protected backup");
    drive(3);
    await settle(500);
    assert.equal(state.entered, 1, "independent primary progress does not create another provider entry");
  } catch (error) {
    firstFailure = error;
    throw error;
  } finally {
    releaseEvaluation();
    try { await session.retire("fixture-complete"); }
    catch (error) { console.error("K07-T08E-CLEANUP", String(error)); }
    if (firstFailure === null && state.active === 0) await rm(root, { recursive: true, force: true });
    else console.error("K07-T08E-SCRATCH", root);
  }
});

// K07-T06 / B.08, B.13 (separately selectable): an honestly labelled fresh
// synthetic disk seed of a damaged active tail is quarantined on open, the old
// bytes are retained, and the new active segment stays valid.
test("K07-T06-storage-quarantine: a damaged active tail is quarantined on open", { timeout: 90_000 }, async () => {
  const seedRoot = await mkdtemp(join(tmpdir(), "qe-k07-t06q-seed-"));
  const clock = new ControlledClock();
  let activeName = null;
  let activeBytes = "";
  const seed = await openJournal(seedRoot, clock, { rotationIntervalMs: null });
  try {
    for (let index = 0; index < 2; index += 1) seed.journal.write(record("authentic-" + index));
    await seed.journal.drain();
    activeName = (await readdir(seedRoot)).find(name => name.endsWith(".jsonl"));
    assert.ok(activeName, "the owner exposes the seed's active basename");
    activeBytes = await readFile(join(seedRoot, activeName), "utf8");
  } finally {
    await seed.journal.close("seed-complete").catch(() => undefined);
  }
  const target = await mkdtemp(join(tmpdir(), "qe-k07-t06q-target-"));
  const damaged = "{\"partial\":true,\"payload\":\"truncated-active-tail";
  const seeded = activeBytes + damaged;
  // Honestly labelled synthetic seed: no lock or index is copied; the damaged
  // active tail is the exact condition being recovered.
  await writeFile(join(target, activeName), seeded, "utf8");
  const opened = await openJournal(target, clock, { rotationIntervalMs: null });
  try {
    const openedEvent = opened.events.find(event => event.kind === "opened");
    assert.ok(openedEvent, "the opening lifecycle record is emitted");
    assert.equal(openedEvent.data.previousTailState, "damaged", "the previous active tail is classified as damaged");
    assert.equal(openedEvent.data.openReason, "tail-repair", "the open reason is the actual tail repair");
    const files = await readdir(target);
    let quarantined = false;
    for (const name of files) {
      if (name === activeName || name.endsWith(".journal-index.json") || name.endsWith(".lock")) continue;
      const text = await readFile(join(target, name), "utf8").catch(() => "");
      if (text.includes(damaged)) quarantined = true;
    }
    assert.equal(quarantined, true, "the damaged bytes are quarantined intact");
    opened.journal.write(record("after-quarantine"));
    await opened.journal.drain();
    const activeNow = await readFile(join(target, files.includes(activeName) ? activeName : (await readdir(target)).find(name => name.endsWith(".jsonl"))), "utf8").catch(() => "");
    const lastLine = activeNow.split(NL).filter(Boolean).pop() ?? "";
    assert.equal(JSON.parse(lastLine).observedSessionId, "sess-k07-storage", "the new active segment carries a valid record");
  } finally {
    await opened.journal.close("quarantine-complete").catch(() => undefined);
    await rm(target, { recursive: true, force: true });
    await rm(seedRoot, { recursive: true, force: true });
  }
});

// K07-T07 / B.10-B.11 (held contributed sink): a READY public C1 sink whose
// write() returns genuinely held Promises keeps bounded outstanding work while
// ordinary primary work continues; release drains every actual write once.
test("K07-T07-storage-held-sink: held contributed writes stay bounded and drain truthfully", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-held-sink-"));
  const agentDir = join(root, "agent");
  const projectConfigDir = join(root, "project", ".pi");
  const sessionId = `sess-k07-held-${process.pid}-${Date.now()}`;
  await mkdir(join(agentDir, "quality"), { recursive: true });
  await mkdir(projectConfigDir, { recursive: true });
  const priceA = { currency: "USD", revision: "price-A", inputPerMillion: "0.20", outputPerMillion: "0.80", cacheReadPerMillion: "0.02", cacheWritePerMillion: "0" };
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1, enabled: true, mode: "advise",
    runtime: { maxConcurrentEvaluations: 2, maxRetiredUnsettledOperations: 1, restore: "reconcile-only", boundaryWaitMs: 0, defaultRunTimeoutMs: 30_000 },
    modelProfiles: { "route-a": { provider: "fixture-a", model: "a-1", maxAttempts: 1, price: { ...priceA } } },
    permissions: { modelProfiles: ["route-a"] },
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { work: { providers: [{ id: "history", use: "core.history", options: { limit: 12 } }], maxEstimatedTokens: 8000 } },
    evaluators: { "chat-a": { use: "core.chat", modelProfile: "route-a", options: {} } },
    policies: { record: { use: "core.record-only" } },
    checks: { "route-a": { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "chat-a", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"] } },
    observability: { sinks: [{ id: "fixture.storage-held", options: {} }] },
  }), "utf8");
  const state = { entered: 0, active: 0 };
  const noFinding = { operational: "completed", coverage: { state: "complete", scopeDescription: "held sink witness", issues: [] }, conclusion: "no-supported-finding", findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [] };
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
  const session = await EngineSession.start({
    observedSessionId: sessionId, branchId: "unresolved", agentDir, projectConfigDir, projectTrusted: true,
    hostVersion: "1.1.0", hostMode: "rpc", resourcesDir: RESOURCES_DIR, hostIdleAtStart: true,
    modelRegistry: port,
    feedbackHost: {
      capabilities: () => new Set(),
      deliver: async request => ({ actionId: request.actionId, state: "rejected", destinationId: null, evidenceIds: [], error: { code: "core.feedback-unsupported", retryable: false } }),
      reconcile: async actionId => ({ actionId, state: "unknown", destinationId: null, evidenceIds: [] }),
    },
  });
  const settle = async (ms = 25) => { await new Promise(resolvePromise => setTimeout(resolvePromise, ms)); };
  const writeIds = [];
  const heldWrites = [];
  let disposed = 0;
  const sink = {
    id: "fixture.storage-held", apiMajor: 1, kind: "sink",
    optionsSchema: { type: "object", additionalProperties: false }, requiredCapabilities: [], diagnosticCodes: [],
    create: async () => ({
      write: record => {
        writeIds.push(String(record?.eventId ?? record?.event ?? "record"));
        return new Promise(resolvePromise => { heldWrites.push(resolvePromise); });
      },
      dispose: async () => { disposed += 1; },
    }),
  };
  const drive = serial => {
    const at = new Date().toISOString();
    session.handlePrimaryEvent({ type: "operator-input", text: `held work ${serial}`, source: "interactive", occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-started", operationId: `hs-${serial}`, toolName: "read", parentOperationId: null, occurredAt: at });
    session.handlePrimaryEvent({ type: "tool-completed", operationId: `hs-${serial}`, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: at });
  };
  let firstFailure = null;
  try {
    const registered = session.endpoint.register({ id: "fixture.k07-held", version: "0.1.0", baseUri: "fixture:held", resources: {}, components: [sink] });
    assert.equal(registered.ok, true, "the contributed sink package registers");
    if (registered.ok) assert.equal((await registered.value.ready).ok, true, "the contributed sink is ready");
    assert.equal((await session.reloadConfiguration()).ok, true, "the sink configuration reload is accepted");
    const ready = Date.now() + 15_000;
    while (session.status(true).checks.active < 1 && Date.now() < ready) await settle();
    drive(1);
    const enteredDeadline = Date.now() + 20_000;
    while (state.entered === 0 && Date.now() < enteredDeadline) await settle();
    assert.equal(state.entered, 1, "useful paid work really reaches the provider once");
    const writeDeadline = Date.now() + 20_000;
    while (writeIds.length === 0 && Date.now() < writeDeadline) await settle();
    assert.equal(writeIds.length >= 1, true, "the READY sink really receives a physical write");
    drive(2);
    drive(3);
    await settle(500);
    assert.equal(heldWrites.length >= 2, true, `outstanding held writes are bounded and visible (${heldWrites.length})`);
    assert.equal(state.active, 0, "independent primary work is not stalled by the held sink");
    const outstandingBeforeRelease = heldWrites.length;
    await session.retire("fixture-complete").catch(error => console.error("K07-HELD-CLEANUP", String(error)));
    // Release every actual held write and wait for the real returns.
    const drainDeadline = Date.now() + 10_000;
    while (heldWrites.length > 0 && Date.now() < drainDeadline) {
      const batch = heldWrites.splice(0);
      for (const resolvePromise of batch) resolvePromise();
      await settle(50);
    }
    assert.equal(heldWrites.length, 0, "all held writes were released and returned");
    assert.equal(new Set(writeIds).size, writeIds.length, "no accepted record ID was delivered twice");
    assert.equal(disposed === 1, true, `the sink is disposed exactly once (${disposed})`);
    assert.equal(session.status(true).runtime.state, "retired", "the engine owner retired after the drain");
    assert.equal(state.entered >= 1, true, "the bounded sequence kept its provider work");
    console.log("K07-HELD-SINK", JSON.stringify({ writes: writeIds.length, outstandingBeforeRelease, entered: state.entered, disposed }));
  } catch (error) {
    firstFailure = error;
    throw error;
  } finally {
    try {
      const tail = heldWrites.splice(0);
      for (const resolvePromise of tail) resolvePromise();
      await session.retire("fixture-cleanup");
    } catch (error) { console.error("K07-HELD-FINALLY", String(error)); }
    if (firstFailure === null && state.active === 0) await rm(root, { recursive: true, force: true });
    else console.error("K07-HELD-SCRATCH", root);
  }
});

// K07-T07 / B.10 (native destination error): a real child captures the owned
// append handle before importing the product, closes it, and the next ordinary
// record hits a genuine native write failure — the journal degrades while useful
// primary work continues and no bytes are replayed.
test("K07-T07-storage-native-write: a real destination failure degrades the journal without stopping primary work", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-native-write-"));
  const sessionId = `sess-k07-nw-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, [join(process.cwd(), "test", "fixtures", "k07-storage-child.mjs"), root, sessionId], {
    cwd: process.cwd(),
    env: {
      QE_K07_REPO: process.cwd(), PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
      TEMP: process.env.TEMP ?? tmpdir(), TMP: process.env.TMP ?? tmpdir(),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
      ...(process.env.APPDATA ? { APPDATA: process.env.APPDATA } : {}),
      ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ...(process.env.GIT_CEILING_DIRECTORIES ? { GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => { if (stdout.length < 4096) stdout += String(chunk); });
  child.stderr?.on("data", chunk => { if (stderr.length < 4096) stderr += String(chunk); });
  const exited = new Promise(resolvePromise => child.once("exit", (code, signal) => resolvePromise({ code, signal })));
  const closed = new Promise(resolvePromise => child.once("close", (code, signal) => resolvePromise({ code, signal })));
  const result = await exited;
  const close = await Promise.race([closed, new Promise(resolvePromise => setTimeout(() => resolvePromise(null), 5_000))]);
  assert.ok(close, "the owned child closed its pipes");
  assert.equal(result.code, 0, `the owned child finished the native-write witness (${JSON.stringify(result)}; stderr ${stderr.slice(0, 300)})`);
  const evidence = JSON.parse(await readFile(join(root, "native-write-evidence.json"), "utf8"));
  assert.equal(evidence.entered >= 2, true, "useful primary work continued (a second paid entry) after the destination fault");
  const grew = evidence.afterSizes.some((size, index) => size > (evidence.beforeSizes[index] ?? 0));
  assert.equal(grew, false, "no bytes were written after the owned append handle closed (no replay)");
  const degraded = JSON.stringify(evidence.journal ?? {}).includes("degrad")
    || JSON.stringify(evidence.health ?? {}).includes("degrad")
    || JSON.stringify(evidence.journal ?? {}).includes("failed")
    || (evidence.lostRecords ?? 0) > 0
    || (evidence.reasonCode ?? null) !== null;
  assert.equal(degraded, true, `the journal surfaces truthful degradation (${JSON.stringify({ journal: evidence.journal, health: evidence.health, reasonCode: evidence.reasonCode, lostRecords: evidence.lostRecords })})`);
  assert.equal(evidence.active, 0, "no provider call stayed active");
  await rm(root, { recursive: true, force: true });
});

const spawnStorageChild = (root, sessionId, mode) => {
  const child = spawn(process.execPath, [join(process.cwd(), "test", "fixtures", "k07-storage-child.mjs"), root, sessionId, mode], {
    cwd: process.cwd(),
    env: {
      QE_K07_REPO: process.cwd(), PATH: process.env.PATH ?? "", SystemRoot: process.env.SystemRoot ?? "",
      TEMP: process.env.TEMP ?? tmpdir(), TMP: process.env.TMP ?? tmpdir(),
      ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
      ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
      ...(process.env.APPDATA ? { APPDATA: process.env.APPDATA } : {}),
      ...(process.env.LOCALAPPDATA ? { LOCALAPPDATA: process.env.LOCALAPPDATA } : {}),
      ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      ...(process.env.GIT_CEILING_DIRECTORIES ? { GIT_CEILING_DIRECTORIES: process.env.GIT_CEILING_DIRECTORIES } : {}),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout?.on("data", chunk => { if (output.stdout.length < 4096) output.stdout += String(chunk); });
  child.stderr?.on("data", chunk => { if (output.stderr.length < 4096) output.stderr += String(chunk); });
  const exited = new Promise(resolvePromise => child.once("exit", (code, signal) => resolvePromise({ code, signal })));
  const closed = new Promise(resolvePromise => child.once("close", (code, signal) => resolvePromise({ code, signal })));
  return { child, exited, closed, output };
};

const waitForGzipMarker = async (root, child) => {
  const marker = join(root, "gzip-marker.json");
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    if (existsSync(marker)) return JSON.parse(await readFile(marker, "utf8"));
    if (child.exitCode !== null) break;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  return null;
};

const closeOut = async (handle, timeoutMs = 5_000) => Promise.race([handle, new Promise(resolvePromise => setTimeout(() => resolvePromise(null), timeoutMs))]);

test("K07-T07-storage-gzip-healthy: the validated promotion publishes the exact archive", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-gz-healthy-"));
  const sessionId = `sess-k07-gzh-${process.pid}-${Date.now()}`;
  const handle = spawnStorageChild(root, sessionId, "gzip");
  const marker = await waitForGzipMarker(root, handle.child);
  assert.ok(marker, `the real compression promotion was reached (${handle.output.stderr.slice(0, 200)})`);
  assert.equal(typeof marker.rawSha256, "string", "the marker carries the real raw source SHA");
  await writeFile(join(root, "gzip-release"), "release", "utf8");
  const result = await handle.exited;
  const close = await closeOut(handle.closed);
  assert.ok(close, "the compression child closed its pipes");
  assert.equal(result.code, 0, `the healthy compression child exited 0 (${JSON.stringify(result)}; ${handle.output.stderr.slice(0, 200)})`);
  const journalRoot = join(root, "journal");
  const archives = (await readdir(journalRoot)).filter(name => name.endsWith(".jsonl.gz"));
  assert.equal(archives.length >= 1, true, `the promotion published a real gzip archive (${archives.join(",")})`);
  const published = await gunzipAsync(await readFile(join(journalRoot, archives[0])));
  assert.equal(published.length, marker.rawBytes, "the published archive carries the exact raw byte count");
  assert.equal(createHash("sha256").update(published).digest("hex"), marker.rawSha256, "the published archive matches the raw source SHA");
  assert.equal(existsSync(marker.tmpPath), false, "the validated temp was consumed by the real promotion");
  await rm(root, { recursive: true, force: true });
});

test("K07-T07-storage-gzip-interrupt: a held promotion preserves the raw source", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-gz-interrupt-"));
  const sessionId = `sess-k07-gzi-${process.pid}-${Date.now()}`;
  const handle = spawnStorageChild(root, sessionId, "gzip");
  const marker = await waitForGzipMarker(root, handle.child);
  assert.ok(marker, `the real compression promotion was reached (${handle.output.stderr.slice(0, 200)})`);
  const rawBefore = await readFile(marker.rawPath);
  assert.equal(rawBefore.length, marker.rawBytes, "the raw source is complete while the promotion is held");
  // Interrupt only the actual owned child while its validated promotion is pending.
  handle.child.kill();
  const result = await handle.exited;
  const close = await closeOut(handle.closed);
  assert.ok(close, "the interrupted owned child closed its pipes");
  assert.notEqual(result.code, 0, "the interrupted child did not report a successful natural completion");
  const rawAfter = await readFile(marker.rawPath);
  assert.equal(rawAfter.length, marker.rawBytes, "the complete raw source survives the interruption");
  assert.equal(createHash("sha256").update(rawAfter).digest("hex"), marker.rawSha256, "the raw source bytes are unchanged");
  const journalRoot = join(root, "journal");
  const finalArchives = (await readdir(journalRoot)).filter(name => name.endsWith(".jsonl.gz"));
  assert.equal(finalArchives.length, 0, "no partial archive was claimed complete");
  if (existsSync(marker.tmpPath)) {
    const temp = await readFile(marker.tmpPath);
    assert.equal(temp.length, marker.tempBytes, "the retained validated temp keeps its real bytes");
  }
  await rm(root, { recursive: true, force: true });
});

// K07-T06 / B.08, B.13 (retention vs reopen): a real owner sweep revalidates an
// age-eligible foreign archive; while that revalidation is held, the archive's
// owner actually reopens. The old sweep must not delete it afterwards.
test("K07-T06-storage-retention: a revalidated foreign archive survives an owner reopen", { timeout: 90_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k07-retention-"));
  const sessionId = `sess-k07-ret-${process.pid}-${Date.now()}`;
  const handle = spawnStorageChild(root, sessionId, "retention");
  const result = await handle.exited;
  const close = await closeOut(handle.closed);
  assert.ok(close, "the retention child closed its pipes");
  assert.equal(result.code, 0, `the retention/reopen child finished (${JSON.stringify(result)}; ${handle.output.stderr.slice(0, 300)})`);
  const evidence = JSON.parse(await readFile(join(root, "retention-evidence.json"), "utf8"));
  assert.equal(evidence.reopenOk, true, "the foreign archive's owner really reopened during the sweep");
  assert.equal(evidence.bActive, true, "the sweeping owner kept its own active segment");
  assert.equal(evidence.archiveSurvived, true, "the revalidated archive survives the old sweep after reopen");
  assert.equal(evidence.statCalls >= 2, true, `discovery and revalidation really occurred (${evidence.statCalls})`);
  await rm(root, { recursive: true, force: true });
});
