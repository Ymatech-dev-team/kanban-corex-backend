import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { AppError } from "../../lib/errors.js";

/**
 * Throttle das mutações sensíveis de auth (change-password / first-login) por USUÁRIO — barra um access
 * token roubado tentando brute-forçar a senha. Store distribuído (Upstash REST) porque o backend roda
 * serverless na Vercel (em memória seria per-lambda = inútil). Login segue com o lockout por-e-mail. [T2]
 *
 * Modo de falha (decisão do painel):
 *  - CONFIG em prod (DATABASE_URL presente e sem UPSTASH_*) → fail-CLOSED: a rota lança (não vira
 *    controle-fantasma silencioso). dev/test → no-op.
 *  - RUNTIME (Upstash timeout/erro) → fail-OPEN observável (loga) — o lockout por-e-mail já é o
 *    controle primário fail-closed; não travamos o app por indisponibilidade do secundário.
 */
let limiter: Ratelimit | null | undefined; // undefined = não inicializado; null = no-op (dev/test)

function getLimiter(): Ratelimit | null {
  if (limiter !== undefined) return limiter;
  // Testes nunca falam com o Upstash (evita rede + falso fail-closed).
  if (process.env.VITEST) {
    limiter = null;
    return null;
  }
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    if (process.env.DATABASE_URL) {
      // prod sem o store → fail-closed no controle (a rota falha em vez de pular o limite silenciosamente).
      throw new AppError("INTERNO", "UPSTASH_REDIS_REST_URL/TOKEN obrigatórios em produção (rate limit)");
    }
    limiter = null; // dev/test local sem env → no-op
    return null;
  }
  const redis = new Redis({ url, token });
  limiter = new Ratelimit({
    redis,
    limiter: Ratelimit.slidingWindow(10, "15 m"), // 10 tentativas / 15 min por usuário
    prefix: "rl:auth",
    ephemeralCache: new Map(), // corta round-trip pra id já bloqueado (não ajuda o caminho feliz)
  });
  return limiter;
}

/** Consome uma tentativa do usuário; lança 429 se estourar. Fail-open observável no runtime. [T2] */
export async function limitAuthAttempt(
  userId: string,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<void> {
  const rl = getLimiter(); // erro de CONFIG (prod sem Upstash) propaga = fail-closed
  if (!rl) return; // dev/test sem env → no-op
  let success = true;
  try {
    ({ success } = await rl.limit(userId));
  } catch (e) {
    // runtime do Upstash caiu → fail-open, mas LOGA (senão o controle some sem ninguém saber).
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
