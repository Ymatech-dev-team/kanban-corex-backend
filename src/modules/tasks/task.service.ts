import { AUDITABLE_FIELDS, PERMISSIONS, type TaskStatus } from "@sistema-tasks/contracts";
import type { CreateTaskInput, UpdateTaskInput } from "@sistema-tasks/contracts";
import { AppError } from "../../lib/errors.js";
import { withIdempotency, type IdempotencyStore } from "../../lib/idempotency.js";
import type { SessionContext } from "../authz/types.js";
import type { ProjectAccessRepo } from "../projects/types.js";
import { generalEngagementId } from "../engagements/general.js";
import type {
  ActivityPayload,
  ActivityRecord,
  ActivityRepo,
  CommentRecord,
  CommentRepo,
  FeedCursor,
  FeedItem,
  FeedPage,
  ListAllResult,
  SubtaskRepo,
  TaskFilterOpts,
  TaskPatch,
  TaskRecord,
  TaskRepo,
} from "./types.js";

/** cursor opaco do feed: "<createdAt ISO>|<src>|<id>". src desempata cross-tabela no mesmo ms. */
function srcOf(item: FeedItem): "a" | "c" {
  return item.type === "COMMENT" ? "c" : "a";
}
function rankOf(src: "a" | "c"): number {
  return src === "a" ? 1 : 0; // no mesmo ms, eventos (a) aparecem antes de comentários (c)
}
function encodeCursor(item: FeedItem): string {
  return `${item.createdAt}|${srcOf(item)}|${item.id}`;
}
function decodeCursor(c: string): FeedCursor | null {
  const parts = c.split("|");
  if (parts.length < 3) return null;
  const [iso, src, ...idParts] = parts;
  const d = new Date(iso);
  const id = idParts.join("|");
  if (Number.isNaN(d.getTime()) || (src !== "a" && src !== "c") || !id) return null;
  return { createdAt: d, src, id };
}
function eventToItem(e: ActivityRecord): FeedItem {
  return {
    id: e.id,
    createdAt: e.createdAt.toISOString(),
    type: e.type,
    actorId: e.actorId,
    actorName: e.actorName,
    payload: e.payload,
  };
}
function commentToItem(c: CommentRecord, userId: string, canModerate: boolean): FeedItem {
  const deleted = c.deletedAt != null;
  return {
    id: c.id,
    createdAt: c.createdAt.toISOString(),
    type: "COMMENT",
    actorId: c.authorId,
    actorName: c.authorName,
    payload: {},
    body: deleted ? null : c.body, // tombstone: mantém o slot na timeline [SEC-107]
    editedAt: c.editedAt ? c.editedAt.toISOString() : null,
    canManage: !deleted && (c.authorId === userId || canModerate),
  };
}

export class TaskService {
  constructor(
    private readonly tasks: TaskRepo,
    private readonly subtasks: SubtaskRepo,
    private readonly access: ProjectAccessRepo,
    private readonly idempotency: IdempotencyStore,
    private readonly activity?: ActivityRepo,
    private readonly comments?: CommentRepo,
  ) {}

  /**
   * Registra evento(s) da linha do tempo APÓS a mutação já persistida — NÃO-fatal.
   * Múltiplos eventos de UMA operação são gravados EM SEQUÊNCIA (await entre eles) para preservar a
   * ordem no feed (createdAt monotônico). Se o log falhar, a operação principal não é afetada. [detalhe-tarefa B, review]
   */
  private recordActivity(
    orgId: string,
    taskId: string,
    actorId: string,
    events: Array<{ type: string; payload: ActivityPayload }>,
  ): void {
    const repo = this.activity;
    if (!repo || events.length === 0) return;
    void (async () => {
      for (const e of events) await repo.record({ taskId, orgId, actorId, type: e.type, payload: e.payload });
    })().catch((err) => {
      // log-only [SEC-302]: atividade é secundária, mas falha não deve sumir silenciosamente
      console.warn(`[activity] falha ao gravar evento da tarefa ${taskId}:`, err instanceof Error ? err.message : err);
    });
  }

  /** Feed unificado: funde eventos (imutáveis) + comentários (mutáveis) por (createdAt, id) desc. [detalhe-tarefa C] */
  async listFeed(
    task: TaskRecord,
    session: SessionContext,
    opts: { limit?: number; cursor?: string },
    canModerate: boolean,
  ): Promise<FeedPage> {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 50);
    const before = opts.cursor ? decodeCursor(opts.cursor) : null;
    // busca limit+1 de CADA fonte pra saber se há próxima página após o merge.
    const [events, comments] = await Promise.all([
      this.activity ? this.activity.listSince(task.id, task.orgId, before, limit + 1) : Promise.resolve([]),
      this.comments ? this.comments.listSince(task.id, task.orgId, before, limit + 1) : Promise.resolve([]),
    ]);
    const merged: FeedItem[] = [
      ...events.map(eventToItem),
      ...comments.map((c) => commentToItem(c, session.userId, canModerate)),
    ].sort((a, b) => {
      const ta = Date.parse(a.createdAt);
      const tb = Date.parse(b.createdAt);
      // mesma ordem total do keyset dos repos: (createdAt desc, rank(src) desc, id desc)
      return tb - ta || rankOf(srcOf(b)) - rankOf(srcOf(a)) || (a.id < b.id ? 1 : -1);
    });
    const hasMore = merged.length > limit;
    const page = merged.slice(0, limit);
    const last = page[page.length - 1];
    return { items: page, nextCursor: hasMore && last ? encodeCursor(last) : null };
  }

  // ---- comentários [detalhe-tarefa C] ----

  async addComment(session: SessionContext, task: TaskRecord, body: string, idempotencyKey?: string) {
    if (!this.comments) throw new AppError("INTERNO", "Comentários indisponíveis");
    const repo = this.comments;
    const { result } = await withIdempotency(this.idempotency, idempotencyKey, session.userId, async () =>
      repo.create({ taskId: task.id, orgId: task.orgId, authorId: session.userId, body }),
    );
    // reuso idempotente devolve só {id} → rebusca o comentário completo (como o create de tarefa). [review C1 #1]
    if (!("body" in result)) {
      const full = await repo.findById(result.id, task.orgId);
      if (!full) throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
      return full;
    }
    return result;
  }

  /** Resolve o comentário garantindo tenant + que pertence à tarefa. */
  async getCommentOrThrow(task: TaskRecord, commentId: string): Promise<CommentRecord> {
    if (!this.comments) throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
    const c = await this.comments.findById(commentId, task.orgId);
    if (!c || c.taskId !== task.id || c.deletedAt) throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
    return c;
  }

  async editComment(task: TaskRecord, commentId: string, body: string): Promise<CommentRecord> {
    if (!this.comments) throw new AppError("INTERNO", "Comentários indisponíveis");
    return this.comments.update(commentId, task.id, task.orgId, body);
  }

  async deleteComment(task: TaskRecord, commentId: string): Promise<void> {
    if (!this.comments) throw new AppError("INTERNO", "Comentários indisponíveis");
    await this.comments.softDelete(commentId, task.id, task.orgId);
  }

  /** Responsável precisa ter acesso ao cliente (senão a tarefa nasce órfã / vaza). [SEC-107] */
  private async assertAssigneeAccess(assigneeId: string | null | undefined, projectId: string): Promise<void> {
    if (!assigneeId) return;
    if (!(await this.access.isMember(assigneeId, projectId))) {
      throw new AppError("VALIDACAO", "O responsável não tem acesso a este cliente");
    }
  }

  async getOrThrow(session: SessionContext, id: string): Promise<TaskRecord> {
    const t = await this.tasks.findById(id, session.orgId);
    if (!t) throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
    return t;
  }

  async create(
    session: SessionContext,
    projectId: string,
    input: CreateTaskInput,
    idempotencyKey?: string,
    engagementId?: string,
  ): Promise<TaskRecord> {
    await this.assertAssigneeAccess(input.assigneeId ?? null, projectId);
    // Sem engagement explícito (endpoint antigo por cliente), cai no "Projeto geral" do cliente. [hierarquia-projetos]
    const targetEngagement = engagementId ?? generalEngagementId(projectId);
    const status: TaskStatus = input.status ?? "TODO";
    const { result } = await withIdempotency(this.idempotency, idempotencyKey, session.userId, async () => {
      const position = (await this.tasks.maxPositionByEngagement(targetEngagement, status)) + 1;
      return this.tasks.create({
        orgId: session.orgId,
        projectId,
        engagementId: targetEngagement,
        title: input.title,
        description: input.description,
        status,
        priority: input.priority ?? "MEDIUM",
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        assigneeId: input.assigneeId ?? null,
        estimatedMinutes: input.estimatedMinutes ?? null,
        position,
        createdById: session.userId,
      });
    });
    // Em reuso, withIdempotency devolve só {id} → rebusca o recurso completo.
    if (!("title" in result)) {
      const task = await this.getOrThrow(session, result.id);
      // Defense-in-depth: só devolve o recurso reusado se o usuário acessa o projeto dele. [SEC-501]
      const hasAccess =
        session.permissions.has(PERMISSIONS.projetos_acessar_todos) ||
        (await this.access.isMember(session.userId, task.projectId));
      if (!hasAccess) throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
      return task;
    }
    this.recordActivity(result.orgId, result.id, session.userId, [{ type: "CREATED", payload: {} }]);
    return result;
  }

  async update(
    session: SessionContext,
    task: TaskRecord,
    patch: UpdateTaskInput,
    ifUnmodifiedSince?: string,
  ): Promise<TaskRecord> {
    if (ifUnmodifiedSince && task.updatedAt.toISOString() !== ifUnmodifiedSince) {
      throw new AppError("CONFLITO", "A tarefa foi alterada por outra pessoa. Recarregue.");
    }
    const data: TaskPatch = {
      title: patch.title,
      description: patch.description,
      status: patch.status,
      priority: patch.priority,
      dueDate: patch.dueDate === undefined ? undefined : patch.dueDate ? new Date(patch.dueDate) : null,
      estimatedMinutes: patch.estimatedMinutes,
    };
    const updated = await this.tasks.update(task.id, data);

    // eventos: status separado; demais campos auditáveis (allowlist — NUNCA estimatedMinutes/custo). [SEC-S3]
    const dueChanged =
      data.dueDate !== undefined && (data.dueDate?.getTime() ?? null) !== (task.dueDate?.getTime() ?? null);
    const changed = AUDITABLE_FIELDS.filter((f) => {
      if (f === "title") return patch.title !== undefined && patch.title.trim() !== task.title;
      if (f === "description") return patch.description !== undefined && (patch.description ?? null) !== task.description;
      if (f === "priority") return patch.priority !== undefined && patch.priority !== task.priority;
      if (f === "dueDate") return dueChanged;
      return false;
    });
    const events: Array<{ type: string; payload: ActivityPayload }> = [];
    if (patch.status !== undefined && patch.status !== task.status) {
      events.push({ type: "STATUS_CHANGED", payload: { from: task.status, to: patch.status } });
    }
    if (changed.length > 0) events.push({ type: "FIELD_EDITED", payload: { fields: changed } });
    this.recordActivity(task.orgId, task.id, session.userId, events);
    return updated;
  }

  /** Mover no Kanban — erro discrimina "removida" (404) de "perdeu acesso" (403 → ejeta board). [JOR-1c] */
  async move(session: SessionContext, id: string, status: TaskStatus, position: number): Promise<TaskRecord> {
    const task = await this.tasks.findById(id, session.orgId);
    if (!task) throw new AppError("TAREFA_REMOVIDA", "Essa tarefa foi removida");
    if (!session.permissions.has(PERMISSIONS.tarefas_mover)) {
      throw new AppError("SEM_PERMISSAO", "Você não tem permissão para isso");
    }
    const hasAccess =
      session.permissions.has(PERMISSIONS.projetos_acessar_todos) ||
      (await this.access.isMember(session.userId, task.projectId));
    if (!hasAccess) {
      throw new AppError("PROJETO_SEM_ACESSO", "Seu acesso a este cliente foi removido");
    }
    const moved = await this.tasks.move(id, status, position);
    if (status !== task.status) {
      this.recordActivity(task.orgId, task.id, session.userId, [
        { type: "STATUS_CHANGED", payload: { from: task.status, to: status } },
      ]);
    }
    return moved;
  }

  async softDelete(id: string): Promise<void> {
    await this.tasks.softDelete(id);
  }

  // ---- responsáveis (principal em Task.assigneeId + extras) [detalhe-tarefa A1] ----

  /** Adiciona responsável. Se a tarefa ainda não tem principal, o primeiro adicionado vira principal. */
  async addAssignee(session: SessionContext, task: TaskRecord, userId: string): Promise<TaskRecord> {
    await this.assertAssigneeAccess(userId, task.projectId);
    if (task.assigneeId === userId) {
      throw new AppError("VALIDACAO", "Essa pessoa já é a responsável principal");
    }
    const alreadyExtra = task.extraAssigneeIds.includes(userId);
    if (task.assigneeId == null) {
      await this.tasks.promoteToPrimary(task.id, userId, task.orgId); // primeiro responsável = principal (custo/card)
    } else {
      await this.tasks.addExtraAssignee(task.id, userId, task.orgId);
    }
    // só registra se houve mudança real (re-add idempotente não gera evento-fantasma). [review]
    if (!alreadyExtra) {
      this.recordActivity(task.orgId, task.id, session.userId, [{ type: "ASSIGNEE_ADDED", payload: { userId } }]);
    }
    return this.getOrThrow(session, task.id);
  }

  /** Remove um responsável. Se for o principal, promove o extra mais antigo (ou fica sem responsável). */
  async removeAssignee(session: SessionContext, task: TaskRecord, userId: string): Promise<TaskRecord> {
    const wasPrimary = task.assigneeId === userId;
    const wasExtra = task.extraAssigneeIds.includes(userId);
    if (wasPrimary) {
      await this.tasks.clearPrimaryPromotingOldest(task.id, task.orgId);
    } else if (wasExtra) {
      await this.tasks.removeExtraAssignee(task.id, userId, task.orgId);
    }
    const fresh = await this.getOrThrow(session, task.id);
    // nada mudou (userId não era responsável) → sem evento-fantasma. [review, SEC-301]
    if (wasPrimary || wasExtra) {
      const events: Array<{ type: string; payload: ActivityPayload }> = [
        { type: "ASSIGNEE_REMOVED", payload: { userId } },
      ];
      // se o principal saiu e outro foi promovido, registra a troca (em sequência, após o REMOVED)
      if (wasPrimary && fresh.assigneeId) {
        events.push({ type: "PRIMARY_CHANGED", payload: { userId: fresh.assigneeId } });
      }
      this.recordActivity(task.orgId, task.id, session.userId, events);
    }
    return fresh;
  }

  /** Torna um responsável (existente ou novo com acesso) o principal — o principal atual vira extra. */
  async setPrimaryAssignee(session: SessionContext, task: TaskRecord, userId: string): Promise<TaskRecord> {
    if (task.assigneeId === userId) return task;
    await this.assertAssigneeAccess(userId, task.projectId);
    await this.tasks.promoteToPrimary(task.id, userId, task.orgId);
    this.recordActivity(task.orgId, task.id, session.userId, [{ type: "PRIMARY_CHANGED", payload: { userId } }]);
    return this.getOrThrow(session, task.id);
  }

  async listByProject(orgId: string, projectId: string, filters: TaskFilterOpts): Promise<{ tasks: TaskRecord[] }> {
    return { tasks: await this.tasks.listByProject(projectId, orgId, filters) };
  }

  async listByEngagement(
    orgId: string,
    engagementId: string,
    filters: TaskFilterOpts,
  ): Promise<{ tasks: TaskRecord[] }> {
    return { tasks: await this.tasks.listByEngagement(engagementId, orgId, filters) };
  }

  /** Escopo de leitura do usuário: "all" (acessar_todos) ou a lista de clientes acessíveis. [SEC-107] */
  private async resolveScope(session: SessionContext): Promise<"all" | string[]> {
    return session.permissions.has(PERMISSIONS.projetos_acessar_todos)
      ? "all"
      : this.access.listAccessibleProjectIds(session.userId);
  }

  /** "Minhas tarefas" — SEMPRE interseccionado com os projetos acessíveis. [SEC-107] */
  async listMine(session: SessionContext, filters: TaskFilterOpts): Promise<{ tasks: TaskRecord[] }> {
    const scope = await this.resolveScope(session);
    return { tasks: await this.tasks.listMine(session.userId, scope, session.orgId, filters) };
  }

  /** Visão global: todas as tarefas do escopo acessível, com filtros. orgId sempre cercado no repo. [tarefas-visao-global] */
  async listAll(session: SessionContext, filters: TaskFilterOpts): Promise<ListAllResult> {
    const scope = await this.resolveScope(session);
    return this.tasks.listAll(scope, session.orgId, filters);
  }

  // ---- subtarefas ----
  async listSubtasks(taskId: string) {
    return this.subtasks.listByTask(taskId);
  }

  async getTaskOfSubtaskOrThrow(session: SessionContext, subtaskId: string): Promise<TaskRecord> {
    const taskId = await this.subtasks.findTaskId(subtaskId);
    if (!taskId) throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
    return this.getOrThrow(session, taskId);
  }

  async addSubtask(session: SessionContext, task: TaskRecord, title: string, idempotencyKey?: string) {
    const { result, reused } = await withIdempotency(this.idempotency, idempotencyKey, session.userId, async () => {
      const position = (await this.subtasks.maxPosition(task.id)) + 1;
      return this.subtasks.create(task.id, title, position);
    });
    if (!reused) this.recordActivity(task.orgId, task.id, session.userId, [{ type: "SUBTASK_ADDED", payload: { title } }]);
    return result;
  }

  async updateSubtask(session: SessionContext, task: TaskRecord, id: string, patch: { title?: string; done?: boolean }) {
    const updated = await this.subtasks.update(id, patch);
    if (patch.done === true) {
      this.recordActivity(task.orgId, task.id, session.userId, [{ type: "SUBTASK_DONE", payload: { title: updated.title } }]);
    }
    return updated;
  }

  async removeSubtask(session: SessionContext, task: TaskRecord, id: string): Promise<void> {
    await this.subtasks.remove(id);
    this.recordActivity(task.orgId, task.id, session.userId, [{ type: "SUBTASK_REMOVED", payload: {} }]);
  }
}
