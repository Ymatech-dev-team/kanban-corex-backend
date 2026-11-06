import type { Prisma, PrismaClient } from "@prisma/client";
import { AppError } from "../../lib/errors.js";

/** Task lock first, matching workflow init/commands. Check and write share a transaction. */
export async function withLegacyTaskWrite<T>(
  db: PrismaClient,
  enabled: boolean,
  taskId: string,
  write: (tx: Prisma.TransactionClient) => Promise<T>,
  options: { orgId?: string; alwaysTransaction?: boolean } = {},
): Promise<T> {
  if (!enabled) return options.alwaysTransaction ? db.$transaction(write) : write(db);
  return db.$transaction(async (tx) => {
    const rows = options.orgId
      ? await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM tasks WHERE id=${taskId} AND "orgId"=${options.orgId} FOR UPDATE`
      : await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM tasks WHERE id=${taskId} FOR UPDATE`;
    if (!rows.length) throw new AppError("NAO_ENCONTRADO", "Tarefa não encontrada");
    const workflows = await tx.$queryRaw<Array<{ taskId: string }>>`SELECT "taskId" FROM task_workflows WHERE "taskId"=${taskId}`;
    if (workflows.length) throw new AppError("CONFLITO", "Esta tarefa usa o fluxo de revisão. Atualize a entrega pela aba Resumo ou Revisão.");
    return write(tx);
  });
}
