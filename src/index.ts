// Pi composition root.
//
// Loading this module registers a command, lifecycle handlers and the C1
// registry query listener only. It starts no timer, reads no configuration file
// at import time and creates no session. Long-lived state begins from
// session_start and ends from the idempotent session_shutdown handler, matching
// the pinned host guidance.

import { CONFIG_DIR_NAME, VERSION, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REGISTRY_QUERY_CHANNEL } from "./contracts.js";
import type { RegistryQuery } from "./contracts.js";
import { EngineSession, inspectInactiveSession } from "./runtime.js";
import type { EngineSessionInput, EngineStatus, PrimaryHostEvent, SessionControlState } from "./runtime.js";
import { mapPiEvent } from "./adapters/pi-host.js";
import type { PiHostEventContext } from "./adapters/pi-host.js";

function packageResourcesDir(): string {
  // dist/index.js -> <package root>/resources; used for shipped built-in resources.
  return fileURLToPath(new URL("../resources", import.meta.url));
}

function sessionInput(ctx: ExtensionContext): EngineSessionInput {
  return {
    observedSessionId: ctx.sessionManager.getSessionId(),
    branchId: ctx.sessionManager.getLeafId() ?? "unresolved",
    agentDir: getAgentDir(),
    projectConfigDir: join(ctx.cwd, CONFIG_DIR_NAME),
    projectTrusted: ctx.isProjectTrusted(),
    hostVersion: VERSION,
    hostMode: ctx.mode,
    resourcesDir: packageResourcesDir(),
  };
}

export default function qualityEngine(pi: ExtensionAPI): void {
  let session: EngineSession | undefined;
  let lifecycleSerial = 0;
  // Scoped control state keyed by the observed session survives same-session
  // reload/replacement without granting new authorization.
  const controlStates = new Map<string, SessionControlState>();

  pi.on("session_start", async (_event, ctx) => {
    const serial = ++lifecycleSerial;
    session?.retire("replaced");
    session = undefined;
    const observedSessionId = ctx.sessionManager.getSessionId();
    const controlState = controlStates.get(observedSessionId) ?? { operatorStopped: false };
    controlStates.set(observedSessionId, controlState);
    const started = await EngineSession.start({
      ...sessionInput(ctx),
      hostIdleAtStart: ctx.isIdle(),
      controlState,
      publishRegistryEndpoint: endpoint => {
        try {
          pi.events.emit("quality.registry.available.v1", endpoint);
        } catch {
          // A failing bus notification must not break session startup; consumers
          // can still discover the endpoint through the query channel.
        }
      },
    });
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

  pi.events.on(REGISTRY_QUERY_CHANNEL, data => {
    const query = data as RegistryQuery;
    if (typeof query !== "object" || query === null) return;
    if (typeof query.reply !== "function") return;
    if (query.apiMajor !== 1) return;
    session?.handleRegistryQuery(query);
  });

  const forward = (event: PrimaryHostEvent) => {
    session?.handlePrimaryEvent(event);
  };
  const contextOf = (ctx: ExtensionContext): PiHostEventContext => ({
    nowIso: new Date().toISOString(),
  });
  pi.on("input", (event, ctx) => {
    forward(mapPiEvent({ type: "input", text: event.text, source: event.source }, contextOf(ctx)));
  });
  pi.on("tool_execution_start", (event, ctx) => {
    forward(mapPiEvent({
      type: "tool_execution_start",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      parentToolCallId: event.parentToolCallId,
    }, contextOf(ctx)));
  });
  pi.on("tool_execution_end", (event, ctx) => {
    forward(mapPiEvent({
      type: "tool_execution_end",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      isError: event.isError,
      durationMs: event.durationMs,
      parentToolCallId: event.parentToolCallId,
    }, contextOf(ctx)));
  });
  pi.on("turn_end", (event, ctx) => {
    forward(mapPiEvent({
      type: "turn_end",
      messageEntryId: event.messageEntryId,
      toolResultEntryIds: event.toolResultEntryIds,
      toolResults: event.toolResults.map(result => ({ toolCallId: result.toolCallId })),
    }, contextOf(ctx)));
  });

  pi.registerCommand("quality", {
    description: "Inspect Pi Quality Engine status or stop its autonomous checks (read-only otherwise)",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested === "stop") {
        session?.requestOperatorStop();
        ctx.ui.notify("Pi Quality Engine checks are stopped for this session.", "info");
        return;
      }
      if (requested !== "" && requested !== "status") {
        ctx.ui.notify("Unavailable: only /quality status and /quality stop are implemented.", "warning");
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
