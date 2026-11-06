import type { PrismaClient } from "@prisma/client";
import type { McpGrant } from "../types.js";
import type { OAuthRecord, OAuthRecordStore } from "./storage.js";

export interface McpConnection extends McpGrant { tokenVersion: number }
export interface McpConnectionStore {
  findById(id: string): Promise<McpConnection | null>;
  create(connection: McpConnection): Promise<void>;
  list(userId: string, orgId: string): Promise<McpConnection[]>;
  revoke(id: string, userId: string, orgId: string): Promise<boolean>;
}
type DB = Pick<PrismaClient, "$queryRawUnsafe" | "$executeRawUnsafe">;
type ConnectionRow = Omit<McpConnection, "expiresAt"> & { expiresAt: bigint };
const connection = (row: ConnectionRow): McpConnection => ({ ...row, expiresAt: Number(row.expiresAt) });

/** All values use positional SQL parameters. No table/column identifiers come from callers. */
export class PrismaOAuthStore implements OAuthRecordStore, McpConnectionStore {
  constructor(private readonly db: DB) {}
  async put(record: OAuthRecord): Promise<void> {
    // A late save must never clear a concurrently committed consumed marker.
    await this.db.$executeRawUnsafe(`INSERT INTO mcp_oauth_artifacts (model,id,payload,"expiresAt") VALUES ($1,$2,$3::jsonb,$4)
      ON CONFLICT(model,id) DO UPDATE SET payload = CASE WHEN mcp_oauth_artifacts.payload ? 'consumed'
        THEN EXCLUDED.payload || jsonb_build_object('consumed',mcp_oauth_artifacts.payload->'consumed') ELSE EXCLUDED.payload END,
        "expiresAt" = EXCLUDED."expiresAt"`, record.model, record.id, JSON.stringify(record.payload), record.expiresAt);
  }
  async get(model: string, field: "id" | "uid" | "userCode", value: string): Promise<OAuthRecord | null> {
    const rows = await this.db.$queryRawUnsafe<Array<Omit<OAuthRecord, "expiresAt"> & { expiresAt: bigint | null }>>(
      `SELECT model,id,payload,"expiresAt" FROM mcp_oauth_artifacts WHERE model=$1 AND
       (($2='id' AND id=$3) OR ($2='uid' AND payload->>'uid'=$3) OR ($2='userCode' AND payload->>'userCode'=$3)) LIMIT 1`, model, field, value);
    return rows[0] ? { ...rows[0], expiresAt: rows[0].expiresAt === null ? null : Number(rows[0].expiresAt) } : null;
  }
  async consume(model: string, id: string, now: number): Promise<boolean> {
    return await this.db.$executeRawUnsafe(`UPDATE mcp_oauth_artifacts SET payload=jsonb_set(payload,'{consumed}',to_jsonb($3::bigint))
      WHERE model=$1 AND id=$2 AND NOT (payload ? 'consumed') AND ("expiresAt" IS NULL OR "expiresAt">$3)`, model, id, now) === 1;
  }
  async delete(model: string, id: string): Promise<void> {
    await this.db.$executeRawUnsafe(`DELETE FROM mcp_oauth_artifacts WHERE model=$1 AND id=$2`, model, id);
  }
  async revokeGrant(grantId: string): Promise<void> {
    await this.db.$executeRawUnsafe(`WITH revoked AS (UPDATE mcp_connections SET "revokedAt"=COALESCE("revokedAt",now()) WHERE id=$1 RETURNING id)
      DELETE FROM mcp_oauth_artifacts WHERE payload->>'grantId'=$1 OR (model='Grant' AND id=$1)`, grantId);
  }
  async findById(id: string): Promise<McpConnection | null> {
    const rows = await this.db.$queryRawUnsafe<ConnectionRow[]>(`SELECT id,"userId","orgId","clientId","tokenVersion",scopes,"expiresAt","revokedAt" FROM mcp_connections WHERE id=$1`, id);
    return rows[0] ? connection(rows[0]) : null;
  }
  async create(value: McpConnection): Promise<void> {
    // Immutable snapshot: conflict rejects instead of refreshing a revoked grant/tokenVersion.
    await this.db.$executeRawUnsafe(`INSERT INTO mcp_connections(id,"userId","orgId","clientId","tokenVersion",scopes,"expiresAt") VALUES($1,$2,$3,$4,$5,$6::text[],$7)`, value.id, value.userId, value.orgId, value.clientId, value.tokenVersion, value.scopes, value.expiresAt);
  }
  async list(userId: string, orgId: string): Promise<McpConnection[]> {
    const rows = await this.db.$queryRawUnsafe<ConnectionRow[]>(`SELECT id,"userId","orgId","clientId","tokenVersion",scopes,"expiresAt","revokedAt" FROM mcp_connections WHERE "userId"=$1 AND "orgId"=$2 ORDER BY "createdAt" DESC LIMIT 100`, userId, orgId);
    return rows.map(connection);
  }
  async revoke(id: string, userId: string, orgId: string): Promise<boolean> {
    const rows = await this.db.$queryRawUnsafe<Array<{ id: string }>>(`WITH revoked AS (
      UPDATE mcp_connections SET "revokedAt"=COALESCE("revokedAt",now()) WHERE id=$1 AND "userId"=$2 AND "orgId"=$3 RETURNING id
    ), removed AS (DELETE FROM mcp_oauth_artifacts WHERE payload->>'grantId' IN (SELECT id FROM revoked) OR (model='Grant' AND id IN (SELECT id FROM revoked))) SELECT id FROM revoked`, id, userId, orgId);
    return rows.length === 1;
  }
}
