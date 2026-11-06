import { z } from "zod";
import { commandSchema } from "./schemas.js";
import type { WorkflowState } from "./types.js";

const eventSchema = z.object({
  version: z.number().int().positive(), type: z.string(), actorId: z.string().min(1),
  channel: z.enum(["WEB", "MCP", "LOCAL_SYNC"]), payload: z.unknown(),
});

/** Repair only the historical submit_review attribution bug, with complete trusted history.
 * Legacy initialization, missing/unknown events or malformed commands preserve all restrictions.
 * Events remain immutable; a subsequent normal command persists the corrected projection.
 */
export function normalizeExecutorProvenance(state: WorkflowState, rawEvents: unknown[]): WorkflowState {
  if (rawEvents.length !== state.version || !rawEvents.length) return state;
  const parsed = z.array(eventSchema).safeParse(rawEvents);
  if (!parsed.success) return state;
  const events = parsed.data;
  if (events[0].type !== "create_managed_task") return state;
  const submitters = new Set<string>();
  const executors = new Set<string>();
  for (const [index, event] of events.entries()) {
    if (event.version !== index + 1) return state;
    if (index === 0) continue;
    if (event.type === "request_action" || event.type === "resolve_action") continue;
    const payload = event.payload as { command?: unknown } | null;
    const parsedCommand = commandSchema.safeParse(payload?.command);
    if (!parsedCommand.success || parsedCommand.data.type !== event.type) return state;
    const command = parsedCommand.data;
    if (event.channel !== "WEB") continue;
    if (command.type === "submit_review") submitters.add(event.actorId);
    if (command.type === "start_execution" || command.type === "change_delivery" || command.type === "report_fix"
      || (command.type === "transition" && command.to === "DOING")) executors.add(event.actorId);
  }
  return { ...state, executorIds: state.executorIds.filter(id => !submitters.has(id) || executors.has(id)) };
}
