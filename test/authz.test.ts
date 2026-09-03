import { describe, it, expect } from "vitest";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import {
  Authorizer,
  resolveEffectivePermissions,
  assertGrantAllowed,
  wouldLeaveNoAdmin,
} from "../src/modules/authz/authorizer.js";
import { InMemoryProjectAccessRepo } from "../src/modules/authz/memory-repos.js";
import type { SessionContext } from "../src/modules/authz/types.js";

function session(perms: string[], userId = "u1"): SessionContext {
  return {
    userId,
    orgId: "o1",
    permissions: resolveEffectivePermissions(perms, []),
    mustChangePassword: false,
  };
}

describe("resolveEffectivePermissions [SEC-114]", () => {
  it("une perfil + extras e descarta o que está fora do catálogo", () => {
    const s = resolveEffectivePermissions(["tarefas.criar", "lixo.invalido"], ["membros.ver"]);
    expect(s.has("tarefas.criar")).toBe(true);
    expect(s.has("membros.ver")).toBe(true);
    expect(s.has("lixo.invalido" as never)).toBe(false);
  });
});

describe("Authorizer.assertCan [SEC-105]", () => {
  it("permissão org-global não exige acesso a projeto", async () => {
    const az = new Authorizer(new InMemoryProjectAccessRepo());
    await expect(
      az.assertCan(session([PERMISSIONS.membros_gerenciar]), PERMISSIONS.membros_gerenciar),
    ).resolves.toBeUndefined();
  });

  it("sem a permissão da ação → 403", async () => {
    const az = new Authorizer(new InMemoryProjectAccessRepo());
    await expect(
      az.assertCan(session([]), PERMISSIONS.tarefas_criar, "p1"),
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it("permissão de projeto sem acesso ao cliente → 404 (não vaza existência)", async () => {
    const az = new Authorizer(new InMemoryProjectAccessRepo());
    await expect(
      az.assertCan(session([PERMISSIONS.tarefas_criar]), PERMISSIONS.tarefas_criar, "p1"),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("permissão de projeto COM acesso ao cliente → ok", async () => {
    const az = new Authorizer(new InMemoryProjectAccessRepo().grant("u1", "p1"));
    await expect(
      az.assertCan(session([PERMISSIONS.tarefas_criar]), PERMISSIONS.tarefas_criar, "p1"),
    ).resolves.toBeUndefined();
  });

  it("acessar_todos ignora a membership do projeto", async () => {
    const az = new Authorizer(new InMemoryProjectAccessRepo());
    await expect(
      az.assertCan(
        session([PERMISSIONS.tarefas_criar, PERMISSIONS.projetos_acessar_todos]),
        PERMISSIONS.tarefas_criar,
        "pX",
      ),
    ).resolves.toBeUndefined();
  });
});

describe("anti-escalonamento e último admin", () => {
  it("não concede permissão que o concedente não possui", () => {
    const granter = resolveEffectivePermissions([PERMISSIONS.tarefas_criar], []);
    expect(() => assertGrantAllowed(granter, [PERMISSIONS.permissoes_conceder])).toThrow();
    expect(() => assertGrantAllowed(granter, [PERMISSIONS.tarefas_criar])).not.toThrow();
  });

  it("bloqueia remover o último admin", () => {
    expect(wouldLeaveNoAdmin(["a1"], "a1")).toBe(true);
    expect(wouldLeaveNoAdmin(["a1", "a2"], "a1")).toBe(false);
  });
});
