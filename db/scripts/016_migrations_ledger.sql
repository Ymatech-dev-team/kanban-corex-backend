-- 016 — Ledger de migrations aplicadas. Passa a registrar quais NNN_*.sql já rodaram NESTE banco.
-- Motivo: dev e prod são o MESMO Neon, e não havia como saber (olhando o banco) o que já foi aplicado
-- → risco de um script ficar por rodar. A partir daqui, todo script novo se auto-registra (ver README).
-- Idempotente. JP roda manual: dev -> verificar -> prod. [hardening T4]
BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  name        text PRIMARY KEY,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- Backfill dos scripts JÁ aplicados (confirmado pelo JP em 2026-09-18): 001–012 + 015 + este 016.
-- FORA de propósito: 013_notif_assignment_index (ainda NÃO aplicado — fica pendente e visível no status)
-- e 014_task_attachments (feature de anexos estacionada). Cada um se registra quando for aplicado.
INSERT INTO schema_migrations (name) VALUES
  ('001_init'),
  ('002_login_attempts'),
  ('003_compensation'),
  ('004_cost'),
  ('005_custos_ver_seed'),
  ('006_engagements'),
  ('007_engagements_perms_seed'),
  ('008_task_assignees'),
  ('009_task_activity'),
  ('010_task_comment'),
  ('011_moderar_comentarios_perm'),
  ('012_ver_globais_perm'),
  ('015_board_filter_presets'),
  ('016_migrations_ledger')
ON CONFLICT (name) DO NOTHING;

COMMIT;

-- VERIFICAÇÃO (esperado: 14 linhas; NÃO deve aparecer 013 nem 014):
--   SELECT name, applied_at FROM schema_migrations ORDER BY name;
