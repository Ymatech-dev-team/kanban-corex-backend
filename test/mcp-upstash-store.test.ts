import { beforeEach,describe,expect,it,vi } from 'vitest';
const f=vi.hoisted(()=>({redis:vi.fn(),config:vi.fn(),limit:vi.fn(),set:vi.fn()}));
vi.mock('@upstash/redis',()=>({Redis:class {constructor(config:unknown){f.redis(config);}set(...args:unknown[]){return f.set(...args);}}}));
vi.mock('@upstash/ratelimit',()=>({Ratelimit:class {
  private prefix:string;
  constructor(config:{prefix:string}){this.prefix=config.prefix;f.config(config);}
  static slidingWindow(limit:number,window:string){return {limit,window};}
  limit(key:string){return f.limit(this.prefix,key);}
}}));
import {createUpstashMcpOperationalStore} from '../src/modules/mcp/operational-guards.js';
const env={UPSTASH_REDIS_REST_URL:'https://redis.example.test',UPSTASH_REDIS_REST_TOKEN:'test-only-token'};
const resource='https://api.example.test/mcp';
beforeEach(()=>{vi.clearAllMocks();f.set.mockResolvedValue('OK');f.limit.mockResolvedValue({success:true,reset:1800000000000,reason:undefined});});
describe('concrete Upstash MCP dependency',()=>{
 it('has no development/test or missing-configuration bypass',()=>{expect(()=>createUpstashMcpOperationalStore({VITEST:'true'},resource)).toThrow('obrigatórios');expect(f.redis).not.toHaveBeenCalled();});
 it.each([{...env,UPSTASH_REDIS_REST_URL:'http://redis.example.test'},{...env,UPSTASH_REDIS_REST_TOKEN:''},{...env,UPSTASH_REDIS_REST_URL:'https://secret@redis.example.test'}])('rejects unsafe config without exposing its value',config=>{expect(()=>createUpstashMcpOperationalStore(config,resource)).toThrow('UPSTASH_REDIS_REST_URL/TOKEN válidos são obrigatórios para MCP');expect(f.redis).not.toHaveBeenCalled();});
 it('configures stable distributed budgets, bounded network requests and no analytics/cache fallback',()=>{createUpstashMcpOperationalStore(env,resource);expect(f.redis).toHaveBeenCalledWith(expect.objectContaining({retry:{retries:0},signal:expect.any(Function)}));expect(f.config).toHaveBeenCalledTimes(6);const budgets=f.config.mock.calls.map(([c])=>[c.prefix.split(':').at(-1),c.limiter.limit]);expect(budgets).toEqual([['global',1200],['oauth-global',60],['oauth',60],['oauth-write',20],['mcp',120],['metadata',120]]);for(const [c] of f.config.mock.calls)expect(c).toMatchObject({ephemeralCache:false,analytics:false,timeout:1000,limiter:{window:'1 m'}});});
 it('preserves timeout reason rather than trusting success:true',async()=>{const store=createUpstashMcpOperationalStore(env,resource);f.limit.mockResolvedValue({success:true,reset:1800000000000,reason:'timeout'});expect(await store.limit('oauth-write','hash')).toMatchObject({success:true,reason:'timeout'});expect(f.limit).toHaveBeenCalledWith(expect.stringMatching(/:oauth-write$/),'hash');});
 it('uses one resource-scoped shared NX+EX throttle lease across instances',async()=>{const one=createUpstashMcpOperationalStore(env,resource);const two=createUpstashMcpOperationalStore(env,resource);expect(await one.acquireRetentionLease()).toBe(true);f.set.mockResolvedValue(null);expect(await two.acquireRetentionLease()).toBe(false);expect(f.set.mock.calls[0]).toEqual(f.set.mock.calls[1]);expect(f.set).toHaveBeenCalledWith(expect.stringMatching(/^rl:corex:mcp:[a-f0-9]{24}:retention$/),'held',{nx:true,ex:60});});
});
