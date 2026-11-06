-- Proposta operacional separada; NÃO executar como migração ou seed.
-- Revisar o org_id/user_id específico e autorizar a concessão antes de executar.
-- psql -v org_id='ID_ORG' -v user_id='ID_ADMIN' -f docs/workflow/bootstrap-permissions.sql
-- Concede somente ao usuário indicado, nunca a todos os membros do papel.
\set ON_ERROR_STOP on
BEGIN;
SELECT u.id, u."orgId", r.name AS role
FROM users u JOIN roles r ON r.id=u."roleId" AND r."orgId"=u."orgId"
WHERE u.id=:'user_id' AND u."orgId"=:'org_id' AND u."deletedAt" IS NULL
  AND r."isSystem"=true AND r.name='Administrador' AND 'perfis.gerenciar'=ANY(r.permissions)
FOR UPDATE OF u;
-- Falha e reverte se o alvo não é exatamente um administrador ativo do tenant.
SELECT 1 / count(*) AS validated_target
FROM users u JOIN roles r ON r.id=u."roleId" AND r."orgId"=u."orgId"
WHERE u.id=:'user_id' AND u."orgId"=:'org_id' AND u."deletedAt" IS NULL
  AND r."isSystem"=true AND r.name='Administrador' AND 'perfis.gerenciar'=ANY(r.permissions);
UPDATE users u SET "extraPermissions"=(
  SELECT ARRAY(SELECT DISTINCT p FROM unnest(u."extraPermissions" || ARRAY['tarefas.revisar','tarefas.aprovar']) AS p ORDER BY p)
)
WHERE u.id=:'user_id' AND u."orgId"=:'org_id' AND u."deletedAt" IS NULL
  AND EXISTS (SELECT 1 FROM roles r WHERE r.id=u."roleId" AND r."orgId"=u."orgId" AND r."isSystem"=true AND r.name='Administrador' AND 'perfis.gerenciar'=ANY(r.permissions))
RETURNING id,"orgId","extraPermissions";
COMMIT;
-- Reautenticar/recarregar sessão; capabilities consultam permissões correntes.
