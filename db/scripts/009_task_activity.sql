-- 009 — Detalhe da tarefa (Escopo B): linha do tempo (atividade automática).
-- Append-only, imutável, gerada pelo servidor. Idempotente. JP roda manual: dev → validar → prod.
-- Requer o 008 (tasks_id_org_uniq) já aplicado.
BEGIN;

CREATE TABLE IF NOT EXISTS task_activity (
  id          TEXT PRIMARY KEY,
  "taskId"    TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "actorId"   TEXT NOT NULL,
  "actorName" TEXT NOT NULL,
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  v           INTEGER NOT NULL DEFAULT 1,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);

ALTER TABLE task_activity DROP CONSTRAINT IF EXISTS task_activity_task_org_fk;
ALTER TABLE task_activity ADD CONSTRAINT task_activity_task_org_fk
  FOREIGN KEY ("taskId", "orgId") REFERENCES tasks (id, "orgId") ON DELETE CASCADE;

-- feed keyset (mais recente primeiro)
CREATE INDEX IF NOT EXISTS task_activity_feed_idx ON task_activity ("taskId", "createdAt" DESC, id);

COMMIT;

-- VERIFICAÇÃO (esperado: tabela criada e vazia):
--   SELECT count(*) FROM task_activity;
