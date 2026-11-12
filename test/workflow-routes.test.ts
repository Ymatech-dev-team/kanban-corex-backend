import Fastify from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { describe, expect, it, vi } from "vitest";
import { makeWorkflowRoutes } from "../src/modules/workflow/workflow.routes.js";
import { Authorizer } from "../src/modules/authz/authorizer.js";
import { AppError } from "../src/lib/errors.js";
import { registerErrorHandler } from "../src/plugins/error-handler.js";
import type { SessionContext } from "../src/modules/authz/types.js";
import type { TaskService } from "../src/modules/tasks/task.service.js";

function fixture(opts: { enabled?: boolean; authenticated?: boolean; projectAccess?: boolean; permissions?: string[] } = {}) {
  const session = { userId: "u", orgId: "o", mustChangePassword: false, permissions: new Set(opts.permissions ?? []) } as SessionContext;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  const tasks = { getOrThrow: vi.fn(async () => ({ id: "t", orgId: "o", projectId: "p" })) } as unknown as Pick<TaskService, "getOrThrow">;
  const authz = new Authorizer({ isMember: async () => opts.projectAccess !== false, listAccessibleProjectIds: async () => ["p"] });
  const repo = { listMonitoring: vi.fn().mockResolvedValue([]), load: vi.fn(async () => null), events: vi.fn(async () => []), actions: vi.fn(async () => []), listActions: vi.fn(async () => []), initialize: vi.fn(), execute: vi.fn() };
  app.register(makeWorkflowRoutes(async (req) => {
    if (opts.authenticated === false) throw new AppError("NAO_AUTENTICADO", "Sem sessão");
    req.session = session;
  }, authz, tasks, repo, opts.enabled !== false));
  return { app, repo };
}

describe("workflow route boundary", () => {
  it.each(["/tasks/t/workflow", "/tasks/actions/mine", "/tasks/workflows/mine"])("requires authentication on %s", async (url) => {
    const { app, repo } = fixture({ authenticated: false });
    try { expect((await app.inject({ method: "GET", url })).statusCode).toBe(401); expect(repo.load).not.toHaveBeenCalled(); }
    finally { await app.close(); }
  });
  it("returns unavailable when disabled without querying workflow tables", async () => {
    const { app, repo } = fixture({ enabled: false });
    try { expect((await app.inject({ method: "GET", url: "/tasks/t/workflow" })).statusCode).toBe(404); expect(repo.load).not.toHaveBeenCalled(); }
    finally { await app.close(); }
  });
  it("denies a task outside project scope before workflow lookup", async () => {
    const { app, repo } = fixture({ projectAccess: false });
    try { expect((await app.inject({ method: "GET", url: "/tasks/t/workflow" })).statusCode).toBe(404); expect(repo.load).not.toHaveBeenCalled(); }
    finally { await app.close(); }
  });
  it("does not infer review or approval permission from task edit permission", async () => {
    const { app } = fixture({ permissions: ["tarefas.editar"] });
    try {
      const response = await app.inject({ method: "GET", url: "/tasks/t/workflow" });
      expect(response.statusCode).toBe(200);
      expect(response.json().capabilities).toEqual({ canWrite: true, canReview: false, canApprove: false, canReopen: false });
    } finally { await app.close(); }
  });
  it("requires edit permission to opt in", async () => {
    const { app, repo } = fixture();
    try {
      expect((await app.inject({ method: "POST", url: "/tasks/t/workflow/init", payload: { operationId: "op", responsibleId: "u", criteria: ["works"], context: "plan" } })).statusCode).toBe(403);
      expect(repo.initialize).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("does not accept caller-supplied identity or permissions", async () => {
    const { app, repo } = fixture({ permissions: ["tarefas.editar"] });
    try {
      expect((await app.inject({ method: "POST", url: "/tasks/t/workflow/commands", payload: { operationId: "op", expectedVersion: 0, command: { type: "transition", to: "READY" }, actor: { userId: "admin", canApprove: true } } })).statusCode).toBe(400);
      expect(repo.execute).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});

describe("monitoring route pagination and authorization", () => {
 it("validates cursor before querying and scopes query to authenticated account", async()=>{const {app,repo}=fixture();try{expect((await app.inject({method:'GET',url:'/tasks/workflows/mine?cursor=bad'})).statusCode).toBe(400);expect(repo.listMonitoring).not.toHaveBeenCalled();const response=await app.inject({method:'GET',url:'/tasks/workflows/mine?limit=2'});expect(response.json()).toEqual({items:[],nextCursor:null});expect(repo.listMonitoring).toHaveBeenCalledWith('o','u',undefined,3);}finally{await app.close();}});
 it("never returns inaccessible rows, preserves cursor for a partially visible page", async()=>{const {app,repo}=fixture({projectAccess:false});const row={taskId:'t',title:'private',updatedAt:'2026-11-12T12:00:00.000Z',state:{}};repo.listMonitoring.mockResolvedValue([row,{...row,taskId:'older'}]);try{const response=await app.inject({method:'GET',url:'/tasks/workflows/mine?limit=1'});expect(response.statusCode).toBe(200);expect(response.json().items).toEqual([]);const cursor=JSON.parse(Buffer.from(response.json().nextCursor,'base64url').toString());expect(cursor).toEqual({updatedAt:row.updatedAt,taskId:'t'});}finally{await app.close();}});
});

 it.each([['tarefas.editar'], ['tarefas.revisar'], []])('does not allow reservation approval with %j', async (...permissions) => {
   const {app,repo}=fixture({permissions: permissions as string[]});
   try { const response=await app.inject({method:'POST',url:'/tasks/t/workflow/commands',payload:{operationId:'reservation',expectedVersion:1,command:{type:'approve_with_reservations',cycle:1,checkNames:['lint'],reason:'Preexisting failure'}}}); expect(response.statusCode).toBe(403);expect(repo.execute).not.toHaveBeenCalled(); }finally{await app.close();}
 });
 it('routes reservation approval with approval-only permission and trusted WEB identity',async()=>{
   const {app,repo}=fixture({permissions:['tarefas.aprovar']});
   try {const command={type:'approve_with_reservations',cycle:1,checkNames:['lint'],reason:'Preexisting failure'};const response=await app.inject({method:'POST',url:'/tasks/t/workflow/commands',payload:{operationId:'reservation',expectedVersion:1,command}});expect(response.statusCode).toBe(200);expect(repo.execute).toHaveBeenCalledWith(expect.objectContaining({channel:'WEB',canApprove:true,canWrite:false}),'t',expect.objectContaining({command}));}finally{await app.close();}
 });
