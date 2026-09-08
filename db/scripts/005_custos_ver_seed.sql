-- 005 — Bootstrap da permissão nova "custos.ver" (feature Custo de alocação)
--
-- Por quê: o perfil "Administrador" é semeado com ALL_PERMISSIONS, mas isso é um
-- snapshot do momento da criação da org. Como "custos.ver" é nova, os Administradores
-- JÁ existentes não a têm — e pela trava anti-escalonamento (assertGrantAllowed) ninguém
-- consegue conceder uma permissão que não possui. Sem este seed, "Ver custos" fica
-- ingrantável pela UI. Orgs criadas a partir de agora já nascem com ela (está em
-- ALL_PERMISSIONS); este script cobre as orgs antigas.
--
-- Idempotente: só adiciona onde falta. Rode em DEV, valide, depois PROD.

BEGIN;

UPDATE roles
SET permissions = array_append(permissions, 'custos.ver')
WHERE "isSystem" = true
  AND NOT ('custos.ver' = ANY (permissions));

COMMIT;

-- Verificação (esperado: tem_custos_ver = true em todas as linhas):
-- SELECT id, name, ('custos.ver' = ANY (permissions)) AS tem_custos_ver
-- FROM roles WHERE "isSystem" = true;
