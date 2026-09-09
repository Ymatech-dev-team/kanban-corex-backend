-- 007 — Semeia as permissões novas de Projeto nos perfis Administrador (isSystem) existentes.
-- Sem isso, ficam ingrantáveis nos Administradores antigos (perfil isSystem é imutável pela UI).
-- Idempotente (só adiciona onde falta). JP roda manual: dev → validar → prod.

BEGIN;
UPDATE roles SET permissions = array_append(permissions, 'engagements.criar')
  WHERE "isSystem" = true AND NOT ('engagements.criar' = ANY (permissions));
UPDATE roles SET permissions = array_append(permissions, 'engagements.editar')
  WHERE "isSystem" = true AND NOT ('engagements.editar' = ANY (permissions));
UPDATE roles SET permissions = array_append(permissions, 'engagements.excluir')
  WHERE "isSystem" = true AND NOT ('engagements.excluir' = ANY (permissions));
UPDATE roles SET permissions = array_append(permissions, 'engagements.consultores')
  WHERE "isSystem" = true AND NOT ('engagements.consultores' = ANY (permissions));
COMMIT;

-- VERIFICAÇÃO (esperado: as 4 'engagements.*' presentes em cada Administrador):
--   SELECT name, permissions FROM roles WHERE "isSystem" = true;
