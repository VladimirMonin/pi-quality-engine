// Routing regression for the evidence-directory allocation.
//
// A control file is left in a prior author run directory. A real producer
// boundary (`scripts/test-isolated.mjs`, which previously carried a stale
// checkpoint fallback) is then executed with no explicit destination. The
// check proves that the producer received a new fresh run directory and that
// the prior control bytes stayed identical.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { allocateEvidenceDir } from "./evidence-run.mjs";

const digest = bytes => createHash("sha256").update(bytes).digest("hex");

const controlDir = allocateEvidenceDir();
const controlPath = join(controlDir, "routing-control.txt");
const controlBytes = Buffer.from("K03 evidence routing control: prior-stage bytes must remain identical\n", "utf8");
writeFileSync(controlPath, controlBytes);
const before = digest(readFileSync(controlPath));

const env = {};
for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "PATHEXT", "SYSTEMDRIVE", "TMPDIR", "TEMP", "TMP", "QE_CHECKPOINT"]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
delete env.QE_EVIDENCE_DIR;
env.QE_TEST_FILES = process.env.QE_TEST_FILES ?? "test/pi.test.mjs";
const result = spawnSync(process.execPath, ["scripts/test-isolated.mjs"], {
  cwd: process.cwd(),
  env,
  encoding: "utf8",
  timeout: 120_000,
  maxBuffer: 8_000_000,
});
const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const marker = output.split(/\r?\n/u).find(line => line.startsWith("QE_EVIDENCE_DIR="));
assert.ok(marker, `producer did not report its evidence directory:\n${output}`);
const producerDir = marker.slice("QE_EVIDENCE_DIR=".length).trim();
const after = digest(readFileSync(controlPath));
assert.equal(after, before, "a later producer run changed prior-stage control bytes");
assert.notEqual(producerDir, controlDir, "every execution must allocate a new directory");
assert.ok(existsSync(producerDir), "the producer evidence directory must exist");
assert.ok(
  relative(join(process.cwd(), "verification", process.env.QE_CHECKPOINT ?? "K03", "author"), producerDir).split(/[\\/]/u).length === 1,
  `the fresh run directory must be an author run below verification/K03/author (${producerDir})`,
);
const evidenceFiles = readdirSync(producerDir).sort();
assert.ok(evidenceFiles.length > 0, "the producer wrote at least one evidence file into its fresh directory");

writeFileSync(join(producerDir, "routing-check.json"), `${JSON.stringify({
  check: "K03 evidence routing producer regression",
  priorStageControl: {
    directory: controlDir,
    file: "routing-control.txt",
    sha256Before: before,
    sha256After: after,
    unchanged: before === after,
  },
  producer: {
    command: `node scripts/test-isolated.mjs (QE_TEST_FILES=${env.QE_TEST_FILES}, no explicit QE_EVIDENCE_DIR)`, 
    directory: producerDir,
    exit: result.status,
    evidenceFiles,
  },
}, null, 2)}\n`, "utf8");
console.log(`evidence-routing-check: prior control unchanged; fresh producer directory ${producerDir}`);
process.exitCode = result.status ?? 1;
