import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import type { AuditRepo, SessionContext } from "../authz/types.js";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import type { EngagementMemberRepo } from "../engagements/types.js";
import type { ProjectAccessRepo, ProjectMemberView, ProjectRecord, ProjectRepo } from "./types.js";

/** Regra de negócio de projetos (= clientes). A autorização é feita nas rotas (authenticate + Authorizer). */
export class ProjectService {
  constructor(
    private readonly projects: ProjectRepo,
    private readonly access: ProjectAccessRepo,
    private readonly audit: AuditRepo,
    private readonly engagementMembers?: EngagementMemberRepo,
  ) {}

  async create(session: SessionContext, input: { name: string; description?: string }): Promise<ProjectRecord> {
    const project = await this.projects.create({
      orgId: session.orgId,
      name: input.name,
      description: input.description,
      createdById: session.userId,
    });
    // Quem cria já acessa (senão criaria um cliente que não consegue ver).
    await this.access.grant(project.id, session.userId);
    return project;
  }

  async list(session: SessionContext): Promise<ProjectRecord[]> {
    if (session.permissions.has(PERMISSIONS.projetos_acessar_todos)) {
      return this.projects.listByOrg(session.orgId);
    }
    const ids = await this.access.listAccessibleProjectIds(session.userId);
    return this.projects.listByIds(ids, session.orgId);
  }

  async getOrThrow(session: SessionContext, id: string): Promise<ProjectRecord> {
    const p = await this.projects.findById(id, session.orgId);
    if (!p) throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
    return p;
  }

  async update(
    session: SessionContext,
    id: string,
    data: { name?: string; description?: string | null },
  ): Promise<ProjectRecord> {
    await this.getOrThrow(session, id);
    return this.projects.update(id, data);
  }

  async softDelete(session: SessionContext, id: string): Promise<void> {
    await this.getOrThrow(session, id);
    await this.projects.softDeleteWithTasks(id, randomUUID());
  }

  async listMembers(session: SessionContext, id: string): Promise<ProjectMemberView[]> {
    await this.getOrThrow(session, id);
    return this.access.listMembers(id);
  }

  /** Pessoas dos clientes que o usuário acessa (id+nome) — fonte do filtro de Responsável da visão global. [tarefas-visao-global] */
  async listAccessibleMembers(session: SessionContext): Promise<ProjectMemberView[]> {
    const scope = session.permissions.has(PERMISSIONS.projetos_acessar_todos)
      ? "all"
      : await this.access.listAccessibleProjectIds(session.userId);
    return this.access.listAccessibleMembers(scope, session.orgId);
  }

  async grantAccess(session: SessionContext, projectId: string, userId: string): Promise<void> {
    await this.getOrThrow(session, projectId);
    if (!(await this.access.userExistsInOrg(userId, session.orgId))) {
      throw new AppError("NAO_ENCONTRADO", "Usuário não encontrado");
    }
    await this.access.grant(projectId, userId);
    await this.audit.record({
      actorId: session.userId,
      targetUserId: userId,
      action: "project.access.grant",
      detail: { projectId },
    });
  }

  async revokeAccess(session: SessionContext, projectId: string, userId: string): Promise<void> {
    await this.getOrThrow(session, projectId);
    await this.access.revoke(projectId, userId);
    await this.access.nullAssigneesInProject(projectId, userId); // [SEC-110]
    // Perdeu acesso ao cliente → sai de consultor de todos os projetos daquele cliente. [RF-42]
    await this.engagementMembers?.removeUserFromClientEngagements(projectId, userId);
    await this.audit.record({
      actorId: session.userId,
      targetUserId: userId,
      action: "project.access.revoke",
      detail: { projectId },
    });
  }
}
