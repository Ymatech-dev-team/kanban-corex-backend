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
import { InMemoryTaskRepo, InMemorySubtaskRepo, InMemoryActivityRepo } from "../src/modules/tasks/memory-repos.js";
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
  const perms = [
    PERMISSIONS.tarefas_criar, PERMISSIONS.tarefas_editar, PERMISSIONS.tarefas_mover,
    PERMISSIONS.tarefas_excluir, PERMISSIONS.subtarefas_gerenciar,
  ];
  const users = new InMemoryAuthzUserRepo()
    .add({ id: "u1", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: perms, extraPermissions: [] })
    .add({ id: "u2", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: perms, extraPermissions: [] });
  access = new InMemoryProjectAccessRepo().addUser("u1", "o1", "Ana").addUser("u2", "o1", "Bia");
  access.grant(P, "u1");
  access.grant(P, "u2");
  const activity = new InMemoryActivityRepo().setName("u1", "Ana").setName("u2", "Bia");
  const taskService = new TaskService(
    new InMemoryTaskRepo(), new InMemorySubtaskRepo(), access, new InMemoryIdempotencyStore(), activity,
  );
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
  return (await call("POST", `/projects/${P}/tasks`, "u1", { title: "Tarefa" })).json().id;
}
async function activityTypes(taskId: string): Promise<string[]> {
  const res = await call("GET", `/tasks/${taskId}/activity`, "u1");
  return res.json().items.map((i: { type: string }) => i.type);
}

describe("linha do tempo (detalhe-tarefa B)", () => {
  it("criar tarefa registra CREATED", async () => {
    const id = await newTask();
    expect(await activityTypes(id)).toEqual(["CREATED"]);
  });

  it("mover registra STATUS_CHANGED com from/to; mais recente primeiro", async () => {
    const id = await newTask();
    await call("PATCH", `/tasks/${id}/move`, "u1", { status: "DOING", position: 1 });
    const res = await call("GET", `/tasks/${id}/activity`, "u1");
    const items = res.json().items;
    expect(items[0].type).toBe("STATUS_CHANGED"); // mais recente no topo
    expect(items[0].payload).toEqual({ from: "TODO", to: "DOING" });
    expect(items[items.length - 1].type).toBe("CREATED");
    expect(items[0].actorName).toBe("Ana"); // snapshot do nome
  });

  it("editar título registra FIELD_EDITED; editar SÓ horas NÃO registra (campo sensível)", async () => {
    const id = await newTask();
    await call("PATCH", `/tasks/${id}`, "u1", { title: "Novo" });
    await call("PATCH", `/tasks/${id}`, "u1", { estimatedMinutes: 120 });
    const res = await call("GET", `/tasks/${id}/activity`, "u1");
    const fieldEvents = res.json().items.filter((i: { type: string }) => i.type === "FIELD_EDITED");
    expect(fieldEvents).toHaveLength(1);
    expect(fieldEvents[0].payload).toEqual({ fields: ["title"] });
  });

  it("payload de FIELD_EDITED nunca contém estimatedMinutes/custo [SEC-S3]", async () => {
    const id = await newTask();
    await call("PATCH", `/tasks/${id}`, "u1", { title: "X", estimatedMinutes: 60, priority: "HIGH" });
    const res = await call("GET", `/tasks/${id}/activity`, "u1");
    const fe = res.json().items.find((i: { type: string }) => i.type === "FIELD_EDITED");
    const blob = JSON.stringify(fe.payload);
    expect(blob).not.toContain("estimatedMinutes");
    expect(blob).not.toContain("60");
    expect(fe.payload.fields.sort()).toEqual(["priority", "title"]);
  });

  it("adicionar responsável e subtarefa registram eventos", async () => {
    const id = await newTask();
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u2" });
    await call("POST", `/tasks/${id}/subtasks`, "u1", { title: "passo" });
    const types = await activityTypes(id);
    expect(types).toContain("ASSIGNEE_ADDED");
    expect(types).toContain("SUBTASK_ADDED");
  });

  it("paginação keyset: limit + cursor", async () => {
    const id = await newTask();
    await call("PATCH", `/tasks/${id}/move`, "u1", { status: "DOING", position: 1 });
    await call("PATCH", `/tasks/${id}/move`, "u1", { status: "DONE", position: 1 });
    const p1 = (await call("GET", `/tasks/${id}/activity?limit=2`, "u1")).json();
    expect(p1.items).toHaveLength(2);
    expect(p1.nextCursor).toBeTruthy();
    const p2 = (await call("GET", `/tasks/${id}/activity?limit=2&cursor=${encodeURIComponent(p1.nextCursor)}`, "u1")).json();
    expect(p2.items.length).toBeGreaterThanOrEqual(1);
    const ids1 = p1.items.map((i: { id: string }) => i.id);
    const ids2 = p2.items.map((i: { id: string }) => i.id);
    expect(ids1.some((x: string) => ids2.includes(x))).toBe(false); // sem sobreposição
  });

  it("re-adicionar o mesmo responsável NÃO gera evento duplicado [review]", async () => {
    const id = await newTask();
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u2" });
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u2" }); // idempotente
    const added = (await activityTypes(id)).filter((t) => t === "ASSIGNEE_ADDED");
    expect(added).toHaveLength(1);
  });

  it("remover quem NÃO é responsável não gera evento-fantasma [review/SEC-301]", async () => {
    const id = await newTask();
    await call("DELETE", `/tasks/${id}/assignees/u2`, "u1"); // u2 nunca foi responsável
    expect(await activityTypes(id)).toEqual(["CREATED"]);
  });

  it("remover o principal gera ASSIGNEE_REMOVED antes de PRIMARY_CHANGED (ordem preservada)", async () => {
    const id = await newTask();
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u1" }); // principal
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u2" }); // extra
    await call("DELETE", `/tasks/${id}/assignees/u1`, "u1"); // remove principal → promove u2
    const items = (await call("GET", `/tasks/${id}/activity?limit=50`, "u1")).json().items;
    const seq = items.map((i: { type: string }) => i.type).reverse(); // cronológico
    const iRem = seq.indexOf("ASSIGNEE_REMOVED");
    const iPri = seq.lastIndexOf("PRIMARY_CHANGED");
    expect(iRem).toBeGreaterThanOrEqual(0);
    expect(iPri).toBeGreaterThan(iRem);
  });

  it("GUARD: nenhum payload de nenhum tipo de evento contém chave sensível [SEC-S3]", async () => {
    const id = await newTask();
    await call("PATCH", `/tasks/${id}`, "u1", { title: "T", estimatedMinutes: 90, priority: "HIGH", dueDate: null });
    await call("PATCH", `/tasks/${id}/move`, "u1", { status: "DOING", position: 1 });
    await call("POST", `/tasks/${id}/assignees`, "u1", { userId: "u2" });
    await call("POST", `/tasks/${id}/subtasks`, "u1", { title: "passo" });
    const items = (await call("GET", `/tasks/${id}/activity?limit=50`, "u1")).json().items;
    const forbidden = ["estimatedMinutes", "compensationCents", "compensation", "cents", "salario", "custo"];
    for (const it of items) {
      const blob = JSON.stringify(it.payload).toLowerCase();
      for (const k of forbidden) expect(blob).not.toContain(k.toLowerCase());
    }
  });

  it("GET activity de tarefa de outra org → 404", async () => {
    const res = await call("GET", `/tasks/nao-existe/activity`, "u1");
    expect(res.statusCode).toBe(404);
  });
});
