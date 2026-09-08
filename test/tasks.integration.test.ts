import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import { buildApp } from "../src/app.js";
import { signInternal } from "../src/lib/hmac.js";
import { TokenService } from "../src/modules/auth/token.service.js";
import { makeAuthenticate } from "../src/modules/authz/authenticate.js";
import { Authorizer } from "../src/modules/authz/authorizer.js";
import { InMemoryAuthzUserRepo } from "../src/modules/authz/memory-repos.js";
import { InMemoryProjectAccessRepo } from "../src/modules/projects/memory-repos.js";
import { InMemoryTaskRepo, InMemorySubtaskRepo } from "../src/modules/tasks/memory-repos.js";
import { InMemoryIdempotencyStore } from "../src/lib/idempotency-store.js";
import { TaskService } from "../src/modules/tasks/task.service.js";

const SECRET = "internal-test";
const P = "p1";
let app: FastifyInstance;
let tokens: TokenService;
let access: InMemoryProjectAccessRepo;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.INTERNAL_API_SECRET = SECRET;
  tokens = new TokenService({
    accessSecret: "a", refreshSecret: "r", issuer: "iss", audience: "aud", accessTtlSec: 900, refreshTtlSec: 1000,
  });
  const users = new InMemoryAuthzUserRepo()
    .add({ id: "u1", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false,
      rolePermissions: [PERMISSIONS.tarefas_criar, PERMISSIONS.tarefas_editar, PERMISSIONS.tarefas_mover, PERMISSIONS.tarefas_excluir, PERMISSIONS.subtarefas_gerenciar], extraPermissions: [] })
    .add({ id: "u2", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false,
      rolePermissions: [PERMISSIONS.tarefas_mover, PERMISSIONS.tarefas_criar], extraPermissions: [] });
  access = new InMemoryProjectAccessRepo().addUser("u1", "o1").addUser("u2", "o1");
  access.grant(P, "u1");
  const taskService = new TaskService(new InMemoryTaskRepo(), new InMemorySubtaskRepo(), access, new InMemoryIdempotencyStore());
  app = buildApp({
    authenticate: makeAuthenticate({ tokens, users }),
    authorizer: new Authorizer(access),
    taskService,
    tokenService: tokens,
  });
  await app.ready();
});
afterAll(async () => { await app.close(); });

function token(u: string) { return tokens.signAccess({ userId: u, orgId: "o1", tokenVersion: 0 }); }
function call(method: string, url: string, u: string, body?: unknown, extra: Record<string, string> = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const ts = Date.now();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token(u)}`,
    "x-internal-timestamp": String(ts),
    "x-internal-signature": signInternal(SECRET, payload, ts),
    ...extra,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({ method: method as "GET", url, headers, payload: body === undefined ? undefined : payload });
}

describe("tarefas (5b)", () => {
  let taskId: string;

  it("u1 cria tarefa no cliente → 200", async () => {
    const res = await call("POST", `/projects/${P}/tasks`, "u1", { title: "Revisar contrato", priority: "MEDIUM" });
    expect(res.statusCode).toBe(200);
    taskId = res.json().id;
    expect(taskId).toBeTruthy();
  });

  it("u1 lista tarefas do cliente → contém a tarefa", async () => {
    const res = await call("GET", `/projects/${P}/tasks`, "u1");
    expect(res.statusCode).toBe(200);
    expect(res.json().tasks.map((t: { id: string }) => t.id)).toContain(taskId);
  });

  it("u2 sem acesso ao cliente → lista responde 404", async () => {
    const res = await call("GET", `/projects/${P}/tasks`, "u2");
    expect(res.statusCode).toBe(404);
  });

  it("u1 edita prioridade → 200", async () => {
    const res = await call("PATCH", `/tasks/${taskId}`, "u1", { priority: "HIGH" });
    expect(res.statusCode).toBe(200);
    expect(res.json().priority).toBe("HIGH");
  });

  it("u1 define e edita horas estimadas (estimatedMinutes)", async () => {
    const created = await call("POST", `/projects/${P}/tasks`, "u1", { title: "Com horas", estimatedMinutes: 90 });
    expect(created.statusCode).toBe(200);
    expect(created.json().estimatedMinutes).toBe(90);
    const patched = await call("PATCH", `/tasks/${created.json().id}`, "u1", { estimatedMinutes: 120 });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().estimatedMinutes).toBe(120);
  });

  it("edição com If-Unmodified-Since velho → 409 (conflito)", async () => {
    const res = await call("PATCH", `/tasks/${taskId}`, "u1", { title: "X" }, {
      "if-unmodified-since": "2020-01-01T00:00:00.000Z",
    });
    expect(res.statusCode).toBe(409);
  });

  it("u1 move a tarefa → 200 e é idempotente", async () => {
    const a = await call("PATCH", `/tasks/${taskId}/move`, "u1", { status: "DONE", position: 5 });
    expect(a.statusCode).toBe(200);
    const b = await call("PATCH", `/tasks/${taskId}/move`, "u1", { status: "DONE", position: 5 });
    expect(b.statusCode).toBe(200);
    expect(b.json().position).toBe(5);
  });

  it("u2 com permissão de mover mas SEM acesso → 403 PROJETO_SEM_ACESSO (ejeta board)", async () => {
    const res = await call("PATCH", `/tasks/${taskId}/move`, "u2", { status: "TODO", position: 1 });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("PROJETO_SEM_ACESSO");
  });

  it("mover tarefa inexistente → 404 TAREFA_REMOVIDA", async () => {
    const res = await call("PATCH", `/tasks/nao-existe/move`, "u1", { status: "TODO", position: 1 });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("TAREFA_REMOVIDA");
  });

  it("Idempotency-Key: dois POST iguais criam UMA tarefa", async () => {
    const key = { "idempotency-key": "k-abc-1" };
    const r1 = await call("POST", `/projects/${P}/tasks`, "u1", { title: "Única" }, key);
    const r2 = await call("POST", `/projects/${P}/tasks`, "u1", { title: "Única" }, key);
    expect(r1.json().id).toBe(r2.json().id);
  });

  it("responsável sem acesso ao cliente → 400; com acesso → 200", async () => {
    const bad = await call("POST", `/projects/${P}/tasks`, "u1", { title: "T", assigneeId: "u2" });
    expect(bad.statusCode).toBe(400);
    access.grant(P, "u2");
    const ok = await call("POST", `/projects/${P}/tasks`, "u1", { title: "T", assigneeId: "u2" });
    expect(ok.statusCode).toBe(200);
  });

  it("subtarefas: adicionar e listar no detalhe", async () => {
    const add = await call("POST", `/tasks/${taskId}/subtasks`, "u1", { title: "Passo 1" });
    expect(add.statusCode).toBe(200);
    const detail = await call("GET", `/tasks/${taskId}`, "u1");
    expect(detail.json().subtasks).toHaveLength(1);
  });

  it("minhas tarefas é interseccionado com acesso: revogar esconde (SEC-107)", async () => {
    // cria tarefa atribuída a u2 (u2 tem acesso agora)
    await call("POST", `/projects/${P}/tasks`, "u1", { title: "Do u2", assigneeId: "u2" });
    const before = await call("GET", `/tasks/mine`, "u2");
    expect(before.json().tasks.length).toBeGreaterThan(0);
    access.revoke(P, "u2");
    const after = await call("GET", `/tasks/mine`, "u2");
    expect(after.json().tasks).toHaveLength(0);
  });
});
