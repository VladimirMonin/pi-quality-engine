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
import { EngineSession, SessionPhysicalState, inspectInactiveSession } from "./runtime.js";
import type { EngineSessionInput, EngineStatus, PrimaryHostEvent, SessionControlState } from "./runtime.js";
import { mapPiEvent } from "./adapters/pi-host.js";
import { piModelRegistryPort } from "./adapters/pi-models.js";
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
    projectRoot: ctx.cwd,
    modelRegistry: piModelRegistryPort(ctx.modelRegistry),
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
  // Session-scoped physical reservations survive generation replacement so a
  // timed-out but unsettled evaluator does not grant free capacity.
  const physicalStates = new Map<string, SessionPhysicalState>();

  pi.on("session_start", async (_event, ctx) => {
    const serial = ++lifecycleSerial;
    await session?.retire("replaced");
    session = undefined;
    const observedSessionId = ctx.sessionManager.getSessionId();
    const controlState = controlStates.get(observedSessionId) ?? { operatorStopped: false };
    controlStates.set(observedSessionId, controlState);
    const physicalState = physicalStates.get(observedSessionId) ?? new SessionPhysicalState();
    physicalStates.set(observedSessionId, physicalState);
    const started = await EngineSession.start({
      ...sessionInput(ctx),
      hostIdleAtStart: ctx.isIdle(),
      controlState,
      physicalState,
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
      await started.retire("replaced");
      return;
    }
    session = started;
  });

  pi.on("session_shutdown", async event => {
    lifecycleSerial += 1;
    // The retired generation stays inspectable through /quality status; it
    // grants no authority and a later start replaces it explicitly.
    await session?.retire(event.reason);
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
    const context = contextOf(ctx);
    forward(mapPiEvent({
      type: "turn_end",
      messageEntryId: event.messageEntryId,
      toolResultEntryIds: event.toolResultEntryIds,
      toolResults: event.toolResults.map(result => ({ toolCallId: result.toolCallId })),
    }, context));
    // The host, not the engine, declares the completion boundary.
    forward({
      type: "completion-boundary",
      boundaryId: event.messageEntryId,
      actionable: true,
      occurredAt: context.nowIso,
    });
  });

  pi.registerCommand("quality", {
    description: "Inspect Pi Quality Engine status or control its observer (stop, pause, resume, reload)",
    handler: async (args, ctx) => {
      const requested = args.trim();
      if (requested === "stop") {
        session?.requestOperatorStop();
        ctx.ui.notify("Pi Quality Engine checks are stopped for this session; stop survives reload and pause.", "info");
        return;
      }
      if (requested === "pause") {
        session?.requestOperatorPause();
        ctx.ui.notify("Pi Quality Engine observer is paused; stop state is unchanged.", "info");
        return;
      }
      if (requested === "resume") {
        session?.requestOperatorResume();
        ctx.ui.notify("Pi Quality Engine observer resumed; an operator stop is not cleared by resume.", "info");
        return;
      }
      if (requested === "reload") {
        if (session === undefined) {
          ctx.ui.notify("No active Pi Quality Engine generation to reload.", "warning");
          return;
        }
        const reloaded = await session.reloadConfiguration();
        ctx.ui.notify(reloaded.ok
          ? "Pi Quality Engine configuration applied."
          : `Configuration rejected; previous configuration remains active (${reloaded.errorCode ?? "unknown"}).`, reloaded.ok ? "info" : "warning");
        return;
      }
      if (requested !== "" && requested !== "status") {
        ctx.ui.notify("Unavailable: /quality supports status, stop, pause, resume and reload.", "warning");
        return;
      }
      let status: EngineStatus;
      if (session !== undefined) {
        await session.syncOwnedReceipts();
        status = session.status(ctx.isIdle());
      } else {
        status = await inspectInactiveSession(sessionInput(ctx), ctx.isIdle());
      }
      ctx.ui.notify(JSON.stringify(status), "info");
    },
  });
}
