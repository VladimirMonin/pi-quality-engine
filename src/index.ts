import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveConfiguration } from "./configuration.js";

// Registration is inert: no runtime, timers, file reads, model calls or effects.
export default function qualityEngine(pi: ExtensionAPI): void {
  pi.registerCommand("quality", {
    description: "Inspect the inactive Pi Quality Engine foundation: /quality status",
    handler: async (args, ctx) => {
      if (args.trim() !== "" && args.trim() !== "status") {
        ctx.ui.notify("Unavailable: only /quality status is implemented.", "warning");
        return;
      }
      const configuration = resolveConfiguration(undefined);
      if (!configuration.ok) return;
      ctx.ui.notify(JSON.stringify({
        version: "0.0.1",
        enabled: configuration.value.enabled,
        mode: configuration.value.mode,
        configurationFiles: "unavailable",
        checkExecution: "unavailable",
        registry: "unavailable",
        journal: "unavailable",
        modelEvaluation: "unavailable",
        feedback: "unavailable",
      }), "info");
    },
  });
}
