import { describe, it, expect } from "vitest";
import { signInternalV2, verifyInternalV2 } from "../src/lib/hmac.js";

/**
 * Vetor de PARIDADE: o mesmo teste (mesmos hexes) existe no front (src/lib/server/hmac.test.ts).
 * Se os dois passam, `signInternalV2` (backend) e `signInternalRequestV2` (BFF) batem byte-a-byte —
 * pré-requisito pra Fase 2 (enforce). Também prova o binding método+path. [hardening T5]
 */
const SECRET = "vector-secret";
const TS = 1700000000000;

describe("HMAC v2 — vetor de paridade + binding", () => {
  it("vetor GET body vazio", () => {
    expect(signInternalV2(SECRET, { method: "GET", path: "/tasks/mine", body: "", timestamp: TS })).toBe(
      "b5c16f12e2b339862a6fd7b5bb70a7913bd22821495f49b7fa987c32b64c7a35",
    );
  });
  it("vetor POST com body", () => {
    expect(signInternalV2(SECRET, { method: "POST", path: "/tasks", body: '{"title":"x"}', timestamp: TS })).toBe(
      "0fccf316c8ec5ad9b407e064481de678e1a458694f81fc60582891bbf84440b2",
    );
  });
  it("path diferente muda a assinatura (mata reuso cross-endpoint de GET vazio)", () => {
    const a = signInternalV2(SECRET, { method: "GET", path: "/tasks/mine", body: "", timestamp: TS });
    const b = signInternalV2(SECRET, { method: "GET", path: "/projects/1/tasks", body: "", timestamp: TS });
    expect(a).not.toBe(b);
  });
  it("método diferente muda a assinatura", () => {
    const a = signInternalV2(SECRET, { method: "GET", path: "/tasks/1", body: "", timestamp: TS });
    const b = signInternalV2(SECRET, { method: "DELETE", path: "/tasks/1", body: "", timestamp: TS });
    expect(a).not.toBe(b);
  });
});

describe("verifyInternalV2 — auth primária da Fase 2", () => {
  const base = { method: "POST", path: "/tasks", body: '{"title":"x"}' };
  const sign = (ts: number, over: Partial<typeof base> = {}) =>
    signInternalV2(SECRET, { ...base, ...over, timestamp: ts });

  it("assinatura válida dentro da janela passa", () => {
    const ts = 1700000000000;
    const signature = sign(ts);
    expect(verifyInternalV2({ secret: SECRET, ...base, timestamp: ts, signature, nowMs: ts }).ok).toBe(true);
  });

  it("método diferente do assinado falha (binding)", () => {
    const ts = 1700000000000;
    const signature = sign(ts, { method: "GET" }); // assinou GET
    const r = verifyInternalV2({ secret: SECRET, ...base, timestamp: ts, signature, nowMs: ts }); // verifica POST
    expect(r.ok).toBe(false);
  });

  it("path diferente do assinado falha (binding)", () => {
    const ts = 1700000000000;
    const signature = sign(ts, { path: "/projects" });
    const r = verifyInternalV2({ secret: SECRET, ...base, timestamp: ts, signature, nowMs: ts });
    expect(r.ok).toBe(false);
  });

  it("body adulterado falha", () => {
    const ts = 1700000000000;
    const signature = sign(ts);
    const r = verifyInternalV2({ secret: SECRET, ...base, body: '{"title":"y"}', timestamp: ts, signature, nowMs: ts });
    expect(r.ok).toBe(false);
  });

  it("fora da janela (replay) falha", () => {
    const ts = 1700000000000;
    const signature = sign(ts);
    const r = verifyInternalV2({ secret: SECRET, ...base, timestamp: ts, signature, nowMs: ts + 31_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/replay/);
  });

  it("assinatura ausente/malformada falha", () => {
    const ts = 1700000000000;
    expect(verifyInternalV2({ secret: SECRET, ...base, timestamp: ts, signature: "", nowMs: ts }).ok).toBe(false);
    expect(verifyInternalV2({ secret: SECRET, ...base, timestamp: ts, signature: "zz", nowMs: ts }).ok).toBe(false);
  });

  it("segredo errado falha", () => {
    const ts = 1700000000000;
    const signature = sign(ts);
    expect(verifyInternalV2({ secret: "outro", ...base, timestamp: ts, signature, nowMs: ts }).ok).toBe(false);
  });
});
