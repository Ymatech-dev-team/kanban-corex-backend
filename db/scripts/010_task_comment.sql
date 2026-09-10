-- 010 — Detalhe da tarefa (Escopo C): comentários manuais na timeline.
-- Mutável (editar/excluir do autor ou moderador), soft-delete. Idempotente. JP roda: dev → validar → prod.
-- Requer o 008 (tasks_id_org_uniq) aplicado.
BEGIN;

CREATE TABLE IF NOT EXISTS task_comment (
  id           TEXT PRIMARY KEY,
  "taskId"     TEXT NOT NULL,
  "orgId"      TEXT NOT NULL,
  "authorId"   TEXT NOT NULL,
  "authorName" TEXT NOT NULL,
  body         TEXT NOT NULL,
  "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT now(),
  "editedAt"   TIMESTAMP(3),
  "deletedAt"  TIMESTAMP(3)
);

ALTER TABLE task_comment DROP CONSTRAINT IF EXISTS task_comment_task_org_fk;
ALTER TABLE task_comment ADD CONSTRAINT task_comment_task_org_fk
  FOREIGN KEY ("taskId", "orgId") REFERENCES tasks (id, "orgId") ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS task_comment_feed_idx ON task_comment ("taskId", "createdAt");

COMMIT;

-- VERIFICAÇÃO (esperado: tabela criada e vazia):
--   SELECT count(*) FROM task_comment;
