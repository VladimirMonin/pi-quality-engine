import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Pack the candidate, install it with its declared host peer into a clean
// consumer root outside this repository, and load the installed artifact
// through the real Pi extension path. No live model route is involved.
//
// Provisioning runs with an explicitly isolated npm environment: an allowlisted
// process environment, empty user/global npm configuration and a dedicated
// package cache. It never reads personal npm or Pi settings.

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.env.npm_execpath
  ? [process.execPath, process.env.npm_execpath]
  : [process.platform === "win32" ? "npm.cmd" : "npm"];
const workDir = mkdtempSync(join(tmpdir(), "qe-package-"));
const packDir = join(workDir, "pack");
const consumer = join(workDir, "consumer");
const evidenceDir = join(packageRoot, "verification", "K01");
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
  return run(npm[0], [...npm.slice(1), ...args], { env: isolatedNpmEnvironment(), ...options });
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
  return env;
}

try {
  mkdirSync(packDir, { recursive: true });
  const packResult = runNpm(["pack", "--json", "--pack-destination", packDir], { cwd: packageRoot });
  const packInfo = JSON.parse(packResult.stdout)[0];
  assert.equal(packInfo.name, "pi-quality-engine");
  assert.equal(packInfo.version, "0.0.1");
  const paths = packInfo.files.map(file => file.path);
  for (const required of ["package.json", "README.md", "THIRD_PARTY_NOTICES.md", "dist/index.js", "dist/contracts.js"]) {
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
  assert.equal(report.packageVersion, "0.0.1");
  assert.equal(report.hostVersion, "1.1.0");
  assert.equal(report.peerRange, "*");
  assert.deepEqual(report.loadErrors, []);
  assert.deepEqual(report.commandNames, ["quality"]);
  assert.deepEqual(report.handlerEvents, ["session_shutdown", "session_start"]);
  assert.equal(report.toolCount, 0);
  assert.deepEqual(report.statuses, { inactive: "inactive", active: "active", retired: "retired" });
  assert.deepEqual(report.eventNames, ["quality.runtime.started", "quality.runtime.retired"]);
  assert.deepEqual(report.effectCounts, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 });
  assert.deepEqual(report.fixtureFilesCreated, []);

  const evidence = {
    checkpoint: "K01",
    case: "K01-T04",
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
  };
  writeFileSync(join(evidenceDir, "package-consumer.json"), `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  writeFileSync(join(evidenceDir, "package-inventory.json"), `${JSON.stringify({
    tarball: { filename: packInfo.filename, sha256: tarballSha256, integrity: packInfo.integrity, shasum: packInfo.shasum, size: packInfo.size, unpackedSize: packInfo.unpackedSize },
    inventory: paths,
  }, null, 2)}\n`, "utf8");

  console.log(`packed ${packInfo.filename} (${paths.length} files, sha256 ${tarballSha256.slice(0, 16)}...)`);
  console.log(`installed host peer ${HOST_PEER} into an isolated consumer and loaded ${report.entryPath}`);
  console.log("K01-T04 package consumer assertions passed");
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
