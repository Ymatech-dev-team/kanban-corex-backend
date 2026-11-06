import { describe, expect, it } from "vitest";
import { createWorkflow, applyWorkflowCommand } from "../src/modules/workflow/workflow.js";
import type { WorkflowActor, WorkflowCommand, WorkflowState } from "../src/modules/workflow/types.js";

const actor: WorkflowActor = { orgId: "org", userId: "owner", channel: "MCP", connectionId: "connection", canWrite: true, canReview: false, canApprove: false, canReopen: false };
const timestamp = "2026-11-06T16:00:00.000Z";
const state = () => ({ ...createWorkflow({ taskId: "task", orgId: "org", responsibleId: "owner", context: "Plan", criteria: ["Works"] }), stage: "READY" as const });
const run = (s: WorkflowState, command: WorkflowCommand, a = actor) => applyWorkflowCommand(s, a, command, s.version, timestamp).state;
const start: WorkflowCommand = { type: "start_execution", executionId: "run1", agent: "Claude", sessionReference: "session-1" };
const progress: WorkflowCommand = { type: "report_progress", executionId: "run1", status: "WAITING", summary: { objective: "Deliver feature", completed: ["Implemented"], remaining: ["Review"], nextStep: "Approve design", blockers: ["Decision"], references: ["PR #12"] } };

describe("execution checkpoints and live summary", () => {
  it("starts execution on the same task with trusted identity and reported timestamp", () => {
    const s = run(state(), start);
    expect(s.taskId).toBe("task");
    expect(s.stage).toBe("DOING");
    expect(s.execution).toMatchObject({ id: "run1", ownerId: "owner", channel: "MCP", status: "RUNNING", lastUpdatedAt: timestamp });
    expect(s.executorIds).toEqual([]);
  });
  it("does not permit an unprivileged actor to start execution", () => {
    expect(() => run(state(), start, { ...actor, canWrite: false })).toThrow(/permissão/i);
  });
  it("refuses silently taking over an active execution", () => {
    expect(() => run(run(state(), start), { ...start, executionId: "other" })).toThrow(/execução/i);
  });
  it("updates a structured summary without changing delivery revision or marking done", () => {
    const s = run(run(state(), start), progress);
    expect(s.stage).toBe("DOING");
    expect(s.deliveryRevision).toBe(1);
    expect(s.summary).toMatchObject({ nextStep: "Approve design", updatedBy: "owner", channel: "MCP", updatedAt: timestamp });
    expect(s.execution?.status).toBe("WAITING");
  });
  it("rejects progress on another run or another owner's run", () => {
    const s = run(state(), start);
    expect(() => run(s, { ...progress, executionId: "other" })).toThrow(/execução/i);
    expect(() => run(s, progress, { ...actor, userId: "another" })).toThrow(/execução/i);
  });
  it("FINISHED execution does not approve the task", () => {
    const s = run(run(state(), start), { ...progress, status: "FINISHED" });
    expect(s.execution?.status).toBe("FINISHED");
    expect(s.stage).toBe("DOING");
  });
  it("permits explicit context and criteria changes only while invalidating delivery", () => {
    const s = run(state(), { type: "change_delivery", reason: "Scope clarified", context: "New plan", criteria: ["New acceptance"] });
    expect(s.context).toBe("New plan");
    expect(s.criteria).toEqual(["New acceptance"]);
    expect(s.deliveryRevision).toBe(2);
  });
});
