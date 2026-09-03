import { describe, it, expect, vi } from "vitest";
import { withIdempotency, type IdempotencyStore } from "../src/lib/idempotency.js";

function memStore(): IdempotencyStore {
  const m = new Map<string, string>();
  return {
    async get(userId, k) {
      const v = m.get(`${userId}:${k}`);
      return v ? { resultId: v } : null;
    },
    async put(userId, k, resultId) {
      m.set(`${userId}:${k}`, resultId);
    },
  };
}

describe("idempotência de criação [JOR-6]", () => {
  it("sem Idempotency-Key: sempre cria", async () => {
    const create = vi.fn(async () => ({ id: "a" }));
    await withIdempotency(memStore(), undefined, "u1", create);
    await withIdempotency(memStore(), undefined, "u1", create);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("mesma key: cria uma vez, reusa depois (duplo-clique não duplica)", async () => {
    const store = memStore();
    const create = vi.fn(async () => ({ id: "x1" }));
    const r1 = await withIdempotency(store, "k1", "u1", create);
    const r2 = await withIdempotency(store, "k1", "u1", create);
    expect(create).toHaveBeenCalledTimes(1);
    expect(r1.reused).toBe(false);
    expect(r2.reused).toBe(true);
    expect(r2.result.id).toBe("x1");
  });
});
