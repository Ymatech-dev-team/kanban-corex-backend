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
  /** Missing on legacy reviews; never infer human consent from absence. */
  reviewMode?: "AGENT" | "HUMAN";
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
  /** Explicit human acceptance of failed checks, scoped to this immutable review. */
  reservation?: { checkNames: string[]; reason: string; approvedBy: string; approvedAt: string; cycle: number; deliveryRevision: number };
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
  | { type: "submit_review"; summary: string; evidence: string[]; checks: ReviewCheck[]; reviewerId?: string; reviewMode?: "AGENT" | "HUMAN" }
  | { type: "record_finding"; id: string; description: string; severity: WorkflowFinding["severity"]; criterion: string; responsibleId: string; blocking: boolean }
  | { type: "report_fix"; findingId: string; evidence: string[] }
  | { type: "validate_finding"; findingId: string; cycle: number }
  | { type: "waive_finding"; findingId: string; cycle: number; reason: string }
  | { type: "request_changes"; cycle: number; reason: string }
  | { type: "adopt_agent_review"; cycle: number }
  | { type: "approve_review"; cycle: number }
  | { type: "approve_with_reservations"; cycle: number; checkNames: string[]; reason: string };

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

/** Persistence boundary. Adapter must authorize before loading or returning a cached result. */
export interface WorkflowRepository {
  load(orgId: string, taskId: string): Promise<WorkflowState | null>;
  /**
   * Atomically CAS expectedVersion, save state + event + outbox and operation result.
   * Key uniqueness: orgId + connectionId + operationId. Repeated digest returns prior result;
   * a different digest with the same key is CONFLITO. No partial update may be visible.
   * Must reject result.state.version !== expectedVersion + 1 and cross-task/org mutations.
   */
  commit(input: {
    orgId: string;
    taskId: string;
    expectedVersion: number;
    connectionId: string;
    operationId: string;
    commandDigest: string;
    result: WorkflowResult;
  }): Promise<WorkflowResult>;
}
