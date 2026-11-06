import type { WorkflowActor, WorkflowState } from "./types.js";
import type { ExecuteWorkflowInput, InitializeWorkflowInput } from "./schemas.js";

export interface WorkflowAction {
  id: string; taskId: string; orgId: string; recipientId: string; kind: string; state: string; question: string; version: number;
  createdAt: Date | string;
  options?: string[];
  response?: string | null;
}
export interface ActionCursor { createdAt: string; id: string }
export interface WorkflowStore {
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
