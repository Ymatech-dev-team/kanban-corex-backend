-- 014 — Anexos de tarefa (Vercel Blob). O arquivo mora no Blob; aqui só o registro/metadata.
-- Idempotente. JP roda manual: dev -> validar -> prod. Requer o 008 (tasks_id_org_uniq) aplicado.
BEGIN;

CREATE TABLE IF NOT EXISTS task_attachment (
  id             TEXT PRIMARY KEY,
  "taskId"       TEXT NOT NULL,
  "orgId"        TEXT NOT NULL,
  "uploaderId"   TEXT NOT NULL,
  "uploaderName" TEXT NOT NULL,
  "fileName"     TEXT NOT NULL,        -- nome original exibível (extensão validada no servidor)
  "contentType"  TEXT NOT NULL,        -- vindo do head() do blob, não do client
  size           INTEGER NOT NULL,     -- bytes reais (head())
  url            TEXT NOT NULL,        -- URL interna do blob (store PRIVADO; usada só server-side p/ head()/del())
  pathname       TEXT NOT NULL,        -- caminho no store (del/cleanup, download assinado)
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now()
);

ALTER TABLE task_attachment DROP CONSTRAINT IF EXISTS task_attachment_task_org_fk;
ALTER TABLE task_attachment ADD CONSTRAINT task_attachment_task_org_fk
  FOREIGN KEY ("taskId", "orgId") REFERENCES tasks (id, "orgId") ON DELETE CASCADE;

-- lista do painel de anexos (mais recente primeiro), keyset
CREATE INDEX IF NOT EXISTS task_attachment_task_idx ON task_attachment ("taskId", "createdAt" DESC, id);
-- 1 blob = 1 registro (idempotência do confirm, anti-duplo-POST)
CREATE UNIQUE INDEX IF NOT EXISTS task_attachment_pathname_uniq ON task_attachment (pathname);

-- auto-registro no ledger (convenção T4): marca este script como aplicado NESTE banco
INSERT INTO schema_migrations (name) VALUES ('014_task_attachments') ON CONFLICT (name) DO NOTHING;

COMMIT;

-- VERIFICAÇÃO (esperado: tabela criada e vazia + 014 no ledger):
--   SELECT count(*) FROM task_attachment;
--   SELECT name, applied_at FROM schema_migrations WHERE name = '014_task_attachments';
