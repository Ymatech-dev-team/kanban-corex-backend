import { describe, it, expect } from "vitest";
import { TokenService } from "../src/modules/auth/token.service.js";

const svc = new TokenService({
  accessSecret: "acc",
  refreshSecret: "ref",
  issuer: "iss",
  audience: "aud",
  accessTtlSec: 900,
  refreshTtlSec: 1000,
});

const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

describe("TokenService [SEC-012]", () => {
  it("emite e verifica access (com tokenVersion)", () => {
    const t = svc.signAccess({ userId: "u1", orgId: "o1", tokenVersion: 3 });
    expect(svc.verifyAccess(t)).toEqual({ userId: "u1", orgId: "o1", tokenVersion: 3 });
  });

  it("access NÃO é aceito como refresh (segredo/typ diferentes)", () => {
    const t = svc.signAccess({ userId: "u1", orgId: "o1", tokenVersion: 0 });
    expect(() => svc.verifyRefresh(t)).toThrow();
  });

  it("rejeita alg:none", () => {
    const bad = `${b64({ alg: "none", typ: "JWT" })}.${b64({
      sub: "u1",
      orgId: "o1",
      typ: "access",
      iss: "iss",
      aud: "aud",
    })}.`;
    expect(() => svc.verifyAccess(bad)).toThrow();
  });

  it("rejeita audience errada", () => {
    const other = new TokenService({
      accessSecret: "acc",
      refreshSecret: "ref",
      issuer: "iss",
      audience: "outra",
      accessTtlSec: 900,
      refreshTtlSec: 1000,
    });
    const t = other.signAccess({ userId: "u1", orgId: "o1", tokenVersion: 0 });
    expect(() => svc.verifyAccess(t)).toThrow();
  });
});
