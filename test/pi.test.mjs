import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  DefaultResourceLoader, ExtensionRunner, ModelRegistry, ModelRuntime,
  SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = process.env.QE_PACKAGE_ROOT ?? process.cwd();

test("actual Pi loads the built inactive extension and reports its limited capabilities", { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "quality-pi-"));
  try {
    const settingsManager = SettingsManager.inMemory();
    const loader = new DefaultResourceLoader({
      cwd: root, agentDir: join(root, "agent"), settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true,
      noThemes: true, noContextFiles: true,
      additionalExtensionPaths: [resolve(packageRoot, "dist/index.js")],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    assert.equal(loaded.extensions.length, 1);
    const extension = loaded.extensions[0];
    assert.ok(extension);
    assert.equal(extension.tools.size, 0);
    assert.equal(extension.handlers.size, 0);
    assert.deepEqual([...extension.commands.keys()], ["quality"]);
    const models = await ModelRuntime.create({
      authPath: join(root, "auth.json"), modelsPath: null,
      modelsStorePath: join(root, "models-cache.json"),
      refreshOnCreate: false, allowModelNetwork: false,
    });
    const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, root,
      SessionManager.inMemory(root), new ModelRegistry(models));
    // ModelRuntime itself creates its isolated auth file; the extension must add no files.
    const hostFiles = await readdir(root);
    const messages = [];
    runner.setUIContext({ ...runner.getUIContext(), notify: message => messages.push(message) }, "rpc");
    const command = runner.getCommand("quality");
    assert.ok(command);
    await command.handler("status", runner.createCommandContext());
    assert.equal(messages.length, 1);
    const status = JSON.parse(messages[0]);
    assert.equal(status.version, "0.0.1");
    assert.equal(status.enabled, false);
    assert.equal(status.mode, "observe");
    assert.equal(status.configurationFiles, "unavailable");
    assert.equal(status.checkExecution, "unavailable");
    assert.equal(status.journal, "unavailable");
    assert.equal(status.modelEvaluation, "unavailable");
    assert.equal(status.feedback, "unavailable");
    assert.deepEqual(await readdir(root), hostFiles);
    await command.handler("run example", runner.createCommandContext());
    assert.equal(messages.at(-1), "Unavailable: only /quality status is implemented.");
    runner.invalidate();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
