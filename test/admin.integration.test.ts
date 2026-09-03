import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import { buildApp } from "../src/app.js";
import { signInternal } from "../src/lib/hmac.js";
import { TokenService } from "../src/modules/auth/token.service.js";
import { PasswordService } from "../src/modules/auth/password.service.js";
import { makeAuthenticate } from "../src/modules/authz/authenticate.js";
import { Authorizer } from "../src/modules/authz/authorizer.js";
import { InMemoryAuthzUserRepo, InMemoryAuditRepo } from "../src/modules/authz/memory-repos.js";
import { InMemoryProjectAccessRepo } from "../src/modules/projects/memory-repos.js";
import { InMemoryRefreshRepo } from "../src/modules/auth/memory-repos.js";
import {
  InMemoryAdminStore,
  InMemoryMemberRepo,
  InMemoryRoleRepo,
} from "../src/modules/admin/memory-repos.js";
import { MemberService } from "../src/modules/admin/member.service.js";
import { RoleService } from "../src/modules/admin/role.service.js";
import type { MemberRecord, RoleRecord } from "../src/modules/admin/types.js";

const SECRET = "internal-test";
const ADMIN_PERMS = [
  PERMISSIONS.membros_ver, PERMISSIONS.membros_gerenciar, PERMISSIONS.perfis_ver,
  PERMISSIONS.perfis_gerenciar, PERMISSIONS.permissoes_conceder, PERMISSIONS.tarefas_criar,
];
const MGR_PERMS = [
  PERMISSIONS.membros_ver, PERMISSIONS.membros_gerenciar, PERMISSIONS.perfis_ver, PERMISSIONS.perfis_gerenciar,
];

let app: FastifyInstance;
let tokens: TokenService;
let memberRepo: InMemoryMemberRepo;

function member(id: string, roleId: string | null, extra: string[] = []): MemberRecord {
  return { id, orgId: "o1", name: id, email: `${id}@x.com`, roleId, rolePermissions: [], extraPermissions: extra,
    mustChangePassword: false, tokenVersion: 0, deletedAt: null };
}
function role(id: string, permissions: string[], isSystem = false): RoleRecord {
  return { id, orgId: "o1", name: id, permissions, isSystem };
}

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.INTERNAL_API_SECRET = SECRET;
  tokens = new TokenService({ accessSecret: "a", refreshSecret: "r", issuer: "iss", audience: "aud", accessTtlSec: 900, refreshTtlSec: 1000 });

  const users = new InMemoryAuthzUserRepo()
    .add({ id: "admin", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: ADMIN_PERMS, extraPermissions: [] })
    .add({ id: "mgr", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: MGR_PERMS, extraPermissions: [] })
    .add({ id: "bob", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [], extraPermissions: [] });

  const store = new InMemoryAdminStore()
    .addRole(role("R_admin", ADMIN_PERMS))
    .addRole(role("R_mgr", MGR_PERMS))
    .addRole(role("R_sys", ADMIN_PERMS, true))
    .addRole(role("R_plain", [PERMISSIONS.tarefas_criar]))
    .addMember(member("admin", "R_admin"))
    .addMember(member("mgr", "R_mgr"))
    .addMember(member("bob", null));

  memberRepo = new InMemoryMemberRepo(store);
  const roleRepo = new InMemoryRoleRepo(store);
  const memberService = new MemberService(memberRepo, roleRepo, new PasswordService(10), new InMemoryRefreshRepo(), new InMemoryAuditRepo());
  const roleService = new RoleService(roleRepo, memberRepo, new InMemoryAuditRepo());

  app = buildApp({
    authenticate: makeAuthenticate({ tokens, users }),
    authorizer: new Authorizer(new InMemoryProjectAccessRepo()),
    memberService,
    roleService,
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

describe("painel admin (5c)", () => {
  it("admin lista membros → 200", async () => {
    const res = await call("GET", "/members", "admin");
    expect(res.statusCode).toBe(200);
    expect(res.json().members.length).toBeGreaterThanOrEqual(3);
  });

  it("bob sem membros.ver → 403", async () => {
    const res = await call("GET", "/members", "bob");
    expect(res.statusCode).toBe(403);
  });

  it("admin cadastra membro → 200 com senha temporária", async () => {
    const res = await call("POST", "/members", "admin", { name: "Nova", email: "nova@x.com" });
    expect(res.statusCode).toBe(200);
    expect(res.json().tempPassword).toBeTruthy();
    expect(res.json().member.mustChangePassword).toBe(true);
  });

  it("criar perfil com permissão que o admin NÃO tem → 403 (anti-escalonamento)", async () => {
    const res = await call("POST", "/roles", "admin", { name: "Super", permissions: [PERMISSIONS.projetos_excluir] });
    expect(res.statusCode).toBe(403);
  });

  it("criar perfil só com permissões que o admin tem → 200", async () => {
    const res = await call("POST", "/roles", "admin", { name: "Colab", permissions: [PERMISSIONS.tarefas_criar] });
    expect(res.statusCode).toBe(200);
  });

  it("admin editando o PRÓPRIO privilégio → 403 (proibido auto-edição)", async () => {
    const res = await call("PATCH", "/members/admin", "admin", { roleId: "R_mgr" });
    expect(res.statusCode).toBe(403);
  });

  it("conceder meta-permissão sem confirmar → 400; com confirmação → 200", async () => {
    const semConfirm = await call("PATCH", "/members/bob", "admin", { extraPermissions: [PERMISSIONS.permissoes_conceder] });
    expect(semConfirm.statusCode).toBe(400);
    const comConfirm = await call("PATCH", "/members/bob", "admin", {
      extraPermissions: [PERMISSIONS.permissoes_conceder], confirmMetaPermission: true,
    });
    expect(comConfirm.statusCode).toBe(200);
  });

  it("remover o ÚLTIMO admin → 409 (org sem administrador)", async () => {
    // mgr tem membros.gerenciar mas NÃO é governance; admin é o único governance
    const res = await call("DELETE", "/members/admin", "mgr");
    expect(res.statusCode).toBe(409);
  });

  it("excluir perfil EM USO → 409", async () => {
    const res = await call("DELETE", "/roles/R_admin", "admin");
    expect(res.statusCode).toBe(409);
  });

  it("excluir/editar perfil de SISTEMA → 403", async () => {
    expect((await call("DELETE", "/roles/R_sys", "admin")).statusCode).toBe(403);
    expect((await call("PATCH", "/roles/R_sys", "admin", { name: "x" })).statusCode).toBe(403);
  });

  it("editar role deixando a org sem admin → 409 (SEC-201)", async () => {
    const res = await call("PATCH", "/roles/R_admin", "admin", { permissions: [PERMISSIONS.tarefas_criar] });
    expect(res.statusCode).toBe(409);
  });

  it("conceder meta-permissão via role sem confirmar → 400; com confirmação → 200 (SEC-203)", async () => {
    const sem = await call("PATCH", "/roles/R_plain", "admin", {
      permissions: [PERMISSIONS.tarefas_criar, PERMISSIONS.permissoes_conceder],
    });
    expect(sem.statusCode).toBe(400);
    const com = await call("PATCH", "/roles/R_plain", "admin", {
      permissions: [PERMISSIONS.tarefas_criar, PERMISSIONS.permissoes_conceder],
      confirmMetaPermission: true,
    });
    expect(com.statusCode).toBe(200);
  });

  it("reset de senha → 200 com nova temporária", async () => {
    const res = await call("POST", "/members/bob/reset-password", "admin");
    expect(res.statusCode).toBe(200);
    expect(res.json().tempPassword).toBeTruthy();
  });

  it("remover membro comum → 200 e nula os responsáveis dele", async () => {
    const res = await call("DELETE", "/members/bob", "admin");
    expect(res.statusCode).toBe(200);
    expect(memberRepo.nulledAssignees).toContain("bob");
  });
});
