import type { PrismaClient } from "@prisma/client";
import type {
  EngagementListItem,
  EngagementMemberRepo,
  EngagementMemberView,
  EngagementRecord,
  EngagementRepo,
  NewEngagement,
} from "./types.js";
import { isGeneralEngagement } from "./general.js";

export class PrismaEngagementRepo implements EngagementRepo {
  constructor(private readonly db: PrismaClient) {}

  async create(e: NewEngagement, id?: string): Promise<EngagementRecord> {
    return this.db.engagement.create({
      data: {
        ...(id ? { id } : {}),
        orgId: e.orgId,
        projectId: e.projectId,
        name: e.name,
        description: e.description ?? null,
        createdById: e.createdById,
      },
    });
  }

  async findById(id: string, orgId: string): Promise<EngagementRecord | null> {
    return this.db.engagement.findFirst({ where: { id, orgId, deletedAt: null } });
  }

  async listByProject(projectId: string, orgId: string): Promise<EngagementListItem[]> {
    const rows = await this.db.engagement.findMany({
      where: { projectId, orgId, deletedAt: null },
      orderBy: { createdAt: "asc" },
    });
    // Contagens em uma passada (groupBy), evitando N+1.
    const taskGroups = await this.db.task.groupBy({
      by: ["engagementId"],
      where: { projectId, orgId, deletedAt: null },
      _count: { _all: true },
    });
    const taskByEng = new Map(taskGroups.map((g) => [g.engagementId, g._count._all]));
    // Ignora consultores soft-deletados para o count bater com a lista (que filtra user.deletedAt). [review correção]
    const memberGroups = await this.db.engagementMember.groupBy({
      by: ["engagementId"],
      where: { engagementId: { in: rows.map((r) => r.id) }, user: { deletedAt: null } },
      _count: { _all: true },
    });
    const memberByEng = new Map(memberGroups.map((g) => [g.engagementId, g._count._all]));
    return rows.map((r) => ({
      ...r,
      taskCount: taskByEng.get(r.id) ?? 0,
      consultorCount: memberByEng.get(r.id) ?? 0,
      isGeneral: isGeneralEngagement(r.id, r.projectId),
    }));
  }

  async update(id: string, data: { name?: string; description?: string | null }): Promise<EngagementRecord> {
    return this.db.engagement.update({ where: { id }, data: { name: data.name, description: data.description } });
  }

  async softDeleteWithTasks(id: string, batchId: string): Promise<void> {
    const now = new Date();
    await this.db.$transaction([
      this.db.engagement.update({ where: { id }, data: { deletedAt: now, deletionBatchId: batchId } }),
      this.db.task.updateMany({
        where: { engagementId: id, deletedAt: null },
        data: { deletedAt: now, deletionBatchId: batchId },
      }),
    ]);
  }

  async countActiveByProject(projectId: string, orgId: string): Promise<number> {
    return this.db.engagement.count({ where: { projectId, orgId, deletedAt: null } });
  }

  async findAnyById(
    id: string,
    orgId: string,
  ): Promise<{ id: string; projectId: string; deletedAt: Date | null; deletionBatchId: string | null } | null> {
    return this.db.engagement.findFirst({
      where: { id, orgId }, // SEM filtro deletedAt — pro undo
      select: { id: true, projectId: true, deletedAt: true, deletionBatchId: true },
    });
  }

  async restoreBatch(batchId: string, orgId: string): Promise<void> {
    await this.db.$transaction([
      this.db.engagement.updateMany({
        where: { orgId, deletionBatchId: batchId, deletedAt: { not: null } },
        data: { deletedAt: null, deletionBatchId: null },
      }),
      this.db.task.updateMany({
        where: { orgId, deletionBatchId: batchId, deletedAt: { not: null } },
        data: { deletedAt: null, deletionBatchId: null },
      }),
    ]);
  }

  async isProjectActive(projectId: string, orgId: string): Promise<boolean> {
    const p = await this.db.project.findFirst({ where: { id: projectId, orgId, deletedAt: null }, select: { id: true } });
    return p !== null;
  }
}

export class PrismaEngagementMemberRepo implements EngagementMemberRepo {
  constructor(private readonly db: PrismaClient) {}

  async add(engagementId: string, userId: string): Promise<void> {
    await this.db.engagementMember.upsert({
      where: { engagementId_userId: { engagementId, userId } },
      create: { engagementId, userId },
      update: {},
    });
  }
  async remove(engagementId: string, userId: string): Promise<void> {
    await this.db.engagementMember.deleteMany({ where: { engagementId, userId } });
  }
  async list(engagementId: string): Promise<EngagementMemberView[]> {
    const rows = await this.db.engagementMember.findMany({
      where: { engagementId, user: { deletedAt: null } },
      select: { user: { select: { id: true, name: true } } },
      orderBy: { user: { name: "asc" } },
    });
    return rows.map((r) => ({ id: r.user.id, name: r.user.name }));
  }
  async removeUserFromClientEngagements(projectId: string, userId: string, orgId: string): Promise<void> {
    await this.db.engagementMember.deleteMany({
      where: { userId, engagement: { projectId, orgId } }, // orgId no WHERE (defense-in-depth) [hardening T6]
    });
  }
  async nullAssigneesInEngagement(engagementId: string, userId: string, orgId: string): Promise<void> {
    await this.db.task.updateMany({ where: { engagementId, assigneeId: userId, orgId }, data: { assigneeId: null } });
  }
}
