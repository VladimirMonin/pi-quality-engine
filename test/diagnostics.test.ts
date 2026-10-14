import assert from "node:assert/strict";
import test from "node:test";
import { DiagnosticHistory } from "../src/diagnostics.js";
import type { DiagnosticHistoryContext, DiagnosticHistoryLimits } from "../src/diagnostics.js";

const CONTEXT: DiagnosticHistoryContext = {
  observedSessionId: "sess-fixture",
  scope: {
    branchId: "unresolved",
    runtimeGeneration: "gen-fixture",
    episodeId: null,
    authorizationRevision: "no-grants",
  },
  configRevision: "cfg-fixture",
  dataPolicyRevision: "o1-1",
  ownerId: "core.runtime",
};

function limits(overrides: Partial<DiagnosticHistoryLimits> = {}): DiagnosticHistoryLimits {
  return { maxEvents: 8, maxBytes: 1_048_576, maxRecordBytes: 65_536, ...overrides };
}

function appendStarted(history: DiagnosticHistory): void {
  history.append({
    event: "quality.runtime.started",
    level: "info",
    reasonCodes: [],
    data: { engineVersion: "0.0.1", hostMode: "rpc" },
  });
}

test("a projected record carries the O1 envelope and engine-issued identity", () => {
  const history = new DiagnosticHistory(CONTEXT, limits());
  appendStarted(history);
  const record = history.records()[0];
  assert.ok(record);
  assert.equal(record.schemaVersion, 1);
  assert.match(record.eventId, /^[0-9a-f-]{36}$/);
  assert.equal(record.sequence, 1);
  assert.equal(record.event, "quality.runtime.started");
  assert.equal(record.observedSessionId, "sess-fixture");
  assert.equal(record.fields.scope.runtimeGeneration, "gen-fixture");
  assert.equal(record.fields.scope.episodeId, null);
  assert.equal(record.fields.origin.kind, "engine");
  assert.equal(record.fields.origin.ownerId, "core.runtime");
  assert.equal(record.fields.level, "info");
  assert.equal(record.fields.detail, "standard");
  assert.equal(record.fields.configRevision, "cfg-fixture");
  assert.equal(record.fields.dataPolicyRevision, "o1-1");
  assert.deepEqual(record.fields.reasonCodes, []);
  assert.ok(Number.isInteger(record.fields.time.monoMs));
  assert.ok(record.fields.time.monoMs >= 0);
  assert.equal(Number.isNaN(Date.parse(record.fields.time.recordedAt)), false);
  assert.equal(record.fields.time.occurredAt, null);
  assert.equal(record.fields.correlation.runId, null);
  assert.equal(record.fields.projection.metadataTruncated, false);
  assert.deepEqual(record.fields.projection.omittedFields, []);
  assert.deepEqual(record.fields.projection.captureRefs, []);
});

test("retained records are bounded by count and expose drop accounting", () => {
  const history = new DiagnosticHistory(CONTEXT, limits({ maxEvents: 2 }));
  appendStarted(history);
  appendStarted(history);
  appendStarted(history);
  const records = history.records();
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(record => record.sequence), [2, 3]);
  assert.equal(history.droppedRecords, 1);
  assert.equal(history.byteLength, records.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record), "utf8") + 1, 0));
});

test("retained records are bounded by serialized bytes and by one-record size", () => {
  const byteBounded = new DiagnosticHistory(CONTEXT, limits({ maxBytes: 1 }));
  appendStarted(byteBounded);
  assert.equal(byteBounded.recordCount, 0);
  assert.equal(byteBounded.droppedRecords, 1);

  const recordBounded = new DiagnosticHistory(CONTEXT, limits({ maxRecordBytes: 16 }));
  appendStarted(recordBounded);
  assert.equal(recordBounded.recordCount, 0);
  assert.equal(recordBounded.droppedRecords, 1);
});

test("retained records are frozen and readers cannot reach shared state", () => {
  const history = new DiagnosticHistory(CONTEXT, limits());
  appendStarted(history);
  const record = history.records()[0];
  assert.ok(record);
  assert.equal(Object.isFrozen(record), true);
  assert.equal(Object.isFrozen(record.fields), true);
  assert.throws(() => {
    (record as { sequence: number }).sequence = 99;
  });
  const detached = history.records() as unknown as unknown[];
  detached.length = 0;
  assert.equal(history.recordCount, 1);
});
