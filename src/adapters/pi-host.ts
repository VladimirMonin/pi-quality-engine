// Pi host adapter: normalizes pinned Pi extension events into C1 observations.
//
// The adapter is the only place that knows Pi event names. It supplies facts
// only where the host actually exposes them: model request attribution is not
// derived from unreliable payload pairing at this checkpoint.

import type { PrimaryHostEvent } from "../runtime.js";

export interface PiHostEventContext {
  nowIso: string;
}

export type PiHostInput =
  | { type: "input"; text: string; source: string }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; parentToolCallId: string | undefined }
  | {
    type: "tool_execution_end";
    toolCallId: string;
    toolName: string;
    isError: boolean;
    durationMs: number | undefined;
    parentToolCallId: string | undefined;
  }
  | {
    type: "turn_end";
    messageEntryId: string;
    toolResultEntryIds: string[];
    toolResults: Array<{ toolCallId: string }>;
  };

export function mapPiEvent(event: PiHostInput, ctx: PiHostEventContext): PrimaryHostEvent {
  switch (event.type) {
    case "input":
      return { type: "operator-input", text: event.text, source: event.source, occurredAt: ctx.nowIso };
    case "tool_execution_start":
      return {
        type: "tool-started",
        operationId: event.toolCallId,
        toolName: event.toolName,
        parentOperationId: event.parentToolCallId ?? null,
        occurredAt: ctx.nowIso,
      };
    case "tool_execution_end":
      return {
        type: "tool-completed",
        operationId: event.toolCallId,
        toolName: event.toolName,
        parentOperationId: event.parentToolCallId ?? null,
        isError: event.isError,
        durationMs: event.durationMs ?? null,
        occurredAt: ctx.nowIso,
      };
    case "turn_end":
      return {
        type: "cycle-completed",
        cycleId: event.messageEntryId,
        operationIds: event.toolResults.map(result => result.toolCallId),
        occurredAt: ctx.nowIso,
      };
  }
}
