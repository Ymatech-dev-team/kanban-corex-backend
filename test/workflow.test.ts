import { describe, expect, it } from "vitest";
import { applyWorkflowCommand, createWorkflow } from "../src/modules/workflow/workflow.js";
import type { WorkflowActor, WorkflowCommand, WorkflowState } from "../src/modules/workflow/types.js";

const executor: WorkflowActor = { orgId: "org", userId: "dev", channel: "WEB", canWrite: true, canReview: false, canApprove: false, canReopen: false };
const reviewer: WorkflowActor = { ...executor, userId: "reviewer", canReview: true, canApprove: true, canReopen: true };
const at = "2026-11-06T15:00:00.000Z";
const run = (state: WorkflowState, command: WorkflowCommand, actor = executor) =>
  applyWorkflowCommand(state, actor, command, state.version, at).state;
const initial = () => createWorkflow({ taskId: "task", orgId: "org", responsibleId: "dev", criteria: ["Behavior verified"], context: "Plan reference" });
const doing = () => run(run(initial(), { type: "transition", to: "READY" }), { type: "transition", to: "DOING" });
const submit: WorkflowCommand = { type: "submit_review", summary: "Implemented", evidence: ["PR #12"], checks: [{ name: "test", status: "passed", required: true }] };
const review = () => run(doing(), submit);
const finding: WorkflowCommand = { type: "record_finding", id: "finding-1", description: "Missing empty state", severity: "high", criterion: "Behavior verified", responsibleId: "dev", blocking: true };

describe("workflow domain authorization and review", () => {
  it("rejects cross-organization access and missing write permission without changing state", () => {
    const state = initial();
    expect(() => run(state, { type: "transition", to: "READY" }, { ...executor, orgId: "other" })).toThrow(/permissão/i);
    expect(() => run(state, { type: "transition", to: "READY" }, { ...executor, canWrite: false })).toThrow(/permissão/i);
    expect(state.version).toBe(0);
  });

  it("rejects stale expectedVersion", () => {
    expect(() => applyWorkflowCommand(initial(), executor, { type: "transition", to: "READY" }, 5, at)).toThrow(/versão/i);
  });

  it("requires preparation and does not allow generic transition to bypass review", () => {
    const state = initial();
    state.criteria = [];
    expect(() => run(state, { type: "transition", to: "READY" })).toThrow(/critério/i);
    expect(() => run(doing(), { type: "transition", to: "DONE" })).toThrow(/transição/i);
    expect(() => run(doing(), { type: "transition", to: "IN_REVIEW" })).toThrow(/transição/i);
  });

  it("MCP cannot give human acceptance even with an approving account", () => {
    expect(() => run(review(), { type: "approve_review", cycle: 1 }, { ...reviewer, channel: "MCP" })).toThrow(/humano/i);
  });

  it("allows a human sponsor to accept an agent delivery but never the MCP channel", () => {
    const agent = { ...reviewer, channel: "MCP" as const };
    let state = run(initial(), { type: "transition", to: "READY" }, agent);
    state = run(state, { type: "transition", to: "DOING" }, agent);
    state = run(state, submit, agent);
    expect(state.executorIds).toEqual([]);
    expect(() => run(state, { type: "approve_review", cycle: 1 }, agent)).toThrow(/humano/i);
    expect(run(state, { type: "approve_review", cycle: 1 }, reviewer).stage).toBe("DONE");
  });

  it("rejects self approval and approval by any previous executor", () => {
    expect(() => run(review(), { type: "approve_review", cycle: 1 }, { ...reviewer, userId: "dev" })).toThrow(/executor/i);
    let state = doing();
    state = run(state, { type: "change_delivery", reason: "Additional implementation" }, reviewer);
    state = run(state, submit);
    expect(() => run(state, { type: "approve_review", cycle: 1 }, reviewer)).toThrow(/executor/i);
  });

  it("requires review permission and explicit correction evidence", () => {
    expect(() => run(review(), finding)).toThrow(/permissão/i);
    const state = run(review(), finding, reviewer);
    expect(() => run(state, { type: "report_fix", findingId: "finding-1", evidence: [] })).toThrow(/evidência/i);
    expect(() => run(state, { type: "validate_finding", findingId: "finding-1", cycle: 1 })).toThrow(/permissão/i);
  });

  it("preserves task and finding IDs across review and correction cycles", () => {
    let state = run(review(), finding, reviewer);
    state = run(state, { type: "request_changes", cycle: 1, reason: "Fix empty state" }, reviewer);
    state = run(state, { type: "transition", to: "DOING" });
    state = run(state, { type: "change_delivery", reason: "Added empty state" });
    state = run(state, { type: "report_fix", findingId: "finding-1", evidence: ["Regression test passed"] });
    state = run(state, submit);
    expect(() => run(state, { type: "approve_review", cycle: 2 }, reviewer)).toThrow(/achados/i);
    state = run(state, { type: "validate_finding", findingId: "finding-1", cycle: 2 }, reviewer);
    state = run(state, { type: "approve_review", cycle: 2 }, reviewer);
    expect(state.taskId).toBe("task");
    expect(state.stage).toBe("DONE");
    expect(state.reviews).toHaveLength(2);
    expect(state.findings).toHaveLength(1);
    expect(state.findings[0]).toMatchObject({ id: "finding-1", openedInCycle: 1, validatedInCycle: 2, state: "validated" });
    expect(state.reviews[0].decision).toBe("changes_requested");
  });

  it("rejects approval and finding validation for old cycles", () => {
    let state = run(review(), finding, reviewer);
    state = run(state, { type: "request_changes", cycle: 1, reason: "Fix" }, reviewer);
    state = run(state, { type: "transition", to: "DOING" });
    state = run(state, { type: "report_fix", findingId: "finding-1", evidence: ["Fix"] });
    state = run(state, submit);
    expect(() => run(state, { type: "approve_review", cycle: 1 }, reviewer)).toThrow(/revisão/i);
    expect(() => run(state, { type: "validate_finding", findingId: "finding-1", cycle: 1 }, reviewer)).toThrow(/revisão/i);
  });

  it("invalidates approval on delivery change and requires explicit reopening of DONE", () => {
    const approved = run(review(), { type: "approve_review", cycle: 1 }, reviewer);
    expect(() => run(approved, { type: "change_delivery", reason: "Changed scope" })).toThrow(/reabrir/i);
    const reopened = run(approved, { type: "change_delivery", reason: "Changed scope" }, reviewer);
    expect(reopened.stage).toBe("DOING");
    expect(reopened.deliveryRevision).toBe(2);
    expect(reopened.reviews[0].decision).toBe("approved");
    expect(() => run(reopened, { type: "approve_review", cycle: 1 }, { ...reviewer, userId: "third" })).toThrow(/revisão/i);
  });

  it("fails approval when required checks did not pass and rejects empty evidence", () => {
    const state = run(doing(), { ...submit, type: "submit_review", checks: [{ name: "test", status: "failed", required: true }] });
    expect(() => run(state, { type: "approve_review", cycle: 1 }, reviewer)).toThrow(/verificações/i);
    expect(() => run(doing(), { type: "submit_review", summary: "Done", evidence: [], checks: [] })).toThrow(/evidência/i);
  });

  it("waiver requires review permission, reason and current cycle", () => {
    const state = run(review(), finding, reviewer);
    expect(() => run(state, { type: "waive_finding", findingId: "finding-1", cycle: 1, reason: "" }, reviewer)).toThrow(/justificativa/i);
    const waived = run(state, { type: "waive_finding", findingId: "finding-1", cycle: 1, reason: "Out of approved scope" }, reviewer);
    expect(run(waived, { type: "approve_review", cycle: 1 }, reviewer).stage).toBe("DONE");
  });

  it("does not mutate input and emits an auditable event for a successful command", () => {
    const state = initial();
    const result = applyWorkflowCommand(state, executor, { type: "transition", to: "READY" }, 0, at);
    expect(state.stage).toBe("BACKLOG");
    expect(result.state.version).toBe(1);
    expect(result.event).toMatchObject({ taskId: "task", actorId: "dev", channel: "WEB", type: "transition", version: 1 });
  });

  it("refuses duplicate finding IDs rather than silently creating a second finding", () => {
    const state = run(review(), finding, reviewer);
    expect(() => run(state, finding, reviewer)).toThrow(/existe/i);
  });

  it("invalidates prior correction evidence when delivery changes again", () => {
    let state = run(review(), finding, reviewer);
    state = run(state, { type: "request_changes", cycle: 1, reason: "Fix" }, reviewer);
    state = run(state, { type: "transition", to: "DOING" });
    state = run(state, { type: "report_fix", findingId: "finding-1", evidence: ["Old fix"] });
    state = run(state, { type: "change_delivery", reason: "Further changes" });
    state = run(state, submit);
    expect(state.findings[0].fixEvidence).toEqual([]);
    expect(() => run(state, { type: "validate_finding", findingId: "finding-1", cycle: 2 }, reviewer)).toThrow(/correção/i);
  });

  it("requires permission and reason for a return to planning", () => {
    expect(() => run(doing(), { type: "transition", to: "PLANNING", reason: "Changed scope" })).toThrow(/permissão/i);
    expect(() => run(doing(), { type: "transition", to: "PLANNING" }, reviewer)).toThrow(/justificativa/i);
    expect(run(doing(), { type: "transition", to: "PLANNING", reason: "Changed scope" }, reviewer).stage).toBe("PLANNING");
  });

  it("rejects self-validation and self-waiver even for an account with review permission", () => {
    let state = run(review(), finding, reviewer);
    state = run(state, { type: "request_changes", cycle: 1, reason: "Fix" }, reviewer);
    state = run(state, { type: "transition", to: "DOING" });
    state = run(state, { type: "report_fix", findingId: "finding-1", evidence: ["Fix"] });
    state = run(state, submit);
    const selfReviewer = { ...executor, canReview: true };
    expect(() => run(state, { type: "validate_finding", findingId: "finding-1", cycle: 2 }, selfReviewer)).toThrow(/executor/i);
    expect(() => run(state, { type: "waive_finding", findingId: "finding-1", cycle: 2, reason: "Ignore" }, selfReviewer)).toThrow(/executor/i);
  });
});
