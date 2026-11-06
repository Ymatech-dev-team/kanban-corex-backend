import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PrismaWorkflowStore, operationDigest } from "../src/modules/workflow/prisma-workflow.js";
import { createWorkflow } from "../src/modules/workflow/workflow.js";
import type { WorkflowActor } from "../src/modules/workflow/types.js";

const actor: WorkflowActor = { orgId: "org", userId: "owner", channel: "MCP", connectionId: "grant", canCreate: true, canWrite: true, canReview: false, canApprove: false, canReopen: false };
const input = { operationId: "create-1", projectId: "client", engagementId: "project", title: "Deliver", context: "Plan", criteria: ["Works"], responsibleId: "owner" };
function fixture(opts: { parents?: boolean; replay?: unknown; failOutbox?: boolean; referenceExists?: boolean } = {}) {
  const writes: string[] = [];
  const tx = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("pg_advisory_xact_lock")) return [];
      if (sql.includes("FROM task_workflows")) return opts.referenceExists ? [{ taskId: "existing" }] : [];
      if (sql.includes("FROM workflow_operations")) return opts.replay ? [opts.replay] : [];
      if (sql.includes("FROM engagements")) return opts.parents === false ? [] : [{ id: "project", projectId: "client" }];
      if (sql.includes("FROM users")) return [{ id: "owner" }];
      if (sql.includes("MAX(position)")) return [{ position: 1024 }];
      throw new Error(`Unexpected query ${sql}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?"); writes.push(sql);
      if (opts.failOutbox && sql.includes("workflow_outbox")) throw new Error("outbox unavailable");
      return 1;
    }),
  };
  const transaction = vi.fn(async (fn) => fn(tx));
  return { store: new PrismaWorkflowStore({ $transaction: transaction } as unknown as PrismaClient), transaction, writes };
}

describe("managed task creation transaction (database mocked)", () => {
  it("requires dedicated create permission", async () => {
    const f = fixture();
    await expect(f.store.createManagedTask({ ...actor, canCreate: false }, input)).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
    expect(f.transaction).not.toHaveBeenCalled();
  });
  it("rejects absent/cross-org/mismatched parent project", async () => {
    const f = fixture({ parents: false });
    await expect(f.store.createManagedTask(actor, input)).rejects.toMatchObject({ code: "NAO_ENCONTRADO" });
    expect(f.writes).toEqual([]);
  });
  it("creates task, workflow, event, operation and outbox together", async () => {
    const f = fixture();
    const result = await f.store.createManagedTask(actor, input);
    expect(result.version).toBe(1);
    expect(result.taskId).not.toBe("scaffold");
    expect(f.transaction).toHaveBeenCalledTimes(1);
    for (const table of ["tasks", "task_workflows", "workflow_events", "workflow_operations", "workflow_outbox"]) {
      expect(f.writes.some((sql) => sql.startsWith(`INSERT INTO ${table} `))).toBe(true);
    }
  });
  it("replays original task when the create call is repeated", async () => {
    const { operationId: _operationId, ...payload } = input;
    const state = { ...createWorkflow({ orgId: "org", taskId: "original", responsibleId: "owner", context: "Plan", criteria: ["Works"] }), version: 1 };
    const f = fixture({ replay: { commandDigest: operationDigest({ tool: "create_managed_task", input: payload }), result: { state } } });
    expect((await f.store.createManagedTask(actor, input)).taskId).toBe("original");
    expect(f.writes).toEqual([]);
  });
  it("does not report created when outbox fails", async () => {
    const f = fixture({ failOutbox: true });
    await expect(f.store.createManagedTask(actor, input)).rejects.toThrow("outbox unavailable");
  });
});


describe("persistent plan item identity", () => {
  it("accepts explicit external reference for a new task", async () => {
    const f = fixture();
    await expect(f.store.createManagedTask(actor, { ...input, externalReference: "repo/plan/item" } as typeof input)).resolves.toMatchObject({ version: 1 });
    expect(f.writes.some((sql) => sql.includes('"externalReference"'))).toBe(true);
  });
  it("rejects an existing plan item even with a new operation or connection", async () => {
    const f = fixture({ referenceExists: true });
    await expect(f.store.createManagedTask({ ...actor, connectionId: "other" }, { ...input, externalReference: "repo/plan/item" } as typeof input)).rejects.toMatchObject({ code: "CONFLITO" });
    expect(f.writes).toEqual([]);
  });
});
