import type { Permission } from "@sistema-tasks/contracts";

/** Contexto da sessão anexado à requisição autenticada. */
export interface SessionContext {
  userId: string;
  orgId: string;
  permissions: Set<Permission>;
  mustChangePassword: boolean;
  name?: string;
  email?: string;
}

export interface AuthzUserRecord {
  id: string;
  orgId: string;
  deletedAt: Date | null;
  tokenVersion: number;
  mustChangePassword: boolean;
  rolePermissions: string[]; // do perfil
  extraPermissions: string[]; // aditivas por usuário (grant-only)
  name?: string;
  email?: string;
}

export interface AuthzUserRepo {
  findById(id: string): Promise<AuthzUserRecord | null>;
}

export interface ProjectAccessRepo {
  isMember(userId: string, projectId: string): Promise<boolean>;
  listAccessibleProjectIds(userId: string): Promise<string[]>;
}

export interface AuditEntry {
  actorId: string;
  targetUserId?: string;
  action: string;
  detail: Record<string, unknown>;
}

export interface AuditRepo {
  record(entry: AuditEntry): Promise<void>;
}
