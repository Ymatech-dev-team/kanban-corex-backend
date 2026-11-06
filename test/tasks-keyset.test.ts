import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { PrismaTaskRepo } from '../src/modules/tasks/prisma-repos.js';
const date='2026-11-10T00:00:00.000Z';
const cursor=(dueDate:string|null,id='b')=>Buffer.from(JSON.stringify({dueDate,id})).toString('base64url');
const task=(id:string,dueDate:Date|null)=>({id,orgId:'org',projectId:'client',engagementId:'project',title:id,description:null,status:'TODO',priority:'MEDIUM',dueDate,assigneeId:null,estimatedMinutes:null,position:1,createdById:'user',deletedAt:null,createdAt:new Date(date),updatedAt:new Date(date),extraAssignees:[]});
function setup(){const findMany=vi.fn().mockResolvedValue([]);const repo=new PrismaTaskRepo({task:{findMany}} as unknown as PrismaClient);return {findMany,repo};}
describe('task search due-date keyset pagination',()=>{
 it('returns cursor from final returned row rather than the lookahead',async()=>{const s=setup();s.findMany.mockResolvedValue([task('a',new Date(date)),task('b',new Date(date)),task('c',null)]);const page=await s.repo.listAll(['client'],'org',{limit:2});expect(page.tasks.map(t=>t.id)).toEqual(['a','b']);expect(page.hasMore).toBe(true);expect(page).toHaveProperty('nextCursor',cursor(date));});
 it('keeps tenant/access filters AND the dated cursor with tie and null-tail branches',async()=>{const s=setup();await s.repo.listAll(['allowed'],'org',{projectId:'selected',cursor:cursor(date),limit:2});expect(s.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{orgId:'org',deletedAt:null,AND:expect.arrayContaining([{projectId:{in:['allowed']}},{projectId:'selected'},{OR:[{dueDate:{gt:new Date(date)}},{dueDate:new Date(date),id:{gt:'b'}},{dueDate:null}]}])},orderBy:[{dueDate:{sort:'asc',nulls:'last'}},{id:'asc'}],take:3}));});
 it('null cursor remains exclusively in null tail with id tie-breaker',async()=>{const s=setup();await s.repo.listAll('all','org',{cursor:cursor(null)});expect(s.findMany).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({orgId:'org',AND:expect.arrayContaining([{dueDate:null,id:{gt:'b'}}])})}));});
 it.each(['bad!',cursor('not-a-date'),Buffer.from(JSON.stringify({id:'x'})).toString('base64url'),Buffer.from(JSON.stringify({dueDate:null,id:'x',orgId:'other'})).toString('base64url')])('rejects malformed cursor before database query %s',async(value)=>{const s=setup();await expect(s.repo.listAll('all','org',{cursor:value})).rejects.toMatchObject({code:'VALIDACAO'});expect(s.findMany).not.toHaveBeenCalled();});
 it('ends pagination with explicit null nextCursor',async()=>{const s=setup();s.findMany.mockResolvedValue([task('z',null)]);expect(await s.repo.listAll('all','org',{limit:2})).toMatchObject({hasMore:false,nextCursor:null});});
});
