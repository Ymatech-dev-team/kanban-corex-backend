import type { TaskStatus, TaskPriority } from "@sistema-tasks/contracts";

export interface TaskRecord {
  id: string;
  orgId: string;
  projectId: string;
  engagementId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  assigneeId: string | null; // responsável PRINCIPAL (autoritativo p/ custo/card) [detalhe-tarefa A1]
  extraAssigneeIds: string[]; // responsáveis EXTRAS (task_assignees); NÃO inclui o principal
  estimatedMinutes: number | null;
  position: number;
  createdById: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTask {
  orgId: string;
  projectId: string;
  engagementId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: Date | null;
  assigneeId?: string | null;
  estimatedMinutes?: number | null;
  position: number;
  createdById: string;
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | null;
  // assigneeId NÃO entra: o principal é gerido pelas rotas /assignees (promoteToPrimary/clear). [detalhe-tarefa A1]
  estimatedMinutes?: number | null;
}

export interface TaskFilterOpts {
  status?: TaskStatus;
  priority?: TaskPriority;
  assigneeId?: string;
  limit?: number;
  cursor?: string;
}

export interface TaskRepo {
  create(t: NewTask): Promise<TaskRecord>;
  findById(id: string, orgId: string): Promise<TaskRecord | null>;
  listByProject(projectId: string, orgId: string, filters: TaskFilterOpts): Promise<TaskRecord[]>;
  listByEngagement(engagementId: string, orgId: string, filters: TaskFilterOpts): Promise<TaskRecord[]>;
  listMine(userId: string, projectIds: string[] | "all", orgId: string, filters: TaskFilterOpts): Promise<TaskRecord[]>;
  update(id: string, patch: TaskPatch): Promise<TaskRecord>;
  move(id: string, status: TaskStatus, position: number): Promise<TaskRecord>;
  softDelete(id: string): Promise<void>;
  maxPositionByEngagement(engagementId: string, status: TaskStatus): Promise<number>;
  // responsáveis extras [detalhe-tarefa A1]. orgId sempre no WHERE (defense-in-depth cross-org) [SEC-A04]
  addExtraAssignee(taskId: string, userId: string, orgId: string): Promise<void>;
  removeExtraAssignee(taskId: string, userId: string, orgId: string): Promise<void>;
  /** Torna userId o principal: o principal atual (se houver) vira extra; userId sai dos extras. Atômico. */
  promoteToPrimary(taskId: string, userId: string, orgId: string): Promise<void>;
  /** Remove o principal atual e promove o extra mais antigo (ou null se não houver). Atômico. */
  clearPrimaryPromotingOldest(taskId: string, orgId: string): Promise<void>;
}

export interface SubtaskRecord {
  id: string;
  taskId: string;
  title: string;
  done: boolean;
  position: number;
  createdAt: Date;
}

export interface SubtaskRepo {
  create(taskId: string, title: string, position: number): Promise<SubtaskRecord>;
  listByTask(taskId: string): Promise<SubtaskRecord[]>;
  findTaskId(subtaskId: string): Promise<string | null>;
  update(id: string, patch: { title?: string; done?: boolean }): Promise<SubtaskRecord>;
  remove(id: string): Promise<void>;
  maxPosition(taskId: string): Promise<number>;
}
