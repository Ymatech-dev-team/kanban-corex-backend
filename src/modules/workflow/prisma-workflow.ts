import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { AppError } from "../../lib/errors.js";
import { applyWorkflowCommand, createWorkflow } from "./workflow.js";
import { commandSchema, executeSchema, initSchema, createManagedTaskSchema, workflowStateSchema, requestActionSchema, resolveActionSchema, type ExecuteWorkflowInput, type InitializeWorkflowInput } from "./schemas.js";
import type { WorkflowActor, WorkflowState } from "./types.js";
import type { ActionCursor, WorkflowAction, WorkflowStore, RequestActionInput, ResolveActionInput, CreateManagedTaskInput } from "./persistence.js";

type Tx = Prisma.TransactionClient;
type TaskRow = { id: string; status: string; projectId: string };
type Operation = { commandDigest: string; result: { state: unknown } };

/** JSON identity independent of object key ordering; only validated JSON inputs. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export const operationDigest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");

export class PrismaWorkflowStore implements WorkflowStore {
  constructor(private readonly db: PrismaClient) {}

  async createManagedTask(actor: WorkflowActor, raw: CreateManagedTaskInput): Promise<WorkflowState> {
    if (!actor.canCreate) throw new AppError("SEM_PERMISSAO", "Sem permissão para criar tarefas");
    const input = createManagedTaskSchema.parse(raw);
    const { operationId: _operationId, ...payload } = input;
    const digest = operationDigest({ tool: "create_managed_task", input: payload });
    return this.db.$transaction(async (tx) => {
      const parents = await tx.$queryRaw<Array<{ id: string }>>`SELECT e.id FROM engagements e JOIN projects p ON p.id=e."projectId" AND p."orgId"=e."orgId" WHERE e.id=${input.engagementId} AND e."projectId"=${input.projectId} AND e."orgId"=${actor.orgId} AND e."deletedAt" IS NULL AND p."deletedAt" IS NULL FOR SHARE OF e,p`;
      if (!parents[0]) throw new AppError("NAO_ENCONTRADO", "Projeto não encontrado neste cliente");
      const target = { id: "", status: "TODO", projectId: input.projectId };
      await this.assertResponsible(tx, actor, target, actor.userId);
      const previous = await this.replay(tx, actor, input.operationId, digest);
      if (previous) return previous;
      await this.assertResponsible(tx, actor, target, input.responsibleId);
      if (input.externalReference) {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId}),hashtext(${`external-reference:${input.externalReference}`}))::text AS locked`;
        const existing = await tx.$queryRaw<Array<{ taskId: string }>>`SELECT "taskId" FROM task_workflows WHERE "orgId"=${actor.orgId} AND "externalReference"=${input.externalReference}`;
        if (existing[0]) throw new AppError("CONFLITO", "Já existe uma tarefa para esta referência externa; consulte o plano existente");
      }
      const taskId = randomUUID();
      const positions = await tx.$queryRaw<Array<{ position: number }>>`SELECT COALESCE(MAX(position),0)+1024 AS position FROM tasks WHERE "orgId"=${actor.orgId} AND "engagementId"=${input.engagementId} AND status='TODO' AND "deletedAt" IS NULL`;
      await tx.$executeRaw`INSERT INTO tasks (id,"orgId","projectId","engagementId",title,description,status,priority,"assigneeId",position,"createdById","createdAt","updatedAt") VALUES (${taskId},${actor.orgId},${input.projectId},${input.engagementId},${input.title},${input.context},'TODO','MEDIUM',${input.responsibleId},${positions[0]?.position ?? 1024},${actor.userId},now(),now())`;
      const state = workflowStateSchema.parse({ ...createWorkflow({ taskId, orgId: actor.orgId, responsibleId: input.responsibleId, criteria: input.criteria, context: input.context }), version: 1 });
      await tx.$executeRaw`INSERT INTO task_workflows ("taskId","orgId",stage,version,"deliveryRevision",aggregate,"externalReference") VALUES (${taskId},${actor.orgId},${state.stage},${state.version},${state.deliveryRevision},${JSON.stringify(state)}::jsonb,${input.externalReference ?? null})`;
      await this.commitEvent(tx, actor, input.operationId, digest, "create_managed_task", 0, state, { input: payload });
      return state;
    });
  }

  async requestAction(actor: WorkflowActor, taskId: string, raw: RequestActionInput): Promise<WorkflowAction> {
    if (!actor.canWrite) throw new AppError("SEM_PERMISSAO", "Sem permissão para solicitar ação");
    const input = requestActionSchema.parse(raw);
    const { operationId: _operationId, ...payload } = input;
    const digest = operationDigest({ taskId, tool: "request_action", input: payload });
    return this.db.$transaction(async (tx) => {
      const task = await this.lockTask(tx, actor.orgId, taskId);
      const previous = await this.replayAction(tx, actor, input.operationId, digest);
      if (previous) return previous;
      const state = await this.loadLocked(tx, actor.orgId, taskId);
      if (state.version !== input.expectedVersion) throw new AppError("CONFLITO", "A versão da tarefa mudou");
      if (state.stage === "DONE") throw new AppError("CONFLITO", "Reabra a tarefa antes de solicitar ação");
      await this.assertResponsible(tx, actor, task, input.recipientId);
      const rows = await tx.$queryRaw<WorkflowAction[]>`INSERT INTO task_action_requests (id,"taskId","orgId","recipientId","createdById",kind,question,options) VALUES (${randomUUID()},${taskId},${actor.orgId},${input.recipientId},${actor.userId},${input.kind},${input.question},${JSON.stringify(input.options)}::jsonb) RETURNING id,"taskId","orgId","recipientId",kind,state,question,options,response,version,"createdAt"`;
      const action = rows[0];
      const previousVersion = state.version;
      state.version += 1;
      await this.saveAggregate(tx, state, previousVersion);
      await this.commitEvent(tx, actor, input.operationId, digest, "request_action", previousVersion, state, { action }, { action });
      return action;
    });
  }
  async resolveAction(actor: WorkflowActor, taskId: string, actionId: string, raw: ResolveActionInput): Promise<WorkflowAction> {
    const input = resolveActionSchema.parse(raw);
    const { operationId: _operationId, ...payload } = input;
    const digest = operationDigest({ taskId, actionId, tool: "resolve_action", input: payload });
    return this.db.$transaction(async (tx) => {
      await this.lockTask(tx, actor.orgId, taskId);
      const rows = await tx.$queryRaw<Array<WorkflowAction & { createdById: string }>>`SELECT id,"taskId","orgId","recipientId","createdById",kind,state,question,version,"createdAt" FROM task_action_requests WHERE id=${actionId} AND "taskId"=${taskId} AND "orgId"=${actor.orgId} FOR UPDATE`;
      const current = rows[0];
      if (!current) throw new AppError("NAO_ENCONTRADO", "Solicitação não encontrada");
      if (input.resolution === "RESOLVED" ? current.recipientId !== actor.userId : current.createdById !== actor.userId && !actor.canApprove) throw new AppError("SEM_PERMISSAO", "Sem permissão para responder esta solicitação");
      if (actor.channel !== "WEB") throw new AppError("SEM_PERMISSAO", "Resposta humana deve ser registrada no painel");
      const previous = await this.replayAction(tx, actor, input.operationId, digest);
      if (previous) return previous;
      if (current.state !== "OPEN" || current.version !== input.expectedVersion) throw new AppError("CONFLITO", "A solicitação foi alterada ou encerrada");
      if (current.kind === "REVIEW") throw new AppError("VALIDACAO", "Use a decisão de revisão para resolver esta solicitação");
      const state = await this.loadLocked(tx, actor.orgId, taskId);
      const updated = await tx.$queryRaw<WorkflowAction[]>`UPDATE task_action_requests SET state=${input.resolution},response=${input.response},"resolvedById"=${actor.userId},"resolvedAt"=now(),"updatedAt"=now(),version=version+1 WHERE id=${actionId} AND "taskId"=${taskId} AND "orgId"=${actor.orgId} AND version=${input.expectedVersion} AND state='OPEN' RETURNING id,"taskId","orgId","recipientId",kind,state,question,options,response,version,"createdAt"`;
      if (!updated[0]) throw new AppError("CONFLITO", "A solicitação mudou");
      const previousVersion = state.version;
      state.version += 1;
      await this.saveAggregate(tx, state, previousVersion);
      await this.commitEvent(tx, actor, input.operationId, digest, "resolve_action", previousVersion, state, { action: updated[0], response: input.response }, { action: updated[0] });
      return updated[0];
    });
  }

  private async loadLocked(tx: Tx, orgId: string, taskId: string): Promise<WorkflowState> {
    const rows = await tx.$queryRaw<Array<{ aggregate: unknown }>>`SELECT aggregate FROM task_workflows WHERE "taskId"=${taskId} AND "orgId"=${orgId} FOR UPDATE`;
    if (!rows[0]) throw new AppError("NAO_ENCONTRADO", "Fluxo ainda não ativado");
    return workflowStateSchema.parse(rows[0].aggregate);
  }

  private async saveAggregate(tx: Tx, raw: WorkflowState, previousVersion: number) {
    const state = workflowStateSchema.parse(raw);
    const changed = await tx.$executeRaw`UPDATE task_workflows SET stage=${state.stage},version=${state.version},"deliveryRevision"=${state.deliveryRevision},aggregate=${JSON.stringify(state)}::jsonb,"updatedAt"=now() WHERE "taskId"=${state.taskId} AND "orgId"=${state.orgId} AND version=${previousVersion}`;
    if (changed !== 1) throw new AppError("CONFLITO", "A versão da tarefa mudou");
  }

  private async replayAction(tx: Tx, actor: WorkflowActor, operationId: string, digest: string): Promise<WorkflowAction | null> {
    const connection = this.connection(actor);
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId}), hashtext(${`${connection}:${operationId}`}))::text AS locked`;
    const rows = await tx.$queryRaw<Array<{ commandDigest: string; result: { action?: WorkflowAction } }>>`SELECT "commandDigest",result FROM workflow_operations WHERE "orgId"=${actor.orgId} AND "connectionId"=${connection} AND "operationId"=${operationId}`;
    if (!rows[0]) return null;
    if (rows[0].commandDigest !== digest || !rows[0].result.action) throw new AppError("CONFLITO", "Identificador de operação já utilizado com outro conteúdo");
    return rows[0].result.action;
  }

  async load(orgId: string, taskId: string): Promise<WorkflowState | null> {
    const rows = await this.db.$queryRaw<Array<{ aggregate: unknown }>>`SELECT aggregate FROM task_workflows WHERE "orgId"=${orgId} AND "taskId"=${taskId}`;
    return rows[0] ? workflowStateSchema.parse(rows[0].aggregate) : null;
  }

  async events(orgId: string, taskId: string, beforeVersion?: number, limit = 51): Promise<unknown[]> {
    return this.db.$queryRaw(Prisma.sql`SELECT id, "actorId", channel, type, version, "deliveryRevision", payload, "createdAt" FROM workflow_events WHERE "orgId"=${orgId} AND "taskId"=${taskId} ${beforeVersion === undefined ? Prisma.empty : Prisma.sql`AND version < ${beforeVersion}`} ORDER BY version DESC LIMIT ${limit}`);
  }

  async actions(orgId: string, taskId: string): Promise<WorkflowAction[]> {
    return this.db.$queryRaw`SELECT id,"taskId","orgId","recipientId",kind,state,question,options,response,version,"createdAt" FROM task_action_requests WHERE "orgId"=${orgId} AND "taskId"=${taskId} AND state='OPEN' ORDER BY "createdAt",id LIMIT 100`;
  }

  async listActions(orgId: string, recipientId: string, before?: ActionCursor, limit = 51): Promise<WorkflowAction[]> {
    return this.db.$queryRaw(Prisma.sql`SELECT a.id,a."taskId",a."orgId",a."recipientId",a.kind,a.state,a.question,a.options,a.response,a.version,a."createdAt" FROM task_action_requests a JOIN tasks t ON t.id=a."taskId" AND t."orgId"=a."orgId" JOIN projects p ON p.id=t."projectId" AND p."orgId"=t."orgId" JOIN engagements e ON e.id=t."engagementId" JOIN users u ON u.id=a."recipientId" AND u."orgId"=a."orgId" LEFT JOIN roles r ON r.id=u."roleId" AND r."orgId"=u."orgId" WHERE a."orgId"=${orgId} AND a."recipientId"=${recipientId} AND a.state='OPEN' AND t."deletedAt" IS NULL AND p."deletedAt" IS NULL AND e."deletedAt" IS NULL AND u."deletedAt" IS NULL AND ('projetos.acessar_todos'=ANY(u."extraPermissions") OR 'projetos.acessar_todos'=ANY(r.permissions) OR EXISTS(SELECT 1 FROM project_members m WHERE m."projectId"=t."projectId" AND m."userId"=u.id)) ${before ? Prisma.sql`AND (a."createdAt",a.id) < (${new Date(before.createdAt)},${before.id})` : Prisma.empty} ORDER BY a."createdAt" DESC,a.id DESC LIMIT ${limit}`);
  }

  private async lockTask(tx: Tx, orgId: string, taskId: string): Promise<TaskRow> {
    const tasks = await tx.$queryRaw<TaskRow[]>`SELECT t.id,t.status,t."projectId" FROM tasks t JOIN projects p ON p.id=t."projectId" AND p."orgId"=t."orgId" JOIN engagements e ON e.id=t."engagementId" WHERE t.id=${taskId} AND t."orgId"=${orgId} AND t."deletedAt" IS NULL AND p."deletedAt" IS NULL AND e."deletedAt" IS NULL FOR UPDATE OF t`;
    if (!tasks[0]) throw new AppError("NAO_ENCONTRADO", "Tarefa não encontrada");
    return tasks[0];
  }

  private async assertResponsible(tx: Tx, actor: WorkflowActor, task: TaskRow, userId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT u.id FROM users u LEFT JOIN roles r ON r.id=u."roleId" AND r."orgId"=u."orgId" WHERE u.id=${userId} AND u."orgId"=${actor.orgId} AND u."deletedAt" IS NULL AND ('projetos.acessar_todos'=ANY(u."extraPermissions") OR 'projetos.acessar_todos'=ANY(r.permissions) OR EXISTS(SELECT 1 FROM project_members m WHERE m."projectId"=${task.projectId} AND m."userId"=u.id)) LIMIT 1`;
    if (!rows.length) throw new AppError("VALIDACAO", "O responsável precisa estar ativo e ter acesso ao cliente");
  }

  private connection(actor: WorkflowActor): string {
    if (actor.channel === "WEB") return `web:${actor.userId}`;
    if (!actor.connectionId) throw new AppError("SEM_PERMISSAO", "Conexão autenticada da integração ausente");
    return `${actor.channel.toLowerCase()}:${actor.userId}:${operationDigest(actor.connectionId)}`;
  }

  private async replay(tx: Tx, actor: WorkflowActor, operationId: string, digest: string): Promise<WorkflowState | null> {
    const connection = this.connection(actor);
    // Serialize the operation key across different task rows too. Hash collisions only
    // over-serialize unrelated operations; uniqueness/digest checks remain authoritative.
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${actor.orgId}), hashtext(${`${connection}:${operationId}`}))::text AS locked`;
    const rows = await tx.$queryRaw<Operation[]>`SELECT "commandDigest",result FROM workflow_operations WHERE "orgId"=${actor.orgId} AND "connectionId"=${connection} AND "operationId"=${operationId}`;
    if (!rows[0]) return null;
    if (rows[0].commandDigest !== digest) throw new AppError("CONFLITO", "Identificador de operação já utilizado com outro conteúdo");
    return workflowStateSchema.parse(rows[0].result.state);
  }

  private async commitEvent(tx: Tx, actor: WorkflowActor, operationId: string, digest: string, type: string, previousVersion: number, state: WorkflowState, payload: unknown, extraResult: Record<string, unknown> = {}) {
    const connection = this.connection(actor);
    const eventId = randomUUID();
    await tx.$executeRaw`INSERT INTO workflow_events (id,"taskId","orgId","actorId",channel,"connectionId","operationId",type,version,"deliveryRevision",payload) VALUES (${eventId},${state.taskId},${state.orgId},${actor.userId},${actor.channel},${connection},${operationId},${type},${state.version},${state.deliveryRevision},${JSON.stringify(payload)}::jsonb)`;
    await tx.$executeRaw`INSERT INTO workflow_operations ("orgId","connectionId","operationId","taskId",tool,"commandDigest","expectedVersion","resultVersion","eventId",result) VALUES (${state.orgId},${connection},${operationId},${state.taskId},${type},${digest},${previousVersion},${state.version},${eventId},${JSON.stringify({ state, ...extraResult })}::jsonb)`;
    await tx.$executeRaw`INSERT INTO workflow_outbox ("orgId","eventId") VALUES (${state.orgId},${eventId})`;
  }

  async initialize(actor: WorkflowActor, taskId: string, raw: InitializeWorkflowInput): Promise<WorkflowState> {
    if (!actor.canWrite) throw new AppError("SEM_PERMISSAO", "Sem permissão para ativar o fluxo");
    const input = initSchema.parse(raw);
    const plan = { responsibleId: input.responsibleId, criteria: input.criteria, context: input.context };
    const digest = operationDigest({ taskId, tool: "initialize", plan });
    return this.db.$transaction(async (tx) => {
      const task = await this.lockTask(tx, actor.orgId, taskId);
      const replay = await this.replay(tx, actor, input.operationId, digest);
      if (replay) return replay;
      const existing = await tx.$queryRaw<Array<{ aggregate: unknown }>>`SELECT aggregate FROM task_workflows WHERE "taskId"=${taskId} AND "orgId"=${actor.orgId} FOR UPDATE`;
      if (existing[0]) {
        throw new AppError("CONFLITO", "O fluxo já foi ativado; use a operação original para repetir a solicitação");
      }
      if (task.status === "DONE") throw new AppError("CONFLITO", "Reabra a tarefa concluída antes de ativar o fluxo");
      await this.assertResponsible(tx, actor, task, input.responsibleId);
      const state = createWorkflow({ taskId, orgId: actor.orgId, ...plan });
      state.version = 1;
      if (task.status === "DOING") { state.stage = "DOING"; state.executorIds = [input.responsibleId]; }
      const validated = workflowStateSchema.parse(state);
      await tx.$executeRaw`INSERT INTO task_workflows ("taskId","orgId",stage,version,"deliveryRevision",aggregate) VALUES (${taskId},${actor.orgId},${state.stage},${state.version},${state.deliveryRevision},${JSON.stringify(validated)}::jsonb)`;
      await this.commitEvent(tx, actor, input.operationId, digest, "initialize", 0, validated, { input: plan });
      return validated;
    });
  }

  async execute(actor: WorkflowActor, taskId: string, raw: ExecuteWorkflowInput): Promise<WorkflowState> {
    const input = executeSchema.parse(raw);
    const command = commandSchema.parse(input.command);
    const digest = operationDigest({ taskId, tool: command.type, expectedVersion: input.expectedVersion, command });
    return this.db.$transaction(async (tx) => {
      const task = await this.lockTask(tx, actor.orgId, taskId);
      // Authorize the action before returning an old result, not just the project.
      const reviewAction = ["record_finding", "validate_finding", "waive_finding", "request_changes"].includes(command.type);
      if (!(command.type === "approve_review" ? actor.canApprove : reviewAction ? actor.canReview : actor.canWrite)) throw new AppError("SEM_PERMISSAO", "Sem permissão para a operação");
      const replay = await this.replay(tx, actor, input.operationId, digest);
      if (replay) return replay;
      const rows = await tx.$queryRaw<Array<{ aggregate: unknown }>>`SELECT aggregate FROM task_workflows WHERE "taskId"=${taskId} AND "orgId"=${actor.orgId} FOR UPDATE`;
      if (!rows[0]) throw new AppError("NAO_ENCONTRADO", "Fluxo ainda não ativado");
      if (command.type === "record_finding") await this.assertResponsible(tx, actor, task, command.responsibleId);
      if (command.type === "submit_review") {
        if (!command.reviewerId) throw new AppError("VALIDACAO", "Escolha explicitamente quem deve revisar a entrega");
        await this.assertResponsible(tx, actor, task, command.reviewerId);
        const reviewers = await tx.$queryRaw<Array<{ id: string }>>`SELECT u.id FROM users u LEFT JOIN roles r ON r.id=u."roleId" AND r."orgId"=u."orgId" WHERE u.id=${command.reviewerId} AND u."orgId"=${actor.orgId} AND u."deletedAt" IS NULL AND (u."extraPermissions" && ARRAY['tarefas.revisar','tarefas.aprovar']::text[] OR r.permissions && ARRAY['tarefas.revisar','tarefas.aprovar']::text[])`;
        if (!reviewers.length) throw new AppError("VALIDACAO", "O revisor precisa de permissão de revisão ou aprovação");
        if (workflowStateSchema.parse(rows[0].aggregate).executorIds.includes(command.reviewerId)) throw new AppError("VALIDACAO", "Escolha um revisor diferente dos executores humanos");
        for (const name of ["typecheck", "lint", "test", "build"]) {
          if (!command.checks.some((check) => check.name === name && check.required)) throw new AppError("VALIDACAO", `Informe a verificação obrigatória ${name}`);
        }
      }
      const result = applyWorkflowCommand(workflowStateSchema.parse(rows[0].aggregate), actor, command, input.expectedVersion, new Date().toISOString());
      const state = workflowStateSchema.parse(result.state);
      const updated = await tx.$executeRaw`UPDATE task_workflows SET stage=${state.stage},version=${state.version},"deliveryRevision"=${state.deliveryRevision},aggregate=${JSON.stringify(state)}::jsonb,"updatedAt"=now() WHERE "taskId"=${taskId} AND "orgId"=${actor.orgId} AND version=${input.expectedVersion}`;
      if (updated !== 1) throw new AppError("CONFLITO", "A versão da tarefa mudou");
      const status = state.stage === "DONE" ? "DONE" : ["DOING", "IN_REVIEW", "CHANGES_REQUESTED"].includes(state.stage) ? "DOING" : "TODO";
      await tx.$executeRaw`UPDATE tasks SET status=${status},"updatedAt"=now() WHERE id=${taskId} AND "orgId"=${actor.orgId}`;
      if (["submit_review", "approve_review", "request_changes", "change_delivery"].includes(command.type)) {
        const resolution = command.type === "approve_review" || command.type === "request_changes" ? "RESOLVED" : "CANCELLED";
        const reason = command.type === "approve_review" ? "Entrega aprovada" : command.type === "request_changes" ? command.reason : "Substituída por nova versão ou revisão";
        await tx.$executeRaw`UPDATE task_action_requests SET state=${resolution},response=${reason},"resolvedById"=${actor.userId},"resolvedAt"=now(),"updatedAt"=now(),version=version+1 WHERE "taskId"=${taskId} AND "orgId"=${actor.orgId} AND kind='REVIEW' AND state='OPEN'`;
      }
      if (command.type === "submit_review") {
        await tx.$executeRaw`INSERT INTO task_action_requests (id,"taskId","orgId","recipientId","createdById",kind,question) VALUES (${randomUUID()},${taskId},${actor.orgId},${command.reviewerId!},${actor.userId},'REVIEW',${`Revisar entrega — ciclo ${state.reviews.at(-1)!.cycle}: ${command.summary}`.slice(0, 8000)})`;
      }
      await this.commitEvent(tx, actor, input.operationId, digest, command.type, input.expectedVersion, state, result.event);
      return state;
    });
  }
}
