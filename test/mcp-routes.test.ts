import Fastify from 'fastify';
import { describe,it,expect,vi } from 'vitest';
import { makeMcpRoutes } from '../src/modules/mcp/mcp.routes.js';
import { registerInternalAuth } from '../src/plugins/internal-auth.js';
import { registerErrorHandler } from '../src/plugins/error-handler.js';
import { signInternal } from '../src/lib/hmac.js';
import type { SessionContext } from '../src/modules/authz/types.js';
import type { McpConnectionStore } from '../src/modules/mcp/oauth/prisma-store.js';
function setup(){
  process.env.INTERNAL_API_SECRET='test-only-internal-secret';
  const app=Fastify();registerInternalAuth(app);registerErrorHandler(app);
  const oauth={handle:vi.fn(async(req,res)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({path:req.url}));})};
  const transport={handle:vi.fn(async(_req,res)=>{res.statusCode=401;res.end('OAuth required');})};
  const connections={list:vi.fn(async()=>[{id:'connection',clientId:'claude',scopes:['tasks:read'],expiresAt:123,revokedAt:null,tokenVersion:9,userId:'u',orgId:'org'}]),revoke:vi.fn(async()=>true)};
  app.register(makeMcpRoutes({issuer:'http://localhost/oauth',resource:'http://localhost/mcp',oauth,transport,connections:connections as unknown as McpConnectionStore,authenticate:async req=>{req.session={userId:'u',orgId:'org'} as SessionContext;}}));
  app.post('/internal',async()=>({ok:true}));
  function headers(){const ts=Date.now();return {'x-internal-timestamp':String(ts),'x-internal-signature':signInternal(process.env.INTERNAL_API_SECRET!,'',ts)};}
  return {app,oauth,transport,connections,headers};
}
describe('MCP explicit Fastify boundary',()=>{
  it('dispatches raw OAuth form before HMAC/json parsing',async()=>{const s=setup();try{const r=await s.app.inject({method:'POST',url:'/oauth/token',headers:{'content-type':'application/x-www-form-urlencoded'},payload:'grant_type=authorization_code'});expect(r.statusCode).toBe(200);expect(s.oauth.handle).toHaveBeenCalledOnce();}finally{await s.app.close();}});
  it('maps standard authorization discovery to provider metadata',async()=>{const s=setup();try{const r=await s.app.inject({url:'/.well-known/oauth-authorization-server/oauth'});expect(r.statusCode).toBe(200);expect(r.json().path).toBe('/oauth/.well-known/openid-configuration');}finally{await s.app.close();}});
  it('sends MCP requests to dedicated OAuth gate',async()=>{const s=setup();try{const r=await s.app.inject({method:'POST',url:'/mcp',payload:{jsonrpc:'2.0',id:1,method:'initialize'}});expect(r.statusCode).toBe(401);expect(r.body).toBe('OAuth required');expect(s.transport.handle).toHaveBeenCalledOnce();}finally{await s.app.close();}});
  it('does not open unrelated internal routes',async()=>{const s=setup();try{expect((await s.app.inject({method:'POST',url:'/internal'})).statusCode).toBe(401);}finally{await s.app.close();}});
  it('keeps connection management behind HMAC and session',async()=>{const s=setup();try{expect((await s.app.inject({url:'/mcp/connections'})).statusCode).toBe(401);expect(s.connections.list).not.toHaveBeenCalled();const r=await s.app.inject({url:'/mcp/connections',headers:s.headers()});expect(r.statusCode).toBe(200);expect(s.connections.list).toHaveBeenCalledWith('u','org');expect(r.json().connections[0]).not.toHaveProperty('tokenVersion');}finally{await s.app.close();}});
  it('revokes only current account connection',async()=>{const s=setup();try{expect((await s.app.inject({method:'DELETE',url:'/mcp/connections/connection',headers:s.headers()})).statusCode).toBe(200);expect(s.connections.revoke).toHaveBeenCalledWith('connection','u','org');}finally{await s.app.close();}});
});
