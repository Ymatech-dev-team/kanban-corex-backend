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
  // filtros extras da visão global [tarefas-visao-global]
  projectId?: string; // Cliente (intersecta o escopo acessível, nunca substitui)
  engagementId?: string; // Projeto
  dueFrom?: string; // ISO — prazo >=
  dueTo?: string; // ISO — prazo <=
  includeDone?: boolean; // false (default) oculta DONE quando não há status explícito
}

/** Resultado da listagem global: tarefas + sinal de truncamento. [tarefas-visao-global RF-A7] */
export interface ListAllResult {
  tasks: TaskRecord[];
  hasMore: boolean;
}

export interface TaskRepo {
  create(t: NewTask): Promise<TaskRecord>;
  findById(id: string, orgId: string): Promise<TaskRecord | null>;
  listByProject(projectId: string, orgId: string, filters: TaskFilterOpts): Promise<TaskRecord[]>;
  listByEngagement(engagementId: string, orgId: string, filters: TaskFilterOpts): Promise<TaskRecord[]>;
  listMine(userId: string, projectIds: string[] | "all", orgId: string, filters: TaskFilterOpts): Promise<TaskRecord[]>;
  /** Visão global: todas as tarefas do escopo acessível (orgId sempre no WHERE), com filtros. [tarefas-visao-global] */
  listAll(scope: string[] | "all", orgId: string, filters: TaskFilterOpts): Promise<ListAllResult>;
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

// ---- Linha do tempo (atividade) [detalhe-tarefa B] ----
export type ActivityPayload = Record<string, unknown>;

export interface NewActivity {
  taskId: string;
  orgId: string;
  actorId: string;
  type: string;
  payload: ActivityPayload;
}

export interface ActivityRecord {
  id: string;
  taskId: string;
  actorId: string;
  actorName: string;
  type: string;
  payload: ActivityPayload;
  createdAt: Date;
}

/** Cursor keyset compartilhado entre atividade e comentários. `src` desempata cross-tabela no mesmo ms. [review C1 #2] */
export type FeedSource = "a" | "c"; // a = atividade (evento), c = comentário
export interface FeedCursor {
  createdAt: Date;
  src: FeedSource;
  id: string;
}

export interface ActivityRepo {
  /** Grava um evento (snapshot do nome do ator resolvido aqui). Append-only. */
  record(a: NewActivity): Promise<void>;
  /** Linhas mais-recente-primeiro com keyset `< before` (para o merge do feed). */
  listSince(taskId: string, orgId: string, before: FeedCursor | null, limit: number): Promise<ActivityRecord[]>;
}

// ---- Comentários (mutáveis, soft-delete) [detalhe-tarefa C] ----
export interface CommentRecord {
  id: string;
  taskId: string;
  orgId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
}
export interface NewComment {
  taskId: string;
  orgId: string;
  authorId: string;
  body: string;
}
export interface CommentRepo {
  create(c: NewComment): Promise<CommentRecord>;
  findById(id: string, orgId: string): Promise<CommentRecord | null>;
  // taskId + orgId no WHERE (defense-in-depth, não depende da ordem de chamadas). [SEC-C1-004]
  update(id: string, taskId: string, orgId: string, body: string): Promise<CommentRecord>;
  softDelete(id: string, taskId: string, orgId: string): Promise<void>;
  listSince(taskId: string, orgId: string, before: FeedCursor | null, limit: number): Promise<CommentRecord[]>;
}

/** Item unificado do feed (um EVENTO ou um COMENTÁRIO), como a UI consome. [detalhe-tarefa C] */
export interface FeedItem {
  id: string;
  createdAt: string; // ISO
  type: string; // tipo do evento, ou "COMMENT"
  actorId: string;
  actorName: string;
  payload: ActivityPayload;
  // só quando type === "COMMENT":
  body?: string | null; // null = comentário removido (tombstone)
  editedAt?: string | null;
  canManage?: boolean; // autor OU moderador (hint de UI; barreira real é o backend)
}
export interface FeedPage {
  items: FeedItem[];
  nextCursor: string | null;
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
