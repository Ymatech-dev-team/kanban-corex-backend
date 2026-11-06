import {describe,expect,it,vi} from 'vitest';
import {PrismaOAuthStore} from '../src/modules/mcp/oauth/prisma-store.js';
const now=1_800_000_000;
function setup(){const db={$queryRawUnsafe:vi.fn(),$executeRawUnsafe:vi.fn().mockResolvedValue(2),$transaction:vi.fn()};db.$transaction.mockImplementation(async(callback)=>callback(db));return {db,store:new PrismaOAuthStore(db)};}
describe('bounded OAuth artifact retention SQL adapter',()=>{
 it('sets server-side statement and lock deadlines inside bounded transaction',async()=>{const s=setup();await s.store.purgeExpired(now-86400,500);expect(s.db.$transaction).toHaveBeenCalledWith(expect.any(Function),{maxWait:1000,timeout:2500});expect(s.db.$queryRawUnsafe).toHaveBeenCalledWith(expect.stringContaining('set_config'), '1500ms','500ms');expect(s.db.$queryRawUnsafe.mock.invocationCallOrder[0]).toBeLessThan(s.db.$executeRawUnsafe.mock.invocationCallOrder[0]);});

 it('uses one parameterized locked batch of expired artifacts only',async()=>{const s=setup();expect(await s.store.purgeExpired(now-86400,500)).toBe(2);expect(s.db.$executeRawUnsafe).toHaveBeenCalledOnce();const [sql,cutoff,batch]=s.db.$executeRawUnsafe.mock.calls[0];expect(cutoff).toBe(now-86400);expect(batch).toBe(500);expect(sql).toContain('mcp_oauth_artifacts');expect(sql).toMatch(/"expiresAt"\s*<=\s*\$1/);expect(sql).toMatch(/LIMIT\s+\$2/);expect(sql).toContain('SKIP LOCKED');expect(sql).not.toContain('mcp_connections');expect(sql).not.toContain(String(now-86400));});
 it.each([0,501,-1,Number.NaN,1.5])('refuses unsafe batch size%s before SQL',async(batch)=>{const s=setup();await expect(s.store.purgeExpired(now-86400,batch)).rejects.toThrow();expect(s.db.$executeRawUnsafe).not.toHaveBeenCalled();});
 it('propagates database failure for sanitized operational handling',async()=>{const s=setup();const err=new Error('db unavailable');s.db.$executeRawUnsafe.mockRejectedValue(err);await expect(s.store.purgeExpired(now-86400,500)).rejects.toBe(err);});
});
