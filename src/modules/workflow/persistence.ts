import type { WorkflowActor, WorkflowState } from "./types.js";
import type { ExecuteWorkflowInput, InitializeWorkflowInput } from "./schemas.js";

export interface WorkflowAction {
  id: string; taskId: string; orgId: string; recipientId: string; kind: string; state: string; question: string; version: number;
  createdAt: Date | string;
  options?: string[];
  response?: string | null;
  taskTitle?: string; clientName?: string; projectName?: string;
}
export interface ActionCursor { createdAt: string; id: string }
export interface MonitoringCursor { updatedAt: string; taskId: string }
export interface WorkflowMonitoringItem { taskId: string; title: string; clientName: string; projectName: string; updatedAt: Date | string; state: WorkflowState }
export interface BoardMoveInput { status: "TODO" | "DOING" | "DONE"; position: number; expectedUpdatedAt?: string; operationId?: string }
export interface BoardMoveActor extends WorkflowActor { canMove: boolean }
export interface WorkflowStore {
  moveBoard?(actor: BoardMoveActor, taskId: string, input: BoardMoveInput): Promise<WorkflowState | null>;
  listMonitoring?(orgId: string, userId: string, before?: MonitoringCursor, limit?: number): Promise<WorkflowMonitoringItem[]>;
  load(orgId: string, taskId: string): Promise<WorkflowState | null>;
  events(orgId: string, taskId: string, beforeVersion?: number, limit?: number): Promise<unknown[]>;
  actions(orgId: string, taskId: string): Promise<WorkflowAction[]>;
  listActions(orgId: string, recipientId: string, before?: ActionCursor, limit?: number): Promise<WorkflowAction[]>;
  initialize(actor: WorkflowActor, taskId: string, input: InitializeWorkflowInput): Promise<WorkflowState>;
  execute(actor: WorkflowActor, taskId: string, input: ExecuteWorkflowInput): Promise<WorkflowState>;
  requestAction?(actor: WorkflowActor, taskId: string, input: RequestActionInput): Promise<WorkflowAction>;
  resolveAction?(actor: WorkflowActor, taskId: string, actionId: string, input: ResolveActionInput): Promise<WorkflowAction>;
  createManagedTask?(actor: WorkflowActor, input: CreateManagedTaskInput): Promise<WorkflowState>;
}

export interface RequestActionInput {
  operationId: string; expectedVersion: number; recipientId: string;
  kind: "CLARIFY_SCOPE" | "DECIDE" | "UNBLOCK"; question: string; options: string[];
}
export interface ResolveActionInput {
  operationId: string; expectedVersion: number; response: string; resolution: "RESOLVED" | "CANCELLED";
}
export interface CreateManagedTaskInput {
  operationId: string; projectId: string; engagementId: string; title: string; externalReference?: string;
  responsibleId: string; criteria: string[]; context: string;
}
