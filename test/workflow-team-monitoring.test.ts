import Fastify from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "@prisma/client";
import { PrismaWorkflowStore, startOfDayBRT } from "../src/modules/workflow/prisma-workflow.js";
import { createWorkflow } from "../src/modules/workflow/workflow.js";
import { makeWorkflowRoutes } from "../src/modules/workflow/workflow.routes.js";
import { Authorizer } from "../src/modules/authz/authorizer.js";
import { AppError } from "../src/lib/errors.js";
import { registerErrorHandler } from "../src/plugins/error-handler.js";
import type { SessionContext } from "../src/modules/authz/types.js";
import type { TaskService } from "../src/modules/tasks/task.service.js";

const NOW = new Date("2026-11-12T15:00:00.000Z");

describe("startOfDayBRT", () => {
  it.each([
    ["00:30 BRT (03:30Z)", "2026-11-12T03:30:00.000Z", "2026-11-12T03:00:00.000Z"],
    ["23:59 BRT (02:59Z next day)", "2026-11-13T02:59:00.000Z", "2026-11-12T03:00:00.000Z"],
    ["02:00 UTC (23:00 BRT previous day)", "2026-11-12T02:00:00.000Z", "2026-11-11T03:00:00.000Z"],
  ])("returns 00:00 BRT of the BRT day for %s", (_label, now, expected) => {
    expect(startOfDayBRT(new Date(now)).toISOString()).toBe(expected);
  });
  it("is exactly 03:00Z at the BRT midnight boundary and still the previous day one millisecond earlier", () => {
    expect(startOfDayBRT(new Date("2026-11-12T03:00:00.000Z")).toISOString()).toBe("2026-11-12T03:00:00.000Z");
    expect(startOfDayBRT(new Date("2026-11-12T02:59:59.999Z")).toISOString()).toBe("2026-11-11T03:00:00.000Z");
  });
  it("does not mutate its argument", () => {
    const now = new Date(NOW);
    startOfDayBRT(now);
    expect(now.getTime()).toBe(NOW.getTime());
  });
});

describe("team feed query boundaries (SQL contract, not live DB)", () => {
  async function sqlFor(before?: { updatedAt: string; taskId: string }, limit = 51) {
    const query = vi.fn().mockResolvedValue([]);
    await new PrismaWorkflowStore({ $queryRaw: query } as unknown as PrismaClient).listTeamMonitoring("org", "user", NOW, before, limit);
    expect(query).toHaveBeenCalledTimes(1);
    return query.mock.calls[0][0] as Prisma.Sql;
  }

  it("keeps tenant, parent exclusions, active user and project visibility; drops the 'mine' filter", async () => {
    const sql = await sqlFor();
    for (const part of [
      'w."orgId"=${', 't."orgId"=w."orgId"', 'p."orgId"=t."orgId"', 'e."orgId"=t."orgId"', 'e."projectId"=t."projectId"',
      't."deletedAt" IS NULL', 'p."deletedAt" IS NULL', 'e."deletedAt" IS NULL', 'u."deletedAt" IS NULL',
      "'projetos.acessar_todos'=ANY(u.\"extraPermissions\")", "'projetos.acessar_todos'=ANY(r.permissions)", "project_members",
    ]) expect(sql.text.replace(/\$\d+/g, "${")).toContain(part);
    expect(sql.values).toContain("org");
    expect(sql.values).toContain("user");
    // "é meu" block must be gone: no responsible/owner/assignee equality and no REVIEW-recipient subquery
    expect(sql.text).not.toMatch(/responsibleId'\s*=/);
    expect(sql.text).not.toContain("'ownerId'");
    expect(sql.text).not.toMatch(/"assigneeId"\s*=\s*\$/);
    expect(sql.text).not.toContain("task_action_requests");
    expect(sql.text).not.toContain("a.kind");
  });

  it("applies the live filter with the BRT start of day as a parameter", async () => {
    const sql = await sqlFor();
    expect(sql.text).toMatch(/\(w\.stage\s*<>\s*'DONE'\s+OR\s+w\."updatedAt"\s*>=\s*\$\d+\)/);
    const start = sql.values.find((v) => v instanceof Date && v.toISOString() === "2026-11-12T03:00:00.000Z");
    expect(start).toBeDefined();
  });

  it("selects names (org-scoped joins), clientId and projectId", async () => {
    const sql = await sqlFor();
    expect(sql.text).toContain('p.id AS "clientId"');
    expect(sql.text).toContain('e.id AS "projectId"');
    expect(sql.text).toContain('ru.name AS "responsibleName"');
    expect(sql.text).toContain('au.name AS "assigneeName"');
    expect(sql.text).toMatch(/LEFT JOIN users ru ON ru\.id\s*=\s*w\.aggregate->>'responsibleId' AND ru\."orgId"\s*=\s*w\."orgId"/);
    expect(sql.text).toMatch(/LEFT JOIN users au ON au\.id\s*=\s*t\."assigneeId" AND au\."orgId"\s*=\s*t\."orgId"/);
  });

  it("applies cursor and limit after every scope clause", async () => {
    const sql = await sqlFor({ updatedAt: "2026-11-12T12:00:00.000Z", taskId: "last" }, 11);
    const at = (s: string) => { const i = sql.text.indexOf(s); expect(i, s).toBeGreaterThan(-1); return i; };
    const visibility = at("project_members");
    const live = at("w.stage");
    const cursor = at('(w."updatedAt",t.id)<');
    const order = at('ORDER BY w."updatedAt" DESC,t.id DESC LIMIT');
    expect(cursor).toBeGreaterThan(visibility);
    expect(cursor).toBeGreaterThan(live);
    expect(order).toBeGreaterThan(cursor);
    expect(sql.values).toContain("last");
    expect(sql.values.at(-1)).toBe(11);
  });

  it("omits the cursor clause without a cursor", async () => {
    expect((await sqlFor()).text).not.toContain('(w."updatedAt",t.id)<');
  });

  it("maps rows to WorkflowTeamItem with ISO updatedAt, validated state and no raw aggregate", async () => {
    const state = createWorkflow({ taskId: "t", orgId: "o", responsibleId: "u", context: "approved", criteria: ["works"] });
    const query = vi.fn().mockResolvedValue([{
      taskId: "t", title: "Title", clientId: "c1", clientName: "Client", projectId: "p1", projectName: "Project",
      responsibleName: "Ana", assigneeName: null, updatedAt: new Date("2026-11-12T12:00:00.000Z"), aggregate: state,
    }]);
    const [item] = await new PrismaWorkflowStore({ $queryRaw: query } as unknown as PrismaClient).listTeamMonitoring("o", "u", NOW);
    expect(item).toEqual({
      taskId: "t", title: "Title", clientId: "c1", clientName: "Client", projectId: "p1", projectName: "Project",
      responsibleName: "Ana", assigneeName: null, updatedAt: "2026-11-12T12:00:00.000Z", state,
    });
    expect(item).not.toHaveProperty("aggregate");
  });
});

function fixture(opts: { permissions?: string[]; projectAccess?: boolean | ((projectId: string) => boolean); withTeam?: boolean; enabled?: boolean } = {}) {
  const session = { userId: "u", orgId: "o", mustChangePassword: false, permissions: new Set(opts.permissions ?? []) } as SessionContext;
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  const tasks = {
    getOrThrow: vi.fn(async (_s: SessionContext, id: string) => {
      if (id === "gone") throw new AppError("NAO_ENCONTRADO", "Tarefa não encontrada");
      if (id === "boom") throw new Error("db down");
      return { id, orgId: "o", projectId: id === "other" ? "p2" : "p" };
    }),
  } as unknown as Pick<TaskService, "getOrThrow">;
  const access = opts.projectAccess ?? true;
  const authz = new Authorizer({
    isMember: async (_u: string, projectId: string) => (typeof access === "function" ? access(projectId) : access),
    listAccessibleProjectIds: async () => ["p"],
  });
  const repo: Record<string, ReturnType<typeof vi.fn>> = {
    listMonitoring: vi.fn().mockResolvedValue([]), load: vi.fn(async () => null), events: vi.fn(async () => []), actions: vi.fn(async () => []),
    listActions: vi.fn(async () => []), initialize: vi.fn(), execute: vi.fn(),
  };
  if (opts.withTeam !== false) repo.listTeamMonitoring = vi.fn().mockResolvedValue([]);
  app.register(makeWorkflowRoutes(async (req) => { req.session = session; }, authz, tasks, repo as never, opts.enabled !== false));
  return { app, repo };
}

const item = (taskId: string, updatedAt = "2026-11-12T12:00:00.000Z") => ({
  taskId, title: taskId, clientId: "c", clientName: "C", projectId: "pr", projectName: "P", responsibleName: null, assigneeName: null, updatedAt, state: {},
});

describe("GET /tasks/workflows/team route", () => {
  it("returns 403 without tarefas.ver_globais and never queries the store", async () => {
    const { app, repo } = fixture({ permissions: ["tarefas.editar"] });
    try {
      expect((await app.inject({ method: "GET", url: "/tasks/workflows/team" })).statusCode).toBe(403);
      expect(repo.listTeamMonitoring).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("does not accept the project-scoped 'mine' route permission as a substitute", async () => {
    const { app, repo } = fixture({ permissions: ["tarefas.revisar", "tarefas.aprovar", "projetos.acessar_todos"] });
    try {
      expect((await app.inject({ method: "GET", url: "/tasks/workflows/team" })).statusCode).toBe(403);
      expect(repo.listTeamMonitoring).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("returns 200 with tarefas.ver_globais, scoped to the session account, asking limit+1 and a clock", async () => {
    const { app, repo } = fixture({ permissions: ["tarefas.ver_globais"] });
    try {
      const response = await app.inject({ method: "GET", url: "/tasks/workflows/team?limit=2" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ items: [], nextCursor: null });
      expect(repo.listTeamMonitoring).toHaveBeenCalledWith("o", "u", expect.any(Date), undefined, 3);
    } finally { await app.close(); }
  });
  it("defaults the limit to 50 (asks 51) and rejects limits outside 1-100", async () => {
    const { app, repo } = fixture({ permissions: ["tarefas.ver_globais"] });
    try {
      await app.inject({ method: "GET", url: "/tasks/workflows/team" });
      expect(repo.listTeamMonitoring).toHaveBeenLastCalledWith("o", "u", expect.any(Date), undefined, 51);
      for (const limit of ["0", "101"]) expect((await app.inject({ method: "GET", url: `/tasks/workflows/team?limit=${limit}` })).statusCode).toBe(400);
      expect(repo.listTeamMonitoring).toHaveBeenCalledTimes(1);
    } finally { await app.close(); }
  });
  it("validates the cursor before querying and forwards a valid one", async () => {
    const { app, repo } = fixture({ permissions: ["tarefas.ver_globais"] });
    try {
      expect((await app.inject({ method: "GET", url: "/tasks/workflows/team?cursor=bad" })).statusCode).toBe(400);
      expect(repo.listTeamMonitoring).not.toHaveBeenCalled();
      const cursor = { updatedAt: "2026-11-12T12:00:00.000Z", taskId: "last" };
      const encoded = Buffer.from(JSON.stringify(cursor)).toString("base64url");
      expect((await app.inject({ method: "GET", url: `/tasks/workflows/team?cursor=${encoded}&limit=1` })).statusCode).toBe(200);
      expect(repo.listTeamMonitoring).toHaveBeenCalledWith("o", "u", expect.any(Date), cursor, 2);
    } finally { await app.close(); }
  });
  it("returns 404 when the workflow is disabled, before checking permission or querying", async () => {
    const { app, repo } = fixture({ permissions: ["tarefas.ver_globais"], enabled: false });
    try {
      expect((await app.inject({ method: "GET", url: "/tasks/workflows/team" })).statusCode).toBe(404);
      expect(repo.listTeamMonitoring).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
  it("behaves like /mine when the store has no team method: 404", async () => {
    const { app } = fixture({ permissions: ["tarefas.ver_globais"], withTeam: false });
    try {
      expect((await app.inject({ method: "GET", url: "/tasks/workflows/mine" })).statusCode).toBe(200);
      expect((await app.inject({ method: "GET", url: "/tasks/workflows/team" })).statusCode).toBe(404);
    } finally { await app.close(); }
  });
  it("still returns 403 (not 404) to a user without permission when the store has no team method", async () => {
    const { app } = fixture({ withTeam: false });
    try { expect((await app.inject({ method: "GET", url: "/tasks/workflows/team" })).statusCode).toBe(403); }
    finally { await app.close(); }
  });
  it("drops items whose project the user cannot open (actorFor), keeping the cursor of the full page", async () => {
    const { app, repo } = fixture({ permissions: ["tarefas.ver_globais"], projectAccess: (projectId) => projectId === "p" });
    repo.listTeamMonitoring.mockResolvedValue([item("visible", "2026-11-12T12:00:00.000Z"), item("other", "2026-11-12T11:00:00.000Z"), item("older", "2026-11-12T10:00:00.000Z")]);
    try {
      const response = await app.inject({ method: "GET", url: "/tasks/workflows/team?limit=2" });
      expect(response.statusCode).toBe(200);
      expect(response.json().items.map((i: { taskId: string }) => i.taskId)).toEqual(["visible"]);
      const cursor = JSON.parse(Buffer.from(response.json().nextCursor, "base64url").toString());
      expect(cursor).toEqual({ updatedAt: "2026-11-12T11:00:00.000Z", taskId: "other" });
    } finally { await app.close(); }
  });
  it("when every row of a full page is discarded, returns empty items with a cursor from the last raw row so the client can advance", async () => {
    const { app, repo } = fixture({ permissions: ["tarefas.ver_globais"], projectAccess: false });
    repo.listTeamMonitoring.mockResolvedValue([item("a", "2026-11-12T12:00:00.000Z"), item("b", "2026-11-12T11:00:00.000Z"), item("c", "2026-11-12T10:00:00.000Z")]);
    try {
      const response = await app.inject({ method: "GET", url: "/tasks/workflows/team?limit=2" });
      expect(response.statusCode).toBe(200);
      expect(response.json().items).toEqual([]);
      expect(response.json().nextCursor).not.toBeNull();
      const cursor = JSON.parse(Buffer.from(response.json().nextCursor, "base64url").toString());
      expect(cursor).toEqual({ updatedAt: "2026-11-12T11:00:00.000Z", taskId: "b" });
      // the cursor is accepted by the same route, so the client can continue paging
      repo.listTeamMonitoring.mockResolvedValue([]);
      const next = await app.inject({ method: "GET", url: `/tasks/workflows/team?limit=2&cursor=${response.json().nextCursor}` });
      expect(next.statusCode).toBe(200);
      expect(repo.listTeamMonitoring).toHaveBeenLastCalledWith("o", "u", expect.any(Date), cursor, 3);
    } finally { await app.close(); }
  });
  it("drops items whose task no longer resolves (NAO_ENCONTRADO) instead of failing the page", async () => {
    const { app, repo } = fixture({ permissions: ["tarefas.ver_globais"] });
    repo.listTeamMonitoring.mockResolvedValue([item("gone"), item("ok")]);
    try {
      const response = await app.inject({ method: "GET", url: "/tasks/workflows/team" });
      expect(response.statusCode).toBe(200);
      expect(response.json().items.map((i: { taskId: string }) => i.taskId)).toEqual(["ok"]);
      expect(response.json().nextCursor).toBeNull();
    } finally { await app.close(); }
  });
  it("does not swallow unexpected errors from the per-item check", async () => {
    const { app, repo } = fixture({ permissions: ["tarefas.ver_globais"] });
    repo.listTeamMonitoring.mockResolvedValue([item("boom")]);
    try { expect((await app.inject({ method: "GET", url: "/tasks/workflows/team" })).statusCode).toBe(500); }
    finally { await app.close(); }
  });
  it("leaves /tasks/workflows/mine untouched: no ver_globais needed, store call unchanged (RB5)", async () => {
    const { app, repo } = fixture();
    try {
      expect((await app.inject({ method: "GET", url: "/tasks/workflows/mine?limit=2" })).statusCode).toBe(200);
      expect(repo.listMonitoring).toHaveBeenCalledWith("o", "u", undefined, 3);
      expect(repo.listTeamMonitoring).not.toHaveBeenCalled();
    } finally { await app.close(); }
  });
});
