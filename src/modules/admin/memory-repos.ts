import { randomUUID } from "node:crypto";
import { PERMISSIONS, type Permission } from "@sistema-tasks/contracts";
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

/** Store compartilhado entre os dublês (membros e perfis se enxergam). */
export class InMemoryAdminStore {
  members = new Map<string, MemberRecord>();
  roles = new Map<string, RoleRecord>();

  addMember(m: MemberRecord): this {
    this.members.set(m.id, m);
    return this;
  }
  addRole(r: RoleRecord): this {
    this.roles.set(r.id, r);
    return this;
  }
  private rolePerms(roleId: string | null): string[] {
    return roleId ? (this.roles.get(roleId)?.permissions ?? []) : [];
  }

  memberWithPerms(m: MemberRecord): MemberRecord {
    return { ...m, rolePermissions: this.rolePerms(m.roleId) };
  }
}

export class InMemoryMemberRepo implements MemberRepo {
  constructor(private readonly store: InMemoryAdminStore) {}

  private summary(m: MemberRecord): MemberSummary {
    return {
      id: m.id,
      name: m.name,
      email: m.email,
      roleId: m.roleId,
      extraPermissions: m.extraPermissions,
      mustChangePassword: m.mustChangePassword,
    };
  }

  async listByOrg(orgId: string): Promise<MemberSummary[]> {
    return [...this.store.members.values()]
      .filter((m) => m.orgId === orgId && !m.deletedAt)
      .map((m) => this.summary(m));
  }
  async findById(id: string, orgId: string): Promise<MemberRecord | null> {
    const m = this.store.members.get(id);
    return m && m.orgId === orgId && !m.deletedAt ? this.store.memberWithPerms(m) : null;
  }
  async emailExists(orgId: string, email: string): Promise<boolean> {
    return [...this.store.members.values()].some(
      (m) => m.orgId === orgId && !m.deletedAt && m.email === email,
    );
  }
  async create(m: NewMember): Promise<MemberSummary> {
    const rec: MemberRecord = {
      id: randomUUID(),
      orgId: m.orgId,
      name: m.name,
      email: m.email,
      roleId: m.roleId,
      rolePermissions: [],
      extraPermissions: [],
      mustChangePassword: true,
      tokenVersion: 0,
      deletedAt: null,
    };
    this.store.members.set(rec.id, rec);
    return this.summary(rec);
  }
  async updateProfile(
    id: string,
    data: { name?: string; roleId?: string | null; extraPermissions?: string[] },
  ): Promise<void> {
    const m = this.store.members.get(id);
    if (!m) return;
    if (data.name !== undefined) m.name = data.name;
    if (data.roleId !== undefined) m.roleId = data.roleId;
    if (data.extraPermissions !== undefined) m.extraPermissions = [...data.extraPermissions];
  }
  async softDeleteAndBump(id: string): Promise<void> {
    const m = this.store.members.get(id);
    if (m) {
      m.deletedAt = new Date();
      m.tokenVersion += 1;
    }
  }
  async setTempPasswordAndBump(id: string, _passwordHash: string): Promise<void> {
    const m = this.store.members.get(id);
    if (m) {
      m.mustChangePassword = true;
      m.tokenVersion += 1;
    }
  }
  readonly nulledAssignees: string[] = [];
  async nullAllAssignees(userId: string): Promise<void> {
    this.nulledAssignees.push(userId);
  }
  async listGovernanceAdminIds(orgId: string): Promise<string[]> {
    return [...this.store.members.values()]
      .filter((m) => m.orgId === orgId && !m.deletedAt)
      .filter((m) => isGovernance(resolveEffectivePermissions(this.store.memberWithPerms(m).rolePermissions, m.extraPermissions)))
      .map((m) => m.id);
  }
  async listMembersForAdminCheck(orgId: string) {
    return [...this.store.members.values()]
      .filter((m) => m.orgId === orgId && !m.deletedAt)
      .map((m) => ({
        id: m.id,
        roleId: m.roleId,
        rolePermissions: this.store.memberWithPerms(m).rolePermissions,
        extraPermissions: m.extraPermissions,
      }));
  }
}

export class InMemoryRoleRepo implements RoleRepo {
  constructor(private readonly store: InMemoryAdminStore) {}

  async listByOrg(orgId: string): Promise<RoleRecord[]> {
    return [...this.store.roles.values()].filter((r) => r.orgId === orgId);
  }
  async findById(id: string, orgId: string): Promise<RoleRecord | null> {
    const r = this.store.roles.get(id);
    return r && r.orgId === orgId ? { ...r } : null;
  }
  async create(orgId: string, name: string, permissions: string[]): Promise<RoleRecord> {
    const r: RoleRecord = { id: randomUUID(), orgId, name, permissions: [...permissions], isSystem: false };
    this.store.roles.set(r.id, r);
    return { ...r };
  }
  async update(id: string, data: { name?: string; permissions?: string[] }): Promise<void> {
    const r = this.store.roles.get(id);
    if (!r) return;
    if (data.name !== undefined) r.name = data.name;
    if (data.permissions !== undefined) r.permissions = [...data.permissions];
  }
  async delete(id: string): Promise<void> {
    this.store.roles.delete(id);
  }
  async countUsers(roleId: string): Promise<number> {
    return [...this.store.members.values()].filter((m) => m.roleId === roleId && !m.deletedAt).length;
  }
}
