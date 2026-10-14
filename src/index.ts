// Pi composition root.
//
// Loading this module registers a command and two lifecycle handlers only. It
// starts no timer, reads no configuration file at import time and creates no
// session. Long-lived state begins from session_start and ends from the
// idempotent session_shutdown handler, matching the pinned host guidance.

import { CONFIG_DIR_NAME, VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { EngineSession, inspectInactiveSession } from "./runtime.js";
import type { EngineSessionInput, EngineStatus } from "./runtime.js";

function sessionInput(ctx: ExtensionContext): EngineSessionInput {
  return {
    observedSessionId: ctx.sessionManager.getSessionId(),
    branchId: ctx.sessionManager.getLeafId() ?? "unresolved",
    agentDir: getAgentDir(),
    projectConfigDir: join(ctx.cwd, CONFIG_DIR_NAME),
    projectTrusted: ctx.isProjectTrusted(),
    hostVersion: VERSION,
    hostMode: ctx.mode,
  };
}

export default function qualityEngine(pi: ExtensionAPI): void {
  let session: EngineSession | undefined;
  let lifecycleSerial = 0;

  pi.on("session_start", async (_event, ctx) => {
    const serial = ++lifecycleSerial;
    session?.retire("replaced");
    session = undefined;
    const started = await EngineSession.start({ ...sessionInput(ctx), hostIdle: ctx.isIdle() });
    if (serial !== lifecycleSerial) {
      // A shutdown or replacement overtook this start; the late generation
      // must not acquire authority in the new lifecycle.
      started.retire("replaced");
      return;
    }
    session = started;
  });

  pi.on("session_shutdown", event => {
    lifecycleSerial += 1;
    session?.retire(event.reason);
  });

  pi.registerCommand("quality", {
    description: "Inspect Pi Quality Engine status (read-only, no model calls)",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested !== "" && requested !== "status") {
        ctx.ui.notify("Unavailable: only /quality status is implemented.", "warning");
        return;
      }
      let status: EngineStatus;
      if (session !== undefined) {
        status = session.status(ctx.isIdle());
      } else {
        status = await inspectInactiveSession(sessionInput(ctx), ctx.isIdle());
      }
      ctx.ui.notify(JSON.stringify(status), "info");
    },
  });
}
