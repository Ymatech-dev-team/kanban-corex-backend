/**
 * Idempotência de criação: mesma Idempotency-Key → mesmo recurso (duplo-clique/retry
 * não duplica). O store é injetado (testável com um in-memory). [design.md §5 JOR-6]
 */

export interface IdempotencyStore {
  // Escopado por usuário — a chave é (userId, key), não global. [SEC-501]
  get(userId: string, key: string): Promise<{ resultId: string } | null>;
  put(userId: string, key: string, resultId: string): Promise<void>;
}

export interface WithIdempotencyResult<T> {
  result: T | { id: string };
  reused: boolean;
}

export async function withIdempotency<T extends { id: string }>(
  store: IdempotencyStore,
  key: string | undefined,
  userId: string,
  create: () => Promise<T>,
): Promise<WithIdempotencyResult<T>> {
  if (!key) {
    return { result: await create(), reused: false };
  }
  const existing = await store.get(userId, key);
  if (existing) {
    return { result: { id: existing.resultId }, reused: true };
  }
  const result = await create();
  await store.put(userId, key, result.id);
  return { result, reused: false };
}
