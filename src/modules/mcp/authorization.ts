import { AppError } from "../../lib/errors.js";
import { PERMISSIONS, type Permission } from "@sistema-tasks/contracts";
import { Authorizer, resolveEffectivePermissions } from "../authz/authorizer.js";
import type { SessionContext } from "../authz/types.js";
import type { McpAuthorizationDeps, McpAuthorizedContext, McpTokenClaims } from "./types.js";

type Scope = "projects:read" | "tasks:read" | "tasks:create" | "tasks:update";
interface ToolPolicy { scope?: Scope; permission?: Permission; project: boolean }

/** Server-owned allowlist. Headers/tool arguments cannot select scopes or permissions. */
const TOOL_POLICIES = new Map<string, ToolPolicy>([
  ["get_current_user", { project: false }],
  ["list_projects", { scope: "projects:read", project: false }],
  ["list_client_projects", { scope: "projects:read", project: true }],
  ["search_tasks", { scope: "tasks:read", permission: PERMISSIONS.tarefas_ver_globais, project: false }],
  ["get_task", { scope: "tasks:read", project: true }],
  ["get_task_timeline", { scope: "tasks:read", project: true }],
  ["list_pending_actions", { scope: "tasks:read", project: false }],
  ...["start_execution", "report_progress", "request_user_action", "submit_for_review"].map((name): [string, ToolPolicy] => [name, { scope: "tasks:update", permission: PERMISSIONS.tarefas_editar, project: true }]),
  ...["record_review_findings", "record_technical_review"].map((name): [string, ToolPolicy] => [name, { scope: "tasks:update", permission: PERMISSIONS.tarefas_revisar, project: true }]),
  ["create_task", { scope: "tasks:create", permission: PERMISSIONS.tarefas_criar, project: true }],
  ["update_task", { scope: "tasks:update", permission: PERMISSIONS.tarefas_editar, project: true }],
  ["report_finding_fix", { scope: "tasks:update", permission: PERMISSIONS.tarefas_editar, project: true }],
  ["transition_task", { scope: "tasks:update", permission: PERMISSIONS.tarefas_mover, project: true }],
]);

const SCOPE_PERMISSIONS: Record<Scope, readonly Permission[]> = {
  "projects:read": [],
  "tasks:read": [PERMISSIONS.tarefas_ver_globais],
  "tasks:create": [PERMISSIONS.tarefas_criar],
  "tasks:update": [PERMISSIONS.tarefas_editar, PERMISSIONS.tarefas_mover, PERMISSIONS.tarefas_revisar],
};
const SCOPES = new Set<string>(Object.keys(SCOPE_PERMISSIONS));

function invalidToken(): never {
  throw new AppError("NAO_AUTENTICADO", "Conexão MCP inválida ou expirada");
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value;
}

function scopeArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 100 && value.every(nonempty);
}

function validClaims(claims: McpTokenClaims, deps: McpAuthorizationDeps, now: number): boolean {
  const audience = Array.isArray(claims.audience) ? claims.audience : [claims.audience];
  return claims.issuer === deps.issuer && audience.includes(deps.resource) &&
    Number.isSafeInteger(claims.expiresAt) && claims.expiresAt > now &&
    Number.isSafeInteger(claims.tokenVersion) && claims.tokenVersion >= 0 &&
    nonempty(claims.grantId) && nonempty(claims.clientId) && nonempty(claims.userId) && nonempty(claims.orgId) &&
    scopeArray(claims.scopes);
}

/** OAuth verification is supplied by a maintained provider; this class applies application policy. */
export class McpAuthorization {
  private readonly authorizer: Authorizer;

  constructor(private readonly deps: McpAuthorizationDeps) {
    if (!nonempty(deps.issuer) || !nonempty(deps.resource)) {
      throw new AppError("INTERNO", "Issuer e recurso MCP precisam estar configurados");
    }
    this.authorizer = new Authorizer(deps.access);
  }

  async authorize(token: string, tool: string, projectId?: string): Promise<McpAuthorizedContext> {
    const policy = TOOL_POLICIES.get(tool);
    if (!policy) throw new AppError("SEM_PERMISSAO", "Ferramenta MCP não habilitada");
    if (typeof token !== "string" || !token.trim() || token.length > 16_384) invalidToken();
    const now = this.deps.now?.() ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(now)) throw new AppError("INTERNO", "Relógio do servidor inválido");
    const claims = await this.deps.verifier.verifyAccessToken(token);
    if (!claims || !validClaims(claims, this.deps, now)) invalidToken();

    const grant = await this.deps.grants.findById(claims.grantId);
    if (!grant || grant.id !== claims.grantId || grant.revokedAt !== null ||
      grant.userId !== claims.userId || grant.orgId !== claims.orgId || grant.clientId !== claims.clientId ||
      !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= now || !scopeArray(grant.scopes)) invalidToken();

    const user = await this.deps.users.findById(claims.userId);
    if (!user || user.id !== claims.userId || user.deletedAt !== null || user.orgId !== claims.orgId ||
      user.tokenVersion !== claims.tokenVersion) invalidToken();
    if (user.mustChangePassword) throw new AppError("TROCA_SENHA_OBRIGATORIA", "Troque a senha no painel para continuar");

    const scopes = new Set(claims.scopes.filter((scope) => SCOPES.has(scope) && grant.scopes.includes(scope)));
    if (policy.scope && !scopes.has(policy.scope)) throw new AppError("SEM_PERMISSAO", "A conexão não autoriza esta ferramenta");

    const currentPermissions = resolveEffectivePermissions(user.rolePermissions, user.extraPermissions);
    const permissions = new Set<Permission>();
    for (const scope of scopes) {
      for (const permission of SCOPE_PERMISSIONS[scope as Scope]) {
        if (currentPermissions.has(permission)) permissions.add(permission);
      }
    }
    // This only widens project visibility to its existing account scope, never grants an action.
    if (scopes.size > 0 && currentPermissions.has(PERMISSIONS.projetos_acessar_todos)) {
      permissions.add(PERMISSIONS.projetos_acessar_todos);
    }
    const session: SessionContext = {
      userId: user.id, orgId: user.orgId, permissions, mustChangePassword: false,
      name: user.name, email: user.email, avatarUrl: user.avatarUrl ?? null,
    };

    if (policy.project) {
      if (!nonempty(projectId)) throw new AppError("VALIDACAO", "Cliente da tarefa é obrigatório");
      const project = await this.deps.projects.findById(projectId);
      if (!project || project.id !== projectId || project.orgId !== session.orgId || project.deletedAt !== null) {
        throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
      }
      await this.authorizer.assertProjectAccess(session, projectId);
    }
    if (policy.permission) await this.authorizer.assertCan(session, policy.permission, projectId);

    return { session, connectionId: grant.id, clientId: grant.clientId, channel: "MCP", scopes };
  }
}
