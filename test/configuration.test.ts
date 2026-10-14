import assert from "node:assert/strict";
import test from "node:test";
import { resolveConfiguration } from "../src/configuration.js";

test("missing configuration is inactive observation with no spending or effects", () => {
  const result = resolveConfiguration(undefined);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.enabled, false);
  assert.equal(result.value.mode, "observe");
  assert.deepEqual(result.value.permissions.modelProfiles, []);
  assert.deepEqual(result.value.permissions.actions, []);
  assert.equal(result.value.observability.detail, "standard");
  assert.ok(Object.values(result.value.observability.capture).every(value => value === "none"));
});

test("an unknown core key is rejected without exposing its name or secret value", () => {
  const sentinel = "private-fixture-sentinel";
  const result = resolveConfiguration({ schemaVersion: 1, [sentinel]: sentinel });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "config.unknown-key");
  assert.equal(result.error.field, "$");
  assert.equal(JSON.stringify(result).includes(sentinel), false);
});

test("present configuration requires schema 1 and validated foundation values", () => {
  for (const input of [{}, { schemaVersion: 2 }, { schemaVersion: 1, enabled: "false" },
    { schemaVersion: 1, mode: "invalid" }, null, [], "private-fixture-sentinel"]) {
    const result = resolveConfiguration(input);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("private-fixture-sentinel"), false);
  }
});

test("valid inactive configuration is accepted but activation is explicitly unavailable", () => {
  assert.equal(resolveConfiguration({ schemaVersion: 1, enabled: false, mode: "observe" }).ok, true);
  const result = resolveConfiguration({ schemaVersion: 1, enabled: true });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "config.capability-unavailable");
  assert.equal(result.error.field, "enabled");
});
