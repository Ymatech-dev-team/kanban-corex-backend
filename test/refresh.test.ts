import { describe, it, expect } from "vitest";
import { TokenService } from "../src/modules/auth/token.service.js";
import { RefreshService } from "../src/modules/auth/refresh.service.js";
import { InMemoryRefreshRepo } from "../src/modules/auth/memory-repos.js";
import { sha256 } from "../src/lib/hash.js";

function setup() {
  const tokens = new TokenService({
    accessSecret: "a",
    refreshSecret: "r",
    issuer: "iss",
    audience: "aud",
    accessTtlSec: 900,
    refreshTtlSec: 3600,
  });
  const repo = new InMemoryRefreshRepo();
  const svc = new RefreshService(repo, tokens, {
    refreshTtlSec: 3600,
    familyTtlSec: 3600,
    graceMs: 10_000,
  });
  return { repo, svc };
}

describe("RefreshService [SEC-004]", () => {
  it("rotaciona: novo válido; antigo (dentro da graça) recusado; novo segue válido", async () => {
    const { svc } = setup();
    const first = await svc.issueNewFamily("u1");
    const r1 = await svc.rotate(first);
    expect(r1.refresh).toBeTruthy();
    await expect(svc.rotate(first)).rejects.toThrow(); // reuso na graça
    const r2 = await svc.rotate(r1.refresh);
    expect(r2.refresh).toBeTruthy();
  });

  it("reuso fora da graça = replay → revoga a família inteira", async () => {
    const { svc, repo } = setup();
    const first = await svc.issueNewFamily("u1");
    const r1 = await svc.rotate(first);
    repo.forceRevokedAt(sha256(first), new Date(Date.now() - 60_000)); // fora da graça
    await expect(svc.rotate(first)).rejects.toThrow(); // replay detectado
    await expect(svc.rotate(r1.refresh)).rejects.toThrow(); // família morta
  });
});
