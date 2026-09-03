import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createMemberSchema,
  updateMemberSchema,
  createRoleSchema,
  updateRoleSchema,
  PERMISSIONS,
} from "@sistema-tasks/contracts";
import type { Authenticate } from "../authz/authenticate.js";
import { Authorizer } from "../authz/authorizer.js";
import { MemberService } from "./member.service.js";
import { RoleService } from "./role.service.js";

const idParams = z.object({ id: z.string().min(1) });

export function makeAdminRoutes(
  authenticate: Authenticate,
  authz: Authorizer,
  members: MemberService,
  roles: RoleService,
) {
  return async function adminRoutes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    // ---- membros ----
    r.get("/members", { preHandler: authenticate }, async (req) => {
      await authz.assertCan(req.session!, PERMISSIONS.membros_ver);
      return { members: await members.list(req.session!) };
    });
    r.post("/members", { preHandler: authenticate, schema: { body: createMemberSchema } }, async (req) => {
      await authz.assertCan(req.session!, PERMISSIONS.membros_gerenciar);
      return members.create(req.session!, req.body);
    });
    r.patch(
      "/members/:id",
      { preHandler: authenticate, schema: { params: idParams, body: updateMemberSchema } },
      async (req) => {
        await authz.assertCan(req.session!, PERMISSIONS.membros_gerenciar);
        await members.update(req.session!, req.params.id, req.body);
        return { ok: true };
      },
    );
    r.delete("/members/:id", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      await authz.assertCan(req.session!, PERMISSIONS.membros_gerenciar);
      await members.softDelete(req.session!, req.params.id);
      return { ok: true };
    });
    r.post(
      "/members/:id/reset-password",
      { preHandler: authenticate, schema: { params: idParams } },
      async (req) => {
        await authz.assertCan(req.session!, PERMISSIONS.membros_gerenciar);
        return members.resetPassword(req.session!, req.params.id);
      },
    );

    // ---- perfis ----
    r.get("/roles", { preHandler: authenticate }, async (req) => {
      await authz.assertCan(req.session!, PERMISSIONS.perfis_ver);
      return { roles: await roles.list(req.session!) };
    });
    r.post("/roles", { preHandler: authenticate, schema: { body: createRoleSchema } }, async (req) => {
      await authz.assertCan(req.session!, PERMISSIONS.perfis_gerenciar);
      return roles.create(req.session!, req.body);
    });
    r.patch(
      "/roles/:id",
      { preHandler: authenticate, schema: { params: idParams, body: updateRoleSchema } },
      async (req) => {
        await authz.assertCan(req.session!, PERMISSIONS.perfis_gerenciar);
        await roles.update(req.session!, req.params.id, req.body);
        return { ok: true };
      },
    );
    r.delete("/roles/:id", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      await authz.assertCan(req.session!, PERMISSIONS.perfis_gerenciar);
      await roles.delete(req.session!, req.params.id);
      return { ok: true };
    });
  };
}
