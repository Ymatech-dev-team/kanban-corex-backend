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
import { InMemoryEngagementRepo, InMemoryEngagementMemberRepo } from "../src/modules/engagements/memory-repos.js";
import { EngagementService } from "../src/modules/engagements/engagement.service.js";
import { InMemoryOrgRepo, InMemoryCostRepo } from "../src/modules/cost/memory-repos.js";
import { CostService } from "../src/modules/cost/cost.service.js";

const SECRET = "internal-test";
const P = "p1";
let app: FastifyInstance;
let tokens: TokenService;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.INTERNAL_API_SECRET = SECRET;
  tokens = new TokenService({
    accessSecret: "a", refreshSecret: "r", issuer: "iss", audience: "aud", accessTtlSec: 900, refreshTtlSec: 1000,
  });
  const engPerms = [
    PERMISSIONS.engagements_criar, PERMISSIONS.engagements_editar,
    PERMISSIONS.engagements_excluir, PERMISSIONS.engagements_consultores, PERMISSIONS.custos_ver,
  ];
  const users = new InMemoryAuthzUserRepo()
    .add({ id: "boss", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: engPerms, extraPermissions: [] })
    .add({ id: "worker", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [], extraPermissions: [] })
    .add({ id: "noacc", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: engPerms, extraPermissions: [] });

  const access = new InMemoryProjectAccessRepo().addUser("boss", "o1").addUser("worker", "o1").addUser("c1", "o1", "Consultor 1").addUser("out", "o1", "Fora");
  access.grant(P, "boss");
  access.grant(P, "worker");
  access.grant(P, "c1"); // c1 é membro do cliente (pode virar consultor)
  // "out" NÃO tem acesso ao cliente; "noacc" também não.

  const engRepo = new InMemoryEngagementRepo().seed({
    id: `gen-${P}`, orgId: "o1", projectId: P, name: "Projeto geral", description: null,
    createdById: "boss", deletedAt: null, createdAt: new Date(0), updatedAt: new Date(0),
  });
  const engMembers = new InMemoryEngagementMemberRepo();
  const engagementService = new EngagementService(engRepo, engMembers, access);
  const taskService = new TaskService(new InMemoryTaskRepo(), new InMemorySubtaskRepo(), access, new InMemoryIdempotencyStore());
  const costRepo = new InMemoryCostRepo().seedEngagement("o1", `gen-${P}`, [
    { taskId: "t1", status: "DONE", estimatedMinutes: 60, assigneeId: "c1", assigneeName: "Consultor 1", compType: "HOURLY", compCents: 4000, assigneeIsMember: true },
  ]);
  const costService = new CostService(new InMemoryOrgRepo(176), costRepo);

  app = buildApp({
    authenticate: makeAuthenticate({ tokens, users }),
    authorizer: new Authorizer(access),
    engagementService, taskService, costService, tokenService: tokens,
  });
  await app.ready();
});
afterAll(async () => { await app.close(); });

function call(method: string, url: string, u: string, body?: unknown) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const ts = Date.now();
  const headers: Record<string, string> = {
    authorization: `Bearer ${tokens.signAccess({ userId: u, orgId: "o1", tokenVersion: 0 })}`,
    "x-internal-timestamp": String(ts),
    "x-internal-signature": signInternal(SECRET, payload, ts),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({ method: method as "GET", url, headers, payload: body === undefined ? undefined : payload });
}

describe("projetos (engagements)", () => {
  let novoId: string;

  it("boss cria projeto no cliente → 200", async () => {
    const res = await call("POST", `/projects/${P}/engagements`, "boss", { name: "Rebranding 2026" });
    expect(res.statusCode).toBe(200);
    novoId = res.json().id;
    expect(novoId).toBeTruthy();
  });

  it("lista traz o Projeto geral (isGeneral) + o novo", async () => {
    const res = await call("GET", `/projects/${P}/engagements`, "boss");
    expect(res.statusCode).toBe(200);
    const list = res.json().engagements as Array<{ id: string; isGeneral: boolean }>;
    expect(list.find((e) => e.id === `gen-${P}`)?.isGeneral).toBe(true);
    expect(list.some((e) => e.id === novoId)).toBe(true);
  });

  it("worker sem permissão não cria → 403", async () => {
    const res = await call("POST", `/projects/${P}/engagements`, "worker", { name: "X" });
    expect(res.statusCode).toBe(403);
  });

  it("sem acesso ao cliente → 404 (não confirma existência)", async () => {
    const res = await call("GET", `/projects/${P}/engagements`, "noacc");
    expect(res.statusCode).toBe(404);
  });

  it("editar projeto → 200", async () => {
    const res = await call("PATCH", `/engagements/${novoId}`, "boss", { name: "Rebranding 2026 v2" });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Rebranding 2026 v2");
  });

  it("excluir o Projeto geral é bloqueado", async () => {
    const res = await call("DELETE", `/engagements/gen-${P}`, "boss");
    expect(res.statusCode).not.toBe(200);
    expect(JSON.stringify(res.json())).toMatch(/geral/i);
  });

  it("adicionar consultor que é membro do cliente → 200; quem não é → erro", async () => {
    const ok = await call("POST", `/engagements/${novoId}/consultores/c1`, "boss");
    expect(ok.statusCode).toBe(200);
    const list = await call("GET", `/engagements/${novoId}/consultores`, "boss");
    expect((list.json().consultores as Array<{ id: string }>).some((c) => c.id === "c1")).toBe(true);

    const bad = await call("POST", `/engagements/${novoId}/consultores/out`, "boss");
    expect(bad.statusCode).not.toBe(200);
    expect(JSON.stringify(bad.json())).toMatch(/acesso ao cliente/i);
  });

  it("excluir projeto que não é o geral (e não é o último) → 200", async () => {
    const res = await call("DELETE", `/engagements/${novoId}`, "boss");
    expect(res.statusCode).toBe(200);
  });

  it("custo por projeto (gen) com custos_ver → soma correta", async () => {
    const res = await call("GET", `/engagements/gen-${P}/cost`, "boss");
    expect(res.statusCode).toBe(200);
    expect(res.json().realizadoCents).toBe(4000); // 60min @ R$40/h, DONE
  });
});
