import type { PrismaClient, Prisma } from "@prisma/client";
import type {
  AuditEntry,
  AuditRepo,
  AuthzUserRecord,
  AuthzUserRepo,
  ProjectAccessRepo,
} from "./types.js";

export class PrismaAuthzUserRepo implements AuthzUserRepo {
  constructor(private readonly db: PrismaClient) {}
  async findById(id: string): Promise<AuthzUserRecord | null> {
    const u = await this.db.user.findUnique({ where: { id }, include: { role: true } });
    if (!u) return null;
    return {
      id: u.id,
      orgId: u.orgId,
      deletedAt: u.deletedAt,
      tokenVersion: u.tokenVersion,
      mustChangePassword: u.mustChangePassword,
      rolePermissions: u.role?.permissions ?? [],
      extraPermissions: u.extraPermissions,
      name: u.name,
      email: u.email,
    };
  }
}

export class PrismaProjectAccessRepo implements ProjectAccessRepo {
  constructor(private readonly db: PrismaClient) {}
  async isMember(userId: string, projectId: string): Promise<boolean> {
    const m = await this.db.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    return m !== null;
  }
  async listAccessibleProjectIds(userId: string): Promise<string[]> {
    const rows = await this.db.projectMember.findMany({
      where: { userId },
      select: { projectId: true },
    });
    return rows.map((r) => r.projectId);
  }
}

export class PrismaAuditRepo implements AuditRepo {
  constructor(private readonly db: PrismaClient) {}
  async record(entry: AuditEntry): Promise<void> {
    await this.db.permissionAudit.create({
      data: {
        actorId: entry.actorId,
        targetUserId: entry.targetUserId ?? null,
        action: entry.action,
        detail: entry.detail as Prisma.InputJsonValue,
      },
    });
  }
}
