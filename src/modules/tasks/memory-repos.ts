import { randomUUID } from "node:crypto";
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

function applyFilters(list: TaskRecord[], f: TaskFilterOpts): TaskRecord[] {
  return list.filter(
    (t) =>
      (!f.status || t.status === f.status) &&
      (!f.priority || t.priority === f.priority) &&
      // filtro por responsável casa principal OU extra [detalhe-tarefa RF-R9]
      (!f.assigneeId || t.assigneeId === f.assigneeId || t.extraAssigneeIds.includes(f.assigneeId)),
  );
}
function sortAndPage(list: TaskRecord[], f: TaskFilterOpts): TaskRecord[] {
  const sorted = [...list].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  return f.limit ? sorted.slice(0, f.limit) : sorted;
}
/** cópia defensiva incluindo o array de extras (evita aliasing entre chamadas). */
function clone(t: TaskRecord): TaskRecord {
  return { ...t, extraAssigneeIds: [...t.extraAssigneeIds] };
}

export class InMemoryTaskRepo implements TaskRepo {
  private byId = new Map<string, TaskRecord>();

  async create(t: NewTask): Promise<TaskRecord> {
    const now = new Date();
    const rec: TaskRecord = {
      id: randomUUID(),
      orgId: t.orgId,
      projectId: t.projectId,
      engagementId: t.engagementId,
      title: t.title,
      description: t.description ?? null,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate ?? null,
      assigneeId: t.assigneeId ?? null,
      extraAssigneeIds: [],
      estimatedMinutes: t.estimatedMinutes ?? null,
      position: t.position,
      createdById: t.createdById,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(rec.id, rec);
    return clone(rec);
  }
  async findById(id: string, orgId: string): Promise<TaskRecord | null> {
    const t = this.byId.get(id);
    return t && t.orgId === orgId && !t.deletedAt ? clone(t) : null;
  }
  async listByProject(projectId: string, orgId: string, f: TaskFilterOpts): Promise<TaskRecord[]> {
    const list = [...this.byId.values()].filter(
      (t) => t.projectId === projectId && t.orgId === orgId && !t.deletedAt,
    );
    return sortAndPage(applyFilters(list, f), f).map(clone);
  }
  async listByEngagement(engagementId: string, orgId: string, f: TaskFilterOpts): Promise<TaskRecord[]> {
    const list = [...this.byId.values()].filter(
      (t) => t.engagementId === engagementId && t.orgId === orgId && !t.deletedAt,
    );
    return sortAndPage(applyFilters(list, f), f).map(clone);
  }
  async listMine(
    userId: string,
    projectIds: string[] | "all",
    orgId: string,
    f: TaskFilterOpts,
  ): Promise<TaskRecord[]> {
    // "minhas" = principal OU extra [detalhe-tarefa RF-R9]; ignora f.assigneeId (é a lista do próprio) [SEC-502]
    const mineFilter: TaskFilterOpts = { status: f.status, priority: f.priority, limit: f.limit };
    const list = [...this.byId.values()].filter(
      (t) =>
        t.orgId === orgId &&
        !t.deletedAt &&
        (t.assigneeId === userId || t.extraAssigneeIds.includes(userId)) &&
        (projectIds === "all" || projectIds.includes(t.projectId)),
    );
    return sortAndPage(applyFilters(list, mineFilter), mineFilter).map(clone);
  }
  async listAll(scope: string[] | "all", orgId: string, f: TaskFilterOpts): Promise<ListAllResult> {
    const from = f.dueFrom ? new Date(f.dueFrom).getTime() : null;
    const to = f.dueTo ? new Date(f.dueTo).getTime() : null;
    const list = [...this.byId.values()].filter((t) => {
      if (t.orgId !== orgId || t.deletedAt) return false; // orgId sempre cerca o tenant [RF-A3]
      if (scope !== "all" && !scope.includes(t.projectId)) return false; // escopo acessível [RF-A4]
      if (f.projectId && t.projectId !== f.projectId) return false; // Cliente (intersecta)
      if (f.engagementId && t.engagementId !== f.engagementId) return false; // Projeto
      if (f.priority && t.priority !== f.priority) return false;
      if (f.assigneeId && !(t.assigneeId === f.assigneeId || t.extraAssigneeIds.includes(f.assigneeId))) return false;
      if (f.status) {
        if (t.status !== f.status) return false;
      } else if (!f.includeDone && t.status === "DONE") {
        return false; // default oculta Concluídas [decisão JP]
      }
      if (from != null || to != null) {
        if (t.dueDate == null) return false; // range de prazo exclui sem-prazo (igual ao Prisma gte/lte)
        const d = t.dueDate.getTime();
        if (from != null && d < from) return false;
        if (to != null && d > to) return false;
      }
      return true;
    });
    const sorted = list.sort((a, b) => {
      const da = a.dueDate ? a.dueDate.getTime() : Infinity; // sem-prazo por último [RF-A7]
      const db = b.dueDate ? b.dueDate.getTime() : Infinity;
      return da - db || (a.id < b.id ? -1 : 1);
    });
    const cap = f.limit ?? 500;
    return { tasks: sorted.slice(0, cap).map(clone), hasMore: sorted.length > cap };
  }
  async update(id: string, patch: TaskPatch): Promise<TaskRecord> {
    const t = this.byId.get(id);
    if (!t) throw new Error("not found");
    if (patch.title !== undefined) t.title = patch.title;
    if (patch.description !== undefined) t.description = patch.description;
    if (patch.status !== undefined) t.status = patch.status;
    if (patch.priority !== undefined) t.priority = patch.priority;
    if (patch.dueDate !== undefined) t.dueDate = patch.dueDate;
    if (patch.estimatedMinutes !== undefined) t.estimatedMinutes = patch.estimatedMinutes;
    t.updatedAt = new Date();
    return clone(t);
  }
  async move(id: string, status: TaskRecord["status"], position: number): Promise<TaskRecord> {
    const t = this.byId.get(id);
    if (!t) throw new Error("not found");
    t.status = status;
    t.position = position;
    t.updatedAt = new Date();
    return clone(t);
  }
  async softDelete(id: string): Promise<void> {
    const t = this.byId.get(id);
    if (t) t.deletedAt = new Date();
  }
  async maxPositionByEngagement(engagementId: string, status: TaskRecord["status"]): Promise<number> {
    const ps = [...this.byId.values()]
      .filter((t) => t.engagementId === engagementId && t.status === status && !t.deletedAt)
      .map((t) => t.position);
    return ps.length ? Math.max(...ps) : 0;
  }

  private get(taskId: string, orgId: string): TaskRecord | undefined {
    const t = this.byId.get(taskId);
    return t && t.orgId === orgId ? t : undefined; // orgId sempre no "WHERE" [SEC-A04]
  }
  async addExtraAssignee(taskId: string, userId: string, orgId: string): Promise<void> {
    const t = this.get(taskId, orgId);
    if (t && !t.extraAssigneeIds.includes(userId)) t.extraAssigneeIds.push(userId); // ordem = createdAt
  }
  async removeExtraAssignee(taskId: string, userId: string, orgId: string): Promise<void> {
    const t = this.get(taskId, orgId);
    if (t) t.extraAssigneeIds = t.extraAssigneeIds.filter((u) => u !== userId);
  }
  async promoteToPrimary(taskId: string, userId: string, orgId: string): Promise<void> {
    const t = this.get(taskId, orgId);
    if (!t) return;
    t.extraAssigneeIds = t.extraAssigneeIds.filter((u) => u !== userId);
    if (t.assigneeId && t.assigneeId !== userId && !t.extraAssigneeIds.includes(t.assigneeId)) {
      t.extraAssigneeIds.push(t.assigneeId);
    }
    t.assigneeId = userId;
    t.updatedAt = new Date();
  }
  async clearPrimaryPromotingOldest(taskId: string, orgId: string): Promise<void> {
    const t = this.get(taskId, orgId);
    if (!t) return;
    const next = t.extraAssigneeIds[0] ?? null; // mais antigo = primeiro inserido
    if (next) t.extraAssigneeIds = t.extraAssigneeIds.filter((u) => u !== next);
    t.assigneeId = next;
    t.updatedAt = new Date();
  }
}

// Relógio monotônico compartilhado: garante createdAt estritamente crescente entre atividade e
// comentários no in-memory (em prod os timestamps já diferem por request). Ordem = inserção.
let lastTs = 0;
function monoNow(): Date {
  lastTs = Math.max(Date.now(), lastTs + 1);
  return new Date(lastTs);
}

/** keyset por fonte (createdAt desc, rank(src) desc, id desc), com `< before`. Espelha o Prisma. [review C1 #2] */
function keysetDesc<T extends { createdAt: Date; id: string }>(
  rows: T[],
  before: FeedCursor | null,
  limit: number,
  mySrc: "a" | "c",
): T[] {
  const sorted = [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : -1));
  if (!before) return sorted.slice(0, limit);
  const bRank = before.src === "a" ? 1 : 0;
  const myRank = mySrc === "a" ? 1 : 0;
  const filtered = sorted.filter((r) => {
    const t = r.createdAt.getTime();
    const bt = before.createdAt.getTime();
    if (t < bt) return true;
    if (t > bt) return false;
    if (myRank === bRank) return r.id < before.id;
    return myRank < bRank; // mesmo ms: minha fonte vem depois (inclui) ou antes (exclui) do cursor
  });
  return filtered.slice(0, limit);
}

export class InMemoryActivityRepo implements ActivityRepo {
  private items: ActivityRecord[] = [];
  private names = new Map<string, string>();
  private counter = 0;

  /** registra nome pra snapshot nos testes (opcional). */
  setName(userId: string, name: string): this {
    this.names.set(userId, name);
    return this;
  }

  async record(a: NewActivity): Promise<void> {
    // snapshot do nome do alvo (payload.userId) — espelha o Prisma repo. [review #2]
    let payload = a.payload;
    const targetId = typeof a.payload.userId === "string" ? a.payload.userId : null;
    if (targetId && typeof a.payload.name !== "string" && this.names.has(targetId)) {
      payload = { ...a.payload, name: this.names.get(targetId) };
    }
    this.items.push({
      id: `a${String(this.counter++).padStart(12, "0")}`, // id monotônico → ordem estável no mesmo ms
      taskId: a.taskId,
      actorId: a.actorId,
      actorName: this.names.get(a.actorId) ?? a.actorId,
      type: a.type,
      payload,
      createdAt: monoNow(),
    });
  }

  async listSince(taskId: string, orgId: string, before: FeedCursor | null, limit: number): Promise<ActivityRecord[]> {
    void orgId;
    return keysetDesc(this.items.filter((i) => i.taskId === taskId), before, limit, "a");
  }
}

export class InMemoryCommentRepo implements CommentRepo {
  private items = new Map<string, CommentRecord>();
  private names = new Map<string, string>();
  private counter = 0;

  setName(userId: string, name: string): this {
    this.names.set(userId, name);
    return this;
  }

  async create(c: NewComment): Promise<CommentRecord> {
    const rec: CommentRecord = {
      id: `c${String(this.counter++).padStart(12, "0")}`,
      taskId: c.taskId,
      orgId: c.orgId,
      authorId: c.authorId,
      authorName: this.names.get(c.authorId) ?? c.authorId,
      body: c.body,
      createdAt: monoNow(),
      editedAt: null,
      deletedAt: null,
    };
    this.items.set(rec.id, rec);
    return { ...rec };
  }
  async findById(id: string, orgId: string): Promise<CommentRecord | null> {
    const c = this.items.get(id);
    return c && c.orgId === orgId ? { ...c } : null;
  }
  async update(id: string, taskId: string, orgId: string, body: string): Promise<CommentRecord> {
    const c = this.items.get(id);
    if (!c || c.orgId !== orgId || c.taskId !== taskId) throw new Error("not found");
    c.body = body;
    c.editedAt = new Date();
    return { ...c };
  }
  async softDelete(id: string, taskId: string, orgId: string): Promise<void> {
    const c = this.items.get(id);
    if (c && c.orgId === orgId && c.taskId === taskId) c.deletedAt = new Date();
  }
  async listSince(taskId: string, orgId: string, before: FeedCursor | null, limit: number): Promise<CommentRecord[]> {
    void orgId;
    return keysetDesc([...this.items.values()].filter((i) => i.taskId === taskId), before, limit, "c");
  }
}

export class InMemorySubtaskRepo implements SubtaskRepo {
  private byId = new Map<string, SubtaskRecord>();

  async create(taskId: string, title: string, position: number): Promise<SubtaskRecord> {
    const rec: SubtaskRecord = { id: randomUUID(), taskId, title, done: false, position, createdAt: new Date() };
    this.byId.set(rec.id, rec);
    return { ...rec };
  }
  async listByTask(taskId: string): Promise<SubtaskRecord[]> {
    return [...this.byId.values()].filter((s) => s.taskId === taskId).sort((a, b) => a.position - b.position);
  }
  async findTaskId(subtaskId: string): Promise<string | null> {
    return this.byId.get(subtaskId)?.taskId ?? null;
  }
  async update(id: string, patch: { title?: string; done?: boolean }): Promise<SubtaskRecord> {
    const s = this.byId.get(id);
    if (!s) throw new Error("not found");
    if (patch.title !== undefined) s.title = patch.title;
    if (patch.done !== undefined) s.done = patch.done;
    return { ...s };
  }
  async remove(id: string): Promise<void> {
    this.byId.delete(id);
  }
  async maxPosition(taskId: string): Promise<number> {
    const ps = [...this.byId.values()].filter((s) => s.taskId === taskId).map((s) => s.position);
    return ps.length ? Math.max(...ps) : 0;
  }
}
