// Original project evidence access.
//
// Declared sources resolve relative to the configuration file that declared
// them, inside canonical allowed roots. Before any read the resolver applies
// protected-path exclusions and target-based symlink policy, reports denied or
// missing material as coverage rather than reading it, and fingerprints the
// actual bytes it hands to a provider. Nothing here writes project state.

import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ContentBlock,
  ContextBatch,
  ContextItem,
  CoverageIssue,
  EvidenceDependency,
  JsonObject,
  Observation,
  Result,
  SourceDefinition,
} from "./contracts.js";

export interface SourceDeclaration {
  id: string;
  definition: SourceDefinition;
  origin: "user" | "project";
  /** Directory of the configuration file that declared this source. */
  baseDir: string;
}

export interface EvidenceRoots {
  projectRoot: string;
  agentDir: string;
  agentQualityDir: string;
}

const PROTECTED_DIRECTORY_NAMES = new Set([".git", "node_modules", "donors"]);
const PROTECTED_FILE_PATTERNS = [
  /^\.env(?:\.|$)/u,
  /\.pem$/iu,
  /\.key$/iu,
  /^id_(?:rsa|ed25519|ecdsa)/u,
  /^\.npmrc$/u,
  /^\.netrc$/u,
  /^credentials?(?:\.|$)/iu,
];

/** Canonical protected-path policy applied to the resolved target, not the visible name. */
export function protectedReason(absolutePath: string, roots?: { agentQualityDir: string }): string | null {
  let target = absolutePath;
  try {
    target = realpathSync(absolutePath);
  } catch {
    // The unresolvable path still gets the visible-name policy below.
  }
  if (roots !== undefined) {
    if (isWithin(join(roots.agentQualityDir, "logs"), target) || isWithin(join(roots.agentQualityDir, "state"), target)) {
      return "core.source-protected";
    }
  }
  const parts = target.split(sep);
  for (const part of parts) {
    if (PROTECTED_DIRECTORY_NAMES.has(part)) return "core.source-protected";
  }
  const name = parts[parts.length - 1] ?? "";
  for (const pattern of PROTECTED_FILE_PATTERNS) {
    if (pattern.test(name)) return "core.source-protected";
  }
  return null;
}

function isWithin(root: string, candidate: string): boolean {
  const normalizedRoot = root.endsWith(sep) ? root : `${root}${sep}`;
  return candidate === root || candidate.startsWith(normalizedRoot);
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/** Bounded `*` / `**` glob matcher over one relative, forward-slash path. */
function globMatches(pattern: string, candidate: string): boolean {
  const patternParts = pattern.split("/");
  const candidateParts = candidate.split("/");
  const walk = (patternIndex: number, candidateIndex: number): boolean => {
    if (patternIndex === patternParts.length) return candidateIndex === candidateParts.length;
    const part = patternParts[patternIndex] ?? "";
    if (part === "**") {
      for (let skip = candidateIndex; skip <= candidateParts.length; skip += 1) {
        if (walk(patternIndex + 1, skip)) return true;
      }
      return false;
    }
    if (candidateIndex >= candidateParts.length) return false;
    if (part === "*" || new RegExp(`^${part.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]")}$`, "u").test(candidateParts[candidateIndex] ?? "")) {
      return walk(patternIndex + 1, candidateIndex + 1);
    }
    return false;
  };
  return walk(0, 0);
}

export interface SectionSelection {
  text: string;
  matched: string[];
  missing: string[];
}

/** Exact Markdown heading-path selection for include: "selected". */
export function selectMarkdownSections(text: string, requested: readonly string[]): SectionSelection {
  const lines = text.split(/\r?\n/u);
  const headings: Array<{ level: number; title: string; path: string; start: number }> = [];
  for (const [index, line] of lines.entries()) {
    const match = /^(#{1,6})\s+(.*?)\s*$/u.exec(line);
    if (match === null) continue;
    const level = match[1]?.length ?? 1;
    const title = match[2] ?? "";
    const stack = headings.filter(heading => heading.level < level).map(heading => heading.title);
    headings.push({ level, title, path: [...stack, title].join(" > "), start: index });
  }
  const chosen: typeof headings = [];
  const matched: string[] = [];
  const missing: string[] = [];
  for (const want of requested) {
    const hit = headings.find(heading => heading.path === want || heading.title === want);
    if (hit === undefined) missing.push(want);
    else {
      chosen.push(hit);
      matched.push(hit.path);
    }
  }
  chosen.sort((left, right) => left.start - right.start);
  const parts: string[] = [];
  for (const heading of chosen) {
    const next = headings.find(other => other.start > heading.start && other.level <= heading.level);
    const end = next?.start ?? lines.length;
    parts.push(lines.slice(heading.start, end).join("\n"));
  }
  return { text: parts.join("\n"), matched, missing };
}

/** One actual permitted resource acquisition, captured before selection can discard it. */
export interface AcquisitionObservation {
  /** Declared source identity whose resolution produced this acquisition. */
  sourceId: string;
  /** Resolved component that owns this read; opaque references are keyed by it. */
  ownerId: string;
  /** Actual binding that invoked the read, when the engine knows it. */
  bindingId: string | null;
  /** Canonical actual resource handed to the provider (private, never projected raw). */
  resource: string;
  /** Original raw-byte fingerprint, taken before any selection/normalization. */
  revision: string;
  /** Original raw byte size of the acquired resource. */
  bytes: number;
  changedDuringRead: boolean;
  outcome: "acquired";
  /** Actual prompt resource purpose, when the owning call knows it. */
  purpose?: "instruction" | "questions" | "resultSchema";
}

/** Engine-issued opaque references for one acquisition. */
export interface AcquiredRefs {
  resourceRef: string;
  revisionRef: string;
}

/** Run-owned acquisition observer; it issues the opaque references and keeps associations. */
export interface AcquisitionObserver {
  observe(event: AcquisitionObservation): AcquiredRefs | null;
}

/**
 * Private per-invocation context: which run-owned observer receives the
 * acquisition and which resolved component/binding owns it. Supplied by the
 * engine's evidence facade, never by a provider.
 */
export interface ReadObservationContext {
  observer: AcquisitionObserver;
  ownerId: string;
  bindingId: string | null;
  /** Run-scoped ownership key used to drain exactly this run's facts. */
  scope: string;
  /** Actual prompt resource purpose known at the owning read call. */
  purpose?: "instruction" | "questions" | "resultSchema";
}

export interface AcquisitionFact {
  sourceId: string;
  required: boolean;
  resourceRefs: string[];
  rawBytes: number;
  selectedBytes: number;
  itemCount: number;
  outcome: "acquired" | "absent" | "denied" | "failed";
  reasonCode: string | null;
  /** Run-scoped ownership key; null only for a direct call without an observer. */
  scope: string | null;
}

export class SourceEvidence {
  readonly #declarations = new Map<string, SourceDeclaration[]>();
  readonly #pins = new Map<string, {
    text: string;
    bytes: number;
    headings: string[];
    originalRevision: string;
    originalBytes: number;
  }>();
  readonly #roots: EvidenceRoots;
  readonly #invocations: string[] = [];

  constructor(declarations: readonly SourceDeclaration[], roots: EvidenceRoots) {
    this.#roots = roots;
    for (const declaration of declarations) {
      const existing = this.#declarations.get(declaration.id) ?? [];
      existing.push(declaration);
      this.#declarations.set(declaration.id, existing);
    }
  }

  get sourceIds(): readonly string[] {
    return [...this.#declarations.keys()];
  }

  get invocations(): readonly string[] {
    return [...this.#invocations];
  }

  #acquisitionLog: AcquisitionFact[] = [];

  /**
   * Drains bounded per-invocation acquisition observations; no extra reads.
   * When a scope is given only the facts captured through that run's owned
   * facade are returned, so one run cannot drain another's records.
   */
  drainAcquisitions(scope?: string): AcquisitionFact[] {
    if (scope === undefined) {
      const rows = this.#acquisitionLog;
      this.#acquisitionLog = [];
      return rows;
    }
    const rows = this.#acquisitionLog.filter(row => row.scope === scope);
    if (rows.length > 0) this.#acquisitionLog = this.#acquisitionLog.filter(row => row.scope !== scope);
    return rows;
  }

  async readSource(sourceId: string, _signal: AbortSignal, observation?: ReadObservationContext): Promise<Result<ContextBatch>> {
    const declarations = this.#declarations.get(sourceId);
    if (declarations === undefined || declarations.length === 0) {
      return { ok: false, error: { code: "core.source-unknown", retryable: false } };
    }
    const items: ContextItem[] = [];
    const issues: CoverageIssue[] = [];
    const dependencies: EvidenceDependency[] = [];
    let requiredMissing = false;
    let anyPartial = false;
    let rawAcquiredBytes = 0;
    let selectedAcquiredBytes = 0;
    const acquiredResourceRefs: string[] = [];
    let deniedReason: string | null = null;
    for (const declaration of declarations) {
      const definition = declaration.definition;
      const candidates = this.#expand(declaration, definition);
      if (candidates.length === 0) {
        if (definition.required) requiredMissing = true;
        issues.push({ sourceId, reason: "core.source-missing", required: definition.required, evidenceIds: [] });
        continue;
      }
      let usedBytes = 0;
      let files = 0;
      for (const candidate of candidates) {
        if (files >= definition.maxFiles) {
          anyPartial = true;
          issues.push({ sourceId, reason: "core.source-truncated", required: definition.required, evidenceIds: [] });
          break;
        }
        const resolved = this.#resolveCandidate(declaration, candidate);
        if (!("denied" in resolved) && definition.revisionPolicy === "pin-at-episode") {
          const pinned = this.#pins.get(`${sourceId}\u0000${resolved.path}`);
          if (pinned !== undefined) {
            usedBytes += pinned.bytes;
            files += 1;
            // The cached selection keeps the original acquisition version: a
            // cached pin is not a fresh native read and cannot relabel the
            // selected-text hash as the original source revision.
            const revision = pinned.originalRevision;
            const refs = observation?.observer.observe({
              sourceId,
              ownerId: observation.ownerId,
              bindingId: observation.bindingId,
              resource: resolved.uri,
              revision: pinned.originalRevision,
              bytes: pinned.originalBytes,
              changedDuringRead: false,
              outcome: "acquired",
            });
            if (refs !== null && refs !== undefined) acquiredResourceRefs.push(refs.resourceRef);
            const itemId = `source:${sourceId}:${revision}`;
            items.push({
              id: itemId,
              role: definition.role,
              required: definition.required,
              content: [{ type: "text", text: pinned.text }],
              provenance: {
                sourceId,
                uri: resolved.uri,
                revision,
                acquiredAt: new Date().toISOString(),
                selection: pinned.headings.length > 0 ? { kind: "sections", headings: pinned.headings } : { kind: "full" },
                changedDuringRead: false,
              },
              bytes: pinned.bytes,
              tokenEstimate: null,
            });
            dependencies.push({ evidenceId: itemId, revision, relevance: definition.role === "requirement" ? "authority" : "supporting", check: "content-fingerprint" });
            rawAcquiredBytes += pinned.originalBytes;
            selectedAcquiredBytes += pinned.bytes;
            continue;
          }
        }
        if ("denied" in resolved) {
          anyPartial = true;
          if (definition.required) requiredMissing = true;
          deniedReason = resolved.denied;
          issues.push({ sourceId, reason: resolved.denied, required: definition.required, evidenceIds: [] });
          continue;
        }
        const bytes = this.#readBounded(resolved.path, definition.maxBytes - usedBytes);
        if (bytes === null) {
          anyPartial = true;
          if (definition.required) requiredMissing = true;
          const exists = existsSync(resolved.path);
          issues.push({ sourceId, reason: exists ? "core.source-unreadable" : "core.source-missing", required: definition.required, evidenceIds: [] });
          continue;
        }
        usedBytes += bytes.bytes.length;
        rawAcquiredBytes += bytes.bytes.length;
        files += 1;
        // Capture the actual permitted resource and its ORIGINAL raw-byte
        // version before section selection, normalization or later failure can
        // discard them; the run-owned observer issues the opaque references.
        const revision = hashBytes(bytes.bytes);
        const refs = observation?.observer.observe({
          sourceId,
          ownerId: observation.ownerId,
          bindingId: observation.bindingId,
          resource: bytes.uri,
          revision,
          bytes: bytes.bytes.length,
          changedDuringRead: bytes.changedDuringRead,
          outcome: "acquired",
        });
        if (refs !== null && refs !== undefined) acquiredResourceRefs.push(refs.resourceRef);
        const itemId = `source:${sourceId}:${revision}`;
        let itemText = bytes.text;
        let selection: ContextItem["provenance"]["selection"] = { kind: "full" };
        if (definition.include === "selected") {
          const selected = selectMarkdownSections(bytes.text, definition.sections);
          itemText = selected.text;
          if (selected.missing.length > 0) {
            anyPartial = true;
            if (definition.required) requiredMissing = true;
            issues.push({ sourceId, reason: "core.source-section-missing", required: definition.required, evidenceIds: [] });
          }
          if (selected.matched.length === 0) {
            anyPartial = true;
            if (definition.required) requiredMissing = true;
          } else {
            selection = { kind: "sections", headings: selected.matched };
          }
        }
        const content: ContentBlock[] = [{ type: "text", text: itemText }];
        items.push({
          id: itemId,
          role: definition.role,
          required: definition.required,
          content,
          provenance: {
            sourceId,
            uri: bytes.uri,
            revision,
            acquiredAt: new Date().toISOString(),
            selection,
            changedDuringRead: bytes.changedDuringRead,
          },
          bytes: Buffer.byteLength(itemText, "utf8"),
          tokenEstimate: null,
        });
        selectedAcquiredBytes += Buffer.byteLength(itemText, "utf8");
        if (definition.revisionPolicy === "pin-at-episode" && !this.#pins.has(`${sourceId}\u0000${resolved.path}`)) {
          const headings = selection.kind === "sections" ? [...selection.headings] : [];
          this.#pins.set(`${sourceId}\u0000${resolved.path}`, {
            text: itemText,
            bytes: Buffer.byteLength(itemText, "utf8"),
            headings,
            originalRevision: revision,
            originalBytes: bytes.bytes.length,
          });
        }
        dependencies.push({ evidenceId: itemId, revision, relevance: definition.role === "requirement" ? "authority" : "supporting", check: "content-fingerprint" });
        if (bytes.changedDuringRead) {
          anyPartial = true;
          issues.push({ sourceId, reason: "core.source-changed-during-read", required: definition.required, evidenceIds: [itemId] });
        }
      }
    }
    this.#acquisitionLog.push({
      sourceId,
      required: declarations.some(declaration => declaration.definition.required),
      resourceRefs: acquiredResourceRefs,
      rawBytes: rawAcquiredBytes,
      selectedBytes: selectedAcquiredBytes,
      itemCount: items.length,
      outcome: items.length > 0 || rawAcquiredBytes > 0 ? "acquired" : deniedReason !== null ? "denied" : "absent",
      reasonCode: items.length > 0 ? null : rawAcquiredBytes > 0 ? (issues[0]?.reason ?? null) : deniedReason ?? issues[0]?.reason ?? "core.source-missing",
      scope: observation?.scope ?? null,
    });
    return {
      ok: true,
      value: {
        items,
        coverage: {
          state: requiredMissing ? "insufficient" : anyPartial ? "partial" : "complete",
          scopeDescription: `Declared source ${sourceId} resolved inside its allowed root.`,
          issues: issues.slice(0, 16),
        },
        dependencies,
      },
    };
  }

  async readPermittedFile(requestedPath: string, signal: AbortSignal, observation?: ReadObservationContext | "instruction" | "questions" | "resultSchema"): Promise<Result<ContextBatch>> {
    return this.readPermittedFileFrom(requestedPath, signal, this.#roots.projectRoot, observation);
  }

  /**
   * Declaration-relative permitted read used by prompt resources: the base is
   * the directory of the configuration file that declared the reference, while
   * the allowed-root and protected-target policy stay exactly the same.
   */
  async readPermittedFileFrom(requestedPath: string, _signal: AbortSignal, declarationBase: string, observation?: ReadObservationContext | "instruction" | "questions" | "resultSchema"): Promise<Result<ContextBatch>> {
    const resolved = this.#resolvePath(requestedPath, declarationBase, declarationBase);
    if ("denied" in resolved) {
      return { ok: false, error: { code: "core.source-denied", retryable: false } };
    }
    const bytes = this.#readBounded(resolved.path, 262_144);
    if (bytes === null) {
      return { ok: false, error: { code: "core.source-unreadable", retryable: false } };
    }
    const revision = hashBytes(bytes.bytes);
    const observationContext = typeof observation === "object" ? observation : undefined;
    // Capture the actual permitted prompt resource BEFORE parsing/normalization
    // or a later failure; the run owner keeps the safe descriptor. A bare
    // purpose string from a direct caller has no run owner and is not observed.
    observationContext?.observer.observe({
      sourceId: "core.read-permitted",
      ownerId: observationContext.ownerId,
      bindingId: observationContext.bindingId,
      resource: bytes.uri,
      revision,
      bytes: bytes.bytes.length,
      changedDuringRead: bytes.changedDuringRead,
      outcome: "acquired",
      ...(observationContext.purpose === undefined ? {} : { purpose: observationContext.purpose }),
    });
    const item: ContextItem = {
      id: `permitted:${revision}`,
      role: "reference",
      required: false,
      content: [{ type: "text", text: bytes.text }],
      provenance: {
        sourceId: "core.read-permitted",
        uri: bytes.uri,
        revision,
        acquiredAt: new Date().toISOString(),
        selection: { kind: "full" },
        changedDuringRead: bytes.changedDuringRead,
      },
      bytes: bytes.bytes.length,
      tokenEstimate: null,
    };
    return {
      ok: true,
      value: {
        items: [item],
        coverage: { state: bytes.changedDuringRead ? "partial" : "complete", scopeDescription: "Single permitted file read.", issues: [] },
        dependencies: [],
      },
    };
  }

  recentObservations(_limit: number): readonly Observation[] {
    return [];
  }

  #expand(declaration: SourceDeclaration, definition: SourceDefinition): string[] {
    const results: string[] = [];
    for (const uri of definition.uris) results.push(uri);
    for (const pattern of definition.globs) {
      const base = pattern.startsWith("project:") ? this.#roots.projectRoot : declaration.baseDir;
      const relativePattern = pattern.replace(/^project:/u, "").replaceAll("\\", "/").replace(/^\.\//u, "");
      if (relativePattern.includes("..")) continue;
      for (const candidate of this.#walk(base, relativePattern.split("/"), 0, 256)) {
        const relativeCandidate = relative(base, candidate).split(sep).join("/");
        if (definition.exclude.some(exclusion => globMatches(exclusion.replaceAll("\\", "/"), relativeCandidate))) continue;
        results.push(candidate);
      }
    }
    return [...new Set(results)].slice(0, definition.maxFiles * 4);
  }

  #walk(base: string, parts: readonly string[], index: number, budget: number): string[] {
    if (budget <= 0) return [];
    if (index >= parts.length) return [base];
    const part = parts[index] ?? "";
    if (part === "**") {
      const results = this.#walk(base, parts, index + 1, budget);
      for (const entry of this.#listDirectory(base)) {
        results.push(...this.#walk(join(base, entry.name), parts, index, budget - results.length));
      }
      return results;
    }
    const entries = this.#listDirectory(base);
    const results: string[] = [];
    for (const entry of entries) {
      if (part === "*" || globMatches(part, entry.name)) {
        results.push(...this.#walk(join(base, entry.name), parts, index + 1, budget - results.length));
      }
    }
    return results;
  }

  #listDirectory(directory: string): Array<{ name: string; directory: boolean }> {
    try {
      return readdirSync(directory, { withFileTypes: true })
        .filter(entry => !entry.isSymbolicLink() && !PROTECTED_DIRECTORY_NAMES.has(entry.name))
        .map(entry => ({ name: entry.name, directory: entry.isDirectory() }));
    } catch {
      return [];
    }
  }

  #resolveCandidate(declaration: SourceDeclaration, candidate: string): { path: string; uri: string } | { denied: string } {
    const resolved = this.#resolvePath(candidate, declaration.baseDir, declaration.baseDir);
    if ("denied" in resolved) return resolved;
    // A symlink or alias must not smuggle a protected canonical target past
    // the policy: resolve the real target and apply the same exclusions.
    const protectedIssue = protectedReason(resolved.path, this.#roots);
    if (protectedIssue !== null) return { denied: protectedIssue };
    return resolved;
  }

  #resolvePath(requestedPath: string, fallbackBase: string, _declarationBase: string): { path: string; uri: string } | { denied: string } {
    let absolute: string;
    if (requestedPath.startsWith("project:")) absolute = resolve(this.#roots.projectRoot, requestedPath.slice("project:".length));
    else if (requestedPath.startsWith("agent:")) absolute = resolve(this.#roots.agentDir, requestedPath.slice("agent:".length));
    else if (requestedPath.startsWith("file:")) {
      const raw = requestedPath.slice("file:".length);
      if (/^file:\/\//u.test(requestedPath)) {
        // Canonical URL form (file:///C:/...) must not be resolved as a plain
        // Windows path: path.resolve would duplicate the drive prefix.
        try {
          absolute = fileURLToPath(requestedPath);
        } catch {
          absolute = resolve(fallbackBase, raw.replace(/^\/+/, ""));
        }
      } else {
        absolute = isAbsolute(raw) ? resolve(raw) : resolve(fallbackBase, raw);
      }
    } else if (isAbsolute(requestedPath)) {
      absolute = resolve(requestedPath);
    } else {
      // Declaration-relative: resolve against the directory of the
      // configuration file that declared this source (explicit project: and
      // agent: prefixes select another root). No silent fallback ordering.
      absolute = resolve(fallbackBase, requestedPath);
    }
    if (!this.#underAllowedRoot(absolute)) return { denied: "core.source-denied" };
    const visibleIssue = this.#protectedReason(absolute);
    if (visibleIssue !== null) return { denied: visibleIssue };
    // Canonical target policy: a junction/symlink alias must not smuggle a
    // protected canonical target past the exclusion before content acquisition.
    const targetIssue = protectedReason(absolute, this.#roots);
    if (targetIssue !== null) return { denied: targetIssue };
    let canonical = absolute;
    try {
      canonical = realpathSync(absolute);
    } catch {
      // An unresolvable path keeps the visible name; the read will report it.
    }
    return { path: canonical, uri: `file:${canonical.split(sep).join("/")}` };
  }

  #underAllowedRoot(absolute: string): boolean {
    const roots = [this.#roots.projectRoot, this.#roots.agentDir, this.#roots.agentQualityDir];
    const realRoots = roots.map(root => {
      try {
        return realpathSync(root);
      } catch {
        return root;
      }
    });
    let realTarget: string;
    try {
      realTarget = realpathSync(absolute);
    } catch {
      return roots.some(root => isWithin(root, absolute));
    }
    return realRoots.some(root => isWithin(root, realTarget));
  }

  #protectedReason(absolute: string): string | null {
    for (const root of [this.#roots.agentQualityDir]) {
      if (isWithin(join(root, "logs"), absolute) || isWithin(join(root, "state"), absolute)) return "core.source-protected";
    }
    const parts = absolute.split(sep);
    for (const part of parts) {
      if (PROTECTED_DIRECTORY_NAMES.has(part)) return "core.source-protected";
    }
    const name = parts[parts.length - 1] ?? "";
    for (const pattern of PROTECTED_FILE_PATTERNS) {
      if (pattern.test(name)) return "core.source-protected";
    }
    return null;
  }

  #readBounded(path: string, remainingBytes: number): { bytes: Buffer; text: string; uri: string; changedDuringRead: boolean } | null {
    if (remainingBytes <= 0) return null;
    this.#invocations.push(path);
    try {
      const stats = lstatSync(path);
      if (!stats.isFile() && !stats.isSymbolicLink()) return null;
      const realStats = statSync(path);
      if (!realStats.isFile() || realStats.size > remainingBytes) return null;
      const bytes = readFileSync(path);
      const after = statSync(path);
      return {
        bytes,
        text: bytes.toString("utf8"),
        uri: `file:${path.split(sep).join("/")}`,
        changedDuringRead: after.mtimeMs !== realStats.mtimeMs || after.size !== realStats.size,
      };
    } catch {
      return null;
    }
  }
}

/** Plain JSON marker used by fixtures to prove which bytes reached a consumer. */
export function textMarkerOf(batch: ContextBatch): JsonObject {
  const markers: Record<string, string> = {};
  for (const item of batch.items) {
    const block = item.content[0];
    if (block !== undefined && block.type === "text") markers[item.id] = block.text.slice(0, 64);
  }
  return markers as JsonObject;
}
