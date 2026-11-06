import { describe, expect, it } from "vitest";
import { normalizeExecutorProvenance } from "../src/modules/workflow/executor-provenance.js";
import { createWorkflow } from "../src/modules/workflow/workflow.js";

function fixture() {
  const state = { ...createWorkflow({ orgId: "org", taskId: "task", responsibleId: "user", criteria: ["works"], context: "plan" }), version: 4, executorIds: ["user"] };
  const events = [
    { version: 1, type: "create_managed_task", actorId: "user", channel: "MCP", payload: {} },
    { version: 2, type: "start_execution", actorId: "user", channel: "MCP", payload: { command: { type: "start_execution", executionId: "run", agent: "claude" } } },
    { version: 3, type: "submit_review", actorId: "user", channel: "WEB", payload: { command: { type: "submit_review", summary: "done", evidence: ["proof"], checks: [] } } },
    { version: 4, type: "record_finding", actorId: "user", channel: "MCP", payload: { command: { type: "record_finding", id: "finding", description: "test", severity: "low", criterion: "works", responsibleId: "user", blocking: true } } },
  ];
  return { state, events };
}
describe("executor provenance repair", () => {
  it("removes only a proven review submitter and preserves immutable input", () => {
    const { state, events } = fixture();
    expect(normalizeExecutorProvenance(state, events).executorIds).toEqual([]);
    expect(state.executorIds).toEqual(["user"]);
  });
  it.each(["start_execution", "change_delivery", "report_fix", "transition"])("preserves actual WEB executor from %s", type => {
    const { state, events } = fixture();
    const commands = { start_execution: { type, executionId: "run", agent: "human" }, change_delivery: { type, reason: "work" }, report_fix: { type, findingId: "finding", evidence: ["proof"] }, transition: { type, to: "DOING" } };
    events[1] = { version: 2, type, actorId: "user", channel: "WEB", payload: { command: commands[type as keyof typeof commands] } } as typeof events[number];
    expect(normalizeExecutorProvenance(state, events).executorIds).toEqual(["user"]);
  });
  it("preserves unknown executor IDs instead of inferring absence of work", () => {
    const { state, events } = fixture(); state.executorIds.push("legacy-human");
    expect(normalizeExecutorProvenance(state, events).executorIds).toEqual(["legacy-human"]);
  });
  it.each(["missing", "duplicate", "initialize", "unknown", "malformed", "channel", "future"])("fails closed on %s history", variant => {
    const { state, events } = fixture();
    if (variant === "missing") events.splice(1, 1);
    if (variant === "duplicate") events[1].version = 1;
    if (variant === "initialize") events[0].type = "initialize";
    if (variant === "unknown") events[1].type = "unknown";
    if (variant === "malformed") events[1].payload = {} as typeof events[1]["payload"];
    if (variant === "channel") events[1].channel = "UNTRUSTED";
    if (variant === "future") events[3].version = 5;
    expect(normalizeExecutorProvenance(state, events).executorIds).toEqual(["user"]);
  });
});

// Adapter proof: pre-fix snapshots must project the same policy in reads and writes.
import { vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { PrismaWorkflowStore } from "../src/modules/workflow/prisma-workflow.js";
import type { WorkflowState } from "../src/modules/workflow/types.js";

describe("persisted pre-fix review snapshots", () => {
  function persisted(humanExecution = false) {
    const { state: base, events } = fixture();
    if (humanExecution) events[1].channel = "WEB";
    const state: WorkflowState = { ...base, stage: "IN_REVIEW", reviews: [{ cycle: 1, deliveryRevision: 1, submittedBy: "user", submittedAt: "2026-11-06T00:00:00.000Z", summary: "done", evidence: ["proof"], checks: ["typecheck", "lint", "test", "build"].map(name => ({ name, required: true, status: "passed" })), decision: "pending" }] };
    const query = vi.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join("?");
      if (sql.includes("FOR UPDATE OF t")) return [{ id: "task", status: "DOING", projectId: "project" }];
      if (sql.includes("FROM workflow_operations") || sql.includes("pg_advisory_xact_lock")) return [];
      if (sql.includes("FROM task_workflows")) return [{ aggregate: state }];
      if (sql.includes("FROM workflow_events")) return events;
      throw new Error(`Unexpected query ${sql}`);
    });
    const write = vi.fn().mockResolvedValue(1);
    const db = { $queryRaw: query, $executeRaw: write, $transaction: vi.fn(async callback => callback(db)) };
    return { store: new PrismaWorkflowStore(db as unknown as PrismaClient), query, write, state };
  }
  const actor = { orgId: "org", userId: "user", channel: "WEB" as const, canWrite: true, canReview: true, canApprove: true, canReopen: false };
  it("returns corrected executors read-only, then persists correction with human approval", async () => {
    const s = persisted();
    expect((await s.store.load("org", "task"))?.executorIds).toEqual([]);
    expect(s.write).not.toHaveBeenCalled();
    const result = await s.store.execute(actor, "task", { operationId: "approve", expectedVersion: 4, command: { type: "approve_review", cycle: 1 } });
    expect(result).toMatchObject({ stage: "DONE", version: 5, executorIds: [] });
    expect(s.state.executorIds).toEqual(["user"]);
    expect(s.write.mock.calls.some(([sql]) => sql.join("?").includes("INSERT INTO workflow_events"))).toBe(true);
  });
  it("preserves the human execution restriction through reads and commands", async () => {
    const s = persisted(true);
    expect((await s.store.load("org", "task"))?.executorIds).toEqual(["user"]);
    await expect(s.store.execute(actor, "task", { operationId: "approve", expectedVersion: 4, command: { type: "approve_review", cycle: 1 } })).rejects.toThrow(/executor/i);
    expect(s.write).not.toHaveBeenCalled();
  });
  it("still blocks missing checks after repairing attribution", async () => {
    const s = persisted(); s.state.reviews[0].checks[0].status = "pending";
    await expect(s.store.execute(actor, "task", { operationId: "approve", expectedVersion: 4, command: { type: "approve_review", cycle: 1 } })).rejects.toThrow(/verificações/i);
    expect(s.write).not.toHaveBeenCalled();
  });
  it("does not allow MCP human acceptance after repairing attribution", async () => {
    const s = persisted();
    await expect(s.store.execute({ ...actor, channel: "MCP", connectionId: "agent" }, "task", { operationId: "approve", expectedVersion: 4, command: { type: "approve_review", cycle: 1 } })).rejects.toThrow(/humano/i);
    expect(s.write).not.toHaveBeenCalled();
  });
});
