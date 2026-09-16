import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import type { Authenticate } from "../authz/authenticate.js";
import { NotificationService } from "./notification.service.js";

export function makeNotificationRoutes(authenticate: Authenticate, service: NotificationService) {
  return async function notificationRoutes(app: FastifyInstance): Promise<void> {
    const r = app.withTypeProvider<ZodTypeProvider>();
    // Notificações do usuário logado — só leitura; o "visto" mora no client (localStorage). [notificações]
    r.get("/notifications/mine", { preHandler: authenticate }, async (req) => {
      return service.listMine(req.session!);
    });
  };
}
