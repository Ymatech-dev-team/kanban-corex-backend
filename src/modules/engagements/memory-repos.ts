import { randomUUID } from "node:crypto";
import type {
  EngagementListItem,
  EngagementMemberRepo,
  EngagementMemberView,
  EngagementRecord,
  EngagementRepo,
  NewEngagement,
} from "./types.js";
import { isGeneralEngagement } from "./general.js";

export class InMemoryEngagementRepo implements EngagementRepo {
  private byId = new Map<string, EngagementRecord>();
  private batch = new Map<string, string>(); // id -> deletionBatchId
  // contagens opcionais só pra teste (não obrigatórias)
  taskCounts = new Map<string, number>();
  consultorCounts = new Map<string, number>();

  seed(rec: EngagementRecord): this {
    this.byId.set(rec.id, rec);
    return this;
  }
  async create(e: NewEngagement, id?: string): Promise<EngagementRecord> {
    const now = new Date();
    const rec: EngagementRecord = {
      id: id ?? randomUUID(),
      orgId: e.orgId,
      projectId: e.projectId,
      name: e.name,
      description: e.description ?? null,
      createdById: e.createdById,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(rec.id, rec);
    return { ...rec };
  }
  async findById(id: string, orgId: string): Promise<EngagementRecord | null> {
    const e = this.byId.get(id);
    return e && e.orgId === orgId && !e.deletedAt ? { ...e } : null;
  }
  async listByProject(projectId: string, orgId: string): Promise<EngagementListItem[]> {
    return [...this.byId.values()]
      .filter((e) => e.projectId === projectId && e.orgId === orgId && !e.deletedAt)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((e) => ({
        ...e,
        taskCount: this.taskCounts.get(e.id) ?? 0,
        consultorCount: this.consultorCounts.get(e.id) ?? 0,
        isGeneral: isGeneralEngagement(e.id, e.projectId),
      }));
  }
  async update(id: string, data: { name?: string; description?: string | null }): Promise<EngagementRecord> {
    const e = this.byId.get(id);
    if (!e) throw new Error("not found");
    if (data.name !== undefined) e.name = data.name;
    if (data.description !== undefined) e.description = data.description;
    e.updatedAt = new Date();
    return { ...e };
  }
  async softDeleteWithTasks(id: string, batchId: string): Promise<void> {
    const e = this.byId.get(id);
    if (e) {
      e.deletedAt = new Date();
      this.batch.set(id, batchId);
    }
  }
  async countActiveByProject(projectId: string, orgId: string): Promise<number> {
    return [...this.byId.values()].filter((e) => e.projectId === projectId && e.orgId === orgId && !e.deletedAt)
      .length;
  }
  async findAnyById(
    id: string,
    orgId: string,
  ): Promise<{ id: string; projectId: string; deletedAt: Date | null; deletionBatchId: string | null } | null> {
    const e = this.byId.get(id);
    return e && e.orgId === orgId
      ? { id: e.id, projectId: e.projectId, deletedAt: e.deletedAt, deletionBatchId: this.batch.get(id) ?? null }
      : null;
  }
  async restoreBatch(batchId: string, orgId: string): Promise<void> {
    for (const [id, b] of this.batch) {
      const e = this.byId.get(id);
      if (b === batchId && e && e.orgId === orgId && e.deletedAt) {
        e.deletedAt = null;
        this.batch.delete(id);
      }
    }
  }
  async isProjectActive(_projectId: string, _orgId: string): Promise<boolean> {
    return true; // stub de teste: o in-memory não modela exclusão do cliente pai
  }
}

export class InMemoryEngagementMemberRepo implements EngagementMemberRepo {
  private set = new Set<string>(); // `${engagementId}::${userId}`
  private names = new Map<string, string>();
  private engProject = new Map<string, string>(); // engagementId -> projectId
  readonly nulled: Array<{ engagementId: string; userId: string }> = [];

  addUserName(userId: string, name: string): this {
    this.names.set(userId, name);
    return this;
  }
  mapEngagement(engagementId: string, projectId: string): this {
    this.engProject.set(engagementId, projectId);
    return this;
  }
  async add(engagementId: string, userId: string): Promise<void> {
    this.set.add(`${engagementId}::${userId}`);
  }
  async remove(engagementId: string, userId: string): Promise<void> {
    this.set.delete(`${engagementId}::${userId}`);
  }
  async list(engagementId: string): Promise<EngagementMemberView[]> {
    return [...this.set]
      .filter((k) => k.startsWith(`${engagementId}::`))
      .map((k) => k.slice(engagementId.length + 2))
      .map((id) => ({ id, name: this.names.get(id) ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async removeUserFromClientEngagements(projectId: string, userId: string, _orgId: string): Promise<void> {
    for (const k of [...this.set]) {
      const [engId, uid] = k.split("::");
      if (uid === userId && this.engProject.get(engId) === projectId) this.set.delete(k);
    }
  }
  async nullAssigneesInEngagement(engagementId: string, userId: string, _orgId: string): Promise<void> {
    this.nulled.push({ engagementId, userId });
  }
}
