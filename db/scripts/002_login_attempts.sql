-- 002_login_attempts.sql — lockout de login por conta, persistido no Postgres. [SEC-003]
-- Idempotente. Rodar manual (JP) em dev; staging/prod com ok separado.

BEGIN;

CREATE TABLE IF NOT EXISTS login_attempts (
  email         TEXT PRIMARY KEY,
  count         INTEGER NOT NULL DEFAULT 0,
  "firstAt"     TIMESTAMP(3) NOT NULL DEFAULT now(),
  "lockedUntil" TIMESTAMP(3)
);

COMMIT;

-- Verificação: SELECT to_regclass('public.login_attempts');  -- esperado: login_attempts
