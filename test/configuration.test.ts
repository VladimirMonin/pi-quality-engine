import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  DEFAULT_RECENT_HISTORY,
  loadEffectiveConfiguration,
  parseConfigurationText,
  validateConfiguration,
} from "../src/configuration.js";

const SENTINEL = "k01-private-fixture-sentinel-7f3a";

interface FixturePaths {
  agentDir: string;
  projectConfigDir: string;
}

async function withFixture(run: (paths: FixturePaths) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "qe-config-"));
  try {
    await run({ agentDir: join(root, "agent"), projectConfigDir: join(root, "project", ".pi") });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeConfig(path: string, contents: string | object): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof contents === "string" ? contents : JSON.stringify(contents), "utf8");
}

function rejectCode(text: string): string | undefined {
  const result = parseConfigurationText(text);
  return result.ok ? undefined : result.error.code;
}

function validationCode(text: string): string | undefined {
  const parsed = parseConfigurationText(text);
  if (!parsed.ok) return parsed.error.code;
  const validated = validateConfiguration(parsed.value);
  return validated.ok ? undefined : validated.error.code;
}

test("missing configuration resolves cold inactive defaults", async () => {
  await withFixture(async paths => {
    const loaded = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.equal(loaded.rejection, null);
    assert.deepEqual(loaded.resolved.sources, { user: "absent", project: "absent" });
    assert.deepEqual(loaded.resolved.origins, []);
    assert.equal(loaded.resolved.value.enabled, false);
    assert.equal(loaded.resolved.value.mode, "observe");
    assert.deepEqual(loaded.resolved.value.permissions.modelProfiles, []);
    assert.deepEqual(loaded.resolved.value.permissions.actions, []);
    assert.equal(loaded.resolved.value.observability.detail, "standard");
    assert.ok(Object.values(loaded.resolved.value.observability.capture).every(value => value === "none"));
    assert.deepEqual(loaded.resolved.value.observability.recentHistory, DEFAULT_RECENT_HISTORY);
    assert.match(loaded.resolved.revision, /^cfg-[0-9a-f]{16}$/);
  });
});

test("a valid YAML user file is applied and narrows only implemented limits", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.yaml"), [
      "schemaVersion: 1",
      "enabled: false",
      "mode: observe",
      "observability:",
      "  detail: standard",
      "  capture:",
      "    documents: none",
      "  recentHistory:",
      "    maxEvents: 64",
      "",
    ].join("\n"));
    const loaded = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.equal(loaded.rejection, null);
    assert.deepEqual(loaded.resolved.sources, { user: "applied", project: "absent" });
    assert.deepEqual(loaded.resolved.origins, ["user"]);
    assert.equal(loaded.resolved.value.observability.recentHistory.maxEvents, 64);
    assert.equal(loaded.resolved.value.observability.recentHistory.maxBytes, DEFAULT_RECENT_HISTORY.maxBytes);
  });
});

test("an unknown core key with a sentinel value is rejected without exposing either", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.json"), { schemaVersion: 1, [SENTINEL]: SENTINEL });
    const loaded = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.ok(loaded.rejection);
    assert.equal(loaded.rejection.error.code, "config.unknown-key");
    assert.equal(loaded.rejection.error.field, "$");
    assert.deepEqual(loaded.resolved.sources, { user: "rejected", project: "absent" });
    assert.equal(loaded.resolved.value.enabled, false);
    const serialized = JSON.stringify(loaded);
    assert.equal(serialized.includes(SENTINEL), false);
  });
});

test("rejection metadata is an opaque reference, never a guessable content hash", async () => {
  await withFixture(async paths => {
    const text = 'schemaVersion: 1\nprivateCode: "1234"\n';
    await writeConfig(join(paths.agentDir, "quality", "config.yaml"), text);
    const loaded = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.ok(loaded.rejection);
    assert.equal(loaded.rejection.error.code, "config.unknown-key");
    const reference = loaded.rejection.candidateRevision;
    assert.match(reference, /^rejected-user-[0-9a-f-]{36}$/);
    const guessable = `sha-${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)}`;
    assert.notEqual(reference, guessable);
    assert.equal(reference.includes("1234"), false);
    assert.equal(JSON.stringify(loaded).includes("1234"), false);
  });
});

test("restricted authoring rules reject duplicates, aliases, custom tags, non-finite values and multiple documents", () => {
  assert.equal(rejectCode("schemaVersion: 1\nenabled: false\nenabled: true\n"), "config.duplicate-key");
  assert.equal(rejectCode('{"schemaVersion": 1, "schemaVersion": 1}'), "config.duplicate-key");
  assert.equal(rejectCode("schemaVersion: 1\nmode: &m observe\nenabled: *m\n"), "config.alias-not-allowed");
  assert.equal(rejectCode("schemaVersion: 1\nmode: !acme observe\n"), "config.tag-not-allowed");
  assert.equal(rejectCode("schemaVersion: 1\n!private enabled: false\n"), "config.tag-not-allowed");
  assert.equal(rejectCode("schemaVersion: 1\nmode: !<tag:yaml.org,2002:private> observe\n"), "config.tag-not-allowed");
  assert.equal(rejectCode("schemaVersion: 1\nmode: .inf\n"), "config.invalid-value");
  assert.equal(rejectCode("schemaVersion: 1\n---\nschemaVersion: 1\n"), "config.multiple-documents");
  assert.equal(rejectCode("1: x\n"), "config.non-string-key");
  assert.equal(rejectCode(""), "config.invalid-object");
});

test("prototype-named keys survive parsing and are rejected as unknown core keys", async () => {
  assert.equal(validationCode("schemaVersion: 1\n__proto__: qe-independent-proto-sentinel\n"), "config.unknown-key");
  assert.equal(validationCode("schemaVersion: 1\nobservability:\n  __proto__: qe-independent-proto-sentinel\n"), "config.unknown-key");
  const parsed = parseConfigurationText("schemaVersion: 1\n__proto__: qe-independent-proto-sentinel\n");
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(Object.keys(parsed.value).sort(), ["__proto__", "schemaVersion"]);
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.yaml"), "schemaVersion: 1\n__proto__: qe-independent-proto-sentinel\n");
    const loaded = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.ok(loaded.rejection);
    assert.equal(loaded.rejection.error.code, "config.unknown-key");
    assert.equal(JSON.stringify(loaded).includes("qe-independent-proto-sentinel"), false);
  });
});

test("zero recent-history limits are valid and mean no retained history", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.json"), {
      schemaVersion: 1,
      observability: { recentHistory: { maxEvents: 0, maxBytes: 0 } },
    });
    const loaded = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.equal(loaded.rejection, null);
    assert.deepEqual(loaded.resolved.value.observability.recentHistory, { maxEvents: 0, maxBytes: 0 });
  });
});

test("structural bounds reject oversized, too-deep and too-many-entry documents", () => {
  const oversized = `schemaVersion: 1\nmode: "${"x".repeat(1_048_577)}"\n`;
  assert.equal(rejectCode(oversized), "config.too-large");
  const tooDeep = `${"[".repeat(40)}1${"]".repeat(40)}`;
  assert.equal(rejectCode(tooDeep), "config.too-deep");
  const tooManyEntries = JSON.stringify({ schemaVersion: 1, observability: Object.fromEntries(Array.from({ length: 257 }, (_value, index) => [`k${index}`, 1])) });
  assert.equal(rejectCode(tooManyEntries), "config.too-many-entries");
});

test("present configuration requires schema version 1 and typed implemented values", () => {
  const cases: Array<[unknown, string]> = [
    [{}, "config.invalid-schema"],
    [{ schemaVersion: 2 }, "config.invalid-schema"],
    [{ schemaVersion: 1, enabled: "false" }, "config.invalid-value"],
    [{ schemaVersion: 1, mode: "invalid" }, "config.invalid-value"],
    [{ schemaVersion: 1, permissions: "all" }, "config.invalid-value"],
    [{ schemaVersion: 1, observability: { detail: "verbose" } }, "config.invalid-value"],
    [{ schemaVersion: 1, observability: { unknownControl: 1 } }, "config.unknown-key"],
    [{ schemaVersion: 1, observability: { capture: { documents: "all" } } }, "config.invalid-value"],
    [{ schemaVersion: 1, observability: { capture: { telepathy: "none" } } }, "config.unknown-key"],
    [{ schemaVersion: 1, permissions: { unknownGrant: true } }, "config.unknown-key"],
  ];
  for (const [input, expected] of cases) {
    const parsed = validateConfiguration(JSON.parse(JSON.stringify(input)));
    assert.equal(parsed.ok, false);
    if (parsed.ok) continue;
    assert.equal(parsed.error.code, expected, JSON.stringify(input));
  }
});

test("valid C1 values outside the implemented slice are reported unavailable, not accepted", () => {
  const cases: Array<[unknown, string]> = [
    [{ schemaVersion: 1, enabled: true }, "$.enabled"],
    [{ schemaVersion: 1, mode: "advise" }, "$.mode"],
    [{ schemaVersion: 1, observability: { detail: "trace" } }, "$.observability.detail"],
    [{ schemaVersion: 1, observability: { capture: { prompts: "excerpt" } } }, "$.observability.capture.prompts"],
    [{ schemaVersion: 1, observability: { journal: { enabled: false } } }, "$.observability.journal"],
    [{ schemaVersion: 1, observability: { presentation: "diagnostic" } }, "$.observability.presentation"],
    [{ schemaVersion: 1, permissions: { modelProfiles: ["local"] } }, "$.permissions.modelProfiles"],
    [{ schemaVersion: 1, permissions: { allowIdleContinuation: true } }, "$.permissions.allowIdleContinuation"],
    [{ schemaVersion: 1, checks: { repetition: {} } }, "$.checks"],
    [{ schemaVersion: 1, modelProfiles: { local: {} } }, "$.modelProfiles"],
  ];
  for (const [input, expectedField] of cases) {
    const parsed = validateConfiguration(JSON.parse(JSON.stringify(input)));
    assert.equal(parsed.ok, false);
    if (parsed.ok) continue;
    assert.equal(parsed.error.code, "config.capability-unavailable", JSON.stringify(input));
    assert.equal(parsed.error.field, expectedField);
  }
});

test("an untrusted project file is never read or applied", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.projectConfigDir, "quality.json"), { schemaVersion: 1, [SENTINEL]: SENTINEL });
    const skipped = await loadEffectiveConfiguration({ ...paths, projectTrusted: false });
    assert.equal(skipped.rejection, null);
    assert.deepEqual(skipped.resolved.sources, { user: "absent", project: "skipped-untrusted" });
    assert.equal(JSON.stringify(skipped).includes(SENTINEL), false);
    const trusted = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.ok(trusted.rejection);
    assert.equal(trusted.rejection.error.code, "config.unknown-key");
    assert.deepEqual(trusted.resolved.sources, { user: "absent", project: "rejected" });
  });
});

test("a trusted project file cannot override the user-owned observability policy", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.json"), {
      schemaVersion: 1,
      observability: { recentHistory: { maxEvents: 64, maxBytes: 65_536 } },
    });
    await writeConfig(join(paths.projectConfigDir, "quality.json"), {
      schemaVersion: 1,
      observability: { recentHistory: { maxEvents: 1 } },
    });
    const overridden = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.ok(overridden.rejection);
    assert.equal(overridden.rejection.error.code, "config.project-observability-override");
    assert.equal(overridden.rejection.error.field, "$.observability");
    assert.deepEqual(overridden.resolved.sources, { user: "applied", project: "rejected" });
    assert.deepEqual(overridden.resolved.origins, ["user"]);
    assert.deepEqual(overridden.resolved.value.observability.recentHistory, { maxEvents: 64, maxBytes: 65_536 });

    // Even a project document that only restates documented defaults is an override.
    await writeConfig(join(paths.projectConfigDir, "quality.json"), {
      schemaVersion: 1,
      observability: { detail: "standard", capture: { documents: "none" } },
    });
    const repeatedDefaults = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.ok(repeatedDefaults.rejection);
    assert.equal(repeatedDefaults.rejection.error.code, "config.project-observability-override");
    assert.deepEqual(repeatedDefaults.resolved.value.observability.recentHistory, { maxEvents: 64, maxBytes: 65_536 });

    // A project document without the observability object still applies as a layer.
    await writeConfig(join(paths.projectConfigDir, "quality.json"), { schemaVersion: 1, permissions: {} });
    const plain = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.equal(plain.rejection, null);
    assert.deepEqual(plain.resolved.sources, { user: "applied", project: "applied" });
    assert.deepEqual(plain.resolved.origins, ["user", "project"]);
    assert.deepEqual(plain.resolved.value.observability.recentHistory, { maxEvents: 64, maxBytes: 65_536 });
  });
});

test("a cold invalid user file leaves the project file untouched and defaults effective", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.json"), { schemaVersion: 1, mode: "advise" });
    await writeConfig(join(paths.projectConfigDir, "quality.json"), {
      schemaVersion: 1,
      observability: { recentHistory: { maxEvents: 16 } },
    });
    const loaded = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.ok(loaded.rejection);
    assert.equal(loaded.rejection.error.code, "config.capability-unavailable");
    assert.deepEqual(loaded.resolved.sources, { user: "rejected", project: "absent" });
    assert.deepEqual(loaded.resolved.value.observability.recentHistory, DEFAULT_RECENT_HISTORY);
  });
});

test("both authoring formats at one location are a configuration error", async () => {
  await withFixture(async paths => {
    await writeConfig(join(paths.agentDir, "quality", "config.yaml"), "schemaVersion: 1\n");
    await writeConfig(join(paths.agentDir, "quality", "config.json"), { schemaVersion: 1 });
    const loaded = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.ok(loaded.rejection);
    assert.equal(loaded.rejection.error.code, "config.ambiguous-format");
    assert.deepEqual(loaded.rejection.error.details, { origin: "user" });
    assert.deepEqual(loaded.resolved.sources, { user: "rejected", project: "absent" });
  });
});

test("the configuration revision is stable for identical effective values and reflects limits", async () => {
  await withFixture(async paths => {
    const first = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    const second = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.equal(first.resolved.revision, second.resolved.revision);
    await writeConfig(join(paths.agentDir, "quality", "config.json"), {
      schemaVersion: 1,
      observability: { recentHistory: { maxEvents: 8 } },
    });
    const changed = await loadEffectiveConfiguration({ ...paths, projectTrusted: true });
    assert.notEqual(changed.resolved.revision, first.resolved.revision);
  });
});

test("JSON text uses the same restricted data model as YAML", () => {
  const parsed = parseConfigurationText('{"schemaVersion": 1, "mode": "observe"}');
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.deepEqual(parsed.value, { schemaVersion: 1, mode: "observe" });
});
