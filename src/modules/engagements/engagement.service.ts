import { randomUUID } from "node:crypto";
import { AppError } from "../../lib/errors.js";
import type { SessionContext } from "../authz/types.js";
import type { ProjectAccessRepo } from "../projects/types.js";
import { isGeneralEngagement } from "./general.js";
import type {
  EngagementListItem,
  EngagementMemberRepo,
  EngagementMemberView,
  EngagementRecord,
  EngagementRepo,
} from "./types.js";

/** Projetos (Engagement) dentro de um Cliente. Autorização feita nas rotas (Authorizer por cliente). */
export class EngagementService {
  constructor(
    private readonly engagements: EngagementRepo,
    private readonly members: EngagementMemberRepo,
    private readonly access: ProjectAccessRepo,
  ) {}

  async getOrThrow(session: SessionContext, id: string): Promise<EngagementRecord> {
    const e = await this.engagements.findById(id, session.orgId);
    if (!e) throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
    return e;
  }

  async list(session: SessionContext, projectId: string): Promise<EngagementListItem[]> {
    return this.engagements.listByProject(projectId, session.orgId);
  }

  async create(
    session: SessionContext,
    projectId: string,
    input: { name: string; description?: string },
  ): Promise<EngagementRecord> {
    return this.engagements.create({
      orgId: session.orgId,
      projectId,
      name: input.name,
      description: input.description,
      createdById: session.userId,
    });
  }

  async update(
    session: SessionContext,
    engagement: EngagementRecord,
    data: { name?: string; description?: string | null },
  ): Promise<EngagementRecord> {
    return this.engagements.update(engagement.id, data);
  }

  async softDelete(session: SessionContext, engagement: EngagementRecord): Promise<void> {
    // "Projeto geral" é o balde padrão — nunca excluível. [RF-25]
    if (isGeneralEngagement(engagement.id, engagement.projectId)) {
      throw new AppError("VALIDACAO", "O Projeto geral não pode ser excluído");
    }
    // Garante que o cliente sempre tenha ≥ 1 projeto.
    const active = await this.engagements.countActiveByProject(engagement.projectId, session.orgId);
    if (active <= 1) {
      throw new AppError("VALIDACAO", "O cliente precisa ter ao menos um projeto");
    }
    await this.engagements.softDeleteWithTasks(engagement.id, randomUUID());
  }

  // ---- consultores ----
  async listConsultores(engagement: EngagementRecord): Promise<EngagementMemberView[]> {
    return this.members.list(engagement.id);
  }

  async addConsultor(engagement: EngagementRecord, userId: string): Promise<void> {
    // Só quem já tem acesso ao Cliente pode virar consultor do projeto. [RF-40]
    if (!(await this.access.isMember(userId, engagement.projectId))) {
      throw new AppError("VALIDACAO", "O usuário precisa ter acesso ao cliente para ser consultor");
    }
    await this.members.add(engagement.id, userId);
  }

  async removeConsultor(engagement: EngagementRecord, userId: string): Promise<void> {
    await this.members.remove(engagement.id, userId);
    // Anula o responsável só nas tarefas DESTE projeto atribuídas a ele. [RF-44/SEC-110]
    await this.members.nullAssigneesInEngagement(engagement.id, userId);
  }
}
