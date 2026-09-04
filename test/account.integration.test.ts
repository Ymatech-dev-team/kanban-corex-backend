import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import { buildApp } from "../src/app.js";
import { signInternal } from "../src/lib/hmac.js";
import { TokenService } from "../src/modules/auth/token.service.js";
import { PasswordService } from "../src/modules/auth/password.service.js";
import { RefreshService } from "../src/modules/auth/refresh.service.js";
import { LockoutService } from "../src/modules/auth/lockout.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { makeAuthenticate } from "../src/modules/authz/authenticate.js";
import { Authorizer } from "../src/modules/authz/authorizer.js";
import { InMemoryAuthzUserRepo, InMemoryAuditRepo } from "../src/modules/authz/memory-repos.js";
import { InMemoryProjectAccessRepo } from "../src/modules/projects/memory-repos.js";
import { InMemoryUserRepo, InMemoryRefreshRepo, InMemoryLockoutStore } from "../src/modules/auth/memory-repos.js";
import { InMemoryAdminStore, InMemoryMemberRepo, InMemoryRoleRepo } from "../src/modules/admin/memory-repos.js";
import { MemberService } from "../src/modules/admin/member.service.js";
import type { MemberRecord, RoleRecord } from "../src/modules/admin/types.js";

const SECRET = "internal-test";
const ADMIN_PERMS = [PERMISSIONS.membros_gerenciar, PERMISSIONS.permissoes_conceder];

let app: FastifyInstance;
let tokens: TokenService;

function member(id: string, roleId: string | null): MemberRecord {
  return {
    id, orgId: "o1", name: id, email: `${id}@x.com`, roleId, rolePermissions: [], extraPermissions: [],
    mustChangePassword: false, tokenVersion: 0, deletedAt: null,
  };
}
function role(id: string, permissions: string[]): RoleRecord {
  return { id, orgId: "o1", name: id, permissions, isSystem: false };
}

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.INTERNAL_API_SECRET = SECRET;
  tokens = new TokenService({ accessSecret: "a", refreshSecret: "r", issuer: "iss", audience: "aud", accessTtlSec: 900, refreshTtlSec: 1000 });
  const passwords = new PasswordService(4);
  const adminHash = await passwords.hash("SenhaAtual123");
  const bobHash = await passwords.hash("bobSenha123");

  const authUsers = new InMemoryUserRepo()
    .add({ id: "admin", orgId: "o1", email: "admin@x.com", passwordHash: adminHash, roleId: "R_admin", mustChangePassword: false, tokenVersion: 0, deletedAt: null })
    .add({ id: "bob", orgId: "o1", email: "bob@x.com", passwordHash: bobHash, roleId: null, mustChangePassword: false, tokenVersion: 0, deletedAt: null });

  const authzUsers = new InMemoryAuthzUserRepo()
    .add({ id: "admin", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: ADMIN_PERMS, extraPermissions: [], name: "Admin", email: "admin@x.com" })
    .add({ id: "bob", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [], extraPermissions: [] });

  const authService = new AuthService({
    users: authUsers, tokens, passwords,
    refresh: new RefreshService(new InMemoryRefreshRepo(), tokens, { refreshTtlSec: 1000, familyTtlSec: 2000, graceMs: 0 }),
    lockout: new LockoutService(new InMemoryLockoutStore()),
  });

  const store = new InMemoryAdminStore().addRole(role("R_admin", ADMIN_PERMS)).addMember(member("admin", "R_admin")).addMember(member("bob", null));
  const memberService = new MemberService(new InMemoryMemberRepo(store), new InMemoryRoleRepo(store), passwords, new InMemoryRefreshRepo(), new InMemoryAuditRepo());

  app = buildApp({
    authenticate: makeAuthenticate({ tokens, users: authzUsers }),
    authorizer: new Authorizer(new InMemoryProjectAccessRepo()),
    authService,
    memberService,
    tokenService: tokens,
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

function call(method: string, url: string, bearer: string, body?: unknown) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const ts = Date.now();
  const headers: Record<string, string> = {
    "x-internal-timestamp": String(ts),
    "x-internal-signature": signInternal(SECRET, payload, ts),
    authorization: `Bearer ${bearer}`,
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({ method: method as "GET", url, headers, payload: body !== undefined ? payload : undefined });
}
const adminToken = () => tokens.signAccess({ userId: "admin", orgId: "o1", tokenVersion: 0 });
const bobToken = () => tokens.signAccess({ userId: "bob", orgId: "o1", tokenVersion: 0 });

describe("conta (integração)", () => {
  it("GET /me devolve nome e email", async () => {
    const res = await call("GET", "/me", adminToken());
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe("Admin");
    expect(res.json().email).toBe("admin@x.com");
  });

  it("trocar senha com senha atual errada → 401", async () => {
    const res = await call("POST", "/auth/change-password", adminToken(), { currentPassword: "errada", newPassword: "NovaSenha123", confirmPassword: "NovaSenha123" });
    expect(res.statusCode).toBe(401);
  });

  it("trocar senha com confirmação diferente → 400", async () => {
    const res = await call("POST", "/auth/change-password", adminToken(), { currentPassword: "SenhaAtual123", newPassword: "NovaSenha123", confirmPassword: "outra" });
    expect(res.statusCode).toBe(400);
  });

  it("trocar senha com dados válidos → 200", async () => {
    const res = await call("POST", "/auth/change-password", adminToken(), { currentPassword: "SenhaAtual123", newPassword: "NovaSenha123", confirmPassword: "NovaSenha123" });
    expect(res.statusCode).toBe(200);
  });

  it("editar o nome → 200", async () => {
    const res = await call("PATCH", "/me", bobToken(), { name: "Roberto" });
    expect(res.statusCode).toBe(200);
  });

  it("último admin NÃO pode excluir a própria conta → 409", async () => {
    const res = await call("DELETE", "/me", adminToken());
    expect(res.statusCode).toBe(409);
  });

  it("usuário comum pode excluir a própria conta → 200", async () => {
    const res = await call("DELETE", "/me", bobToken());
    expect(res.statusCode).toBe(200);
  });
});
