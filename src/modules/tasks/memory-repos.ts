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
      (!f.assigneeId || t.assigneeId === f.assigneeId),
  );
}
function sortAndPage(list: TaskRecord[], f: TaskFilterOpts): TaskRecord[] {
  const sorted = [...list].sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1));
  return f.limit ? sorted.slice(0, f.limit) : sorted;
}

export class InMemoryTaskRepo implements TaskRepo {
  private byId = new Map<string, TaskRecord>();

  async create(t: NewTask): Promise<TaskRecord> {
    const now = new Date();
    const rec: TaskRecord = {
      id: randomUUID(),
      orgId: t.orgId,
      projectId: t.projectId,
      title: t.title,
      description: t.description ?? null,
      status: t.status,
      priority: t.priority,
      dueDate: t.dueDate ?? null,
      assigneeId: t.assigneeId ?? null,
      position: t.position,
      createdById: t.createdById,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(rec.id, rec);
    return { ...rec };
  }
  async findById(id: string, orgId: string): Promise<TaskRecord | null> {
    const t = this.byId.get(id);
    return t && t.orgId === orgId && !t.deletedAt ? { ...t } : null;
  }
  async listByProject(projectId: string, f: TaskFilterOpts): Promise<TaskRecord[]> {
    const list = [...this.byId.values()].filter((t) => t.projectId === projectId && !t.deletedAt);
    return sortAndPage(applyFilters(list, f), f).map((t) => ({ ...t }));
  }
  async listMine(
    userId: string,
    projectIds: string[] | "all",
    orgId: string,
    f: TaskFilterOpts,
  ): Promise<TaskRecord[]> {
    const list = [...this.byId.values()].filter(
      (t) =>
        t.orgId === orgId &&
        !t.deletedAt &&
        t.assigneeId === userId &&
        (projectIds === "all" || projectIds.includes(t.projectId)),
    );
    return sortAndPage(applyFilters(list, f), f).map((t) => ({ ...t }));
  }
  async update(id: string, patch: TaskPatch): Promise<TaskRecord> {
    const t = this.byId.get(id);
    if (!t) throw new Error("not found");
    if (patch.title !== undefined) t.title = patch.title;
    if (patch.description !== undefined) t.description = patch.description;
    if (patch.status !== undefined) t.status = patch.status;
    if (patch.priority !== undefined) t.priority = patch.priority;
    if (patch.dueDate !== undefined) t.dueDate = patch.dueDate;
    if (patch.assigneeId !== undefined) t.assigneeId = patch.assigneeId;
    t.updatedAt = new Date();
    return { ...t };
  }
  async move(id: string, status: TaskRecord["status"], position: number): Promise<TaskRecord> {
    const t = this.byId.get(id);
    if (!t) throw new Error("not found");
    t.status = status;
    t.position = position;
    t.updatedAt = new Date();
    return { ...t };
  }
  async softDelete(id: string): Promise<void> {
    const t = this.byId.get(id);
    if (t) t.deletedAt = new Date();
  }
  async maxPosition(projectId: string, status: TaskRecord["status"]): Promise<number> {
    const ps = [...this.byId.values()]
      .filter((t) => t.projectId === projectId && t.status === status && !t.deletedAt)
      .map((t) => t.position);
    return ps.length ? Math.max(...ps) : 0;
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
