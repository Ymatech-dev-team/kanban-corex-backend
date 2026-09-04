import type { FastifyInstance } from "fastify";
import type { Authenticate } from "../modules/authz/authenticate.js";

/**
 * GET /me — dados da sessão + permissões efetivas + mustChangePassword.
 * `allowMustChange` para o front conseguir ler o flag e rotear pra troca de senha. [JOR]
 */
export function makeMeRoutes(authenticate: Authenticate) {
  return async function meRoutes(app: FastifyInstance): Promise<void> {
    app.get("/me", { config: { allowMustChange: true }, preHandler: authenticate }, async (req) => {
      const s = req.session!;
      return {
        userId: s.userId,
        orgId: s.orgId,
        name: s.name ?? "",
        email: s.email ?? "",
        permissions: [...s.permissions],
        mustChangePassword: s.mustChangePassword,
      };
    });
  };
}
