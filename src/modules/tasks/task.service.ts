import { PERMISSIONS, type TaskStatus } from "@sistema-tasks/contracts";
import type { CreateTaskInput, UpdateTaskInput } from "@sistema-tasks/contracts";
import { AppError } from "../../lib/errors.js";
import { withIdempotency, type IdempotencyStore } from "../../lib/idempotency.js";
import type { SessionContext } from "../authz/types.js";
import type { ProjectAccessRepo } from "../projects/types.js";
import type { SubtaskRepo, TaskFilterOpts, TaskPatch, TaskRecord, TaskRepo } from "./types.js";

export class TaskService {
  constructor(
    private readonly tasks: TaskRepo,
    private readonly subtasks: SubtaskRepo,
    private readonly access: ProjectAccessRepo,
    private readonly idempotency: IdempotencyStore,
  ) {}

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
  ): Promise<TaskRecord> {
    await this.assertAssigneeAccess(input.assigneeId ?? null, projectId);
    const status: TaskStatus = input.status ?? "TODO";
    const { result } = await withIdempotency(this.idempotency, idempotencyKey, session.userId, async () => {
      const position = (await this.tasks.maxPosition(projectId, status)) + 1;
      return this.tasks.create({
        orgId: session.orgId,
        projectId,
        title: input.title,
        description: input.description,
        status,
        priority: input.priority ?? "MEDIUM",
        dueDate: input.dueDate ? new Date(input.dueDate) : null,
        assigneeId: input.assigneeId ?? null,
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
    if (patch.assigneeId !== undefined) {
      await this.assertAssigneeAccess(patch.assigneeId, task.projectId);
    }
    const data: TaskPatch = {
      title: patch.title,
      description: patch.description,
      status: patch.status,
      priority: patch.priority,
      dueDate: patch.dueDate === undefined ? undefined : patch.dueDate ? new Date(patch.dueDate) : null,
      assigneeId: patch.assigneeId,
    };
    return this.tasks.update(task.id, data);
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
    return this.tasks.move(id, status, position);
  }

  async softDelete(id: string): Promise<void> {
    await this.tasks.softDelete(id);
  }

  async listByProject(projectId: string, filters: TaskFilterOpts): Promise<{ tasks: TaskRecord[] }> {
    return { tasks: await this.tasks.listByProject(projectId, filters) };
  }

  /** "Minhas tarefas" — SEMPRE interseccionado com os projetos acessíveis. [SEC-107] */
  async listMine(session: SessionContext, filters: TaskFilterOpts): Promise<{ tasks: TaskRecord[] }> {
    const projectIds = session.permissions.has(PERMISSIONS.projetos_acessar_todos)
      ? ("all" as const)
      : await this.access.listAccessibleProjectIds(session.userId);
    return { tasks: await this.tasks.listMine(session.userId, projectIds, session.orgId, filters) };
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

  async addSubtask(session: SessionContext, taskId: string, title: string, idempotencyKey?: string) {
    const { result } = await withIdempotency(this.idempotency, idempotencyKey, session.userId, async () => {
      const position = (await this.subtasks.maxPosition(taskId)) + 1;
      return this.subtasks.create(taskId, title, position);
    });
    return result;
  }

  async updateSubtask(id: string, patch: { title?: string; done?: boolean }) {
    return this.subtasks.update(id, patch);
  }

  async removeSubtask(id: string): Promise<void> {
    await this.subtasks.remove(id);
  }
}
