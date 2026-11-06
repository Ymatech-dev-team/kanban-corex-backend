-- 019 — OAuth MCP persistente. PREPARADO, NÃO APLICADO.
-- Requer 016 (schema_migrations). Reutiliza índice composto de 018 se presente.
-- Executar após revisão independente. Não modifica credenciais/sessões do painel.
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS users_id_org_workflow_uidx ON users (id, "orgId");
CREATE TABLE IF NOT EXISTS mcp_connections (
  id TEXT PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "tokenVersion" INTEGER NOT NULL CHECK ("tokenVersion" >= 0),
  scopes TEXT[] NOT NULL,
  "expiresAt" BIGINT NOT NULL CHECK ("expiresAt" > 0),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT mcp_connections_user_org_fk FOREIGN KEY ("userId", "orgId") REFERENCES users(id, "orgId") ON DELETE RESTRICT,
  CONSTRAINT mcp_connections_scope_check CHECK (cardinality(scopes) BETWEEN 1 AND 16 AND array_position(scopes, NULL) IS NULL),
  CONSTRAINT mcp_connections_identity_check CHECK (length(id) BETWEEN 1 AND 256 AND length("clientId") BETWEEN 1 AND 256)
);
CREATE INDEX IF NOT EXISTS mcp_connections_user_idx ON mcp_connections("orgId", "userId", "createdAt" DESC);
-- Protocol artifacts are issued by oidc-provider; clients/interactions may predate account consent.
-- Keep separate from panel auth tables. Do not expose payloads/tokens in logs or APIs.
CREATE TABLE IF NOT EXISTS mcp_oauth_artifacts (
  model TEXT NOT NULL,
  id TEXT NOT NULL,
  payload JSONB NOT NULL,
  "expiresAt" BIGINT,
  PRIMARY KEY(model, id),
  CONSTRAINT mcp_oauth_payload_check CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 262144),
  CONSTRAINT mcp_oauth_identity_check CHECK (length(model) BETWEEN 1 AND 128 AND length(id) BETWEEN 1 AND 512),
  CONSTRAINT mcp_oauth_expiry_check CHECK ("expiresAt" IS NULL OR "expiresAt" > 0)
);
CREATE INDEX IF NOT EXISTS mcp_oauth_expiry_idx ON mcp_oauth_artifacts("expiresAt") WHERE "expiresAt" IS NOT NULL;
CREATE INDEX IF NOT EXISTS mcp_oauth_grant_idx ON mcp_oauth_artifacts((payload->>'grantId'));
CREATE INDEX IF NOT EXISTS mcp_oauth_uid_idx ON mcp_oauth_artifacts(model, (payload->>'uid')) WHERE payload ? 'uid';
CREATE INDEX IF NOT EXISTS mcp_oauth_usercode_idx ON mcp_oauth_artifacts(model, (payload->>'userCode')) WHERE payload ? 'userCode';
INSERT INTO schema_migrations (name) VALUES ('019_mcp_oauth') ON CONFLICT (name) DO NOTHING;
COMMIT;
