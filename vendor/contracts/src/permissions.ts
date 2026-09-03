import { z } from "zod";

/**
 * Catálogo único de permissões (`categoria.acao`) — fonte da verdade.
 * Alimenta o union type, o Zod, o `can()` do backend e a PermissionMatrix do front.
 * Nunca escrever a string solta em outro lugar. [design.md §2.3]
 */
export const PERMISSIONS = {
  membros_ver: "membros.ver",
  membros_gerenciar: "membros.gerenciar",
  perfis_ver: "perfis.ver",
  perfis_gerenciar: "perfis.gerenciar",
  permissoes_conceder: "permissoes.conceder",
  projetos_criar: "projetos.criar",
  projetos_acessar_todos: "projetos.acessar_todos",
  projetos_editar: "projetos.editar",
  projetos_excluir: "projetos.excluir",
  tarefas_criar: "tarefas.criar",
  tarefas_editar: "tarefas.editar",
  tarefas_mover: "tarefas.mover",
  tarefas_excluir: "tarefas.excluir",
  subtarefas_gerenciar: "subtarefas.gerenciar",
} as const;

export type Permission = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ALL_PERMISSIONS = Object.values(PERMISSIONS) as Permission[];

/**
 * Classe de cada permissão: `org` (global, sem projeto) ou `project` (escopada ao cliente).
 * A checagem de acesso ao projeto só se aplica às `project`. [design.md §2.3, SEC-105]
 */
export const PERMISSION_SCOPE: Record<Permission, "org" | "project"> = {
  "membros.ver": "org",
  "membros.gerenciar": "org",
  "perfis.ver": "org",
  "perfis.gerenciar": "org",
  "permissoes.conceder": "org",
  "projetos.criar": "org",
  "projetos.acessar_todos": "org",
  "projetos.editar": "project",
  "projetos.excluir": "project",
  "tarefas.criar": "project",
  "tarefas.editar": "project",
  "tarefas.mover": "project",
  "tarefas.excluir": "project",
  "subtarefas.gerenciar": "project",
};

/** Meta-permissões: concessão exige confirmação reforçada e auditoria à parte. [SEC-104/111] */
export const META_PERMISSIONS: Permission[] = [
  PERMISSIONS.projetos_acessar_todos,
  PERMISSIONS.permissoes_conceder,
];

/** Zod: valida que uma string é uma permissão do catálogo (igualdade estrita, sem wildcard). [SEC-114] */
export const permissionSchema = z.enum(
  ALL_PERMISSIONS as [Permission, ...Permission[]],
);

export const permissionListSchema = z.array(permissionSchema);

export function isProjectScoped(p: Permission): boolean {
  return PERMISSION_SCOPE[p] === "project";
}
