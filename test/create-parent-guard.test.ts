import { describe, it, expect } from "vitest";
import { TaskService } from "../src/modules/tasks/task.service.js";
import { AppError } from "../src/lib/errors.js";
import type { SessionContext } from "../src/modules/authz/types.js";
import type { TaskRepo } from "../src/modules/tasks/types.js";

/**
 * Guarda de pai excluído no create: não cria tarefa órfã sob cliente/projeto soft-deletado.
 * Testa o chokepoint (TaskService.create) com um repo fake — o in-memory real tem stub que
 * retorna sempre `true`, então a regra é exercida aqui. [chip create-under-deleted]
 */
function serviceWith(parentsActive: boolean, spy: { created: boolean }) {
  const tasks = {
    areParentsActive: async () => parentsActive,
    maxPositionByEngagement: async () => 0,
    create: async (t: unknown) => {
      spy.created = true;
      return { ...(t as object), id: "new" };
    },
  } as unknown as TaskRepo;
  const access = { isMember: async () => true } as never;
  return new TaskService(tasks, {} as never, access, {} as never);
}

const session = { userId: "u1", orgId: "o1", permissions: new Set() } as unknown as SessionContext;

describe("create — guarda de pai excluído", () => {
  it("cliente/projeto excluído → VALIDACAO e NÃO cria", async () => {
    const spy = { created: false };
    const service = serviceWith(false, spy);
    await expect(service.create(session, "p1", { title: "órfã" })).rejects.toMatchObject({
      code: "VALIDACAO",
    });
    expect(spy.created).toBe(false); // barrou antes de persistir
  });

  it("pais ativos → segue para a criação", async () => {
    const spy = { created: false };
    const service = serviceWith(true, spy);
    const created = await service.create(session, "p1", { title: "ok" });
    expect(spy.created).toBe(true);
    expect((created as { id: string }).id).toBe("new");
  });
});

// garante que o AppError da guarda tem o code esperado (documenta o contrato do erro)
it("o erro da guarda é um AppError VALIDACAO", async () => {
  const service = serviceWith(false, { created: false });
  await expect(service.create(session, "p1", { title: "x" })).rejects.toBeInstanceOf(AppError);
});
