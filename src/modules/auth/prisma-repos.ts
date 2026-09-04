import type { PrismaClient } from "@prisma/client";
import type {
  LockoutStore,
  NewRefreshToken,
  RefreshTokenRepo,
  StoredRefreshToken,
  UserRecord,
  UserRepo,
} from "./types.js";

/** Implementações de produção (Prisma). Testadas por smoke contra o banco real (não em CI sem DB). */

type PrismaUser = {
  id: string;
  orgId: string;
  email: string;
  passwordHash: string;
  roleId: string | null;
  mustChangePassword: boolean;
  tokenVersion: number;
  deletedAt: Date | null;
};

function toUser(u: PrismaUser): UserRecord {
  return {
    id: u.id,
    orgId: u.orgId,
    email: u.email,
    passwordHash: u.passwordHash,
    roleId: u.roleId,
    mustChangePassword: u.mustChangePassword,
    tokenVersion: u.tokenVersion,
    deletedAt: u.deletedAt,
  };
}

export class PrismaUserRepo implements UserRepo {
  constructor(private readonly db: PrismaClient) {}

  async findActiveByEmail(email: string): Promise<UserRecord | null> {
    // email é persistido em minúsculas na criação; o AuthService também normaliza. [SEC-005]
    const u = await this.db.user.findFirst({ where: { email: email.toLowerCase(), deletedAt: null } });
    return u ? toUser(u) : null;
  }
  async findById(id: string): Promise<UserRecord | null> {
    const u = await this.db.user.findUnique({ where: { id } });
    return u ? toUser(u) : null;
  }
  async setNewPassword(id: string, passwordHash: string): Promise<void> {
    await this.db.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: false, tokenVersion: { increment: 1 } },
    });
  }
  async updateName(id: string, name: string): Promise<void> {
    await this.db.user.update({ where: { id }, data: { name } });
  }
}

export class PrismaRefreshRepo implements RefreshTokenRepo {
  constructor(private readonly db: PrismaClient) {}

  async create(t: NewRefreshToken): Promise<void> {
    await this.db.refreshToken.create({
      data: {
        id: t.id,
        userId: t.userId,
        tokenHash: t.tokenHash,
        family: t.family,
        expiresAt: t.expiresAt,
        familyExpiresAt: t.familyExpiresAt,
      },
    });
  }
  async findByHash(hash: string): Promise<StoredRefreshToken | null> {
    const r = await this.db.refreshToken.findUnique({ where: { tokenHash: hash } });
    if (!r) return null;
    return {
      id: r.id,
      userId: r.userId,
      tokenHash: r.tokenHash,
      family: r.family,
      expiresAt: r.expiresAt,
      familyExpiresAt: r.familyExpiresAt,
      revokedAt: r.revokedAt,
      replacedById: r.replacedById,
    };
  }
  async rotate(oldId: string, next: NewRefreshToken): Promise<boolean> {
    try {
      await this.db.$transaction(async (tx) => {
        // CAS: só rotaciona se ainda não revogado.
        const upd = await tx.refreshToken.updateMany({
          where: { id: oldId, revokedAt: null },
          data: { revokedAt: new Date(), replacedById: next.id },
        });
        if (upd.count === 0) throw new Error("CAS_LOST");
        await tx.refreshToken.create({
          data: {
            id: next.id,
            userId: next.userId,
            tokenHash: next.tokenHash,
            family: next.family,
            expiresAt: next.expiresAt,
            familyExpiresAt: next.familyExpiresAt,
          },
        });
      });
      return true;
    } catch (e) {
      if (e instanceof Error && e.message === "CAS_LOST") return false;
      throw e;
    }
  }
  async revokeFamily(family: string): Promise<void> {
    await this.db.refreshToken.updateMany({
      where: { family, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  async revokeAllForUser(userId: string): Promise<void> {
    await this.db.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
}

export class PrismaLockoutStore implements LockoutStore {
  constructor(
    private readonly db: PrismaClient,
    private readonly max = 5,
    private readonly lockMs = 15 * 60_000,
    private readonly windowMs = 15 * 60_000,
  ) {}

  async recordFailure(key: string): Promise<void> {
    const now = new Date();
    const existing = await this.db.loginAttempt.findUnique({ where: { email: key } });
    const lockExpired = existing?.lockedUntil && existing.lockedUntil.getTime() < now.getTime();
    // Janela deslizante: sem lock e com a 1ª falha fora da janela → a contagem esfria. [code-review #4]
    const windowStale =
      existing &&
      !existing.lockedUntil &&
      now.getTime() - existing.firstAt.getTime() > this.windowMs;
    if (existing && (lockExpired || windowStale)) {
      await this.db.loginAttempt.update({
        where: { email: key },
        data: { count: 1, firstAt: now, lockedUntil: null },
      });
      return;
    }
    const row = await this.db.loginAttempt.upsert({
      where: { email: key },
      create: { email: key, count: 1, firstAt: now },
      update: { count: { increment: 1 } },
    });
    if (row.count >= this.max) {
      await this.db.loginAttempt.update({
        where: { email: key },
        data: { lockedUntil: new Date(Date.now() + this.lockMs) },
      });
    }
  }
  async reset(key: string): Promise<void> {
    await this.db.loginAttempt.deleteMany({ where: { email: key } });
  }
  async lockedUntil(key: string): Promise<Date | null> {
    const r = await this.db.loginAttempt.findUnique({ where: { email: key } });
    return r?.lockedUntil ?? null;
  }
}
