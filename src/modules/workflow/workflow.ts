import { AppError } from "../../lib/errors.js";
import type { WorkflowActor, WorkflowCommand, WorkflowFinding, WorkflowResult, WorkflowState, WorkflowStage } from "./types.js";

function requireText(value: string, label: string, max = 8_000): void {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new AppError("VALIDACAO", `${label} é obrigatório e deve ter até ${max} caracteres`);
  }
}

function requireEvidence(evidence: string[]): void {
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.length > 50) {
    throw new AppError("VALIDACAO", "Informe de 1 a 50 referências de evidência");
  }
  for (const item of evidence) requireText(item, "Evidência", 2_000);
}

function requirePermission(allowed: boolean): void {
  if (!allowed) throw new AppError("SEM_PERMISSAO", "Sem permissão para esta operação");
}

function currentReview(state: WorkflowState, cycle?: number) {
  const review = state.reviews.at(-1);
  if (state.stage !== "IN_REVIEW" || !review || review.decision !== "pending" ||
    review.deliveryRevision !== state.deliveryRevision || (cycle !== undefined && review.cycle !== cycle)) {
    throw new AppError("CONFLITO", "A revisão não corresponde à entrega atual");
  }
  return review;
}

function getFinding(state: WorkflowState, id: string): WorkflowFinding {
  const finding = state.findings.find((item) => item.id === id);
  if (!finding) throw new AppError("NAO_ENCONTRADO", "Achado não encontrado nesta tarefa");
  return finding;
}

function markExecutor(state: WorkflowState, actor: WorkflowActor) {
  // Delegating to an agent does not make the sponsoring human an executor.
  // The authenticated adapter controls channel; callers cannot select it.
  if (actor.channel === "WEB" && !state.executorIds.includes(actor.userId)) state.executorIds.push(actor.userId);
}

function ready(state: WorkflowState): void {
  if (state.criteria.length === 0 || state.criteria.length > 100) {
    throw new AppError("VALIDACAO", "Informe os critérios de aceite");
  }
  for (const criterion of state.criteria) requireText(criterion, "Critério de aceite", 2_000);
  requireText(state.context, "Contexto");
  requireText(state.responsibleId, "Responsável", 128);
}

const FORWARD: Partial<Record<WorkflowStage, readonly WorkflowStage[]>> = {
  BACKLOG: ["PLANNING", "READY"], PLANNING: ["READY"], READY: ["DOING"], CHANGES_REQUESTED: ["DOING"],
};

function transition(state: WorkflowState, actor: WorkflowActor, command: Extract<WorkflowCommand, { type: "transition" }>) {
  requirePermission(actor.canWrite);
  const planningReturn = (state.stage === "READY" || state.stage === "DOING") && command.to === "PLANNING";
  if (planningReturn) {
    requirePermission(actor.canReopen);
    requireText(command.reason ?? "", "Justificativa do retorno");
  } else if (!FORWARD[state.stage]?.includes(command.to)) {
    throw new AppError("VALIDACAO", "Transição inválida; submissão e aceite usam comandos de revisão");
  }
  if (command.to === "READY" || command.to === "DOING") ready(state);
  state.stage = command.to;
  if (command.to === "DOING") markExecutor(state, actor);
}

export function createWorkflow(input: Pick<WorkflowState, "taskId" | "orgId" | "responsibleId" | "criteria" | "context">): WorkflowState {
  requireText(input.taskId, "Tarefa", 128);
  requireText(input.orgId, "Organização", 128);
  return { ...structuredClone(input), version: 0, stage: "BACKLOG", deliveryRevision: 1, executorIds: [], reviews: [], findings: [] };
}

export function applyWorkflowCommand(
  current: WorkflowState,
  actor: WorkflowActor,
  command: WorkflowCommand,
  expectedVersion: number,
  at: string,
): WorkflowResult {
  requirePermission(actor.orgId === current.orgId && !!actor.userId);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion !== current.version) {
    throw new AppError("CONFLITO", "A versão da tarefa mudou; releia antes de atualizar");
  }
  if (!Number.isFinite(Date.parse(at))) throw new AppError("VALIDACAO", "Data do evento inválida");
  const state = structuredClone(current);
  switch (command.type) {
    case "start_execution": {
      requirePermission(actor.canWrite);
      if (!["READY", "DOING", "CHANGES_REQUESTED"].includes(state.stage)) throw new AppError("VALIDACAO", "A tarefa não está pronta para execução");
      if (state.execution && ["RUNNING", "WAITING"].includes(state.execution.status)) throw new AppError("CONFLITO", "Já existe uma execução em andamento; pause ou encerre antes de transferir");
      ready(state);
      requireText(command.executionId, "Execução", 128);
      requireText(command.agent, "Agente", 128);
      if (command.sessionReference !== undefined) requireText(command.sessionReference, "Sessão", 256);
      state.execution = { id: command.executionId, agent: command.agent, ownerId: actor.userId, channel: actor.channel,
        ...(actor.connectionId ? { connectionId: actor.connectionId } : {}),
        ...(command.sessionReference ? { sessionReference: command.sessionReference } : {}), status: "RUNNING", lastUpdatedAt: at };
      state.stage = "DOING";
      markExecutor(state, actor);
      break;
    }
    case "report_progress": {
      requirePermission(actor.canWrite);
      if (!state.execution || state.execution.id !== command.executionId || state.execution.ownerId !== actor.userId ||
        state.execution.channel !== actor.channel || state.execution.connectionId !== actor.connectionId) {
        throw new AppError("SEM_PERMISSAO", "A execução não pertence a esta sessão autenticada");
      }
      if (state.execution.status === "FINISHED" || state.stage === "DONE") throw new AppError("CONFLITO", "A execução já foi encerrada");
      if (!["RUNNING", "WAITING", "PAUSED", "FINISHED"].includes(command.status)) throw new AppError("VALIDACAO", "Estado de execução inválido");
      requireText(command.summary.objective, "Objetivo");
      requireText(command.summary.nextStep, "Próximo passo");
      for (const values of [command.summary.completed, command.summary.remaining, command.summary.blockers, command.summary.references]) {
        if (!Array.isArray(values) || values.length > 50) throw new AppError("VALIDACAO", "Resumo deve ter até 50 itens por seção");
        for (const value of values) requireText(value, "Item do resumo", 2000);
      }
      state.summary = { ...structuredClone(command.summary), updatedAt: at, updatedBy: actor.userId, channel: actor.channel };
      state.execution.status = command.status;
      state.execution.lastUpdatedAt = at;
      break;
    }
    case "transition":
      transition(state, actor, command);
      break;
    case "change_delivery": {
      requirePermission(actor.canWrite);
      requireText(command.reason, "Justificativa da alteração");
      if (command.context !== undefined) { requireText(command.context, "Contexto"); state.context = command.context; }
      if (command.criteria !== undefined) {
        if (!command.criteria.length || command.criteria.length > 100) throw new AppError("VALIDACAO", "Informe de 1 a 100 critérios");
        for (const criterion of command.criteria) requireText(criterion, "Critério de aceite", 2000);
        state.criteria = [...command.criteria];
      }
      if (state.stage === "DONE" && !actor.canReopen) throw new AppError("SEM_PERMISSAO", "Sem permissão para reabrir a entrega");
      state.deliveryRevision += 1;
      const review = state.reviews.at(-1);
      if (review?.decision === "pending") review.decision = "superseded";
      for (const finding of state.findings) {
        // Resolutions were for a specific delivery. A new delivery must be reviewed again.
        finding.state = "open";
        finding.fixEvidence = [];
        delete finding.validatedInCycle;
        delete finding.resolvedDeliveryRevision;
        delete finding.waiverReason;
      }
      if (state.stage === "IN_REVIEW" || state.stage === "DONE") state.stage = "DOING";
      markExecutor(state, actor);
      break;
    }
    case "submit_review": {
      requirePermission(actor.canWrite);
      if (state.stage !== "DOING") throw new AppError("VALIDACAO", "Submissão exige tarefa em execução");
      ready(state);
      requireText(command.summary, "Resumo da entrega");
      requireEvidence(command.evidence);
      if (!Array.isArray(command.checks) || command.checks.length > 100) throw new AppError("VALIDACAO", "Verificações inválidas");
      const names = new Set<string>();
      for (const check of command.checks) {
        requireText(check.name, "Nome da verificação", 128);
        if (names.has(check.name) || !["passed", "failed", "pending"].includes(check.status) || typeof check.required !== "boolean") {
          throw new AppError("VALIDACAO", "Verificações inválidas ou duplicadas");
        }
        names.add(check.name);
      }
      state.reviews.push({ cycle: (state.reviews.at(-1)?.cycle ?? 0) + 1, deliveryRevision: state.deliveryRevision,
        submittedBy: actor.userId, submittedAt: at, summary: command.summary, evidence: [...command.evidence],
        checks: structuredClone(command.checks), decision: "pending" });
      state.stage = "IN_REVIEW";
      // Submission is coordination, not evidence of human implementation.
      break;
    }
    case "record_finding": {
      requirePermission(actor.canReview);
      const review = currentReview(state);
      requireText(command.id, "Identificador do achado", 128);
      requireText(command.description, "Descrição do achado");
      requireText(command.criterion, "Critério afetado", 2_000);
      requireText(command.responsibleId, "Responsável", 128);
      if (!["low", "medium", "high", "critical"].includes(command.severity) || typeof command.blocking !== "boolean") {
        throw new AppError("VALIDACAO", "Severidade ou bloqueio inválido");
      }
      if (state.findings.some((item) => item.id === command.id)) throw new AppError("CONFLITO", "O achado já existe nesta tarefa");
      state.findings.push({ id: command.id, description: command.description, severity: command.severity,
        criterion: command.criterion, responsibleId: command.responsibleId, blocking: command.blocking,
        state: "open", openedInCycle: review.cycle, fixEvidence: [] });
      break;
    }
    case "report_fix": {
      requirePermission(actor.canWrite);
      requireEvidence(command.evidence);
      if (!["DOING", "CHANGES_REQUESTED"].includes(state.stage)) throw new AppError("VALIDACAO", "Informe a correção durante a execução ou ajustes");
      const finding = getFinding(state, command.findingId);
      if (finding.state === "validated" || finding.state === "waived") throw new AppError("CONFLITO", "Achado já resolvido");
      finding.state = "fix_reported";
      finding.fixEvidence = [...command.evidence];
      markExecutor(state, actor);
      break;
    }
    case "validate_finding": {
      requirePermission(actor.canReview);
      const review = currentReview(state, command.cycle);
      const finding = getFinding(state, command.findingId);
      if (finding.state !== "fix_reported") throw new AppError("VALIDACAO", "O achado precisa de correção informada antes da validação");
      if (state.executorIds.includes(actor.userId)) throw new AppError("SEM_PERMISSAO", "O executor não pode validar a própria correção");
      finding.state = "validated";
      finding.validatedInCycle = review.cycle;
      finding.resolvedDeliveryRevision = state.deliveryRevision;
      break;
    }
    case "waive_finding": {
      requirePermission(actor.canReview);
      const review = currentReview(state, command.cycle);
      requireText(command.reason, "Justificativa da dispensa");
      const finding = getFinding(state, command.findingId);
      if (state.executorIds.includes(actor.userId)) throw new AppError("SEM_PERMISSAO", "O executor não pode dispensar achados da própria entrega");
      if (finding.state === "validated" || finding.state === "waived") throw new AppError("CONFLITO", "Achado já resolvido");
      finding.state = "waived";
      finding.validatedInCycle = review.cycle;
      finding.resolvedDeliveryRevision = state.deliveryRevision;
      finding.waiverReason = command.reason;
      break;
    }
    case "request_changes": {
      requirePermission(actor.canReview);
      const review = currentReview(state, command.cycle);
      requireText(command.reason, "Justificativa da revisão");
      review.decision = "changes_requested";
      review.decidedBy = actor.userId;
      review.decidedAt = at;
      review.reason = command.reason;
      state.stage = "CHANGES_REQUESTED";
      break;
    }
    case "approve_review": {
      requirePermission(actor.canApprove);
      if (actor.channel !== "WEB") throw new AppError("SEM_PERMISSAO", "Aceite humano exige ação no painel");
      const review = currentReview(state, command.cycle);
      if (state.executorIds.includes(actor.userId)) throw new AppError("SEM_PERMISSAO", "O executor não pode aprovar a própria entrega");
      if (state.findings.some((finding) => finding.blocking &&
        (!(finding.state === "validated" || finding.state === "waived") || finding.resolvedDeliveryRevision !== state.deliveryRevision))) {
        throw new AppError("VALIDACAO", "Existem achados impeditivos não resolvidos");
      }
      if (review.checks.some((check) => check.required && check.status !== "passed")) {
        throw new AppError("VALIDACAO", "As verificações obrigatórias precisam passar");
      }
      review.decision = "approved";
      review.decidedBy = actor.userId;
      review.decidedAt = at;
      state.stage = "DONE";
      break;
    }
    default: {
      const exhaustive: never = command;
      throw new AppError("VALIDACAO", `Comando de workflow desconhecido: ${String(exhaustive)}`);
    }
  }
  state.version += 1;
  return { state, event: {
    taskId: state.taskId, orgId: state.orgId, actorId: actor.userId, channel: actor.channel,
    type: command.type, version: state.version, deliveryRevision: state.deliveryRevision, createdAt: at, command: structuredClone(command),
  } };
}
