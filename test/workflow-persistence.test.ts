import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { canonicalJson, operationDigest, PrismaWorkflowStore } from "../src/modules/workflow/prisma-workflow.js";
import { createWorkflow } from "../src/modules/workflow/workflow.js";
import type { WorkflowActor } from "../src/modules/workflow/types.js";

const actor: WorkflowActor = { orgId: "org", userId: "user", channel: "WEB", canWrite: true, canReview: false, canApprove: false, canReopen: false };
const input = { operationId: "op", expectedVersion: 0, command: { type: "transition" as const, to: "READY" as const } };
function database(options: { cas?: number; replay?: unknown; stage?: "BACKLOG" | "DOING"; failOutbox?: boolean } = {}) {
  const calls: string[] = [];
  const state = createWorkflow({ orgId: "org", taskId: "task", responsibleId: "user", criteria: ["works"], context: "plan" });
  state.stage = options.stage ?? "BACKLOG";
  const query = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?"); calls.push(sql);
    if (sql.includes("FOR UPDATE OF t")) return [{ id: "task", status: "TODO", projectId: "project" }];
    if (sql.includes("pg_advisory_xact_lock")) return [{ locked: "" }];
    if (sql.includes("FROM workflow_operations")) return options.replay ? [options.replay] : [];
    if (sql.includes("FROM task_workflows")) return [{ aggregate: state }];
    throw new Error(`Unexpected query ${sql}`);
  });
  const execute = vi.fn(async (strings: TemplateStringsArray) => {
    const sql = strings.join("?"); calls.push(sql);
    if (sql.startsWith("UPDATE task_workflows")) return options.cas ?? 1;
    if (sql.startsWith("INSERT INTO workflow_outbox") && options.failOutbox) throw new Error("outbox unavailable");
    return 1;
  });
  const transaction = vi.fn(async (callback) => callback({ $queryRaw: query, $executeRaw: execute }));
  return { store: new PrismaWorkflowStore({ $transaction: transaction } as unknown as PrismaClient), calls, execute, query, transaction, state };
}

describe("workflow persistence adapter (transaction mocked, not a database proof)", () => {
  it("canonical digest ignores property insertion order but binds target and version", () => {
    expect(canonicalJson({ b: 2, a: [1, "x"] })).toBe(canonicalJson({ a: [1, "x"], b: 2 }));
    expect(operationDigest({ taskId: "one", version: 1 })).not.toBe(operationDigest({ taskId: "two", version: 1 }));
    expect(operationDigest({ taskId: "one", version: 1 })).not.toBe(operationDigest({ taskId: "one", version: 2 }));
  });
  it("locks task before workflow and commits CAS/event/result/outbox in one transaction", async () => {
    const db = database();
    const result = await db.store.execute(actor, "task", input);
    expect(result.stage).toBe("READY");
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(db.calls[0]).toContain("FOR UPDATE OF t");
    expect(db.calls.findIndex((s) => s.includes("FROM task_workflows"))).toBeGreaterThan(0);
    expect(db.calls.some((s) => s.startsWith("INSERT INTO workflow_events"))).toBe(true);
    expect(db.calls.some((s) => s.startsWith("INSERT INTO workflow_operations"))).toBe(true);
    expect(db.calls.at(-1)).toContain("INSERT INTO workflow_outbox");
  });
  it("does not persist event/results after failed CAS", async () => {
    const db = database({ cas: 0 });
    await expect(db.store.execute(actor, "task", input)).rejects.toMatchObject({ code: "CONFLITO" });
    expect(db.calls.some((s) => s.startsWith("INSERT INTO"))).toBe(false);
  });
  it("replays a committed operation without mutating state again", async () => {
    const digest = operationDigest({ taskId: "task", tool: input.command.type, expectedVersion: 0, command: input.command });
    const db = database({ replay: { commandDigest: digest, result: { state: createWorkflow({ orgId: "org", taskId: "task", responsibleId: "user", criteria: ["works"], context: "plan" }) } } });
    await db.store.execute(actor, "task", input);
    expect(db.execute).not.toHaveBeenCalled();
  });
  it("rejects reused operation key with different content", async () => {
    const db = database({ replay: { commandDigest: "other", result: {} } });
    await expect(db.store.execute(actor, "task", input)).rejects.toMatchObject({ code: "CONFLITO" });
    expect(db.execute).not.toHaveBeenCalled();
  });
  it("checks current permissions before returning a replay", async () => {
    const db = database({ replay: { commandDigest: "any", result: {} } });
    await expect(db.store.execute({ ...actor, canWrite: false }, "task", input)).rejects.toMatchObject({ code: "SEM_PERMISSAO" });
    expect(db.calls.some((s) => s.includes("FROM workflow_operations"))).toBe(false);
  });
  it("does not claim success when outbox insertion fails", async () => {
    const db = database({ failOutbox: true });
    await expect(db.store.execute(actor, "task", input)).rejects.toThrow("outbox unavailable");
  });
  it("requires policy checks instead of accepting an omitted test list", async () => {
    const db = database({ stage: "DOING" });
    await expect(db.store.execute(actor, "task", { ...input, command: { type: "submit_review", summary: "done", evidence: ["PR"], checks: [] } })).rejects.toMatchObject({ code: "VALIDACAO" });
    expect(db.execute).not.toHaveBeenCalled();
  });
});

describe('agent review persistence routing',()=>{
 const agent={...actor,channel:'MCP' as const,connectionId:'grant',canReview:true,canApprove:true};
 const checks=['typecheck','lint','test','build'].map(name=>({name,status:'passed' as const,required:true}));
 function agentDb(){const db=database({stage:'DOING'});db.state.execution={id:'run',agent:'Codex',ownerId:'user',channel:'MCP',connectionId:'grant',status:'RUNNING',lastUpdatedAt:'2026-11-12T12:00:00.000Z'};return db;}
 it('submits AGENT atomically without user lookup or human request INSERT',async()=>{const db=agentDb();const out=await db.store.execute(agent,'task',{operationId:'submit',expectedVersion:0,command:{type:'submit_review',reviewMode:'AGENT',summary:'done',evidence:['log'],checks}});expect(out.reviews[0].reviewMode).toBe('AGENT');expect(db.calls.some(s=>s.startsWith('INSERT INTO task_action_requests'))).toBe(false);expect(db.calls.some(s=>s.includes('FROM users'))).toBe(false);expect(db.calls.some(s=>s.startsWith('INSERT INTO workflow_events'))).toBe(true);});
 it('rejects AGENT submission with a missing mandatory check before persistence',async()=>{const db=agentDb();await expect(db.store.execute(agent,'task',{operationId:'submit',expectedVersion:0,command:{type:'submit_review',reviewMode:'AGENT',summary:'done',evidence:['log'],checks:checks.slice(1)}})).rejects.toMatchObject({code:'VALIDACAO'});expect(db.execute).not.toHaveBeenCalled();});
 it('adopts only legacy review and cancels its human request with audited CAS',async()=>{const db=agentDb();db.state.stage='IN_REVIEW';db.state.reviews=[{cycle:1,deliveryRevision:1,submittedBy:'user',submittedAt:'2026-11-12T12:00:00.000Z',summary:'done',evidence:['log'],checks,decision:'pending'}];const out=await db.store.execute(agent,'task',{operationId:'adopt',expectedVersion:0,command:{type:'adopt_agent_review',cycle:1}});expect(out.reviews[0]).toMatchObject({reviewMode:'AGENT',decision:'pending',checks});expect(db.calls.some(s=>s.startsWith('UPDATE task_action_requests'))).toBe(true);expect(db.calls.some(s=>s.startsWith('INSERT INTO workflow_events'))).toBe(true);expect(db.calls.some(s=>s.startsWith('INSERT INTO task_action_requests'))).toBe(false);});
});
