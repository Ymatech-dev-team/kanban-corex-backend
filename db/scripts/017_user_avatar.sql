-- 017 — Foto de perfil (avatar). Coluna nullable com a URL pública do avatar (store PÚBLICO do Vercel Blob).
-- Idempotente. JP roda manual: dev -> verificar -> prod (mesmo Neon). [conta-redesign]
BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT;

-- auto-registro no ledger (convenção T4)
INSERT INTO schema_migrations (name) VALUES ('017_user_avatar') ON CONFLICT (name) DO NOTHING;

COMMIT;

-- VERIFICAÇÃO (coluna existe + 017 no ledger):
--   SELECT column_name FROM information_schema.columns WHERE table_name='users' AND column_name='avatarUrl';
--   SELECT name FROM schema_migrations WHERE name = '017_user_avatar';
