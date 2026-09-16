import type { PrismaClient } from "@prisma/client";
import type { NotificationRepo, NotificationRow } from "./types.js";

const ASSIGN_TYPES = ["ASSIGNEE_ADDED", "PRIMARY_CHANGED"];

export class PrismaNotificationRepo implements NotificationRepo {
  constructor(private readonly db: PrismaClient) {}

  async listAssignmentsForRecipient(
    orgId: string,
    recipientId: string,
    scope: string[] | "all",
    since: Date,
    limit: number,
  ): Promise<NotificationRow[]> {
    const rows = await this.db.taskActivity.findMany({
      where: {
        orgId, // cross-org sempre no WHERE [SEC]
        type: { in: ASSIGN_TYPES },
        actorId: { not: recipientId }, // não notifica quem se auto-atribui
        createdAt: { gt: since },
        payload: { path: ["userId"], equals: recipientId }, // eu fui o atribuído
        task: { deletedAt: null, ...(scope === "all" ? {} : { projectId: { in: scope } }) },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      distinct: ["taskId"], // 1 por tarefa (o evento mais recente)
      take: limit,
      select: {
        id: true,
        taskId: true,
        actorName: true,
        type: true,
        createdAt: true,
        task: { select: { title: true } },
      },
    });
    return rows.map((r) => ({
      id: r.id,
      taskId: r.taskId,
      title: r.task.title,
      actorName: r.actorName,
      type: r.type,
      createdAt: r.createdAt,
    }));
  }
}
