-- Somente leitura. Executar DEPOIS de aplicar 018_task_workflow no alvo autorizado.
-- Cada verificação deve ser conferida; existir no ledger não prova integridade.

-- Esperado: exatamente estas cinco tabelas, cada uma uma vez.
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('task_workflows', 'workflow_events', 'workflow_operations', 'workflow_outbox', 'task_action_requests')
ORDER BY table_name;

-- Esperado: uma linha, 018_task_workflow.
SELECT name, applied_at FROM schema_migrations WHERE name = '018_task_workflow';

-- Esperado: todas as constraints validadas (convalidated = true).
-- Conferir definições, principalmente FKs compostas e CHECKs de JSON/estado.
SELECT c.conrelid::regclass AS relation, c.conname, c.contype, c.convalidated,
       pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
WHERE c.conrelid IN (
  'public.task_workflows'::regclass, 'public.workflow_events'::regclass,
  'public.workflow_operations'::regclass, 'public.workflow_outbox'::regclass,
  'public.task_action_requests'::regclass
)
ORDER BY c.conrelid::regclass::text, c.conname;

-- Esperado: todos os índices listados existentes, válidos e prontos.
SELECT idx.relname, i.indisvalid, i.indisready, pg_get_indexdef(idx.oid) AS definition
FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
WHERE idx.relname IN (
  'users_id_org_workflow_uidx', 'task_workflows_org_stage_idx',
  'workflow_events_feed_idx', 'workflow_operations_task_idx',
  'workflow_outbox_pending_idx', 'task_action_requests_inbox_idx', 'task_action_requests_task_idx'
)
ORDER BY idx.relname;

-- Esperado: zero linhas órfãs/incoerentes.
SELECT w."taskId", w."orgId"
FROM task_workflows w LEFT JOIN tasks t ON t.id = w."taskId" AND t."orgId" = w."orgId"
WHERE t.id IS NULL;

-- Esperado: zero incoerências, inclusive SQL NULL (IS DISTINCT FROM).
SELECT "taskId", "orgId"
FROM task_workflows
WHERE aggregate->>'taskId' IS DISTINCT FROM "taskId"
   OR aggregate->>'orgId' IS DISTINCT FROM "orgId"
   OR aggregate->>'stage' IS DISTINCT FROM stage
   OR aggregate->>'version' IS DISTINCT FROM version::text
   OR aggregate->>'deliveryRevision' IS DISTINCT FROM "deliveryRevision"::text;

-- Esperado: zero; se faltar outbox de evento, atomicidade foi violada.
SELECT e.id, e."taskId", e.version
FROM workflow_events e LEFT JOIN workflow_outbox o ON o."eventId" = e.id AND o."orgId" = e."orgId"
WHERE o.id IS NULL;

-- Esperado: zero; destinatários/atores devem pertencer à organização.
SELECT a.id
FROM task_action_requests a
LEFT JOIN users r ON r.id = a."recipientId" AND r."orgId" = a."orgId"
LEFT JOIN users c ON c.id = a."createdById" AND c."orgId" = a."orgId"
WHERE r.id IS NULL OR c.id IS NULL;

-- O CHECK existente de tasks.status deve continuar TODO/DOING/DONE.
SELECT conname, pg_get_constraintdef(oid) AS definition
FROM pg_constraint
WHERE conrelid = 'public.tasks'::regclass AND contype = 'c'
ORDER BY conname;

-- Contagens informativas: primeira aplicação deve criar tabelas vazias.
-- Uma reaplicação preserva dados; não exigir zero se a feature já tiver sido usada.
SELECT 'task_workflows' AS relation, count(*) FROM task_workflows
UNION ALL SELECT 'workflow_events', count(*) FROM workflow_events
UNION ALL SELECT 'workflow_operations', count(*) FROM workflow_operations
UNION ALL SELECT 'workflow_outbox', count(*) FROM workflow_outbox
UNION ALL SELECT 'task_action_requests', count(*) FROM task_action_requests;

-- Deve retornar índice único parcial e coluna nullable para identidade estável do item do plano.
SELECT indexdef FROM pg_indexes WHERE tablename='task_workflows' AND indexname='task_workflows_external_reference_uidx';
SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_name='task_workflows' AND column_name='externalReference';
