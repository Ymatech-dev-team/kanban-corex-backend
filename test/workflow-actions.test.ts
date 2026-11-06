import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PrismaWorkflowStore } from "../src/modules/workflow/prisma-workflow.js";
import { createWorkflow } from "../src/modules/workflow/workflow.js";
import type { WorkflowActor } from "../src/modules/workflow/types.js";

const actor: WorkflowActor = { orgId: "org", userId: "owner", channel: "WEB", canWrite: true, canReview: true, canApprove: true, canReopen: true };
const request = { operationId: "req1", expectedVersion: 0, recipientId: "owner", kind: "DECIDE" as const, question: "Choose option", options: ["A", "B"] };
const resolve = { operationId: "reply1", expectedVersion: 0, response: "A", resolution: "RESOLVED" as const };
function fixture(opts: { recipientId?: string; kind?: string; version?: number; state?: string } = {}) {
  const writes: string[] = [];
  const state = createWorkflow({ orgId: "org", taskId: "task", responsibleId: "owner", criteria: ["works"], context: "Plan" });
  const action = { id: "action", taskId: "task", orgId: "org", createdById: "owner", recipientId: opts.recipientId ?? "owner", kind: opts.kind ?? "DECIDE", state: opts.state ?? "OPEN", question: "Choose", version: opts.version ?? 0, createdAt: new Date() };
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("FOR UPDATE OF t")) return [{ id: "task", status: "DOING", projectId: "project" }];
      if (sql.includes("pg_advisory_xact_lock")) return [];
      if (sql.includes("FROM workflow_operations")) return [];
      if (sql.includes("FROM task_workflows")) return [{ aggregate: state }];
      if (sql.includes("FROM task_action_requests")) return [action];
      if (sql.includes("FROM users")) return [{ id: "owner" }];
      if (sql.includes("INSERT INTO task_action_requests") || sql.includes("UPDATE task_action_requests")) { writes.push(sql); return [{ ...action, state: sql.includes("UPDATE") ? "RESOLVED" : "OPEN" }]; }
      throw new Error(`Unexpected query: ${sql}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => { writes.push(strings.join("?")); return 1; }),
  };
  const transaction = vi.fn(async (fn) => fn(tx));
  return { store: new PrismaWorkflowStore({ $transaction: transaction } as unknown as PrismaClient), transaction, writes };
}

describe("action request authorization and atomicity (database mocked)", () => {
  it("requires task write permission to request an action", async () => {
    const f = fixture();
    await expect(f.store.requestAction({ ...actor, canWrite: false }, "task", request)).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
  });
  it("records action, workflow event and outbox in one transaction", async () => {
    const f = fixture();
    await f.store.requestAction(actor, "task", request);
    expect(f.transaction).toHaveBeenCalledTimes(1);
    expect(f.writes.some((sql) => sql.includes("task_action_requests"))).toBe(true);
    expect(f.writes.some((sql) => sql.includes("workflow_events"))).toBe(true);
    expect(f.writes.some((sql) => sql.includes("workflow_outbox"))).toBe(true);
  });
  it("only recipient may respond; read access or edit permission is insufficient", async () => {
    const f = fixture({ recipientId: "another" });
    await expect(f.store.resolveAction(actor, "task", "action", resolve)).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
  });
  it("rejects stale action version", async () => {
    const f = fixture({ version: 3 });
    await expect(f.store.resolveAction(actor, "task", "action", resolve)).rejects.toMatchObject({ code: "CONFLITO" });
  });
  it("does not resolve a cancelled request", async () => {
    const f = fixture({ state: "CANCELLED" });
    await expect(f.store.resolveAction(actor, "task", "action", resolve)).rejects.toMatchObject({ code: "CONFLITO" });
  });
  it("requires actual review decision instead of acknowledging a REVIEW request", async () => {
    const f = fixture({ kind: "REVIEW" });
    await expect(f.store.resolveAction(actor, "task", "action", resolve)).rejects.toMatchObject({ code: "VALIDACAO" });
  });
});
