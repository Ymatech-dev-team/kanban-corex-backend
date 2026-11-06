-- 018 — Persistência aditiva para workflow, revisão e fila de ações.
-- PREPARADO, NÃO APLICADO. Requer 008 (tasks_id_org_uniq) e 016 (ledger).
-- Não ativa novas etapas, não modifica tasks.status e não altera dados existentes.
-- Verificação: docs/workflow/018-verification.sql. Desenho: docs/workflow/persistence.md.
BEGIN;

-- FK composta evita vincular destinatário/ator de outra organização.
CREATE UNIQUE INDEX IF NOT EXISTS users_id_org_workflow_uidx ON users (id, "orgId");

CREATE TABLE IF NOT EXISTS task_workflows (
  "taskId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  stage TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 0,
  "deliveryRevision" INTEGER NOT NULL DEFAULT 1,
  aggregate JSONB NOT NULL,
  "externalReference" TEXT,
  CONSTRAINT task_workflows_external_reference_check CHECK ("externalReference" IS NULL OR length("externalReference") BETWEEN 1 AND 512),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("taskId", "orgId"),
  CONSTRAINT task_workflows_task_org_fk FOREIGN KEY ("taskId", "orgId") REFERENCES tasks (id, "orgId") ON DELETE RESTRICT,
  CONSTRAINT task_workflows_stage_check CHECK (stage IN ('BACKLOG', 'PLANNING', 'READY', 'DOING', 'IN_REVIEW', 'CHANGES_REQUESTED', 'DONE')),
  CONSTRAINT task_workflows_version_check CHECK (version >= 0 AND "deliveryRevision" >= 1),
  -- CHECK não aceita apenas comparações nullable: presença e tipos são explícitos.
  CONSTRAINT task_workflows_aggregate_check CHECK (
    jsonb_typeof(aggregate) = 'object'
    AND aggregate ?& ARRAY['taskId','orgId','stage','version','deliveryRevision','responsibleId','criteria','context','executorIds','reviews','findings']
    AND jsonb_typeof(aggregate->'taskId') = 'string'
    AND jsonb_typeof(aggregate->'orgId') = 'string'
    AND jsonb_typeof(aggregate->'stage') = 'string'
    AND jsonb_typeof(aggregate->'version') = 'number'
    AND jsonb_typeof(aggregate->'deliveryRevision') = 'number'
    AND jsonb_typeof(aggregate->'responsibleId') = 'string'
    AND jsonb_typeof(aggregate->'context') = 'string'
    AND jsonb_typeof(aggregate->'criteria') = 'array'
    AND jsonb_typeof(aggregate->'executorIds') = 'array'
    AND jsonb_typeof(aggregate->'reviews') = 'array'
    AND jsonb_typeof(aggregate->'findings') = 'array'
    AND aggregate->>'taskId' = "taskId"
    AND aggregate->>'orgId' = "orgId"
    AND aggregate->>'stage' = stage
    AND aggregate->>'version' = version::text
    AND aggregate->>'deliveryRevision' = "deliveryRevision"::text
  ),
  CONSTRAINT task_workflows_size_check CHECK (octet_length(aggregate::text) <= 1048576)
);
CREATE UNIQUE INDEX IF NOT EXISTS task_workflows_external_reference_uidx ON task_workflows ("orgId", "externalReference") WHERE "externalReference" IS NOT NULL;
CREATE INDEX IF NOT EXISTS task_workflows_org_stage_idx ON task_workflows ("orgId", stage, "updatedAt" DESC, "taskId");

CREATE TABLE IF NOT EXISTS workflow_events (
  id TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  channel TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  type TEXT NOT NULL,
  version INTEGER NOT NULL,
  "deliveryRevision" INTEGER NOT NULL,
  payload JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  CONSTRAINT workflow_events_task_org_fk FOREIGN KEY ("taskId", "orgId") REFERENCES task_workflows ("taskId", "orgId") ON DELETE RESTRICT,
  CONSTRAINT workflow_events_actor_org_fk FOREIGN KEY ("actorId", "orgId") REFERENCES users (id, "orgId") ON DELETE RESTRICT,
  CONSTRAINT workflow_events_task_version_uniq UNIQUE ("taskId", "orgId", version),
  CONSTRAINT workflow_events_id_org_uniq UNIQUE (id, "orgId"),
  CONSTRAINT workflow_events_identity_version_uniq UNIQUE (id, "taskId", "orgId", version),
  CONSTRAINT workflow_events_channel_check CHECK (channel IN ('WEB', 'MCP', 'LOCAL_SYNC')),
  CONSTRAINT workflow_events_version_check CHECK (version >= 1 AND "deliveryRevision" >= 1),
  CONSTRAINT workflow_events_type_check CHECK (length(type) BETWEEN 1 AND 128),
  CONSTRAINT workflow_events_identity_check CHECK (length("connectionId") BETWEEN 1 AND 256 AND length("operationId") BETWEEN 1 AND 256),
  CONSTRAINT workflow_events_payload_check CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 1048576)
);
CREATE INDEX IF NOT EXISTS workflow_events_feed_idx ON workflow_events ("orgId", "taskId", version DESC);

-- Append-only pelo contrato da aplicação. Restrição do papel de banco é etapa
-- explícita de implantação futura; não criar regras que ignorem UPDATE/DELETE.

CREATE TABLE IF NOT EXISTS workflow_operations (
  "orgId" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "operationId" TEXT NOT NULL,
  "taskId" TEXT NOT NULL,
  tool TEXT NOT NULL,
  "commandDigest" TEXT NOT NULL,
  "expectedVersion" INTEGER NOT NULL,
  "resultVersion" INTEGER NOT NULL,
  "eventId" TEXT NOT NULL,
  result JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("orgId", "connectionId", "operationId"),
  CONSTRAINT workflow_operations_task_org_fk FOREIGN KEY ("taskId", "orgId") REFERENCES task_workflows ("taskId", "orgId") ON DELETE RESTRICT,
  CONSTRAINT workflow_operations_event_version_fk FOREIGN KEY ("eventId", "taskId", "orgId", "resultVersion") REFERENCES workflow_events (id, "taskId", "orgId", version) ON DELETE RESTRICT,
  CONSTRAINT workflow_operations_identity_check CHECK (length("connectionId") BETWEEN 1 AND 256 AND length("operationId") BETWEEN 1 AND 256 AND length(tool) BETWEEN 1 AND 128),
  CONSTRAINT workflow_operations_digest_check CHECK ("commandDigest" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT workflow_operations_version_check CHECK ("expectedVersion" >= 0 AND "resultVersion" = "expectedVersion" + 1),
  CONSTRAINT workflow_operations_result_check CHECK (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 2097152)
);
CREATE INDEX IF NOT EXISTS workflow_operations_task_idx ON workflow_operations ("orgId", "taskId", "createdAt");

CREATE TABLE IF NOT EXISTS workflow_outbox (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "orgId" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "publishedAt" TIMESTAMP(3),
  "lockedUntil" TIMESTAMP(3),
  "lockedBy" TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT workflow_outbox_event_org_fk FOREIGN KEY ("eventId", "orgId") REFERENCES workflow_events (id, "orgId") ON DELETE RESTRICT,
  CONSTRAINT workflow_outbox_event_uniq UNIQUE ("eventId"),
  CONSTRAINT workflow_outbox_attempts_check CHECK (attempts >= 0),
  CONSTRAINT workflow_outbox_lock_check CHECK (("lockedUntil" IS NULL) = ("lockedBy" IS NULL))
);
CREATE INDEX IF NOT EXISTS workflow_outbox_pending_idx ON workflow_outbox (id) WHERE "publishedAt" IS NULL;

CREATE TABLE IF NOT EXISTS task_action_requests (
  id TEXT NOT NULL PRIMARY KEY,
  "taskId" TEXT NOT NULL,
  "orgId" TEXT NOT NULL,
  "recipientId" TEXT NOT NULL,
  "createdById" TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'OPEN',
  version INTEGER NOT NULL DEFAULT 0,
  question TEXT NOT NULL,
  options JSONB NOT NULL DEFAULT '[]'::jsonb,
  response TEXT,
  "resolvedById" TEXT,
  "dueAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "resolvedAt" TIMESTAMP(3),
  CONSTRAINT task_action_requests_task_org_fk FOREIGN KEY ("taskId", "orgId") REFERENCES task_workflows ("taskId", "orgId") ON DELETE RESTRICT,
  CONSTRAINT task_action_requests_recipient_org_fk FOREIGN KEY ("recipientId", "orgId") REFERENCES users (id, "orgId") ON DELETE RESTRICT,
  CONSTRAINT task_action_requests_creator_org_fk FOREIGN KEY ("createdById", "orgId") REFERENCES users (id, "orgId") ON DELETE RESTRICT,
  CONSTRAINT task_action_requests_resolver_org_fk FOREIGN KEY ("resolvedById", "orgId") REFERENCES users (id, "orgId") ON DELETE RESTRICT,
  CONSTRAINT task_action_requests_kind_check CHECK (kind IN ('CLARIFY_SCOPE', 'DECIDE', 'UNBLOCK', 'REVIEW')),
  CONSTRAINT task_action_requests_state_check CHECK (state IN ('OPEN', 'RESOLVED', 'CANCELLED')),
  CONSTRAINT task_action_requests_version_check CHECK (version >= 0),
  CONSTRAINT task_action_requests_question_check CHECK (length(btrim(question)) BETWEEN 1 AND 8000),
  CONSTRAINT task_action_requests_options_check CHECK (jsonb_typeof(options) = 'array' AND jsonb_array_length(options) <= 20 AND octet_length(options::text) <= 16000),
  CONSTRAINT task_action_requests_response_check CHECK (response IS NULL OR length(btrim(response)) BETWEEN 1 AND 8000),
  CONSTRAINT task_action_requests_resolution_check CHECK (
    (state = 'OPEN' AND "resolvedAt" IS NULL AND "resolvedById" IS NULL AND response IS NULL)
    OR (state IN ('RESOLVED', 'CANCELLED') AND "resolvedAt" IS NOT NULL AND "resolvedById" IS NOT NULL AND response IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS task_action_requests_inbox_idx ON task_action_requests ("orgId", "recipientId", "dueAt", "createdAt", id) WHERE state = 'OPEN';
CREATE INDEX IF NOT EXISTS task_action_requests_task_idx ON task_action_requests ("orgId", "taskId", "createdAt" DESC, id);

INSERT INTO schema_migrations (name) VALUES ('018_task_workflow') ON CONFLICT (name) DO NOTHING;
COMMIT;
