import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createProjectSchema, updateProjectSchema, PERMISSIONS } from "@sistema-tasks/contracts";
import type { Authenticate } from "../authz/authenticate.js";
import { Authorizer } from "../authz/authorizer.js";
import { ProjectService } from "./project.service.js";

const idParams = z.object({ id: z.string().min(1) });
const memberParams = z.object({ id: z.string().min(1), userId: z.string().min(1) });

export function makeProjectRoutes(
  authenticate: Authenticate,
  authz: Authorizer,
  service: ProjectService,
) {
  return async function projectRoutes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post("/projects", { preHandler: authenticate, schema: { body: createProjectSchema } }, async (req) => {
      await authz.assertCan(req.session!, PERMISSIONS.projetos_criar);
      return service.create(req.session!, req.body);
    });

    r.get("/projects", { preHandler: authenticate }, async (req) => {
      return { projects: await service.list(req.session!) };
    });

    r.get("/projects/:id", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      await authz.assertProjectAccess(req.session!, req.params.id);
      return service.getOrThrow(req.session!, req.params.id);
    });

    r.patch(
      "/projects/:id",
      { preHandler: authenticate, schema: { params: idParams, body: updateProjectSchema } },
      async (req) => {
        await authz.assertCan(req.session!, PERMISSIONS.projetos_editar, req.params.id);
        return service.update(req.session!, req.params.id, req.body);
      },
    );

    r.delete("/projects/:id", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      await authz.assertCan(req.session!, PERMISSIONS.projetos_excluir, req.params.id);
      await service.softDelete(req.session!, req.params.id);
      return { ok: true };
    });

    r.get(
      "/projects/:id/members",
      { preHandler: authenticate, schema: { params: idParams } },
      async (req) => {
        await authz.assertProjectAccess(req.session!, req.params.id);
        return { members: await service.listMembers(req.session!, req.params.id) };
      },
    );

    r.post(
      "/projects/:id/members/:userId",
      { preHandler: authenticate, schema: { params: memberParams } },
      async (req) => {
        await authz.assertCan(req.session!, PERMISSIONS.permissoes_conceder);
        await authz.assertProjectAccess(req.session!, req.params.id);
        await service.grantAccess(req.session!, req.params.id, req.params.userId);
        return { ok: true };
      },
    );

    r.delete(
      "/projects/:id/members/:userId",
      { preHandler: authenticate, schema: { params: memberParams } },
      async (req) => {
        await authz.assertCan(req.session!, PERMISSIONS.permissoes_conceder);
        await authz.assertProjectAccess(req.session!, req.params.id);
        await service.revokeAccess(req.session!, req.params.id, req.params.userId);
        return { ok: true };
      },
    );
  };
}
