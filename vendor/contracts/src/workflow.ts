export const WORKFLOW_STAGES = ["BACKLOG", "PLANNING", "READY", "DOING", "IN_REVIEW", "CHANGES_REQUESTED", "DONE"] as const;
export type WorkflowStage = (typeof WORKFLOW_STAGES)[number];
export type WorkflowChannel = "WEB" | "MCP" | "LOCAL_SYNC";

/** Trusted, task-scoped authorization context resolved by the server, never tool input. */
export interface WorkflowActor {
  orgId: string;
  userId: string;
  channel: WorkflowChannel;
  /** Trusted OAuth connection/run identifier, supplied by authenticated adapters only. */
  connectionId?: string;
  canWrite: boolean;
  canCreate?: boolean;
  canReview: boolean;
  canApprove: boolean;
  canReopen: boolean;
}

export interface ReviewCheck {
  name: string;
  status: "passed" | "failed" | "pending";
  required: boolean;
}

export interface WorkflowReview {
  cycle: number;
  deliveryRevision: number;
  submittedBy: string;
  submittedAt: string;
  summary: string;
  evidence: string[];
  checks: ReviewCheck[];
  decision: "pending" | "changes_requested" | "approved" | "superseded";
  decidedBy?: string;
  decidedAt?: string;
  decidedChannel?: WorkflowChannel;
  decidedAgent?: string;
  reason?: string;
}

export interface WorkflowFinding {
  id: string;
  description: string;
  severity: "low" | "medium" | "high" | "critical";
  criterion: string;
  responsibleId: string;
  blocking: boolean;
  state: "open" | "fix_reported" | "validated" | "waived";
  openedInCycle: number;
  validatedInCycle?: number;
  resolvedDeliveryRevision?: number;
  fixEvidence: string[];
  waiverReason?: string;
}

export interface WorkflowState {
  taskId: string;
  orgId: string;
  version: number;
  stage: WorkflowStage;
  deliveryRevision: number;
  responsibleId: string;
  criteria: string[];
  context: string;
  executorIds: string[];
  reviews: WorkflowReview[];
  findings: WorkflowFinding[];
  summary?: WorkflowSummary;
  execution?: WorkflowExecution;
}

export interface WorkflowSummary {
  objective: string;
  completed: string[];
  remaining: string[];
  nextStep: string;
  blockers: string[];
  references: string[];
  updatedAt: string;
  updatedBy: string;
  channel: WorkflowChannel;
}
export interface WorkflowExecution {
  id: string;
  agent: string;
  ownerId: string;
  channel: WorkflowChannel;
  connectionId?: string;
  sessionReference?: string;
  status: "RUNNING" | "WAITING" | "PAUSED" | "FINISHED";
  lastUpdatedAt: string;
}
export type ProgressSummary = Omit<WorkflowSummary, "updatedAt" | "updatedBy" | "channel">;

export type WorkflowCommand =
  | { type: "transition"; to: WorkflowStage; reason?: string }
  | { type: "change_delivery"; reason: string; context?: string; criteria?: string[] }
  | { type: "start_execution"; executionId: string; agent: string; sessionReference?: string }
  | { type: "report_progress"; executionId: string; status: WorkflowExecution["status"]; summary: ProgressSummary }
  | { type: "record_evidence"; summary: string; evidence: string[] }
  | { type: "submit_review"; summary: string; evidence: string[]; checks: ReviewCheck[]; reviewerId?: string }
  | { type: "record_finding"; id: string; description: string; severity: WorkflowFinding["severity"]; criterion: string; responsibleId: string; blocking: boolean }
  | { type: "report_fix"; findingId: string; evidence: string[] }
  | { type: "validate_finding"; findingId: string; cycle: number }
  | { type: "waive_finding"; findingId: string; cycle: number; reason: string }
  | { type: "request_changes"; cycle: number; reason: string }
  | { type: "approve_review"; cycle: number };

export interface WorkflowEvent {
  taskId: string;
  orgId: string;
  actorId: string;
  channel: WorkflowChannel;
  type: WorkflowCommand["type"];
  version: number;
  deliveryRevision: number;
  createdAt: string;
  command: WorkflowCommand;
}

export interface WorkflowResult {
  state: WorkflowState;
  event: WorkflowEvent;
}


import { z } from "zod";

const id = z.string().trim().min(1).max(128);
const text = z.string().trim().min(1).max(8000);
const evidence = z.array(z.string().trim().min(1).max(2000)).min(1).max(50);
export const workflowCheckSchema = z.object({ name: id, status: z.enum(["passed", "failed", "pending"]), required: z.boolean() }).strict();
const summarySchema = z.object({ objective: text, completed: z.array(text.max(2000)).max(50), remaining: z.array(text.max(2000)).max(50), nextStep: text, blockers: z.array(text.max(2000)).max(50), references: z.array(text.max(2000)).max(50) }).strict();
export const workflowCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("transition"), to: z.enum(WORKFLOW_STAGES), reason: text.optional() }).strict(),
  z.object({ type: z.literal("change_delivery"), reason: text, context: text.optional(), criteria: z.array(text.max(2000)).min(1).max(100).optional() }).strict(),
  z.object({ type: z.literal("start_execution"), executionId: id, agent: id, sessionReference: z.string().min(1).max(256).optional() }).strict(),
  z.object({ type: z.literal("report_progress"), executionId: id, status: z.enum(["RUNNING", "WAITING", "PAUSED", "FINISHED"]), summary: summarySchema }).strict(),
  z.object({ type: z.literal("submit_review"), summary: text, evidence, checks: z.array(workflowCheckSchema).max(100), reviewerId: id.optional() }).strict(),
  z.object({ type: z.literal("record_finding"), id, description: text, severity: z.enum(["low", "medium", "high", "critical"]), criterion: text.max(2000), responsibleId: id, blocking: z.boolean() }).strict(),
  z.object({ type: z.literal("report_fix"), findingId: id, evidence }).strict(),
  z.object({ type: z.literal("validate_finding"), findingId: id, cycle: z.number().int().positive() }).strict(),
  z.object({ type: z.literal("waive_finding"), findingId: id, cycle: z.number().int().positive(), reason: text }).strict(),
  z.object({ type: z.literal("request_changes"), cycle: z.number().int().positive(), reason: text }).strict(),
  z.object({ type: z.literal("approve_review"), cycle: z.number().int().positive() }).strict(),
]);

export const initializeWorkflowSchema = z.object({ operationId: z.string().min(1).max(256), responsibleId: id, criteria: z.array(text.max(2000)).min(1).max(100), context: text }).strict();
export const createManagedTaskSchema = initializeWorkflowSchema.extend({ projectId: id, engagementId: id, title: text.max(200), externalReference: z.string().trim().min(1).max(512).optional() }).strict();
export const executeWorkflowSchema = z.object({ operationId: z.string().min(1).max(256), expectedVersion: z.number().int().nonnegative(), command: workflowCommandSchema }).strict();
export const workflowStateSchema = z.object({
  taskId: id, orgId: id, version: z.number().int().nonnegative(), stage: z.enum(WORKFLOW_STAGES),
  deliveryRevision: z.number().int().positive(), responsibleId: id, criteria: z.array(text.max(2000)).max(100), context: z.string().max(8000), executorIds: z.array(id).max(1000),
  reviews: z.array(z.object({ cycle: z.number().int().positive(), deliveryRevision: z.number().int().positive(), submittedBy: id, submittedAt: z.string().datetime(), summary: text, evidence, checks: z.array(workflowCheckSchema).max(100), decision: z.enum(["pending", "changes_requested", "approved", "superseded"]), decidedBy: id.optional(), decidedAt: z.string().datetime().optional(), reason: text.optional() }).strict()).max(1000),
  findings: z.array(z.object({ id, description: text, severity: z.enum(["low", "medium", "high", "critical"]), criterion: text.max(2000), responsibleId: id, blocking: z.boolean(), state: z.enum(["open", "fix_reported", "validated", "waived"]), openedInCycle: z.number().int().positive(), validatedInCycle: z.number().int().positive().optional(), resolvedDeliveryRevision: z.number().int().positive().optional(), fixEvidence: z.array(z.string().min(1).max(2000)).max(50), waiverReason: text.optional() }).strict()).max(1000),
  summary: summarySchema.extend({ updatedAt: z.string().datetime(), updatedBy: id, channel: z.enum(["WEB", "MCP", "LOCAL_SYNC"]) }).strict().optional(),
  execution: z.object({ id, agent: id, ownerId: id, channel: z.enum(["WEB", "MCP", "LOCAL_SYNC"]), connectionId: z.string().min(1).max(256).optional(), sessionReference: z.string().min(1).max(256).optional(), status: z.enum(["RUNNING", "WAITING", "PAUSED", "FINISHED"]), lastUpdatedAt: z.string().datetime() }).strict().optional(),
}).strict();

export const requestWorkflowActionSchema = z.object({ operationId: z.string().min(1).max(256), expectedVersion: z.number().int().nonnegative(), recipientId: id, kind: z.enum(["CLARIFY_SCOPE", "DECIDE", "UNBLOCK"]), question: text, options: z.array(text.max(1000)).max(20) }).strict();
export const resolveWorkflowActionSchema = z.object({ operationId: z.string().min(1).max(256), expectedVersion: z.number().int().nonnegative(), response: text, resolution: z.enum(["RESOLVED", "CANCELLED"]) }).strict();

export type InitializeWorkflowInput = z.infer<typeof initializeWorkflowSchema>;
export type ExecuteWorkflowInput = z.infer<typeof executeWorkflowSchema>;
