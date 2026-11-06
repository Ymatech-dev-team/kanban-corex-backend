import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage } from 'node:http';
import { createMcpOperationalGuard } from '../src/modules/mcp/operational-guards.js';
const now = 1_800_000_000_000;
function request(headers: IncomingMessage['headers'] = {}, method='POST', remoteAddress='192.0.2.10') {
  return { headers, method, socket: { remoteAddress } } as Pick<IncomingMessage,'headers'|'method'|'socket'>;
}
function setup(vercel=false) {
  const store = { limit:vi.fn().mockResolvedValue({success:true,reset:now+60_000}), acquireRetentionLease:vi.fn().mockResolvedValue(false) };
  const retention = { purgeExpired:vi.fn().mockResolvedValue(0) }; const report=vi.fn();
  return { store,retention,report,guard:createMcpOperationalGuard({store,retention,vercel,now:()=>now,report}) };
}
describe('distributed raw MCP/OAuth operational guard',()=>{
  it.each([
    ['ip','guard_ip_unavailable'], ['exception','guard_store_unavailable'],
    ['timeout','guard_store_timeout'], ['malformed','guard_store_malformed'],
  ])('reports only a fixed diagnostic event for %s and keeps fail-closed',async(source,event)=>{
    const s=setup(source==='ip');
    if(source==='exception')s.store.limit.mockRejectedValue(new Error('redis-password secret-token https://private.example'));
    if(source==='timeout')s.store.limit.mockResolvedValue({success:true,reset:now+60000,reason:'timeout'});
    if(source==='malformed')s.store.limit.mockResolvedValue({success:true,reset:NaN,reason:'secret-token'});
    await expect(s.guard.check(request({authorization:'Bearer secret-token',cookie:'secret-cookie','x-forwarded-for':'203.0.113.90'}),'mcp')).rejects.toMatchObject({statusCode:503});
    expect(s.report.mock.calls).toEqual([[event]]);
    const logged=JSON.stringify(s.report.mock.calls);
    for(const sensitive of ['secret-token','secret-cookie','redis-password','private.example','203.0.113.90','192.0.2.10'])expect(logged).not.toContain(sensitive);
    expect(s.retention.purgeExpired).not.toHaveBeenCalled();
  });

  it('checks a shared OAuth issuance budget before per-IP budget',async()=>{const s=setup();await s.guard.check(request(),'oauth');expect(s.store.limit).toHaveBeenNthCalledWith(1,'global','global');expect(s.store.limit).toHaveBeenNthCalledWith(2,'oauth-global','global');expect(s.store.limit).toHaveBeenNthCalledWith(3,'oauth-write',expect.any(String));});

  it('checks global and hashed socket-IP budget without reading credentials',async()=>{const s=setup();await s.guard.check(request({authorization:'Bearer secret',cookie:'secret','x-forwarded-for':'203.0.113.5'}),'mcp');expect(s.store.limit).toHaveBeenNthCalledWith(1,'global','global');expect(s.store.limit).toHaveBeenNthCalledWith(2,'mcp',expect.stringMatching(/^[a-f0-9]{64}$/));expect(JSON.stringify(s.store.limit.mock.calls)).not.toContain('secret');expect(JSON.stringify(s.store.limit.mock.calls)).not.toContain('192.0.2.10');});
  it('ignores arbitrary forwarded headers off Vercel',async()=>{const s=setup();await s.guard.check(request({'x-forwarded-for':'203.0.113.1','x-vercel-forwarded-for':'203.0.113.1'}),'mcp');const first=s.store.limit.mock.calls[1][1];await s.guard.check(request({'x-forwarded-for':'203.0.113.2','x-vercel-forwarded-for':'203.0.113.2'}),'mcp');expect(s.store.limit.mock.calls[3][1]).toBe(first);});
  it('uses only the Vercel-owned IP header on Vercel',async()=>{const s=setup(true);await s.guard.check(request({'x-vercel-forwarded-for':'203.0.113.1','x-forwarded-for':'fake'}),'mcp');const first=s.store.limit.mock.calls[1][1];await s.guard.check(request({'x-vercel-forwarded-for':'203.0.113.2','x-forwarded-for':'fake'}),'mcp');expect(s.store.limit.mock.calls[3][1]).not.toBe(first);});
  it.each([undefined,'not-an-ip','203.0.113.1, 203.0.113.2',['203.0.113.1']])('rejects missing/ambiguous Vercel IP %j',async(header)=>{const s=setup(true);await expect(s.guard.check(request({'x-vercel-forwarded-for':header}),'oauth')).rejects.toMatchObject({statusCode:503});expect(s.store.limit).not.toHaveBeenCalled();});
  it.each([['oauth','GET','oauth'],['oauth','POST','oauth-write'],['oauth','DELETE','oauth-write'],['metadata','GET','metadata'],['mcp','POST','mcp']] as const)('groups %s %s into a stable bucket %s',async(kind,method,bucket)=>{const s=setup();await s.guard.check(request({},method),kind);expect(s.store.limit.mock.calls.at(-1)![0]).toBe(bucket);});
  it('returns 429 with bounded Retry-After and skips cleanup when exhausted',async()=>{const s=setup();s.store.limit.mockResolvedValueOnce({success:false,reset:now+61_100});await expect(s.guard.check(request(),'mcp')).rejects.toMatchObject({statusCode:429,retryAfterSeconds:62});expect(s.store.acquireRetentionLease).not.toHaveBeenCalled();});
  it('fails closed when Upstash SDK reports timeout as success',async()=>{const s=setup();s.store.limit.mockResolvedValueOnce({success:true,reset:now+60_000,reason:'timeout'});await expect(s.guard.check(request(),'mcp')).rejects.toMatchObject({statusCode:503});expect(s.store.acquireRetentionLease).not.toHaveBeenCalled();});
  it('fails closed on Redis exception without leaking its message',async()=>{const s=setup();s.store.limit.mockRejectedValue(new Error('https://secret-token@example.test'));await expect(s.guard.check(request(),'oauth')).rejects.toMatchObject({statusCode:503,message:expect.not.stringContaining('secret-token')});expect(s.retention.purgeExpired).not.toHaveBeenCalled();});
  it('cleans only one bounded batch older than expiry grace after acquiring shared lease',async()=>{const s=setup();s.store.acquireRetentionLease.mockResolvedValue(true);await s.guard.check(request(),'mcp');expect(s.retention.purgeExpired).toHaveBeenCalledOnce();expect(s.retention.purgeExpired).toHaveBeenCalledWith(now/1000-86400,500);});
  it('does not clean when another instance already holds shared throttle lease',async()=>{const s=setup();await s.guard.check(request(),'mcp');expect(s.store.acquireRetentionLease).toHaveBeenCalledOnce();expect(s.retention.purgeExpired).not.toHaveBeenCalled();});
  it('awaits cleanup and reports failure without exposing details or blocking an allowed request',async()=>{const s=setup();s.store.acquireRetentionLease.mockResolvedValue(true);s.retention.purgeExpired.mockRejectedValue(new Error('database secret'));await expect(s.guard.check(request(),'mcp')).resolves.toBeUndefined();expect(s.report).toHaveBeenCalledWith('mcp_retention_failed');expect(s.report).toHaveBeenCalledTimes(1);});
});
