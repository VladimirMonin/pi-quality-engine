// Pi model-registry adapter for the owned model service.
//
// The adapter is the only place that knows the pinned SDK model API. It
// resolves approved provider/model routes from the host registry and dispatches
// through the registry's request-time authenticated methods, so the engine
// never inherits the primary session's model or credentials implicitly.

import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ChatTransportResult, ClassifierTransportResult, ModelRegistryPort } from "../models.js";

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
      const assistant = await registry.complete(model as never, context as never, requestOptions as never);
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
