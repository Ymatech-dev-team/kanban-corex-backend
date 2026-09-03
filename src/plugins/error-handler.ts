import type { FastifyInstance } from "fastify";
import { AppError, errorBody } from "../lib/errors.js";

/** Contrato de erro uniforme, PT-BR, sem stack pro cliente. [design.md §3, RF12] */
export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error, req, reply) => {
    // Erro de validação de schema (Zod) — nunca vaza detalhe interno.
    if ((error as { validation?: unknown }).validation) {
      return reply.status(400).send(errorBody("VALIDACAO", "Dados inválidos"));
    }
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send(errorBody(error.code, error.message));
    }
    // Inesperado: log detalhado no servidor, resposta genérica pro cliente.
    req.log.error(error);
    return reply.status(500).send(errorBody("INTERNO", "Erro interno"));
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send(errorBody("NAO_ENCONTRADO", "Recurso não encontrado"));
  });
}
