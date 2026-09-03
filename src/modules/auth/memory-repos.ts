import type {
  LockoutStore,
  NewRefreshToken,
  RefreshTokenRepo,
  StoredRefreshToken,
  UserRecord,
  UserRepo,
} from "./types.js";

/** Dublês em memória — usados nos testes (sem tocar no banco). */

export class InMemoryUserRepo implements UserRepo {
  private byId = new Map<string, UserRecord>();

  add(u: UserRecord): this {
    this.byId.set(u.id, u);
    return this;
  }
  async findActiveByEmail(email: string): Promise<UserRecord | null> {
    // Case-SENSITIVE de propósito, espelhando o Postgres (o AuthService normaliza antes). [SEC-005]
    for (const u of this.byId.values()) {
      if (u.email === email && !u.deletedAt) return u;
    }
    return null;
  }
  async findById(id: string): Promise<UserRecord | null> {
    return this.byId.get(id) ?? null;
  }
  async setNewPassword(id: string, passwordHash: string): Promise<void> {
    const u = this.byId.get(id);
    if (u) {
      u.passwordHash = passwordHash;
      u.mustChangePassword = false;
      u.tokenVersion += 1;
    }
  }
  /** helper de teste */
  markDeleted(id: string): void {
    const u = this.byId.get(id);
    if (u) u.deletedAt = new Date();
  }
}

export class InMemoryRefreshRepo implements RefreshTokenRepo {
  private byHash = new Map<string, StoredRefreshToken>();
  private byId = new Map<string, StoredRefreshToken>();

  async create(t: NewRefreshToken): Promise<void> {
    const s: StoredRefreshToken = { ...t, revokedAt: null, replacedById: null };
    this.byHash.set(t.tokenHash, s);
    this.byId.set(t.id, s);
  }
  async findByHash(hash: string): Promise<StoredRefreshToken | null> {
    return this.byHash.get(hash) ?? null;
  }
  async rotate(oldId: string, next: NewRefreshToken): Promise<boolean> {
    const old = this.byId.get(oldId);
    if (!old || old.revokedAt) return false; // CAS
    old.revokedAt = new Date();
    old.replacedById = next.id;
    await this.create(next);
    return true;
  }
  async revokeFamily(family: string): Promise<void> {
    for (const s of this.byId.values()) {
      if (s.family === family && !s.revokedAt) s.revokedAt = new Date();
    }
  }
  async revokeAllForUser(userId: string): Promise<void> {
    for (const s of this.byId.values()) {
      if (s.userId === userId && !s.revokedAt) s.revokedAt = new Date();
    }
  }
  /** helper de teste: força um revokedAt antigo pra simular replay fora da janela de graça. */
  forceRevokedAt(hash: string, at: Date): void {
    const s = this.byHash.get(hash);
    if (s) s.revokedAt = at;
  }
}

export class InMemoryLockoutStore implements LockoutStore {
  private m = new Map<string, number[]>();
  constructor(
    private max = 5,
    private windowMs = 15 * 60_000,
    private lockMs = 15 * 60_000,
  ) {}

  async recordFailure(key: string): Promise<void> {
    const now = Date.now();
    const times = (this.m.get(key) ?? []).filter((t) => now - t < this.windowMs);
    times.push(now);
    this.m.set(key, times);
  }
  async reset(key: string): Promise<void> {
    this.m.delete(key);
  }
  async lockedUntil(key: string): Promise<Date | null> {
    const times = this.m.get(key);
    if (!times) return null;
    const now = Date.now();
    const recent = times.filter((t) => now - t < this.windowMs);
    if (recent.length >= this.max) return new Date(recent[0] + this.lockMs);
    return null;
  }
}
