import { createServer } from "node:http";
import { createHash, generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMcpOAuth } from "../src/modules/mcp/oauth/provider.js";
import type { OAuthRecord, OAuthRecordStore } from "../src/modules/mcp/oauth/storage.js";
import type { McpConnection, McpConnectionStore } from "../src/modules/mcp/oauth/prisma-store.js";
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks = { keys: [{ ...privateKey.export({ format: "jwk" }), kid: "test-only", use: "sig", alg: "RS256" }] };
const user = { id: "user", orgId: "org", tokenVersion: 2, deletedAt: null, mustChangePassword: false, rolePermissions: [], extraPermissions: [] };
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function setup(dropSocketAfterBody = false) {
  const artifacts = new Map<string, OAuthRecord>(); const grants = new Map<string, McpConnection>();
  const records: OAuthRecordStore = {
    async put(r) { const old=artifacts.get(`${r.model}:${r.id}`); artifacts.set(`${r.model}:${r.id}`, structuredClone({ ...r,payload:{...r.payload,...(old?.payload.consumed ? {consumed:old.payload.consumed}:{})} })); },
    async get(model, field, value) { return structuredClone([...artifacts.values()].find(r => r.model===model && (field==='id' ? r.id===value:r.payload[field]===value)) ?? null); },
    async consume(model,id,now) { const r=artifacts.get(`${model}:${id}`); if(!r || r.payload.consumed || (r.expiresAt!==null && r.expiresAt<=now))return false;r.payload.consumed=now;return true; },
    async delete(model,id) { artifacts.delete(`${model}:${id}`); },
    async revokeGrant(id) { for(const [key,r] of artifacts)if(r.payload.grantId===id || (r.model==='Grant' && r.id===id))artifacts.delete(key);const c=grants.get(id);if(c)c.revokedAt=new Date(); },
  };
  const connections: McpConnectionStore = { async create(c) { if(grants.has(c.id))throw new Error('duplicate');grants.set(c.id,structuredClone(c)); }, async findById(id){return structuredClone(grants.get(id)??null);}, async list(u,o){return [...grants.values()].filter(c=>c.userId===u&&c.orgId===o);}, async revoke(id,u,o){const c=grants.get(id);if(!c||c.userId!==u||c.orgId!==o)return false;await records.revokeGrant(id);return true;} };
  const server=createServer((req,res)=> { if(dropSocketAfterBody)req.once("end",()=>{Object.defineProperty(req,"socket",{value:null,configurable:true});}); void service.handle(req,res).catch(()=>{res.statusCode=500;res.end('error');}); });
  await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",resolve);});
  cleanup.push(()=>new Promise<void>(resolve=>{server.closeAllConnections();server.close(()=>resolve());}));
  const address=server.address();if(!address || typeof address==='string')throw new Error('address');
  const base=`http://127.0.0.1:${address.port}`;const issuer=`${base}/oauth`;const resource=`${base}/mcp`;
  const users={findById:vi.fn().mockResolvedValue({...user})};
  const authenticate=vi.fn(async(email:string,password:string)=>{if(email!=='person@example.test'||password!=='test-password')throw new Error('bad login');return {...user};});
  const service=createMcpOAuth({issuer,resource,cookieKeys:['test-cookie-key-at-least-32-characters'],jwks,clients:[{client_id:'claude',redirect_uris:['https://client.example.test/callback'],response_types:['code'],grant_types:['authorization_code','refresh_token'],token_endpoint_auth_method:'none'}],records,connections,users,authenticate});
  const jar = new Map<string,string>();
  async function request(url:string,init:RequestInit={}) {
    const response=await fetch(new URL(url,base),{...init,redirect:'manual',headers:{cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...init.headers}});
    for(const cookie of response.headers.getSetCookie()){const pair=cookie.split(';')[0];const split=pair.indexOf('=');jar.set(pair.slice(0,split),pair.slice(split+1));}
    return response;
  }
  const verifier='a'.repeat(64);const challenge=createHash('sha256').update(verifier).digest('base64url');
  async function authorize() {
    const q=new URLSearchParams({client_id:'claude',redirect_uri:'https://client.example.test/callback',response_type:'code',scope:'tasks:read tasks:update offline_access',resource,code_challenge:challenge,code_challenge_method:'S256',state:'test-state'});
    let response=await request(`${issuer}/auth?${q}`);
    expect(response.status).toBe(303);
    const interaction=response.headers.get('location')!;
    response=await request(interaction);expect(response.status).toBe(200);
    const html=await response.text();const csrf=html.match(/name="csrf" value="([^"]+)"/)?.[1];expect(csrf).toBeTruthy();
    return {interaction,csrf:csrf!};
  }
  async function approve() {
    const {interaction,csrf}=await authorize();
    let response=await request(interaction,{method:'POST',headers:{origin:base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,email:'person@example.test',password:'test-password',decision:'allow'})});
    expect(response.status).toBe(303);
    for(let i=0;i<5;i++){const location=response.headers.get('location')!;if(location.startsWith('https://client.example.test'))return new URL(location).searchParams.get('code')!;response=await request(location);expect(response.status).toBe(303);}
    throw new Error('authorization did not finish');
  }
  async function exchange(code:string,codeVerifier=verifier) { return request(`${issuer}/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'claude',grant_type:'authorization_code',code,redirect_uri:'https://client.example.test/callback',code_verifier:codeVerifier,resource})}); }
  return {base,issuer,resource,service,records,connections,users,authenticate,request,authorize,approve,exchange};
}
describe('real maintained OAuth provider',()=>{
  it('completes denial when the serverless request loses its socket after body consumption',async()=>{
    const s=await setup(true);const {interaction,csrf}=await s.authorize();
    const r=await s.request(interaction,{method:'POST',headers:{origin:s.base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,decision:'deny'})});
    expect(r.status).toBe(303);expect(s.authenticate).not.toHaveBeenCalled();
  });
  it('completes authorization when the serverless request loses its socket after body consumption',async()=>{
    const s=await setup(true);const code=await s.approve();
    expect((await s.exchange(code)).status).toBe(200);
  });
  it('serves consent with a referrer policy compatible with native same-origin forms',async()=>{
    const s=await setup();const {interaction}=await s.authorize();
    const response=await s.request(interaction);
    expect(response.headers.get('referrer-policy')).toBe('same-origin');
    expect(response.headers.get('content-security-policy')).toContain("form-action 'self'");
  });
  it.each(['null',''])('rejects opaque or missing Origin (%s) before authentication',async(origin)=>{
    const s=await setup();const {interaction,csrf}=await s.authorize();
    const headers:Record<string,string>={'content-type':'application/x-www-form-urlencoded'};
    if(origin)headers.origin=origin;
    const response=await s.request(interaction,{method:'POST',headers,body:new URLSearchParams({csrf,email:'person@example.test',password:'test-password',decision:'allow'})});
    expect(response.status).toBe(403);expect(s.authenticate).not.toHaveBeenCalled();
  });
  it('a denied interaction cannot later be approved from another previously loaded form',async()=>{const s=await setup();const {interaction,csrf}=await s.authorize();const nextHtml=await(await s.request(interaction)).text();const other=nextHtml.match(/name="csrf" value="([^"]+)"/)![1];const post=(value:string,decision:string)=>s.request(interaction,{method:'POST',headers:{origin:s.base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:value,email:'person@example.test',password:'test-password',decision})});expect((await post(csrf,'deny')).status).toBe(303);expect((await post(other,'allow')).status).not.toBe(303);expect(await s.connections.list('user','org')).toEqual([]);});

  it('offers a working retry after incorrect password without reviving consumed CSRF',async()=>{const s=await setup();const {interaction,csrf}=await s.authorize();const post=(value:string,password:string)=>s.request(interaction,{method:'POST',headers:{origin:s.base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:value,email:'person@example.test',password,decision:'allow'})});expect((await post(csrf,'wrong')).status).toBe(401);const retry=await s.request(interaction);const html=await retry.text();const next=html.match(/name="csrf" value="([^"]+)"/)![1];expect(next).not.toBe(csrf);expect((await post(next,'test-password')).status).toBe(303);expect((await post(csrf,'test-password')).status).not.toBe(303);});

  it('rotates refresh token and rejects replay of the previous refresh',async()=>{const s=await setup();const token=await(await s.exchange(await s.approve())).json();expect(token.refresh_token).toBeTruthy();const refresh=()=>s.request(`${s.issuer}/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'claude',grant_type:'refresh_token',refresh_token:token.refresh_token,resource:s.resource})});const renewed=await refresh();expect(renewed.status).toBe(200);const next=await renewed.json();expect(next.refresh_token).toBeTruthy();expect(next.refresh_token).not.toBe(token.refresh_token);expect(await s.service.verifyAccessToken(next.access_token)).toMatchObject({tokenVersion:2});expect((await refresh()).status).toBe(400);});
  it('rejects invalid CSRF without authenticating credentials',async()=>{const s=await setup();const {interaction}=await s.authorize();const r=await s.request(interaction,{method:'POST',headers:{origin:s.base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:'fake',email:'person@example.test',password:'test-password',decision:'allow'})});expect(r.status).toBe(403);expect(s.authenticate).not.toHaveBeenCalled();});
  it('denial issues no connection and does not authenticate',async()=>{const s=await setup();const {interaction,csrf}=await s.authorize();const r=await s.request(interaction,{method:'POST',headers:{origin:s.base,'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,decision:'deny'})});expect(r.status).toBe(303);expect(await s.connections.list('user','org')).toEqual([]);expect(s.authenticate).not.toHaveBeenCalled();});

  it('publishes discovery and requires PKCE S256',async()=>{const s=await setup();const r=await s.request(`${s.issuer}/.well-known/openid-configuration`);expect(r.status).toBe(200);const body=await r.json();expect(body.issuer).toBe(s.issuer);expect(body.code_challenge_methods_supported).toEqual(['S256']);});
  it('consents same panel account, exchanges code and validates dedicated resource token',async()=>{const s=await setup();const code=await s.approve();const r=await s.exchange(code);expect(r.status).toBe(200);const token=await r.json();expect(token.refresh_token).toBeTruthy();expect(await s.service.verifyAccessToken(token.access_token)).toMatchObject({userId:'user',orgId:'org',tokenVersion:2,audience:s.resource,issuer:s.issuer});expect(s.authenticate).toHaveBeenCalledWith('person@example.test','test-password');});
  it('rejects incorrect PKCE verifier',async()=>{const s=await setup();const r=await s.exchange(await s.approve(),'b'.repeat(64));expect(r.status).toBe(400);});
  it('rejects authorization-code replay',async()=>{const s=await setup();const code=await s.approve();expect((await s.exchange(code)).status).toBe(200);expect((await s.exchange(code)).status).toBe(400);});
  it('rejects cross-origin consent before account lookup',async()=>{const s=await setup();const {interaction,csrf}=await s.authorize();const r=await s.request(interaction,{method:'POST',headers:{origin:'https://evil.test','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,email:'person@example.test',password:'test-password',decision:'allow'})});expect(r.status).toBe(403);expect(s.authenticate).not.toHaveBeenCalled();});
  it('revokes access and refresh together without minting a renewed connection',async()=>{const s=await setup();const token=await(await s.exchange(await s.approve())).json();expect(token.refresh_token).toBeTruthy();const claims=await s.service.verifyAccessToken(token.access_token);expect(claims).toBeTruthy();await s.connections.revoke(claims!.grantId,'user','org');expect(await s.service.verifyAccessToken(token.access_token)).toBeNull();const refresh=await s.request(`${s.issuer}/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'claude',grant_type:'refresh_token',refresh_token:token.refresh_token,resource:s.resource})});expect(refresh.status).toBe(400);});
  it('password change prevents refreshing a grant with its old tokenVersion',async()=>{const s=await setup();const token=await(await s.exchange(await s.approve())).json();expect(token.refresh_token).toBeTruthy();s.users.findById.mockResolvedValue({...user,tokenVersion:3});const refresh=await s.request(`${s.issuer}/token`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:'claude',grant_type:'refresh_token',refresh_token:token.refresh_token,resource:s.resource})});expect(refresh.status).not.toBe(200);});
});
