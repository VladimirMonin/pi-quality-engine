import test from "node:test";
import assert from "node:assert/strict";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { piModelRegistryPort } from "../src/adapters/pi-models.js";

// Pure adapter mapping controls complement, never replace, the real SDK/body
//integration in k09-input-delivery.test.mjs. No AgentSession or model is faked.
function capturePort() {
  const calls: Array<{ context: unknown; options: unknown }> = [];
  const registry = {
    async complete(_model: unknown, context: unknown, options: unknown) {
      calls.push({ context, options });
      return { content: [{ type: "text", text: "{}" }], usage: {}, stopReason: "stop" };
    },
  } as unknown as ModelRegistry;
  return { calls, port: piModelRegistryPort(registry) };
}

test("K09-INPUT-F1 direct assessment instructions use the supported SDK systemPrompt field", async () => {
  const { calls, port } = capturePort();
  const messages = [
    { role: "system", content: "Synthetic project review instructions." },
    { role: "system", content: "Synthetic bounded supplement." },
    { role: "user", content: "Actual supplied synthetic task and evidence." },
  ];
  const before = JSON.stringify(messages);
  await port.completeChat({ api: "openai-completions" }, messages, { maxOutputTokens: 1024, reasoning: "low" }, new AbortController().signal);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.context, {
    systemPrompt: "Synthetic project review instructions.\n\nSynthetic bounded supplement.",
    messages: [{ role: "user", content: [{ type: "text", text: "Actual supplied synthetic task and evidence." }] }],
  });
  assert.deepEqual(calls[0]?.options, { maxTokens: 1024, reasoning: "low" });
  assert.equal(JSON.stringify(messages), before, "mapping does not mutate admitted input");
});

test("K09-INPUT-F1 absence of system text does not fabricate a prompt or change user content", async () => {
  const { calls, port } = capturePort();
  await port.completeChat({ api: "openai-completions" }, [{ role: "user", content: "Synthetic only." }], { maxOutputTokens: 256, reasoning: "off" }, new AbortController().signal);
  assert.deepEqual(calls[0]?.context, { messages: [{ role: "user", content: [{ type: "text", text: "Synthetic only." }] }] });
  assert.deepEqual(calls[0]?.options, { maxTokens: 256 });
});
