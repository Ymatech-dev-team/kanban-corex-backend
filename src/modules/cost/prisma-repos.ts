import type { PrismaClient } from "@prisma/client";
import type { TaskStatus } from "@sistema-tasks/contracts";
import { DEFAULT_MONTHLY_HOURS, type CostRepo, type CostRow, type OrgRepo } from "./types.js";

type TaskWithAssignee = {
  id: string;
  projectId?: string;
  status: string;
  estimatedMinutes: number | null;
  assigneeId: string | null;
  assignee: {
    id: string;
    name: string;
    deletedAt: Date | null;
    compensationType: string | null;
    compensationCents: number | null;
  } | null;
};

function toRow(t: TaskWithAssignee, isMember: boolean): CostRow {
  const a = t.assignee;
  const alive = !!a && a.deletedAt === null; // usuário soft-deleted não conta [RF-32]
  return {
    taskId: t.id,
    status: t.status as TaskStatus,
    estimatedMinutes: t.estimatedMinutes,
    assigneeId: t.assigneeId ?? null,
    assigneeName: alive ? a!.name : null,
    compType: alive ? a!.compensationType : null,
    compCents: alive ? a!.compensationCents : null,
    assigneeIsMember: alive ? isMember : false,
  };
}

const SELECT = {
  id: true,
  status: true,
  estimatedMinutes: true,
  assigneeId: true,
  assignee: {
    select: { id: true, name: true, deletedAt: true, compensationType: true, compensationCents: true },
  },
} as const;

export class PrismaOrgRepo implements OrgRepo {
  constructor(private readonly db: PrismaClient) {}
  async getMonthlyHours(orgId: string): Promise<number> {
    const o = await this.db.organization.findUnique({ where: { id: orgId }, select: { monthlyHours: true } });
    return o?.monthlyHours ?? DEFAULT_MONTHLY_HOURS;
  }
}

export class PrismaCostRepo implements CostRepo {
  constructor(private readonly db: PrismaClient) {}

  // Fonte única: carrega as tarefas do WHERE + resolve membership pelo Cliente (projectId).
  // "Membro" ESPELHA ProjectAccessRepo.isMember (mesma tabela/chave projectId_userId); se a definição
  // de acesso mudar no authz, atualizar junto — senão RESPONSAVEL_SEM_ACESSO mente. [SEC-004/M1]
  private async costRows(
    where: { projectId: string; orgId: string; engagementId?: string },
  ): Promise<CostRow[]> {
    const tasks = await this.db.task.findMany({ where: { ...where, deletedAt: null }, select: SELECT });
    const members = await this.db.projectMember.findMany({
      where: { projectId: where.projectId },
      select: { userId: true },
    });
    const memberIds = new Set(members.map((m) => m.userId));
    return tasks.map((t) => toRow(t, t.assigneeId ? memberIds.has(t.assigneeId) : false));
  }

  async projectCostRows(projectId: string, orgId: string): Promise<CostRow[]> {
    return this.costRows({ projectId, orgId });
  }

  async engagementCostRows(engagementId: string, projectId: string, orgId: string): Promise<CostRow[]> {
    // Custo de UM projeto: tarefas do engagement (membership continua no nível Cliente). [RF-52]
    return this.costRows({ projectId, orgId, engagementId });
  }

  async taskCostRow(taskId: string, orgId: string): Promise<(CostRow & { projectId: string }) | null> {
    const t = await this.db.task.findFirst({
      where: { id: taskId, orgId, deletedAt: null },
      select: { ...SELECT, projectId: true },
    });
    if (!t) return null;
    const isMember = t.assigneeId
      ? (await this.db.projectMember.findUnique({
          where: { projectId_userId: { projectId: t.projectId, userId: t.assigneeId } },
        })) !== null
      : false;
    return { ...toRow(t, isMember), projectId: t.projectId };
  }
}
