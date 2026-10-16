import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SourceEvidence } from "../src/evidence.js";
import { loadEffectiveConfiguration } from "../src/configuration.js";
import { GitEpisodeEvidence } from "../src/git-evidence.js";
import type { ContextBatch, SourceDefinition } from "../src/contracts.js";

const signal = new AbortController().signal;

function sourceDefinition(overrides: Partial<SourceDefinition> = {}): SourceDefinition {
  return {
    uris: [],
    globs: [],
    role: "evidence",
    required: false,
    revisionPolicy: "refresh-at-check",
    include: "full",
    sections: [],
    maxFiles: 32,
    maxBytes: 262_144,
    exclude: [],
    ...overrides,
  };
}

async function fixtureRoot(): Promise<{ root: string; projectRoot: string; agentDir: string; agentQualityDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-evidence-"));
  const projectRoot = join(root, "project");
  const agentDir = join(root, "agent");
  const agentQualityDir = join(agentDir, "quality");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(agentQualityDir, { recursive: true });
  return { root, projectRoot, agentDir, agentQualityDir };
}

test("K04-P04 required, optional and protected sources resolve with truthful coverage", async () => {
  const paths = await fixtureRoot();
  try {
    await writeFile(join(paths.projectRoot, "architecture.md"), "# Architecture\nmarker-architecture\n", "utf8");
    await writeFile(join(paths.projectRoot, "requirements.md"), "# Requirements\nmarker-requirements\n", "utf8");
    await writeFile(join(paths.projectRoot, ".env"), "SECRET_MARKER=do-not-read\n", "utf8");
    const evidence = new SourceEvidence([
      { id: "architecture", definition: sourceDefinition({ uris: ["architecture.md"], role: "requirement", required: true, revisionPolicy: "pin-at-episode" }), origin: "project", baseDir: paths.projectRoot },
      { id: "requirements", definition: sourceDefinition({ uris: ["requirements.md"], role: "requirement", required: true }), origin: "project", baseDir: paths.projectRoot },
      { id: "optional", definition: sourceDefinition({ uris: ["missing-reference.md"], required: false }), origin: "project", baseDir: paths.projectRoot },
      { id: "protected", definition: sourceDefinition({ uris: [".env"], required: false }), origin: "project", baseDir: paths.projectRoot },
      { id: "absent-required", definition: sourceDefinition({ uris: ["absent.md"], required: true }), origin: "project", baseDir: paths.projectRoot },
    ], { projectRoot: paths.projectRoot, agentDir: paths.agentDir, agentQualityDir: paths.agentQualityDir });

    const architecture = await evidence.readSource("architecture", signal);
    assert.equal(architecture.ok, true);
    if (!architecture.ok) return;
    const architectureText = JSON.stringify(architecture.value.items);
    assert.ok(architectureText.includes("marker-architecture"));
    assert.equal(architecture.value.coverage.state, "complete");
    assert.equal(architecture.value.items[0]?.required, true);
    assert.equal(architecture.value.items[0]?.provenance.changedDuringRead, false);
    assert.match(architecture.value.items[0]?.provenance.revision ?? "", /^[0-9a-f]{32}$/u);

    const optional = await evidence.readSource("optional", signal);
    assert.equal(optional.ok, true);
    if (optional.ok) {
      assert.equal(optional.value.items.length, 0);
      assert.equal(optional.value.coverage.state, "partial");
      assert.ok(optional.value.coverage.issues.some(issue => issue.reason === "core.source-missing"));
    }

    const protectedSource = await evidence.readSource("protected", signal);
    assert.equal(protectedSource.ok, true);
    if (protectedSource.ok) {
      assert.equal(protectedSource.value.items.length, 0);
      assert.ok(protectedSource.value.coverage.issues.some(issue => issue.reason === "core.source-protected"));
      assert.equal(JSON.stringify(protectedSource.value).includes("SECRET_MARKER"), false);
    }

    const absent = await evidence.readSource("absent-required", signal);
    assert.equal(absent.ok, true);
    if (absent.ok) {
      assert.equal(absent.value.coverage.state, "insufficient");
      assert.ok(absent.value.coverage.issues.some(issue => issue.required));
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("K04-P04 symlink escape and hostile path are denied without reading the target", async () => {
  const paths = await fixtureRoot();
  try {
    const outside = join(paths.root, "outside");
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "OUTSIDE_TARGET_MARKER\n", "utf8");
    await symlink(join(outside, "secret.txt"), join(paths.projectRoot, "escape.txt"));
    const evidence = new SourceEvidence([
      { id: "escape", definition: sourceDefinition({ uris: ["escape.txt"] }), origin: "project", baseDir: paths.projectRoot },
    ], { projectRoot: paths.projectRoot, agentDir: paths.agentDir, agentQualityDir: paths.agentQualityDir });
    const result = await evidence.readSource("escape", signal);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.items.length, 0);
      assert.ok(result.value.coverage.issues.some(issue => issue.reason === "core.source-denied"));
      assert.equal(JSON.stringify(result.value).includes("OUTSIDE_TARGET_MARKER"), false);
    }
    const permitted = await evidence.readPermittedFile(join(outside, "secret.txt"), signal);
    assert.equal(permitted.ok, false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("K04-P04 glob expansion is bounded, deterministic and exclusion-aware", async () => {
  const paths = await fixtureRoot();
  try {
    await mkdir(join(paths.projectRoot, "docs"), { recursive: true });
    await writeFile(join(paths.projectRoot, "docs", "a.md"), "marker-a\n", "utf8");
    await writeFile(join(paths.projectRoot, "docs", "b.md"), "marker-b\n", "utf8");
    await writeFile(join(paths.projectRoot, "docs", "skip.md"), "marker-skip\n", "utf8");
    const evidence = new SourceEvidence([
      { id: "docs", definition: sourceDefinition({ globs: ["docs/**/*.md"], exclude: ["docs/skip.md"] }), origin: "project", baseDir: paths.projectRoot },
    ], { projectRoot: paths.projectRoot, agentDir: paths.agentDir, agentQualityDir: paths.agentQualityDir });
    const first = await evidence.readSource("docs", signal);
    const second = await evidence.readSource("docs", signal);
    assert.equal(first.ok, true);
    if (!first.ok || !second.ok) return;
    const text = JSON.stringify(first.value.items);
    assert.ok(text.includes("marker-a") && text.includes("marker-b"));
    assert.equal(text.includes("marker-skip"), false);
    assert.deepEqual(
      first.value.items.map(item => item.provenance.uri).sort(),
      second.value.items.map(item => item.provenance.uri).sort(),
    );
    assert.equal(first.value.coverage.state, "complete");
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

function git(projectRoot: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8", windowsHide: true });
}

test("K04-P04/T03 read-only Git evidence preserves index and later commits stay visible", async () => {
  const paths = await fixtureRoot();
  const projectRoot = paths.projectRoot;
  try {
    git(projectRoot, ["init", "--quiet"]);
    git(projectRoot, ["config", "user.email", "fixture@example.invalid"]);
    git(projectRoot, ["config", "user.name", "Fixture"]);
    await writeFile(join(projectRoot, "clean.txt"), "clean-baseline\n", "utf8");
    await writeFile(join(projectRoot, "dirty.txt"), "dirty-baseline\n", "utf8");
    await writeFile(join(projectRoot, "staged.txt"), "staged-baseline\n", "utf8");
    await writeFile(join(projectRoot, "untracked.txt"), "preexisting-untracked\n", "utf8");
    git(projectRoot, ["add", "clean.txt", "dirty.txt", "staged.txt"]);
    git(projectRoot, ["commit", "--quiet", "-m", "baseline"]);
    await writeFile(join(projectRoot, "dirty.txt"), "dirty-baseline\nepisode-dirty\n", "utf8");
    await writeFile(join(projectRoot, "staged.txt"), "staged-baseline\nepisode-staged\n", "utf8");
    git(projectRoot, ["add", "staged.txt"]);

    const evidence = new GitEpisodeEvidence(projectRoot);
    const baseline = evidence.captureBaseline();
    assert.ok(baseline.head !== null);
    assert.ok(baseline.entries.some(entry => entry.path === "dirty.txt" && entry.worktree === "M"));
    assert.ok(baseline.entries.some(entry => entry.path === "staged.txt" && entry.index === "M"));
    assert.ok(baseline.untracked.includes("untracked.txt"));
    assert.ok(baseline.dirtyFingerprints["dirty.txt"] !== undefined);

    await writeFile(join(projectRoot, "dirty.txt"), "dirty-baseline\nepisode-dirty\nsecond-edit\n", "utf8");
    await writeFile(join(projectRoot, "episode-commit.txt"), "episode-committed-marker\n", "utf8");
    git(projectRoot, ["add", "episode-commit.txt"]);
    git(projectRoot, ["commit", "--quiet", "-m", "episode change"]);

    // Before/after evidence is scoped to the collector call; the fixture's
    // deliberate commit is separate from collector behavior.
    const indexBefore = git(projectRoot, ["status", "--porcelain=v1"]);
    const indexFileBefore = await readFile(join(projectRoot, ".git", "index"));

    const collected = evidence.collectChanges({ paths: ["**"], includeUntracked: true, maxFiles: 16, maxBytes: 65_536 });
    assert.equal(collected.ok, true);
    if (!collected.ok) return;
    const text = JSON.stringify(collected.value.items);
    assert.ok(text.includes("second-edit"), "unstaged episode edit is visible");
    assert.ok(text.includes("episode-committed-marker"), "committed episode work remains visible");
    assert.ok(text.includes("staged-baseline"), "staged baseline is preserved");

    const indexAfter = git(projectRoot, ["status", "--porcelain=v1"]);
    const indexFileAfter = await readFile(join(projectRoot, ".git", "index"));
    assert.equal(indexAfter, indexBefore, "collector did not change repository status");
    assert.deepEqual(indexFileAfter, indexFileBefore, "collector did not write the real index");
    const invocations = evidence.invocations.map(entry => entry.args.join(" "));
    for (const invocation of invocations) {
      for (const forbidden of ["add ", "reset", "stash", "write-tree", "update-index"]) {
        assert.equal(invocation.includes(forbidden), false, `collector must not run ${forbidden}: ${invocation}`);
      }
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("K04-P04 an absent Git repository yields scoped unavailability without mutation", async () => {
  const paths = await fixtureRoot();
  try {
    const evidence = new GitEpisodeEvidence(paths.projectRoot);
    const baseline = evidence.captureBaseline();
    assert.equal(baseline.head, null);
    const collected = evidence.collectChanges({ paths: ["**"], includeUntracked: true, maxFiles: 8, maxBytes: 4_096 });
    assert.equal(collected.ok, true);
    if (collected.ok) {
      assert.equal(collected.value.items.length, 0);
      assert.equal(collected.value.coverage.state, "partial");
    }
    assert.equal(existsSync(join(paths.projectRoot, ".git")), false);
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Common-path integration: core.files reaches a real evaluator with coverage.
// ---------------------------------------------------------------------------

import { mkdir as mkdirSyncLike } from "node:fs/promises";
import { EngineSession } from "../src/runtime.js";
import type { AssessmentResult, EvaluatorDefinition, PackageDefinition, ContextSnapshot } from "../src/contracts.js";

async function startEvidenceSession(input: {
  root: string;
  sources: Record<string, SourceDefinition>;
  providers: object[];
  requiredCoverage?: "complete" | "partial";
}): Promise<{ session: EngineSession; captured: Array<{ snapshot: ContextSnapshot }> }> {
  const agentDir = join(input.root, "agent");
  const projectRoot = join(input.root, "project");
  const projectConfigDir = join(projectRoot, ".pi");
  await mkdirSyncLike(join(agentDir, "quality"), { recursive: true });
  await mkdirSyncLike(projectConfigDir, { recursive: true });
  await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
    schemaVersion: 1,
    enabled: true,
    mode: "observe",
    sources: input.sources,
    prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
    contexts: { evidence: { providers: input.providers, maxEstimatedTokens: 8000, requiredCoverage: input.requiredCoverage ?? "complete" } },
    evaluators: { capture: { use: "fixture.capture" } },
    policies: { record: { use: "core.record-only" } },
    checks: {
      evidence: {
        triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }],
        context: "evidence",
        prompt: "repetition",
        evaluator: "capture",
        policy: "record",
        cooldownMs: 0,
        criteria: ["efficiency.repetition"],
        workStates: ["work-expected"],
      },
    },
  }), "utf8");
  const captured: Array<{ snapshot: ContextSnapshot }> = [];
  const evaluator: EvaluatorDefinition = {
    id: "fixture.capture",
    apiMajor: 1,
    kind: "evaluator",
    mechanism: "deterministic",
    accepts: ["json"],
    optionsSchema: { type: "object", additionalProperties: false },
    requiredCapabilities: [],
    diagnosticCodes: [],
    evaluate: async (_options, evaluatorInput) => {
      captured.push({ snapshot: evaluatorInput.context });
      const result: AssessmentResult = {
        operational: "completed",
        coverage: evaluatorInput.context.coverage,
        conclusion: "no-supported-finding",
        findings: [],
        scores: [],
        additionalEvidence: [],
        dependencies: [],
        usageAttemptIds: [],
      };
      return result;
    },
  };
  const session = await EngineSession.start({
    observedSessionId: `sess-${Date.now()}-${Math.round(performance.now())}`,
    branchId: "unresolved",
    agentDir,
    projectRoot,
    projectConfigDir,
    projectTrusted: true,
    hostVersion: "1.1.0",
    hostMode: "rpc",
    resourcesDir: join(process.cwd(), "resources"),
    hostIdleAtStart: true,
  });
  const definition: PackageDefinition = { id: "fixture.capture-package", version: "0.1.0", baseUri: "fixture:capture", components: [evaluator], resources: {} };
  const registered = session.endpoint.register(definition);
  assert.equal(registered.ok, true);
  if (registered.ok) await registered.value.ready;
  return { session, captured };
}

function runEvidenceCheck(session: EngineSession, id = "t1"): void {
  session.handlePrimaryEvent({ type: "operator-input", text: "assess evidence", source: "interactive", occurredAt: new Date().toISOString() });
  session.handlePrimaryEvent({ type: "tool-started", operationId: id, toolName: "read", parentOperationId: null, occurredAt: new Date().toISOString() });
  session.handlePrimaryEvent({ type: "tool-completed", operationId: id, toolName: "read", parentOperationId: null, isError: false, durationMs: 1, occurredAt: new Date().toISOString() });
}

test("K04-T01/T02 core.files reaches a real evaluator with actual selected bytes and coverage", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-session-"));
  try {
    await mkdirSyncLike(join(root, "project"), { recursive: true });
    await writeFile(join(root, "project", "architecture.md"), "# Architecture\nsession-marker-architecture\n", "utf8");
    const { session, captured } = await startEvidenceSession({
      root,
      sources: {
        architecture: sourceDefinition({ uris: ["project:architecture.md"], role: "requirement", required: true }),
        optional: sourceDefinition({ uris: ["absent-optional.md"], required: false }),
      },
      providers: [
        { id: "files", use: "core.files", options: { sourceIds: ["architecture", "optional"] } },
        { id: "task", use: "core.task" },
      ],
    });
    try {
      runEvidenceCheck(session);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 120));
      assert.equal(captured.length, 1, "the capture evaluator saw one real run");
      const snapshot = captured[0]?.snapshot;
      assert.ok(snapshot !== undefined);
      const text = JSON.stringify(snapshot.items);
      assert.ok(text.includes("session-marker-architecture"), "selected required bytes reach the actual evaluator input");
      assert.equal(text.includes("absent-optional.md"), false);
      assert.equal(snapshot.coverage.state, "complete", "an optional omission must not fail the complete required scope");
      assert.ok(snapshot.coverage.issues.some(issue => issue.sourceId === "optional" || issue.sourceId === "core.files"));
      const manifest = session.status(true).diagnostics.recentEvents.find(record => record.event === "quality.context.manifest")?.fields.data as Record<string, unknown> | undefined;
      assert.ok(manifest !== undefined, "an assembled-context manifest is emitted");
      assert.ok((manifest["itemCount"] as number) >= 1);
      assert.equal(manifest["coverage"], "complete");
    } finally {
      await session.retire("quit");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-T02 a missing required source prevents an unqualified complete coverage result", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-required-"));
  try {
    const { session, captured } = await startEvidenceSession({
      root,
      sources: {
        required: sourceDefinition({ uris: ["required-absent.md"], role: "requirement", required: true }),
      },
      providers: [{ id: "files", use: "core.files", options: { sourceIds: ["required"] } }],
    });
    try {
      runEvidenceCheck(session);
      await new Promise(resolvePromise => setTimeout(resolvePromise, 120));
      // Accepted required-coverage correction: a complete plan refuses before
      // the evaluator is admitted when declared required material is missing.
      assert.equal(captured.length, 0, "a refused incomplete run must not reach the evaluator");
      const settled = session.status(true).diagnostics.recentEvents
        .find(record => record.event === "quality.check.settled")?.fields.data as Record<string, unknown> | undefined;
      assert.equal(settled?.["terminalReason"], "core.context-incomplete", "the refusal keeps its actual cause");
    } finally {
      await session.retire("quit");
    }
    // The same missing input under an explicit partial plan still evaluates and
    // cannot present as clean complete coverage.
    const partialRoot = await mkdtemp(join(tmpdir(), "qe-k04-required-partial-"));
    try {
      const partial = await startEvidenceSession({
        root: partialRoot,
        sources: {
          required: sourceDefinition({ uris: ["required-absent.md"], role: "requirement", required: true }),
        },
        providers: [{ id: "files", use: "core.files", options: { sourceIds: ["required"] } }],
        requiredCoverage: "partial",
      });
      try {
        runEvidenceCheck(partial.session);
        await new Promise(resolvePromise => setTimeout(resolvePromise, 120));
        assert.equal(partial.captured.length, 1);
        const snapshot = partial.captured[0]?.snapshot;
        assert.ok(snapshot !== undefined);
        assert.notEqual(snapshot.coverage.state, "complete", "required missing material cannot become a complete clean review");
        assert.ok(snapshot.coverage.issues.some(issue => issue.required));
        assert.equal(snapshot.items.length, 0);
      } finally {
        await partial.session.retire("quit");
      }
    } finally {
      await rm(partialRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-P04 declaration-relative origin distinguishes user and project declarations of the same filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-origin-"));
  try {
    const agentDir = join(root, "agent");
    const projectRoot = join(root, "project");
    const projectConfigDir = join(projectRoot, ".pi");
    await mkdirSyncLike(join(agentDir, "quality"), { recursive: true });
    await mkdirSyncLike(projectConfigDir, { recursive: true });
    await writeFile(join(agentDir, "quality", "shared.md"), "user-declaration-marker\n", "utf8");
    await writeFile(join(projectConfigDir, "shared.md"), "project-declaration-marker\n", "utf8");
    await writeFile(join(projectRoot, "shared.md"), "project-root-marker\n", "utf8");
    await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
      schemaVersion: 1,
      sources: {
        "user-doc": { uris: ["shared.md"], role: "requirement", required: true },
        "root-doc": { uris: ["project:shared.md"], role: "evidence", required: true },
      },
    }), "utf8");
    await writeFile(join(projectConfigDir, "quality.json"), JSON.stringify({
      schemaVersion: 1,
      sources: { "project-doc": { uris: ["shared.md"], role: "evidence", required: true } },
    }), "utf8");
    const loaded = await loadEffectiveConfiguration({ agentDir, projectConfigDir, projectTrusted: true });
    assert.equal(loaded.rejection, null, JSON.stringify(loaded.rejection));
    assert.deepEqual(loaded.resolved.sourceOrigins, { "user-doc": "user", "root-doc": "user", "project-doc": "project" });
    const evidence = new SourceEvidence(
      Object.entries(loaded.resolved.value.sources).map(([id, definition]) => {
        const origin = loaded.resolved.sourceOrigins[id] ?? "user";
        return { id, definition, origin, baseDir: origin === "project" ? projectConfigDir : join(agentDir, "quality") };
      }),
      { projectRoot, agentDir, agentQualityDir: join(agentDir, "quality") },
    );
    const userResult = await evidence.readSource("user-doc", signal);
    const projectResult = await evidence.readSource("project-doc", signal);
    const rootResult = await evidence.readSource("root-doc", signal);
    assert.equal(userResult.ok && projectResult.ok && rootResult.ok, true);
    if (!userResult.ok || !projectResult.ok || !rootResult.ok) return;
    assert.ok(JSON.stringify(userResult.value.items).includes("user-declaration-marker"));
    assert.ok(JSON.stringify(projectResult.value.items).includes("project-declaration-marker"));
    assert.ok(JSON.stringify(rootResult.value.items).includes("project-root-marker"));
    assert.ok(userResult.value.items[0]?.provenance.uri.includes("agent"));
    assert.ok(projectResult.value.items[0]?.provenance.uri.includes(".pi"));
    assert.ok(rootResult.value.items[0]?.provenance.uri.includes("/project/shared.md"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-R1 a symlink alias to a protected in-root target is denied before reading", async () => {
  const paths = await fixtureRoot();
  try {
    await writeFile(join(paths.projectRoot, "synthetic.pem"), "QE_PRIVATE_CANARY\n", "utf8");
    await symlink(join(paths.projectRoot, "synthetic.pem"), join(paths.projectRoot, "ordinary-alias.md"));
    const evidence = new SourceEvidence([
      { id: "doc", definition: sourceDefinition({ uris: ["ordinary-alias.md"], required: true }), origin: "project", baseDir: paths.projectRoot },
    ], { projectRoot: paths.projectRoot, agentDir: paths.agentDir, agentQualityDir: paths.agentQualityDir });
    const result = await evidence.readSource("doc", signal);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.items.length, 0);
      assert.ok(result.value.coverage.issues.some(issue => issue.reason === "core.source-protected"));
      assert.equal(JSON.stringify(result.value).includes("QE_PRIVATE_CANARY"), false);
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("K04-R2 include:selected returns only the exact requested heading section", async () => {
  const paths = await fixtureRoot();
  try {
    await writeFile(join(paths.projectRoot, "sections.md"), "# Included\nSELECTED_ALLOWED\n# Excluded\nUNSELECTED_CANARY\n", "utf8");
    const evidence = new SourceEvidence([
      { id: "doc", definition: sourceDefinition({ uris: ["sections.md"], include: "selected", sections: ["Included"] }), origin: "project", baseDir: paths.projectRoot },
    ], { projectRoot: paths.projectRoot, agentDir: paths.agentDir, agentQualityDir: paths.agentQualityDir });
    const result = await evidence.readSource("doc", signal);
    assert.equal(result.ok, true);
    if (result.ok) {
      const text = JSON.stringify(result.value.items);
      assert.ok(text.includes("SELECTED_ALLOWED"));
      assert.equal(text.includes("UNSELECTED_CANARY"), false);
      assert.equal((result.value.items[0]?.provenance.selection as { kind: string }).kind, "sections");
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("K04-R3 a pinned requirement keeps the approved episode body after an executor edit", async () => {
  const paths = await fixtureRoot();
  try {
    await writeFile(join(paths.projectRoot, "requirement.md"), "ORIGINAL_APPROVED_REQUIREMENT\n", "utf8");
    const evidence = new SourceEvidence([
      { id: "doc", definition: sourceDefinition({ uris: ["requirement.md"], role: "requirement", revisionPolicy: "pin-at-episode" }), origin: "project", baseDir: paths.projectRoot },
    ], { projectRoot: paths.projectRoot, agentDir: paths.agentDir, agentQualityDir: paths.agentQualityDir });
    const before = await evidence.readSource("doc", signal);
    assert.equal(before.ok, true);
    await writeFile(join(paths.projectRoot, "requirement.md"), "EXECUTOR_REPEALED_REQUIREMENT\n", "utf8");
    const after = await evidence.readSource("doc", signal);
    assert.equal(after.ok, true);
    if (after.ok) {
      const text = JSON.stringify(after.value.items);
      assert.ok(text.includes("ORIGINAL_APPROVED_REQUIREMENT"));
      assert.equal(text.includes("EXECUTOR_REPEALED_REQUIREMENT"), false);
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("K04-R1/R4 Git skips protected untracked files and retains the dirty starting body", async () => {
  const paths = await fixtureRoot();
  try {
    git(paths.projectRoot, ["init", "--quiet"]);
    git(paths.projectRoot, ["config", "user.email", "fixture@example.invalid"]);
    git(paths.projectRoot, ["config", "user.name", "Fixture"]);
    await writeFile(join(paths.projectRoot, "tracked.txt"), "HEAD_BODY\n", "utf8");
    git(paths.projectRoot, ["add", "tracked.txt"]);
    git(paths.projectRoot, ["commit", "--quiet", "-m", "baseline"]);
    const evidence = new GitEpisodeEvidence(paths.projectRoot);
    await writeFile(join(paths.projectRoot, "tracked.txt"), "PREEXISTING_DIRTY_BODY_NOT_IN_HEAD\n", "utf8");
    evidence.captureBaseline();
    await writeFile(join(paths.projectRoot, "tracked.txt"), "EPISODE_CURRENT_BODY\n", "utf8");
    await writeFile(join(paths.projectRoot, "synthetic.pem"), "PROTECTED_GIT_CANARY\n", "utf8");
    const batch = evidence.collectChanges({ paths: ["**"], includeUntracked: true, maxFiles: 16, maxBytes: 65_536 });
    assert.equal(batch.ok, true);
    if (batch.ok) {
      const text = JSON.stringify({ batch });
      assert.ok(text.includes("PREEXISTING_DIRTY_BODY_NOT_IN_HEAD"), "the dirty starting body is retained, not reconstructed from HEAD");
      assert.equal(text.includes("PROTECTED_GIT_CANARY"), false, "protected untracked content is not acquired");
      assert.ok(batch.value.coverage.issues.some(issue => issue.reason === "core.git-protected-omitted"));
    }
  } finally {
    await rm(paths.root, { recursive: true, force: true });
  }
});

test("K04-R1 protected tracked baseline is never physically read", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-git-prot-"));
  try {
    const project = join(root, "project");
    await mkdirSyncLike(project, { recursive: true });
    git(project, ["init", "--quiet"]);
    git(project, ["config", "user.email", "fixture@example.invalid"]);
    git(project, ["config", "user.name", "Fixture"]);
    await writeFile(join(project, "synthetic.pem"), "COMMITTED_PLACEHOLDER\n", "utf8");
    git(project, ["add", "synthetic.pem"]);
    git(project, ["commit", "--quiet", "-m", "baseline"]);
    await writeFile(join(project, "synthetic.pem"), "PROTECTED_BASELINE_CANARY\n", "utf8");
    const collector = new GitEpisodeEvidence(project);
    const baseline = collector.captureBaseline();
    assert.equal(JSON.stringify(baseline).includes("PROTECTED_BASELINE_CANARY"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-R1 a protected committed episode body is never acquired", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-git-committed-"));
  try {
    const project = join(root, "project");
    await mkdirSyncLike(project, { recursive: true });
    git(project, ["init", "--quiet"]);
    git(project, ["config", "user.email", "fixture@example.invalid"]);
    git(project, ["config", "user.name", "Fixture"]);
    await writeFile(join(project, "synthetic.pem"), "COMMITTED_PLACEHOLDER\n", "utf8");
    git(project, ["add", "synthetic.pem"]);
    git(project, ["commit", "--quiet", "-m", "baseline"]);
    const collector = new GitEpisodeEvidence(project);
    collector.captureBaseline();
    await writeFile(join(project, "synthetic.pem"), "PROTECTED_COMMITTED_CANARY\n", "utf8");
    git(project, ["add", "synthetic.pem"]);
    git(project, ["commit", "--quiet", "-m", "episode commit"]);
    assert.equal(git(project, ["status", "--porcelain"]).trim(), "");
    const batch = collector.collectChanges({ paths: ["**"], includeUntracked: true, maxFiles: 16, maxBytes: 65_536 });
    assert.equal(batch.ok, true);
    if (batch.ok) {
      assert.equal(JSON.stringify(batch.value.items).includes("PROTECTED_COMMITTED_CANARY"), false);
      assert.ok(batch.value.coverage.issues.some(issue => issue.reason === "core.git-protected-omitted"));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-R4 pre-existing untracked and staged starting bodies are retained", async () => {
  const root = await mkdtemp(join(tmpdir(), "qe-k04-git-layers-"));
  try {
    const project = join(root, "project");
    await mkdirSyncLike(project, { recursive: true });
    git(project, ["init", "--quiet"]);
    git(project, ["config", "user.email", "fixture@example.invalid"]);
    git(project, ["config", "user.name", "Fixture"]);
    await writeFile(join(project, "tracked.txt"), "HEAD_BASELINE\n", "utf8");
    git(project, ["add", "tracked.txt"]);
    git(project, ["commit", "--quiet", "-m", "baseline"]);
    await writeFile(join(project, "untracked.txt"), "PREEXISTING_UNTRACKED_ORIGINAL_BODY\n", "utf8");
    await writeFile(join(project, "tracked.txt"), "PREEXISTING_INDEX_ONLY_BODY\n", "utf8");
    git(project, ["add", "tracked.txt"]);
    await writeFile(join(project, "tracked.txt"), "PREEXISTING_WORKTREE_BODY\n", "utf8");
    const collector = new GitEpisodeEvidence(project);
    collector.captureBaseline();
    await writeFile(join(project, "untracked.txt"), "CURRENT_UNTRACKED_BODY\n", "utf8");
    await writeFile(join(project, "tracked.txt"), "EPISODE_NEW_INDEX_BODY\n", "utf8");
    git(project, ["add", "tracked.txt"]);
    await writeFile(join(project, "tracked.txt"), "EPISODE_CURRENT_WORKTREE_BODY\n", "utf8");
    const batch = collector.collectChanges({ paths: ["**"], includeUntracked: true, maxFiles: 24, maxBytes: 131_072 });
    assert.equal(batch.ok, true);
    if (batch.ok) {
      const text = JSON.stringify({ baseline: collector.baseline, batch });
      assert.ok(text.includes("PREEXISTING_UNTRACKED_ORIGINAL_BODY"), "initial untracked layer is retained");
      assert.ok(text.includes("PREEXISTING_INDEX_ONLY_BODY"), "initial index layer is retained");
      assert.ok(text.includes("PREEXISTING_WORKTREE_BODY"), "initial worktree layer is retained");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("K04-R11 the prompt provider reads a permitted local resource and denies protected targets", async () => {
  const { createPromptFilesProvider } = await import("../src/builtins/prompts.js");
  const { pathToFileURL } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "qe-k04-prompt-"));
  try {
    const project = join(root, "project");
    const agent = join(root, "agent");
    await mkdir(join(agent, "quality", "state"), { recursive: true });
    await mkdir(project, { recursive: true });
    const allowed = join(project, "owner-prompt.md");
    await writeFile(allowed, "QE_PRIVATE_R8_ALLOWED_PROMPT\n", "utf8");
    const protectedFile = join(agent, "quality", "state", "secret.md");
    await writeFile(protectedFile, "QE_PRIVATE_R8_PROTECTED\n", "utf8");
    const evidence = new SourceEvidence([], { projectRoot: project, agentDir: agent, agentQualityDir: join(agent, "quality") });
    const ctx = { scope: {}, signal: new AbortController().signal, evidence } as never;
    const provider = createPromptFilesProvider(join(process.cwd(), "resources"));
    const ok = await provider.build({ instructions: [pathToFileURL(allowed).href] }, ctx);
    assert.equal(ok.ok, true);
    if (ok.ok) {
      const text = JSON.stringify(ok.value.instructions);
      assert.ok(text.includes("QE_PRIVATE_R8_ALLOWED_PROMPT"));
      const expectedRevision = createHash("sha256").update("QE_PRIVATE_R8_ALLOWED_PROMPT\n", "utf8").digest("hex").slice(0, 32);
      assert.equal(ok.value.instructions[0]?.provenance.revision, expectedRevision, "the exact content revision is reported");
    }
    const denied = await provider.build({ instructions: [pathToFileURL(protectedFile).href] }, ctx);
    assert.equal(denied.ok, false, "a protected target must be denied before any read");
    if (!denied.ok) assert.equal(denied.error.code, "core.prompt-resource-missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
