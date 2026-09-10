import { PERMISSIONS } from "@sistema-tasks/contracts";
import type { Authorizer } from "../authz/authorizer.js";
import type { SessionContext } from "../authz/types.js";

/**
 * `estimatedMinutes` é INSUMO de custo: só pode ir no payload de quem tem `custos.ver` no cliente.
 * Sem o direito, o campo vira `null` na resposta (mesma regra do valor de custo, que já é gated). [SEC-custo]
 */
export function redactCost<T extends { estimatedMinutes: number | null }>(task: T, canSeeCost: boolean): T {
  return canSeeCost ? task : { ...task, estimatedMinutes: null };
}

/**
 * Redige uma lista que pode cruzar vários clientes (ex.: "minhas tarefas"): resolve `custos.ver`
 * UMA vez por projeto distinto (dedup) e aplica a cada tarefa. [SEC-custo]
 */
export async function redactCostList<T extends { estimatedMinutes: number | null; projectId: string }>(
  tasks: T[],
  session: SessionContext,
  authz: Authorizer,
): Promise<T[]> {
  const distinct = [...new Set(tasks.map((t) => t.projectId))];
  const canByProject = new Map<string, boolean>();
  await Promise.all(
    distinct.map(async (pid) => {
      canByProject.set(pid, await authz.can(session, PERMISSIONS.custos_ver, pid));
    }),
  );
  return tasks.map((t) => redactCost(t, canByProject.get(t.projectId) ?? false));
}
