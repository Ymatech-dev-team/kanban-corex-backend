/** Storage port implements atomic consume and preserves consumed markers on upsert. */
export interface OAuthRecord { model: string; id: string; payload: Record<string, unknown>; expiresAt: number | null }
export interface OAuthRecordStore {
  put(record: OAuthRecord): Promise<void>;
  get(model: string, field: "id" | "uid" | "userCode", value: string): Promise<OAuthRecord | null>;
  consume(model: string, id: string, now: number): Promise<boolean>;
  delete(model: string, id: string): Promise<void>;
  revokeGrant(grantId: string): Promise<void>;
}
export function createOAuthAdapter(store: OAuthRecordStore, now = () => Math.floor(Date.now() / 1000)) {
  return class OAuthAdapter {
    constructor(private readonly model: string) {}
    async upsert(id: string, payload: Record<string, unknown>, expiresIn?: number): Promise<void> {
      await store.put({ model: this.model, id, payload, expiresAt: expiresIn === undefined ? null : now() + expiresIn });
    }
    private async lookup(field: "id" | "uid" | "userCode", value: string) {
      const record = await store.get(this.model, field, value);
      if (!record || (record.expiresAt !== null && record.expiresAt <= now())) return undefined;
      return record.payload;
    }
    find(id: string) { return this.lookup("id", id); }
    findByUid(uid: string) { return this.lookup("uid", uid); }
    findByUserCode(code: string) { return this.lookup("userCode", code); }
    async consume(id: string): Promise<void> {
      if (!await store.consume(this.model, id, now())) throw new Error("OAuth artifact already consumed or expired");
    }
    destroy(id: string) { return store.delete(this.model, id); }
    revokeByGrantId(id: string) { return store.revokeGrant(id); }
  };
}
