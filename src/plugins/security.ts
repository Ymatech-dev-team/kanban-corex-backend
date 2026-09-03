import type { FastifyInstance } from "fastify";
import helmet from "@fastify/helmet";
import cors from "@fastify/cors";

/**
 * Headers de segurança (helmet) + CORS restritivo. [design.md §4]
 * O navegador NÃO fala direto com a API (só o BFF, servidor-a-servidor) — logo
 * CORS é uma allowlist mínima, defensiva; a barreira real é o HMAC (internal-auth).
 */
export function registerSecurity(app: FastifyInstance): void {
  app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
      },
    },
    hsts: { maxAge: 15_552_000, includeSubDomains: true },
  });

  const frontend = process.env.FRONTEND_URL;
  app.register(cors, {
    origin: frontend ? [frontend] : false,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE"],
  });
}
