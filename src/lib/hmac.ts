import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * Barreira interna BFF→API. O BFF assina cada requisição; a API verifica.
 * Um vazamento do CORS não basta — sem a assinatura HMAC + JWT, a chamada não passa.
 * [design.md §1.1, SEC-002]
 */

const DEFAULT_WINDOW_MS = 30_000;

export function signInternal(secret: string, body: string, timestamp: number): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Assinatura v2 (T5): amarra MÉTODO + PATH (sem query) + hash do body, além do timestamp — fecha o
 * reuso cross-endpoint (um GET de body vazio deixa de valer pra qualquer rota). Path SEM query de
 * propósito (a query normaliza diferente entre fetch/edge e o backend). Separador `\n` (nenhum campo
 * carrega newline cru). DEVE bater byte-a-byte com o `signInternalRequestV2` do BFF. [hardening T5]
 */
export function signInternalV2(
  secret: string,
  input: { method: string; path: string; body: string; timestamp: number },
): string {
  const canonical = `${input.timestamp}\n${input.method.toUpperCase()}\n${input.path}\n${sha256Hex(input.body)}`;
  return createHmac("sha256", secret).update(canonical).digest("hex");
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
  if (!input.signature || !/^[0-9a-f]{64}$/i.test(input.signature)) {
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

export interface VerifyV2Input {
  secret: string;
  method: string;
  path: string;
  body: string;
  timestamp: number;
  signature: string;
  nowMs?: number;
  windowMs?: number;
}

/**
 * Verifica a assinatura v2 (T5): mesmo anti-replay (janela de timestamp) e compare timing-safe do v1,
 * mas contra o canônico método+path+hash(body). Usada como auth primária na Fase 2. [hardening T5]
 */
export function verifyInternalV2(input: VerifyV2Input): { ok: boolean; reason?: string } {
  const now = input.nowMs ?? Date.now();
  const windowMs = input.windowMs ?? DEFAULT_WINDOW_MS;

  if (!Number.isFinite(input.timestamp)) {
    return { ok: false, reason: "timestamp inválido" };
  }
  if (Math.abs(now - input.timestamp) > windowMs) {
    return { ok: false, reason: "timestamp fora da janela (replay)" };
  }
  if (!input.signature || !/^[0-9a-f]{64}$/i.test(input.signature)) {
    return { ok: false, reason: "assinatura ausente/malformada" };
  }

  const expected = Buffer.from(
    signInternalV2(input.secret, {
      method: input.method,
      path: input.path,
      body: input.body,
      timestamp: input.timestamp,
    }),
    "hex",
  );
  const provided = Buffer.from(input.signature, "hex");
  if (expected.length !== provided.length) {
    return { ok: false, reason: "assinatura inválida" };
  }
  if (!timingSafeEqual(expected, provided)) {
    return { ok: false, reason: "assinatura inválida" };
  }
  return { ok: true };
}
