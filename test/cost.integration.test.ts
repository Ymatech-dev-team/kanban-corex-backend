import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import { buildApp } from "../src/app.js";
import { signInternal } from "../src/lib/hmac.js";
import { TokenService } from "../src/modules/auth/token.service.js";
import { makeAuthenticate } from "../src/modules/authz/authenticate.js";
import { Authorizer } from "../src/modules/authz/authorizer.js";
import { InMemoryAuthzUserRepo } from "../src/modules/authz/memory-repos.js";
import { InMemoryProjectAccessRepo } from "../src/modules/authz/memory-repos.js";
import { InMemoryOrgRepo, InMemoryCostRepo } from "../src/modules/cost/memory-repos.js";
import { CostService } from "../src/modules/cost/cost.service.js";
import type { CostRow } from "../src/modules/cost/types.js";

const SECRET = "internal-test";
let app: FastifyInstance;
let tokens: TokenService;

const P = "proj-1";
const okDone: CostRow = { taskId: "t1", status: "DONE", estimatedMinutes: 60, assigneeId: "u1", assigneeName: "Ana", compType: "HOURLY", compCents: 4000, assigneeIsMember: true };
const okOpen: CostRow = { taskId: "t2", status: "TODO", estimatedMinutes: 120, assigneeId: "u1", assigneeName: "Ana", compType: "HOURLY", compCents: 4000, assigneeIsMember: true };
const semResp: CostRow = { taskId: "t3", status: "TODO", estimatedMinutes: 30, assigneeId: null, assigneeName: null, compType: null, compCents: null, assigneeIsMember: false };
const semRem: CostRow = { taskId: "t4", status: "TODO", estimatedMinutes: 30, assigneeId: "u2", assigneeName: "Bruno", compType: null, compCents: null, assigneeIsMember: true };

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.INTERNAL_API_SECRET = SECRET;
  tokens = new TokenService({ accessSecret: "a", refreshSecret: "r", issuer: "iss", audience: "aud", accessTtlSec: 900, refreshTtlSec: 1000 });

  const users = new InMemoryAuthzUserRepo()
    .add({ id: "boss", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [PERMISSIONS.custos_ver], extraPermissions: [] })
    .add({ id: "worker", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [], extraPermissions: [] })
    .add({ id: "super", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [PERMISSIONS.custos_ver, PERMISSIONS.projetos_acessar_todos], extraPermissions: [] });

  const access = new InMemoryProjectAccessRepo().grant("boss", P).grant("worker", P);
  const costRepo = new InMemoryCostRepo()
    .seedProject("o1", P, [okDone, okOpen, semResp, semRem])
    .seedProject("o2", "proj-outra", [okDone]) // dados de OUTRA org
    .seedTask("o1", "tk1", { ...okDone, projectId: P })
    .seedTask("o2", "tk-o2", { ...okDone, projectId: "proj-outra" }); // tarefa de OUTRA org

  app = buildApp({
    authenticate: makeAuthenticate({ tokens, users }),
    authorizer: new Authorizer(access),
    costService: new CostService(new InMemoryOrgRepo(176), costRepo),
    tokenService: tokens,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function get(url: string, userId: string) {
  const ts = Date.now();
  return app.inject({
    method: "GET",
    url,
    headers: {
      "x-internal-timestamp": String(ts),
      "x-internal-signature": signInternal(SECRET, "", ts),
      authorization: `Bearer ${tokens.signAccess({ userId, orgId: "o1", tokenVersion: 0 })}`,
    },
  });
}

describe("custo (integração)", () => {
  it("com custos_ver → resumo com realizado/planejado e incompletos (nunca 0 por falta de dado)", async () => {
    const res = await get(`/projects/${P}/cost`, "boss");
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.realizadoCents).toBe(4000); // t1 DONE 60min @40/h
    expect(b.planejadoCents).toBe(8000); // t2 TODO 120min @40/h
    expect(b.incompletos).toEqual({ semResponsavel: 1, semRemuneracao: 1, semHoras: 0, respSemAcesso: 0 });
    expect(b.porPessoa).toHaveLength(1);
    expect(b.porPessoa[0]).toMatchObject({ userId: "u1", realizadoCents: 4000, planejadoCents: 8000, horasAbertoMin: 120 });
  });

  it("acesso ao cliente SEM custos_ver → 403 (não vaza custo)", async () => {
    const res = await get(`/projects/${P}/cost`, "worker");
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain("4000");
  });

  it("projetos_acessar_todos cross-org → só enxerga a PRÓPRIA org (dados de o2 não vazam)", async () => {
    const res = await get(`/projects/proj-outra/cost`, "super");
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.realizadoCents).toBe(0);
    expect(b.planejadoCents).toBe(0);
    expect(b.porPessoa).toHaveLength(0);
  });

  it("GET /tasks/:id/cost com custos_ver → custo da tarefa (state OK + cents)", async () => {
    const res = await get(`/tasks/tk1/cost`, "boss");
    expect(res.statusCode).toBe(200);
    const b = res.json();
    expect(b.state).toBe("OK");
    expect(b.cents).toBe(4000); // 60min @40/h
  });

  it("GET /tasks/:id/cost SEM custos_ver → 403 (não vaza cents)", async () => {
    const res = await get(`/tasks/tk1/cost`, "worker");
    expect(res.statusCode).toBe(403);
    expect(JSON.stringify(res.json())).not.toContain("4000");
  });

  it("GET /tasks/:id/cost de tarefa de OUTRA org → 404 (nem confirma existência)", async () => {
    const res = await get(`/tasks/tk-o2/cost`, "super");
    expect(res.statusCode).toBe(404);
  });
});
