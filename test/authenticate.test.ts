import { describe, it, expect } from "vitest";
import type { FastifyReply, FastifyRequest } from "fastify";
import { TokenService } from "../src/modules/auth/token.service.js";
import { makeAuthenticate } from "../src/modules/authz/authenticate.js";
import { InMemoryAuthzUserRepo } from "../src/modules/authz/memory-repos.js";
import type { AuthzUserRecord } from "../src/modules/authz/types.js";

const tokens = new TokenService({
  accessSecret: "a",
  refreshSecret: "r",
  issuer: "iss",
  audience: "aud",
  accessTtlSec: 900,
  refreshTtlSec: 1000,
});

function baseUser(overrides: Partial<AuthzUserRecord> = {}): AuthzUserRecord {
  return {
    id: "u1",
    orgId: "o1",
    deletedAt: null,
    tokenVersion: 0,
    mustChangePassword: false,
    rolePermissions: ["tarefas.criar"],
    extraPermissions: [],
    ...overrides,
  };
}

function fakeReq(token: string, config: object = {}): FastifyRequest {
  return { headers: { authorization: `Bearer ${token}` }, routeOptions: { config } } as unknown as FastifyRequest;
}
const reply = {} as FastifyReply;

describe("authenticate (porteiro)", () => {
  it("token válido → seta a sessão com permissões efetivas", async () => {
    const auth = makeAuthenticate({ tokens, users: new InMemoryAuthzUserRepo().add(baseUser()) });
    const req = fakeReq(tokens.signAccess({ userId: "u1", orgId: "o1", tokenVersion: 0 }));
    await auth(req, reply);
    expect(req.session?.userId).toBe("u1");
    expect(req.session?.permissions.has("tarefas.criar")).toBe(true);
  });

  it("sem Bearer → 401", async () => {
    const auth = makeAuthenticate({ tokens, users: new InMemoryAuthzUserRepo().add(baseUser()) });
    const req = { headers: {}, routeOptions: { config: {} } } as unknown as FastifyRequest;
    await expect(auth(req, reply)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("tokenVersion divergente → 401 (senha trocada / rebaixado)", async () => {
    const auth = makeAuthenticate({ tokens, users: new InMemoryAuthzUserRepo().add(baseUser()) });
    const req = fakeReq(tokens.signAccess({ userId: "u1", orgId: "o1", tokenVersion: 9 }));
    await expect(auth(req, reply)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("usuário deletado → 401", async () => {
    const r = new InMemoryAuthzUserRepo().add(baseUser());
    r.markDeleted("u1");
    const auth = makeAuthenticate({ tokens, users: r });
    const req = fakeReq(tokens.signAccess({ userId: "u1", orgId: "o1", tokenVersion: 0 }));
    await expect(auth(req, reply)).rejects.toMatchObject({ statusCode: 401 });
  });

  it("mustChangePassword bloqueia rota comum → 403", async () => {
    const r = new InMemoryAuthzUserRepo().add(baseUser({ mustChangePassword: true }));
    const auth = makeAuthenticate({ tokens, users: r });
    const req = fakeReq(tokens.signAccess({ userId: "u1", orgId: "o1", tokenVersion: 0 }));
    await expect(auth(req, reply)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("mustChangePassword permite rota com allowMustChange (ex.: /me)", async () => {
    const r = new InMemoryAuthzUserRepo().add(baseUser({ mustChangePassword: true }));
    const auth = makeAuthenticate({ tokens, users: r });
    const req = fakeReq(tokens.signAccess({ userId: "u1", orgId: "o1", tokenVersion: 0 }), {
      allowMustChange: true,
    });
    await auth(req, reply);
    expect(req.session?.mustChangePassword).toBe(true);
  });
});
