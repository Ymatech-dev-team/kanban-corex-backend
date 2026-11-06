-- Somente leitura; executar após SQL019 no banco autorizado. Não imprime payloads/tokens.
SELECT name,applied_at FROM schema_migrations WHERE name='019_mcp_oauth';
SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name IN ('mcp_connections','mcp_oauth_artifacts') ORDER BY table_name;
SELECT c.conrelid::regclass AS relation,c.conname,c.convalidated,pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c WHERE c.conrelid IN ('public.mcp_connections'::regclass,'public.mcp_oauth_artifacts'::regclass) ORDER BY 1,2;
SELECT idx.relname,i.indisvalid,i.indisready,pg_get_indexdef(idx.oid) AS definition
FROM pg_index i JOIN pg_class idx ON idx.oid=i.indexrelid
WHERE idx.relname IN ('users_id_org_workflow_uidx','mcp_connections_user_idx','mcp_oauth_expiry_idx','mcp_oauth_grant_idx','mcp_oauth_uid_idx','mcp_oauth_usercode_idx') ORDER BY 1;
-- Esperado: zero órfãos, sem retornar informações identificáveis.
SELECT count(*) AS orphan_connections FROM mcp_connections c LEFT JOIN users u ON u.id=c."userId" AND u."orgId"=c."orgId" WHERE u.id IS NULL;
-- Informativo: tabela nova vazia; reaplicação preserva conexões existentes.
SELECT 'mcp_connections' AS relation,count(*) FROM mcp_connections UNION ALL SELECT 'mcp_oauth_artifacts',count(*) FROM mcp_oauth_artifacts;
