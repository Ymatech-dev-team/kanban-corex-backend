import { randomUUID } from "node:crypto";
import type { NewProject, ProjectAccessRepo, ProjectMemberView, ProjectRecord, ProjectRepo } from "./types.js";

export class InMemoryProjectRepo implements ProjectRepo {
  private byId = new Map<string, ProjectRecord>();

  async create(p: NewProject): Promise<ProjectRecord> {
    const now = new Date();
    const rec: ProjectRecord = {
      id: randomUUID(),
      orgId: p.orgId,
      name: p.name,
      description: p.description ?? null,
      createdById: p.createdById,
      deletedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.byId.set(rec.id, rec);
    return { ...rec };
  }
  async findById(id: string, orgId: string): Promise<ProjectRecord | null> {
    const p = this.byId.get(id);
    return p && p.orgId === orgId && !p.deletedAt ? { ...p } : null;
  }
  async listByOrg(orgId: string): Promise<ProjectRecord[]> {
    return [...this.byId.values()].filter((p) => p.orgId === orgId && !p.deletedAt);
  }
  async listByIds(ids: string[], orgId: string): Promise<ProjectRecord[]> {
    const set = new Set(ids);
    return [...this.byId.values()].filter((p) => set.has(p.id) && p.orgId === orgId && !p.deletedAt);
  }
  async update(id: string, data: { name?: string; description?: string | null }): Promise<ProjectRecord> {
    const p = this.byId.get(id);
    if (!p) throw new Error("not found");
    if (data.name !== undefined) p.name = data.name;
    if (data.description !== undefined) p.description = data.description;
    p.updatedAt = new Date();
    return { ...p };
  }
  async softDeleteWithTasks(id: string, _batchId: string): Promise<void> {
    const p = this.byId.get(id);
    if (p) p.deletedAt = new Date();
  }
}

export class InMemoryProjectAccessRepo implements ProjectAccessRepo {
  private access = new Set<string>();
  private users = new Map<string, { orgId: string; name: string }>();
  readonly nulled: Array<{ projectId: string; userId: string }> = [];

  addUser(userId: string, orgId: string, name?: string): this {
    this.users.set(userId, { orgId, name: name ?? userId });
    return this;
  }
  async isMember(userId: string, projectId: string): Promise<boolean> {
    return this.access.has(`${userId}:${projectId}`);
  }
  async listAccessibleProjectIds(userId: string): Promise<string[]> {
    return [...this.access]
      .filter((k) => k.startsWith(`${userId}:`))
      .map((k) => k.slice(userId.length + 1));
  }
  async grant(projectId: string, userId: string): Promise<void> {
    this.access.add(`${userId}:${projectId}`);
  }
  async revoke(projectId: string, userId: string): Promise<void> {
    this.access.delete(`${userId}:${projectId}`);
  }
  async listMembers(projectId: string): Promise<ProjectMemberView[]> {
    return [...this.access]
      .filter((k) => k.endsWith(`:${projectId}`))
      .map((k) => k.slice(0, k.length - projectId.length - 1))
      .map((id) => ({ id, name: this.users.get(id)?.name ?? id }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  async nullAssigneesInProject(projectId: string, userId: string): Promise<void> {
    this.nulled.push({ projectId, userId });
  }
  async userExistsInOrg(userId: string, orgId: string): Promise<boolean> {
    return this.users.get(userId)?.orgId === orgId;
  }
}
