import type { PrismaClient } from "@prisma/client";
import { generalEngagementId } from "../engagements/general.js";
import type { NewProject, ProjectAccessRepo, ProjectMemberView, ProjectRecord, ProjectRepo } from "./types.js";

export class PrismaProjectRepo implements ProjectRepo {
  constructor(private readonly db: PrismaClient) {}

  async create(p: NewProject): Promise<ProjectRecord> {
    // Cria o cliente E seu "Projeto geral" (gen-<clienteId>) na mesma transação, para que
    // toda tarefa do cliente tenha um projeto pai desde o início. [hierarquia-projetos]
    return this.db.$transaction(async (tx) => {
      const project = await tx.project.create({
        data: { orgId: p.orgId, name: p.name, description: p.description ?? null, createdById: p.createdById },
      });
      await tx.engagement.create({
        data: {
          id: generalEngagementId(project.id),
          orgId: project.orgId,
          projectId: project.id,
          name: "Projeto geral",
          createdById: p.createdById,
        },
      });
      return project;
    });
  }
  async findById(id: string, orgId: string): Promise<ProjectRecord | null> {
    return this.db.project.findFirst({ where: { id, orgId, deletedAt: null } });
  }
  async listByOrg(orgId: string): Promise<ProjectRecord[]> {
    return this.db.project.findMany({ where: { orgId, deletedAt: null }, orderBy: { createdAt: "desc" } });
  }
  async listByIds(ids: string[], orgId: string): Promise<ProjectRecord[]> {
    if (ids.length === 0) return [];
    return this.db.project.findMany({
      where: { id: { in: ids }, orgId, deletedAt: null },
      orderBy: { createdAt: "desc" },
    });
  }
  async update(id: string, data: { name?: string; description?: string | null }): Promise<ProjectRecord> {
    return this.db.project.update({ where: { id }, data: { name: data.name, description: data.description } });
  }
  async softDeleteWithTasks(id: string, batchId: string): Promise<void> {
    const now = new Date();
    await this.db.$transaction([
      this.db.project.update({ where: { id }, data: { deletedAt: now, deletionBatchId: batchId } }),
      this.db.task.updateMany({
        where: { projectId: id, deletedAt: null },
        data: { deletedAt: now, deletionBatchId: batchId },
      }),
      // Cascata para os Projetos (engagements) do cliente — senão ficam órfãos ativos. [review arq ALTO 1]
      this.db.engagement.updateMany({
        where: { projectId: id, deletedAt: null },
        data: { deletedAt: now, deletionBatchId: batchId },
      }),
    ]);
  }
}

export class PrismaProjectAccessRepo implements ProjectAccessRepo {
  constructor(private readonly db: PrismaClient) {}

  async isMember(userId: string, projectId: string): Promise<boolean> {
    const m = await this.db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    return m !== null;
  }
  async listAccessibleProjectIds(userId: string): Promise<string[]> {
    const rows = await this.db.projectMember.findMany({ where: { userId }, select: { projectId: true } });
    return rows.map((r) => r.projectId);
  }
  async grant(projectId: string, userId: string): Promise<void> {
    await this.db.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId },
      update: {},
    });
  }
  async revoke(projectId: string, userId: string): Promise<void> {
    await this.db.projectMember.deleteMany({ where: { projectId, userId } });
  }
  async listMembers(projectId: string): Promise<ProjectMemberView[]> {
    const rows = await this.db.projectMember.findMany({
      where: { projectId, user: { deletedAt: null } },
      select: { user: { select: { id: true, name: true } } },
      orderBy: { user: { name: "asc" } },
    });
    return rows.map((r) => ({ id: r.user.id, name: r.user.name }));
  }
  async nullAssigneesInProject(projectId: string, userId: string): Promise<void> {
    await this.db.task.updateMany({ where: { projectId, assigneeId: userId }, data: { assigneeId: null } });
  }
  async userExistsInOrg(userId: string, orgId: string): Promise<boolean> {
    const u = await this.db.user.findFirst({ where: { id: userId, orgId, deletedAt: null } });
    return u !== null;
  }
}
