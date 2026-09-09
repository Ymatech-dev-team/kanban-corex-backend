import type { TaskStatus } from "@sistema-tasks/contracts";

/** Jornada mensal padrão (h/mês) quando a org não configurou — espelha o DEFAULT 176 do SQL 004. */
export const DEFAULT_MONTHLY_HOURS = 176;

/** Estado do custo de uma tarefa. Só OK entra nos totais; o resto é "incompleto". */
export type CostState =
  | "OK"
  | "SEM_RESPONSAVEL"
  | "RESPONSAVEL_SEM_ACESSO"
  | "SEM_HORAS"
  | "SEM_REMUNERACAO";

export interface TaskCostResult {
  state: CostState;
  cents: number | null;
}

/** Linha crua pro cálculo — o CostRepo é o ÚNICO que carrega remuneração. */
export interface CostRow {
  taskId: string;
  status: TaskStatus;
  estimatedMinutes: number | null;
  assigneeId: string | null;
  assigneeName: string | null;
  compType: string | null;
  compCents: number | null;
  assigneeIsMember: boolean;
}

export interface PerPersonCost {
  userId: string;
  name: string;
  realizadoCents: number;
  planejadoCents: number;
  horasAbertoMin: number;
}

export interface CostSummary {
  realizadoCents: number;
  planejadoCents: number;
  incompletos: { semResponsavel: number; semRemuneracao: number; semHoras: number; respSemAcesso: number };
  porPessoa: PerPersonCost[];
  moeda: "BRL";
}

export interface OrgRepo {
  getMonthlyHours(orgId: string): Promise<number>;
}

export interface CostRepo {
  projectCostRows(projectId: string, orgId: string): Promise<CostRow[]>;
  engagementCostRows(engagementId: string, projectId: string, orgId: string): Promise<CostRow[]>;
  taskCostRow(taskId: string, orgId: string): Promise<(CostRow & { projectId: string }) | null>;
}
