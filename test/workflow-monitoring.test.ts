import { describe, expect, it, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';
import { PrismaWorkflowStore } from '../src/modules/workflow/prisma-workflow.js';
import { createWorkflow } from '../src/modules/workflow/workflow.js';

describe('monitoring query boundaries (SQL contract, not live DB)',()=>{
 it('scopes every parent, active user and membership before cursor/limit, includes pending review recipients',async()=>{
  const query=vi.fn().mockResolvedValue([]);const store=new PrismaWorkflowStore({$queryRaw:query} as unknown as PrismaClient);
  await store.listMonitoring('org','user',{updatedAt:'2026-11-12T12:00:00.000Z',taskId:'last'},11);
  const sql=query.mock.calls[0][0] as Prisma.Sql;
  for(const part of ['t."orgId"=w."orgId"','e."orgId"=t."orgId"','e."projectId"=t."projectId"','u."deletedAt" IS NULL','project_members',"a.kind='REVIEW'",'(w."updatedAt",t.id)<','ORDER BY w."updatedAt" DESC,t.id DESC LIMIT'])expect(sql.text).toContain(part);
  expect(sql.values).toContain('org');expect(sql.values).toContain('user');expect(sql.values).toContain('last');expect(sql.values.at(-1)).toBe(11);
 });
 it('returns validated state with title/context, not raw aggregate',async()=>{
  const state=createWorkflow({taskId:'t',orgId:'o',responsibleId:'u',context:'approved',criteria:['works']});
  const query=vi.fn().mockResolvedValue([{taskId:'t',title:'Title',clientName:'Client',projectName:'Project',updatedAt:'2026-11-12T12:00:00.000Z',aggregate:state}]);
  const result=await new PrismaWorkflowStore({$queryRaw:query} as unknown as PrismaClient).listMonitoring('o','u');
  expect(result[0]).toMatchObject({taskId:'t',title:'Title',state});expect(result[0]).not.toHaveProperty('aggregate');
 });
 it('filters review routing before pagination and preserves explicitly human requests',async()=>{
  const query=vi.fn().mockResolvedValue([]);await new PrismaWorkflowStore({$queryRaw:query} as unknown as PrismaClient).listActions('org','u',undefined,51);
  const sql=query.mock.calls[0][0] as Prisma.Sql;expect(sql.text).toContain("a.kind<>'REVIEW' OR EXISTS");expect(sql.text).toContain("->>'reviewMode'='HUMAN'");expect(sql.text).toContain('w."orgId"=a."orgId"');expect(sql.text).toContain('t.title AS "taskTitle"');expect(sql.values.at(-1)).toBe(51);
 });
});
