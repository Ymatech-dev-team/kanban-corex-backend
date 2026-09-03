export interface MemberRecord {
  id: string;
  orgId: string;
  name: string;
  email: string;
  roleId: string | null;
  rolePermissions: string[];
  extraPermissions: string[];
  mustChangePassword: boolean;
  tokenVersion: number;
  deletedAt: Date | null;
}

export interface MemberSummary {
  id: string;
  name: string;
  email: string;
  roleId: string | null;
  extraPermissions: string[];
  mustChangePassword: boolean;
}

export interface NewMember {
  orgId: string;
  name: string;
  email: string;
  passwordHash: string;
  roleId: string | null;
}

export interface MemberRepo {
  listByOrg(orgId: string): Promise<MemberSummary[]>;
  findById(id: string, orgId: string): Promise<MemberRecord | null>;
  emailExists(orgId: string, email: string): Promise<boolean>;
  create(m: NewMember): Promise<MemberSummary>;
  updateProfile(
    id: string,
    data: { name?: string; roleId?: string | null; extraPermissions?: string[] },
  ): Promise<void>;
  softDeleteAndBump(id: string): Promise<void>;
  setTempPasswordAndBump(id: string, passwordHash: string): Promise<void>;
  nullAllAssignees(userId: string): Promise<void>;
  /** IDs dos usuários cuja permissão efetiva inclui conceder + gerenciar (admins). [SEC-016] */
  listGovernanceAdminIds(orgId: string): Promise<string[]>;
  /** Membros ativos com role+extras, para simular o efeito de editar uma role. [SEC-201] */
  listMembersForAdminCheck(orgId: string): Promise<MemberForAdminCheck[]>;
}

export interface MemberForAdminCheck {
  id: string;
  roleId: string | null;
  rolePermissions: string[];
  extraPermissions: string[];
}

export interface RoleRecord {
  id: string;
  orgId: string;
  name: string;
  permissions: string[];
  isSystem: boolean;
}

export interface RoleRepo {
  listByOrg(orgId: string): Promise<RoleRecord[]>;
  findById(id: string, orgId: string): Promise<RoleRecord | null>;
  create(orgId: string, name: string, permissions: string[]): Promise<RoleRecord>;
  update(id: string, data: { name?: string; permissions?: string[] }): Promise<void>;
  delete(id: string): Promise<void>;
  countUsers(roleId: string): Promise<number>;
}
