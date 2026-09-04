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

/** Remuneração do membro: salário mensal OU valor/hora (exclusivos). Valor em CENTAVOS. */
export const COMPENSATION_TYPES = ["MONTHLY", "HOURLY"] as const;
export const compensationTypeSchema = z.enum(COMPENSATION_TYPES);
export type CompensationType = (typeof COMPENSATION_TYPES)[number];

export const setCompensationSchema = z
  .object({
    type: compensationTypeSchema.nullable(),
    amountCents: z.number().int().min(0).max(100_000_000).nullable(), // teto R$ 1.000.000,00
  })
  .refine((d) => (d.type === null) === (d.amountCents === null), {
    message: "Informe o tipo e o valor, ou limpe os dois.",
    path: ["amountCents"],
  });
export type SetCompensationInput = z.infer<typeof setCompensationSchema>;

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
