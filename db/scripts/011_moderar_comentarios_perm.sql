-- 011 — Permissão de moderação de comentários (project-scoped) aos perfis de sistema.
-- Idempotente. JP roda: dev → validar → prod.
BEGIN;
UPDATE roles SET permissions = array_append(permissions, 'tarefas.moderar_comentarios')
  WHERE "isSystem" = true AND NOT ('tarefas.moderar_comentarios' = ANY (permissions));
COMMIT;

-- VERIFICAÇÃO:
--   SELECT name, 'tarefas.moderar_comentarios' = ANY(permissions) AS tem FROM roles WHERE "isSystem" = true;
