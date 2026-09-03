import type { FastifyInstance } from "fastify";

/** Rota protegida por HMAC — usada pelo BFF pra checar conectividade e no smoke de segurança. */
export async function internalPingRoutes(app: FastifyInstance): Promise<void> {
  app.get("/internal/ping", async () => ({ pong: true }));
}
