import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { AppError } from "../../lib/errors.js";

/**
 * Throttle de mutações sensíveis por USUÁRIO — barra um access token roubado. Store distribuído (Upstash
 * REST) porque o backend roda serverless na Vercel (em memória seria per-lambda = inútil). [T2 / conta-redesign]
 *
 * Modo de falha (decisão do painel):
 *  - CONFIG em prod (DATABASE_URL presente e sem UPSTASH_*) → fail-CLOSED: a rota lança (não vira
 *    controle-fantasma silencioso). dev/test → no-op.
 *  - RUNTIME (Upstash timeout/erro) → fail-OPEN observável (loga).
 */
type Logger = { warn: (obj: unknown, msg: string) => void };

const limiters = new Map<string, Ratelimit | null>(); // por chave; null = no-op (dev/test)

function getLimiter(key: string, make: (redis: Redis) => Ratelimit): Ratelimit | null {
  const cached = limiters.get(key);
  if (cached !== undefined) return cached;
  // Testes nunca falam com o Upstash (evita rede + falso fail-closed).
  if (process.env.VITEST) {
    limiters.set(key, null);
    return null;
  }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (process.env.DATABASE_URL) {
      // prod sem o store → fail-closed no controle (a rota falha em vez de pular o limite silenciosamente).
      throw new AppError("INTERNO", "UPSTASH_REDIS_REST_URL/TOKEN obrigatórios em produção (rate limit)");
    }
    limiters.set(key, null); // dev/test local sem env → no-op
    return null;
  }
  const rl = make(new Redis({ url, token }));
  limiters.set(key, rl);
  return rl;
}

/** Consome uma tentativa; lança 429 se estourar. Fail-open observável no runtime. */
async function consume(rl: Ratelimit | null, userId: string, log?: Logger): Promise<void> {
  if (!rl) return; // dev/test sem env → no-op
  let success = true;
  try {
    ({ success } = await rl.limit(userId));
  } catch (e) {
    log?.warn(
      { event: "rate_limit_unavailable", err: e instanceof Error ? e.message : String(e) },
      "rate limit indisponível (fail-open)",
    );
    return;
  }
  if (!success) {
    throw new AppError("MUITAS_TENTATIVAS", "Muitas tentativas. Aguarde e tente de novo.");
  }
}

/** change-password / first-login: 10 tentativas / 15 min por usuário. [T2] */
export async function limitAuthAttempt(userId: string, log?: Logger): Promise<void> {
  const rl = getLimiter(
    "auth",
    (redis) =>
      new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(10, "15 m"),
        prefix: "rl:auth",
        ephemeralCache: new Map(),
      }),
  );
  await consume(rl, userId, log);
}

/** Upload de avatar: 20 trocas / 10 min por usuário — barra churn de put+delete. [conta-redesign] */
export async function limitAvatarUpload(userId: string, log?: Logger): Promise<void> {
  const rl = getLimiter(
    "avatar",
    (redis) =>
      new Ratelimit({
        redis,
        limiter: Ratelimit.slidingWindow(20, "10 m"),
        prefix: "rl:avatar",
        ephemeralCache: new Map(),
      }),
  );
  await consume(rl, userId, log);
}
