import { describe,it,expect } from 'vitest';
import { mcpConfigFromEnv } from '../src/modules/mcp/runtime.js';
const env = {MCP_ISSUER:'http://127.0.0.1:3001/oauth',MCP_RESOURCE:'http://127.0.0.1:3001/mcp',MCP_COOKIE_KEYS:JSON.stringify(['x'.repeat(40)]),MCP_JWKS:JSON.stringify({keys:[{kty:'RSA'}]}),MCP_OAUTH_CLIENTS:JSON.stringify([{client_id:'test'}])};
describe('MCP runtime configuration',()=>{
  it('requires explicit persistent secrets and clients',()=>{expect(()=>mcpConfigFromEnv({})).toThrow();expect(()=>mcpConfigFromEnv({...env,MCP_COOKIE_KEYS:'[]'})).toThrow();expect(()=>mcpConfigFromEnv({...env,MCP_OAUTH_CLIENTS:'[]'})).toThrow();});
  it('constrains mount paths and shared canonical origin',()=>{expect(()=>mcpConfigFromEnv({...env,MCP_RESOURCE:'https://other.example/mcp'})).toThrow();expect(()=>mcpConfigFromEnv({...env,MCP_ISSUER:'http://127.0.0.1:3001/auth'})).toThrow();});
  it('fails closed on malformed config without exposing value',()=>{expect(()=>mcpConfigFromEnv({...env,MCP_JWKS:'secret-not-json'})).toThrow('Configuração JSON do MCP ausente ou inválida');});
  it('accepts explicit loopback setup without enabling trust proxy by default',()=>{expect(mcpConfigFromEnv(env)).toMatchObject({issuer:env.MCP_ISSUER,resource:env.MCP_RESOURCE,trustProxy:false,allowedOrigins:[]});});
});
