import type { IncomingMessage, ServerResponse } from "node:http";
import { ZodError as DomainValidationError } from "zod";
import { z, type ZodRawShape } from "zod/v4";
import { createMcpHandler, fromJsonSchema, McpServer, requireBearerAuth, OAuthError, OAuthErrorCode } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { AppError } from "../../lib/errors.js";
import { MCP_SCOPES } from "./oauth/provider.js";
import type { McpAuthorization } from "./authorization.js";
import type { McpTokenVerifier } from "./types.js";
export interface McpToolDefinition {
  name: string; description: string; inputSchema: ZodRawShape; readOnly: boolean;
  execute(token: string, input: unknown): Promise<unknown>;
}
export interface McpTransportOptions {
  issuer: string; resource: string; verifier: McpTokenVerifier;
  authorization: Pick<McpAuthorization, "authorize">; tools: McpToolDefinition[];
  allowedOrigins?: string[];
}
export function createMcpTransport(options: McpTransportOptions) {
  const resource = new URL(options.resource);
  const metadataPath = `/.well-known/oauth-protected-resource${resource.pathname === "/" ? "" : resource.pathname}`;
  const metadataUrl = new URL(metadataPath, resource.origin).href;
  const gate = requireBearerAuth({ expectedResource: resource, resourceMetadataUrl: metadataUrl, verifier: {
    async verifyAccessToken(token) {
      const claims = await options.verifier.verifyAccessToken(token);
      if (!claims || claims.issuer !== options.issuer) throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid MCP token");
      try { await options.authorization.authorize(token, "get_current_user"); }
      catch (error) {
        if (error instanceof AppError && ["NAO_AUTENTICADO", "TROCA_SENHA_OBRIGATORIA", "SEM_PERMISSAO"].includes(error.code)) throw new OAuthError(OAuthErrorCode.InvalidToken, "Connection unavailable");
        throw error;
      }
      const audiences = Array.isArray(claims.audience) ? claims.audience : [claims.audience];
      if (!audiences.includes(options.resource)) throw new OAuthError(OAuthErrorCode.InvalidToken, "Invalid resource");
      return { token, clientId: claims.clientId, scopes: claims.scopes, expiresAt: claims.expiresAt, resource };
    },
  } });
  const sdk = createMcpHandler((ctx) => {
    const server = new McpServer({ name: "corex-kanban", version: "1.0.0" });
    for (const tool of options.tools) {
      server.registerTool(tool.name, { description: tool.description, inputSchema: fromJsonSchema(z.toJSONSchema(z.object(tool.inputSchema).strict(), { io: "input" }) as Parameters<typeof fromJsonSchema>[0]),
        annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false } }, async (input: unknown) => {
        try {
          if (!ctx.authInfo?.token) throw new AppError("NAO_AUTENTICADO", "Conexão inválida");
          const args = z.object(tool.inputSchema).strict().parse(input);
          const result = await tool.execute(ctx.authInfo.token, args);
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
        } catch (error) {
          const message = error instanceof AppError ? `${error.code}: ${error.message}` : (error instanceof z.ZodError || error instanceof DomainValidationError) ? "VALIDACAO: Argumentos inválidos" : "INTERNO: Não foi possível concluir a operação";
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      });
    }
    return server;
  }, { legacy: "stateless", maxRequestBodySize: 128 * 1024, maxSubscriptions: 0 });
  const handler = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      if (url.host !== resource.host) return new Response("Invalid host", { status: 400 });
      if (url.pathname === metadataPath && request.method === "GET") return Response.json({ resource: options.resource, authorization_servers: [options.issuer], scopes_supported: MCP_SCOPES, bearer_methods_supported: ["header"], resource_name: "Corex Kanban" });
      if (url.pathname !== resource.pathname) return new Response("Not found", { status: 404 });
      const origin = request.headers.get("origin");
      if (origin && ![resource.origin, ...(options.allowedOrigins ?? [])].includes(origin)) return new Response("Invalid origin", { status: 403 });
      const auth = await gate(request);
      if (auth instanceof Response) return auth;
      return sdk.fetch(request, { authInfo: auth });
    },
  };
  const node = toNodeHandler(handler, { maxRequestBodySize: 128 * 1024 });
  return { ...handler, async handle(req: IncomingMessage, res: ServerResponse) { await node(req, res); } };
}
