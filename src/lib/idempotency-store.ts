import type { PrismaClient } from "@prisma/client";
import type { IdempotencyStore } from "./idempotency.js";

// Chave física escopada por usuário (userId::key) — fecha o vazamento cross-usuário. [SEC-501]
const composite = (userId: string, key: string) => `${userId}::${key}`;

export class InMemoryIdempotencyStore implements IdempotencyStore {
  private m = new Map<string, string>();
  async get(userId: string, key: string) {
    const v = this.m.get(composite(userId, key));
    return v ? { resultId: v } : null;
  }
  async put(userId: string, key: string, resultId: string) {
    this.m.set(composite(userId, key), resultId);
  }
}

export class PrismaIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: PrismaClient) {}
  async get(userId: string, key: string) {
    const r = await this.db.idempotencyKey.findUnique({ where: { key: composite(userId, key) } });
    return r ? { resultId: r.resultId } : null;
  }
  async put(userId: string, key: string, resultId: string) {
    await this.db.idempotencyKey.create({ data: { key: composite(userId, key), userId, resultId } });
  }
}
