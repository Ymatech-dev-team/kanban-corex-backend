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
const P1 = "cli-1";
const P2 = "cli-2";
const P3 = "cli-3"; // u1 NÃO acessa
let app: FastifyInstance;
let tokens: TokenService;
const ids: Record<string, string> = {};

const iso = (y: number, m: number, d: number) => new Date(y, m, d, 12, 0, 0).toISOString();

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.INTERNAL_API_SECRET = SECRET;
  tokens = new TokenService({
    accessSecret: "a", refreshSecret: "r", issuer: "iss", audience: "aud", accessTtlSec: 900, refreshTtlSec: 1000,
  });
  const G = PERMISSIONS.tarefas_ver_globais; // ver a aba Tarefas global
  const users = new InMemoryAuthzUserRepo()
    // acesso a P1+P2, com ver_globais, SEM custos_ver, SEM acessar_todos
    .add({ id: "u1", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [G], extraPermissions: [] })
    // ver_globais + custos_ver em P1
    .add({ id: "boss", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [G, PERMISSIONS.custos_ver], extraPermissions: [] })
    // ver_globais + acessar_todos (org o1) + custos_ver
    .add({ id: "super", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [G, PERMISSIONS.projetos_acessar_todos, PERMISSIONS.custos_ver], extraPermissions: [] })
    // acesso a P1, mas SEM a permissão de ver a aba global
    .add({ id: "nope", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [], extraPermissions: [] });

  const access = new InMemoryProjectAccessRepo()
    .addUser("u1", "o1").addUser("boss", "o1").addUser("super", "o1").addUser("nope", "o1");
  access.grant(P1, "u1"); access.grant(P2, "u1"); access.grant(P1, "boss"); access.grant(P1, "nope");

  const taskRepo = new InMemoryTaskRepo();
  const mk = async (key: string, p: { projectId: string; engagementId: string; orgId?: string; status?: "TODO" | "DOING" | "DONE"; priority?: "LOW" | "MEDIUM" | "HIGH"; dueDate?: Date | null; assigneeId?: string | null; estimatedMinutes?: number | null }) => {
    const rec = await taskRepo.create({
      orgId: p.orgId ?? "o1", projectId: p.projectId, engagementId: p.engagementId,
      title: key, status: p.status ?? "TODO", priority: p.priority ?? "MEDIUM",
      dueDate: p.dueDate ?? null, assigneeId: p.assigneeId ?? null,
      estimatedMinutes: p.estimatedMinutes ?? null, position: 1, createdById: "u1",
    });
    ids[key] = rec.id;
    return rec.id;
  };
  await mk("a", { projectId: P1, engagementId: "e1", status: "TODO", priority: "HIGH", dueDate: new Date(iso(2026, 8, 10)), assigneeId: "u1", estimatedMinutes: 60 });
  await mk("b", { projectId: P1, engagementId: "e1", status: "DONE", priority: "LOW", dueDate: new Date(iso(2026, 8, 1)), assigneeId: "u2" });
  await mk("c", { projectId: P2, engagementId: "e2", status: "DOING", priority: "MEDIUM", dueDate: null, assigneeId: "u1" });
  await mk("e", { projectId: P1, engagementId: "e1", status: "TODO", priority: "MEDIUM", dueDate: new Date(iso(2026, 8, 20)), assigneeId: "u2" });
  await mk("d", { projectId: P3, engagementId: "e3", status: "TODO", assigneeId: "u1" }); // P3: u1 sem acesso
  await mk("x", { projectId: "cli-o2", engagementId: "eo2", orgId: "o2", status: "TODO", assigneeId: "u1" }); // outro org
  await taskRepo.addExtraAssignee(ids["c"], "u2", "o1"); // u2 é EXTRA na tarefa c

  const taskService = new TaskService(taskRepo, new InMemorySubtaskRepo(), access, new InMemoryIdempotencyStore());
  app = buildApp({ authenticate: makeAuthenticate({ tokens, users }), authorizer: new Authorizer(access), taskService, tokenService: tokens });
  await app.ready();
});
afterAll(async () => { await app.close(); });

function get(url: string, u: string, orgId = "o1") {
  const ts = Date.now();
  return app.inject({
    method: "GET", url,
    headers: {
      authorization: `Bearer ${tokens.signAccess({ userId: u, orgId, tokenVersion: 0 })}`,
      "x-internal-timestamp": String(ts),
      "x-internal-signature": signInternal(SECRET, "", ts),
    },
  });
}
const idsOf = (res: { json: () => { tasks: { id: string }[] } }) => res.json().tasks.map((t) => t.id);

describe("GET /tasks — visão global", () => {
  it("sem a permissão tarefas.ver_globais → 403 (mesmo com acesso a projeto)", async () => {
    const res = await get("/tasks", "nope");
    expect(res.statusCode).toBe(403);
  });

  it("escopo: u1 vê só P1+P2 acessíveis (não P3 nem outro org); DONE oculto por padrão", async () => {
    const res = await get("/tasks", "u1");
    expect(res.statusCode).toBe(200);
    const got = idsOf(res);
    expect(got).toEqual(expect.arrayContaining([ids["a"], ids["c"], ids["e"]]));
    expect(got).not.toContain(ids["b"]); // DONE oculto
    expect(got).not.toContain(ids["d"]); // sem acesso a P3
    expect(got).not.toContain(ids["x"]); // outro org
  });

  it("tenant: super (acessar_todos, org o1) NÃO recebe tarefa do org o2", async () => {
    const got = idsOf(await get("/tasks?includeDone=true", "super"));
    expect(got).not.toContain(ids["x"]);
    expect(got).toContain(ids["a"]); // enxerga o próprio org
  });

  it("filtro-cliente sem acesso → [] (não vaza)", async () => {
    expect(idsOf(await get(`/tasks?projectId=${P3}`, "u1"))).toEqual([]);
  });

  it("assigneeId casa principal OU extra", async () => {
    const got = idsOf(await get("/tasks?assigneeId=u2", "u1"));
    expect(got).toEqual(expect.arrayContaining([ids["e"], ids["c"]])); // e: principal, c: extra
    expect(got).not.toContain(ids["a"]); // a é do u1
  });

  it("default oculta DONE; includeDone mostra; status=DONE só DONE", async () => {
    expect(idsOf(await get("/tasks", "u1"))).not.toContain(ids["b"]);
    expect(idsOf(await get("/tasks?includeDone=true", "u1"))).toContain(ids["b"]);
    const onlyDone = idsOf(await get("/tasks?status=DONE", "u1"));
    expect(onlyDone).toEqual([ids["b"]]);
  });

  it("range de prazo: dueTo corta os mais tarde; intervalo invertido → 400", async () => {
    const upto = idsOf(await get(`/tasks?dueTo=${encodeURIComponent(iso(2026, 8, 15))}`, "u1"));
    expect(upto).toContain(ids["a"]); // vence 10
    expect(upto).not.toContain(ids["e"]); // vence 20
    const bad = await get(`/tasks?dueFrom=${encodeURIComponent(iso(2026, 8, 20))}&dueTo=${encodeURIComponent(iso(2026, 8, 1))}`, "u1");
    expect(bad.statusCode).toBe(400);
  });

  it("truncamento: limit=1 → hasMore true", async () => {
    const res = await get("/tasks?limit=1", "u1");
    const b = res.json() as { tasks: unknown[]; hasMore: boolean };
    expect(b.tasks).toHaveLength(1);
    expect(b.hasMore).toBe(true);
  });

  it("redação: sem custos.ver → estimatedMinutes null; com → valor real", async () => {
    const asU1 = (await get("/tasks", "u1")).json().tasks.find((t: { id: string }) => t.id === ids["a"]);
    expect(asU1.estimatedMinutes).toBeNull();
    const asBoss = (await get("/tasks", "boss")).json().tasks.find((t: { id: string }) => t.id === ids["a"]);
    expect(asBoss.estimatedMinutes).toBe(60);
  });
});
