import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, createWorkflow } from "../src/modules/workflow/workflow.js";
import { commandSchema, workflowStateSchema } from "../src/modules/workflow/schemas.js";
import type { WorkflowActor, WorkflowCommand, WorkflowState } from "../src/modules/workflow/types.js";
const actor: WorkflowActor = { orgId: "org", userId: "reviewer", channel: "WEB", canWrite: true, canReview: true, canApprove: true, canReopen: true };
const at = "2026-11-12T23:00:00.000Z";
const command = { type: "approve_with_reservations", cycle: 1, checkNames: ["lint", "test"], reason: "Falhas preexistentes fora da entrega" };
const run = (state: WorkflowState, cmd = command, who = actor) => applyWorkflowCommand(state, who, cmd as WorkflowCommand, state.version, at);
function reviewing(): WorkflowState {
  return { ...createWorkflow({ taskId: "task", orgId: "org", responsibleId: "owner", criteria: ["works"], context: "plan" }), stage: "IN_REVIEW", version: 4, executorIds: ["human-executor"], reviews: [{ cycle: 1, deliveryRevision: 1, reviewMode: "HUMAN", submittedBy: "owner", submittedAt: at, summary: "done", evidence: ["logs"], checks: ["typecheck", "lint", "test", "build"].map(name => ({ name, required: true, status: name === "lint" || name === "test" ? "failed" : "passed" })), decision: "pending" }] };
}
describe("human approval with reservations", () => {
  it("concludes without rewriting failed checks and records trusted audit metadata", () => {
    const before = reviewing(), result = run(before);
    expect(result.state.stage).toBe("DONE");
    expect(result.state.reviews[0].checks).toEqual(before.reviews[0].checks);
    expect(result.state.reviews[0]).toMatchObject({ decision: "approved", decidedChannel: "WEB", reservation: { checkNames: command.checkNames, reason: command.reason, approvedBy: actor.userId, approvedAt: at, cycle: 1, deliveryRevision: 1 } });
  });
  it.each(["MCP", "LOCAL_SYNC"] as const)("rejects %s even with approval permission", channel => {
    expect(() => run(reviewing(), command, { ...actor, channel, connectionId: "grant" })).toThrow(/painel/i);
  });
  it("requires approval permission and an independent human", () => {
    expect(() => run(reviewing(), command, { ...actor, canApprove: false })).toThrow(/permissão/i);
    expect(() => run(reviewing(), command, { ...actor, userId: "human-executor" })).toThrow(/executor/i);
    expect(() => run(reviewing(), command, { ...actor, orgId: "other" })).toThrow(/permissão/i);
  });
  it.each([[], ["lint"], ["lint", "test", "test"], ["lint", "test", "unknown"], ["lint", "test", "build"]].map(checkNames => ({ checkNames })))("rejects invalid or incomplete selections $checkNames", ({ checkNames }) => {
    expect(() => run(reviewing(), { ...command, checkNames })).toThrow();
  });
  it.each(["pending", "missing", "optional", "duplicate"])("does not bypass %s mandatory checks", kind => {
    const state = reviewing();
    if (kind === "pending") state.reviews[0].checks[1].status = "pending";
    if (kind === "missing") state.reviews[0].checks.shift();
    if (kind === "optional") state.reviews[0].checks[0].required = false;
    if (kind === "duplicate") state.reviews[0].checks.push({ ...state.reviews[0].checks[0] });
    expect(() => run(state)).toThrow();
  });
  it("does not bypass findings, cycle/version or delivery boundaries", () => {
    const state = reviewing();
    state.findings = [{ id: "f", description: "block", severity: "high", criterion: "works", responsibleId: "owner", blocking: true, state: "open", openedInCycle: 1, fixEvidence: [] }];
    expect(() => run(state)).toThrow(/achados/i);
    expect(() => run(reviewing(), { ...command, cycle: 2 })).toThrow(/revisão/i);
    const stale = reviewing(); stale.deliveryRevision = 2;
    expect(() => run(stale)).toThrow(/revisão/i);
    expect(() => applyWorkflowCommand(reviewing(), actor, command as WorkflowCommand, 3, at)).toThrow(/versão/i);
  });
  it("requires a meaningful reason and a strict command", () => {
    for (const reason of ["", "  ", "ab"]) expect(() => run(reviewing(), { ...command, reason })).toThrow();
    expect(commandSchema.safeParse(command).success).toBe(true);
    expect(commandSchema.safeParse({ ...command, approvedBy: "spoof" }).success).toBe(false);
  });
  it("roundtrips snapshots and does not reuse a reservation for a new review", () => {
    const done = run(reviewing()).state;
    expect(workflowStateSchema.safeParse(done).success).toBe(true);
    const reopened = applyWorkflowCommand(done, { ...actor, userId: "owner" }, { type: "change_delivery", reason: "new delivery" }, done.version, at).state;
    const submitted = applyWorkflowCommand(reopened, { ...actor, userId: "owner" }, { type: "submit_review", summary: "new", evidence: ["new logs"], checks: reviewing().reviews[0].checks }, reopened.version, at).state;
    expect(submitted.reviews.at(-1)).not.toHaveProperty("reservation");
    expect(() => applyWorkflowCommand(submitted, actor, { type: "approve_review", cycle: 2 }, submitted.version, at)).toThrow(/verifica/i);
  });
});
