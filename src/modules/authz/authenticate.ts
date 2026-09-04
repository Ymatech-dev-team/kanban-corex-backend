import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../lib/errors.js";
import { TokenService } from "../auth/token.service.js";
import { resolveEffectivePermissions } from "./authorizer.js";
import type { AuthzUserRepo, SessionContext } from "./types.js";

declare module "fastify" {
  interface FastifyRequest {
    session?: SessionContext;
  }
}

export type Authenticate = (req: FastifyRequest, reply: FastifyReply) => Promise<void>;

function bearer(req: FastifyRequest): string {
  const h = req.headers.authorization;
  if (!h || !/^Bearer\s+/i.test(h)) {
    throw new AppError("NAO_AUTENTICADO", "Sessão inválida");
  }
  return h.replace(/^Bearer\s+/i, "");
}

/**
 * O "porteiro": valida o access token, busca o usuário FRESCO no banco (deletedAt +
 * tokenVersion — bump derruba a sessão), aplica mustChangePassword, e resolve a
 * permissão efetiva por request (não confia no que veio no token). [design.md §2.3]
 */
export function makeAuthenticate(deps: { tokens: TokenService; users: AuthzUserRepo }): Authenticate {
  return async function authenticate(req, _reply) {
    const claims = deps.tokens.verifyAccess(bearer(req));
    const user = await deps.users.findById(claims.userId);
    if (!user || user.deletedAt) {
      throw new AppError("NAO_AUTENTICADO", "Sessão inválida");
    }
    if (claims.orgId !== user.orgId) {
      throw new AppError("NAO_AUTENTICADO", "Sessão inválida"); // coerência token↔banco [SEC-A02]
    }
    if (user.tokenVersion !== claims.tokenVersion) {
      throw new AppError("NAO_AUTENTICADO", "Sessão expirada"); // senha trocada / rebaixado [SEC-007]
    }
    const allowMustChange = (req.routeOptions?.config as { allowMustChange?: boolean } | undefined)
      ?.allowMustChange;
    if (user.mustChangePassword && !allowMustChange) {
      throw new AppError("TROCA_SENHA_OBRIGATORIA", "Troque a senha para continuar");
    }

    req.session = {
      userId: user.id,
      orgId: user.orgId,
      permissions: resolveEffectivePermissions(user.rolePermissions, user.extraPermissions),
      mustChangePassword: user.mustChangePassword,
      name: user.name,
      email: user.email,
    };
  };
}
