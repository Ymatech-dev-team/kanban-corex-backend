export interface ProjectRecord {
  id: string;
  orgId: string;
  name: string;
  description: string | null;
  createdById: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewProject {
  orgId: string;
  name: string;
  description?: string;
  createdById: string;
}

export interface ProjectRepo {
  create(p: NewProject): Promise<ProjectRecord>;
  /** Só ativos (deletedAt null) e da org. */
  findById(id: string, orgId: string): Promise<ProjectRecord | null>;
  listByOrg(orgId: string): Promise<ProjectRecord[]>;
  listByIds(ids: string[], orgId: string): Promise<ProjectRecord[]>;
  update(id: string, data: { name?: string; description?: string | null }): Promise<ProjectRecord>;
  /** Soft-delete do projeto + cascata nas tarefas, marcando o mesmo deletionBatchId. [JOR-2c] */
  softDeleteWithTasks(id: string, batchId: string): Promise<void>;
}

/** Membro de um cliente/projeto, o suficiente pra escolher responsável. */
export interface ProjectMemberView {
  id: string;
  name: string;
}

/** Acesso por cliente/projeto (a fronteira entre clientes). Read + write. */
export interface ProjectAccessRepo {
  isMember(userId: string, projectId: string): Promise<boolean>;
  listAccessibleProjectIds(userId: string): Promise<string[]>; // compatível com authz
  grant(projectId: string, userId: string): Promise<void>;
  revoke(projectId: string, userId: string): Promise<void>;
  listMembers(projectId: string): Promise<ProjectMemberView[]>;
  /** Ao revogar acesso, tarefas onde o usuário era responsável ficam sem responsável. [SEC-110] */
  nullAssigneesInProject(projectId: string, userId: string): Promise<void>;
  userExistsInOrg(userId: string, orgId: string): Promise<boolean>;
}
