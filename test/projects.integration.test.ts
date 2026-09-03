import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import { buildApp } from "../src/app.js";
import { signInternal } from "../src/lib/hmac.js";
import { TokenService } from "../src/modules/auth/token.service.js";
import { makeAuthenticate } from "../src/modules/authz/authenticate.js";
import { Authorizer } from "../src/modules/authz/authorizer.js";
import { InMemoryAuthzUserRepo, InMemoryAuditRepo } from "../src/modules/authz/memory-repos.js";
import { InMemoryProjectRepo, InMemoryProjectAccessRepo } from "../src/modules/projects/memory-repos.js";
import { ProjectService } from "../src/modules/projects/project.service.js";

const SECRET = "internal-test";
let app: FastifyInstance;
let tokens: TokenService;
let access: InMemoryProjectAccessRepo;

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
  const users = new InMemoryAuthzUserRepo()
    .add({
      id: "u1",
      orgId: "o1",
      deletedAt: null,
      tokenVersion: 0,
      mustChangePassword: false,
      rolePermissions: [
        PERMISSIONS.projetos_criar,
        PERMISSIONS.projetos_editar,
        PERMISSIONS.projetos_excluir,
        PERMISSIONS.permissoes_conceder,
      ],
      extraPermissions: [],
    })
    .add({
      id: "u2",
      orgId: "o1",
      deletedAt: null,
      tokenVersion: 0,
      mustChangePassword: false,
      rolePermissions: [PERMISSIONS.projetos_editar],
      extraPermissions: [],
    });
  access = new InMemoryProjectAccessRepo().addUser("u1", "o1", "Ana").addUser("u2", "o1", "Bruno");
  const authorizer = new Authorizer(access);
  const projectService = new ProjectService(new InMemoryProjectRepo(), access, new InMemoryAuditRepo());
  app = buildApp({
    authenticate: makeAuthenticate({ tokens, users }),
    authorizer,
    projectService,
    tokenService: tokens,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function token(userId: string) {
  return tokens.signAccess({ userId, orgId: "o1", tokenVersion: 0 });
}
function req(method: string, url: string, userId: string, body?: unknown) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const ts = Date.now();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token(userId)}`,
    "x-internal-timestamp": String(ts),
    "x-internal-signature": signInternal(SECRET, payload, ts),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({ method: method as "GET", url, headers, payload: body === undefined ? undefined : payload });
}

describe("projetos + acesso por cliente (5a)", () => {
  let projectId: string;

  it("u1 cria projeto (tem projetos.criar) → 200 e vira acessante", async () => {
    const res = await req("POST", "/projects", "u1", { name: "Cliente ACME" });
    expect(res.statusCode).toBe(200);
    projectId = res.json().id;
    expect(projectId).toBeTruthy();
  });

  it("u1 lista e vê o projeto criado", async () => {
    const res = await req("GET", "/projects", "u1");
    expect(res.statusCode).toBe(200);
    expect(res.json().projects.map((p: { id: string }) => p.id)).toContain(projectId);
  });

  it("u2 SEM acesso → GET do projeto responde 404 (não vaza)", async () => {
    const res = await req("GET", `/projects/${projectId}`, "u2");
    expect(res.statusCode).toBe(404);
  });

  it("u2 SEM permissão de criar → POST 403", async () => {
    const res = await req("POST", "/projects", "u2", { name: "X" });
    expect(res.statusCode).toBe(403);
  });

  it("u1 concede acesso a u2 → u2 passa a ver (200)", async () => {
    const grant = await req("POST", `/projects/${projectId}/members/u2`, "u1");
    expect(grant.statusCode).toBe(200);
    const view = await req("GET", `/projects/${projectId}`, "u2");
    expect(view.statusCode).toBe(200);
  });

  it("GET /projects/:id/members devolve id + nome de quem tem acesso", async () => {
    const res = await req("GET", `/projects/${projectId}/members`, "u1");
    expect(res.statusCode).toBe(200);
    const members = res.json().members as { id: string; name: string }[];
    expect(members).toEqual(
      expect.arrayContaining([
        { id: "u1", name: "Ana" },
        { id: "u2", name: "Bruno" },
      ]),
    );
  });

  it("u2 com acesso + projetos.editar → PATCH 200", async () => {
    const res = await req("PATCH", `/projects/${projectId}`, "u2", { name: "Cliente ACME 2" });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Cliente ACME 2");
  });

  it("u1 revoga acesso de u2 → u2 volta a 404 e assignees são nulados", async () => {
    const revoke = await req("DELETE", `/projects/${projectId}/members/u2`, "u1");
    expect(revoke.statusCode).toBe(200);
    expect(access.nulled).toContainEqual({ projectId, userId: "u2" });
    const view = await req("GET", `/projects/${projectId}`, "u2");
    expect(view.statusCode).toBe(404);
  });

  it("u1 exclui o projeto (soft-delete) → some da listagem", async () => {
    const del = await req("DELETE", `/projects/${projectId}`, "u1");
    expect(del.statusCode).toBe(200);
    const list = await req("GET", "/projects", "u1");
    expect(list.json().projects.map((p: { id: string }) => p.id)).not.toContain(projectId);
  });
});
