import { describe, expect, it, vi } from "vitest";
import { createOAuthAdapter, type OAuthRecordStore } from "../src/modules/mcp/oauth/storage.js";
const now = 1800000000;
function setup() {
  const store: OAuthRecordStore = { put: vi.fn().mockResolvedValue(undefined), get: vi.fn().mockResolvedValue(null), consume: vi.fn().mockResolvedValue(true), delete: vi.fn().mockResolvedValue(undefined), revokeGrant: vi.fn().mockResolvedValue(undefined) };
  const Adapter = createOAuthAdapter(store, () => now);
  return { store, adapter: new Adapter("AuthorizationCode") };
}
describe("persistent OAuth adapter boundary", () => {
  it("stores provider payload with absolute expiry and model namespace", async () => {
    const { store, adapter } = setup();
    await adapter.upsert("code", { grantId: "grant", accountId: "user" }, 60);
    expect(store.put).toHaveBeenCalledWith({ model: "AuthorizationCode", id: "code", payload: { grantId: "grant", accountId: "user" }, expiresAt: now + 60 });
  });
  it("supports non-expiring provider client records", async () => {
    const { store } = setup(); const Adapter = createOAuthAdapter(store, () => now);
    await new Adapter("Client").upsert("client", { redirect_uris: ["https://client.test/cb"] });
    expect(store.put).toHaveBeenCalledWith(expect.objectContaining({ expiresAt: null }));
  });
  it("returns only unexpired payload and preserves consumed timestamp", async () => {
    const { store, adapter } = setup();
    vi.mocked(store.get).mockResolvedValue({ model: "AuthorizationCode", id: "code", expiresAt: now + 1, payload: { consumed: now - 1 } });
    expect(await adapter.find("code")).toEqual({ consumed: now - 1 });
    vi.mocked(store.get).mockResolvedValue({ model: "AuthorizationCode", id: "code", expiresAt: now, payload: {} });
    expect(await adapter.find("code")).toBeUndefined();
  });
  it("namespaces secondary indexes by model", async () => {
    const { store, adapter } = setup();
    expect(await adapter.findByUid("uid")).toBeUndefined();
    expect(await adapter.findByUserCode("code")).toBeUndefined();
    expect(store.get).toHaveBeenNthCalledWith(1, "AuthorizationCode", "uid", "uid");
    expect(store.get).toHaveBeenNthCalledWith(2, "AuthorizationCode", "userCode", "code");
  });
  it("requires successful atomic consume and rejects replay", async () => {
    const { store, adapter } = setup();
    await adapter.consume("code");
    expect(store.consume).toHaveBeenCalledWith("AuthorizationCode", "code", now);
    vi.mocked(store.consume).mockResolvedValue(false);
    await expect(adapter.consume("code")).rejects.toThrow();
  });
  it("deletes exact artifact and revokes all grant artifacts", async () => {
    const { store, adapter } = setup();
    await adapter.destroy("code"); await adapter.revokeByGrantId("grant");
    expect(store.delete).toHaveBeenCalledWith("AuthorizationCode", "code");
    expect(store.revokeGrant).toHaveBeenCalledWith("grant");
  });
  it("propagates persistence outages rather than fall back to memory", async () => {
    const { store, adapter } = setup(); const error = new Error("database offline");
    vi.mocked(store.get).mockRejectedValue(error);
    await expect(adapter.find("code")).rejects.toBe(error);
  });
});
