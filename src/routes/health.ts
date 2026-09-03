import type { FastifyInstance } from "fastify";

/** Rota de saúde — PÚBLICA (sem HMAC), usada pelo smoke test e pelo monitor da Vercel. */
export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", { config: { public: true } }, async () => ({
    status: "ok",
    service: "sistema-de-task-backend",
    ts: new Date().toISOString(),
  }));
}
