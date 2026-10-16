// Read-only episode-relative Git evidence.
//
// The collector inspects an existing repository with explicit argument arrays
// and never stages, resets, stashes or writes trees/objects. A baseline is
// captured before the episode's first collection so dirty/staged/untracked
// state is not attributed to the observed interval, and later commits remain
// visible through the baseline..HEAD range.

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { protectedReason } from "./evidence.js";
import type {
  ContextBatch,
  ContextItem,
  CoverageIssue,
  EvidenceDependency,
  JsonObject,
  Result,
} from "./contracts.js";
import { createHash } from "node:crypto";

export interface GitStatusEntry {
  path: string;
  index: string;
  worktree: string;
}

export interface GitBaseline {
  head: string | null;
  entries: GitStatusEntry[];
  untracked: string[];
  dirtyFingerprints: Record<string, string>;
  /** Bounded actual starting worktree bodies for dirty tracked files. */
  dirtyBodies: Record<string, { bytes: number; text: string } | null>;
  /** Bounded actual starting index bodies for staged tracked files. */
  stagedBodies: Record<string, { bytes: number; text: string } | null>;
  /** Bounded actual starting bodies for pre-existing untracked files. */
  untrackedBodies: Record<string, { bytes: number; text: string } | null>;
  /** True when a bounded baseline read was omitted or truncated. */
  baselinePartial: boolean;
  capturedAt: string;
}

export interface GitInvocation {
  args: readonly string[];
  exit: number | null;
}

export interface GitChangeEvidenceOptions {
  paths: readonly string[];
  includeUntracked: boolean;
  maxFiles: number;
  maxBytes: number;
}

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 8_000_000;

export class GitEpisodeEvidence {
  readonly #projectRoot: string;
  readonly #invocations: GitInvocation[] = [];
  #baseline: GitBaseline | null = null;

  constructor(projectRoot: string) {
    this.#projectRoot = projectRoot;
  }

  get baseline(): GitBaseline | null {
    return this.#baseline === null ? null : structuredClone(this.#baseline);
  }

  get invocations(): readonly GitInvocation[] {
    return this.#invocations.map(entry => ({ args: [...entry.args], exit: entry.exit }));
  }

  /** Captures the starting repository state. Read-only. */
  captureBaseline(): GitBaseline {
    const headResult = this.#git(["rev-parse", "HEAD"]);
    const head = headResult.exit === 0 ? headResult.stdout.trim() || null : null;
    const statusResult = this.#git(["status", "--porcelain=v1", "-z"]);
    const entries = statusResult.exit === 0 ? parseStatus(statusResult.stdout) : [];
    const untracked = entries.filter(entry => entry.index === "?").map(entry => entry.path);
    const dirtyFingerprints: Record<string, string> = {};
    const dirtyBodies: Record<string, { bytes: number; text: string } | null> = {};
    const stagedBodies: Record<string, { bytes: number; text: string } | null> = {};
    const untrackedBodies: Record<string, { bytes: number; text: string } | null> = {};
    let baselinePartial = false;
    let baselineBudget = 262_144;
    for (const entry of entries.slice(0, 128)) {
      // Canonical protection is applied before every baseline body read.
      if (protectedReason(join(this.#projectRoot, entry.path)) !== null) {
        baselinePartial = true;
        if (entry.index === "?") untrackedBodies[entry.path] = null;
        else {
          if (entry.index !== " " && entry.index !== "?") stagedBodies[entry.path] = null;
          dirtyBodies[entry.path] = null;
        }
        continue;
      }
      if (entry.index === "?") {
        const content = readBoundedWorktreeFile(this.#projectRoot, entry.path, Math.min(65_536, baselineBudget));
        if (content === null) {
          untrackedBodies[entry.path] = null;
          baselinePartial = true;
        } else {
          untrackedBodies[entry.path] = { bytes: Buffer.byteLength(content, "utf8"), text: content };
          baselineBudget -= Buffer.byteLength(content, "utf8");
        }
        continue;
      }
      if (entry.index !== " " && entry.index !== "?") {
        // Original index layer for a staged path, captured before any fixture
        // restaging; a later staged diff cannot reconstruct it.
        const indexBody = this.#git(["show", `:${entry.path}`]);
        const indexText = indexBody.exit === 0 ? indexBody.stdout : "";
        if (indexBody.exit === 0 && Buffer.byteLength(indexText, "utf8") <= Math.min(65_536, baselineBudget)) {
          stagedBodies[entry.path] = { bytes: Buffer.byteLength(indexText, "utf8"), text: indexText };
          baselineBudget -= Buffer.byteLength(indexText, "utf8");
        } else {
          stagedBodies[entry.path] = null;
          baselinePartial = true;
        }
      }
      const content = readBoundedWorktreeFile(this.#projectRoot, entry.path, Math.min(65_536, baselineBudget));
      if (content !== null) {
        dirtyFingerprints[entry.path] = hashText(content);
        dirtyBodies[entry.path] = { bytes: Buffer.byteLength(content, "utf8"), text: content };
        baselineBudget -= Buffer.byteLength(content, "utf8");
      } else {
        dirtyBodies[entry.path] = null;
        baselinePartial = true;
      }
    }
    this.#baseline = {
      head,
      entries,
      untracked,
      dirtyFingerprints,
      dirtyBodies,
      stagedBodies,
      untrackedBodies,
      baselinePartial,
      capturedAt: new Date().toISOString(),
    };
    return structuredClone(this.#baseline);
  }

  /** Builds bounded episode-relative change evidence. Read-only. */
  collectChanges(options: GitChangeEvidenceOptions): Result<ContextBatch> {
    if (this.#baseline === null) this.captureBaseline();
    const baseline = this.#baseline as GitBaseline;
    if (baseline.head === null && this.#git(["rev-parse", "--is-inside-work-tree"]).exit !== 0) {
      return {
        ok: true,
        value: {
          items: [],
          coverage: { state: "partial", scopeDescription: "The project root is not a readable Git work tree.", issues: [{ sourceId: "core.changes", reason: "core.git-unavailable", required: false, evidenceIds: [] }] },
          dependencies: [],
        },
      };
    }
    const items: ContextItem[] = [];
    const issues: CoverageIssue[] = [];
    const dependencies: EvidenceDependency[] = [];
    // A lone `**` means "all pathspecs"; git treats a bare `**` as a literal
    // pattern and would otherwise return no diff.
    const pathArgs = options.paths.length > 0 && !(options.paths.length === 1 && options.paths[0] === "**")
      ? [...options.paths, "--"]
      : ["--"];
    let bytes = 0;
    let omitted = 0;
    const push = (id: string, summary: JsonObject, text: string, revision: string): void => {
      if (items.length >= options.maxFiles || bytes + Buffer.byteLength(text, "utf8") > options.maxBytes) {
        omitted += 1;
        return;
      }
      bytes += Buffer.byteLength(text, "utf8");
      items.push({
        id,
        role: "evidence",
        required: false,
        content: [
          { type: "json", value: summary },
          { type: "text", text },
        ],
        provenance: {
          sourceId: "core.changes",
          uri: `git:${id}`,
          revision,
          acquiredAt: new Date().toISOString(),
          selection: { kind: "derived", inputIds: [], method: "core.git-read-only" },
          changedDuringRead: false,
        },
        bytes: Buffer.byteLength(text, "utf8"),
        tokenEstimate: null,
      });
      dependencies.push({ evidenceId: id, revision, relevance: "conclusion", check: "content-fingerprint" });
    };

    const finalStatus = this.#git(["status", "--porcelain=v1", "-z"]);
    const finalEntries = finalStatus.exit === 0 ? parseStatus(finalStatus.stdout) : [];
    const baselineKnown = baseline.entries.length <= options.maxFiles * 4;
    if (!baselineKnown) {
      issues.push({ sourceId: "core.changes", reason: "core.git-baseline-partial", required: false, evidenceIds: [] });
    }
    const stagedPaths = finalEntries.filter(entry => entry.index !== " " && entry.index !== "?").map(entry => entry.path);
    const unstagedPaths = finalEntries.filter(entry => entry.worktree !== " " && entry.worktree !== "?").map(entry => entry.path);
    const committedPaths = baseline.head === null
      ? []
      : this.#git(["diff", "--name-only", "--no-ext-diff", "--no-textconv", `${baseline.head}..HEAD`]).stdout.split(/\r?\n/u).filter(Boolean);
    const protectedPaths = protectedChangedPaths(this.#projectRoot, [
      ...stagedPaths,
      ...unstagedPaths,
      ...finalEntries.filter(entry => entry.index === "?").map(entry => entry.path),
      ...baseline.entries.map(entry => entry.path),
      ...committedPaths,
    ]);
    if (protectedPaths.length > 0) {
      // Protected content is never acquired through Git either; the affected
      // diff/tracked body is omitted and coverage becomes partial.
      issues.push({ sourceId: "core.changes", reason: "core.git-protected-omitted", required: false, evidenceIds: [] });
    }
    const baselineLayers: Array<[string, Record<string, { bytes: number; text: string } | null>]> = [
      ["worktree", baseline.dirtyBodies],
      ["index", baseline.stagedBodies],
      ["untracked", baseline.untrackedBodies],
    ];
    for (const [layer, bodies] of baselineLayers) {
      for (const [path, body] of Object.entries(bodies).slice(0, options.maxFiles)) {
        if (protectedReason(join(this.#projectRoot, path)) !== null) continue;
        if (body === null) {
          issues.push({ sourceId: "core.changes", reason: "core.git-baseline-unavailable", required: false, evidenceIds: [] });
          continue;
        }
        push(`changes:baseline:${layer}:${path}`, { kind: "baseline", layer, path }, body.text, hashText(body.text));
      }
    }
    if (baseline.baselinePartial) {
      issues.push({ sourceId: "core.changes", reason: "core.git-baseline-partial", required: false, evidenceIds: [] });
    }
    const unstaged = protectedPaths.length === 0 ? this.#git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", ...pathArgs]) : { exit: 0, stdout: "", stderr: "" };
    if (unstaged.exit === 0 && unstaged.stdout.length > 0) {
      push("changes:unstaged", { kind: "unstaged", files: unstagedPaths.slice(0, 64) }, unstaged.stdout, hashText(unstaged.stdout));
    }
    const staged = protectedPaths.length === 0 ? this.#git(["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", ...pathArgs]) : { exit: 0, stdout: "", stderr: "" };
    if (staged.exit === 0 && staged.stdout.length > 0) {
      push("changes:staged", { kind: "staged", files: stagedPaths.slice(0, 64) }, staged.stdout, hashText(staged.stdout));
    }
    if (options.includeUntracked) {
      for (const entry of finalEntries.filter(candidate => candidate.index === "?").slice(0, options.maxFiles)) {
        if (protectedReason(join(this.#projectRoot, entry.path)) !== null) continue;
        const content = readBoundedWorktreeFile(this.#projectRoot, entry.path, Math.max(1, options.maxBytes - bytes));
        if (content === null) {
          omitted += 1;
          continue;
        }
        push(
          `changes:untracked:${entry.path}`,
          { kind: "untracked", path: entry.path, preexisting: baseline.untracked.includes(entry.path) },
          content,
          hashText(content),
        );
      }
    }
    if (baseline.head !== null) {
      const committed = protectedPaths.length === 0 ? this.#git(["diff", "--no-ext-diff", "--no-textconv", "--no-color", `${baseline.head}..HEAD`, ...pathArgs]) : { exit: 0, stdout: "", stderr: "" };
      if (committed.exit === 0 && committed.stdout.length > 0) {
        push("changes:committed", { kind: "committed", from: baseline.head }, committed.stdout, hashText(committed.stdout));
      }
    }
    const attributionLimited = finalEntries.some(entry => !baseline.entries.some(previous => previous.path === entry.path && previous.index === entry.index && previous.worktree === entry.worktree));
    if (attributionLimited) {
      issues.push({ sourceId: "core.changes", reason: "core.git-shared-worktree-attribution-uncertain", required: false, evidenceIds: [] });
    }
    return {
      ok: true,
      value: {
        items,
        coverage: {
          state: issues.length > 0 || omitted > 0 ? "partial" : "complete",
          scopeDescription: `Bounded read-only episode change evidence over ${options.paths.join(", ") || "**"}.`,
          issues: issues.slice(0, 16),
        },
        dependencies,
      },
    };
  }

  #git(args: readonly string[]): { exit: number | null; stdout: string; stderr: string } {
    const result = spawnSync("git", ["-C", this.#projectRoot, "-c", "core.quotepath=false", "--no-optional-locks", ...args], {
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      shell: false,
      env: {
        ...process.env,
        GIT_EXTERNAL_DIFF: undefined,
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    this.#invocations.push({ args: [...args], exit: result.status ?? null });
    return { exit: result.status ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

function protectedChangedPaths(projectRoot: string, paths: readonly string[]): string[] {
  return paths.filter(path => protectedReason(join(projectRoot, path)) !== null);
}

function parseStatus(output: string): GitStatusEntry[] {
  const entries: GitStatusEntry[] = [];
  for (const chunk of output.split("\u0000")) {
    if (chunk.length < 4) continue;
    const index = chunk[0] ?? " ";
    const worktree = chunk[1] ?? " ";
    const path = chunk.slice(3);
    entries.push({ path, index, worktree });
  }
  return entries;
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 32);
}

/** Reads one bounded worktree file without touching Git state. */
function readBoundedWorktreeFile(root: string, relativePath: string, remainingBytes: number): string | null {
  if (remainingBytes <= 0 || relativePath.length === 0 || relativePath.includes("\u0000")) return null;
  const absolute = join(root, relativePath);
  try {
    const stats = statSync(absolute);
    if (!stats.isFile() || stats.size > remainingBytes) return null;
    return readFileSync(absolute, "utf8");
  } catch {
    return null;
  }
}
