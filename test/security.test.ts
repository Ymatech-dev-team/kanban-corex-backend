import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { signInternal } from "../src/lib/hmac.js";

const SECRET = "test-secret-xyz";
let app: FastifyInstance;

beforeAll(async () => {
  delete process.env.DATABASE_URL; // testa a camada transversal, sem o caminho de auth de produção
  process.env.INTERNAL_API_SECRET = SECRET;
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function hmacHeaders(body = "", ts = Date.now()) {
  return {
    "x-internal-timestamp": String(ts),
    "x-internal-signature": signInternal(SECRET, body, ts),
  };
}

describe("segurança transversal", () => {
  it("/health é público e traz headers de segurança (helmet)", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["content-security-policy"]).toBeTruthy();
  });

  it("rota protegida sem HMAC → 401", async () => {
    const res = await app.inject({ method: "GET", url: "/internal/ping" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe("NAO_AUTENTICADO");
  });

  it("rota protegida com HMAC válido → 200", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/ping",
      headers: hmacHeaders(""),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pong: true });
  });

  it("HMAC com timestamp expirado → 401 (anti-replay)", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/internal/ping",
      headers: hmacHeaders("", Date.now() - 60_000),
    });
    expect(res.statusCode).toBe(401);
  });

  it("rota inexistente → 404 com contrato de erro", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/nao-existe",
      headers: hmacHeaders(""),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NAO_ENCONTRADO");
  });
});
