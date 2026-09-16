import { PERMISSIONS } from "@sistema-tasks/contracts";
import type { SessionContext } from "../authz/types.js";
import type { ProjectAccessRepo } from "../projects/types.js";
import type { NotificationRepo } from "./types.js";

const WINDOW_DAYS = 30; // janela efêmera: não vira caixa de entrada infinita
const LIMIT = 30;

export interface NotificationItem {
  id: string;
  taskId: string;
  title: string;
  actorName: string;
  type: string; // ASSIGNEE_ADDED | PRIMARY_CHANGED
  createdAt: string; // ISO
}

export class NotificationService {
  constructor(
    private readonly repo: NotificationRepo,
    private readonly access: ProjectAccessRepo,
  ) {}

  /** Notificações de atribuição do usuário logado (intersecção com projetos acessíveis). [SEC-107] */
  async listMine(session: SessionContext): Promise<{ notifications: NotificationItem[] }> {
    const scope = session.permissions.has(PERMISSIONS.projetos_acessar_todos)
      ? "all"
      : await this.access.listAccessibleProjectIds(session.userId);
    const since = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
    const rows = await this.repo.listAssignmentsForRecipient(session.orgId, session.userId, scope, since, LIMIT);
    return {
      notifications: rows.map((r) => ({
        id: r.id,
        taskId: r.taskId,
        title: r.title,
        actorName: r.actorName,
        type: r.type,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  }
}
