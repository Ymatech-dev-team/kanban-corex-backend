import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import {
  createTaskSchema,
  updateTaskSchema,
  moveTaskSchema,
  taskFiltersSchema,
  createSubtaskSchema,
  updateSubtaskSchema,
  PERMISSIONS,
} from "@sistema-tasks/contracts";
import type { Authenticate } from "../authz/authenticate.js";
import { Authorizer } from "../authz/authorizer.js";
import { TaskService } from "./task.service.js";

const projectParams = z.object({ projectId: z.string().min(1) });
const idParams = z.object({ id: z.string().min(1) });

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

export function makeTaskRoutes(authenticate: Authenticate, authz: Authorizer, service: TaskService) {
  return async function taskRoutes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    r.post(
      "/projects/:projectId/tasks",
      { preHandler: authenticate, schema: { params: projectParams, body: createTaskSchema } },
      async (req) => {
        await authz.assertCan(req.session!, PERMISSIONS.tarefas_criar, req.params.projectId);
        return service.create(req.session!, req.params.projectId, req.body, header(req, "idempotency-key"));
      },
    );

    r.get(
      "/projects/:projectId/tasks",
      { preHandler: authenticate, schema: { params: projectParams, querystring: taskFiltersSchema } },
      async (req) => {
        await authz.assertProjectAccess(req.session!, req.params.projectId);
        return service.listByProject(req.params.projectId, req.query);
      },
    );

    // rota estática ANTES da param (find-my-way prioriza estática, mas deixamos explícito)
    r.get("/tasks/mine", { preHandler: authenticate, schema: { querystring: taskFiltersSchema } }, async (req) => {
      return service.listMine(req.session!, req.query);
    });

    r.get("/tasks/:id", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      const task = await service.getOrThrow(req.session!, req.params.id);
      await authz.assertProjectAccess(req.session!, task.projectId);
      return { ...task, subtasks: await service.listSubtasks(task.id) };
    });

    r.patch(
      "/tasks/:id",
      { preHandler: authenticate, schema: { params: idParams, body: updateTaskSchema } },
      async (req) => {
        const task = await service.getOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.tarefas_editar, task.projectId);
        return service.update(req.session!, task, req.body, header(req, "if-unmodified-since"));
      },
    );

    r.patch(
      "/tasks/:id/move",
      { preHandler: authenticate, schema: { params: idParams, body: moveTaskSchema } },
      async (req) => {
        return service.move(req.session!, req.params.id, req.body.status, req.body.position);
      },
    );

    r.delete("/tasks/:id", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      const task = await service.getOrThrow(req.session!, req.params.id);
      await authz.assertCan(req.session!, PERMISSIONS.tarefas_excluir, task.projectId);
      await service.softDelete(task.id);
      return { ok: true };
    });

    r.post(
      "/tasks/:id/subtasks",
      { preHandler: authenticate, schema: { params: idParams, body: createSubtaskSchema } },
      async (req) => {
        const task = await service.getOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.subtarefas_gerenciar, task.projectId);
        return service.addSubtask(req.session!, task.id, req.body.title, header(req, "idempotency-key"));
      },
    );

    r.patch(
      "/subtasks/:id",
      { preHandler: authenticate, schema: { params: idParams, body: updateSubtaskSchema } },
      async (req) => {
        const task = await service.getTaskOfSubtaskOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.subtarefas_gerenciar, task.projectId);
        return service.updateSubtask(req.params.id, req.body);
      },
    );

    r.delete("/subtasks/:id", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      const task = await service.getTaskOfSubtaskOrThrow(req.session!, req.params.id);
      await authz.assertCan(req.session!, PERMISSIONS.subtarefas_gerenciar, task.projectId);
      await service.removeSubtask(req.params.id);
      return { ok: true };
    });
  };
}
