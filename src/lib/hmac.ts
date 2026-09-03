import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Barreira interna BFF→API. O BFF assina cada requisição; a API verifica.
 * Um vazamento do CORS não basta — sem a assinatura HMAC + JWT, a chamada não passa.
 * [design.md §1.1, SEC-002]
 */

const DEFAULT_WINDOW_MS = 30_000;

export function signInternal(secret: string, body: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export interface VerifyInput {
  secret: string;
  body: string;
  timestamp: number;
  signature: string;
  nowMs?: number;
  windowMs?: number;
}

export function verifyInternal(input: VerifyInput): { ok: boolean; reason?: string } {
  const now = input.nowMs ?? Date.now();
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;

  if (!Number.isFinite(input.timestamp)) {
    return { ok: false, reason: "timestamp inválido" };
  }
  if (Math.abs(now - input.timestamp) > windowMs) {
    return { ok: false, reason: "timestamp fora da janela (replay)" };
  }
  if (!input.signature || !/^[0-9a-f]+$/i.test(input.signature)) {
    return { ok: false, reason: "assinatura ausente/malformada" };
  }

  const expected = Buffer.from(signInternal(input.secret, input.body, input.timestamp), "hex");
  const provided = Buffer.from(input.signature, "hex");
  if (expected.length !== provided.length) {
    return { ok: false, reason: "assinatura inválida" };
  }
  if (!timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "assinatura inválida" };
  }
  return { ok: true };
}
