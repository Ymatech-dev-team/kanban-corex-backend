# Workflow domain

Task workflow aggregate and opt-in HTTP persistence for the approved navigation/MCP plan, sections 5, 7 and 10.
The HTTP adapter is mounted only when a store is supplied and `WORKFLOW_ENABLED=true` (or an explicit test override). New tables require the separately reviewed 018 migration before enabling it. This module does not create an OAuth/MCP server.

## Integration boundary

1. Authenticate the request, resolve organization and project access, and calculate task-scoped capabilities. Construct `WorkflowActor` on the server; never accept its fields from request/tool arguments. The channel must originate from the authenticated adapter, not a caller-supplied header.
2. Parse commands against a strict runtime schema. Resolve referenced users and evidence inside the authorized organization. This core also validates important invariants but does not replace input schemas.
3. Check a durable idempotency record before applying a command, after reauthorization. A matching operation/digest returns the committed result; a different digest using the same operation ID is a conflict.
4. Load the aggregate and call `applyWorkflowCommand` with the caller's expected version and a server-generated timestamp.
5. Atomically compare/update the aggregate version, persist the event, write the outbox entry and save the operation result. Retry of a concurrent conflict must not overwrite human edits. `PrismaWorkflowStore` implements the transaction with parameterized raw SQL, locks the legacy task before the aggregate and serializes idempotency keys with a transaction advisory lock. No in-memory production store is provided.

Generic existing task mutation/move endpoints must call this same domain before enabling the new workflow. Patching status directly would bypass the review requirements. Updates to code delivery, scope or criteria must issue `change_delivery`; comments do not.

The responsible human remains distinct from the execution channel. Human executor identities accumulate across a delivery, preventing self-approval by an earlier human executor after handoff. MCP/LOCAL_SYNC sponsors are not human executors; their activity retains the authenticated channel in events. A human may approve an agent delivery sponsored by their own account, per the explicit user decision on 2026-11-06. Human acceptance requires the WEB channel and a task-scoped approval capability. MCP and local synchronization may supply technical findings but cannot grant human acceptance.

Check requirements and evidence provenance must be derived from project policy by the adapter. Do not let a model mark a required check optional. A `passed` status is reported evidence unless the adapter verified its source; the UI must preserve that distinction.

Review history stays immutable when a new delivery supersedes an approved review: approval remains historical but no longer authorizes completion. Current finding resolutions are invalidated for changed deliveries; every command is returned as an event for durable history.

`schemas.ts` validates commands and persisted snapshots. The opt-in template is initially a code-delivery workflow: submissions must include required `typecheck`, `lint`, `test` and `build` checks. Pending/failed checks can be submitted for review but block final approval. These are reported checks until verified separately; the UI must not claim execution proof merely from a reported status.

Routes: GET `/tasks/:id/workflow`, POST `/tasks/:id/workflow/init`, POST `/tasks/:id/workflow/commands`, GET `/tasks/actions/mine`. Initialization records version 1 and an initialize event/operation/outbox atomically; factory version 0 remains a pure pre-persistence state. Existing TODO tasks start at BACKLOG, DOING tasks keep DOING with their responsible human conservatively recorded as legacy executor, and DONE must be reopened before opting in. Only repeating the original initialization operation ID and payload replays the committed result. A different operation ID conflicts once the workflow exists, preventing a successful unreserved idempotency key.

New permissions `tarefas.revisar` and `tarefas.aprovar` are project-scoped and are not automatically granted. The HTTP adapter resolves capabilities per task. The integration actor accepts an authenticated connection identifier for future MCP use, but HTTP callers cannot inject actor/channel/capabilities fields.

Action requests have versioned creation and human response/cancellation endpoints. Review submission creates an explicit recipient request; approval or change request closes it in the same transaction. Reading never resolves an action. Execution start and progress reports record the authenticated owner/channel and a structured summary, without inferring activity from elapsed time. Real-time publishing remains separate integration work. The outbox rows do not imply a running publisher. Production activation requires SQL verification, transactional database tests and independent review; passing mock adapter tests is not database proof.
