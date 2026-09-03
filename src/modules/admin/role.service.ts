import {
  META_PERMISSIONS,
  PERMISSIONS,
  type Permission,
  type CreateRoleInput,
  type UpdateRoleInput,
} from "@sistema-tasks/contracts";
import { AppError } from "../../lib/errors.js";
import { assertGrantAllowed, resolveEffectivePermissions } from "../authz/authorizer.js";
import type { AuditRepo, SessionContext } from "../authz/types.js";
import type { MemberRepo, RoleRepo } from "./types.js";

function isGovernance(perms: Set<Permission>): boolean {
  return perms.has(PERMISSIONS.permissoes_conceder) && perms.has(PERMISSIONS.membros_gerenciar);
}

export class RoleService {
  constructor(
    private readonly roles: RoleRepo,
    private readonly members: MemberRepo,
    private readonly audit: AuditRepo,
  ) {}

  list(session: SessionContext) {
    return this.roles.listByOrg(session.orgId);
  }

  async create(session: SessionContext, input: CreateRoleInput) {
    assertGrantAllowed(session.permissions, input.permissions); // [SEC-102]
    // Criar role com meta-perm não afeta usuário nenhum (role nova, sem membros) → sem gate.
    const role = await this.roles.create(session.orgId, input.name, input.permissions);
    await this.audit.record({ actorId: session.userId, action: "role.create", detail: { roleId: role.id, permissions: input.permissions } });
    return role;
  }

  async update(session: SessionContext, roleId: string, patch: UpdateRoleInput): Promise<void> {
    const role = await this.roles.findById(roleId, session.orgId);
    if (!role) throw new AppError("NAO_ENCONTRADO", "Perfil não encontrado");
    if (role.isSystem) throw new AppError("SEM_PERMISSAO", "Perfil de sistema não é editável");

    if (patch.permissions) {
      // Anti-escalonamento: editar o conteúdo do perfil também é conceder. [SEC-101]
      assertGrantAllowed(session.permissions, patch.permissions);

      // Meta-permissão nova via role exige confirmação (senão contorna a confirmação por membro). [SEC-203]
      const metaAdded = META_PERMISSIONS.filter(
        (m) => patch.permissions!.includes(m) && !role.permissions.includes(m),
      );
      if (metaAdded.length > 0 && !patch.confirmMetaPermission) {
        throw new AppError("VALIDACAO", "Confirmação necessária para conceder permissões de administração");
      }

      // Último-admin: simula as novas permissões da role e confere se sobra admin. [SEC-201]
      await this.assertRoleEditKeepsAdmin(session.orgId, roleId, patch.permissions);
    }

    await this.roles.update(roleId, patch);
    await this.audit.record({ actorId: session.userId, action: "role.update", detail: { roleId, permissions: patch.permissions ?? null } });
  }

  async delete(session: SessionContext, roleId: string): Promise<void> {
    const role = await this.roles.findById(roleId, session.orgId);
    if (!role) throw new AppError("NAO_ENCONTRADO", "Perfil não encontrado");
    if (role.isSystem) throw new AppError("SEM_PERMISSAO", "Perfil de sistema não pode ser removido");
    if ((await this.roles.countUsers(roleId)) > 0) {
      throw new AppError("CONFLITO", "Perfil em uso — reatribua os usuários antes de remover");
    }
    await this.roles.delete(roleId);
    await this.audit.record({ actorId: session.userId, action: "role.delete", detail: { roleId } });
  }

  private async assertRoleEditKeepsAdmin(orgId: string, roleId: string, newPerms: string[]): Promise<void> {
    const members = await this.members.listMembersForAdminCheck(orgId);
    const stillAdmin = members.some((m) => {
      const rolePerms = m.roleId === roleId ? newPerms : m.rolePermissions;
      return isGovernance(resolveEffectivePermissions(rolePerms, m.extraPermissions));
    });
    if (!stillAdmin) {
      throw new AppError("CONFLITO", "A organização ficaria sem administrador");
    }
  }
}
