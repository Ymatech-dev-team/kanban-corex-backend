import {
  PERMISSIONS,
  META_PERMISSIONS,
  type Permission,
  type CreateMemberInput,
  type UpdateMemberInput,
} from "@sistema-tasks/contracts";
import { AppError } from "../../lib/errors.js";
import { genTempPassword } from "../../lib/secret.js";
import {
  resolveEffectivePermissions,
  assertGrantAllowed,
  wouldLeaveNoAdmin,
} from "../authz/authorizer.js";
import type { PasswordService } from "../auth/password.service.js";
import type { RefreshTokenRepo } from "../auth/types.js";
import type { AuditRepo, SessionContext } from "../authz/types.js";
import type { MemberRepo, RoleRepo } from "./types.js";

function isGovernance(perms: Set<Permission>): boolean {
  return perms.has(PERMISSIONS.permissoes_conceder) && perms.has(PERMISSIONS.membros_gerenciar);
}

export class MemberService {
  constructor(
    private readonly members: MemberRepo,
    private readonly roles: RoleRepo,
    private readonly passwords: PasswordService,
    private readonly refresh: RefreshTokenRepo,
    private readonly audit: AuditRepo,
  ) {}

  list(session: SessionContext) {
    return this.members.listByOrg(session.orgId);
  }

  async create(session: SessionContext, input: CreateMemberInput) {
    const email = input.email.trim().toLowerCase();
    if (await this.members.emailExists(session.orgId, email)) {
      throw new AppError("VALIDACAO", "Email já cadastrado");
    }
    if (input.roleId) {
      const role = await this.roles.findById(input.roleId, session.orgId);
      if (!role) throw new AppError("VALIDACAO", "Perfil inválido");
      assertGrantAllowed(session.permissions, role.permissions); // não cria alguém acima de você
    }
    const temp = genTempPassword();
    const passwordHash = await this.passwords.hash(temp);
    const member = await this.members.create({
      orgId: session.orgId,
      name: input.name,
      email,
      passwordHash,
      roleId: input.roleId ?? null,
    });
    await this.audit.record({
      actorId: session.userId,
      targetUserId: member.id,
      action: "member.create",
      detail: { email },
    });
    return { member, tempPassword: temp };
  }

  async update(session: SessionContext, targetId: string, patch: UpdateMemberInput): Promise<void> {
    const target = await this.members.findById(targetId, session.orgId);
    if (!target) throw new AppError("NAO_ENCONTRADO", "Usuário não encontrado");

    const changingPrivilege = patch.roleId !== undefined || patch.extraPermissions !== undefined;
    if (changingPrivilege && targetId === session.userId) {
      throw new AppError("SEM_PERMISSAO", "Você não pode editar o próprio privilégio"); // [SEC-103]
    }

    if (changingPrivilege) {
      const currentEffective = resolveEffectivePermissions(target.rolePermissions, target.extraPermissions);
      const newRoleId = patch.roleId !== undefined ? patch.roleId : target.roleId;
      const newExtras = patch.extraPermissions !== undefined ? patch.extraPermissions : target.extraPermissions;

      let rolePerms: string[] = [];
      if (newRoleId) {
        const role = await this.roles.findById(newRoleId, session.orgId);
        if (!role) throw new AppError("VALIDACAO", "Perfil inválido");
        rolePerms = role.permissions;
      }
      const newEffective = resolveEffectivePermissions(rolePerms, newExtras);

      // Anti-escalonamento: só concede (via perfil OU extras) o que você mesmo tem. [SEC-101/102]
      assertGrantAllowed(session.permissions, [...rolePerms, ...newExtras]);

      // Meta-permissão nova exige confirmação reforçada. [SEC-104]
      const metaAdded = META_PERMISSIONS.filter((m) => newEffective.has(m) && !currentEffective.has(m));
      if (metaAdded.length > 0 && !patch.confirmMetaPermission) {
        throw new AppError("VALIDACAO", "Confirmação necessária para conceder permissões de administração");
      }

      // Último admin: não pode deixar a org sem quem administra. [SEC-016/S02]
      await this.assertKeepsAdmin(session.orgId, targetId, isGovernance(newEffective));
    }

    await this.members.updateProfile(targetId, {
      name: patch.name,
      roleId: patch.roleId,
      extraPermissions: patch.extraPermissions,
    });
    await this.audit.record({
      actorId: session.userId,
      targetUserId: targetId,
      action: "member.update",
      detail: { roleId: patch.roleId ?? null, extraPermissions: patch.extraPermissions ?? null },
    });
  }

  async softDelete(session: SessionContext, targetId: string): Promise<void> {
    if (targetId === session.userId) {
      throw new AppError("VALIDACAO", "Você não pode remover a si mesmo");
    }
    const target = await this.members.findById(targetId, session.orgId);
    if (!target) throw new AppError("NAO_ENCONTRADO", "Usuário não encontrado");
    const admins = await this.members.listGovernanceAdminIds(session.orgId);
    if (wouldLeaveNoAdmin(admins, targetId)) {
      throw new AppError("CONFLITO", "A organização ficaria sem administrador");
    }
    await this.members.softDeleteAndBump(targetId); // deletedAt + bump tokenVersion (mata sessão)
    await this.refresh.revokeAllForUser(targetId);
    await this.members.nullAllAssignees(targetId); // [SEC-007/RF8]
    await this.audit.record({ actorId: session.userId, targetUserId: targetId, action: "member.delete", detail: {} });
  }

  async resetPassword(session: SessionContext, targetId: string) {
    const target = await this.members.findById(targetId, session.orgId);
    if (!target) throw new AppError("NAO_ENCONTRADO", "Usuário não encontrado");
    const temp = genTempPassword();
    const hash = await this.passwords.hash(temp);
    await this.members.setTempPasswordAndBump(targetId, hash); // temp + mustChangePassword + bump
    await this.refresh.revokeAllForUser(targetId);
    await this.audit.record({ actorId: session.userId, targetUserId: targetId, action: "member.reset_password", detail: {} });
    return { tempPassword: temp };
  }

  private async assertKeepsAdmin(orgId: string, targetId: string, targetWillBeAdmin: boolean): Promise<void> {
    const admins = await this.members.listGovernanceAdminIds(orgId);
    const others = admins.filter((id) => id !== targetId);
    if (others.length === 0 && !targetWillBeAdmin) {
      throw new AppError("CONFLITO", "A organização ficaria sem administrador");
    }
  }
}
