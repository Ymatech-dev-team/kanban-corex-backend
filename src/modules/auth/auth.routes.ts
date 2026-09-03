import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { loginSchema, refreshSchema, firstLoginSchema } from "@sistema-tasks/contracts";
import { AuthService } from "./auth.service.js";
import { TokenService } from "./token.service.js";

/**
 * Rotas de auth. NÃO são `public` (exigem HMAC do BFF), mas não exigem sessão.
 * A API devolve os tokens no corpo; o BFF é quem guarda no cookie httpOnly. [design.md §1.1]
 */
export function makeAuthRoutes(service: AuthService, tokens: TokenService) {
  return async function authRoutes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post("/auth/login", { schema: { body: loginSchema } }, async (req) => {
      const { email, password } = req.body;
      const out = await service.login(email, password);
      return {
        accessToken: out.access,
        refreshToken: out.refresh,
        mustChangePassword: out.mustChangePassword,
      };
    });

    r.post("/auth/refresh", { schema: { body: refreshSchema } }, async (req) => {
      const out = await service.refreshSession(req.body.refreshToken);
      return { accessToken: out.access, refreshToken: out.refresh };
    });

    r.post("/auth/logout", { schema: { body: refreshSchema } }, async (req) => {
      await service.logout(req.body.refreshToken);
      return { ok: true };
    });

    r.post("/auth/first-login", { schema: { body: firstLoginSchema } }, async (req) => {
      const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
      const { userId } = tokens.verifyAccess(bearer);
      await service.firstLogin(userId, req.body.currentPassword, req.body.newPassword);
      return { ok: true };
    });
  };
}
