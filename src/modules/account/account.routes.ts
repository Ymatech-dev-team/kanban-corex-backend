import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { changePasswordSchema, updateProfileSchema } from "@sistema-tasks/contracts";
import type { Authenticate } from "../authz/authenticate.js";
import type { AuthService } from "../auth/auth.service.js";
import type { MemberService } from "../admin/member.service.js";
import type { ProfileService } from "./profile.service.js";
import { limitAuthAttempt, limitAvatarUpload } from "../auth/rate-limit.js";

// ~2 MB de corpo nesta rota (base64 de um avatar ≤512px + envelope JSON). Cap baixo = anti-DoS. [conta-redesign]
const AVATAR_BODY_LIMIT = 2 * 1024 * 1024;
const avatarBody = z.object({ imageBase64: z.string().min(1).max(2_000_000) });

/** Conta do próprio usuário: trocar senha, editar perfil, foto de perfil, excluir conta. */
export function makeAccountRoutes(
  authenticate: Authenticate,
  auth: AuthService,
  members: MemberService,
  profile: ProfileService,
) {
  return async function accountRoutes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    // Trocar a senha estando logado — derruba a sessão (bump), front volta pro login.
    r.post(
      "/auth/change-password",
      { preHandler: authenticate, schema: { body: changePasswordSchema } },
      async (req) => {
        await limitAuthAttempt(req.session!.userId, req.log); // throttle por usuário (token roubado) [T2]
        await auth.changePassword(req.session!.userId, req.body.currentPassword, req.body.newPassword);
        return { ok: true };
      },
    );

    // Editar o próprio nome.
    r.patch("/me", { preHandler: authenticate, schema: { body: updateProfileSchema } }, async (req) => {
      await auth.updateName(req.session!.userId, req.body.name);
      return { ok: true };
    });

    // Foto de perfil: sobe base64, o backend valida+re-encoda (sharp) e grava no store PÚBLICO. [conta-redesign]
    r.post(
      "/me/avatar",
      { preHandler: authenticate, bodyLimit: AVATAR_BODY_LIMIT, schema: { body: avatarBody } },
      async (req) => {
        await limitAvatarUpload(req.session!.userId, req.log); // throttle por usuário (churn de put+delete)
        return profile.setAvatar(req.session!.userId, req.body.imageBase64, req.log);
      },
    );

    // Remover a foto: apaga o blob de fato E zera a coluna.
    r.delete("/me/avatar", { preHandler: authenticate }, async (req) => {
      await profile.removeAvatar(req.session!.userId, req.log);
      return { ok: true };
    });

    // Excluir a própria conta (barra o último admin).
    r.delete("/me", { preHandler: authenticate }, async (req) => {
      await members.deleteOwnAccount(req.session!);
      return { ok: true };
    });
  };
}
