import { z } from "zod";

/** Contratos de autenticação compartilhados entre front e back. */

export const loginSchema = z.object({
  email: z.string().email("Email inválido"),
  password: z.string().min(1, "Informe a senha"),
});
export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

export const firstLoginSchema = z
  .object({
    currentPassword: z.string().min(1, "Informe a senha temporária"),
    newPassword: z.string().min(8, "A nova senha deve ter ao menos 8 caracteres"),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    message: "As senhas não conferem",
    path: ["confirmPassword"],
  });
export type FirstLoginInput = z.infer<typeof firstLoginSchema>;

/** Papéis de tarefa (enum de domínio — texto + CHECK no banco). */
export const TASK_STATUS = ["TODO", "DOING", "DONE"] as const;
export const TASK_PRIORITY = ["LOW", "MEDIUM", "HIGH"] as const;
export const taskStatusSchema = z.enum(TASK_STATUS);
export const taskPrioritySchema = z.enum(TASK_PRIORITY);
export type TaskStatus = (typeof TASK_STATUS)[number];
export type TaskPriority = (typeof TASK_PRIORITY)[number];
