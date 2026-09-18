import type { FastifyInstance, FastifyRequest } from "fastify";
import { verifyInternal, verifyInternalV2 } from "../lib/hmac.js";
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
    const rawBody = (req as FastifyRequest & { rawBody?: string }).rawBody;

    // Se há corpo mas o parser de rawBody não rodou (content-type não suportado),
    // não verificamos contra "" — rejeita. [SEC-007]
    const hasBody = Number(req.headers["content-length"] ?? "0") > 0;
    if (hasBody && rawBody === undefined) {
      throw new AppError("NAO_AUTENTICADO", "Conteúdo não suportado");
    }

    const path = (req.url ?? "").split("?")[0];

    // T5 Fase 2: o v2 (método+path+hash+ts) é a auth PRIMÁRIA. Se presente e válido, autentica por ele.
    // Prod real deu 0 divergência na Fase 1 (observe-only), então o v2 é confiável. [hardening T5]
    const v2Header = String(req.headers["x-internal-sig-v2"] ?? "");
    if (v2Header) {
      const r2 = verifyInternalV2({ secret, method: req.method, path, body: rawBody ?? "", timestamp, signature: v2Header });
      if (r2.ok) return;
    }

    // Rede de segurança (dual-accept): v2 ausente/ inválido → cai pro v1. Enquanto essa rede existir,
    // logamos todo uso dela — quando `hmac_v1_fallback` ficar 0 em prod, a Fase 3 remove o v1. [hardening T5]
    const signature = String(req.headers["x-internal-signature"] ?? "");
    const res = verifyInternal({ secret, body: rawBody ?? "", timestamp, signature });
    if (!res.ok) {
      throw new AppError("NAO_AUTENTICADO", "Requisição interna não autenticada");
    }
    // só método+path e se HAVIA v2 (nunca body/assinatura) — dado suficiente sem vazar nada.
    req.log.warn({ event: "hmac_v1_fallback", method: req.method, path, hadV2: !!v2Header }, "auth via HMAC v1 (fase 2)");
  });
}
