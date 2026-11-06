import type { IncomingMessage, ServerResponse } from "node:http";
import { Provider, errors, type ClientMetadata, type JWKS } from "oidc-provider";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { renderConsent, renderConsentError } from "./consent-view.js";
import { createOAuthAdapter } from "./storage.js";
import type { AuthzUserRecord, AuthzUserRepo } from "../../authz/types.js";
import type { McpTokenVerifier } from "../types.js";
import type { OAuthRecordStore } from "./storage.js";
import type { McpConnectionStore } from "./prisma-store.js";
export interface McpOAuthOptions {
  issuer: string; resource: string; trustProxy?: boolean; cookieKeys: string[]; jwks: JWKS; clients: ClientMetadata[];
  records: OAuthRecordStore; connections: McpConnectionStore; users: AuthzUserRepo;
  /** Existing AuthService login/lockout verification; returns a server-loaded account, never model args. */
  authenticate(email: string, password: string): Promise<AuthzUserRecord>;
}
export interface McpOAuthService extends McpTokenVerifier {
  provider: Provider;
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}
export const MCP_SCOPES = ["projects:read", "tasks:read", "tasks:create", "tasks:update"] as const;
const lifetime = 30 * 24 * 60 * 60;
const clock = () => Math.floor(Date.now() / 1000);

function configuredUrl(value: string) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("OAuth requires a configured HTTPS URL (HTTP only on loopback)");
  }
  return url;
}
function active(user: AuthzUserRecord | null): user is AuthzUserRecord { return !!user && user.deletedAt === null && !user.mustChangePassword; }
function send(res: ServerResponse, status: number, body: string, contentType = "text/plain; charset=utf-8", nonce?: string) {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "no-store");
  // Native form POSTs send Origin: null under no-referrer. Keep same-origin
  // submission verifiable without disclosing interaction URLs to other origins.
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Security-Policy", `default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'${nonce ? `; style-src 'nonce-${nonce}'` : ""}`);
  res.end(body);
}
async function formBody(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/x-www-form-urlencoded") throw new Error("content type");
  let text = "";
  for await (const chunk of req) {
    text += chunk.toString();
    if (Buffer.byteLength(text) > 8192) throw new Error("body limit");
  }
  const body = new URLSearchParams(text);
  if ([...body.keys()].some((key) => body.getAll(key).length !== 1)) throw new Error("duplicate parameters");
  return body;
}

/** OAuth primitives and token validation belong exclusively to oidc-provider. */
export function createMcpOAuth(options: McpOAuthOptions): McpOAuthService {
  const issuerUrl = configuredUrl(options.issuer);
  configuredUrl(options.resource);
  if (options.issuer.endsWith("/") || issuerUrl.pathname === "/") throw new Error("Use a dedicated issuer path, e.g. /oauth");
  if (!options.cookieKeys.length || options.cookieKeys.some((key) => key.length < 32) || !options.jwks.keys.length || !options.clients.length) {
    throw new Error("Persistent OAuth cookie keys, JWKS and explicit clients are required");
  }
  const prefix = issuerUrl.pathname;
  const adapter = createOAuthAdapter(options.records);
  async function validConnection(id: string, accountId: string, clientId: string) {
    const c = await options.connections.findById(id);
    if (!c || c.revokedAt || c.expiresAt <= clock() || c.userId !== accountId || c.clientId !== clientId) return null;
    const user = await options.users.findById(accountId);
    return active(user) && user.id === c.userId && user.orgId === c.orgId && user.tokenVersion === c.tokenVersion ? c : null;
  }
  const provider: Provider = new Provider(options.issuer, {
    adapter, clients: options.clients, jwks: options.jwks, responseTypes: ["code"],
    cookies: { keys: options.cookieKeys, long: { signed: true, httpOnly: true, sameSite: "lax" }, short: { signed: true, httpOnly: true, sameSite: "lax" } },
    scopes: ["openid", "offline_access"],
    claims: { openid: ["sub"] },
    features: {
      devInteractions: { enabled: false }, registration: { enabled: false }, revocation: { enabled: true },
      resourceIndicators: { enabled: true, defaultResource: () => options.resource, useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== options.resource) throw new errors.InvalidTarget();
          return { scope: MCP_SCOPES.join(" "), audience: options.resource, accessTokenTTL: 600, accessTokenFormat: "opaque" };
        } },
    },
    pkce: { required: () => true },
    ttl: { AccessToken: 600, AuthorizationCode: 60, RefreshToken: lifetime, Grant: lifetime, Session: 3600, Interaction: 600 },
    rotateRefreshToken: true,
    issueRefreshToken: (_ctx, client) => client.grantTypeAllowed("refresh_token"),
    interactions: { url: (_ctx, interaction) => `${prefix}/interaction/${interaction.uid}` },
    async findAccount(_ctx, id) {
      const user = await options.users.findById(id);
      if (!active(user)) return undefined;
      return { accountId: user.id, claims: () => ({ sub: user.id }) };
    },
    async loadExistingGrant(ctx) {
      // Only consent from this interaction. Never silently reuse a browser's old grant.
      const id = ctx.oidc.result?.consent?.grantId;
      if (typeof id !== "string") return undefined;
      const grant = await provider.Grant.find(id);
      if (!grant || !await validConnection(id, grant.accountId!, grant.clientId!)) return undefined;
      return grant;
    },
    async extraTokenClaims(_ctx, token) {
      if (token.kind !== "AccessToken" || !token.clientId) throw new errors.InvalidGrant();
      const c = await validConnection(token.grantId, token.accountId, token.clientId);
      if (!c) throw new errors.InvalidGrant("Connection expired or revoked");
      return { orgId: c.orgId, tokenVersion: c.tokenVersion };
    },
  });
  provider.proxy = options.trustProxy ?? false;
  const callback = provider.callback();
  const csrfAdapter = new adapter("McpConsentCsrf");
  const completionAdapter = new adapter("McpConsentCompletion");
  return {
    provider,
    async verifyAccessToken(value) {
      // AccessToken.find verifies its opaque artifact, expiry and provider session binding.
      const token = await provider.AccessToken.find(value);
      if (!token || !token.clientId || typeof token.exp !== "number" || token.tokenType !== "Bearer" || token.aud !== options.resource) return null;
      const c = await validConnection(token.grantId, token.accountId, token.clientId);
      if (!c || token.extra?.orgId !== c.orgId || token.extra?.tokenVersion !== c.tokenVersion) return null;
      return { issuer: options.issuer, audience: options.resource, expiresAt: token.exp, scopes: (token.scope ?? "").split(" ").filter(Boolean), grantId: c.id, clientId: c.clientId, userId: c.userId, orgId: c.orgId, tokenVersion: c.tokenVersion };
    },
    async handle(req, res) {
      if (req.headers.host !== issuerUrl.host) { send(res, 400, "Invalid host"); return; }
      const path = new URL(req.url ?? "/", options.issuer).pathname;
      if (!path.startsWith(`${prefix}/`)) { send(res, 404, "Not found"); return; }
      if (!path.startsWith(`${prefix}/interaction/`)) {
        const originalUrl = req.url;
        const mounted = req as IncomingMessage & { originalUrl?: string };
        mounted.originalUrl = originalUrl;
        req.url = req.url!.slice(prefix.length);
        try { await callback(req, res); } finally { req.url = originalUrl; delete mounted.originalUrl; }
        return;
      }
      // Vercel may detach req.socket when the request body ends. The provider
      // creates a fresh Koa context during completion and still needs the original
      // transport and signed-cookie headers. Preserve this request's metadata only;
      // never fabricate TLS or change the trust-proxy / Origin checks.
      const completionRequest = Object.create(req, {
        socket: { value: req.socket },
        headers: { value: { ...req.headers } },
        url: { value: req.url },
        method: { value: req.method },
      }) as IncomingMessage;
      let stage = "interaction";
      try {
        const interaction = await provider.interactionDetails(req, res);
        if (path !== `${prefix}/interaction/${interaction.uid}`) { send(res, 400, "Invalid interaction"); return; }
        const requested = String(interaction.params.scope ?? "").split(" ");
        const scopes = MCP_SCOPES.filter((scope) => requested.includes(scope));
        const clientId = String(interaction.params.client_id ?? "");
        if (!scopes.length || !options.clients.some((c) => c.client_id === clientId)) { send(res, 400, "Invalid scopes or client"); return; }
        if (req.method === "GET") {
          const csrf = randomBytes(32).toString("base64url");
          await csrfAdapter.upsert(`${interaction.uid}:${csrf}`, { value: csrf }, 600);
          await completionAdapter.upsert(interaction.uid, {}, 600);
          const nonce = randomBytes(18).toString("base64url");
          send(res, 200, renderConsent({ clientId, scopes, csrf, nonce }), "text/html; charset=utf-8", nonce);
          return;
        }
        if (req.method !== "POST") { send(res, 405, "Method not allowed"); return; }
        if (req.headers.origin !== issuerUrl.origin) { send(res, 403, "Origem inválida"); return; }
        stage = "form";
        const body = await formBody(req);
        const csrfId = `${interaction.uid}:${body.get("csrf") ?? ""}`;
        const csrf = await csrfAdapter.find(csrfId);
        const expected = Buffer.from(typeof csrf?.value === "string" ? csrf.value : "");
        const actual = Buffer.from(body.get("csrf") ?? "");
        if (!expected.length || actual.length !== expected.length || !timingSafeEqual(actual, expected)) { send(res, 403, "Formulário expirado"); return; }
        stage = "csrf_consume";
        await csrfAdapter.consume(csrfId);
        if (body.get("decision") === "deny") { stage = "deny_completion"; await completionAdapter.consume(interaction.uid); stage = "deny_finish"; await provider.interactionFinished(completionRequest, res, { error: "access_denied", error_description: "User denied access" }); return; }
        if (body.get("decision") !== "allow") { send(res, 400, "Decisão inválida"); return; }
        stage = "authenticate";
        let authenticated: AuthzUserRecord;
        try { authenticated = await options.authenticate(body.get("email") ?? "", body.get("password") ?? ""); }
        catch { const nonce = randomBytes(18).toString("base64url"); send(res, 401, renderConsentError("Confira seu e-mail e senha. Se sua conta pede uma troca de senha, conclua essa etapa no painel.", path, nonce), "text/html; charset=utf-8", nonce); return; }
        const user = await options.users.findById(authenticated.id);
        if (!active(user) || user.orgId !== authenticated.orgId || user.tokenVersion !== authenticated.tokenVersion) { send(res, 403, "Entre no painel para atualizar sua conta"); return; }
        stage = "allow_completion";
        await completionAdapter.consume(interaction.uid);
        const grant = new provider.Grant({ accountId: user.id, clientId });
        grant.addResourceScope(options.resource, scopes.join(" "));
        grant.addOIDCScope(requested.filter((s) => ["openid", "offline_access"].includes(s)).join(" "));
        stage = "grant_save";
        const grantId = await grant.save();
        stage = "connection_create";
        await options.connections.create({ id: grantId, userId: user.id, orgId: user.orgId, clientId, tokenVersion: user.tokenVersion, scopes, revokedAt: null, expiresAt: clock() + lifetime });
        stage = "allow_finish";
        await provider.interactionFinished(completionRequest, res, { login: { accountId: user.id, remember: false }, consent: { grantId } }, { mergeWithLastSubmission: false });
      } catch (error) {
        const errorName = error instanceof Error ? error.name : "";
        const category = ["SessionNotFound", "TypeError", "PrismaClientKnownRequestError", "PrismaClientValidationError", "Error"].includes(errorName) ? errorName : "other";
        const message = error instanceof Error ? error.message : "";
        const reason = message.includes("encrypted") ? "socket_unavailable" : message.includes("secure cookie") ? "secure_cookie" : message.includes("headers") ? "headers" : message.includes("session id cookie") ? "cookie_missing" : message.includes("session not found") ? "session_missing" : message.includes("ttl") ? "ttl" : "other";
        // Only fixed internal stage labels; never log request data or exception details.
        console.warn({ event: "mcp_consent_failed", stage, category, reason });
        // No provider details, passwords, tokens or database messages in HTTP responses.
        if (!res.headersSent) send(res, 400, "Interação inválida ou expirada. Inicie a conexão novamente.");
        else if (!res.writableEnded) res.end();
      }
    },
  };
}
