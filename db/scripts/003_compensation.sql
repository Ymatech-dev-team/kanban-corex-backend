-- 003 — remuneração do membro (salário mensal OU valor/hora), em centavos.
-- Idempotente. Rodar no Neon após 001 e 002.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS "compensationType" TEXT,
  ADD COLUMN IF NOT EXISTS "compensationCents" INTEGER;

-- Tipo só pode ser MONTHLY, HOURLY ou nulo.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_compensation_type_chk;
ALTER TABLE users
  ADD CONSTRAINT users_compensation_type_chk
  CHECK ("compensationType" IS NULL OR "compensationType" IN ('MONTHLY', 'HOURLY'));

-- Tipo e valor andam juntos (ambos nulos ou ambos preenchidos), e valor não-negativo.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_compensation_pair_chk;
ALTER TABLE users
  ADD CONSTRAINT users_compensation_pair_chk
  CHECK (
    ("compensationType" IS NULL AND "compensationCents" IS NULL)
    OR ("compensationType" IS NOT NULL AND "compensationCents" IS NOT NULL AND "compensationCents" >= 0)
  );
