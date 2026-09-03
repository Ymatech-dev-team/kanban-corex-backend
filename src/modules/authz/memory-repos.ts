import type {
  AuditEntry,
  AuditRepo,
  AuthzUserRecord,
  AuthzUserRepo,
  ProjectAccessRepo,
} from "./types.js";

/** Dublês em memória (testes). */

export class InMemoryAuthzUserRepo implements AuthzUserRepo {
  private m = new Map<string, AuthzUserRecord>();
  add(u: AuthzUserRecord): this {
    this.m.set(u.id, u);
    return this;
  }
  markDeleted(id: string): void {
    const u = this.m.get(id);
    if (u) u.deletedAt = new Date();
  }
  async findById(id: string): Promise<AuthzUserRecord | null> {
    return this.m.get(id) ?? null;
  }
}

export class InMemoryProjectAccessRepo implements ProjectAccessRepo {
  private access = new Set<string>();
  grant(userId: string, projectId: string): this {
    this.access.add(`${userId}:${projectId}`);
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
}

export class InMemoryAuditRepo implements AuditRepo {
  readonly entries: AuditEntry[] = [];
  async record(entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
  }
}
