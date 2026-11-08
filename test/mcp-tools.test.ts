import { describe, expect, it, vi } from 'vitest';
import { PERMISSIONS } from '@sistema-tasks/contracts';
import { createMcpTransport } from '../src/modules/mcp/transport.js';
import { createCorexMcpTools } from '../src/modules/mcp/tools.js';
function setup(enabled=true){
 const session={userId:'user',orgId:'org',permissions:new Set([PERMISSIONS.tarefas_editar,PERMISSIONS.tarefas_revisar,PERMISSIONS.tarefas_criar]),mustChangePassword:false};
 const ctx={session,connectionId:'trusted-grant',clientId:'claude',channel:'MCP' as const,scopes:new Set(['tasks:read','tasks:update','tasks:create'])};
 const authorization={authorize:vi.fn().mockResolvedValue(ctx)};
 const task={id:'task',orgId:'org',projectId:'canonical-project',title:'Task',status:'DOING',estimatedMinutes:240};
 const tasks={getOrThrow:vi.fn().mockResolvedValue(task),listAll:vi.fn().mockResolvedValue({tasks:[task],hasMore:false})};
 const projects={list:vi.fn().mockResolvedValue([{id:'client',name:'Client'}])};
 const engagements={list:vi.fn().mockResolvedValue([{id:'engagement',projectId:'client',name:'Project',isGeneral:false,description:null}])};
 const workflow={load:vi.fn().mockResolvedValue({taskId:'task',version:2,stage:'DOING'}),events:vi.fn().mockResolvedValue([]),actions:vi.fn().mockResolvedValue([]),listActions:vi.fn().mockResolvedValue([]),initialize:vi.fn(),execute:vi.fn().mockResolvedValue({taskId:'task',version:3}),requestAction:vi.fn(),createManagedTask:vi.fn().mockResolvedValue({taskId:'new-task',version:0})};
 const tools=createCorexMcpTools({authorization,tasks,projects,engagements,workflow,workflowEnabled:enabled});
 const call=(name:string,input:unknown)=>{const tool=tools.find(t=>t.name===name);if(!tool)throw new Error('missing tool '+name);return tool.execute('opaque',input);};
 return {authorization,tasks,engagements,workflow,tools,call,ctx};
}
describe('Corex MCP authorized tool adapters',()=>{
 it('does not write when approval consent is missing and preserves reconnection guidance',async()=>{
  const s=setup();
  s.authorization.authorize.mockResolvedValueOnce(s.ctx).mockRejectedValueOnce(new Error('Reconecte o aplicativo e autorize a conclusão de tarefas (tasks:approve).'));
  await expect(s.call('approve_review',{taskId:'task',operationId:'op',expectedVersion:2,cycle:1})).rejects.toThrow(/Reconecte.*tasks:approve/);
  expect(s.workflow.execute).not.toHaveBeenCalled();
 });

 it('routes autonomous approval with only delegated approval capability', async()=>{
  const s=setup(); s.ctx.session.permissions.add(PERMISSIONS.tarefas_aprovar);
  await s.call('approve_review',{taskId:'task',operationId:'approve',expectedVersion:2,cycle:1});
  expect(s.authorization.authorize).toHaveBeenLastCalledWith('opaque','approve_review','canonical-project');
  expect(s.workflow.execute).toHaveBeenCalledWith(expect.objectContaining({channel:'MCP',canApprove:true,canReopen:false}),'task',expect.objectContaining({command:{type:'approve_review',cycle:1}}));
 });
 it.each([
  ['request_changes',{cycle:1,reason:'Typecheck failed'},{type:'request_changes',cycle:1,reason:'Typecheck failed'}],
  ['record_delivery_evidence',{summary:'Deploy verified',evidence:['deployment URL']},{type:'record_evidence',summary:'Deploy verified',evidence:['deployment URL']}],
 ])('routes %s to the same versioned workflow',async(name,fields,command)=>{
  const s=setup(); await s.call(name,{taskId:'task',operationId:'op',expectedVersion:2,...fields});
  expect(s.workflow.execute).toHaveBeenCalledWith(expect.objectContaining({channel:'MCP'}),'task',{operationId:'op',expectedVersion:2,command});
 });
 it('does not let callers inject approval capabilities or omit final evidence',async()=>{
  const s=setup(); await expect(s.call('approve_review',{taskId:'task',operationId:'op',expectedVersion:2,cycle:1,canApprove:true})).rejects.toThrow();
  await expect(s.call('record_delivery_evidence',{taskId:'task',operationId:'op',expectedVersion:2,summary:'done',evidence:[]})).rejects.toThrow();
  expect(s.workflow.execute).not.toHaveBeenCalled();
 });

 it.each(['IN_REVIEW', 'CHANGES_REQUESTED'])('returns authoritative %s status in detail and search without changing the stored legacy status', async (stage) => {
   const s = setup();
   s.workflow.load.mockResolvedValue({taskId:'task',version:6,stage});
   expect(await s.call('get_task',{taskId:'task'})).toMatchObject({task:{status:stage,legacyStatus:'DOING',statusSource:'workflow'},status:stage,state:{stage}});
   expect(await s.call('search_tasks',{})).toMatchObject({tasks:[{status:stage,legacyStatus:'DOING',statusSource:'workflow'}]});
   expect(s.workflow.load).toHaveBeenLastCalledWith('org','task');
   expect((await s.tasks.getOrThrow()).status).toBe('DOING');
 });
 it('keeps legacy status for tasks without a workflow', async () => {
   const s = setup(); s.workflow.load.mockResolvedValue(null);
   expect(await s.call('get_task',{taskId:'task'})).toMatchObject({task:{status:'DOING',legacyStatus:'DOING',statusSource:'legacy'},state:null});
   expect(await s.call('search_tasks',{})).toMatchObject({tasks:[{status:'DOING',legacyStatus:'DOING',statusSource:'legacy'}]});
 });
 it('enriches a mixed page without changing its order or pagination', async () => {
   const s = setup(); const task = await s.tasks.getOrThrow();
   s.tasks.listAll.mockResolvedValue({tasks:[{...task,id:'review'},{...task,id:'legacy'}],hasMore:true,nextCursor:'next-page'});
   s.workflow.load.mockImplementation(async (_org, taskId) => taskId === 'review' ? {taskId,version:6,stage:'IN_REVIEW'} : null);
   expect(await s.call('search_tasks',{})).toMatchObject({tasks:[{id:'review',status:'IN_REVIEW'},{id:'legacy',status:'DOING'}],hasMore:true,nextCursor:'next-page'});
   expect(s.workflow.load.mock.calls).toEqual([['org','review'],['org','legacy']]);
 });
 it('does not present the legacy status as authoritative when workflow lookup fails', async () => {
   const s = setup(); s.workflow.load.mockRejectedValue(new Error('storage unavailable'));
   await expect(s.call('get_task',{taskId:'task'})).rejects.toThrow('storage unavailable');
   await expect(s.call('search_tasks',{})).rejects.toThrow('storage unavailable');
 });
 it('does not load workflows while disabled', async () => {
   const s = setup(false);
   expect(await s.call('get_task',{taskId:'task'})).toMatchObject({task:{status:'DOING',statusSource:'legacy'},state:null});
   expect(await s.call('search_tasks',{})).toMatchObject({tasks:[{status:'DOING',statusSource:'legacy'}]});
   expect(s.workflow.load).not.toHaveBeenCalled();
 });
 it('preserves the documented legacy search grouping for existing clients', async () => {
   const s = setup();
   await s.call('search_tasks',{status:'DOING'});
   expect(s.tasks.listAll).toHaveBeenCalledWith(s.ctx.session,expect.objectContaining({status:'DOING'}));
   expect(s.tools.find(t => t.name === 'search_tasks')?.description).toContain('agrupamento legado');
 });
 it('returns the same authoritative status after a successful workflow mutation', async () => {
   const s=setup(); s.workflow.execute.mockResolvedValue({taskId:'task',version:3,stage:'IN_REVIEW'});
   expect(await s.call('submit_for_review',{taskId:'task',operationId:'op',expectedVersion:2,summary:'Done',evidence:['proof'],reviewerId:'user',checks:[]})).toMatchObject({status:'IN_REVIEW',state:{stage:'IN_REVIEW'},nextAllowedStep:'REVIEW_AND_RESOLVE_CHECKS'});
 });
 it.each([
   ['list_projects', {}], ['search_tasks', {}], ['get_task_timeline', { taskId: 'task' }], ['list_pending_actions', {}],
 ])('SDK accepts omitted default arguments for %s', async (name, args) => {
   const s = setup();
   const issuer = 'https://api.corex.test/oauth', resource = 'https://api.corex.test/mcp';
   const verifier = { verifyAccessToken: vi.fn().mockResolvedValue({ issuer, audience: resource, expiresAt: Math.floor(Date.now()/1000)+600, scopes: ['projects:read','tasks:read'], grantId:'grant',clientId:'claude',userId:'user',orgId:'org',tokenVersion:1 }) };
   const handler = createMcpTransport({ issuer, resource, authorization:s.authorization, verifier, tools:s.tools });
   const response = await handler.fetch(new Request(resource, { method:'POST', headers: { authorization:'Bearer opaque', 'content-type':'application/json', accept:'application/json, text/event-stream', 'mcp-protocol-version':'2025-11-25' }, body: JSON.stringify({jsonrpc:'2.0', id:1, method:'tools/call', params:{name, arguments:args}}) }));
   expect(response.status).toBe(200);
   const text = await response.text();
   const data = text.split('\n').find(line => line.startsWith('data:'));
   const message = JSON.parse(data ? data.slice(5) : text);
   expect(message.error).toBeUndefined();
   expect(message.result.isError).not.toBe(true);
   expect(message.result.content[0].type).toBe('text');
   if (name === 'search_tasks') expect(s.tasks.listAll).toHaveBeenCalledWith(s.ctx.session, expect.objectContaining({limit:50}));
   if (name === 'get_task_timeline') expect(s.workflow.events).toHaveBeenCalledWith('org','task',undefined,51);
   if (name === 'list_pending_actions') expect(s.workflow.listActions).toHaveBeenCalledWith('org','user',undefined,51);
 });

 it('all actual tool schemas register through real SDK JSON-schema bridge',async()=>{const s=setup();const issuer='https://api.corex.test/oauth',resource='https://api.corex.test/mcp';const verifier={verifyAccessToken:vi.fn().mockResolvedValue({issuer,audience:resource,expiresAt:Math.floor(Date.now()/1000)+600,scopes:['tasks:read'],grantId:'grant',clientId:'claude',userId:'user',orgId:'org',tokenVersion:1})};const handler=createMcpTransport({issuer,resource,authorization:s.authorization,verifier,tools:s.tools});const r=await handler.fetch(new Request(resource,{method:'POST',headers:{authorization:'Bearer opaque','content-type':'application/json',accept:'application/json, text/event-stream','mcp-protocol-version':'2025-11-25'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})}));expect(r.status).toBe(200);const output=await r.text();expect(output).toContain('create_task');expect(output).toContain('externalReference');expect(output).toContain('record_review_findings');expect(output).toContain('approve_review');});

 it('lists projects within accessible clients using explicit external vocabulary',async()=>{const s=setup();expect(await s.call('list_projects',{})).toMatchObject({clients:[{clientId:'client',projects:[{projectId:'engagement',clientId:'client'}]}]});expect(s.authorization.authorize).toHaveBeenLastCalledWith('opaque','list_client_projects','client');expect(s.engagements.list).toHaveBeenCalledWith(s.ctx.session,'client');});
 it('maps client/project task filters to canonical service columns',async()=>{const s=setup();await s.call('search_tasks',{clientId:'client',projectId:'engagement'});expect(s.tasks.listAll).toHaveBeenCalledWith(s.ctx.session,expect.objectContaining({projectId:'client',engagementId:'engagement'}));});
 it('rejects generic DONE and missing stable external reference before persistence',async()=>{const s=setup();await expect(s.call('transition_task',{taskId:'task',operationId:'op',expectedVersion:2,to:'DONE'})).rejects.toThrow();await expect(s.call('create_task',{operationId:'op',clientId:'client',projectId:'engagement',title:'Task',responsibleId:'user',criteria:['works'],context:'scope'})).rejects.toThrow();expect(s.workflow.execute).not.toHaveBeenCalled();expect(s.workflow.createManagedTask).not.toHaveBeenCalled();});

 it('resolves canonical task project before exposing record and redacts costs',async()=>{const s=setup();const result=await s.call('get_task',{taskId:'task'});expect(s.authorization.authorize).toHaveBeenLastCalledWith('opaque','get_task','canonical-project');expect(JSON.stringify(result)).not.toContain('240');expect(s.tasks.getOrThrow).toHaveBeenCalledWith(s.ctx.session,'task');});
 it('never uses model actor/org/project as authorization context',async()=>{const s=setup();await expect(s.call('get_task',{taskId:'task',projectId:'fake',actorId:'admin',orgId:'other'})).rejects.toThrow();expect(s.tasks.getOrThrow).not.toHaveBeenCalled();});
 it('scope-denied task returns no record',async()=>{const s=setup();s.authorization.authorize.mockRejectedValueOnce(new Error('revoked'));await expect(s.call('get_task',{taskId:'task'})).rejects.toThrow('revoked');expect(s.tasks.getOrThrow).not.toHaveBeenCalled();});
 it('writes to same task with trusted MCP actor and human privileges false',async()=>{const s=setup();await s.call('transition_task',{taskId:'task',operationId:'op',expectedVersion:2,to:'IN_REVIEW'});expect(s.workflow.execute).toHaveBeenCalledWith(expect.objectContaining({userId:'user',orgId:'org',channel:'MCP',connectionId:'trusted-grant',canApprove:false,canReopen:false}),'task',{operationId:'op',expectedVersion:2,command:{type:'transition',to:'IN_REVIEW'}});});
 it('has no waiver/delete or impersonated response tool',()=>{const s=setup();for(const name of ['waive_finding','delete_task','resolve_user_action'])expect(s.tools.find(t=>t.name===name)).toBeUndefined();});
 it('feature-disabled tools do not advertise workflow mutations',()=>{const s=setup(false);expect(s.tools.some(t=>!t.readOnly)).toBe(false);});
 it('creates through atomic managed facade with verified project',async()=>{const s=setup();await s.call('create_task',{operationId:'op',externalReference:'plan/item',clientId:'project',projectId:'engagement',title:'Implement',responsibleId:'user',criteria:['works'],context:'scope'});expect(s.authorization.authorize).toHaveBeenLastCalledWith('opaque','create_task','project');expect(s.workflow.createManagedTask).toHaveBeenCalledWith(expect.objectContaining({channel:'MCP',connectionId:'trusted-grant'}),expect.objectContaining({operationId:'op',externalReference:'plan/item',projectId:'project',engagementId:'engagement',title:'Implement'}));});
});
