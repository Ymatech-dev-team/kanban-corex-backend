-- 008 — Detalhe da tarefa (Escopo A): responsáveis EXTRAS (multi-responsável).
-- O responsável PRINCIPAL continua em tasks.assigneeId (custo/card intactos). [detalhe-tarefa A1]
-- Idempotente. Sem PL/pgSQL (runner do Neon). JP roda manual: dev → validar → prod.
BEGIN;

-- Pré-requisito p/ a FK composta de tenant (task, org) das tabelas-filhas.
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_id_org_uniq;
ALTER TABLE tasks ADD CONSTRAINT tasks_id_org_uniq UNIQUE (id, "orgId");

CREATE TABLE IF NOT EXISTS task_assignees (
  "taskId"    TEXT NOT NULL,
  "userId"    TEXT NOT NULL,
  "orgId"     TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("taskId", "userId")
);

-- coerência de tenant garantida no banco: (task, org) tem de bater
ALTER TABLE task_assignees DROP CONSTRAINT IF EXISTS task_assignees_task_org_fk;
ALTER TABLE task_assignees ADD CONSTRAINT task_assignees_task_org_fk
  FOREIGN KEY ("taskId", "orgId") REFERENCES tasks (id, "orgId") ON DELETE CASCADE;
ALTER TABLE task_assignees DROP CONSTRAINT IF EXISTS task_assignees_user_fk;
ALTER TABLE task_assignees ADD CONSTRAINT task_assignees_user_fk
  FOREIGN KEY ("userId") REFERENCES users (id);

CREATE INDEX IF NOT EXISTS task_assignees_user_idx ON task_assignees ("userId");

COMMIT;

-- VERIFICAÇÃO (esperado: a tabela existe e não há linhas órfãs):
--   SELECT count(*) FROM task_assignees;
