import type { PrismaClient } from "@prisma/client";
import { PERMISSIONS, type Permission } from "@sistema-tasks/contracts";
import { AppError } from "../../lib/errors.js";
import { resolveEffectivePermissions } from "../authz/authorizer.js";
import type {
  MemberRecord,
  MemberRepo,
  MemberSummary,
  NewMember,
  RoleRecord,
  RoleRepo,
} from "./types.js";

function isGovernance(perms: Set<Permission>): boolean {
  return perms.has(PERMISSIONS.permissoes_conceder) && perms.has(PERMISSIONS.membros_gerenciar);
}

export class PrismaMemberRepo implements MemberRepo {
  constructor(private readonly db: PrismaClient) {}

  async listByOrg(orgId: string): Promise<MemberSummary[]> {
    const rows = await this.db.user.findMany({
      where: { orgId, deletedAt: null },
      select: { id: true, name: true, email: true, roleId: true, extraPermissions: true, mustChangePassword: true },
      orderBy: { name: "asc" },
    });
    return rows;
  }
  async findById(id: string, orgId: string): Promise<MemberRecord | null> {
    const u = await this.db.user.findFirst({ where: { id, orgId, deletedAt: null }, include: { role: true } });
    if (!u) return null;
    return {
      id: u.id,
      orgId: u.orgId,
      name: u.name,
      email: u.email,
      roleId: u.roleId,
      rolePermissions: u.role?.permissions ?? [],
      extraPermissions: u.extraPermissions,
      mustChangePassword: u.mustChangePassword,
      tokenVersion: u.tokenVersion,
      deletedAt: u.deletedAt,
    };
  }
  async emailExists(orgId: string, email: string): Promise<boolean> {
    const u = await this.db.user.findFirst({ where: { orgId, email, deletedAt: null } });
    return u !== null;
  }
  async create(m: NewMember): Promise<MemberSummary> {
    try {
      return await this.db.user.create({
        data: {
          orgId: m.orgId,
          name: m.name,
          email: m.email,
          passwordHash: m.passwordHash,
          roleId: m.roleId,
          mustChangePassword: true,
        },
        select: { id: true, name: true, email: true, roleId: true, extraPermissions: true, mustChangePassword: true },
      });
    } catch (e) {
      // Índice único parcial (orgId,email) WHERE deletedAt IS NULL garante no banco. [SEC-204]
      if (e && typeof e === "object" && (e as { code?: string }).code === "P2002") {
        throw new AppError("VALIDACAO", "Email já cadastrado");
      }
      throw e;
    }
  }
  async updateProfile(
    id: string,
    data: { name?: string; roleId?: string | null; extraPermissions?: string[] },
  ): Promise<void> {
    await this.db.user.update({
      where: { id },
      data: { name: data.name, roleId: data.roleId, extraPermissions: data.extraPermissions },
    });
  }
  async softDeleteAndBump(id: string): Promise<void> {
    await this.db.user.update({ where: { id }, data: { deletedAt: new Date(), tokenVersion: { increment: 1 } } });
  }
  async setTempPasswordAndBump(id: string, passwordHash: string): Promise<void> {
    await this.db.user.update({
      where: { id },
      data: { passwordHash, mustChangePassword: true, tokenVersion: { increment: 1 } },
    });
  }
  async nullAllAssignees(userId: string): Promise<void> {
    await this.db.task.updateMany({ where: { assigneeId: userId }, data: { assigneeId: null } });
  }
  async listGovernanceAdminIds(orgId: string): Promise<string[]> {
    const rows = await this.db.user.findMany({ where: { orgId, deletedAt: null }, include: { role: true } });
    return rows
      .filter((u) => isGovernance(resolveEffectivePermissions(u.role?.permissions ?? [], u.extraPermissions)))
      .map((u) => u.id);
  }
  async listMembersForAdminCheck(orgId: string) {
    const rows = await this.db.user.findMany({ where: { orgId, deletedAt: null }, include: { role: true } });
    return rows.map((u) => ({
      id: u.id,
      roleId: u.roleId,
      rolePermissions: u.role?.permissions ?? [],
      extraPermissions: u.extraPermissions,
    }));
  }
}

export class PrismaRoleRepo implements RoleRepo {
  constructor(private readonly db: PrismaClient) {}

  async listByOrg(orgId: string): Promise<RoleRecord[]> {
    return this.db.role.findMany({ where: { orgId }, orderBy: { name: "asc" } });
  }
  async findById(id: string, orgId: string): Promise<RoleRecord | null> {
    return this.db.role.findFirst({ where: { id, orgId } });
  }
  async create(orgId: string, name: string, permissions: string[]): Promise<RoleRecord> {
    return this.db.role.create({ data: { orgId, name, permissions } });
  }
  async update(id: string, data: { name?: string; permissions?: string[] }): Promise<void> {
    await this.db.role.update({ where: { id }, data: { name: data.name, permissions: data.permissions } });
  }
  async delete(id: string): Promise<void> {
    await this.db.role.delete({ where: { id } });
  }
  async countUsers(roleId: string): Promise<number> {
    return this.db.user.count({ where: { roleId, deletedAt: null } });
  }
}
