// Pi model-registry adapter for the owned model service.
//
// The adapter is the only place that knows the pinned SDK model API. It
// resolves approved provider/model routes from the host registry and dispatches
// through the registry's request-time authenticated methods, so the engine
// never inherits the primary session's model or credentials implicitly.

import { createHash } from "node:crypto";
import { access as fsAccess, readFile as fsReadFile, readdir as fsReaddir, stat as fsStat } from "node:fs/promises";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ChatTransportResult, ClassifierTransportResult, ModelRegistryPort } from "../models.js";
import type { ModelProfileDefinition } from "../contracts.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function extractText(message: unknown): string {
  const record = asRecord(message);
  const content = record?.["content"];
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    const entry = asRecord(block);
    if (entry === null) continue;
    if (entry["type"] === "text" && typeof entry["text"] === "string") parts.push(entry["text"]);
  }
  return parts.join("\n");
}

// The pinned OpenAI-compatible serializer merges sampling parameters last.
// Bound their cap aliases on request-local copies so model/thinking defaults
// cannot widen an admitted SDK maxTokens (and smaller defaults stay smaller).
function boundedSdkSampling(model: Record<string, unknown>, options: Record<string, unknown>): { model: Record<string, unknown>; options: Record<string, unknown> } {
  const limit = options["maxTokens"];
  if (model["api"] !== "openai-completions" || typeof limit !== "number" || !Number.isSafeInteger(limit) || limit <= 0) return { model, options };
  const bound = (value: unknown): unknown => {
    const record = asRecord(value);
    if (record === null) return value;
    const copy = { ...record };
    for (const key of ["max_tokens", "max_completion_tokens"]) {
      const cap = copy[key];
      if (typeof cap === "number" && Number.isFinite(cap) && cap > 0) copy[key] = Math.min(cap, limit);
    }
    return copy;
  };
  const levels = asRecord(model["samplingParamsByThinkingLevel"]);
  return {
    model: {
      ...model,
      ...(model["samplingParams"] === undefined ? {} : { samplingParams: bound(model["samplingParams"]) }),
      ...(levels === null ? {} : { samplingParamsByThinkingLevel: Object.fromEntries(Object.entries(levels).map(([level, value]) => [level, bound(value)])) }),
    },
    options: { ...options, ...(options["samplingParams"] === undefined ? {} : { samplingParams: bound(options["samplingParams"]) }) },
  };
}

export function piModelRegistryPort(registry: ModelRegistry): ModelRegistryPort {
  return {
    findChat(provider, model) {
      return asRecord(registry.findOfType("chat", provider, model));
    },
    findClassifier(provider, model) {
      return asRecord(registry.findOfType("classifier", provider, model));
    },
    hasConfiguredAuth(model) {
      return registry.hasConfiguredAuth(model as never);
    },
    async completeChat(model, messages, options, _signal): Promise<ChatTransportResult> {
      const context = {
        messages: messages.map(message => ({
          role: message.role,
          content: [{ type: "text", text: message.content }],
        })),
      };
      const requestOptions: Record<string, unknown> = { maxTokens: options["maxOutputTokens"] };
      if (options["reasoning"] !== undefined && options["reasoning"] !== "off") {
        requestOptions["reasoning"] = options["reasoning"];
      }
      const bounded = boundedSdkSampling(model, requestOptions);
      const assistant = await registry.complete(bounded.model as never, context as never, bounded.options as never);
      const record = asRecord(assistant);
      return {
        text: extractText(assistant),
        model: {
          provider: typeof model["provider"] === "string" ? model["provider"] : "unknown",
          id: typeof model["id"] === "string" ? model["id"] : "unknown",
          revision: typeof model["revision"] === "string" ? model["revision"] : null,
        },
        usage: asRecord(record?.["usage"]),
        stopReason: typeof record?.["stopReason"] === "string" ? record["stopReason"] : null,
        errorCode: null,
      };
    },
    streamSimple(model, context, options) {
      const bounded = boundedSdkSampling(model, asRecord(options) ?? {});
      return registry.streamSimple(bounded.model as never, context as never, bounded.options as never);
    },
    async classify(model, state, questions, options, _signal): Promise<ClassifierTransportResult> {
      const result = await registry.classify(
        model as never,
        { state: state as never, questions: questions as never },
        { maxTokens: options["maxOutputTokens"] } as never,
      );
      const record = asRecord(result);
      return {
        answers: asRecord(record?.["answers"]) ?? {},
        model: {
          provider: typeof record?.["provider"] === "string" ? record["provider"] : "unknown",
          id: typeof record?.["model"] === "string" ? record["model"] : "unknown",
          revision: null,
        },
        usage: asRecord(record?.["usage"]),
        stopReason: typeof record?.["stopReason"] === "string" ? record["stopReason"] : null,
        errorMessage: typeof record?.["errorMessage"] === "string" ? record["errorMessage"] : null,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// K05 clean reviewer host (production adapter boundary)
//
// Each reviewer evaluation gets a genuinely fresh project-local AgentSession
// built through the pinned public SDK: no-discovery resource loader, in-memory
// settings and session storage, an explicit read-only tool allowlist plus the
// package-owned structured result tool. `agent.streamFunction` is installed
// BEFORE the first prompt and routes every provider turn through the shared
// reviewer admission owner; the actual native stream is produced by the host
// registry's approved route. The native SDK conversion lives only here.
// ---------------------------------------------------------------------------

import {
  createAgentSession,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  truncateHead,
  createReadToolDefinition,
  createGrepToolDefinition,
  createFindToolDefinition,
  createLsToolDefinition,
  DefaultResourceLoader,
  defineTool,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ReviewerHost, ReviewerSession, ReviewerSessionHooks } from "../builtins/pi-reviewer.js";

export interface PiReviewerHostOptions {
  /** Resolved approved chat model object from the host registry. */
  model: Record<string, unknown>;
  /** Selected profile, never the SDK or primary session's ambient default. */
  reasoning?: ModelProfileDefinition["reasoning"];
}

function toolResultBytes(event: unknown, argsOf?: (toolCallId: string) => Record<string, unknown> | undefined): {
  toolName: string;
  bytes: number;
  selectedBytes?: number;
  toolCallId?: string;
  path?: string;
  selectedDigest?: string;
  sourceVersion?: string | null;
  requested?: string;
  actual?: string;
  truncated?: boolean;
  sourceBytes?: number | null;
  serializedBytes?: number;
  isError?: boolean;
} | null {
  const record = asRecord(event);
  if (record === null || record["type"] !== "tool_execution_end") return null;
  const toolName = typeof record["toolName"] === "string" ? record["toolName"] : null;
  if (toolName === null) return null;
  const result = asRecord(record["result"]);
  const content = result?.["content"];
  const serializedBytes = content === undefined ? 0 : Buffer.byteLength(JSON.stringify(content), "utf8");
  const toolCallId = typeof record["toolCallId"] === "string" ? record["toolCallId"] : undefined;
  const isError = record["isError"] === true;
  // 201-F2: the pinned tool_execution_end carries no args, so the actual requested
  // target and selection are joined from the args captured at the real permission
  // boundary for this exact owned call identity.
  const args = (toolCallId === undefined ? undefined : argsOf?.(toolCallId)) ?? asRecord(record["args"]);
  const path = typeof args?.["path"] === "string" ? args["path"] as string : undefined;
  const offset = typeof args?.["offset"] === "number" && Number.isFinite(args["offset"]) ? Math.max(0, Math.floor(args["offset"] as number)) : undefined;
  const limit = typeof args?.["limit"] === "number" && Number.isFinite(args["limit"]) ? Math.max(1, Math.floor(args["limit"] as number)) : undefined;
  // Requested versus actually returned selection: a read without range arguments asks for the
  // whole source, but the SDK/aggregate boundary may truncate it; that is a truncated view,
  // not a full-source acquisition. Non-read tools return a result set, not a source body.
  const requested = toolName !== "read"
    ? "result-set"
    : (offset === undefined && limit === undefined ? "full" : `range:${offset ?? 0}+${limit === undefined ? "end" : limit}`);
  const detailRecord = asRecord(result?.["details"]);
  const truncation = asRecord(detailRecord?.["truncation"]);
  const declaredTruncated = truncation?.["truncated"] === true;
  // The pinned SDK reports totalBytes inside its own selection domain; it must not be renamed
  // into a whole-source size. The engine's delivery boundary reports deliveryLimited and the
  // requested/delivered facts for a bounded delivery, which is not a complete source acquisition.
  const deliveryLimited = detailRecord?.["deliveryLimited"] === true;
  const deliveredBytes = typeof detailRecord?.["deliveredBytes"] === "number" && Number.isFinite(detailRecord["deliveredBytes"]) ? Math.max(0, Math.floor(detailRecord["deliveredBytes"] as number)) : undefined;
  const requestedBytes = typeof detailRecord?.["requestedBytes"] === "number" && Number.isFinite(detailRecord["requestedBytes"]) ? Math.max(0, Math.floor(detailRecord["requestedBytes"] as number)) : undefined;
  // The exact selected result that was actually returned, and (only for a complete untruncated
  // read) the whole-source version. A rendered-text hash is a selected-result digest, never a
  // manufactured source version.
  const selectedText = (() => {
    const blocks = Array.isArray(content) ? content : [];
    return blocks
      .filter(block => block !== null && typeof block === "object" && (block as { type?: unknown }).type === "text")
      .map(block => String((block as { text?: unknown }).text ?? ""))
      .join(String.fromCharCode(10));
  })();
  const selectedBytes = Buffer.byteLength(selectedText, "utf8");
  const selectedDigest = !isError && selectedText.length > 0 ? createHash("sha256").update(selectedText, "utf8").digest("hex").slice(0, 16) : undefined;
  // The ACTUAL selection is the observed returned coordinate span when the read boundary recorded
  // one; only a read that was asked for and returned whole is reported as full.
  const observedRead = asRecord(detailRecord?.["readSelection"]);
  const observedStartLine = typeof observedRead?.["startLine"] === "number" && Number.isFinite(observedRead["startLine"]) ? Math.floor(observedRead["startLine"] as number) : undefined;
  const observedEndLine = typeof observedRead?.["endLine"] === "number" && Number.isFinite(observedRead["endLine"]) ? Math.floor(observedRead["endLine"] as number) : undefined;
  const observedTotalLines = typeof observedRead?.["totalLines"] === "number" && Number.isFinite(observedRead["totalLines"]) ? Math.floor(observedRead["totalLines"] as number) : undefined;
  const truncated = !isError && (deliveryLimited || declaredTruncated);
  const actual = toolName !== "read"
    ? "result-set"
    : (selectedBytes === 0 && !deliveryLimited ? "empty"
      : (deliveryLimited ? `limited:${deliveredBytes ?? selectedBytes}/${requestedBytes ?? "unknown"}`
        : (declaredTruncated ? `truncated:${selectedBytes}`
          : (observedStartLine !== undefined && observedEndLine !== undefined
            ? `lines:${observedStartLine}-${observedEndLine}/${observedTotalLines ?? "unknown"}`
            : "full"))));
  const fullSourceRead = !isError && !truncated && toolName === "read" && offset === undefined && limit === undefined && selectedBytes > 0;
  const sourceBytes = fullSourceRead ? selectedBytes : null;
  const sourceVersion = fullSourceRead ? selectedDigest ?? null : null;
  return {
    toolName,
    bytes: serializedBytes,
    selectedBytes,
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(path === undefined ? {} : { path }),
    ...(selectedDigest === undefined ? {} : { selectedDigest }),
    sourceVersion,
    requested,
    actual,
    ...(truncated ? { truncated: true } : {}),
    sourceBytes,
    serializedBytes,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * Builds the production ReviewerHost over the host's approved model registry.
 * Construction uses an isolated model runtime (no catalog refresh, no network,
 * no operator model store); actual provider streaming is intercepted by the
 * installed streamFunction and dispatched through the host registry route.
 */
/** Image MIME sniffing for the owned read pipeline (magic bytes first). */
function ownedImageMime(absolutePath: string, bytes: Buffer): string | null {
  const head = bytes.subarray(0, 12);
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 6 && head.subarray(0, 3).toString("latin1") === "GIF") return "image/gif";
  if (head.length >= 12 && head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  const lower = absolutePath.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".webp")) return "image/webp";
  return null;
}

/** Minimal glob matcher for locally-matched root files (`*` and name substrings). */
function nameMatchesPattern(name: string, pattern: string | null): boolean {
  // F04: anchored SDK glob semantics — `*` matches any sequence and `?`
  // matches exactly one character, instead of substring matching.
  if (pattern === null || pattern.length === 0) return true;
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else if ("\^$+|()[]{}.".includes(character)) source += "\\" + character;
    else source += character;
  }
  source += "$";
  try {
    return new RegExp(source).test(name);
  } catch {
    return false;
  }
}

export async function createPiReviewerHost(registry: ModelRegistry, options: PiReviewerHostOptions): Promise<ReviewerHost> {
  const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  // Transfer ONLY the approved selected route's public registration/auth into
  // the isolated construction runtime: no all-provider copy, no auth-file scan
  // and no new credential persistence.
  const providerName = typeof options.model["provider"] === "string" ? options.model["provider"] : null;
  if (providerName !== null) {
    const native = registry.getRegisteredNativeProvider(providerName);
    if (native !== undefined) {
      modelRuntime.registerNativeProvider(native);
    } else {
      const config = registry.getRegisteredProviderConfig(providerName);
      if (config !== undefined) modelRuntime.registerProvider(providerName, config);
    }
  }
  const sessions = new WeakMap<ReviewerSession, { prompt(text: string): Promise<void>; abort(): Promise<void>; dispose(): void }>();

  const host: ReviewerHost = {
    async createSession({ cwd, agentDir, tools, hooks, deliveryBudget, holdPhysical, isRevoked }): Promise<ReviewerSession> {
      const settingsManager = SettingsManager.inMemory({ retry: { enabled: false, maxRetries: 0 }, compaction: { enabled: false }, cacheWarming: "off" });
      const resourceLoader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        // T02 ambient isolation: the fresh reviewer must not inherit an ambient
        // user/project system prompt or append-system prompt (SYSTEM.md /
        // APPEND_SYSTEM.md are discovered independently of noContextFiles).
        systemPrompt: "",
        appendSystemPrompt: [],
      });
      await resourceLoader.reload();
      const resultTool = defineTool({
        name: "submit_result",
        label: "Submit result",
        description: "Submit the canonical structured assessment result for this review.",
        parameters: { type: "object", additionalProperties: true } as never,
        execute: async (toolCallId: string, params: unknown) => {
          const operationEntry = typeof toolCallId === "string" ? consumeOp(toolCallId) : undefined;
          hooks.submit(params, operationEntry?.operationId);
          return { content: [{ type: "text", text: "result submitted" }], details: undefined };
        },
      });
      // C1 §12.3/§17.1: permitted roots are conditional. When a search/list tool
      // targets an ancestor of an engine-owned protected root, the tool runs on
      // the bounded admitted leaf targets instead of the whole subtree, so no
      // external search child can visit the excluded path while ordinary sibling
      // matches/names stay available. Direct protected targets are denied by the
      // runner; this wrapper never widens any grant.
      const protectedRootReal = (() => {
        try { return realpathSync.native(agentDir); } catch { return resolve(agentDir); }
      })();
      const adoptedBudget = (deliveryBudget as { maxAdditionalReadBytes: number; delivered: number } | undefined)
        ?? { maxAdditionalReadBytes: Number.POSITIVE_INFINITY, delivered: 0 };
      // D4: the configured aggregate additional-byte allowance bounds what is
      // ADOPTED into the model conversation, before later delivery — physical
      // acquisition stays a separate measurement. Excess evidence is truncated
      // with a truthful notice instead of being silently omitted.
      // F05: every supported adopted evidence surface counts against the same
      // allowance — text, real binary image payload bytes (decoded, not base64
      // framing), and the separators between retained blocks. Image data can no
      // longer pass merely because the accompanying text fits.
      const imagePayloadBytes = (block: unknown): number => {
        if (block === null || typeof block !== "object") return 0;
        const data = (block as { data?: unknown }).data;
        if (typeof data !== "string") return 0;
        const withoutPadding = data.replace(/=+$/u, "");
        return Math.floor((withoutPadding.length * 3) / 4);
      };
      const blockEvidenceBytes = (block: unknown): number => {
        if (block === null || typeof block !== "object") return 0;
        const kind = (block as { type?: string }).type;
        if (kind === "text") return Buffer.byteLength(String((block as { text?: unknown }).text ?? ""), "utf8");
        if (kind === "image") return imagePayloadBytes(block);
        return 0;
      };
      // 192/193/194: a structured truncation body duplicates source evidence already
      // bounded in `content`; it may never carry a DIFFERENT withheld slice of the
      // original source than the selection actually delivered. Deriving it from the
      // same admitted selection keeps one shared additional-evidence allowance and
      // cannot leak an over-cap body through details. Truthful limit metadata is kept
      // and equivalent duplication is not charged twice.
      const boundStructuredDetails = (details: unknown, deliveredText: string): unknown => {
        if (details === null || typeof details !== "object") return details;
        const record = details as Record<string, unknown>;
        const truncation = record["truncation"];
        if (truncation === null || typeof truncation !== "object") return details;
        const entry = truncation as Record<string, unknown>;
        const content = entry["content"];
        if (typeof content !== "string") return details;
        // The structured body is retained only when it is exactly the admitted
        // selection; otherwise it is reduced to that selection (empty when nothing
        // was delivered) so no differently-truncated original bytes ride along.
        if (content === deliveredText) return details;
        return { ...record, truncation: { ...entry, content: deliveredText, deliveryLimited: true } };
      };
      const boundDelivery = (content: unknown[], details: unknown): { content: unknown[]; details: unknown } => {
        const blocks = Array.isArray(content) ? content : [];
        const mergedText = blocks
          .filter(block => block !== null && typeof block === "object" && (block as { type?: string }).type === "text")
          .map(block => String((block as { text?: unknown }).text ?? ""))
          .join(String.fromCharCode(10));
        const imageBytes = blocks.reduce((total: number, block: unknown) => total + imagePayloadBytes(block), 0);
        const bytes = blocks.reduce((total: number, block: unknown) => total + blockEvidenceBytes(block), 0) + Math.max(0, blocks.length - 1);
        const remaining = Math.max(0, adoptedBudget.maxAdditionalReadBytes - adoptedBudget.delivered);
        if (bytes <= remaining) {
          adoptedBudget.delivered += bytes;
          return { content: blocks, details: boundStructuredDetails(details, mergedText) };
        }
        // The notice is evidence too: it is counted INSIDE the same remaining
        // allowance, clipped when the allowance is tiny, and an exhausted
        // allowance delivers nothing rather than overrunning the bound.
        if (remaining === 0) {
          return {
            content: [],
            details: boundStructuredDetails({
              ...(details !== null && typeof details === "object" ? details as Record<string, unknown> : {}),
              deliveryLimited: true,
              requestedBytes: bytes,
              deliveredBytes: 0,
            }, ""),
          };
        }
        // Image payload cannot be partially delivered: it is refused whole and
        // reported, while the allowance keeps its remaining text capacity.
        const textOnlyBlocks = blocks.filter(block => block !== null && typeof block === "object" && (block as { type?: string }).type === "text");
        const deliveredText = textOnlyBlocks.map(block => String((block as { text?: unknown }).text ?? "")).join(String.fromCharCode(10));
        const noticeFull = imageBytes > 0
          ? `[core.review-additional-bytes-limited] delivered=${remaining} requested=${bytes} image-refused=${imageBytes} remaining=0`
          : `[core.review-additional-bytes-limited] delivered=${remaining} requested=${bytes} remaining=0`;
        let notice = noticeFull;
        if (Buffer.byteLength(notice, "utf8") > remaining) {
          notice = new TextDecoder("utf-8").decode(Buffer.from(noticeFull, "utf8").subarray(0, remaining)).replace(/�$/u, "");
          if (notice.length === 0) notice = ".";
        }
        const separatorBytes = notice.length > 0 ? 1 : 0;
        const keep = Math.max(0, remaining - Buffer.byteLength(notice, "utf8") - separatorBytes);
        const head = new TextDecoder("utf-8").decode(Buffer.from(deliveredText, "utf8").subarray(0, keep)).replace(/�$/u, "");
        const boundedText = notice + (notice.length > 0 && head.length > 0 ? String.fromCharCode(10) + head : head);
        adoptedBudget.delivered += Buffer.byteLength(boundedText, "utf8");
        return {
          content: [{ type: "text", text: boundedText }],
          details: boundStructuredDetails({
            ...(details !== null && typeof details === "object" ? details as Record<string, unknown> : {}),
            deliveryLimited: true,
            requestedBytes: bytes,
            deliveredBytes: Buffer.byteLength(boundedText, "utf8"),
            imageBytesRefused: imageBytes,
          }, boundedText),
        };
      };
      const withinProtected = (candidate: string): boolean => {
        const resolved = (() => { try { return realpathSync.native(candidate); } catch { return resolve(candidate); } })();
        return resolved === protectedRootReal || resolved.startsWith(protectedRootReal + sep);
      };
      const ENUMERATION_BOUND = 16;
      const exclusionCounter = { excluded: 0 };
      type LeafPlan =
        | { kind: "delegate" }
        | { kind: "leaves"; leaves: string[]; fileTargets: string[] }
        | { kind: "refuse"; reason: string; detail: string };
      // Candidate enumeration happens BEFORE any search child is spawned. An
      // empty or failed admission at an ancestor of the protected root must
      // never fall through to a broad root search, and an over-bound enumeration
      // is signalled truthfully instead of being silently clipped.
      const admittedLeaves = (requested: string, activeTool: string): LeafPlan => {
        const base = resolve(cwd, requested);
        let realBase: string;
        try { realBase = realpathSync.native(base); } catch { return { kind: "delegate" }; }
        if (!(protectedRootReal === realBase || protectedRootReal.startsWith(realBase + sep))) return { kind: "delegate" };
        let entries: string[];
        try {
          entries = readdirSync(realBase);
        } catch {
          return { kind: "refuse", reason: "core.review-enumeration-failed", detail: "the requested root could not be enumerated, so no search was started" };
        }
        const collected = [];
        const fileTargets: string[] = [];
        const queue = [realBase];
        let visited = 0;
        while (queue.length > 0 && visited < 128) {
          visited += 1;
          const dir = queue.shift() as string;
          let children: string[];
          try {
            children = readdirSync(dir);
          } catch {
            return { kind: "refuse", reason: "core.review-enumeration-failed", detail: "the requested root could not be enumerated, so no search was started" };
          }
          for (const name of children) {
            const full = join(dir, name);
            const real = (() => { try { return realpathSync.native(full); } catch { return resolve(full); } })();
            if (real === protectedRootReal || real.startsWith(protectedRootReal + sep)) continue;
            if (protectedRootReal.startsWith(real + sep)) {
              // A container of the protected root is descended instead of being
              // dropped, so ordinary allowed content beside it stays reachable
              // while the protected branch is excluded at any depth.
              queue.push(full);
              continue;
            }
            // F03: every ACTUAL acquisition target is re-admitted under the
            // existing project/source grant. A file link or directory junction
            // whose canonical target escapes the admitted project root is
            // excluded BEFORE any search child can visit it — no output
            // redaction, no broad refusal, no name blacklist.
            const projectRootReal = (() => { try { return realpathSync.native(cwd); } catch { return resolve(cwd); } })();
            if (!(real === projectRootReal || real.startsWith(projectRootReal + sep))) {
              exclusionCounter.excluded += 1;
              continue;
            }
            // Kind-aware delegation: `find` (fd-backed) accepts directory
            // roots only, while `grep` (rg-backed) also accepts file targets.
            // Ordinary root files are still preserved for find through local
            // name matching instead of being silently omitted.
            const isDirectory = (() => { try { return statSync(full).isDirectory(); } catch { return false; } })();
            if (isDirectory) collected.push(full);
            else if (activeTool === "find") {
              fileTargets.push(full);
              if (collected.length + fileTargets.length > ENUMERATION_BOUND) {
                return { kind: "refuse", reason: "core.review-enumeration-truncated", detail: `the requested root admits more than ${ENUMERATION_BOUND} searchable targets; target a narrower path` };
              }
            }
            else collected.push(full);
            if (collected.length > ENUMERATION_BOUND) {
              return { kind: "refuse", reason: "core.review-enumeration-truncated", detail: `the requested root admits more than ${ENUMERATION_BOUND} searchable targets; target a narrower path` };
            }
          }
        }
        if (queue.length > 0) {
          return { kind: "refuse", reason: "core.review-enumeration-exhausted", detail: `enumeration reached its finite ${visited}-node bound with work remaining; target a narrower path` };
        }
        if (collected.length === 0 && fileTargets.length === 0) {
          return { kind: "refuse", reason: "core.review-enumeration-empty", detail: "the requested root admits no searchable target, so no broad search was started" };
        }
        return { kind: "leaves", leaves: collected, fileTargets };

      };
      const policyWrap = (definition: { execute: (...args: never[]) => Promise<{ content?: unknown[] } & Record<string, unknown>> } & Record<string, unknown>, toolName: string) => ({
        ...definition,
        execute: async (toolCallId: string, params: Record<string, unknown>, ...rest: unknown[]) => {
          const requested = typeof params?.["path"] === "string" ? params["path"] as string : ".";
          // `ls` keeps requested-root listing semantics (ordinary files and
          // directory entries, root-relative names). It is a shallow name/stat
          // enumeration, so the protected entry is filtered from the listing
          // instead of being enumerated per leaf (which would change semantics
          // and hide ordinary entries).
          if (toolName === "ls") {
            const delegated = await definition.execute(toolCallId as never, params as never, ...(rest as never[]));
            // 173/S2 + Astra189 §4.2: awaited delegated results are consumed and delivered only
            // under current authority; expired content is refused before filtering/delivery.
            if (isRevoked?.() === true) throw new Error("core.review-revoked");
            const protectedName = protectedRootReal.split(sep).filter(Boolean).pop() ?? "";
            const filtered = (delegated?.content ?? []).map(block => {
              if (block === null || typeof block !== "object" || (block as { type?: string }).type !== "text") return block;
              const text = String((block as { text?: unknown }).text ?? "");
              const kept = text.split(String.fromCharCode(10)).filter(line => {
                const first = line.trim().split(/[\/]/)[0] ?? "";
                return first !== protectedName;
              }).join(String.fromCharCode(10));
              return { ...(block as Record<string, unknown>), text: kept };
            });
            return boundDelivery(filtered, delegated?.details);
          }
          exclusionCounter.excluded = 0;
          // F08/F09: the lease is acquired BEFORE any real backend work starts
          // and released only when that work genuinely settles.
          const releaseOuterLease = holdPhysical === undefined ? undefined : holdPhysical();
          try {
          const plan = admittedLeaves(requested, toolName);
          if (plan.kind === "delegate") {
            const delegated = await definition.execute(toolCallId as never, params as never, ...(rest as never[]));
            // 173/S2 + Astra189 §4.2: the awaited delegate result is delivered only under
            // current authority; a delegate that resolves after the absolute review deadline
            // cannot have its content adopted as fresh evidence.
            if (isRevoked?.() === true) throw new Error("core.review-revoked");
            return boundDelivery((delegated?.content ?? []) as unknown[], delegated?.details);
          }
          if (plan.kind === "refuse") {
            // F05: refusals/limitations are adopted evidence too, so they pass
            // through the same cumulative allowance instead of bypassing it.
            return boundDelivery([{ type: "text", text: `[${plan.reason}] ${plan.detail}` }], { reason: plan.reason });
          }
          // D1: one logical result/match allowance across all decomposed
          // targets — the caller's limit is divided, never multiplied.
          // F02: ONE shared logical search allowance across every delegated
          // target AND every locally matched result — the caller's explicit
          // limit, or the tool's own canonical default, is never restarted or
          // multiplied per target, and no minimum-one escape can overshoot it.
          const requestedLimit = (() => {
            const raw = params?.["limit"];
            if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) return Math.floor(raw);
            return toolName === "find" ? 1000 : 100;
          })();
          let remainingLimit = requestedLimit;
          let omittedTargets = 0;
          const notices = [];
          const localFileMatches = plan.fileTargets.map(file => {
            const name = file.split(sep).pop() ?? file;
            const pattern = typeof params?.["pattern"] === "string" ? params["pattern"] as string : null;
            if (!nameMatchesPattern(name, pattern)) return null;
            if (remainingLimit <= 0) { omittedTargets += 1; return null; }
            remainingLimit -= 1;
            return resolve(file).slice(resolve(cwd).length + 1).split(sep).join("/");
          }).filter((entry): entry is string => entry !== null);
          const results = [];
          for (const leaf of plan.leaves) {
            if (remainingLimit <= 0) { omittedTargets += 1; continue; }
            // 173/S2 + Astra189 §4.2: no further owned acquisition after the absolute review
            // deadline, and an awaited leaf result is accumulated only under current authority.
            if (isRevoked?.() === true) throw new Error("core.review-revoked");
            const targetsLeft = Math.max(1, plan.leaves.length - results.length);
            const share = Math.max(1, Math.ceil(remainingLimit / targetsLeft));
            const boundedShare = Math.min(share, remainingLimit);
            remainingLimit -= boundedShare;
            const leafResult = await definition.execute(toolCallId as never, { ...params, limit: boundedShare, path: leaf } as never, ...(rest as never[]));
            if (isRevoked?.() === true) throw new Error("core.review-revoked");
            results.push(leafResult);
          }
          if (exclusionCounter.excluded > 0) {
            notices.push(`[core.review-target-excluded] escaped=${exclusionCounter.excluded}`);
          }
          if (omittedTargets > 0 || plan.leaves.length + plan.fileTargets.length > 1) {
            notices.push(`[core.review-aggregate-limit] logical-limit=${requestedLimit} targets=${plan.leaves.length + plan.fileTargets.length} omitted=${omittedTargets}`);
          }
          // One logical request keeps ONE canonical result bound: the merged
          // output of the decomposed targets is bounded by the same public
          // default byte limit a single call uses, and truncation is reported
          // truthfully instead of silently clipping or multiplying the budget.
          const merged = [...localFileMatches, ...notices, ...results
            .flatMap(result => (result?.content ?? []) as { type?: string; text?: unknown }[])
            .filter(block => block?.type === "text")
            .map(block => String(block.text ?? ""))
            ].join(String.fromCharCode(10));
          const mergedBytes = Buffer.byteLength(merged, "utf8");
          const truncated = mergedBytes > DEFAULT_MAX_BYTES;
          let bounded = merged;
          if (truncated) {
            // The truthfulness notice travels in the delivered text itself, not
            // only in an optional details channel, and it counts against the
            // same single canonical byte ceiling as the retained content.
            const notice = `[core.review-aggregate-truncated] targets=${plan.leaves.length} original-bytes=${mergedBytes}`;
            const noticeBytes = Buffer.byteLength(notice + String.fromCharCode(10), "utf8");
            const keep = Math.max(0, DEFAULT_MAX_BYTES - noticeBytes);
            const head = new TextDecoder("utf-8").decode(Buffer.from(merged, "utf8").subarray(0, keep)).replace(/�$/u, "");
            bounded = notice + String.fromCharCode(10) + head;
          }
          return boundDelivery(
            [{ type: "text", text: bounded }],
            { truncated, aggregateTargets: plan.leaves.length, aggregateBytes: mergedBytes, originalBytes: mergedBytes },
          );
          } finally {
            releaseOuterLease?.();
          }
        },
      });
      // P1: a single fail-closed acquisition gate for every owned backend
      // operation; it lives in the session closure, not inside a tool options
      // object, and refuses new work on a revoked owner.
      const acquire = () => {
        if (isRevoked?.() === true) throw new Error("core.review-revoked");
        return holdPhysical?.();
      };
      const wrappedTools = [
        tools.includes("grep") ? policyWrap(createGrepToolDefinition(cwd) as never, "grep") : null,
        tools.includes("find") ? policyWrap(createFindToolDefinition(cwd, {
          // F08/F09 find-backend ownership: the default fd child aborts by
          // rejecting BEFORE its real close. This owned glob is a bounded
          // walk implemented in-process, so the run's physical lease spans the
          // actual directory reads and no hidden child can outlive it.
          operations: {
            exists: async (absolutePath: string) => {
              // 173/S1: the actual owned backend acquisition consults the same
              // authority gate as the ls/find/read backends; a physical lease is
              // bookkeeping, not permission.
              const release = acquire();
              try { try { await fsAccess(absolutePath); return true; } catch { return false; } } finally { release?.(); }
            },
            glob: async (pattern: string, root: string, options: { ignore: string[]; limit: number }) => {
              const release = holdPhysical?.();
              try {
                const results: string[] = [];
                const ignoreSet = new Set(options.ignore ?? []);
                const queue = [root];
                while (queue.length > 0 && results.length < options.limit) {
                  if (isRevoked?.() === true) break; // P1: no fresh nested read after revocation
                  const dir = queue.shift() as string;
                  let entries: { name: string; isDirectory: () => boolean }[] = [];
                  try {
                    const dirents = await fsReaddir(dir, { withFileTypes: true });
                    if (isRevoked?.() === true) break; // 173/S2: revalidate BEFORE consuming the returned entries
                    entries = dirents.map(entry => ({ name: entry.name, isDirectory: () => entry.isDirectory() }));
                  } catch {
                    continue;
                  }
                  // 151 repair: re-check the already-owned absolute revocation/deadline view AFTER the
                  // awaited nested return and BEFORE consuming or enqueuing its entries, so a nested
                  // enumeration that resolves late cannot adopt or extend expired traversal authority.
                  if (isRevoked?.() === true) break;
                  for (const entry of entries) {
                    if (ignoreSet.has(entry.name)) continue;
                    const full = join(dir, entry.name);
                    if (entry.isDirectory()) { queue.push(full); continue; }
                    const relative = full.slice(root.length + 1).split(sep).join("/");
                    if (nameMatchesPattern(entry.name, pattern) || nameMatchesPattern(relative, pattern)) results.push(relative);
                    if (results.length >= options.limit) break;
                  }
                }
                return results.slice(0, options.limit);
              } finally { release?.(); }
            },
          },
        } as never) as never, "find") : null,
        tools.includes("ls") ? policyWrap(createLsToolDefinition(cwd, {
          // F08/F09 ls-backend ownership: every async I/O the list tool needs
          // runs through these leased operations, so the run's lease spans the
          // real stat/readdir work instead of only the early-settling tool
          // promise.
          operations: {
            exists: async (absolutePath: string) => {
              const release = acquire();
              try { try { await fsAccess(absolutePath); return true; } catch { return false; } } finally { release?.(); }
            },
            stat: async (absolutePath: string) => {
              const release = acquire();
              try {
                const stats = await fsStat(absolutePath);
                if (isRevoked?.() === true) throw new Error("core.review-revoked");
                return { isDirectory: () => stats.isDirectory() };
              } finally { release?.(); }
            },
            readdir: async (absolutePath: string) => {
              const release = acquire();
              try {
                const entries = await fsReaddir(absolutePath);
                if (isRevoked?.() === true) throw new Error("core.review-revoked");
                return entries;
              } finally { release?.(); }
            },
          },
        } as never) as never, "ls") : null,
        tools.includes("read") ? policyWrap((() => {
          // F08/F09 read-pipeline ownership: the package-owned execute owns the
          // WHOLE pipeline — path resolution, byte read, image encode and text
          // truncation — so no hidden SDK stage can outlive the root lease, and
          // the lease is released only after every owned stage genuinely
          // settles. Same public schema/description; supported images and text
          // truncation semantics preserved.
          const base = createReadToolDefinition(cwd) as unknown as { name: string; label: string; description: string; parameters: unknown };
          return {
            ...base,
            execute: async (_toolCallId: string, params: Record<string, unknown>) => {
              const releaseRoot = holdPhysical?.();
              try {
                const requested = typeof params["path"] === "string" ? params["path"] as string : "";
                const releaseResolve = holdPhysical?.();
                let absolute: string;
                try {
                  absolute = realpathSync.native(resolve(cwd, requested));
                } catch (error) {
                  if ((error as { code?: string }).code === "ENOENT") absolute = resolve(cwd, requested);
                  else throw error;
                } finally {
                  releaseResolve?.();
                }
                const rootReal = (() => { try { return realpathSync.native(cwd); } catch { return resolve(cwd); } })();
                if (!(absolute === rootReal || absolute.startsWith(rootReal + sep))) {
                  throw new Error("read denied: path is outside the admitted project root");
                }
                const releaseRead = holdPhysical?.();
                let bytes: Buffer;
                try {
                  // 173/S1: the actual owned backend acquisition rechecks current authority; a physical lease is not permission.
                  if (isRevoked?.() === true) throw new Error("core.review-revoked");
                  bytes = await fsReadFile(absolute);
                  // 173/S2: the returned bytes are adopted only under current
                  // authority. A read that acquired while live but resolved after
                  // the absolute review deadline must not become fresh evidence;
                  // the bytes were already produced, so this is logical refusal,
                  // not physical drain or retroactive accounting.
                  if (isRevoked?.() === true) throw new Error("core.review-revoked");
                } finally {
                  releaseRead?.();
                }
                const mime = ownedImageMime(absolute, bytes);
                if (mime !== null) {
                  return {
                    content: [{ type: "image", data: bytes.toString("base64"), mimeType: mime, note: `${basename(absolute)} (${bytes.length} bytes)` }],
                    details: undefined,
                  };
                }
                let text = bytes.toString("utf8");
                // 205-F2B/208: honor the publicly exposed pinned read schema — `offset` is
                // ONE-indexed and `limit` applies independently of it — and carry the OBSERVED
                // returned selection (one-indexed inclusive line coordinates) into the tool details,
                // so custody can distinguish requested from actually returned coordinates.
                const requestedOffset = typeof params["offset"] === "number" && Number.isFinite(params["offset"]) ? Math.max(1, Math.floor(params["offset"] as number)) : null;
                const requestedLimit = typeof params["limit"] === "number" && Number.isFinite(params["limit"]) ? Math.max(1, Math.floor(params["limit"] as number)) : null;
                let observedSelection: { startLine: number; endLine: number; totalLines: number; unit: "line" } | null = null;
                if (requestedOffset !== null || requestedLimit !== null) {
                  const lines = text.split(String.fromCharCode(10));
                  const start = (requestedOffset ?? 1) - 1;
                  const end = requestedLimit === null ? lines.length : start + requestedLimit;
                  const kept = lines.slice(start, end);
                  observedSelection = { startLine: start + 1, endLine: start + kept.length, totalLines: lines.length, unit: "line" };
                  text = kept.join(String.fromCharCode(10));
                }
                const truncation = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
                return {
                  content: [{ type: "text", text: truncation.content }],
                  details: { truncation, ...(observedSelection === null ? {} : { readSelection: observedSelection }) },
                };
              } finally {
                releaseRoot?.();
              }
            },
          };
        })() as never, "read") : null,
      ].filter((entry): entry is never => entry !== null);
      const { session } = await createAgentSession({
        cwd,
        agentDir,
        modelRuntime,
        model: options.model as never,
        thinkingLevel: options.reasoning ?? "off",
        tools: [...tools, "submit_result"],
        customTools: [resultTool as never, ...wrappedTools],
        resourceLoader,
        settingsManager,
        sessionManager: SessionManager.inMemory(),
      });
      // 201-F2: capture the actual requested target/selection at the real permission
      // boundary for this exact owned call identity; the pinned tool_execution_end does
      // not carry args, so this join is the only truthful target source.
      // 201-F4/206: one engine-owned operation identity per actual call, carried from admission
      // through its result so the owner operation records join the same call across phases.
      let callSequence = 0;
      const pendingToolOps = new Map<string, { args: Record<string, unknown>; operationId: string; denied?: boolean }>();
      const argsOf = (toolCallId: string): Record<string, unknown> | undefined => pendingToolOps.get(toolCallId)?.args;
      const consumeOp = (toolCallId: string): { args: Record<string, unknown>; operationId: string; denied?: boolean } | undefined => {
        const entry = pendingToolOps.get(toolCallId);
        pendingToolOps.delete(toolCallId);
        return entry;
      };
      const unsubscribe = session.subscribe(event => {
        const accounted = toolResultBytes(event, argsOf);
        const operationEntry = accounted === null || accounted.toolCallId === undefined ? undefined : consumeOp(accounted.toolCallId);
        if (accounted !== null) hooks.noteToolResult(accounted.toolName, accounted.bytes, {
          ...(operationEntry === undefined ? {} : { operationId: operationEntry.operationId }),
          ...(operationEntry?.denied === true ? { denied: true } : {}),
          ...(accounted.toolCallId === undefined ? {} : { toolCallId: accounted.toolCallId }),
          ...(accounted.path === undefined ? {} : { path: accounted.path }),
          ...(accounted.selectedBytes === undefined ? {} : { selectedBytes: accounted.selectedBytes }),
          ...(accounted.selectedDigest === undefined ? {} : { selectedDigest: accounted.selectedDigest }),
          sourceVersion: accounted.sourceVersion ?? null,
          ...(accounted.requested === undefined ? {} : { requested: accounted.requested }),
          ...(accounted.actual === undefined ? {} : { actual: accounted.actual }),
          ...(accounted.truncated === true ? { truncated: true } : {}),
          sourceBytes: accounted.sourceBytes ?? null,
          ...(accounted.serializedBytes === undefined ? {} : { serializedBytes: accounted.serializedBytes }),
          ...(accounted.isError === true ? { isError: true } : {}),
        });
      });
      const contextImageBlocks = (context: unknown): number => {
        const messages = (context as { messages?: unknown })?.messages;
        let count = 0;
        for (const message of Array.isArray(messages) ? messages : []) {
          const content = (message as { content?: unknown })?.content;
          for (const block of Array.isArray(content) ? content : []) {
            if (block !== null && typeof block === "object" && (block as { type?: string }).type === "image") count += 1;
          }
        }
        return count;
      };
      const withholdUnsupportedImages = (context: unknown): unknown => {
        const record = context as { messages?: unknown[] } | null;
        if (record === null || !Array.isArray(record.messages)) return context;
        let replaced = 0;
        const messages = record.messages.map(message => {
          const content = (message as { content?: unknown })?.content;
          if (!Array.isArray(content)) return message;
          const blocks = content.map(block => {
            if (block !== null && typeof block === "object" && (block as { type?: string }).type === "image") {
              replaced += 1;
              return { type: "text", text: "[core.model-input-unsupported] image evidence withheld: the selected model declares text-only input" };
            }
            return block;
          });
          return { ...(message as Record<string, unknown>), content: blocks };
        });
        return replaced > 0 ? { ...(context as Record<string, unknown>), messages } : context;
      };
      const selectedInputKinds = (() => {
        const raw = (options.model as { input?: unknown })?.input;
        return Array.isArray(raw) ? raw.map(String) : [];
      })();
      session.agent.streamFunction = async (_model, context, streamOptions) => {
        // F10: actual represented input kinds must pass the selected route's
        // declared capability BEFORE transport. For a text-only model the image
        // blocks are withheld and replaced with an explicit supported
        // limitation, so the turn still reaches its callback without image
        // evidence — no fake visual success, no route or grant change.
        let turnContext: unknown = context;
        if (contextImageBlocks(context) > 0 && !selectedInputKinds.includes("image")) {
          turnContext = withholdUnsupportedImages(context);
        }
        // 201-F2A/206: the bounded owner-issued identity must stay available in EVERY actual input
        // while the evidence remains available — the pinned SDK does not retain this adapter's
        // private request copy, so the note is rebuilt per turn. De-duplication is by token+revision
        // so a later revision or selection of the same resource still appears. Metadata only.
        const issuedEvidence = hooks.issuedEvidence?.() ?? [];
        const availableEvidence = [...new Map(issuedEvidence.map(item => [`${item.token} ${item.revision}`, item])).values()].slice(0, 8);
        if (availableEvidence.length > 0) {
          const lines = availableEvidence.map(item => `[reviewer-evidence ${item.token} rev ${item.revision} source ${item.source} sourceVersion ${item.sourceVersion ?? "unknown"} selectedDigest ${item.selectedDigest} selection ${item.selection} role ${item.role} disposition ${item.disposition} bytes ${item.bytes}]`);
          const baseMessages = ((turnContext as { messages?: unknown[] } | null)?.messages ?? []) as unknown[];
          turnContext = {
            ...(turnContext as Record<string, unknown>),
            messages: [...baseMessages, {
              role: "user",
              content: [{ type: "text", text: `Additional evidence acquired by the permitted tools:\n${lines.join(String.fromCharCode(10))}\nCite these issued evidence identities in your canonical result when you rely on them.` }],
            }],
          };
        }
        // F01: the strongest observable actual-input manifest/digest for THIS
        // turn — computed over the post-withholding selected SDK material, so
        // it binds what was really sent rather than the pre-transform fixture.
        const turnMessages = ((turnContext as { messages?: unknown[] } | null)?.messages ?? []) as unknown[];
        const turnBlockCount = turnMessages.reduce((total: number, message) => {
          const content = (message as { content?: unknown })?.content;
          return total + (Array.isArray(content) ? content.length : 0);
        }, 0);
        const turnDigest = createHash("sha256").update(JSON.stringify(turnContext ?? null)).digest("hex");
        const turnManifestRef = `review-turn:msgs=${turnMessages.length}:blocks=${turnBlockCount}:digest=${turnDigest.slice(0, 16)}`;
        const admitted = await hooks.beginTurn(turnContext as never, streamOptions, {
          inputManifestRef: turnManifestRef,
          inputSerializedDigest: turnDigest,
        });
        if (!admitted.ok) {
          // Local pre-transport refusal: terminate the SDK turn with the public
          // closed error/aborted stream instead of throwing, while the shared
          // owner keeps the refusal reason and any released intent audit row.
          hooks.noteRefusal?.(admitted.error.code);
          return reviewerRefusalStream(asRecord(_model) ?? {}, admitted.error.code) as never;
        }
        return admitted.value.stream as never;
      };
      session.agent.beforeToolCall = async ({ toolCall, args }) => {
        callSequence += 1;
        const operationId = `reviewer-call-${callSequence}`;
        const admitted = hooks.allowToolCall(toolCall.name, args as Record<string, unknown> | undefined, operationId);
        // 205-F4/208: keep the SDK-call -> operation join even for a DENIED call. The pinned SDK
        // still emits a blocked terminal event for it; the same owned identity and the truthful
        // not-executed disposition must be reported instead of inventing a second operation.
        if (typeof toolCall.id === "string" && toolCall.id.length > 0) {
          if (pendingToolOps.size >= 32) pendingToolOps.delete(pendingToolOps.keys().next().value as string);
          pendingToolOps.set(toolCall.id, {
            args: (args ?? {}) as Record<string, unknown>,
            operationId,
            ...(admitted ? {} : { denied: true }),
          });
        }
        if (!admitted) return { block: true, reason: "core.review-tool-denied" };
        return undefined;
      };
      session.agent.finishTurn = () => (hooks.shouldEndTurn() || hooks.isTerminated() ? { action: "end" } : undefined);
      // Session-root physical lease: a reviewer session may keep executing an
      // owned tool body AFTER the runner returns/disposes it (the SDK's inner
      // operation continues). This root lease keeps the run's reservation until
      // the session is actually disposed, so work that starts in that window
      // still holds the run; per-operation leases cover the rest.
      const releaseSessionLease = holdPhysical?.();
      const handle: ReviewerSession = {
        dispose: () => {
          unsubscribe();
          session.dispose();
          releaseSessionLease?.();
        },
      };
      sessions.set(handle, {
        prompt: (text: string) => session.prompt(text),
        abort: () => session.abort(),
        dispose: () => session.dispose(),
      });
      return handle;
    },
    async prompt(session, text): Promise<void> {
      const entry = sessions.get(session);
      if (entry === undefined) return;
      await entry.prompt(text);
    },
    async abort(session): Promise<void> {
      const entry = sessions.get(session);
      if (entry === undefined) return;
      await entry.abort();
    },
  };
  return host;
}

/**
 * Closed public protocol refusal stream: an error event plus a terminal
 * assistant with matching stop reason and bounded engine error message. This
 * is protocol termination only - it is not a provider call, an owned attempt or
 * a usage receipt (its zero-shaped usage is never invoiced).
 */
function reviewerRefusalStream(model: Record<string, unknown>, reasonCode: string): unknown {
  const aborted = reasonCode === "core.review-timeout" || reasonCode === "core.run-revoked" || reasonCode === "core.model-request-cancelled";
  const message = {
    role: "assistant",
    content: [],
    api: typeof model["api"] === "string" ? model["api"] : "unknown",
    provider: typeof model["provider"] === "string" ? model["provider"] : "unknown",
    model: typeof model["id"] === "string" ? model["id"] : "unknown",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    stopReason: aborted ? "aborted" : "error",
    errorMessage: reasonCode.slice(0, 192),
    timestamp: Date.now(),
  };
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "error", reason: message.stopReason, error: message };
    },
    async result() {
      return message;
    },
  };
}

/** @deprecated retained only for older harnesses; the bridge returns a refusal stream. */
export class ReviewerAdmissionError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}
