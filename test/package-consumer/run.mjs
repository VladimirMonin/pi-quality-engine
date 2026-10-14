import assert from "node:assert/strict";
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
assert.deepEqual([...extension.handlers.keys()].sort(), ["session_shutdown", "session_start"]);
for (const providerEvent of ["before_provider_request", "before_provider_headers", "after_provider_response"]) {
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
assert.deepEqual(active.diagnostics.recentEvents.map(record => record.event), ["quality.runtime.started"]);

await runner.emit({ type: "session_shutdown", reason: "quit" });
const retired = await readStatus(runner, messages);
assert.equal(retired.runtime.state, "retired");
assert.deepEqual(retired.diagnostics.recentEvents.map(record => record.event), [
  "quality.runtime.started",
  "quality.runtime.retired",
]);
assert.deepEqual(await listOrEmpty(fixtureRoot), fixtureBefore, "the installed engine must not create fixture files");
assert.deepEqual(await listOrEmpty(agentDir), [], "the installed engine must not create an agent-side directory");
assert.deepEqual(await listOrEmpty(projectDir), []);
assert.deepEqual(effects, { sendMessage: 0, sendUserMessage: 0, appendEntry: 0, abort: 0 }, "the installed engine attempts no primary effect");

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
  fixtureFilesCreated: [],
})}\n`);
