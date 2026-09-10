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
  addAssigneeSchema,
  activityFiltersSchema,
  createCommentSchema,
  editCommentSchema,
  PERMISSIONS,
} from "@sistema-tasks/contracts";
import type { Authenticate } from "../authz/authenticate.js";
import { Authorizer } from "../authz/authorizer.js";
import { AppError } from "../../lib/errors.js";
import { TaskService } from "./task.service.js";
import type { TaskRecord } from "./types.js";

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
        return service.listByProject(req.session!.orgId, req.params.projectId, req.query);
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

    r.get(
      "/tasks/:id/activity",
      { preHandler: authenticate, schema: { params: idParams, querystring: activityFiltersSchema } },
      async (req) => {
        const task = await service.getOrThrow(req.session!, req.params.id);
        await authz.assertProjectAccess(req.session!, task.projectId);
        const canModerate = await authz.can(req.session!, PERMISSIONS.tarefas_moderar_comentarios, task.projectId);
        return service.listFeed(task, req.session!, req.query, canModerate);
      },
    );

    // ---- comentários (comentar = acesso ao cliente; editar/excluir = autor OU moderador) [detalhe-tarefa C] ----
    const commentParams = z.object({ id: z.string().min(1).max(64), commentId: z.string().min(1).max(64) });

    r.post(
      "/tasks/:id/comments",
      { preHandler: authenticate, schema: { params: idParams, body: createCommentSchema } },
      async (req) => {
        const task = await service.getOrThrow(req.session!, req.params.id);
        await authz.assertProjectAccess(req.session!, task.projectId); // comentar exige acesso ao cliente [RF-C6]
        return service.addComment(req.session!, task, req.body.body, header(req, "idempotency-key"));
      },
    );

    async function assertCanManageComment(req: FastifyRequest, task: TaskRecord, commentId: string) {
      const c = await service.getCommentOrThrow(task, commentId);
      const isAuthor = c.authorId === req.session!.userId;
      const canMod = await authz.can(req.session!, PERMISSIONS.tarefas_moderar_comentarios, task.projectId);
      if (!isAuthor && !canMod) throw new AppError("SEM_PERMISSAO", "Você não pode editar este comentário");
      return c;
    }

    r.patch(
      "/tasks/:id/comments/:commentId",
      { preHandler: authenticate, schema: { params: commentParams, body: editCommentSchema } },
      async (req) => {
        const task = await service.getOrThrow(req.session!, req.params.id);
        await authz.assertProjectAccess(req.session!, task.projectId);
        await assertCanManageComment(req, task, req.params.commentId);
        return service.editComment(task, req.params.commentId, req.body.body);
      },
    );

    r.delete(
      "/tasks/:id/comments/:commentId",
      { preHandler: authenticate, schema: { params: commentParams } },
      async (req) => {
        const task = await service.getOrThrow(req.session!, req.params.id);
        await authz.assertProjectAccess(req.session!, task.projectId);
        await assertCanManageComment(req, task, req.params.commentId);
        await service.deleteComment(task, req.params.commentId);
        return { ok: true };
      },
    );

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

    const assigneeParams = z.object({ id: z.string().min(1).max(64), userId: z.string().min(1).max(64) });

    r.post(
      "/tasks/:id/assignees",
      { preHandler: authenticate, schema: { params: idParams, body: addAssigneeSchema } },
      async (req) => {
        const task = await service.getOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.tarefas_editar, task.projectId);
        return service.addAssignee(req.session!, task, req.body.userId);
      },
    );

    r.post(
      "/tasks/:id/assignees/:userId/primary",
      { preHandler: authenticate, schema: { params: assigneeParams } },
      async (req) => {
        const task = await service.getOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.tarefas_editar, task.projectId);
        return service.setPrimaryAssignee(req.session!, task, req.params.userId);
      },
    );

    r.delete(
      "/tasks/:id/assignees/:userId",
      { preHandler: authenticate, schema: { params: assigneeParams } },
      async (req) => {
        const task = await service.getOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.tarefas_editar, task.projectId);
        return service.removeAssignee(req.session!, task, req.params.userId);
      },
    );

    r.post(
      "/tasks/:id/subtasks",
      { preHandler: authenticate, schema: { params: idParams, body: createSubtaskSchema } },
      async (req) => {
        const task = await service.getOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.subtarefas_gerenciar, task.projectId);
        return service.addSubtask(req.session!, task, req.body.title, header(req, "idempotency-key"));
      },
    );

    r.patch(
      "/subtasks/:id",
      { preHandler: authenticate, schema: { params: idParams, body: updateSubtaskSchema } },
      async (req) => {
        const task = await service.getTaskOfSubtaskOrThrow(req.session!, req.params.id);
        await authz.assertCan(req.session!, PERMISSIONS.subtarefas_gerenciar, task.projectId);
        return service.updateSubtask(req.session!, task, req.params.id, req.body);
      },
    );

    r.delete("/subtasks/:id", { preHandler: authenticate, schema: { params: idParams } }, async (req) => {
      const task = await service.getTaskOfSubtaskOrThrow(req.session!, req.params.id);
      await authz.assertCan(req.session!, PERMISSIONS.subtarefas_gerenciar, task.projectId);
      await service.removeSubtask(req.session!, task, req.params.id);
      return { ok: true };
    });
  };
}
