import type { IncomingMessage, ServerResponse } from "node:http";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";

/**
 * Ponte Fastify → função serverless do Vercel.
 * A app é construída e "aquecida" (app.ready) na primeira requisição (não no import,
 * pra o env já estar disponível) e reaproveitada entre invocações quentes.
 * O Vercel reescreve todas as rotas para /api (ver vercel.json), então o Fastify
 * recebe a URL original e faz o roteamento normalmente.
 */
let appPromise: Promise<FastifyInstance> | undefined;

function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    const app = buildApp();
    appPromise = Promise.resolve(app.ready()).then(() => app);
  }
  return appPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const app = await getApp();
  app.server.emit("request", req, res);
}
