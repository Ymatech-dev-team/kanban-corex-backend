import type { CostRow, TaskCostResult } from "./types.js";

/**
 * Custo estimado de uma tarefa, em centavos. Função pura, determinística.
 * Ordem dos estados de incompleto: responsável → acesso → horas → remuneração.
 * Nunca retorna 0 por falta de dado (incompleto tem cents null). [design §3]
 */
export function taskCost(row: CostRow, monthlyHours: number): TaskCostResult {
  if (!row.assigneeId) return { state: "SEM_RESPONSAVEL", cents: null };
  if (!row.assigneeIsMember) return { state: "RESPONSAVEL_SEM_ACESSO", cents: null };
  if (row.estimatedMinutes == null) return { state: "SEM_HORAS", cents: null };
  if (!row.compType || row.compCents == null || row.compCents <= 0) {
    return { state: "SEM_REMUNERACAO", cents: null };
  }
  const cents =
    row.compType === "HOURLY"
      ? Math.round((row.compCents * row.estimatedMinutes) / 60)
      : Math.round((row.compCents * row.estimatedMinutes) / (monthlyHours * 60));
  return { state: "OK", cents };
}
