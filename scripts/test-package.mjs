import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { allocateEvidenceDir } from "./evidence-run.mjs";

// Pack the candidate, install it with its declared host peer into a clean
// consumer root outside this repository, and load the installed artifact
// through the real Pi extension path. No live model route is involved.
//
// Provisioning runs with an explicitly isolated npm environment: an allowlisted
// process environment, empty user/global npm configuration and a dedicated
// package cache. It never reads personal npm or Pi settings.

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
function resolveNpm() {
  const candidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  const cli = candidates.find(candidate => existsSync(candidate));
  if (cli !== undefined) return { command: process.execPath, prefix: [cli], shell: false };
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    prefix: [],
    shell: process.platform === "win32",
  };
}

const npm = resolveNpm();
const workDir = mkdtempSync(join(tmpdir(), "qe-package-"));
const packDir = join(workDir, "pack");
const consumer = join(workDir, "consumer");
const evidenceDir = allocateEvidenceDir();
console.log(`QE_EVIDENCE_DIR=${evidenceDir}`);
const HOST_PEER = "@earendil-works/pi-coding-agent@1.1.0";

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isolatedNpmEnvironment() {
  const home = join(workDir, "npm-home");
  mkdirSync(join(home, "appdata"), { recursive: true });
  mkdirSync(join(home, "localappdata"), { recursive: true });
  mkdirSync(join(home, "npm-cache"), { recursive: true });
  writeFileSync(join(home, "user.npmrc"), "", "utf8");
  writeFileSync(join(home, "global.npmrc"), "", "utf8");
  const env = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "PATHEXT", "SYSTEMDRIVE", "TMPDIR", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "appdata"),
    LOCALAPPDATA: join(home, "localappdata"),
    npm_config_userconfig: join(home, "user.npmrc"),
    npm_config_globalconfig: join(home, "global.npmrc"),
    npm_config_cache: join(home, "npm-cache"),
  });
  return env;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 300_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function runNpm(args, options = {}) {
  return run(npm.command, [...npm.prefix, ...args], { env: isolatedNpmEnvironment(), shell: npm.shell, ...options });
}

function consumerEnvironment() {
  const env = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
    "PATHEXT", "SYSTEMDRIVE", "TMPDIR", "TEMP", "TMP"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  const home = join(consumer, "fixture", "home");
  const temp = join(consumer, "fixture", "tmp");
  env.HOME = home;
  env.USERPROFILE = home;
  env.APPDATA = join(home, "appdata");
  env.LOCALAPPDATA = join(home, "localappdata");
  env.TEMP = temp;
  env.TMP = temp;
  env.TMPDIR = temp;
  env.PI_CODING_AGENT_DIR = join(consumer, "fixture", "agent");
  env.GIT_CEILING_DIRECTORIES = consumer;
  return env;
}

try {
  mkdirSync(packDir, { recursive: true });
  const packResult = runNpm(["pack", "--json", "--pack-destination", packDir], { cwd: packageRoot });
  const packInfo = JSON.parse(packResult.stdout)[0];
  assert.equal(packInfo.name, "pi-quality-engine");
  assert.equal(packInfo.version, "0.6.0");
  const paths = packInfo.files.map(file => file.path);
  for (const required of ["package.json", "README.md", "THIRD_PARTY_NOTICES.md", "dist/index.js", "dist/contracts.js", "resources/prompts/repetition-v1.md", "resources/prompts/progress-v1.md", "resources/prompts/progress-v1.questions.json", "resources/prompts/engineering-v1.md", "resources/prompts/evaluation-v1.schema.json", "resources/prompts/feedback-v1.md", "examples/independent-extension/package.json", "examples/independent-extension/extension.mjs", "examples/independent-extension/resources/k08-context.md", "examples/independent-extension/resources/k08-prompt.md"]) {
    assert.ok(paths.includes(required), `packed artifact is missing ${required}`);
  }
  for (const path of paths) {
    assert.equal(path.startsWith("src/") || path.startsWith("test/") || path.startsWith("scripts/"), false, `packed artifact leaks ${path}`);
    assert.equal(path.startsWith("donors/") || path.startsWith("verification/") || path.startsWith(".test-build/"), false, `packed artifact leaks ${path}`);
    assert.equal(path.includes("node_modules/"), false, `packed artifact bundles ${path}`);
  }
  const tarballPath = join(packDir, packInfo.filename);
  assert.equal(existsSync(tarballPath), true);
  const tarballSha256 = sha256File(tarballPath);

  // Retain the actual tested tarball with the candidate evidence.
  mkdirSync(evidenceDir, { recursive: true });
  const retainedTarball = join(evidenceDir, packInfo.filename);
  cpSync(tarballPath, retainedTarball);

  mkdirSync(consumer, { recursive: true });
  mkdirSync(join(consumer, "fixture", "home", "appdata"), { recursive: true });
  mkdirSync(join(consumer, "fixture", "tmp"), { recursive: true });
  // Reproduce the pinned host dependency set recorded in this repository's
  // manifest; without these overrides npm would resolve a newer host family.
  const rootManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const consumerManifest = {
    name: "pi-quality-package-consumer",
    version: "0.0.0",
    private: true,
    type: "module",
  };
  if (rootManifest.overrides) consumerManifest.overrides = rootManifest.overrides;
  writeFileSync(join(consumer, "package.json"), `${JSON.stringify(consumerManifest, null, 2)}\n`, "utf8");
  runNpm(["install", "--prefer-offline", "--ignore-scripts", "--no-audit", "--no-fund",
    "--no-save", "--no-package-lock", tarballPath, HOST_PEER], { cwd: consumer });

  cpSync(join(packageRoot, "test", "package-consumer", "run.mjs"), join(consumer, "run.mjs"));
  const consumerResult = run(process.execPath, ["run.mjs"], { cwd: consumer, env: consumerEnvironment() });
  const markerLine = consumerResult.stdout.split(/\r?\n/).find(line => line.startsWith("QE_CONSUMER_REPORT="));
  assert.ok(markerLine, `consumer report missing from stdout:\n${consumerResult.stdout}\n${consumerResult.stderr}`);
  const report = JSON.parse(markerLine.slice("QE_CONSUMER_REPORT=".length));
  assert.equal(report.ok, true);
  assert.equal(report.packageVersion, "0.6.0");
  assert.equal(report.hostVersion, "1.1.0");
  assert.equal(report.peerRange, "*");
  assert.deepEqual(report.loadErrors, []);
  assert.deepEqual(report.commandNames, ["quality"]);
  assert.deepEqual(report.handlerEvents, [
    "agent_before_settle", "agent_settled", "before_agent_start", "before_provider_request",
    "input", "session_shutdown", "session_start", "tool_execution_end",
    "tool_execution_start", "turn_end",
  ]);
  assert.equal(report.toolCount, 0);
  // K05 installed reviewer witness (preliminary while traversal is unresolved).
  const k05Line = consumerResult.stdout.split(String.fromCharCode(10)).map(line => line.replace(String.fromCharCode(13), "")).find(line => line.startsWith("QE_CONSUMER_K05="));
  assert.ok(k05Line, `installed reviewer witness missing from consumer stdout:
${consumerResult.stdout}
${consumerResult.stderr}`);
  const k05 = JSON.parse(k05Line.slice("QE_CONSUMER_K05=".length));
  assert.equal(k05.version, "0.6.0");
  assert.equal(k05.entryIsolated, true, "the reviewer ran from the installed artifact inside the consumer root");
  assert.equal(k05.arrivals, 2, "the installed reviewer used the scripted provider for its read and result turns");
  assert.equal(k05.bodyDelivered, true, "the installed reviewer's permitted read reached a later provider input");
  assert.equal(k05.canonicalAccepted, true, "the installed artifact accepted the canonical submission");
  assert.equal(k05.runs, 1, "the installed artifact ran exactly one reviewer for the eligible completion");
  assert.equal(Number(k05.ownedRequests) >= 2, true, "the installed reviewer's owned requests settled through the shared ledger");
  assert.deepEqual(report.statuses, { inactive: "inactive", active: "active", retired: "retired" });
  assert.deepEqual(report.eventNames, [
    "quality.runtime.started", "quality.config.applied", "quality.runtime.retired", "quality.journal.closed",
  ]);
  assert.deepEqual(report.effectCounts, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 });
  assert.ok(report.fixtureFilesCreated.every(entry => /^agent[\\/]quality([\\/]state.*)?$/u.test(entry)),
    `the installed engine only adds its control checkpoint (${report.fixtureFilesCreated.join(",")})`);
  assert.equal(report.resourcesResolved, true);
  assert.ok(report.installedLoopRuns >= 1);
  assert.ok(report.promptResourceRefs.includes("builtin:repetition-v1.md"));
  assert.equal(report.journalFiles.length, 1);

  const evidence = {
    checkpoint: "K02",
    case: "K02-T04",
    tarball: {
      filename: packInfo.filename,
      retainedAt: retainedTarball,
      sha256: tarballSha256,
      integrity: packInfo.integrity,
      shasum: packInfo.shasum,
      size: packInfo.size,
      unpackedSize: packInfo.unpackedSize,
      inventory: paths,
    },
    provisioning: {
      environment: "allowlisted process environment, empty npm user/global config, dedicated npm cache",
      installedHostPeer: HOST_PEER,
      networkPolicy: "package-manager dependency acquisition only; no model/API traffic",
    },
    consumer: report,
    // K05 installed-artifact reviewer witness. Truthful additional labeling:
    // the legacy K02 consumer report above is retained unchanged, while these
    // fields record the K05 reviewer read->canonical-submit case that actually
    // ran in the same installed consumer. PRELIMINARY while the traversal
    // question is unresolved; this is not the final common/package gate.
    k05: {
      checkpoint: "K05",
      case: "K05-installed-reviewer-read-submit",
      preliminary: true,
      sourceIdentity: {
        headCommit: (() => {
          try {
            const rev = spawnSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" });
            return rev.status === 0 ? rev.stdout.trim() : null;
          } catch { return null; }
        })(),
        // HEAD alone cannot identify a dirty candidate. Bind only published
        // payloads and explicit candidate inputs; other dirt is path/status-only.
        // Never open unrelated receipts, credentials or operator files.
        dirtyFiles: (() => {
          try {
            const diff = spawnSync("git", ["status", "--porcelain"], { cwd: packageRoot, encoding: "utf8" });
            const lines = (diff.status === 0 ? diff.stdout : "")
              .split(String.fromCharCode(10)).filter(line => line.trim().length > 0);
            const identityPaths = new Set([...paths,
              "src/journal.ts", "src/checkpoint.ts", "src/runtime.ts", "src/models.ts", "src/diagnostics.ts",
              "test/k07-host.test.mjs", "test/k07-storage.test.mjs", "test/k07-recovery.test.mjs",
              "package-lock.json", "tsconfig.json", "tsconfig.test.json",
              "scripts/test-package.mjs", "scripts/evidence-routing-check.mjs",
            ]);
            return lines.map(line => {
              const path = line.slice(3).trim();
              if (!identityPaths.has(path)) return { status: line.slice(0, 2).trim(), path, contentIdentity: "not-inspected" };
              try {
                const bytes = readFileSync(join(packageRoot, path));
                return { status: line.slice(0, 2).trim(), path, sha256: createHash("sha256").update(bytes).digest("hex") };
              } catch {
                return { status: line.slice(0, 2).trim(), path, sha256: null };
              }
            });
          } catch { return []; }
        })(),
      },
      tarball: {
        filename: packInfo.filename,
        sha256: tarballSha256,
        integrity: packInfo.integrity,
        shasum: packInfo.shasum,
        files: paths.length,
        version: packInfo.version,
      },
      witness: {
        packageVersion: k05.version,
        isolatedEntry: k05.entryIsolated,
        providerArrivals: k05.arrivals,
        readBodyDeliveredToLaterInput: k05.bodyDelivered,
        canonicalResultAccepted: k05.canonicalAccepted,
        primaryRuns: k05.runs,
        ownedRequests: k05.ownedRequests,
      },
      command: {
        packageScript: "scripts/test-package.mjs",
        consumerEntry: "test/package-consumer/run.mjs",
        consumerExit: 0,
        packageExit: 0,
      },
      consumerStdout: consumerResult.stdout,
      consumerStderr: consumerResult.stderr,
    },
  };
  writeFileSync(join(evidenceDir, "package-consumer.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  writeFileSync(join(evidenceDir, "package-inventory.json"), `${JSON.stringify({
    tarball: { filename: packInfo.filename, sha256: tarballSha256, integrity: packInfo.integrity, shasum: packInfo.shasum, size: packInfo.size, unpackedSize: packInfo.unpackedSize },
    inventory: paths,
  }, null, 2)}\n`, "utf8");

  console.log(`packed ${packInfo.filename} (${paths.length} files, sha256 ${tarballSha256.slice(0, 16)}...)`);
  console.log(`installed host peer ${HOST_PEER} into an isolated consumer and loaded ${report.entryPath}`);
  console.log("K02-T04 package consumer assertions passed");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
