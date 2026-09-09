export interface EngagementRecord {
  id: string;
  orgId: string;
  projectId: string; // Cliente dono
  name: string;
  description: string | null;
  createdById: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewEngagement {
  orgId: string;
  projectId: string;
  name: string;
  description?: string;
  createdById: string;
}

/** Item da lista de projetos do cliente (com contagens para o card). */
export interface EngagementListItem extends EngagementRecord {
  taskCount: number;
  consultorCount: number;
  isGeneral: boolean; // "Projeto geral" (id gen-<clienteId>) — não pode ser excluído se for o último
}

export interface EngagementMemberView {
  id: string;
  name: string;
}

export interface EngagementRepo {
  create(e: NewEngagement, id?: string): Promise<EngagementRecord>;
  findById(id: string, orgId: string): Promise<EngagementRecord | null>;
  listByProject(projectId: string, orgId: string): Promise<EngagementListItem[]>;
  update(id: string, data: { name?: string; description?: string | null }): Promise<EngagementRecord>;
  softDeleteWithTasks(id: string, batchId: string): Promise<void>;
  countActiveByProject(projectId: string, orgId: string): Promise<number>;
}

export interface EngagementMemberRepo {
  add(engagementId: string, userId: string): Promise<void>;
  remove(engagementId: string, userId: string): Promise<void>;
  list(engagementId: string): Promise<EngagementMemberView[]>;
  /** Remove a participação do usuário em TODOS os projetos de um cliente (cascata ao revogar acesso). [RF-42] */
  removeUserFromClientEngagements(projectId: string, userId: string): Promise<void>;
  /** Anula o responsável só nas tarefas DAQUELE projeto atribuídas ao usuário. [RF-44/SEC-110] */
  nullAssigneesInEngagement(engagementId: string, userId: string): Promise<void>;
}
