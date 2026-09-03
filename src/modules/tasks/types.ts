import type { TaskStatus, TaskPriority } from "@sistema-tasks/contracts";

export interface TaskRecord {
  id: string;
  orgId: string;
  projectId: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: Date | null;
  assigneeId: string | null;
  position: number;
  createdById: string;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewTask {
  orgId: string;
  projectId: string;
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: Date | null;
  assigneeId?: string | null;
  position: number;
  createdById: string;
}

export interface TaskPatch {
  title?: string;
  description?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority;
  dueDate?: Date | null;
  assigneeId?: string | null;
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
  listByProject(projectId: string, filters: TaskFilterOpts): Promise<TaskRecord[]>;
  listMine(userId: string, projectIds: string[] | "all", orgId: string, filters: TaskFilterOpts): Promise<TaskRecord[]>;
  update(id: string, patch: TaskPatch): Promise<TaskRecord>;
  move(id: string, status: TaskStatus, position: number): Promise<TaskRecord>;
  softDelete(id: string): Promise<void>;
  maxPosition(projectId: string, status: TaskStatus): Promise<number>;
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
