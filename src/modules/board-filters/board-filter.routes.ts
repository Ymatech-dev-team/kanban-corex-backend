import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Authenticate } from "../authz/authenticate.js";
import { Authorizer } from "../authz/authorizer.js";
import { BoardFilterService, MAX_NAME_LEN } from "./board-filter.service.js";

const projectParams = z.object({ projectId: z.string().min(1) });
const presetParams = z.object({ projectId: z.string().min(1), presetId: z.string().min(1) });

// Whitelist do payload de filtros: só campos/enums conhecidos (`.strict()` barra chaves extras). [SEC]
const filtersSchema = z
  .object({
    resp: z.string().min(1).max(64).optional(),
    status: z.enum(["TODO", "DOING", "DONE"]).optional(),
    prio: z.enum(["HIGH", "MEDIUM", "LOW"]).optional(),
    prazo: z.enum(["atrasadas", "hoje", "semana"]).optional(),
  })
  .strict();

const nameSchema = z.string().trim().min(1).max(MAX_NAME_LEN);
const createBody = z.object({ name: nameSchema, filters: filtersSchema });
const patchBody = z.object({ name: nameSchema.optional(), filters: filtersSchema.optional() });

export function makeBoardFilterRoutes(authenticate: Authenticate, authz: Authorizer, service: BoardFilterService) {
  return async function boardFilterRoutes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    // Lista os presets do usuário logado para o cliente.
    r.get(
      "/projects/:projectId/board-filters",
      { preHandler: authenticate, schema: { params: projectParams } },
      async (req) => {
        await authz.assertProjectAccess(req.session!, req.params.projectId);
        return { presets: await service.list(req.session!, req.params.projectId) };
      },
    );

    // Cria um preset { name, filters }.
    r.post(
      "/projects/:projectId/board-filters",
      { preHandler: authenticate, schema: { params: projectParams, body: createBody } },
      async (req) => {
        await authz.assertProjectAccess(req.session!, req.params.projectId);
        return service.create(req.session!, req.params.projectId, req.body.name, req.body.filters);
      },
    );

    // Renomeia e/ou re-salva os filtros de um preset.
    r.patch(
      "/projects/:projectId/board-filters/:presetId",
      { preHandler: authenticate, schema: { params: presetParams, body: patchBody } },
      async (req) => {
        await authz.assertProjectAccess(req.session!, req.params.projectId);
        return service.update(req.session!, req.params.presetId, req.params.projectId, req.body);
      },
    );

    // Exclui um preset (só o dono).
    r.delete(
      "/projects/:projectId/board-filters/:presetId",
      { preHandler: authenticate, schema: { params: presetParams } },
      async (req) => {
        await authz.assertProjectAccess(req.session!, req.params.projectId);
        await service.remove(req.session!, req.params.presetId, req.params.projectId);
        return { ok: true };
      },
    );
  };
}
