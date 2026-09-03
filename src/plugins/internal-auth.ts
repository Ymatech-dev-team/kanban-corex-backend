import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyInternal } from "../lib/hmac.js";
import { AppError } from "../lib/errors.js";

/**
 * Exige HMAC interno em toda rota, exceto as marcadas `config: { public: true }`.
 * Captura o rawBody (byte-exato) para a verificação. [design.md §1.1, SEC-002]
 */
export function registerInternalAuth(app: FastifyInstance): void {
  // rawBody para HMAC byte-a-byte (não JSON.stringify, que reordena chaves).
  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (req, body, done) => {
      (req as FastifyRequest & { rawBody?: string }).rawBody = body as string;
      if (body === "" || body == null) return done(null, undefined);
      try {
        done(null, JSON.parse(body as string));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // preValidation roda DEPOIS do parse (rawBody disponível), ANTES da validação de schema.
  app.addHook("preValidation", async (req) => {
    const isPublic = (req.routeOptions?.config as { public?: boolean } | undefined)?.public;
    if (isPublic) return;

    const secret = process.env.INTERNAL_API_SECRET;
    if (!secret) {
      throw new AppError("INTERNO", "INTERNAL_API_SECRET ausente");
    }
    const timestamp = Number(req.headers["x-internal-timestamp"]);
    const signature = String(req.headers["x-internal-signature"] ?? "");
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody;

    // Se há corpo mas o parser de rawBody não rodou (content-type não suportado),
    // não verificamos contra "" — rejeita. [SEC-007]
    const hasBody = Number(req.headers["content-length"] ?? "0") > 0;
    if (hasBody && rawBody === undefined) {
      throw new AppError("NAO_AUTENTICADO", "Conteúdo não suportado");
    }

    const res = verifyInternal({ secret, body: rawBody ?? "", timestamp, signature });
    if (!res.ok) {
      throw new AppError("NAO_AUTENTICADO", "Requisição interna não autenticada");
    }
  });
}
