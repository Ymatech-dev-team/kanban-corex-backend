import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { PERMISSIONS } from "@sistema-tasks/contracts";
import { buildApp } from "../src/app.js";
import { signInternal } from "../src/lib/hmac.js";
import { TokenService } from "../src/modules/auth/token.service.js";
import { makeAuthenticate } from "../src/modules/authz/authenticate.js";
import { Authorizer } from "../src/modules/authz/authorizer.js";
import { InMemoryAuthzUserRepo } from "../src/modules/authz/memory-repos.js";
import { InMemoryProjectAccessRepo } from "../src/modules/projects/memory-repos.js";
import {
  InMemoryTaskRepo,
  InMemorySubtaskRepo,
  InMemoryActivityRepo,
  InMemoryCommentRepo,
} from "../src/modules/tasks/memory-repos.js";
import { InMemoryIdempotencyStore } from "../src/lib/idempotency-store.js";
import { TaskService } from "../src/modules/tasks/task.service.js";

const SECRET = "internal-test";
const P = "p1";
let app: FastifyInstance;
let tokens: TokenService;

beforeAll(async () => {
  delete process.env.DATABASE_URL;
  process.env.INTERNAL_API_SECRET = SECRET;
  tokens = new TokenService({
    accessSecret: "a", refreshSecret: "r", issuer: "iss", audience: "aud", accessTtlSec: 900, refreshTtlSec: 1000,
  });
  const users = new InMemoryAuthzUserRepo()
    .add({ id: "u1", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [PERMISSIONS.tarefas_criar, PERMISSIONS.tarefas_editar, PERMISSIONS.tarefas_mover], extraPermissions: [] })
    .add({ id: "u2", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [], extraPermissions: [] })
    .add({ id: "u3", orgId: "o1", deletedAt: null, tokenVersion: 0, mustChangePassword: false, rolePermissions: [PERMISSIONS.tarefas_moderar_comentarios], extraPermissions: [] });
  const access = new InMemoryProjectAccessRepo().addUser("u1", "o1", "Ana").addUser("u2", "o1", "Bia").addUser("u3", "o1", "Caio");
  access.grant(P, "u1");
  access.grant(P, "u2");
  access.grant(P, "u3");
  const activity = new InMemoryActivityRepo().setName("u1", "Ana");
  const comments = new InMemoryCommentRepo().setName("u1", "Ana").setName("u2", "Bia").setName("u3", "Caio");
  const taskService = new TaskService(
    new InMemoryTaskRepo(), new InMemorySubtaskRepo(), access, new InMemoryIdempotencyStore(), activity, comments,
  );
  app = buildApp({
    authenticate: makeAuthenticate({ tokens, users }),
    authorizer: new Authorizer(access),
    taskService,
    tokenService: tokens,
  });
  await app.ready();
});
afterAll(async () => { await app.close(); });

function token(u: string) { return tokens.signAccess({ userId: u, orgId: "o1", tokenVersion: 0 }); }
function call(method: string, url: string, u: string, body?: unknown) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  const ts = Date.now();
  const headers: Record<string, string> = {
    authorization: `Bearer ${token(u)}`,
    "x-internal-timestamp": String(ts),
    "x-internal-signature": signInternal(SECRET, payload, ts),
  };
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({ method: method as "GET", url, headers, payload: body === undefined ? undefined : payload });
}
async function newTask(): Promise<string> {
  return (await call("POST", `/projects/${P}/tasks`, "u1", { title: "Tarefa" })).json().id;
}
function feed(taskId: string, u: string) {
  return call("GET", `/tasks/${taskId}/activity`, u);
}

describe("comentários (detalhe-tarefa C)", () => {
  it("membro do cliente comenta; comentário aparece no feed com body e canManage do autor", async () => {
    const id = await newTask();
    const c = await call("POST", `/tasks/${id}/comments`, "u2", { body: "Primeiro comentário" });
    expect(c.statusCode).toBe(200);
    const items = (await feed(id, "u2")).json().items;
    const comment = items.find((i: { type: string }) => i.type === "COMMENT");
    expect(comment.body).toBe("Primeiro comentário");
    expect(comment.actorName).toBe("Bia"); // snapshot do autor
    expect(comment.canManage).toBe(true); // u2 é o autor
  });

  it("feed funde comentários e eventos numa lista só", async () => {
    const id = await newTask(); // gera CREATED
    await call("POST", `/tasks/${id}/comments`, "u1", { body: "coment" });
    await call("PATCH", `/tasks/${id}/move`, "u1", { status: "DOING", position: 1 });
    const types = (await feed(id, "u1")).json().items.map((i: { type: string }) => i.type);
    expect(types).toContain("COMMENT");
    expect(types).toContain("STATUS_CHANGED");
    expect(types).toContain("CREATED");
    // evento mais novo (mudança de status) vem antes do mais antigo (criação)
    expect(types.indexOf("STATUS_CHANGED")).toBeLessThan(types.indexOf("CREATED"));
  });

  it("não-autor sem moderação NÃO edita/exclui comentário alheio (403); autor edita", async () => {
    const id = await newTask();
    const c = (await call("POST", `/tasks/${id}/comments`, "u1", { body: "do u1" })).json();
    const asU2 = await call("PATCH", `/tasks/${id}/comments/${c.id}`, "u2", { body: "hack" });
    expect(asU2.statusCode).toBe(403);
    const del = await call("DELETE", `/tasks/${id}/comments/${c.id}`, "u2");
    expect(del.statusCode).toBe(403);
    const edit = await call("PATCH", `/tasks/${id}/comments/${c.id}`, "u1", { body: "editado" });
    expect(edit.statusCode).toBe(200);
    const comment = (await feed(id, "u1")).json().items.find((i: { type: string }) => i.type === "COMMENT");
    expect(comment.body).toBe("editado");
    expect(comment.editedAt).toBeTruthy();
  });

  it("moderador exclui comentário alheio (soft-delete → tombstone)", async () => {
    const id = await newTask();
    const c = (await call("POST", `/tasks/${id}/comments`, "u1", { body: "sensível" })).json();
    const del = await call("DELETE", `/tasks/${id}/comments/${c.id}`, "u3"); // u3 tem moderar_comentarios
    expect(del.statusCode).toBe(200);
    const comment = (await feed(id, "u1")).json().items.find((i: { type: string }) => i.type === "COMMENT");
    expect(comment.body).toBeNull(); // tombstone
    expect(comment.canManage).toBe(false);
  });

  it("body vazio → 400; corpo é armazenado literal (XSS é escapado no front)", async () => {
    const id = await newTask();
    const empty = await call("POST", `/tasks/${id}/comments`, "u1", { body: "   " });
    expect(empty.statusCode).toBe(400);
    const xss = await call("POST", `/tasks/${id}/comments`, "u1", { body: "<script>alert(1)</script>" });
    expect(xss.statusCode).toBe(200);
    const comment = (await feed(id, "u1")).json().items.find((i: { type: string }) => i.type === "COMMENT");
    expect(comment.body).toBe("<script>alert(1)</script>"); // texto literal, sem sanitizar no backend
  });

  it("comentar/editar em tarefa de outra org → 404", async () => {
    const post = await call("POST", `/tasks/nao-existe/comments`, "u1", { body: "x" });
    expect(post.statusCode).toBe(404);
  });
});
