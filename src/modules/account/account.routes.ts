import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { changePasswordSchema, updateProfileSchema } from "@sistema-tasks/contracts";
import type { Authenticate } from "../authz/authenticate.js";
import type { AuthService } from "../auth/auth.service.js";
import type { MemberService } from "../admin/member.service.js";

/** Conta do próprio usuário: trocar senha, editar perfil, excluir conta. */
export function makeAccountRoutes(authenticate: Authenticate, auth: AuthService, members: MemberService) {
  return async function accountRoutes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    // Trocar a senha estando logado — derruba a sessão (bump), front volta pro login.
    r.post(
      "/auth/change-password",
      { preHandler: authenticate, schema: { body: changePasswordSchema } },
      async (req) => {
        await auth.changePassword(req.session!.userId, req.body.currentPassword, req.body.newPassword);
        return { ok: true };
      },
    );

    // Editar o próprio nome.
    r.patch("/me", { preHandler: authenticate, schema: { body: updateProfileSchema } }, async (req) => {
      await auth.updateName(req.session!.userId, req.body.name);
      return { ok: true };
    });

    // Excluir a própria conta (barra o último admin).
    r.delete("/me", { preHandler: authenticate }, async (req) => {
      await members.deleteOwnAccount(req.session!);
      return { ok: true };
    });
  };
}
