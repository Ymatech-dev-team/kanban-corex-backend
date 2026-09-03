import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { signInternal } from "../src/lib/hmac.js";
import { TokenService } from "../src/modules/auth/token.service.js";
import { PasswordService } from "../src/modules/auth/password.service.js";
import { RefreshService } from "../src/modules/auth/refresh.service.js";
import { LockoutService } from "../src/modules/auth/lockout.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import {
  InMemoryUserRepo,
  InMemoryRefreshRepo,
  InMemoryLockoutStore,
} from "../src/modules/auth/memory-repos.js";

const SECRET = "internal-test";
let app: FastifyInstance;
let users: InMemoryUserRepo;

beforeAll(async () => {
  process.env.INTERNAL_API_SECRET = SECRET;
  const tokens = new TokenService({
    accessSecret: "a",
    refreshSecret: "r",
    issuer: "iss",
    audience: "aud",
    accessTtlSec: 900,
    refreshTtlSec: 3600,
  });
  const passwords = new PasswordService(10);
  users = new InMemoryUserRepo();
  users.add({
    id: "u1",
    orgId: "o1",
    email: "joao@x.com",
    passwordHash: await passwords.hash("senha-correta"),
    roleId: null,
    mustChangePassword: false,
    tokenVersion: 0,
    deletedAt: null,
  });
  users.add({
    id: "u2",
    orgId: "o1",
    email: "novo@x.com",
    passwordHash: await passwords.hash("temp-123"),
    roleId: null,
    mustChangePassword: true,
    tokenVersion: 0,
    deletedAt: null,
  });
  users.add({
    id: "u3",
    orgId: "o1",
    email: "reset@x.com",
    passwordHash: await passwords.hash("temp-abc"),
    roleId: null,
    mustChangePassword: true,
    tokenVersion: 0,
    deletedAt: null,
  });
  const svc = new AuthService({
    users,
    tokens,
    passwords,
    refresh: new RefreshService(new InMemoryRefreshRepo(), tokens, {
      refreshTtlSec: 3600,
      familyTtlSec: 3600,
      graceMs: 10_000,
    }),
    lockout: new LockoutService(new InMemoryLockoutStore(5)),
  });
  app = buildApp({ authService: svc, tokenService: tokens });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function post(url: string, payloadObj: unknown, extraHeaders: Record<string, string> = {}) {
  const body = JSON.stringify(payloadObj);
  const ts = Date.now();
  return app.inject({
    method: "POST",
    url,
    payload: body,
    headers: {
      "content-type": "application/json",
      "x-internal-timestamp": String(ts),
      "x-internal-signature": signInternal(SECRET, body, ts),
      ...extraHeaders,
    },
  });
}

describe("auth (integração)", () => {
  it("senha errada → 401 genérico", async () => {
    const res = await post("/auth/login", { email: "joao@x.com", password: "errada" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("email ou senha inválidos");
  });

  it("email inexistente → mesma mensagem genérica", async () => {
    const res = await post("/auth/login", { email: "ninguem@x.com", password: "x" });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.message).toBe("email ou senha inválidos");
  });

  it("login correto → 200 com tokens", async () => {
    const res = await post("/auth/login", { email: "joao@x.com", password: "senha-correta" });
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.accessToken).toBeTruthy();
    expect(b.refreshToken).toBeTruthy();
    expect(b.mustChangePassword).toBe(false);
  });

  it("refresh rotaciona e reuso do antigo falha", async () => {
    const login = await post("/auth/login", { email: "joao@x.com", password: "senha-correta" });
    const { refreshToken } = login.json();
    const r1 = await post("/auth/refresh", { refreshToken });
    expect(r1.statusCode).toBe(200);
    const reuse = await post("/auth/refresh", { refreshToken });
    expect(reuse.statusCode).toBe(401);
  });

  it("first-login troca a senha e limpa a flag", async () => {
    const login = await post("/auth/login", { email: "novo@x.com", password: "temp-123" });
    expect(login.json().mustChangePassword).toBe(true);
    const access = login.json().accessToken;
    const res = await post(
      "/auth/first-login",
      { currentPassword: "temp-123", newPassword: "nova-senha-8", confirmPassword: "nova-senha-8" },
      { authorization: `Bearer ${access}` },
    );
    expect(res.statusCode).toBe(200);
    const relogin = await post("/auth/login", { email: "novo@x.com", password: "nova-senha-8" });
    expect(relogin.statusCode).toBe(200);
    expect(relogin.json().mustChangePassword).toBe(false);
  });

  it("login é case-insensitive no email (normalizado) [SEC-005]", async () => {
    const res = await post("/auth/login", { email: "JOAO@X.com", password: "senha-correta" });
    expect(res.statusCode).toBe(200);
  });

  it("first-login com senha atual errada → 401", async () => {
    const login = await post("/auth/login", { email: "reset@x.com", password: "temp-abc" });
    const access = login.json().accessToken;
    const res = await post(
      "/auth/first-login",
      { currentPassword: "errada", newPassword: "outra-senha-9", confirmPassword: "outra-senha-9" },
      { authorization: `Bearer ${access}` },
    );
    expect(res.statusCode).toBe(401);
  });

  it("trocar a senha revoga o refresh antigo (mata a sessão) [SEC-002]", async () => {
    const login = await post("/auth/login", { email: "reset@x.com", password: "temp-abc" });
    const { accessToken, refreshToken } = login.json();
    await post(
      "/auth/first-login",
      { currentPassword: "temp-abc", newPassword: "senha-nova-9", confirmPassword: "senha-nova-9" },
      { authorization: `Bearer ${accessToken}` },
    );
    // o refresh emitido ANTES da troca não vale mais
    const reuse = await post("/auth/refresh", { refreshToken });
    expect(reuse.statusCode).toBe(401);
  });

  it("refresh de usuário deletado → 401", async () => {
    const login = await post("/auth/login", { email: "joao@x.com", password: "senha-correta" });
    const { refreshToken } = login.json();
    users.markDeleted("u1");
    const res = await post("/auth/refresh", { refreshToken });
    expect(res.statusCode).toBe(401);
    users.add({
      id: "u1",
      orgId: "o1",
      email: "joao@x.com",
      passwordHash: (await new PasswordService(10).hash("senha-correta")),
      roleId: null,
      mustChangePassword: false,
      tokenVersion: 0,
      deletedAt: null,
    });
  });

  it("lockout após 5 falhas → 429", async () => {
    for (let i = 0; i < 5; i++) {
      await post("/auth/login", { email: "lock@x.com", password: "x" });
    }
    const res = await post("/auth/login", { email: "lock@x.com", password: "x" });
    expect(res.statusCode).toBe(429);
  });
});
