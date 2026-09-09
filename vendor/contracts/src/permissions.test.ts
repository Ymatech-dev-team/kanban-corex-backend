import { describe, it, expect } from "vitest";
import {
  PERMISSIONS,
  ALL_PERMISSIONS,
  PERMISSION_SCOPE,
  isProjectScoped,
  permissionSchema,
} from "./permissions.js";

describe("catálogo de permissões (fonte única)", () => {
  it("expõe a chave como a string categoria.acao esperada", () => {
    expect(PERMISSIONS.tarefas_mover).toBe("tarefas.mover");
    expect(PERMISSIONS.permissoes_conceder).toBe("permissoes.conceder");
  });

  it("toda permissão tem uma classe de escopo definida", () => {
    for (const p of ALL_PERMISSIONS) {
      expect(PERMISSION_SCOPE[p]).toMatch(/^(org|project)$/);
    }
  });

  it("classifica tarefas.* como projeto-escopada e membros.* como org-global", () => {
    expect(isProjectScoped("tarefas.mover")).toBe(true);
    expect(isProjectScoped("membros.gerenciar")).toBe(false);
  });

  it("permissões de projeto (engagements.*) são projeto-escopadas", () => {
    expect(PERMISSIONS.engagements_criar).toBe("engagements.criar");
    expect(isProjectScoped("engagements.criar")).toBe(true);
    expect(isProjectScoped("engagements.editar")).toBe(true);
    expect(isProjectScoped("engagements.excluir")).toBe(true);
    expect(isProjectScoped("engagements.consultores")).toBe(true);
  });

  it("Zod rejeita string fora do catálogo (sem wildcard)", () => {
    expect(permissionSchema.safeParse("tarefa.mover").success).toBe(false); // typo sem 's'
    expect(permissionSchema.safeParse("tarefas.*").success).toBe(false);
    expect(permissionSchema.safeParse("tarefas.mover").success).toBe(true);
  });
});
