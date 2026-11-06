import type { PrismaClient } from '@prisma/client';
import type { ClientMetadata, JWKS } from 'oidc-provider';
import { AppError } from '../../lib/errors.js';
import type { AuthService } from '../auth/auth.service.js';
import type { Authenticate } from '../authz/authenticate.js';
import { PrismaAuthzUserRepo } from '../authz/prisma-repos.js';
import { PrismaProjectAccessRepo } from '../projects/prisma-repos.js';
import type { ProjectService } from '../projects/project.service.js';
import type { EngagementService } from '../engagements/engagement.service.js';
import type { TaskService } from '../tasks/task.service.js';
import type { WorkflowStore } from '../workflow/persistence.js';
import { createMcpOperationalGuard, createUpstashMcpOperationalStore } from './operational-guards.js';
import { McpAuthorization } from './authorization.js';
import { createMcpOAuth } from './oauth/provider.js';
import { PrismaOAuthStore } from './oauth/prisma-store.js';
import { createMcpTransport } from './transport.js';
import { createCorexMcpTools } from './tools.js';
import type { McpRouteOptions } from './mcp.routes.js';

export function mcpConfigFromEnv(env: NodeJS.ProcessEnv) {
  const required = (key: string) => { const value = env[key]; if (!value) throw new Error(`${key} obrigatório quando MCP_ENABLED=true`); return value; };
  let cookieKeys: string[], jwks: JWKS, clients: ClientMetadata[], allowedOrigins: string[];
  try {
    cookieKeys = JSON.parse(required('MCP_COOKIE_KEYS'));
    jwks = JSON.parse(required('MCP_JWKS'));
    clients = JSON.parse(required('MCP_OAUTH_CLIENTS'));
    allowedOrigins = JSON.parse(env.MCP_ALLOWED_ORIGINS ?? '[]');
  } catch { throw new Error('Configuração JSON do MCP ausente ou inválida'); }
  if (!Array.isArray(cookieKeys) || !cookieKeys.length || cookieKeys.some(v => typeof v !== 'string' || v.length < 32) ||
      !jwks || !Array.isArray(jwks.keys) || !jwks.keys.length || !Array.isArray(clients) || !clients.length ||
      !Array.isArray(allowedOrigins) || allowedOrigins.some(v => typeof v !== 'string' || new URL(v).origin !== v)) {
    throw new Error('Configuração MCP inválida; use chaves persistentes e clientes explícitos');
  }
  const issuer = required('MCP_ISSUER'); const resource = required('MCP_RESOURCE');
  const issuerUrl = new URL(issuer); const resourceUrl = new URL(resource);
  // These endpoints are hosted together by this API, with reserved paths.
  if (issuerUrl.origin !== resourceUrl.origin || issuerUrl.pathname !== '/oauth' || resourceUrl.pathname !== '/mcp') {
    throw new Error('MCP_ISSUER e MCP_RESOURCE devem usar a mesma origem com /oauth e /mcp');
  }
  return { issuer, resource, cookieKeys, jwks, clients, allowedOrigins, trustProxy: env.MCP_TRUST_PROXY === 'true' };
}

export function createMcpRuntime(deps: {
  db: PrismaClient; auth: AuthService; authenticate: Authenticate; tasks: TaskService;
  projects: ProjectService; engagements: EngagementService; workflow: WorkflowStore; workflowEnabled: boolean;
}, env: NodeJS.ProcessEnv = process.env): McpRouteOptions {
  const config = mcpConfigFromEnv(env);
  const users = new PrismaAuthzUserRepo(deps.db);
  const records = new PrismaOAuthStore(deps.db);
  const operationalGuard = createMcpOperationalGuard({
    store: createUpstashMcpOperationalStore(env, config.resource), retention: records, vercel: env.VERCEL === '1',
    report: event => console.warn(JSON.stringify({ event })),
  });
  const oauth = createMcpOAuth({ ...config, records, connections: records, users,
    async authenticate(email, password) {
      const verified = await deps.auth.authenticateCredentials(email, password);
      const user = await users.findById(verified.id);
      if (!user || user.deletedAt || user.orgId !== verified.orgId || user.tokenVersion !== verified.tokenVersion) {
        throw new AppError('NAO_AUTENTICADO', 'Conta indisponível');
      }
      return user;
    },
  });
  const authorization = new McpAuthorization({ ...config, verifier: oauth, grants: records, users,
    projects: { findById: id => deps.db.project.findUnique({ where: {id}, select: { id: true, orgId: true, deletedAt: true } }) },
    access: new PrismaProjectAccessRepo(deps.db),
  });
  const tools = createCorexMcpTools({ authorization, tasks: deps.tasks, projects: deps.projects, engagements: deps.engagements, workflow: deps.workflow, workflowEnabled: deps.workflowEnabled });
  const transport = createMcpTransport({ ...config, verifier: oauth, authorization, tools });
  return { issuer: config.issuer, resource: config.resource, operationalGuard, oauth, transport, connections: records, authenticate: deps.authenticate };
}
