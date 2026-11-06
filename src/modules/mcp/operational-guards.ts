import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
export type McpEndpointKind = 'oauth' | 'mcp' | 'metadata';
export type McpRateBucket = 'global' | 'oauth-global' | 'oauth' | 'oauth-write' | 'mcp' | 'metadata';
export interface McpRateDecision { success: boolean; reset: number; reason?: string }
export interface McpOperationalStore {
  limit(bucket: McpRateBucket, key: string): Promise<McpRateDecision>;
  acquireRetentionLease(): Promise<boolean>;
}
export interface McpRetentionStore { purgeExpired(beforeEpochSeconds: number, batchSize: number): Promise<number> }
export interface McpOperationalGuard { check(request: Pick<IncomingMessage,'headers'|'method'|'socket'>, kind: McpEndpointKind): Promise<void> }
export type McpOperationalEvent = 'mcp_retention_failed' | 'guard_ip_unavailable' | 'guard_store_unavailable' | 'guard_store_timeout' | 'guard_store_malformed';
export interface McpOperationalOptions {
  store: McpOperationalStore; retention: McpRetentionStore; vercel: boolean;
  now?: () => number;
  /** Only fixed event names; never attach request, exception text, tokens, IP or payload. */
  report?: (event: McpOperationalEvent) => void;
}
export class McpOperationalError extends Error {
  constructor(readonly statusCode: 429 | 503, readonly retryAfterSeconds: number) {
    super(statusCode === 429 ? 'Muitas requisições. Aguarde e tente novamente.' : 'Conexão temporariamente indisponível. Tente novamente.');
  }
}
export function createMcpOperationalGuard(options: McpOperationalOptions): McpOperationalGuard {
  return {
    async check(request, kind) {
      const now = options.now?.() ?? Date.now();
      if (!Number.isFinite(now)) throw new McpOperationalError(503, 5);
      // The Vercel proxy owns this header only on an actual Vercel deployment.
      // Never trust client-provided XFF/Forwarded outside that boundary.
      const ip = options.vercel ? request.headers['x-vercel-forwarded-for'] : request.socket.remoteAddress;
      if (typeof ip !== 'string' || !isIP(ip)) {
        options.report?.('guard_ip_unavailable');
        throw new McpOperationalError(503, 5);
      }
      const key = createHash('sha256').update(ip).digest('hex');
      const bucket: McpRateBucket = kind === 'oauth' && !['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? '') ? 'oauth-write' : kind;
      async function consume(bucketName: McpRateBucket, identifier: string) {
        let result: McpRateDecision;
        try { result = await options.store.limit(bucketName, identifier); }
        catch {
          options.report?.('guard_store_unavailable');
          throw new McpOperationalError(503, 5);
        }
        // Upstash's SDK intentionally returns success:true on its timeout. Reject it.
        if (result?.reason === 'timeout') {
          options.report?.('guard_store_timeout');
          throw new McpOperationalError(503, 5);
        }
        if (!result || typeof result.success !== 'boolean' || !Number.isFinite(result.reset)) {
          options.report?.('guard_store_malformed');
          throw new McpOperationalError(503, 5);
        }
        if (!result.success) throw new McpOperationalError(429, Math.min(3600, Math.max(1, Math.ceil((result.reset - now) / 1000))));
      }
      await consume('global', 'global');
      if (kind === 'oauth') await consume('oauth-global', 'global');
      await consume(bucket, key);
      // Await maintenance rather than abandoning a background Promise in serverless.
      // The lease is intentionally not released: it is also a distributed throttle.
      try {
        if (await options.store.acquireRetentionLease()) await options.retention.purgeExpired(Math.floor(now / 1000) - 86400, 500);
      } catch { options.report?.('mcp_retention_failed'); }
    },
  };
}

/** Mandatory distributed dependency when the real MCP runtime is enabled. */
export function createUpstashMcpOperationalStore(env: NodeJS.ProcessEnv, resource: string): McpOperationalStore {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  try {
    const parsed = new URL(url ?? '');
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !token?.trim()) throw new Error('config');
  } catch { throw new Error('UPSTASH_REDIS_REST_URL/TOKEN válidos são obrigatórios para MCP'); }
  const redis = new Redis({ url, token, retry: { retries: 0 }, signal: () => AbortSignal.timeout(1500) });
  const namespace = `rl:corex:mcp:${createHash('sha256').update(resource).digest('hex').slice(0, 24)}`;
  const budgets: Record<McpRateBucket, number> = { global: 1200, 'oauth-global': 60, oauth: 60, 'oauth-write': 20, mcp: 120, metadata: 120 };
  const limiters = Object.fromEntries(Object.entries(budgets).map(([bucket, limit]) => [bucket, new Ratelimit({
    redis, prefix: `${namespace}:${bucket}`, limiter: Ratelimit.slidingWindow(limit, '1 m'),
    ephemeralCache: false, analytics: false, timeout: 1000,
  })])) as Record<McpRateBucket, Ratelimit>;
  return {
    async limit(bucket, key) {
      const { success, reset, reason } = await limiters[bucket].limit(key);
      return { success, reset, reason };
    },
    async acquireRetentionLease() {
      return await redis.set(`${namespace}:retention`, 'held', { nx: true, ex: 60 }) === 'OK';
    },
  };
}
