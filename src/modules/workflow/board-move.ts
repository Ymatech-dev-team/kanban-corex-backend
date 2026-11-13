import { AppError } from "../../lib/errors.js";
import type { BoardMoveActor, BoardMoveInput } from "./persistence.js";
import type { WorkflowState } from "./types.js";
import { applyWorkflowCommand } from "./workflow.js";

export const boardStatus = (state: WorkflowState): BoardMoveInput["status"] => state.stage === "DONE" ? "DONE" : ["DOING", "IN_REVIEW", "CHANGES_REQUESTED"].includes(state.stage) ? "DOING" : "TODO";

/** Pure board transition. No synthetic checks, evidence, or agent execution. */
export function applyBoardMove(current: WorkflowState, actor: BoardMoveActor, target: BoardMoveInput["status"], at: string): WorkflowState {
  if (!actor.canMove || actor.channel !== "WEB" || actor.orgId !== current.orgId || !actor.userId) throw new AppError("SEM_PERMISSAO", "Sem permissão para mover esta tarefa");
  const from = boardStatus(current);
  const state = structuredClone(current);
  if (from === target) { state.version++; return state; }
  if (target === "DONE" ? !actor.canApprove : !actor.canWrite) throw new AppError("SEM_PERMISSAO", "Sem permissão para alterar esta etapa");
  if (target === "DONE") {
    if (state.stage === "IN_REVIEW") {
      const review = state.reviews.at(-1);
      if (!review) throw new AppError("CONFLITO", "Revisão atual ausente; atualize a tarefa");
      return applyWorkflowCommand(state, actor, { type: "approve_anyway", cycle: review.cycle }, state.version, at).state;
    }
    state.boardCompletion = { approvedBy: actor.userId, approvedAt: at, channel: "WEB", deliveryRevision: state.deliveryRevision };
    state.stage = "DONE";
  } else {
    if (from === "DONE") {
      state.deliveryRevision++;
      // Prior resolution remains evidenced in history; it cannot certify a new delivery.
      for (const finding of state.findings) {
        finding.state = "open";
        finding.fixEvidence = [];
        delete finding.resolvedDeliveryRevision;
        delete finding.validatedInCycle;
        delete finding.waiverReason;
      }
    }
    const review = state.reviews.at(-1);
    if (review?.decision === "pending") review.decision = "superseded";
    state.stage = target === "DOING" ? "DOING" : "BACKLOG";
  }
  if (state.execution) { state.execution.status = "FINISHED"; state.execution.lastUpdatedAt = at; }
  state.version++;
  return state;
}
