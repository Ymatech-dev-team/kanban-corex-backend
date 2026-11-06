import type { AuthzUserRepo, ProjectAccessRepo, SessionContext } from "../authz/types.js";

/** Claims returned only after signature/introspection validation by the OAuth provider adapter. */
export interface McpTokenClaims {
  issuer: string;
  audience: string | string[];
  expiresAt: number; // Unix seconds
  scopes: string[];
  grantId: string;
  clientId: string;
  userId: string;
  orgId: string;
  tokenVersion: number;
}

export interface McpTokenVerifier {
  /** Null means invalid token. Operational errors must throw. Never decode an unsigned JWT here. */
  verifyAccessToken(token: string): Promise<McpTokenClaims | null>;
}

export interface McpGrant {
  id: string;
  userId: string;
  orgId: string;
  clientId: string;
  revokedAt: Date | null;
  expiresAt: number; // Unix seconds
  scopes: string[];
}

export interface McpGrantRepo {
  findById(id: string): Promise<McpGrant | null>;
}

export interface McpProjectRepo {
  /** Project is the existing client's canonical database record, not model-provided metadata. */
  findById(id: string): Promise<{ id: string; orgId: string; deletedAt: Date | null } | null>;
}

export interface McpAuthorizationDeps {
  issuer: string;
  resource: string;
  verifier: McpTokenVerifier;
  grants: McpGrantRepo;
  users: AuthzUserRepo;
  projects: McpProjectRepo;
  access: ProjectAccessRepo;
  now?: () => number; // Unix seconds, server clock
}

export interface McpAuthorizedContext {
  session: SessionContext;
  connectionId: string;
  clientId: string;
  channel: "MCP";
  scopes: ReadonlySet<string>;
}
