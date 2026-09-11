-- 012 — Permissão da aba Tarefas global (org-scoped) aos perfis de sistema E aos que veem todos os clientes.
-- Só libera VER a tela; o escopo do que aparece segue o acesso a projetos. Idempotente. JP roda: dev → validar → prod.
BEGIN;
UPDATE roles SET permissions = array_append(permissions, 'tarefas.ver_globais')
  WHERE ("isSystem" = true OR 'projetos.acessar_todos' = ANY (permissions))
    AND NOT ('tarefas.ver_globais' = ANY (permissions));
COMMIT;

-- VERIFICAÇÃO (esperado: admin + perfis com acessar_todos = true):
--   SELECT name, 'tarefas.ver_globais' = ANY(permissions) AS tem FROM roles
--     WHERE "isSystem" = true OR 'projetos.acessar_todos' = ANY(permissions);
