import { randomUUID } from "node:crypto";
import type {
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
