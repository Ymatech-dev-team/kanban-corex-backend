-- 006 — Hierarquia de Projetos: nível Engagement (Projeto) entre Cliente(projects) e Tarefa(tasks).
-- Idempotente. Sem PL/pgSQL (runner do Neon). JP roda manual: dev → validar → prod.
--
-- PRÉ-CHECK (rode ANTES; deve retornar 0 — se >0, há task órfã e o passo 5/FK falha):
--   SELECT count(*) FROM tasks t
--   WHERE NOT EXISTS (SELECT 1 FROM projects p WHERE p.id = t."projectId" AND p."orgId" = t."orgId");

BEGIN;

-- 1) tabela engagements (Projeto)
CREATE TABLE IF NOT EXISTS engagements (
  id                TEXT PRIMARY KEY,
  "orgId"           TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  "createdById"     TEXT NOT NULL,
  "deletionBatchId" TEXT,
  "deletedAt"       TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
-- unique (id, projectId, orgId) habilita a FK tripla de tasks
ALTER TABLE engagements DROP CONSTRAINT IF EXISTS engagements_id_proj_org_uniq;
ALTER TABLE engagements ADD CONSTRAINT engagements_id_proj_org_uniq UNIQUE (id, "projectId", "orgId");
ALTER TABLE engagements DROP CONSTRAINT IF EXISTS engagements_project_org_fk;
ALTER TABLE engagements ADD CONSTRAINT engagements_project_org_fk
  FOREIGN KEY ("projectId", "orgId") REFERENCES projects (id, "orgId");
CREATE INDEX IF NOT EXISTS engagements_project_idx ON engagements ("projectId");
CREATE INDEX IF NOT EXISTS engagements_org_idx ON engagements ("orgId");

-- 2) coluna engagementId em tasks (nullable ANTES do backfill)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "engagementId" TEXT;

-- 3) "Projeto geral" por cliente (id determinístico → idempotente).
--    Herda deletedAt/deletionBatchId do cliente para não travar purge de cliente soft-deletado.
INSERT INTO engagements
  (id, "orgId", "projectId", name, "createdById", "deletionBatchId", "deletedAt", "createdAt", "updatedAt")
SELECT 'gen-'||p.id, p."orgId", p.id, 'Projeto geral', p."createdById",
       p."deletionBatchId", p."deletedAt", now(), now()
FROM projects p
WHERE NOT EXISTS (SELECT 1 FROM engagements e WHERE e.id = 'gen-'||p.id);

-- 4) re-parent das tarefas (só as ainda não migradas)
UPDATE tasks SET "engagementId" = 'gen-'||"projectId" WHERE "engagementId" IS NULL;

-- 5) FK composta tripla (depois do backfill) + NOT NULL
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_engagement_fk;
ALTER TABLE tasks ADD CONSTRAINT tasks_engagement_fk
  FOREIGN KEY ("engagementId", "projectId", "orgId")
  REFERENCES engagements (id, "projectId", "orgId");
ALTER TABLE tasks ALTER COLUMN "engagementId" SET NOT NULL;

-- 6) índice do novo caminho quente do board (mantém tasks(projectId,status,position) p/ roll-up de custo)
CREATE INDEX IF NOT EXISTS tasks_engagement_status_pos_idx ON tasks ("engagementId", status, position);

-- 7) tabela de consultores (participação)
CREATE TABLE IF NOT EXISTS engagement_members (
  "engagementId" TEXT NOT NULL,
  "userId"       TEXT NOT NULL,
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("engagementId", "userId")
);
ALTER TABLE engagement_members DROP CONSTRAINT IF EXISTS engagement_members_engagement_fk;
ALTER TABLE engagement_members ADD CONSTRAINT engagement_members_engagement_fk
  FOREIGN KEY ("engagementId") REFERENCES engagements (id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS engagement_members_user_idx ON engagement_members ("userId");

COMMIT;

-- VERIFICAÇÃO (esperado: 0):
--   SELECT count(*) FROM tasks WHERE "engagementId" IS NULL;
