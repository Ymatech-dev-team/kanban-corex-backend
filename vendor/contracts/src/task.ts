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
});
export type CreateTaskInput = z.infer<typeof createTaskSchema>;

export const updateTaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  dueDate: z.string().datetime().nullable().optional(),
  assigneeId: z.string().nullable().optional(),
  // projectId é IMUTÁVEL via PATCH [SEC-106] — nem entra no schema.
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

export const createSubtaskSchema = z.object({
  title: z.string().trim().min(1).max(200),
});
export const updateSubtaskSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  done: z.boolean().optional(),
});
