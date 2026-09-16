-- 013 — Notificações de "tarefa atribuída": índice para a consulta por destinatário.
-- Não cria tabela nova — as notificações derivam da task_activity (009). Só acelera o
-- GET /notifications/mine (filtra por org + payload->>'userId' + tipo de atribuição, ordenado
-- por createdAt desc). Idempotente. JP roda manual: dev -> validar -> prod. Requer o 009 aplicado.
BEGIN;

-- Índice PARCIAL: só os eventos de atribuição, chaveado por org + quem foi atribuído + recência.
CREATE INDEX IF NOT EXISTS task_activity_recipient_idx
  ON task_activity ("orgId", (payload ->> 'userId'), "createdAt" DESC)
  WHERE type IN ('ASSIGNEE_ADDED', 'PRIMARY_CHANGED');

COMMIT;

-- VERIFICAÇÃO (esperado: 1 linha):
--   SELECT indexname FROM pg_indexes
--   WHERE tablename = 'task_activity' AND indexname = 'task_activity_recipient_idx';
