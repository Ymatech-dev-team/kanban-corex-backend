import {
  ALL_PERMISSIONS,
  PERMISSION_SCOPE,
  PERMISSIONS,
  type Permission,
} from "@sistema-tasks/contracts";
import { AppError } from "../../lib/errors.js";
import type { ProjectAccessRepo, SessionContext } from "./types.js";

const CATALOG = new Set<string>(ALL_PERMISSIONS);

/** Permissão efetiva = perfil ∪ extras, filtrada pelo catálogo (lixo é descartado). [SEC-114] */
export function resolveEffectivePermissions(
  rolePermissions: string[],
  extraPermissions: string[],
): Set<Permission> {
  const set = new Set<Permission>();
  for (const p of [...rolePermissions, ...extraPermissions]) {
    if (CATALOG.has(p)) set.add(p as Permission);
  }
  return set;
}

/** Decide "pode fazer a ação X no cliente Y?" nas duas dimensões. [design.md §2.3] */
export class Authorizer {
  constructor(private readonly access: ProjectAccessRepo) {}

  async assertCan(
    session: SessionContext,
    perm: Permission,
    projectId?: string,
  ): Promise<void> {
    // 1) tem a permissão da ação? (senão 403)
    if (!session.permissions.has(perm)) {
      throw new AppError("SEM_PERMISSAO", "Você não tem permissão para isso");
    }
    // 2) permissão org-global não depende de projeto
    if (PERMISSION_SCOPE[perm] === "org") return;
    // 3) permissão de projeto: acessar_todos OU membro do projeto
    if (session.permissions.has(PERMISSIONS.projetos_acessar_todos)) return;
    // invariante: permissão de projeto SEMPRE recebe projectId — ausência é bug de wiring. [SEC-A01]
    if (!projectId) {
      throw new AppError("INTERNO", "projectId obrigatório para permissão de projeto");
    }
    if (await this.access.isMember(session.userId, projectId)) return;
    // sem acesso ao cliente → 404 (não confirma existência) [SEC-105]
    throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
  }

  /** Leitura = sessão + acesso ao cliente (não existe permissão de "ver"). [design.md §2.3] */
  async assertProjectAccess(session: SessionContext, projectId: string): Promise<void> {
    if (session.permissions.has(PERMISSIONS.projetos_acessar_todos)) return;
    if (await this.access.isMember(session.userId, projectId)) return;
    throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
  }

  async can(session: SessionContext, perm: Permission, projectId?: string): Promise<boolean> {
    try {
      await this.assertCan(session, perm, projectId);
      return true;
    } catch (e) {
      // Só nega por autorização; erro real (banco, bug) propaga em vez de virar "sem permissão". [SEC-A03]
      if (e instanceof AppError && (e.code === "SEM_PERMISSAO" || e.code === "NAO_ENCONTRADO")) {
        return false;
      }
      throw e;
    }
  }
}

/** Anti-escalonamento: só concede o que o próprio concedente tem na efetiva. [SEC-101/102/103] */
export function assertGrantAllowed(granter: Set<Permission>, requested: string[]): void {
  for (const p of requested) {
    if (!granter.has(p as Permission)) {
      throw new AppError("SEM_PERMISSAO", "Você não pode conceder uma permissão que não possui");
    }
  }
}

/** Trava do último admin: simula a remoção e vê se sobra alguém que administra. [SEC-016/109] */
export function wouldLeaveNoAdmin(adminUserIds: string[], removedUserId: string): boolean {
  return adminUserIds.filter((id) => id !== removedUserId).length === 0;
}
