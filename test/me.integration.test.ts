import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { signInternal } from "../src/lib/hmac.js";
import { TokenService } from "../src/modules/auth/token.service.js";
import { makeAuthenticate } from "../src/modules/authz/authenticate.js";
import { InMemoryAuthzUserRepo } from "../src/modules/authz/memory-repos.js";

const SECRET = "internal-test";
let app: FastifyInstance;
let tokens: TokenService;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.INTERNAL_API_SECRET = SECRET;
  tokens = new TokenService({
    accessSecret: "a",
    refreshSecret: "r",
    issuer: "iss",
    audience: "aud",
    accessTtlSec: 900,
    refreshTtlSec: 1000,
  });
  const users = new InMemoryAuthzUserRepo().add({
    id: "u1",
    orgId: "o1",
    deletedAt: null,
    tokenVersion: 0,
    mustChangePassword: false,
    rolePermissions: ["tarefas.criar"],
    extraPermissions: ["membros.ver"],
  });
  app = buildApp({ authenticate: makeAuthenticate({ tokens, users }), tokenService: tokens });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function get(url: string, bearer?: string) {
  const ts = Date.now();
  const headers: Record<string, string> = {
    "x-internal-timestamp": String(ts),
    "x-internal-signature": signInternal(SECRET, "", ts),
  };
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  return app.inject({ method: "GET", url, headers });
}

describe("/me (integração)", () => {
  it("com token válido → 200 com permissões efetivas", async () => {
    const token = tokens.signAccess({ userId: "u1", orgId: "o1", tokenVersion: 0 });
    const res = await get("/me", token);
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.userId).toBe("u1");
    expect(b.permissions).toContain("tarefas.criar");
    expect(b.permissions).toContain("membros.ver");
  });

  it("sem token → 401", async () => {
    const res = await get("/me");
    expect(res.statusCode).toBe(401);
  });
});
