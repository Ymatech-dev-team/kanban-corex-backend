import { z } from "zod";
import { taskStatusSchema, taskPrioritySchema } from "./auth.js";

/** Contratos de tarefa / subtarefa. */

export const createTaskSchema = z.object({
  title: z.string().trim().min(1, "Informe o título").max(200),
  description: z.string().max(5000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: z.string().datetime().optional(),
  assigneeId: z.string().optional(),
  estimatedMinutes: z.number().int().min(0).max(1_000_000).nullable().optional(),
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: z.string().datetime().nullable().optional(),
  estimatedMinutes: z.number().int().min(0).max(1_000_000).nullable().optional(),
  // projectId é IMUTÁVEL via PATCH [SEC-106] — nem entra no schema.
  // assigneeId (responsável principal) NÃO entra aqui: é gerido pelas rotas /assignees
  // (add/primary/remove), senão poderia duplicar/derrubar o principal fora da invariante. [detalhe-tarefa A1/RF-R7]
});
export type UpdateTaskInput = z.infer<typeof updateTaskSchema>;

export const moveTaskSchema = z.object({
  status: taskStatusSchema,
  position: z.number(),
});
export type MoveTaskInput = z.infer<typeof moveTaskSchema>;

export const taskFiltersSchema = z.object({
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  assigneeId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});
export type TaskFilters = z.infer<typeof taskFiltersSchema>;

/** Adicionar um responsável EXTRA à tarefa (o principal fica em Task.assigneeId). [hierarquia/detalhe-tarefa A1] */
export const addAssigneeSchema = z.object({
  userId: z.string().min(1).max(64),
});
export type AddAssigneeInput = z.infer<typeof addAssigneeSchema>;

/** Tipos de evento da linha do tempo (gerados pelo servidor, append-only). [detalhe-tarefa B] */
export const TASK_ACTIVITY_TYPES = [
  "CREATED",
  "STATUS_CHANGED",
  "FIELD_EDITED",
  "ASSIGNEE_ADDED",
  "ASSIGNEE_REMOVED",
  "PRIMARY_CHANGED",
  "SUBTASK_ADDED",
  "SUBTASK_DONE",
  "SUBTASK_REMOVED",
] as const;
export type TaskActivityType = (typeof TASK_ACTIVITY_TYPES)[number];

/** Campos de tarefa cuja edição pode ser registrada (allowlist não-sensível — nunca custo/horas). [SEC-S3] */
export const AUDITABLE_FIELDS = ["title", "description", "priority", "dueDate"] as const;
export type AuditableField = (typeof AUDITABLE_FIELDS)[number];

/** Paginação keyset da timeline (mais recente primeiro). */
export const activityFiltersSchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).optional(),
  cursor: z.string().max(128).optional(), // cursor válido é "ISO|cuid" (~60 chars) [SEC-C1-003]
});
export type ActivityFilters = z.infer<typeof activityFiltersSchema>;

/** Comentário manual na timeline — texto puro (front renderiza escapado). [detalhe-tarefa C, SEC-108/109] */
export const createCommentSchema = z.object({
  body: z.string().trim().min(1).max(5000),
});
export type CreateCommentInput = z.infer<typeof createCommentSchema>;
export const editCommentSchema = createCommentSchema;
export type EditCommentInput = CreateCommentInput;

export const createSubtaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
});
export const updateSubtaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
});
