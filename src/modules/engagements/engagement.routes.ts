import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createTaskSchema, taskFiltersSchema, PERMISSIONS } from "@sistema-tasks/contracts";
import type { Authenticate } from "../authz/authenticate.js";
import { Authorizer } from "../authz/authorizer.js";
import { EngagementService } from "./engagement.service.js";
import { TaskService } from "../tasks/task.service.js";
import { redactCost } from "../tasks/redact.js";
import { CostService } from "../cost/cost.service.js";

const clientParams = z.object({ id: z.string().min(1) });
const idParams = z.object({ id: z.string().min(1) });
const consultorParams = z.object({ id: z.string().min(1), userId: z.string().min(1) });
const createEngagementSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().max(5000).optional(),
});
const updateEngagementSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(5000).nullable().optional(),
});

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Rotas de Projeto (Engagement). Autorização resolvida SEMPRE pelo Cliente dono (engagement.projectId). */
export function makeEngagementRoutes(
  authenticate: Authenticate,
  authz: Authorizer,
  engagements: EngagementService,
  tasks: TaskService,
  cost: CostService,
) {
  return async function engagementRoutes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    // ---- lista/criação escopadas ao Cliente ----
    r.get(
      "/projects/:id/engagements",
      { preHandler: authenticate, schema: { params: clientParams } },
      async (req) => {
        await authz.assertProjectAccess(req.session!, req.params.id);
        return { engagements: await engagements.list(req.session!, req.params.id) };
      },
    );

    r.post(
      "/projects/:id/engagements",
      { preHandler: authenticate, schema: { params: clientParams, body: createEngagementSchema } },
      async (req) => {
        await authz.assertCan(req.session!, PERMISSIONS.engagements_criar, req.params.id);
        return engagements.create(req.session!, req.params.id, req.body);
      },
    );

    // ---- por projeto (carrega a entidade → resolve acesso pelo Cliente dono) ----
    r.patch(
      "/engagements/:id",
      { preHandler: authenticate, schema: { params: idParams, body: updateEngagementSchema } },
      async (req) => {
        const eng = await engagements.getOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.engagements_editar, eng.projectId);
        return engagements.update(req.session!, eng, req.body);
      },
    );

    r.delete("/engagements/:id", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      const eng = await engagements.getOrThrow(req.session!, req.params.id);
      await authz.assertCan(req.session!, PERMISSIONS.engagements_excluir, eng.projectId);
      await engagements.softDelete(req.session!, eng);
      return { ok: true };
    });

    // ---- consultores ----
    r.get("/engagements/:id/consultores", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      const eng = await engagements.getOrThrow(req.session!, req.params.id);
      await authz.assertProjectAccess(req.session!, eng.projectId);
      return { consultores: await engagements.listConsultores(eng) };
    });

    r.post(
      "/engagements/:id/consultores/:userId",
      { preHandler: authenticate, schema: { params: consultorParams } },
      async (req) => {
        const eng = await engagements.getOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.engagements_consultores, eng.projectId);
        await engagements.addConsultor(eng, req.params.userId);
        return { ok: true };
      },
    );

    r.delete(
      "/engagements/:id/consultores/:userId",
      { preHandler: authenticate, schema: { params: consultorParams } },
      async (req) => {
        const eng = await engagements.getOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.engagements_consultores, eng.projectId);
        await engagements.removeConsultor(eng, req.params.userId);
        return { ok: true };
      },
    );

    // ---- tarefas do projeto ----
    r.get(
      "/engagements/:id/tasks",
      { preHandler: authenticate, schema: { params: idParams, querystring: taskFiltersSchema } },
      async (req) => {
        const eng = await engagements.getOrThrow(req.session!, req.params.id);
        await authz.assertProjectAccess(req.session!, eng.projectId);
        const cost = await authz.can(req.session!, PERMISSIONS.custos_ver, eng.projectId);
        const { tasks: rows } = await tasks.listByEngagement(req.session!.orgId, eng.id, req.query);
        return { tasks: rows.map((t) => redactCost(t, cost)) };
      },
    );

    r.post(
      "/engagements/:id/tasks",
      { preHandler: authenticate, schema: { params: idParams, body: createTaskSchema } },
      async (req) => {
        const eng = await engagements.getOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.tarefas_criar, eng.projectId);
        const cost = await authz.can(req.session!, PERMISSIONS.custos_ver, eng.projectId);
        const input = cost ? req.body : { ...req.body, estimatedMinutes: undefined };
        const created = await tasks.create(req.session!, eng.projectId, input, header(req, "idempotency-key"), eng.id);
        return redactCost(created, cost);
      },
    );

    // ---- custo do projeto ----
    r.get("/engagements/:id/cost", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      const eng = await engagements.getOrThrow(req.session!, req.params.id);
      await authz.assertProjectAccess(req.session!, eng.projectId);
      await authz.assertCan(req.session!, PERMISSIONS.custos_ver, eng.projectId);
      return cost.engagementSummary(req.session!.orgId, eng.projectId, eng.id);
    });
  };
}
