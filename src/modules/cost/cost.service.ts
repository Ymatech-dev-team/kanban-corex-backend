import { taskCost } from "./calc.js";
import type { CostRepo, CostSummary, OrgRepo, PerPersonCost, TaskCostResult } from "./types.js";

/** Agrega custo por cliente e calcula custo de tarefa. Único consumidor de remuneração (via CostRepo). */
export class CostService {
  constructor(
    private readonly org: OrgRepo,
    private readonly repo: CostRepo,
  ) {}

  async taskCost(orgId: string, taskId: string): Promise<{ result: TaskCostResult; projectId: string } | null> {
    const row = await this.repo.taskCostRow(taskId, orgId);
    if (!row) return null;
    const monthlyHours = await this.org.getMonthlyHours(orgId);
    return { result: taskCost(row, monthlyHours), projectId: row.projectId };
  }

  async summary(orgId: string, projectId: string): Promise<CostSummary> {
    const [rows, monthlyHours] = await Promise.all([
      this.repo.projectCostRows(projectId, orgId),
      this.org.getMonthlyHours(orgId),
    ]);
    let realizadoCents = 0;
    let planejadoCents = 0;
    const incompletos = { semResponsavel: 0, semRemuneracao: 0, semHoras: 0, respSemAcesso: 0 };
    const people = new Map<string, PerPersonCost>();

    for (const row of rows) {
      const c = taskCost(row, monthlyHours);
      const done = row.status === "DONE";
      if (c.state === "OK" && c.cents != null && row.assigneeId) {
        const p =
          people.get(row.assigneeId) ??
          { userId: row.assigneeId, name: row.assigneeName ?? "", realizadoCents: 0, planejadoCents: 0, horasAbertoMin: 0 };
        if (done) {
          realizadoCents += c.cents;
          p.realizadoCents += c.cents;
        } else {
          planejadoCents += c.cents;
          p.planejadoCents += c.cents;
          p.horasAbertoMin += row.estimatedMinutes ?? 0;
        }
        people.set(row.assigneeId, p);
      } else {
        if (c.state === "SEM_RESPONSAVEL") incompletos.semResponsavel++;
        else if (c.state === "SEM_REMUNERACAO") incompletos.semRemuneracao++;
        else if (c.state === "SEM_HORAS") incompletos.semHoras++;
        else if (c.state === "RESPONSAVEL_SEM_ACESSO") incompletos.respSemAcesso++;
      }
    }

    return {
      realizadoCents,
      planejadoCents,
      incompletos,
      porPessoa: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)),
      moeda: "BRL",
    };
  }
}
