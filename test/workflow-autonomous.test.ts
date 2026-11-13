import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, createWorkflow } from "../src/modules/workflow/workflow.js";
import { commandSchema, workflowStateSchema } from "../src/modules/workflow/schemas.js";
import type { WorkflowActor, WorkflowCommand, WorkflowState } from "../src/modules/workflow/types.js";

const actor: WorkflowActor = { orgId: "org", userId: "user", channel: "MCP", connectionId: "grant", canWrite: true, canReview: true, canApprove: true, canReopen: false };
const at = "2026-11-08T12:00:00.000Z";
const checks = ["typecheck", "lint", "test", "build"].map(name => ({ name, required: true, status: "passed" as const }));
const run = (state: WorkflowState, command: WorkflowCommand, who = actor) => applyWorkflowCommand(state, who, command, state.version, at).state;
const submission = { type: "submit_review" as const, reviewMode: "AGENT" as const, summary: "Implemented and verified", evidence: ["test log"], checks };
function executing() {
  let state = createWorkflow({ taskId: "task", orgId: "org", responsibleId: "user", criteria: ["works"], context: "approved plan" });
  state = run(state, { type: "transition", to: "READY" });
  return run(state, { type: "start_execution", executionId: "run", agent: "Codex" });
}
const reviewing = () => run(executing(), submission);

describe("autonomous MCP completion", () => {
  it("accepts a checked MCP delivery, records trusted attribution and finishes the execution", () => {
    const state = run(reviewing(), { type: "approve_review", cycle: 1 });
    expect(state.stage).toBe("DONE");
    expect(state.execution?.status).toBe("FINISHED");
    expect(state.reviews[0]).toMatchObject({ decidedBy: "user", decidedChannel: "MCP", decidedAgent: "Codex" });
    expect(workflowStateSchema.safeParse(state).success).toBe(true);
  });
  it("does not attribute another authorized connection to the original executing agent", () => {
    const state = run(reviewing(), { type: "approve_review", cycle: 1 }, { ...actor, connectionId: "reviewer-grant" });
    expect(state.reviews[0]).toMatchObject({ decidedChannel: "MCP", decidedAgent: "Assistente conectado" });
  });
  it.each(["missing", "optional", "pending", "failed"])("rejects %s mandatory checks, even in persisted review snapshots", (kind) => {
    const state = reviewing();
    if (kind === "missing") state.reviews[0].checks = state.reviews[0].checks.filter(c => c.name !== "typecheck");
    else if (kind === "optional") state.reviews[0].checks[0].required = false;
    else state.reviews[0].checks[0].status = kind as "pending" | "failed";
    expect(() => run(state, { type: "approve_review", cycle: 1 }, { ...actor, channel: "WEB" })).toThrow(/verifica/i);
  });
  it("rejects absent approval permission and LOCAL_SYNC; permits authenticated agent reviewing legacy human work", () => {
    expect(() => run(reviewing(), { type: "approve_review", cycle: 1 }, { ...actor, canApprove: false })).toThrow(/permissão/i);
    expect(() => run(reviewing(), { type: "approve_review", cycle: 1 }, { ...actor, channel: "LOCAL_SYNC" })).toThrow();
    const noRun = reviewing(); delete noRun.execution;
    expect(run(noRun, { type: "approve_review", cycle: 1 }).stage).toBe("DONE");
    const human = reviewing(); human.executorIds = ["user"];
    expect(run(human, { type: "approve_review", cycle: 1 }).stage).toBe("DONE");
  });
  it("corrects a failed review and blocking finding in a new execution on the same card", () => {
    let state = executing();
    state = run(state, { type: "report_progress", executionId: "run", status: "FINISHED", summary: { objective: "deliver", completed: [], remaining: ["typecheck"], blockers: [], references: [], nextStep: "review" } });
    state = run(state, { ...submission, checks: checks.map(c => ({ ...c, status: c.name === "typecheck" ? "failed" : c.status })) });
    state = run(state, { type: "record_finding", id: "finding", description: "Missing type", criterion: "works", severity: "high", responsibleId: "user", blocking: true });
    expect(() => run(state, { type: "approve_review", cycle: 1 })).toThrow(/achados/i);
    state = run(state, { type: "request_changes", cycle: 1, reason: "Correct type and rerun checks" });
    state = run(state, { type: "start_execution", executionId: "run2", agent: "Claude" });
    state = run(state, { type: "report_fix", findingId: "finding", evidence: ["fixed type; typecheck log"] });
    state = run(state, submission);
    expect(() => run(state, { type: "approve_review", cycle: 2 })).toThrow(/achados/i);
    state = run(state, { type: "validate_finding", findingId: "finding", cycle: 2 });
    state = run(state, { type: "approve_review", cycle: 2 });
    expect(state).toMatchObject({ taskId: "task", stage: "DONE" });
    expect(state.findings).toHaveLength(1); expect(state.reviews).toHaveLength(2);
  });
  it("records late evidence after DONE without changing acceptance, execution or delivery", () => {
    const done = run(reviewing(), { type: "approve_review", cycle: 1 });
    const command = commandSchema.parse({ type: "record_evidence", summary: "Deployed", evidence: ["deployment link", "merge commit"] });
    const result = applyWorkflowCommand(done, actor, command, done.version, at);
    expect(result.state).toEqual({ ...done, version: done.version + 1 });
    expect(result.event.command).toEqual(command);
    expect(() => applyWorkflowCommand(done, { ...actor, canWrite: false }, command, done.version, at)).toThrow(/permissão/i);
    expect(() => applyWorkflowCommand(done, actor, command, done.version - 1, at)).toThrow(/versão/i);
  });
  it("allows evidence on a finished execution before approval and preserves all review gates", () => {
    let state = executing();
    state = run(state, { type: "report_progress", executionId: "run", status: "FINISHED", summary: { objective: "deliver", completed: [], remaining: ["review"], blockers: [], references: [], nextStep: "review" } });
    state = run(state, submission);
    const next = run(state, { type: "record_evidence", summary: "Smoke follow-up", evidence: ["smoke log"] });
    expect(next).toEqual({ ...state, version: state.version + 1 });
    expect(next.execution?.status).toBe("FINISHED");
  });
  it("rejects duplicate mandatory check names in stored snapshots", () => {
    const state = reviewing(); state.reviews[0].checks.push({ ...checks[0] });
    expect(() => run(state, { type: "approve_review", cycle: 1 })).toThrow(/verifica/i);
  });
  it("requires nonempty late evidence and keeps finished progress immutable", () => {
    expect(commandSchema.safeParse({ type: "record_evidence", summary: "done", evidence: [] }).success).toBe(false);
    const done = run(reviewing(), { type: "approve_review", cycle: 1 });
    expect(() => run(done, { type: "report_progress", executionId: "run", status: "RUNNING", summary: { objective: "deliver", completed: [], remaining: [], blockers: [], references: [], nextStep: "done" } })).toThrow(/encerrada/i);
  });
});
