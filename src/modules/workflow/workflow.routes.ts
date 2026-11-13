import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import type { Authenticate } from "../authz/authenticate.js";
import type { Authorizer } from "../authz/authorizer.js";
import type { TaskService } from "../tasks/task.service.js";
import { AppError } from "../../lib/errors.js";
import { executeSchema, initSchema, requestActionSchema, resolveActionSchema } from "./schemas.js";
import type { WorkflowActor } from "./types.js";
import type { WorkflowStore } from "./persistence.js";

export function makeWorkflowRoutes(authenticate: Authenticate, authz: Authorizer, tasks: Pick<TaskService, "getOrThrow">, repository: WorkflowStore, enabled: boolean) {
  return async (app: FastifyInstance) => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const params = z.object({ id: z.string().min(1).max(128) }).strict();
    const eventQuery = z.object({ beforeVersion: z.coerce.number().int().nonnegative().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
    const actionQuery = z.object({ cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
    const available = async () => { if (!enabled) throw new AppError("NAO_ENCONTRADO", "Fluxo ainda não disponível"); };
    const preHandler = [available, authenticate];
    async function actorFor(req: FastifyRequest, taskId: string): Promise<WorkflowActor> {
      const session = req.session!;
      const task = await tasks.getOrThrow(session, taskId);
      await authz.assertProjectAccess(session, task.projectId);
      const [canWrite, canReview, canApprove] = await Promise.all([
        authz.can(session, PERMISSIONS.tarefas_editar, task.projectId),
        authz.can(session, PERMISSIONS.tarefas_revisar, task.projectId),
        authz.can(session, PERMISSIONS.tarefas_aprovar, task.projectId),
      ]);
      return { orgId: session.orgId, userId: session.userId, channel: "WEB", canWrite, canReview, canApprove, canReopen: canApprove };
    }
    r.get("/tasks/actions/mine", { preHandler, schema: { querystring: actionQuery } }, async (req) => {
      let cursor: { createdAt: string; id: string } | undefined;
      if (req.query.cursor) {
        try { cursor = z.object({ createdAt: z.string().datetime(), id: z.string().min(1).max(128) }).strict().parse(JSON.parse(Buffer.from(req.query.cursor, "base64url").toString())); }
        catch { throw new AppError("VALIDACAO", "Cursor inválido"); }
      }
      const candidates = await repository.listActions(req.session!.orgId, req.session!.userId, cursor, req.query.limit + 1);
      const actions = [];
      for (const action of candidates.slice(0, req.query.limit)) {
        try { await actorFor(req, action.taskId); actions.push(action); }
        catch (error) { if (!(error instanceof AppError && error.code === "NAO_ENCONTRADO")) throw error; }
      }
      const last = candidates[Math.min(candidates.length, req.query.limit) - 1];
      const nextCursor = candidates.length > req.query.limit && last ? Buffer.from(JSON.stringify({ createdAt: new Date(last.createdAt).toISOString(), id: last.id })).toString("base64url") : null;
      return { actions, nextCursor };
    });
    r.get("/tasks/workflows/mine", { preHandler, schema: { querystring: actionQuery } }, async (req) => {
      if (!repository.listMonitoring) throw new AppError("NAO_ENCONTRADO", "Acompanhamento indisponível");
      let cursor: { updatedAt: string; taskId: string } | undefined;
      if (req.query.cursor) {
        try { cursor = z.object({ updatedAt: z.string().datetime(), taskId: z.string().min(1).max(128) }).strict().parse(JSON.parse(Buffer.from(req.query.cursor, "base64url").toString())); }
        catch { throw new AppError("VALIDACAO", "Cursor inválido"); }
      }
      const rows = await repository.listMonitoring(req.session!.orgId, req.session!.userId, cursor, req.query.limit + 1);
      const items = [];
      for (const row of rows.slice(0, req.query.limit)) {
        try { await actorFor(req, row.taskId); items.push(row); }
        catch (error) { if (!(error instanceof AppError && error.code === "NAO_ENCONTRADO")) throw error; }
      }
      const last = rows[Math.min(rows.length, req.query.limit) - 1];
      const nextCursor = rows.length > req.query.limit && last ? Buffer.from(JSON.stringify({ updatedAt: new Date(last.updatedAt).toISOString(), taskId: last.taskId })).toString("base64url") : null;
      return { items, nextCursor };
    });
    r.get("/tasks/:id/workflow", { preHandler, schema: { params, querystring: eventQuery } }, async (req) => {
      const actor = await actorFor(req, req.params.id);
      const state = await repository.load(actor.orgId, req.params.id);
      const [eventRows, actions] = state ? await Promise.all([repository.events(actor.orgId, req.params.id, req.query.beforeVersion, req.query.limit + 1), repository.actions(actor.orgId, req.params.id)]) : [[], []];
      const events = eventRows.slice(0, req.query.limit);
      const nextEventCursor = eventRows.length > req.query.limit ? (events.at(-1) as { version: number }).version : null;
      const { canWrite, canReview, canApprove, canReopen } = actor;
      return { state, events, actions, nextEventCursor, capabilities: { canWrite, canReview, canApprove, canReopen } };
    });
    r.post("/tasks/:id/workflow/init", { preHandler, schema: { params, body: initSchema } }, async (req) => {
      const actor = await actorFor(req, req.params.id);
      if (!actor.canWrite) throw new AppError("SEM_PERMISSAO", "Sem permissão para ativar o fluxo");
      return { state: await repository.initialize(actor, req.params.id, req.body) };
    });
    r.post("/tasks/:id/workflow/commands", { preHandler, schema: { params, body: executeSchema } }, async (req) => {
      const actor = await actorFor(req, req.params.id);
      const type = req.body.command.type;
      const reviewAction = ["record_finding", "validate_finding", "waive_finding", "request_changes"].includes(type);
      if (!(["approve_anyway", "approve_review", "approve_with_reservations", "adopt_agent_review"].includes(type) ? actor.canApprove : reviewAction ? actor.canReview : actor.canWrite)) throw new AppError("SEM_PERMISSAO", "Sem permissão para esta ação");
      return { state: await repository.execute(actor, req.params.id, req.body) };
    });
    r.post("/tasks/:id/workflow/actions", { preHandler, schema: { params, body: requestActionSchema } }, async (req) => {
      const actor = await actorFor(req, req.params.id);
      if (!actor.canWrite) throw new AppError("SEM_PERMISSAO", "Sem permissão para solicitar ação");
      if (!repository.requestAction) throw new AppError("NAO_ENCONTRADO", "Solicitações indisponíveis");
      return { action: await repository.requestAction(actor, req.params.id, req.body) };
    });
    r.post("/tasks/:id/workflow/actions/:actionId/resolve", { preHandler, schema: { params: params.extend({ actionId: z.string().min(1).max(128) }), body: resolveActionSchema } }, async (req) => {
      const actor = await actorFor(req, req.params.id);
      if (!repository.resolveAction) throw new AppError("NAO_ENCONTRADO", "Solicitações indisponíveis");
      return { action: await repository.resolveAction(actor, req.params.id, req.params.actionId, req.body) };
    });
  };
}
