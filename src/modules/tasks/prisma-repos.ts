import type { PrismaClient, Prisma } from "@prisma/client";
import type { TaskStatus, TaskPriority } from "@sistema-tasks/contracts";
import type {
  ActivityRecord,
  ActivityRepo,
  CommentRecord,
  CommentRepo,
  FeedCursor,
  ListAllResult,
  NewActivity,
  NewComment,
  NewTask,
  SubtaskRecord,
  SubtaskRepo,
  TaskFilterOpts,
  TaskPatch,
  TaskRecord,
  TaskRepo,
} from "./types.js";

/**
 * keyset por fonte: ordem total (createdAt desc, rank(src) desc, id desc). Como cada tabela é uma fonte fixa,
 * o filtro `< before` no mesmo ms depende do rank da fonte do cursor vs a desta tabela. [review C1 #2]
 */
function beforeWhereForSource(before: FeedCursor | null, mySrc: "a" | "c") {
  if (!before) return {};
  const bRank = before.src === "a" ? 1 : 0;
  const myRank = mySrc === "a" ? 1 : 0;
  if (myRank === bRank) {
    return { OR: [{ createdAt: { lt: before.createdAt } }, { createdAt: before.createdAt, id: { lt: before.id } }] };
  }
  if (myRank < bRank) return { createdAt: { lte: before.createdAt } }; // no mesmo ms vêm DEPOIS do cursor
  return { createdAt: { lt: before.createdAt } }; // no mesmo ms vêm ANTES (já mostrados)
}

type PrismaTask = {
  id: string; orgId: string; projectId: string; engagementId: string; title: string; description: string | null;
  status: string; priority: string; dueDate: Date | null; assigneeId: string | null;
  estimatedMinutes: number | null;
  position: number; createdById: string; deletedAt: Date | null; createdAt: Date; updatedAt: Date;
  extraAssignees?: { userId: string }[];
};
function toTask(t: PrismaTask): TaskRecord {
  return {
    ...t,
    status: t.status as TaskStatus,
    priority: t.priority as TaskPriority,
    extraAssigneeIds: (t.extraAssignees ?? []).map((a) => a.userId),
  };
}
/** include padrão p/ trazer os responsáveis extras junto da tarefa. [detalhe-tarefa A1] */
const withExtras = { extraAssignees: { select: { userId: true } } } as const;
function whereFilters(f: TaskFilterOpts): Prisma.TaskWhereInput {
  return {
    ...(f.status ? { status: f.status } : {}),
    ...(f.priority ? { priority: f.priority } : {}),
    // filtro por responsável casa principal OU extra [detalhe-tarefa RF-R9]
    ...(f.assigneeId
      ? { OR: [{ assigneeId: f.assigneeId }, { extraAssignees: { some: { userId: f.assigneeId } } }] }
      : {}),
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
      include: withExtras,
    });
    return toTask(created);
  }
  async findById(id: string, orgId: string): Promise<TaskRecord | null> {
    const t = await this.db.task.findFirst({ where: { id, orgId, deletedAt: null }, include: withExtras });
    return t ? toTask(t) : null;
  }
  async listByProject(projectId: string, orgId: string, f: TaskFilterOpts): Promise<TaskRecord[]> {
    // orgId no WHERE fecha cross-org mesmo se assertProjectAccess liberar por acesso_todos. [SEC-004/SEC-001]
    const rows = await this.db.task.findMany({
      where: { projectId, orgId, deletedAt: null, ...whereFilters(f) },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      take: f.limit ?? 100,
      include: withExtras,
    });
    return rows.map(toTask);
  }
  async listByEngagement(engagementId: string, orgId: string, f: TaskFilterOpts): Promise<TaskRecord[]> {
    const rows = await this.db.task.findMany({
      where: { engagementId, orgId, deletedAt: null, ...whereFilters(f) },
      orderBy: [{ position: "asc" }, { id: "asc" }],
      take: f.limit ?? 100,
      include: withExtras,
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
        ...(f.status ? { status: f.status } : {}),
        ...(f.priority ? { priority: f.priority } : {}),
        // "minhas" = principal OU extra. AND separado do restante: nenhum filtro de query alarga o dono [SEC-502]
        OR: [{ assigneeId: userId }, { extraAssignees: { some: { userId } } }],
      },
      orderBy: [{ dueDate: "asc" }, { id: "asc" }],
      take: f.limit ?? 100,
      include: withExtras,
    });
    return rows.map(toTask);
  }
  async listAll(scope: string[] | "all", orgId: string, f: TaskFilterOpts): Promise<ListAllResult> {
    // Composição por AND explícito: escopo (projectId IN) e filtro-cliente (projectId =) não podem
    // colidir na mesma chave; o OR de responsável fica isolado no seu próprio elemento. [tarefas-visao-global RF-A4/A5]
    const and: Prisma.TaskWhereInput[] = [];
    if (scope !== "all") and.push({ projectId: { in: scope } }); // escopo acessível — filtro intersecta, nunca substitui
    if (f.projectId) and.push({ projectId: f.projectId }); // Cliente
    if (f.engagementId) and.push({ engagementId: f.engagementId }); // Projeto
    if (f.dueFrom || f.dueTo) {
      and.push({
        dueDate: {
          ...(f.dueFrom ? { gte: new Date(f.dueFrom) } : {}),
          ...(f.dueTo ? { lte: new Date(f.dueTo) } : {}),
        },
      });
    }
    if (f.status) and.push({ status: f.status });
    else if (!f.includeDone) and.push({ status: { not: "DONE" } }); // default oculta Concluídas [decisão JP]
    if (f.priority) and.push({ priority: f.priority });
    if (f.assigneeId) {
      and.push({ OR: [{ assigneeId: f.assigneeId }, { extraAssignees: { some: { userId: f.assigneeId } } }] });
    }
    const cap = f.limit ?? 500;
    const rows = await this.db.task.findMany({
      where: { orgId, deletedAt: null, ...(and.length ? { AND: and } : {}) }, // orgId sempre cerca o tenant [RF-A3]
      orderBy: [{ dueDate: { sort: "asc", nulls: "last" } }, { id: "asc" }], // total, determinística [RF-A7]
      take: cap + 1, // +1 detecta truncamento sem cursor
      include: withExtras,
    });
    const hasMore = rows.length > cap;
    return { tasks: rows.slice(0, cap).map(toTask), hasMore };
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
        estimatedMinutes: patch.estimatedMinutes,
      },
      include: withExtras,
    });
    return toTask(updated);
  }
  async move(id: string, status: TaskStatus, position: number): Promise<TaskRecord> {
    const updated = await this.db.task.update({ where: { id }, data: { status, position }, include: withExtras });
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

  async addExtraAssignee(taskId: string, userId: string, orgId: string): Promise<void> {
    // idempotente: se já existe, não duplica
    await this.db.taskAssignee.upsert({
      where: { taskId_userId: { taskId, userId } },
      create: { taskId, userId, orgId },
      update: {},
    });
  }
  async removeExtraAssignee(taskId: string, userId: string, orgId: string): Promise<void> {
    await this.db.taskAssignee.deleteMany({ where: { taskId, userId, orgId } });
  }
  async promoteToPrimary(taskId: string, userId: string, orgId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const task = await tx.task.findFirst({ where: { id: taskId, orgId }, select: { assigneeId: true } });
      if (!task) return;
      // userId sai dos extras
      await tx.taskAssignee.deleteMany({ where: { taskId, userId, orgId } });
      // principal atual (se houver e diferente) vira extra
      if (task.assigneeId && task.assigneeId !== userId) {
        await tx.taskAssignee.upsert({
          where: { taskId_userId: { taskId, userId: task.assigneeId } },
          create: { taskId, userId: task.assigneeId, orgId },
          update: {},
        });
      }
      await tx.task.updateMany({ where: { id: taskId, orgId }, data: { assigneeId: userId } });
    });
  }
  async clearPrimaryPromotingOldest(taskId: string, orgId: string): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const oldest = await tx.taskAssignee.findFirst({
        where: { taskId, orgId },
        orderBy: [{ createdAt: "asc" }, { userId: "asc" }],
        select: { userId: true },
      });
      const newPrimary = oldest?.userId ?? null;
      if (newPrimary) await tx.taskAssignee.deleteMany({ where: { taskId, userId: newPrimary, orgId } });
      await tx.task.updateMany({ where: { id: taskId, orgId }, data: { assigneeId: newPrimary } });
    });
  }
}

type PrismaActivity = {
  id: string; taskId: string; actorId: string; actorName: string; type: string;
  payload: unknown; createdAt: Date;
};
function toActivity(a: PrismaActivity): ActivityRecord {
  return {
    id: a.id, taskId: a.taskId, actorId: a.actorId, actorName: a.actorName, type: a.type,
    payload: (a.payload ?? {}) as Record<string, unknown>, createdAt: a.createdAt,
  };
}

export class PrismaActivityRepo implements ActivityRepo {
  constructor(private readonly db: PrismaClient) {}

  async record(a: NewActivity): Promise<void> {
    // snapshot do nome do ator (sobrevive a remoção/renome do usuário). [detalhe-tarefa RF-A4]
    const u = await this.db.user.findUnique({ where: { id: a.actorId }, select: { name: true } });
    // snapshot também do ALVO (payload.userId) — evita "sem acesso" pra quem saiu depois. [review #2]
    let payload = a.payload;
    const targetId = typeof a.payload.userId === "string" ? a.payload.userId : null;
    if (targetId && typeof a.payload.name !== "string") {
      const target = await this.db.user.findUnique({ where: { id: targetId }, select: { name: true } });
      if (target?.name) payload = { ...a.payload, name: target.name };
    }
    await this.db.taskActivity.create({
      data: {
        taskId: a.taskId,
        orgId: a.orgId,
        actorId: a.actorId,
        actorName: u?.name ?? a.actorId,
        type: a.type,
        payload: payload as Prisma.InputJsonValue,
      },
    });
  }

  async listSince(taskId: string, orgId: string, before: FeedCursor | null, limit: number): Promise<ActivityRecord[]> {
    const rows = await this.db.taskActivity.findMany({
      where: { taskId, orgId, ...beforeWhereForSource(before, "a") }, // orgId no WHERE — cross-org [SEC-102]
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
    return rows.map(toActivity);
  }
}

type PrismaComment = {
  id: string; taskId: string; orgId: string; authorId: string; authorName: string; body: string;
  createdAt: Date; editedAt: Date | null; deletedAt: Date | null;
};

export class PrismaCommentRepo implements CommentRepo {
  constructor(private readonly db: PrismaClient) {}

  async create(c: NewComment): Promise<CommentRecord> {
    const u = await this.db.user.findUnique({ where: { id: c.authorId }, select: { name: true } });
    return this.db.taskComment.create({
      data: { taskId: c.taskId, orgId: c.orgId, authorId: c.authorId, authorName: u?.name ?? c.authorId, body: c.body },
    });
  }
  async findById(id: string, orgId: string): Promise<CommentRecord | null> {
    return this.db.taskComment.findFirst({ where: { id, orgId } });
  }
  async update(id: string, taskId: string, orgId: string, body: string): Promise<CommentRecord> {
    // updateMany p/ escopar id+taskId+orgId; depois relê. [SEC-A04/C1-004]
    await this.db.taskComment.updateMany({ where: { id, taskId, orgId }, data: { body, editedAt: new Date() } });
    return (await this.db.taskComment.findFirst({ where: { id, orgId } })) as PrismaComment;
  }
  async softDelete(id: string, taskId: string, orgId: string): Promise<void> {
    await this.db.taskComment.updateMany({ where: { id, taskId, orgId }, data: { deletedAt: new Date() } });
  }
  async listSince(taskId: string, orgId: string, before: FeedCursor | null, limit: number): Promise<CommentRecord[]> {
    return this.db.taskComment.findMany({
      where: { taskId, orgId, ...beforeWhereForSource(before, "c") },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    });
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
