import { z } from "zod";
import { permissionListSchema } from "./permissions.js";

/** Contratos do painel admin (membros + perfis). */

export const createMemberSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().email("Email inválido"),
  roleId: z.string().optional(),
});
export type CreateMemberInput = z.infer<typeof createMemberSchema>;

export const updateMemberSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  roleId: z.string().nullable().optional(),
  extraPermissions: permissionListSchema.optional(),
  // confirmação reforçada ao conceder meta-permissão (acessar_todos / conceder) [SEC-104]
  confirmMetaPermission: z.boolean().optional(),
});
export type UpdateMemberInput = z.infer<typeof updateMemberSchema>;

export const createRoleSchema = z.object({
  name: z.string().trim().min(1).max(80),
  permissions: permissionListSchema,
});
export type CreateRoleInput = z.infer<typeof createRoleSchema>;

export const updateRoleSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  permissions: permissionListSchema.optional(),
  confirmMetaPermission: z.boolean().optional(),
});
export type UpdateRoleInput = z.infer<typeof updateRoleSchema>;
