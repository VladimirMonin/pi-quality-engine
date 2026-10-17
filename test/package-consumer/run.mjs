import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime,
  SessionManager, SettingsManager, VERSION,
} from "@earendil-works/pi-coding-agent";

// Clean package consumer fixture. It runs from an extracted/installed copy of
// the packed candidate, outside the source repository, and creates no product
// files: only evidence of what the installed artifact actually loads.

const consumerRoot = process.cwd();
const fixtureRoot = join(consumerRoot, "fixture");
const agentDir = join(fixtureRoot, "agent");
const projectDir = join(fixtureRoot, "project");
const homeDir = join(fixtureRoot, "home");

process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.HOME = homeDir;
process.env.USERPROFILE = homeDir;

const noop = () => {};

async function listOrEmpty(root) {
  try {
    return (await readdir(root, { recursive: true })).sort();
  } catch {
    return [];
  }
}

async function readStatus(runner, messages) {
  const command = runner.getCommand("quality");
  assert.ok(command, "quality command is registered in the installed package");
  await command.handler("status", runner.createCommandContext());
  return JSON.parse(messages.at(-1));
}

await mkdir(agentDir, { recursive: true });
await mkdir(projectDir, { recursive: true });
await mkdir(homeDir, { recursive: true });

const entryUrl = import.meta.resolve("pi-quality-engine");
const entryPath = fileURLToPath(entryUrl);
const packageRoot = dirname(dirname(entryPath));
const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
const inventory = await readdir(packageRoot, { recursive: true });

const relative = resolve(packageRoot).startsWith(resolve(consumerRoot) + sep);
assert.equal(relative, true, "the engine package resolves inside the clean consumer root");
assert.equal(entryPath, resolve(packageRoot, "dist", "index.js"));
assert.deepEqual(manifest.pi?.extensions, ["./dist/index.js"]);
assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
assert.equal(Object.keys(manifest.dependencies ?? {}).some(name => name.startsWith("@earendil-works/")), false);
assert.equal(inventory.some(path => path.includes("@earendil-works")), false, "the tarball must not carry a host SDK copy");

const loader = new DefaultResourceLoader({
  cwd: projectDir,
  agentDir,
  settingsManager: SettingsManager.inMemory(),
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  additionalExtensionPaths: [entryPath],
});
await loader.reload();
const loaded = loader.getExtensions();
assert.deepEqual(loaded.errors, []);
assert.equal(loaded.extensions.length, 1);
const extension = loaded.extensions[0];
assert.ok(extension);
assert.equal(resolve(extension.resolvedPath), entryPath);
assert.equal(extension.tools.size, 0);
assert.deepEqual([...extension.commands.keys()], ["quality"]);
assert.deepEqual([...extension.handlers.keys()].sort(), [
  "agent_before_settle", "agent_settled", "before_agent_start", "before_provider_request",
  "input", "session_shutdown", "session_start", "tool_execution_end",
  "tool_execution_start", "turn_end",
]);
assert.equal(extension.handlers.has("before_provider_request"), true);
for (const providerEvent of ["before_provider_headers", "after_provider_response"]) {
  assert.equal(extension.handlers.has(providerEvent), false);
}

const models = await ModelRuntime.create({
  authPath: join(fixtureRoot, "auth.json"),
  modelsPath: null,
  modelsStorePath: join(fixtureRoot, "models-cache.json"),
  refreshOnCreate: false,
  allowModelNetwork: false,
});
const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, projectDir, SessionManager.inMemory(projectDir), new ModelRegistry(models));
const effects = { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 };
runner.bindCore({
  sendMessage: () => { effects.sendMessage += 1; }, sendUserMessage: () => { effects.sendUserMessage += 1; },
  appendEntry: () => { effects.appendEntry += 1; }, setSessionName: noop,
  getSessionName: () => undefined, setLabel: noop, getActiveTools: () => [], getAllTools: () => [],
  getSettings: () => ({}), setActiveTools: noop, refreshTools: noop, getCommands: () => [],
  setModel: noop, getThinkingLevel: () => "off", setThinkingLevel: noop,
}, {
  getModel: () => undefined, getScopedModels: () => [], isIdle: () => true, isProjectTrusted: () => true,
  getSignal: () => undefined, abort: () => { effects.abort += 1; }, hasPendingMessages: () => false, shutdown: noop,
  getContextUsage: () => undefined, compact: noop, getSystemPrompt: () => "",
});
const messages = [];
runner.setUIContext({ ...runner.getUIContext(), notify: message => messages.push(message) }, "rpc");

const fixtureBefore = await listOrEmpty(fixtureRoot);
const inactive = await readStatus(runner, messages);
assert.equal(inactive.runtime.state, "inactive");
assert.equal(inactive.configuration.enabled, false);

await runner.emit({ type: "session_start", reason: "startup" });
const active = await readStatus(runner, messages);
assert.equal(active.runtime.state, "active");
assert.equal(active.configuration.enabled, false);
assert.equal(active.configuration.mode, "observe");
assert.deepEqual(active.diagnostics.recentEvents.map(record => record.event), [
  "quality.runtime.started",
  "quality.config.applied",
]);

await runner.emit({ type: "session_shutdown", reason: "quit" });
const retired = await readStatus(runner, messages);
assert.equal(retired.runtime.state, "retired");
assert.deepEqual(retired.diagnostics.recentEvents.map(record => record.event), [
  "quality.runtime.started",
  "quality.config.applied",
  "quality.runtime.retired",
  "quality.journal.closed",
]);
const afterInertStart = (await listOrEmpty(fixtureRoot)).filter(entry => !fixtureBefore.includes(entry));
assert.ok(
  afterInertStart.every(entry => /^agent[\\/]quality([\\/]state.*)?$/u.test(entry)),
  `the installed inert engine only creates its control checkpoint (${afterInertStart.join(",")})`,
);
assert.deepEqual(await listOrEmpty(join(agentDir, "quality", "logs")), [], "a disabled journal creates no destination");
assert.deepEqual(await listOrEmpty(projectDir), []);
assert.deepEqual(effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 }, "the installed engine attempts no primary effect");

// Phase two: the installed package runs the enabled deterministic loop and
// resolves its shipped prompt resource through the real timer.
const promptResourcePath = join(packageRoot, "resources", "prompts", "repetition-v1.md");
const resourcesResolved = existsSync(promptResourcePath);
assert.equal(resourcesResolved, true, "the packed artifact ships its prompt resource");
await mkdir(join(agentDir, "quality"), { recursive: true });
await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
  schemaVersion: 1,
  enabled: true,
  mode: "observe",
  prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
  contexts: {
    "recent-work": {
      providers: [
        { id: "task", use: "core.task" },
        { id: "history", use: "core.history", options: { limit: 12, includeToolBodies: false } },
        { id: "waits", use: "core.waits" },
      ],
    },
  },
  evaluators: { "repetition-check": { use: "core.repeated-tools" } },
  policies: { record: { use: "core.record-only" } },
  checks: {
    repetition: {
      triggers: [{ id: "periodic", use: "core.periodic", options: { everyMs: 150, requireNewEvidence: false } }],
      context: "recent-work",
      prompt: "repetition",
      evaluator: "repetition-check",
      policy: "record",
      cooldownMs: 0,
      criteria: ["efficiency.repetition"],
    },
  },
}), "utf8");
await runner.emit({ type: "session_start", reason: "reload" });
await runner.emit({ type: "input", text: "assess repetition", source: "interactive" });
const loopDeadline = Date.now() + 2_500;
let installedLoopRuns = 0;
let promptResourceRefs = [];
for (;;) {
  const status = await readStatus(runner, messages);
  installedLoopRuns = status.checks.runs;
  promptResourceRefs = status.diagnostics.recentEvents
    .filter(record => record.event === "quality.context.manifest")
    .flatMap(record => record.fields.data.resourceRefs ?? []);
  if (installedLoopRuns >= 1 || Date.now() > loopDeadline) break;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
}
assert.ok(installedLoopRuns >= 1, "the installed package admitted a check by time");
assert.ok(promptResourceRefs.includes("builtin:repetition-v1.md"), "the installed prompt resource resolved");
const journalDirectory = join(agentDir, "quality", "logs");
// The installed file sink is asynchronous: poll bounded for the projected
// settlement record rather than assuming the in-memory status and file bytes
// are synchronized at the same instant.
const journalDeadline = Date.now() + 1_500;
let journalText = "";
for (;;) {
  const active = (await listOrEmpty(journalDirectory)).filter(name => name.endsWith(".jsonl"));
  journalText = active.length === 0 ? "" : await readFile(join(journalDirectory, active[0]), "utf8");
  if (journalText.includes("quality.check.settled") || Date.now() > journalDeadline) break;
  await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
}
assert.ok(journalText.includes("quality.check.settled"), "the installed journal contains the settlement");
await runner.emit({ type: "session_shutdown", reason: "quit" });

process.stdout.write(`QE_CONSUMER_REPORT=${JSON.stringify({
  ok: true,
  packageRoot,
  packageVersion: manifest.version,
  entryPath,
  resolvedEntry: resolve(extension.resolvedPath),
  hostVersion: VERSION,
  peerRange: manifest.peerDependencies?.["@earendil-works/pi-coding-agent"],
  extensionCount: loaded.extensions.length,
  loadErrors: loaded.errors,
  commandNames: [...extension.commands.keys()],
  handlerEvents: [...extension.handlers.keys()].sort(),
  toolCount: extension.tools.size,
  statuses: {
    inactive: inactive.runtime.state,
    active: active.runtime.state,
    retired: retired.runtime.state,
  },
  eventNames: retired.diagnostics.recentEvents.map(record => record.event),
  effectCounts: effects,
  resourcesResolved,
  installedLoopRuns,
  promptResourceRefs,
  journalFiles: (await listOrEmpty(journalDirectory)).filter(name => name.endsWith(".jsonl")),
  fixtureFilesCreated: afterInertStart,
})}\n`);

// Phase three (K05): the installed artifact runs a real reviewer session with a
// local scripted provider and its permitted read reaches a later provider input
// before the canonical submission is accepted. PRELIMINARY while the traversal
// question is unresolved; it is not the final common/package gate.
const reviewerSeen = { arrivals: 0, transcripts: [], results: [] };
const RESULT = {
  operational: "completed",
  coverage: { state: "complete", scopeDescription: "installed reviewer witnessed the permitted file", issues: [] },
  conclusion: "no-supported-finding",
  findings: [], scores: [], additionalEvidence: [], dependencies: [], usageAttemptIds: [],
};
function reviewerMessage(model, content, stopReason) {
  return {
    role: "assistant", content, api: model.api, provider: model.provider, model: model.id,
    usage: { input: 120, output: 30, cacheRead: 0, cacheWrite: 0, totalTokens: 150, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason, timestamp: Date.now(),
  };
}
function reviewerStream(message) {
  return {
    async *[Symbol.asyncIterator]() {
      yield { type: "start", partial: { ...message, content: [] } };
      yield { type: "done", reason: message.stopReason, message };
    },
    async result() { return message; },
  };
}
await writeFile(join(projectDir, "notes.md"), "K05_INSTALLED_REVIEWER_BODY", "utf8");
await writeFile(join(agentDir, "quality", "evidence.md"), "installed-marker-evidence", "utf8");
await writeFile(join(agentDir, "quality", "config.json"), JSON.stringify({
  schemaVersion: 1,
  enabled: true,
  mode: "observe",
  sources: { evidence: { uris: ["evidence.md"], role: "evidence", required: true } },
  modelProfiles: { scripted: { provider: "qe-package-reviewer", model: "scripted-1", price: "unknown", requiredInputs: ["text"], requestTimeoutMs: 30000 } },
  permissions: { modelProfiles: ["scripted"] },
  prompts: { repetition: { use: "core.prompt-files", options: { instructions: ["builtin:repetition-v1.md"] } } },
  contexts: { work: { providers: [{ id: "files", use: "core.files", options: { sourceIds: ["evidence"] } }], maxEstimatedTokens: 8000 } },
  evaluators: { direct: { use: "core.pi-session", modelProfile: "scripted", options: { timeoutMs: 30000 } } },
  policies: { record: { use: "core.record-only" } },
  checks: { direct: { triggers: [{ id: "due", use: "core.every-tools", options: { count: 1 } }], context: "work", prompt: "repetition", evaluator: "direct", policy: "record", cooldownMs: 0, criteria: ["efficiency.repetition"], workStates: ["work-expected"], maxRunsPerEpisode: 2 } },
}), "utf8");
models.registerProvider("qe-package-reviewer", {
  name: "scripted installed reviewer provider",
  api: "qe-package-reviewer-api",
  apiKey: "fixture-not-credential",
  baseUrl: "http://127.0.0.1:9/not-used",
  streamSimple: (model, context) => {
    reviewerSeen.arrivals += 1;
    reviewerSeen.transcripts.push(JSON.stringify(context.messages ?? []));
    const message = reviewerSeen.arrivals === 1
      ? reviewerMessage(model, [{ type: "toolCall", id: "pkg-read", name: "read", arguments: { path: "notes.md" } }], "toolUse")
      : reviewerMessage(model, [{ type: "toolCall", id: "pkg-submit", name: "submit_result", arguments: RESULT }], "toolUse");
    return reviewerStream(message);
  },
  models: [{ id: "scripted-1", name: "scripted", api: "qe-package-reviewer-api", input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32_768, maxTokens: 8_192 }],
});
await runner.emit({ type: "session_start", reason: "startup" });
const packaged = await readStatus(runner, messages);
assert.equal(packaged.configuration.rejection, null, "the installed package accepts the reviewer configuration");
await runner.emit({ type: "input", text: "installed reviewer", source: "interactive" });
await runner.emit({ type: "tool_execution_start", toolCallId: "pkg-1", toolName: "read", args: {} });
await runner.emit({ type: "tool_execution_end", toolCallId: "pkg-1", toolName: "read", result: { content: [] }, isError: false, durationMs: 1 });
const packagedDeadline = Date.now() + 30_000;
let packagedSettled = await readStatus(runner, messages);
while ((packagedSettled.checks?.runs ?? 0) < 1 && Date.now() < packagedDeadline) {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 50));
  packagedSettled = await readStatus(runner, messages);
}
assert.equal(packagedSettled.checks.runs, 1, "the installed artifact runs exactly one reviewer for the eligible completion");
assert.equal(reviewerSeen.arrivals, 2, "the installed reviewer used the scripted provider for its read and result turns");
assert.equal(reviewerSeen.transcripts.some(text => text.includes("K05_INSTALLED_REVIEWER_BODY")), true, "the installed reviewer's real read body reached a later provider input");
const packagedResults = [];
for (const name of await readdir(join(agentDir, "quality", "logs")).catch(() => [])) {
  if (!name.endsWith(".jsonl")) continue;
  const text = await readFile(join(agentDir, "quality", "logs", name), "utf8");
  for (const line of text.split(String.fromCharCode(10))) {
    if (line.trim().length === 0) continue;
    const record = JSON.parse(line);
    if (record.event === "quality.assessment.result") packagedResults.push(record.fields?.data);
  }
}
assert.equal(packagedResults.some(result => result?.operational === "completed" && result?.conclusion === "no-supported-finding"), true, "the installed artifact accepted the canonical submission");
assert.equal(Number(packagedSettled.accounting?.ownedRequestCount ?? 0) >= 2, true, "the installed reviewer's owned requests settle through the shared ledger");
assert.equal(Number(packagedSettled.accounting?.excluded?.externalHandoffs ?? 1), 0, "no external handoff is fabricated by the installed reviewer");
await runner.emit({ type: "session_shutdown", reason: "quit" });
console.log("QE_CONSUMER_K05=" + JSON.stringify({ version: manifest.version, entryIsolated: resolve(entryPath).startsWith(resolve(consumerRoot) + sep), arrivals: reviewerSeen.arrivals, runs: packagedSettled.checks.runs, ownedRequests: packagedSettled.accounting?.ownedRequestCount ?? null, bodyDelivered: reviewerSeen.transcripts.some(text => text.includes("K05_INSTALLED_REVIEWER_BODY")), canonicalAccepted: packagedResults.some(result => result?.operational === "completed" && result?.conclusion === "no-supported-finding") }));
