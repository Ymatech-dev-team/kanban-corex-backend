import type { PrismaClient, Prisma } from "@prisma/client";
import type { TaskStatus, TaskPriority } from "@sistema-tasks/contracts";
import type {
  NewTask,
  SubtaskRecord,
  SubtaskRepo,
  TaskFilterOpts,
  TaskPatch,
  TaskRecord,
  TaskRepo,
} from "./types.js";

type PrismaTask = {
  id: string; orgId: string; projectId: string; engagementId: string; title: string; description: string | null;
  status: string; priority: string; dueDate: Date | null; assigneeId: string | null;
  estimatedMinutes: number | null;
  position: number; createdById: string; deletedAt: Date | null; createdAt: Date; updatedAt: Date;
};
function toTask(t: PrismaTask): TaskRecord {
  return { ...t, status: t.status as TaskStatus, priority: t.priority as TaskPriority };
}
function whereFilters(f: TaskFilterOpts): Prisma.TaskWhereInput {
  return {
    ...(f.status ? { status: f.status } : {}),
    ...(f.priority ? { priority: f.priority } : {}),
    ...(f.assigneeId ? { assigneeId: f.assigneeId } : {}),
  };
}

export class PrismaTaskRepo implements TaskRepo {
  constructor(private readonly db: PrismaClient) {}

  async create(t: NewTask): Promise<TaskRecord> {
    const created = await this.db.task.create({
      data: {
        orgId: t.orgId,
        projectId: t.projectId,
        engagementId: t.engagementId,
        title: t.title,
        description: t.description ?? null,
        status: t.status,
        priority: t.priority,
        dueDate: t.dueDate ?? null,
        assigneeId: t.assigneeId ?? null,
        estimatedMinutes: t.estimatedMinutes ?? null,
        position: t.position,
        createdById: t.createdById,
      },
    });
    return toTask(created);
  }
  async findById(id: string, orgId: string): Promise<TaskRecord | null> {
    const t = await this.db.task.findFirst({ where: { id, orgId, deletedAt: null } });
    return t ? toTask(t) : null;
  }
  async listByProject(projectId: string, orgId: string, f: TaskFilterOpts): Promise<TaskRecord[]> {
    // orgId no WHERE fecha cross-org mesmo se assertProjectAccess liberar por acesso_todos. [SEC-004/SEC-001]
    const rows = await this.db.task.findMany({
      where: { projectId, orgId, deletedAt: null, ...whereFilters(f) },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      take: f.limit ?? 100,
    });
    return rows.map(toTask);
  }
  async listByEngagement(engagementId: string, orgId: string, f: TaskFilterOpts): Promise<TaskRecord[]> {
    const rows = await this.db.task.findMany({
      where: { engagementId, orgId, deletedAt: null, ...whereFilters(f) },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      take: f.limit ?? 100,
    });
    return rows.map(toTask);
  }
  async listMine(
    userId: string,
    projectIds: string[] | "all",
    orgId: string,
    f: TaskFilterOpts,
  ): Promise<TaskRecord[]> {
    const rows = await this.db.task.findMany({
      where: {
        orgId,
        deletedAt: null,
        ...(projectIds === "all" ? {} : { projectId: { in: projectIds } }),
        ...whereFilters(f),
        assigneeId: userId, // pin por ÚLTIMO — filtro de query não sobrescreve o dono [SEC-502]
      },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: f.limit ?? 100,
    });
    return rows.map(toTask);
  }
  async update(id: string, patch: TaskPatch): Promise<TaskRecord> {
    const updated = await this.db.task.update({
      where: { id },
      data: {
        title: patch.title,
        description: patch.description,
        status: patch.status,
        priority: patch.priority,
        dueDate: patch.dueDate,
        assigneeId: patch.assigneeId,
        estimatedMinutes: patch.estimatedMinutes,
      },
    });
    return toTask(updated);
  }
  async move(id: string, status: TaskStatus, position: number): Promise<TaskRecord> {
    const updated = await this.db.task.update({ where: { id }, data: { status, position } });
    return toTask(updated);
  }
  async softDelete(id: string): Promise<void> {
    await this.db.task.update({ where: { id }, data: { deletedAt: new Date() } });
  }
  async maxPositionByEngagement(engagementId: string, status: TaskStatus): Promise<number> {
    const agg = await this.db.task.aggregate({
      where: { engagementId, status, deletedAt: null },
      _max: { position: true },
    });
    return agg._max.position ?? 0;
  }
}

export class PrismaSubtaskRepo implements SubtaskRepo {
  constructor(private readonly db: PrismaClient) {}

  async create(taskId: string, title: string, position: number): Promise<SubtaskRecord> {
    return this.db.subtask.create({ data: { taskId, title, position } });
  }
  async listByTask(taskId: string): Promise<SubtaskRecord[]> {
    return this.db.subtask.findMany({ where: { taskId }, orderBy: { position: "asc" } });
  }
  async findTaskId(subtaskId: string): Promise<string | null> {
    const s = await this.db.subtask.findUnique({ where: { id: subtaskId }, select: { taskId: true } });
    return s?.taskId ?? null;
  }
  async update(id: string, patch: { title?: string; done?: boolean }): Promise<SubtaskRecord> {
    return this.db.subtask.update({ where: { id }, data: { title: patch.title, done: patch.done } });
  }
  async remove(id: string): Promise<void> {
    await this.db.subtask.delete({ where: { id } });
  }
  async maxPosition(taskId: string): Promise<number> {
    const agg = await this.db.subtask.aggregate({ where: { taskId }, _max: { position: true } });
    return agg._max.position ?? 0;
  }
}
