import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { allocateEvidenceDir } from "./evidence-run.mjs";

// Collects complete candidate evidence: every deliverable source/test/script/
// package file digest, the actual installed host SDK bytes, and the manifest
// that binds them to the environment. Run after the affected checks so the
// digests describe exactly the tested working tree.

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceDir = allocateEvidenceDir();
console.log(`QE_EVIDENCE_DIR=${evidenceDir}`);
mkdirSync(evidenceDir, { recursive: true });
const SKIP_DIRECTORIES = new Set(["node_modules", "dist", ".test-build", "donors", "verification", ".serena", ".git", "logs"]);
const CANDIDATE_ROOTS = ["src", "test", "scripts", "resources", "examples"];
const CANDIDATE_FILES = [
  "package.json", "package-lock.json", "tsconfig.json", "tsconfig.test.json",
  "README.md", "THIRD_PARTY_NOTICES.md", ".gitignore",
];
const SDK_FILES = [
  "package.json",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/core/extensions/types.d.ts",
  "dist/core/extensions/runner.js",
  "dist/core/extensions/runner.d.ts",
  "dist/config.js",
  "dist/config.d.ts",
];

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function walk(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      files.push(...walk(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

const candidateFiles = [
  ...CANDIDATE_ROOTS.flatMap(root => (existsSync(join(packageRoot, root)) ? walk(join(packageRoot, root)) : [])),
  ...CANDIDATE_FILES.filter(name => existsSync(join(packageRoot, name))).map(name => join(packageRoot, name)),
].sort();

const candidateDigests = candidateFiles.map(path => {
  const bytes = readFileSync(path);
  return { path: relative(packageRoot, path).split("\\").join("/"), bytes: bytes.length, sha256: sha256(bytes) };
});
const candidateDigest = sha256(candidateDigests.map(entry => `${entry.sha256}  ${entry.path}\n`).join(""));

const hostRoot = join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent");
const hostManifest = JSON.parse(readFileSync(join(hostRoot, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(join(packageRoot, "package-lock.json"), "utf8"));
const lockEntry = lock.packages?.["node_modules/@earendil-works/pi-coding-agent"];
const sdkIdentity = {
  source: {
    baselinePin: "c661bc574f9e9713cc2af567fc1ac00621377a0c",
    relation: "matching source manifest version; exact npm/Git byte equivalence not claimed",
  },
  host: {
    package: hostManifest.name,
    version: hostManifest.version,
    npmIntegrity: lockEntry?.integrity ?? "unknown",
    files: Object.fromEntries(SDK_FILES.map(name => [name, sha256(readFileSync(join(hostRoot, name)))])),
  },
  node: process.version,
  os: `${process.platform} ${process.arch}`,
};

const tarballInventoryPath = join(evidenceDir, "package-inventory.json");
const tarball = existsSync(tarballInventoryPath)
  ? (() => {
    const inventory = JSON.parse(readFileSync(tarballInventoryPath, "utf8"));
    return { ...inventory.tarball, inventory: inventory.inventory };
  })()
  : null;
const gitStatus = execFileSync("git", ["status", "--porcelain=v1"], { cwd: packageRoot, encoding: "utf8" })
  .trim().split("\n").filter(Boolean);

function npmVersion() {
  const npmCliCandidates = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter(Boolean);
  try {
    const npmCli = npmCliCandidates.find(candidate => existsSync(candidate));
    if (npmCli) return execFileSync(process.execPath, [npmCli, "--version"], { encoding: "utf8" }).trim();
    const fromAgent = process.env.npm_config_user_agent?.match(/npm\/([^\s]+)/)?.[1];
    if (fromAgent) return fromAgent;
  } catch {
    return "unknown";
  }
  return "unknown";
}

const manifest = {
  checkpoint: "K02",
  projectVersion: JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version,
  baseCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: packageRoot, encoding: "utf8" }).trim(),
  candidateState: "uncommitted working tree; the acceptance owner owns the commit",
  candidateFileCount: candidateDigests.length,
  candidateDigest,
  environment: {
    os: `${process.platform} ${process.arch} ${execFileSync(process.execPath, ["-e", "process.stdout.write(require('os').release())"], { encoding: "utf8" })}`,
    node: process.version,
    npm: npmVersion(),
  },
  gitStatus,
  sdk: sdkIdentity,
  artifacts: {
    tarball,
    evidenceFiles: readdirSync(evidenceDir).sort(),
  },
  evidenceCommand: "node scripts/collect-evidence.mjs",
};

mkdirSync(evidenceDir, { recursive: true });
writeFileSync(join(evidenceDir, "candidate-bytes.json"), `${JSON.stringify({ candidateDigest, files: candidateDigests }, null, 2)}\n`, "utf8");
writeFileSync(join(evidenceDir, "sdk-identity.json"), `${JSON.stringify(sdkIdentity, null, 2)}\n`, "utf8");
writeFileSync(join(evidenceDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`candidate files: ${candidateDigests.length}, digest ${candidateDigest.slice(0, 16)}...`);
console.log(`host SDK: ${hostManifest.name}@${hostManifest.version} integrity ${String(sdkIdentity.host.npmIntegrity).slice(0, 24)}...`);
console.log(`tarball: ${tarball ? `${tarball.filename} sha256 ${tarball.sha256.slice(0, 16)}...` : "not retained yet"}`);
console.log(`evidence: ${manifest.artifacts.evidenceFiles.length} files in ${relative(packageRoot, evidenceDir).split("\\").join("/")}`);
