import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PrismaTaskRepo, PrismaSubtaskRepo } from "../src/modules/tasks/prisma-repos.js";
import { PrismaAttachmentRepo } from "../src/modules/attachments/prisma-repo.js";

function fixture(managed: boolean) {
  const order: string[] = [];
  const update = vi.fn(async () => { order.push("write"); return { id: "task", status: "TODO", priority: "MEDIUM" }; });
  const tx = {
    task: { update },
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => {
      if (query.join("").includes("FOR UPDATE")) { order.push("lock"); return [{ id: "task" }]; }
      order.push("check"); return managed ? [{ taskId: "task" }] : [];
    }),
  };
  const db = { task: { update }, $transaction: vi.fn(async (work: (value: typeof tx) => unknown) => work(tx)) };
  return { db: db as unknown as PrismaClient, update, order };
}

describe("legacy task writes cannot bypass managed review", () => {
  it("rejects direct status update for a managed task after locking the task", async () => {
    const f = fixture(true);
    await expect(new PrismaTaskRepo(f.db, true).update("task", { status: "DONE" })).rejects.toMatchObject({ code: "CONFLITO" });
    expect(f.order).toEqual(["lock", "check"]);
    expect(f.update).not.toHaveBeenCalled();
  });
  it("rejects scope edits and direct move on a managed task", async () => {
    const f = fixture(true);
    const repo = new PrismaTaskRepo(f.db, true);
    await expect(repo.update("task", { description: "changed scope" })).rejects.toMatchObject({ code: "CONFLITO" });
    await expect(repo.move("task", "DONE", 10)).rejects.toMatchObject({ code: "CONFLITO" });
    expect(f.update).not.toHaveBeenCalled();
  });
  it("allows legacy tasks inside the same lock/check/write transaction", async () => {
    const f = fixture(false);
    await new PrismaTaskRepo(f.db, true).update("task", { title: "Updated" });
    expect(f.order).toEqual(["lock", "check", "write"]);
  });
  it("preserves legacy behavior when feature is disabled", async () => {
    const f = fixture(true);
    await new PrismaTaskRepo(f.db).move("task", "DOING", 10);
    expect(f.order).toEqual(["write"]);
  });
});

function childFixture(managed: boolean) {
  const writes = vi.fn(async () => ({ id: "child", taskId: "task" }));
  const db = {
    task: { findFirst: vi.fn(async () => ({ assigneeId: null })), updateMany: writes },
    taskAssignee: { upsert: writes, deleteMany: writes, findFirst: vi.fn(async () => null) },
    subtask: { create: writes, update: writes, delete: writes, findUnique: vi.fn(async () => ({ taskId: "task" })) },
    taskAttachment: { create: writes, deleteMany: writes, findFirst: vi.fn(async () => ({ taskId: "task" })) },
    user: { findUnique: vi.fn(async () => ({ name: "Test" })) },
    $queryRaw: vi.fn(async (query: TemplateStringsArray) => query.join("").includes("FOR UPDATE") ? [{ id: "task" }] : managed ? [{ taskId: "task" }] : []),
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn) => fn(db));
  return { db: db as unknown as PrismaClient, writes };
}
const childWrites = [
  ["assign extra", (db: PrismaClient) => new PrismaTaskRepo(db, true).addExtraAssignee("task", "user", "org")],
  ["remove extra", (db: PrismaClient) => new PrismaTaskRepo(db, true).removeExtraAssignee("task", "user", "org")],
  ["promote primary", (db: PrismaClient) => new PrismaTaskRepo(db, true).promoteToPrimary("task", "user", "org")],
  ["clear primary", (db: PrismaClient) => new PrismaTaskRepo(db, true).clearPrimaryPromotingOldest("task", "org")],
  ["create subtask", (db: PrismaClient) => new PrismaSubtaskRepo(db, true).create("task", "Child", 0)],
  ["update subtask", (db: PrismaClient) => new PrismaSubtaskRepo(db, true).update("child", { done: true })],
  ["remove subtask", (db: PrismaClient) => new PrismaSubtaskRepo(db, true).remove("child")],
  ["create attachment", (db: PrismaClient) => new PrismaAttachmentRepo(db, true).create({ taskId: "task", orgId: "org", uploaderId: "user", fileName: "test.pdf", contentType: "application/pdf", size: 10, url: "https://example.test/test.pdf", pathname: "t/task/test.pdf" })],
  ["remove attachment", (db: PrismaClient) => new PrismaAttachmentRepo(db, true).delete("attachment", "org")],
] as const;

describe("managed delivery child writes", () => {
  it.each(childWrites)("blocks %s for managed task", async (_name, write) => {
    const f = childFixture(true);
    await expect(write(f.db)).rejects.toMatchObject({ code: "CONFLITO" });
    expect(f.writes).not.toHaveBeenCalled();
  });
  it.each(childWrites)("allows %s for unmanaged task", async (_name, write) => {
    const f = childFixture(false);
    await write(f.db);
    expect(f.writes).toHaveBeenCalled();
  });
  it("rejects upload preflight before signing a token", async () => {
    const f = childFixture(true);
    await expect(new PrismaAttachmentRepo(f.db, true).assertWritable("task", "org")).rejects.toMatchObject({ code: "CONFLITO" });
    expect(f.writes).not.toHaveBeenCalled();
  });
});
