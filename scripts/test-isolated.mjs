import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { allocateEvidenceDir } from "./evidence-run.mjs";

// Only the test subprocess uses this environment. Never change operator Pi settings.
const root = mkdtempSync(join(tmpdir(), "quality-environment-"));
const env = {};
for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC",
  "PATHEXT", "SYSTEMDRIVE", "TMPDIR", "TEMP", "TMP"]) {
  if (process.env[name] !== undefined) env[name] = process.env[name];
}
env.HOME = root;
env.USERPROFILE = root;
env.APPDATA = join(root, "appdata");
env.LOCALAPPDATA = join(root, "localappdata");
env.PI_CODING_AGENT_DIR = join(root, "agent");
// Every execution writes into its own fresh run directory; an explicit
// QE_EVIDENCE_DIR (reviewer run, owner replay) is propagated exactly.
env.QE_EVIDENCE_DIR = allocateEvidenceDir();
console.log(`QE_EVIDENCE_DIR=${env.QE_EVIDENCE_DIR}`);
if (process.argv[2]) env.QE_PACKAGE_ROOT = process.argv[2];
const defaultFiles = [
  "test/pi.test.mjs", "test/primary.test.mjs", "test/loop-host.test.mjs", "test/k04-host.test.mjs",
  "test/repair-boundaries.test.mjs", "test/repair2-boundaries.test.mjs", "test/repair3-boundaries.test.mjs",
];
const files = process.env.QE_TEST_FILES
  ? process.env.QE_TEST_FILES.split(",").map(name => name.trim()).filter(Boolean)
  : defaultFiles;
try {
  const result = spawnSync(process.execPath, ["--test", ...files], {
    env, stdio: "inherit", timeout: 120000,
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
