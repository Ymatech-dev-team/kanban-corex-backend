import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import { AppError } from "../../lib/errors.js";
import type { Authenticate } from "../authz/authenticate.js";
import { Authorizer } from "../authz/authorizer.js";
import { CostService } from "./cost.service.js";

const idParams = z.object({ id: z.string().min(1) });

/** Custo de alocação — sempre gated: acesso ao cliente E custos_ver. Valor nunca vaza sem o direito. */
export function makeCostRoutes(authenticate: Authenticate, authz: Authorizer, cost: CostService) {
  return async function costRoutes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    // Resumo por cliente.
    r.get("/projects/:id/cost", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      await authz.assertProjectAccess(req.session!, req.params.id);
      await authz.assertCan(req.session!, PERMISSIONS.custos_ver, req.params.id);
      return cost.summary(req.session!.orgId, req.params.id);
    });

    // Custo de uma tarefa (para o detalhe).
    r.get("/tasks/:id/cost", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      const out = await cost.taskCost(req.session!.orgId, req.params.id);
      if (!out) throw new AppError("NAO_ENCONTRADO", "Recurso não encontrado");
      await authz.assertProjectAccess(req.session!, out.projectId);
      await authz.assertCan(req.session!, PERMISSIONS.custos_ver, out.projectId);
      return out.result;
    });
  };
}
