-- 015 — Presets de filtro do board (por usuário, por cliente). Payload dos filtros em JSONB.
-- Idempotente. JP roda manual: dev -> validar -> prod. Requer o 008 (projects.@@unique([id,orgId])).
BEGIN;

CREATE TABLE IF NOT EXISTS board_filter_preset (
  id          TEXT PRIMARY KEY,
  "orgId"     TEXT NOT NULL,
  "projectId" TEXT NOT NULL,          -- cliente dono
  "userId"    TEXT NOT NULL,          -- dono (privado por usuário)
  name        TEXT NOT NULL,
  filters     JSONB NOT NULL,         -- { resp?, status?, prio?, prazo? }
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);

-- FK composta (project, org): coerência de tenant; cascade se o cliente for hard-deleted.
ALTER TABLE board_filter_preset DROP CONSTRAINT IF EXISTS board_filter_preset_project_org_fk;
ALTER TABLE board_filter_preset ADD CONSTRAINT board_filter_preset_project_org_fk
  FOREIGN KEY ("projectId", "orgId") REFERENCES projects (id, "orgId") ON DELETE CASCADE;

-- lista do painel (por org/cliente/usuário)
CREATE INDEX IF NOT EXISTS board_filter_preset_scope_idx
  ON board_filter_preset ("orgId", "projectId", "userId");
-- 1 nome por (org, cliente, usuário) — backstop; a checagem normalizada fica na service
CREATE UNIQUE INDEX IF NOT EXISTS board_filter_preset_name_uniq
  ON board_filter_preset ("orgId", "projectId", "userId", name);

COMMIT;

-- VERIFICAÇÃO (esperado: tabela criada e vazia):
--   SELECT count(*) FROM board_filter_preset;
