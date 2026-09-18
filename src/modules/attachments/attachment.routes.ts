import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import type { Authenticate } from "../authz/authenticate.js";
import { Authorizer } from "../authz/authorizer.js";
import { TaskService } from "../tasks/task.service.js";
import { AttachmentService } from "./attachment.service.js";

const taskParams = z.object({ taskId: z.string().min(1) });
const attParams = z.object({ taskId: z.string().min(1), attachmentId: z.string().min(1) });
const uploadTokenBody = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1).max(150),
  size: z.number().int().positive(),
});
const confirmBody = z.object({
  url: z.string().url(),
  pathname: z.string().min(1),
  fileName: z.string().min(1).max(255),
});

export function makeAttachmentRoutes(
  authenticate: Authenticate,
  authz: Authorizer,
  tasks: TaskService,
  service: AttachmentService,
) {
  return async function attachmentRoutes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();

    // URL de PUT ASSINADA (store PRIVADO): o navegador sobe DIRETO pro Blob. Só é assinada se o usuário
    // tem acesso ao cliente da tarefa; o pathname é gerado no servidor e amarra tipo/tamanho/prefixo. O
    // binário fica privado (sem URL pública) — o download passa pelo endpoint que assina. [anexos B]
    r.post(
      "/tasks/:taskId/attachments/upload-token",
      { preHandler: authenticate, schema: { params: taskParams, body: uploadTokenBody } },
      async (req) => {
        const task = await tasks.getOrThrow(req.session!, req.params.taskId);
        await authz.assertProjectAccess(req.session!, task.projectId);
        return service.requestUpload(task, req.body.fileName, req.body.contentType, req.body.size);
      },
    );

    // Confirma o upload → grava o registro (valida metadata REAL via head()).
    r.post(
      "/tasks/:taskId/attachments",
      { preHandler: authenticate, schema: { params: taskParams, body: confirmBody } },
      async (req) => {
        const task = await tasks.getOrThrow(req.session!, req.params.taskId);
        await authz.assertProjectAccess(req.session!, task.projectId);
        return service.confirm(req.session!, task, req.body.url, req.body.pathname, req.body.fileName);
      },
    );

    // Lista os anexos da tarefa.
    r.get(
      "/tasks/:taskId/attachments",
      { preHandler: authenticate, schema: { params: taskParams } },
      async (req) => {
        const task = await tasks.getOrThrow(req.session!, req.params.taskId);
        await authz.assertProjectAccess(req.session!, task.projectId);
        const canModerate = await authz.can(req.session!, PERMISSIONS.tarefas_moderar_comentarios, task.projectId);
        return { attachments: await service.list(req.session!, task, canModerate) };
      },
    );

    // Download: checa o acesso e devolve uma URL ASSINADA de curta duração (get, ~5 min) — o front abre.
    // O binário nunca é público; sem acesso ao cliente, não há como assinar. [anexos B]
    r.get(
      "/tasks/:taskId/attachments/:attachmentId/download",
      { preHandler: authenticate, schema: { params: attParams } },
      async (req) => {
        const task = await tasks.getOrThrow(req.session!, req.params.taskId);
        await authz.assertProjectAccess(req.session!, task.projectId);
        return { url: await service.signDownload(task, req.params.attachmentId) };
      },
    );

    // Remove um anexo (uploader OU moderador).
    r.delete(
      "/tasks/:taskId/attachments/:attachmentId",
      { preHandler: authenticate, schema: { params: attParams } },
      async (req) => {
        const task = await tasks.getOrThrow(req.session!, req.params.taskId);
        await authz.assertProjectAccess(req.session!, task.projectId);
        const canModerate = await authz.can(req.session!, PERMISSIONS.tarefas_moderar_comentarios, task.projectId);
        await service.remove(req.session!, task, req.params.attachmentId, canModerate);
        return { ok: true };
      },
    );
  };
}
