import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { McpOperationalError, type McpOperationalGuard, type McpEndpointKind } from './operational-guards.js';
import { AppError } from '../../lib/errors.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Authenticate } from '../authz/authenticate.js';
import type { McpConnectionStore } from './oauth/prisma-store.js';
export interface McpRouteOptions {
  issuer: string; resource: string;
  operationalGuard?: McpOperationalGuard;
  oauth: {handle(req:IncomingMessage,res:ServerResponse):Promise<void>};
  transport: {handle(req:IncomingMessage,res:ServerResponse):Promise<void>};
  connections: McpConnectionStore; authenticate: Authenticate;
}
export function makeMcpRoutes(options: McpRouteOptions) {
  return async (app: FastifyInstance) => {
    const issuer = new URL(options.issuer);
    const resource = new URL(options.resource);
    const dispatch = (service: McpRouteOptions["oauth"], kind: McpEndpointKind, rewrite?: string) => async (req: FastifyRequest, reply: FastifyReply) => {
      // The provider/SDK reads raw streams and performs its own explicit authentication.
      // Hijack in onRequest, before JSON parsing and the internal BFF HMAC hook.
      // Never mark these routes public to skip application authorization implicitly.
      reply.hijack();
      try { await options.operationalGuard?.check(req.raw, kind); }
      catch (error) {
        const failure = error instanceof McpOperationalError ? error : new McpOperationalError(503, 5);
        reply.raw.statusCode = failure.statusCode;
        reply.raw.setHeader("Content-Type", "application/json; charset=utf-8");
        reply.raw.setHeader("Cache-Control", "no-store");
        reply.raw.setHeader("Retry-After", String(failure.retryAfterSeconds));
        reply.raw.end(JSON.stringify({ error: failure.statusCode === 429 ? "rate_limited" : "temporarily_unavailable", message: failure.message }));
        return;
      }
      if (rewrite) req.raw.url = rewrite;
      try { await service.handle(req.raw, reply.raw); }
      catch {
        if (!reply.raw.headersSent) {
          reply.raw.statusCode = 500;
          reply.raw.setHeader("Content-Type", "text/plain; charset=utf-8");
          reply.raw.setHeader("Cache-Control", "no-store");
        }
        if (!reply.raw.writableEnded) reply.raw.end("Não foi possível concluir a conexão");
      }
    };
    const unreachable = async () => { throw new Error("Raw OAuth/MCP handler did not dispatch"); };
    // Per-route silent logs avoid writing OAuth codes/query parameters into access logs.
    app.all(`${issuer.pathname}/*`, { logLevel: "silent", onRequest: dispatch(options.oauth, "oauth") }, unreachable);
    app.get(`/.well-known/oauth-authorization-server${issuer.pathname}`, {
      logLevel: "silent", onRequest: dispatch(options.oauth, "metadata", `${issuer.pathname}/.well-known/openid-configuration`),
    }, unreachable);
    app.all(resource.pathname, { logLevel: "silent", onRequest: dispatch(options.transport, "mcp") }, unreachable);
    app.get(`/.well-known/oauth-protected-resource${resource.pathname}`, {
      logLevel: "silent", onRequest: dispatch(options.transport, "metadata"),
    }, unreachable);

    // Account management intentionally keeps the normal BFF HMAC + current web session.
    app.get("/mcp/connections", { preHandler: options.authenticate }, async (req) => {
      const session = req.session!;
      const connections = await options.connections.list(session.userId, session.orgId);
      return { connections: connections.map(({ id, clientId, scopes, expiresAt, revokedAt }) => ({ id, clientId, scopes, expiresAt, revokedAt })) };
    });
    app.delete<{ Params: { id: string } }>("/mcp/connections/:id", { preHandler: options.authenticate }, async (req) => {
      const session = req.session!;
      if (req.params.id.length > 256) throw new AppError("VALIDACAO", "Conexão inválida");
      const revoked = await options.connections.revoke(req.params.id, session.userId, session.orgId);
      if (!revoked) throw new AppError("NAO_ENCONTRADO", "Conexão não encontrada");
      return { revoked: true };
    });
  };
}
