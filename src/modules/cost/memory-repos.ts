import { DEFAULT_MONTHLY_HOURS, type CostRepo, type CostRow, type OrgRepo } from "./types.js";

export class InMemoryOrgRepo implements OrgRepo {
  constructor(private readonly hours = DEFAULT_MONTHLY_HOURS) {}
  async getMonthlyHours(): Promise<number> {
    return this.hours;
  }
}

/** Dublê: linhas indexadas por `orgId::projectId` e `orgId::taskId` (modela o escopo por org). */
export class InMemoryCostRepo implements CostRepo {
  private byProject = new Map<string, CostRow[]>();
  private byTask = new Map<string, CostRow & { projectId: string }>();

  seedProject(orgId: string, projectId: string, rows: CostRow[]): this {
    this.byProject.set(`${orgId}::${projectId}`, rows);
    return this;
  }
  seedTask(orgId: string, taskId: string, row: CostRow & { projectId: string }): this {
    this.byTask.set(`${orgId}::${taskId}`, row);
    return this;
  }
  async projectCostRows(projectId: string, orgId: string): Promise<CostRow[]> {
    return this.byProject.get(`${orgId}::${projectId}`) ?? [];
  }
  async taskCostRow(taskId: string, orgId: string): Promise<(CostRow & { projectId: string }) | null> {
    return this.byTask.get(`${orgId}::${taskId}`) ?? null;
  }
}
