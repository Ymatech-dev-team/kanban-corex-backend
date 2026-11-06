import Fastify from 'fastify';
import { describe,expect,it,vi } from 'vitest';
import { makeMcpRoutes } from '../src/modules/mcp/mcp.routes.js';
import { McpOperationalError } from '../src/modules/mcp/operational-guards.js';
import { registerInternalAuth } from '../src/plugins/internal-auth.js';
import type { McpConnectionStore } from '../src/modules/mcp/oauth/prisma-store.js';
function setup(error?:Error){
  const app=Fastify();process.env.INTERNAL_API_SECRET='test-only';registerInternalAuth(app);
  const check=vi.fn(async()=>{if(error)throw error;});
  const oauth={handle:vi.fn(async(_req,res)=>{res.end('provider');})};
  const transport={handle:vi.fn(async(_req,res)=>{res.end('SDK');})};
  app.register(makeMcpRoutes({issuer:'http://localhost/oauth',resource:'http://localhost/mcp',oauth,transport,connections:{} as McpConnectionStore,authenticate:async()=>{},operationalGuard:{check}}));
  return {app,check,oauth,transport};
}
describe('raw routes enforce operational guard before provider or SDK',()=>{
  it.each(['/oauth/token','/mcp','/.well-known/oauth-protected-resource/mcp','/.well-known/oauth-authorization-server/oauth'])('rejects exhausted budget before dispatch %s',async(url)=>{const s=setup(new McpOperationalError(429,60));try{const r=await s.app.inject({method:url.includes('.well-known')?'GET':'POST',url,payload:url.includes('.well-known')?undefined:'unparsed-secret'});expect(r.statusCode).toBe(429);expect(r.headers['retry-after']).toBe('60');expect(r.headers['cache-control']).toBe('no-store');expect(s.oauth.handle).not.toHaveBeenCalled();expect(s.transport.handle).not.toHaveBeenCalled();}finally{await s.app.close();}});
  it('returns sanitized503 for operational store error before raw handler',async()=>{const s=setup(new Error('redis-secret'));try{const r=await s.app.inject({method:'POST',url:'/mcp',payload:'not-json'});expect(r.statusCode).toBe(503);expect(r.body).not.toContain('redis-secret');expect(s.transport.handle).not.toHaveBeenCalled();}finally{await s.app.close();}});
  it('calls guard once before allowed raw OAuth request and before body parser',async()=>{const s=setup();try{const r=await s.app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:'grant_type=authorization_code'});expect(r.statusCode).toBe(200);expect(s.check).toHaveBeenCalledOnce();expect(s.check.mock.invocationCallOrder[0]).toBeLessThan(s.oauth.handle.mock.invocationCallOrder[0]);}finally{await s.app.close();}});
});

it('Node MCP wrapper rejects bodies above128KiB before token verification',async()=>{
  const { createMcpTransport } = await import('../src/modules/mcp/transport.js');
  const verifier={verifyAccessToken:vi.fn().mockResolvedValue(null)};
  const transport=createMcpTransport({issuer:'http://localhost/oauth',resource:'http://localhost/mcp',verifier,authorization:{authorize:vi.fn()},tools:[]});
  const app=Fastify();
  app.all('/mcp',{onRequest:async(req,reply)=>{reply.hijack();await transport.handle(req.raw,reply.raw);}},async()=>{});
  try {
    const response=await app.inject({method:'POST',url:'/mcp',headers:{authorization:'Bearer token','content-type':'application/json'},payload:'x'.repeat(128*1024+1)});
    expect(response.statusCode).toBe(413);
    expect(verifier.verifyAccessToken).not.toHaveBeenCalled();
  } finally {await app.close();}
});
