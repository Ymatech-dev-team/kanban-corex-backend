import { z } from "zod";

/** Contratos de projeto (= cliente). */

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "Informe o nome do cliente").max(120),
  description: z.string().max(2000).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
});
export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;
