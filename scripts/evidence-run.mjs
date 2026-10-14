// Fresh evidence-run allocation.
//
// Every execution writes into its own new directory under
// `verification/<checkpoint>/<role>/<run-id>/`. An explicitly supplied
// `QE_EVIDENCE_DIR` is propagated exactly as given (reviewer runs, owner
// replays); otherwise the producer allocates the next author run directory.
// Cleanup stays the responsibility of the producer that created its own
// temporary workspace; this helper never deletes anything.

import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export function newRunId() {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/gu, "").slice(0, 17);
  return `${stamp}-p${process.pid}-${randomBytes(3).toString("hex")}`;
}

export function allocateEvidenceDir(options = {}) {
  const explicit = options.explicit ?? process.env.QE_EVIDENCE_DIR;
  if (typeof explicit === "string" && explicit.trim() !== "") {
    const directory = resolve(explicit);
    mkdirSync(directory, { recursive: true });
    return directory;
  }
  const checkpoint = options.checkpoint ?? process.env.QE_CHECKPOINT ?? "K03";
  const role = options.role ?? process.env.QE_EVIDENCE_ROLE ?? "author";
  const directory = join(process.cwd(), "verification", checkpoint, role, newRunId());
  mkdirSync(directory, { recursive: true });
  return directory;
}
