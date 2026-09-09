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
  const editar = [PERMISSIONS.tarefas_criar, PERMISSIONS.tarefas_editar];
  const users = new InMemoryAuthzUserRepo()
    .add({ id: "u1", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: editar, extraPermissions: [] })
    .add({ id: "u2", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: editar, extraPermissions: [] })
    .add({ id: "u3", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: editar, extraPermissions: [] });
  access = new InMemoryProjectAccessRepo().addUser("u1", "o1", "Ana").addUser("u2", "o1", "Bia").addUser("u3", "o1", "Caio");
  access.grant(P, "u1");
  access.grant(P, "u2"); // u2 tem acesso ao cliente; u3 NÃO
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
function call(method: string, url: string, u: string, body?: unknown) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const ts = Date.now();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token(u)}`,
    "x-internal-timestamp": String(ts),
    "x-internal-signature": signInternal(SECRET, payload, ts),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({ method: method as "GET", url, headers, payload: body === undefined ? undefined : payload });
}

async function newTask(): Promise<string> {
  const res = await call("POST", `/projects/${P}/tasks`, "u1", { title: "Tarefa" });
  return res.json().id;
}

describe("responsáveis (detalhe-tarefa A)", () => {
  it("primeiro responsável adicionado vira PRINCIPAL; segundo vira extra", async () => {
    const id = await newTask();
    const a = await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u1" });
    expect(a.statusCode).toBe(200);
    expect(a.json().assigneeId).toBe("u1");
    expect(a.json().extraAssigneeIds).toEqual([]);

    const b = await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u2" });
    expect(b.statusCode).toBe(200);
    expect(b.json().assigneeId).toBe("u1");
    expect(b.json().extraAssigneeIds).toEqual(["u2"]);
  });

  it("adicionar responsável sem acesso ao cliente → 400", async () => {
    const id = await newTask();
    const res = await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u3" });
    expect(res.statusCode).toBe(400);
  });

  it("adicionar quem já é principal → 400", async () => {
    const id = await newTask();
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u1" });
    const dup = await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u1" });
    expect(dup.statusCode).toBe(400);
  });

  it("tornar um extra principal troca o principal (o antigo vira extra)", async () => {
    const id = await newTask();
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u1" });
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u2" });
    const res = await call("POST", `/tasks/${id}/assignees/u2/primary`, "u1");
    expect(res.statusCode).toBe(200);
    expect(res.json().assigneeId).toBe("u2");
    expect(res.json().extraAssigneeIds).toEqual(["u1"]);
  });

  it("remover o principal promove o extra mais antigo", async () => {
    const id = await newTask();
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u1" }); // principal
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u2" }); // extra
    const res = await call("DELETE", `/tasks/${id}/assignees/u1`, "u1");
    expect(res.statusCode).toBe(200);
    expect(res.json().assigneeId).toBe("u2");
    expect(res.json().extraAssigneeIds).toEqual([]);
  });

  it("remover o último responsável deixa a tarefa sem responsável", async () => {
    const id = await newTask();
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u1" });
    const res = await call("DELETE", `/tasks/${id}/assignees/u1`, "u1");
    expect(res.statusCode).toBe(200);
    expect(res.json().assigneeId).toBeNull();
    expect(res.json().extraAssigneeIds).toEqual([]);
  });

  it("remover um extra some só ele", async () => {
    const id = await newTask();
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u1" });
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u2" });
    const res = await call("DELETE", `/tasks/${id}/assignees/u2`, "u1");
    expect(res.json().assigneeId).toBe("u1");
    expect(res.json().extraAssigneeIds).toEqual([]);
  });

  it("'minhas tarefas' inclui quem é responsável EXTRA", async () => {
    const id = await newTask();
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u1" }); // principal
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u2" }); // extra
    const mine = await call("GET", `/tasks/mine`, "u2");
    expect(mine.json().tasks.map((t: { id: string }) => t.id)).toContain(id);
  });

  it("filtro por responsável casa principal OU extra", async () => {
    const id = await newTask();
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u1" });
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u2" });
    const res = await call("GET", `/projects/${P}/tasks?assigneeId=u2`, "u1");
    expect(res.json().tasks.map((t: { id: string }) => t.id)).toContain(id);
  });

  it("PATCH /tasks/:id ignora assigneeId (principal só muda pelas rotas /assignees) [C1]", async () => {
    const id = await newTask();
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u1" }); // principal = u1
    // tentativa de trocar o principal pela rota antiga + adicionar via campo
    const res = await call("PATCH", `/tasks/${id}`, "u1", { title: "Novo título", assigneeId: "u2" });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe("Novo título"); // título muda
    expect(res.json().assigneeId).toBe("u1"); // principal NÃO muda
    expect(res.json().extraAssigneeIds).toEqual([]); // u2 não entrou como extra
  });

  it("tarefa de outra org → 404 (cross-org)", async () => {
    // u1 é da o1; tarefa inexistente/de outra org
    const res = await call("POST", `/tasks/nao-existe/assignees`, "u1", { userId: "u1" });
    expect(res.statusCode).toBe(404);
  });
});
