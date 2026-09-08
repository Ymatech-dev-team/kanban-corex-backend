-- 004 — custo de alocação: horas estimadas na tarefa + horas-mês da organização.
-- Aditivo e idempotente. Rodar no Neon após 001, 002 e 003.

-- Horas estimadas por tarefa (em minutos), opcional e não-negativa.
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS "estimatedMinutes" INTEGER;
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_estimated_minutes_chk;
ALTER TABLE tasks
  ADD CONSTRAINT tasks_estimated_minutes_chk
  CHECK ("estimatedMinutes" IS NULL OR "estimatedMinutes" >= 0);

-- Horas-mês padrão da org (divisor de salário mensal -> custo-hora). Default 176 (22 dias x 8h).
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS "monthlyHours" INTEGER NOT NULL DEFAULT 176;
ALTER TABLE organizations DROP CONSTRAINT IF EXISTS orgs_monthly_hours_chk;
ALTER TABLE organizations
  ADD CONSTRAINT orgs_monthly_hours_chk CHECK ("monthlyHours" > 0);
