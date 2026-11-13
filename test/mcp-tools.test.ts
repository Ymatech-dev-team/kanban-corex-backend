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
 it('defaults submit without reviewer to AGENT and preserves explicit HUMAN',async()=>{const s=setup();const input={taskId:'task',operationId:'op',expectedVersion:2,summary:'done',evidence:['log'],checks:[]};await s.call('submit_for_review',input);expect(s.workflow.execute).toHaveBeenLastCalledWith(expect.anything(),'task',expect.objectContaining({command:expect.objectContaining({reviewMode:'AGENT'})}));await s.call('submit_for_review',{...input,reviewerId:'user',reviewMode:'HUMAN'});expect(s.workflow.execute).toHaveBeenLastCalledWith(expect.anything(),'task',expect.objectContaining({command:expect.objectContaining({reviewMode:'HUMAN',reviewerId:'user'})}));});
 it('routes legacy adoption with scoped authorization',async()=>{const s=setup();s.ctx.session.permissions.add(PERMISSIONS.tarefas_aprovar);await s.call('adopt_agent_review',{taskId:'task',operationId:'adopt',expectedVersion:2,cycle:1});expect(s.authorization.authorize).toHaveBeenLastCalledWith('opaque','adopt_agent_review','canonical-project');expect(s.workflow.execute).toHaveBeenLastCalledWith(expect.objectContaining({canApprove:true}),'task',expect.objectContaining({command:{type:'adopt_agent_review',cycle:1}}));});
 it('reports structured check blockers without asking for final human acceptance',async()=>{const s=setup();s.workflow.load.mockResolvedValue({taskId:'task',version:3,stage:'IN_REVIEW',reviews:[{reviewMode:'AGENT',checks:[{name:'lint',status:'failed',required:true}]}],findings:[]});const out=await s.call('get_task',{taskId:'task'});expect(out).toMatchObject({suggestedTool:'request_changes',completionBlockers:expect.arrayContaining([{kind:'CHECK',id:'lint',status:'failed'}])});});

 it.each(['approve_review','approve_anyway'])('does not write %s when approval consent is missing',async(name)=>{
  const s=setup();
  s.authorization.authorize.mockResolvedValueOnce(s.ctx).mockRejectedValueOnce(new Error('Reconecte o aplicativo e autorize a conclusão de tarefas (tasks:approve).'));
  await expect(s.call(name,{taskId:'task',operationId:'op',expectedVersion:2,cycle:1})).rejects.toThrow(/Reconecte.*tasks:approve/);
  expect(s.workflow.execute).not.toHaveBeenCalled();
 });

 it.each(['approve_review','approve_anyway'])('routes %s with only delegated approval capability', async(name)=>{
  const s=setup(); s.ctx.session.permissions.add(PERMISSIONS.tarefas_aprovar);
  await s.call(name,{taskId:'task',operationId:'approve',expectedVersion:2,cycle:1});
  expect(s.authorization.authorize).toHaveBeenLastCalledWith('opaque',name,'canonical-project');
  expect(s.workflow.execute).toHaveBeenCalledWith(expect.objectContaining({channel:'MCP',canApprove:true,canReopen:false}),'task',expect.objectContaining({command:{type:name,cycle:1}}));
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
 it('has no waiver/delete or impersonated response tool',()=>{const s=setup();for(const name of ['waive_finding','approve_with_reservations','delete_task','resolve_user_action'])expect(s.tools.find(t=>t.name===name)).toBeUndefined();});
 it('feature-disabled tools do not advertise workflow mutations',()=>{const s=setup(false);expect(s.tools.some(t=>!t.readOnly)).toBe(false);});
 it('creates through atomic managed facade with verified project',async()=>{const s=setup();await s.call('create_task',{operationId:'op',externalReference:'plan/item',clientId:'project',projectId:'engagement',title:'Implement',responsibleId:'user',criteria:['works'],context:'scope'});expect(s.authorization.authorize).toHaveBeenLastCalledWith('opaque','create_task','project');expect(s.workflow.createManagedTask).toHaveBeenCalledWith(expect.objectContaining({channel:'MCP',connectionId:'trusted-grant'}),expect.objectContaining({operationId:'op',externalReference:'plan/item',projectId:'project',engagementId:'engagement',title:'Implement'}));});
});

it('offers explicit override on HUMAN and legacy review without hiding blockers',async()=>{for(const reviewMode of ['HUMAN',undefined]){const s=setup();s.ctx.session.permissions.add(PERMISSIONS.tarefas_aprovar);s.ctx.scopes.add('tasks:approve');s.workflow.load.mockResolvedValue({taskId:'task',version:3,stage:'IN_REVIEW',deliveryRevision:1,reviews:[{decision:'pending',deliveryRevision:1,reviewMode,checks:[{name:'lint',status:'failed',required:true}]}],findings:[]});expect(await s.call('get_task',{taskId:'task'})).toMatchObject({approvalOverrideAvailable:true,approvalOverrideTool:'approve_anyway',completionBlockers:expect.arrayContaining([{kind:'CHECK',id:'lint',status:'failed'}])});}});

it('does not advertise approval override without current delegated approval',async()=>{const s=setup();s.workflow.load.mockResolvedValue({taskId:'task',version:3,stage:'IN_REVIEW',deliveryRevision:1,reviews:[{decision:'pending',deliveryRevision:1,reviewMode:'HUMAN',checks:[]}],findings:[]});expect(await s.call('get_task',{taskId:'task'})).toMatchObject({approvalOverrideAvailable:false,approvalOverrideTool:null});s.ctx.session.permissions.add(PERMISSIONS.tarefas_aprovar);expect(await s.call('get_task',{taskId:'task'})).toMatchObject({approvalOverrideAvailable:false});});

// Contract frozen BEFORE the S3 description changes (RB6/RNF2): name, readOnly and the JSON input schema of every
// tool. Only `description` strings may change; schemas, validation and tool set must stay identical.
import { z as zodV4 } from 'zod/v4';
const FROZEN_TOOL_CONTRACT: Record<string, { readOnly: boolean; schema: unknown }> = {
 "get_current_user":{"readOnly":true,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{},"additionalProperties":false}},
 "list_projects":{"readOnly":true,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"offset":{"default":0,"type":"integer","minimum":0,"maximum":10000},"limit":{"default":50,"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false}},
 "search_tasks":{"readOnly":true,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"clientId":{"type":"string","minLength":1,"maxLength":128},"projectId":{"type":"string","minLength":1,"maxLength":128},"assigneeId":{"type":"string","minLength":1,"maxLength":128},"status":{"description":"Agrupamento legado do quadro, não etapa exata do workflow. DOING inclui IN_REVIEW e CHANGES_REQUESTED.","type":"string","enum":["TODO","DOING","DONE"]},"priority":{"type":"string","enum":["LOW","MEDIUM","HIGH"]},"limit":{"default":50,"type":"integer","minimum":1,"maximum":100},"includeDone":{"type":"boolean"},"cursor":{"type":"string","minLength":1,"maxLength":1024}},"additionalProperties":false}},
 "get_task":{"readOnly":true,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128}},"required":["taskId"],"additionalProperties":false}},
 "get_task_timeline":{"readOnly":true,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"beforeVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"limit":{"default":50,"type":"integer","minimum":1,"maximum":100}},"required":["taskId"],"additionalProperties":false}},
 "list_pending_actions":{"readOnly":true,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"before":{"type":"object","properties":{"createdAt":{"type":"string","format":"date-time","pattern":"^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$"},"id":{"type":"string","minLength":1,"maxLength":128}},"required":["createdAt","id"],"additionalProperties":false},"limit":{"default":50,"type":"integer","minimum":1,"maximum":100}},"additionalProperties":false}},
 "update_task":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"reason":{"type":"string","minLength":1,"maxLength":8000},"context":{"type":"string","minLength":1,"maxLength":8000},"criteria":{"minItems":1,"maxItems":100,"type":"array","items":{"type":"string","minLength":1,"maxLength":2000}}},"required":["taskId","operationId","expectedVersion","reason"],"additionalProperties":false}},
 "transition_task":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"to":{"type":"string","enum":["BACKLOG","PLANNING","READY","DOING","IN_REVIEW","CHANGES_REQUESTED"]},"reason":{"type":"string","minLength":1,"maxLength":8000}},"required":["taskId","operationId","expectedVersion","to"],"additionalProperties":false}},
 "start_execution":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"executionId":{"type":"string","minLength":1,"maxLength":128},"agent":{"type":"string","minLength":1,"maxLength":128},"sessionReference":{"type":"string","minLength":1,"maxLength":256}},"required":["taskId","operationId","expectedVersion","executionId","agent"],"additionalProperties":false}},
 "report_progress":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"executionId":{"type":"string","minLength":1,"maxLength":128},"status":{"type":"string","enum":["RUNNING","WAITING","PAUSED","FINISHED"]},"summary":{"type":"object","properties":{"objective":{"type":"string","minLength":1,"maxLength":8000},"completed":{"maxItems":50,"type":"array","items":{"type":"string","minLength":1,"maxLength":2000}},"remaining":{"maxItems":50,"type":"array","items":{"type":"string","minLength":1,"maxLength":2000}},"nextStep":{"type":"string","minLength":1,"maxLength":8000},"blockers":{"maxItems":50,"type":"array","items":{"type":"string","minLength":1,"maxLength":2000}},"references":{"maxItems":50,"type":"array","items":{"type":"string","minLength":1,"maxLength":2000}}},"required":["objective","completed","remaining","nextStep","blockers","references"],"additionalProperties":false}},"required":["taskId","operationId","expectedVersion","executionId","status","summary"],"additionalProperties":false}},
 "submit_for_review":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"summary":{"type":"string","minLength":1,"maxLength":8000},"evidence":{"minItems":1,"maxItems":50,"type":"array","items":{"type":"string","minLength":1,"maxLength":2000}},"reviewerId":{"type":"string","minLength":1,"maxLength":128},"reviewMode":{"type":"string","enum":["AGENT","HUMAN"]},"checks":{"maxItems":100,"type":"array","items":{"type":"object","properties":{"name":{"type":"string","minLength":1,"maxLength":128},"status":{"type":"string","enum":["passed","failed","pending"]},"required":{"type":"boolean"}},"required":["name","status","required"],"additionalProperties":false}}},"required":["taskId","operationId","expectedVersion","summary","evidence","checks"],"additionalProperties":false}},
 "request_changes":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"cycle":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991},"reason":{"type":"string","minLength":1,"maxLength":8000}},"required":["taskId","operationId","expectedVersion","cycle","reason"],"additionalProperties":false}},
 "adopt_agent_review":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"cycle":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}},"required":["taskId","operationId","expectedVersion","cycle"],"additionalProperties":false}},
 "approve_anyway":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"cycle":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}},"required":["taskId","operationId","expectedVersion","cycle"],"additionalProperties":false}},
 "approve_review":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"cycle":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}},"required":["taskId","operationId","expectedVersion","cycle"],"additionalProperties":false}},
 "record_delivery_evidence":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"summary":{"type":"string","minLength":1,"maxLength":8000},"evidence":{"minItems":1,"maxItems":50,"type":"array","items":{"type":"string","minLength":1,"maxLength":2000}}},"required":["taskId","operationId","expectedVersion","summary","evidence"],"additionalProperties":false}},
 "record_review_findings":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"id":{"type":"string","minLength":1,"maxLength":128},"description":{"type":"string","minLength":1,"maxLength":8000},"severity":{"type":"string","enum":["low","medium","high","critical"]},"criterion":{"type":"string","minLength":1,"maxLength":2000},"responsibleId":{"type":"string","minLength":1,"maxLength":128},"blocking":{"type":"boolean"}},"required":["taskId","operationId","expectedVersion","id","description","severity","criterion","responsibleId","blocking"],"additionalProperties":false}},
 "report_finding_fix":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"findingId":{"type":"string","minLength":1,"maxLength":128},"evidence":{"minItems":1,"maxItems":50,"type":"array","items":{"type":"string","minLength":1,"maxLength":2000}}},"required":["taskId","operationId","expectedVersion","findingId","evidence"],"additionalProperties":false}},
 "record_technical_review":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"findingId":{"type":"string","minLength":1,"maxLength":128},"cycle":{"type":"integer","exclusiveMinimum":0,"maximum":9007199254740991}},"required":["taskId","operationId","expectedVersion","findingId","cycle"],"additionalProperties":false}},
 "request_user_action":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"taskId":{"type":"string","minLength":1,"maxLength":128},"operationId":{"type":"string","minLength":1,"maxLength":256},"expectedVersion":{"type":"integer","minimum":0,"maximum":9007199254740991},"recipientId":{"type":"string","minLength":1,"maxLength":128},"kind":{"type":"string","enum":["CLARIFY_SCOPE","DECIDE","UNBLOCK"]},"question":{"type":"string","minLength":1,"maxLength":8000},"options":{"maxItems":20,"type":"array","items":{"type":"string","minLength":1,"maxLength":1000}}},"required":["taskId","operationId","expectedVersion","recipientId","kind","question","options"],"additionalProperties":false}},
 "create_task":{"readOnly":false,"schema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"operationId":{"type":"string","minLength":1,"maxLength":256},"externalReference":{"type":"string","minLength":1,"maxLength":512},"clientId":{"type":"string","minLength":1,"maxLength":128},"projectId":{"type":"string","minLength":1,"maxLength":128},"title":{"type":"string","minLength":1,"maxLength":200},"responsibleId":{"type":"string","minLength":1,"maxLength":128},"criteria":{"minItems":1,"maxItems":100,"type":"array","items":{"type":"string","minLength":1,"maxLength":2000}},"context":{"type":"string","minLength":1,"maxLength":8000}},"required":["operationId","externalReference","clientId","projectId","title","responsibleId","criteria","context"],"additionalProperties":false}},
};
const FROZEN_TOOL_ORDER = ["get_current_user", "list_projects", "search_tasks", "get_task", "get_task_timeline", "list_pending_actions", "update_task", "transition_task", "start_execution", "report_progress", "submit_for_review", "request_changes", "adopt_agent_review", "approve_anyway", "approve_review", "record_delivery_evidence", "record_review_findings", "report_finding_fix", "record_technical_review", "request_user_action", "create_task"];

describe('MCP reporting instructions (RB6) without contract changes (RNF2)', () => {
 const descriptionOf = (name: string) => { const tool = setup().tools.find(t => t.name === name); if (!tool) throw new Error('missing tool ' + name); return tool.description; };

 it('keeps the tool set, order, readOnly flag and every JSON input schema identical', () => {
  const s = setup();
  expect(s.tools.map(t => t.name)).toEqual(FROZEN_TOOL_ORDER);
  const actual = Object.fromEntries(s.tools.map(t => [t.name, { readOnly: t.readOnly, schema: zodV4.toJSONSchema(zodV4.object(t.inputSchema).strict(), { io: 'input' }) }]));
  expect(JSON.parse(JSON.stringify(actual))).toEqual(FROZEN_TOOL_CONTRACT);
 });

 it('start_execution tells the agent to call report_progress right after, with objective and the whole plan in remaining (a)', () => {
  const d = descriptionOf('start_execution');
  expect(d).toContain('report_progress'); expect(d).toContain('objective'); expect(d).toMatch(/plano inteiro em remaining/);
 });

 it('report_progress covers steps (a)-(d) and includes a payload example', () => {
  const d = descriptionOf('report_progress');
  expect(d).toMatch(/logo após start_execution.*objective.*plano inteiro em remaining/);
  expect(d).toMatch(/a cada passo concluído.*de remaining para completed.*nextStep/);
  expect(d).toMatch(/blockers/); expect(d).toContain('WAITING'); expect(d).toContain('PAUSED');
  expect(d).toMatch(/WAITING primeiro \(a resposta traz a version nova\).*request_user_action.*version.*options/);
  expect(d).toMatch(/status FINISHED.*remaining vazio.*antes de submit_for_review/);
  const example = d.match(/Exemplo de summary: (\{.*\})\./)?.[1];
  expect(example).toBeDefined();
  expect(JSON.parse(example as string)).toEqual({ objective: expect.any(String), completed: expect.any(Array), remaining: expect.any(Array), nextStep: expect.any(String), blockers: expect.any(Array), references: expect.any(Array) });
 });

 it('submit_for_review asks for the last step to be reported before sending, keeping its previous guidance', () => {
  const d = descriptionOf('submit_for_review');
  expect(d).toMatch(/último report_progress com status FINISHED/); expect(d).toMatch(/remaining vazio/); expect(d).toMatch(/não encerra a execução/);
  expect(d).toMatch(/request_changes.*start_execution.*novo executionId/); expect(d).toContain('reviewMode AGENT'); expect(d).toContain('Não marque passed sem execução e evidência.');
 });

 it('request_user_action orders report_progress WAITING first, then the request with the new version, recipient and where the answer appears', () => {
  const d = descriptionOf('request_user_action');
  expect(d).toMatch(/primeiro chame report_progress com status WAITING e o motivo em blockers \(a resposta traz a version nova\)/);
  expect(d).toMatch(/essa version em expectedVersion/); expect(d).toContain('options');
  expect(d).toMatch(/recipientId normalmente igual ao responsável da tarefa \(state\.responsibleId em get_task\)/);
  expect(d).toMatch(/consulte get_task antes de relatar de novo/);
  expect(d).toMatch(/get_task_timeline \(evento resolve_action, campo response\)/); expect(d).toMatch(/some de get_task\.actions/);
 });

 it('report_progress example payload is accepted by the real tool schema', async () => {
  const s = setup(); const d = descriptionOf('report_progress');
  const summary = JSON.parse(d.match(/Exemplo de summary: (\{.*\})\./)![1]);
  await s.call('report_progress', { taskId: 'task', operationId: 'op', expectedVersion: 2, executionId: 'exec-1', status: 'RUNNING', summary });
  expect(s.workflow.execute).toHaveBeenLastCalledWith(expect.anything(), 'task', expect.objectContaining({ command: expect.objectContaining({ type: 'report_progress', summary }) }));
 });
});
