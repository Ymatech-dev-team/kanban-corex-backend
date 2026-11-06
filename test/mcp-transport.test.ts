import { describe, expect, it, vi } from "vitest";
import { createMcpTransport } from "../src/modules/mcp/transport.js";
const issuer='https://api.corex.test/oauth',resource='https://api.corex.test/mcp';
function setup(){
 const verifier={verifyAccessToken:vi.fn().mockResolvedValue({issuer,audience:resource,expiresAt:Math.floor(Date.now()/1000)+600,scopes:['tasks:read'],grantId:'grant',clientId:'claude',userId:'user',orgId:'org',tokenVersion:1})};
 const authorization={authorize:vi.fn().mockResolvedValue({session:{userId:'user',orgId:'org',permissions:new Set(),mustChangePassword:false},connectionId:'grant',channel:'MCP',clientId:'claude',scopes:new Set(['tasks:read'])})};
 const execute=vi.fn().mockResolvedValue({id:'user'});
 const handler=createMcpTransport({issuer,resource,verifier,authorization,tools:[{name:'get_current_user',description:'Conta conectada',inputSchema:{},readOnly:true,execute}]});
 const request=(body:unknown,extra:Record<string,string>={})=>handler.fetch(new Request(resource,{method:'POST',headers:{authorization:'Bearer opaque','content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25',...extra},body:JSON.stringify(body)}));
 return {handler,request,verifier,authorization,execute};
}
async function payload(response:Response){const text=await response.text();return text.startsWith('event:')||text.startsWith('data:') ? JSON.parse(text.split('\n').find(l=>l.startsWith('data:'))!.slice(5)) : JSON.parse(text);}
describe('real SDK stateless transport',()=>{
 it('publishes protected-resource metadata without account data',async()=>{const {handler}=setup();const r=await handler.fetch(new Request('https://api.corex.test/.well-known/oauth-protected-resource/mcp'));expect(r.status).toBe(200);expect(await r.json()).toMatchObject({resource,authorization_servers:[issuer]});});
 it('challenges missing bearer before SDK dispatch',async()=>{const s=setup();const r=await s.request({jsonrpc:'2.0',id:1,method:'tools/list'},{authorization:''});expect(r.status).toBe(401);expect(r.headers.get('www-authenticate')).toContain('resource_metadata');expect(s.execute).not.toHaveBeenCalled();});
 it('rejects web/foreign audience tokens',async()=>{const s=setup();s.verifier.verifyAccessToken.mockResolvedValue(null);expect((await s.request({jsonrpc:'2.0',id:1,method:'tools/list'})).status).toBe(401);});
 it('serves tool list via SDK and exposes no human approval tool',async()=>{const s=setup();const r=await s.request({jsonrpc:'2.0',id:1,method:'tools/list'});expect(r.status).toBe(200);const body=await payload(r);expect(body.result.tools.map((t:{name:string})=>t.name)).toEqual(['get_current_user']);expect(s.authorization.authorize).toHaveBeenCalledWith('opaque','get_current_user');});
 it('dispatches only server registered tools with verified bearer',async()=>{const s=setup();const r=await s.request({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'get_current_user',arguments:{}}});expect(r.status).toBe(200);expect((await payload(r)).result.isError).not.toBe(true);expect(s.execute).toHaveBeenCalledWith('opaque',{});});
 it('rejects hostile browser origin before tool invocation',async()=>{const s=setup();expect((await s.request({jsonrpc:'2.0',id:1,method:'tools/list'},{origin:'https://evil.test'})).status).toBe(403);expect(s.execute).not.toHaveBeenCalled();});
 it('never turns storage failure into authenticated tool call',async()=>{const s=setup();s.verifier.verifyAccessToken.mockRejectedValue(new Error('db unavailable'));expect((await s.request({jsonrpc:'2.0',id:1,method:'tools/list'})).status).toBe(500);expect(s.execute).not.toHaveBeenCalled();});
});
