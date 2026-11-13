import { z } from "zod";
import { WORKFLOW_STAGES } from "./types.js";

const id = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(8000);
const evidence = z.array(z.string().trim().min(1).max(2000)).min(1).max(50);
export const checkSchema = z.object({ name: id, status: z.enum(["passed", "failed", "pending"]), required: z.boolean() }).strict();
const summarySchema = z.object({ objective: text, completed: z.array(text.max(2000)).max(50), remaining: z.array(text.max(2000)).max(50), nextStep: text, blockers: z.array(text.max(2000)).max(50), references: z.array(text.max(2000)).max(50) }).strict();
export const commandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("transition"), to: z.enum(WORKFLOW_STAGES), reason: text.optional() }).strict(),
  z.object({ type: z.literal("change_delivery"), reason: text, context: text.optional(), criteria: z.array(text.max(2000)).min(1).max(100).optional() }).strict(),
  z.object({ type: z.literal("start_execution"), executionId: id, agent: id, sessionReference: z.string().min(1).max(256).optional() }).strict(),
  z.object({ type: z.literal("report_progress"), executionId: id, status: z.enum(["RUNNING", "WAITING", "PAUSED", "FINISHED"]), summary: summarySchema }).strict(),
  z.object({ type: z.literal("record_evidence"), summary: text, evidence }).strict(),
  z.object({ type: z.literal("submit_review"), summary: text, evidence, checks: z.array(checkSchema).max(100), reviewerId: id.optional(), reviewMode: z.enum(["AGENT", "HUMAN"]).optional() }).strict(),
  z.object({ type: z.literal("record_finding"), id, description: text, severity: z.enum(["low", "medium", "high", "critical"]), criterion: text.max(2000), responsibleId: id, blocking: z.boolean() }).strict(),
  z.object({ type: z.literal("report_fix"), findingId: id, evidence }).strict(),
  z.object({ type: z.literal("validate_finding"), findingId: id, cycle: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("waive_finding"), findingId: id, cycle: z.number().int().positive(), reason: text }).strict(),
  z.object({ type: z.literal("request_changes"), cycle: z.number().int().positive(), reason: text }).strict(),
  z.object({ type: z.literal("adopt_agent_review"), cycle: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("approve_anyway"), cycle: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("approve_review"), cycle: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("approve_with_reservations"), cycle: z.number().int().positive(), checkNames: z.array(id).min(1).max(100), reason: text.min(3) }).strict(),
]);

export const initSchema = z.object({ operationId: z.string().min(1).max(256), responsibleId: id, criteria: z.array(text.max(2000)).min(1).max(100), context: text }).strict();
export const createManagedTaskSchema = initSchema.extend({ projectId: id, engagementId: id, title: text.max(200), externalReference: z.string().trim().min(1).max(512).optional() }).strict();
export const executeSchema = z.object({ operationId: z.string().min(1).max(256), expectedVersion: z.number().int().nonnegative(), command: commandSchema }).strict();
export const workflowStateSchema = z.object({
  taskId: id, orgId: id, version: z.number().int().nonnegative(), stage: z.enum(WORKFLOW_STAGES),
  deliveryRevision: z.number().int().positive(), responsibleId: id, criteria: z.array(text.max(2000)).max(100), context: z.string().max(8000), executorIds: z.array(id).max(1000),
  reviews: z.array(z.object({ cycle: z.number().int().positive(), deliveryRevision: z.number().int().positive(), reviewMode: z.enum(["AGENT", "HUMAN"]).optional(), submittedBy: id, submittedAt: z.string().datetime(), summary: text, evidence, checks: z.array(checkSchema).max(100), decision: z.enum(["pending", "changes_requested", "approved", "superseded"]), decidedBy: id.optional(), decidedAt: z.string().datetime().optional(), decidedChannel: z.enum(["WEB", "MCP", "LOCAL_SYNC"]).optional(), decidedAgent: id.optional(), reason: text.optional(), approvalOverride: z.object({ approvedBy: id, approvedAt: z.string().datetime(), channel: z.enum(["WEB", "MCP"]), cycle: z.number().int().positive(), deliveryRevision: z.number().int().positive() }).strict().optional(), reservation: z.object({ checkNames: z.array(id).min(1).max(100), reason: text.min(3), approvedBy: id, approvedAt: z.string().datetime(), cycle: z.number().int().positive(), deliveryRevision: z.number().int().positive() }).strict().optional() }).strict()).max(1000),
  findings: z.array(z.object({ id, description: text, severity: z.enum(["low", "medium", "high", "critical"]), criterion: text.max(2000), responsibleId: id, blocking: z.boolean(), state: z.enum(["open", "fix_reported", "validated", "waived"]), openedInCycle: z.number().int().positive(), validatedInCycle: z.number().int().positive().optional(), resolvedDeliveryRevision: z.number().int().positive().optional(), fixEvidence: z.array(z.string().min(1).max(2000)).max(50), waiverReason: text.optional() }).strict()).max(1000),
  summary: summarySchema.extend({ updatedAt: z.string().datetime(), updatedBy: id, channel: z.enum(["WEB", "MCP", "LOCAL_SYNC"]) }).strict().optional(),
  execution: z.object({ id, agent: id, ownerId: id, channel: z.enum(["WEB", "MCP", "LOCAL_SYNC"]), connectionId: z.string().min(1).max(256).optional(), sessionReference: z.string().min(1).max(256).optional(), status: z.enum(["RUNNING", "WAITING", "PAUSED", "FINISHED"]), lastUpdatedAt: z.string().datetime() }).strict().optional(),
}).strict();

export const requestActionSchema = z.object({ operationId: z.string().min(1).max(256), expectedVersion: z.number().int().nonnegative(), recipientId: id, kind: z.enum(["CLARIFY_SCOPE", "DECIDE", "UNBLOCK"]), question: text, options: z.array(text.max(1000)).max(20) }).strict();
export const resolveActionSchema = z.object({ operationId: z.string().min(1).max(256), expectedVersion: z.number().int().nonnegative(), response: text, resolution: z.enum(["RESOLVED", "CANCELLED"]) }).strict();

export type InitializeWorkflowInput = z.infer<typeof initSchema>;
export type ExecuteWorkflowInput = z.infer<typeof executeSchema>;
