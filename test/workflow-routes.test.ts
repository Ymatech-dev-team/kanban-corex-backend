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
  const repo = { load: vi.fn(async () => null), events: vi.fn(async () => []), actions: vi.fn(async () => []), listActions: vi.fn(async () => []), initialize: vi.fn(), execute: vi.fn() };
  app.register(makeWorkflowRoutes(async (req) => {
    if (opts.authenticated === false) throw new AppError("NAO_AUTENTICADO", "Sem sessão");
    req.session = session;
  }, authz, tasks, repo, opts.enabled !== false));
  return { app, repo };
}

describe("workflow route boundary", () => {
  it.each(["/tasks/t/workflow", "/tasks/actions/mine"])("requires authentication on %s", async (url) => {
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
