-- 001_init.sql — Sistema de Tasks · schema inicial (10 tabelas)
-- Idempotente (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS + ADD). Sem DO $$ (runner do Neon).
-- Rodar MANUALMENTE: dev primeiro; staging/prod com ok separado. Nunca prisma migrate/db push.
-- Verificação ao final do arquivo.

BEGIN;

-- 1. Organizações
CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);

-- 2. Usuários (roleId FK adicionada após criar roles)
CREATE TABLE IF NOT EXISTS users (
  id                   TEXT PRIMARY KEY,
  "orgId"              TEXT NOT NULL REFERENCES organizations(id),
  name                 TEXT NOT NULL,
  email                TEXT NOT NULL,
  "passwordHash"       TEXT NOT NULL,
  "roleId"             TEXT,
  "extraPermissions"   TEXT[] NOT NULL DEFAULT '{}',
  "mustChangePassword" BOOLEAN NOT NULL DEFAULT false,
  "tokenVersion"       INTEGER NOT NULL DEFAULT 0,
  "deletedAt"          TIMESTAMP(3),
  "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT now()
);
-- email único POR ORG e só entre ativos [SEC-010][JOR-2d]
CREATE UNIQUE INDEX IF NOT EXISTS users_org_email_active_uidx
  ON users("orgId", email) WHERE "deletedAt" IS NULL;
CREATE INDEX IF NOT EXISTS users_orgId_idx ON users("orgId");

-- 3. Perfis (roles)
CREATE TABLE IF NOT EXISTS roles (
  id          TEXT PRIMARY KEY,
  "orgId"     TEXT NOT NULL REFERENCES organizations(id),
  name        TEXT NOT NULL,
  permissions TEXT[] NOT NULL DEFAULT '{}',
  "isSystem"  BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS roles_org_name_uidx ON roles("orgId", name);

-- FK users.roleId -> roles com RESTRICT (deletar role em uso é bloqueado) [SEC-109]
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_fk;
ALTER TABLE users ADD  CONSTRAINT users_role_fk
  FOREIGN KEY ("roleId") REFERENCES roles(id) ON DELETE RESTRICT;

-- 4. Projetos (= clientes)
CREATE TABLE IF NOT EXISTS projects (
  id                TEXT PRIMARY KEY,
  "orgId"           TEXT NOT NULL REFERENCES organizations(id),
  name              TEXT NOT NULL,
  description       TEXT,
  "createdById"     TEXT NOT NULL,
  "deletionBatchId" TEXT,
  "deletedAt"       TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
-- habilita a FK composta de integridade de tenant [ARQ]
ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_id_org_uniq;
ALTER TABLE projects ADD  CONSTRAINT projects_id_org_uniq UNIQUE (id, "orgId");
CREATE INDEX IF NOT EXISTS projects_orgId_idx ON projects("orgId");

-- 5. Acesso por cliente/projeto (A ÚNICA fronteira entre clientes) [SEC-105]
CREATE TABLE IF NOT EXISTS project_members (
  "projectId" TEXT NOT NULL REFERENCES projects(id),
  "userId"    TEXT NOT NULL REFERENCES users(id),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now(),
  PRIMARY KEY ("projectId","userId")
);
CREATE INDEX IF NOT EXISTS project_members_user_idx ON project_members("userId");

-- 6. Tarefas
CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  "orgId"           TEXT NOT NULL,
  "projectId"       TEXT NOT NULL,
  title             TEXT NOT NULL,
  description       TEXT,
  status            TEXT NOT NULL DEFAULT 'TODO',
  priority          TEXT NOT NULL DEFAULT 'MEDIUM',
  "dueDate"         TIMESTAMP(3),
  "assigneeId"      TEXT REFERENCES users(id),
  position          DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdById"     TEXT NOT NULL,
  "deletionBatchId" TEXT,
  "deletedAt"       TIMESTAMP(3),
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now(),
  "updatedAt"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD  CONSTRAINT tasks_status_check   CHECK (status   IN ('TODO','DOING','DONE'));
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_priority_check;
ALTER TABLE tasks ADD  CONSTRAINT tasks_priority_check CHECK (priority IN ('LOW','MEDIUM','HIGH'));
-- FK composta garante task.orgId == project.orgId [ARQ]
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_project_org_fk;
ALTER TABLE tasks ADD  CONSTRAINT tasks_project_org_fk
  FOREIGN KEY ("projectId","orgId") REFERENCES projects(id,"orgId");
CREATE INDEX IF NOT EXISTS tasks_orgId_idx              ON tasks("orgId");
CREATE INDEX IF NOT EXISTS tasks_project_status_pos_idx ON tasks("projectId", status, position);
CREATE INDEX IF NOT EXISTS tasks_assigneeId_idx         ON tasks("assigneeId");
CREATE INDEX IF NOT EXISTS tasks_dueDate_idx            ON tasks("dueDate");

-- 7. Subtarefas
CREATE TABLE IF NOT EXISTS subtasks (
  id          TEXT PRIMARY KEY,
  "taskId"    TEXT NOT NULL REFERENCES tasks(id),
  title       TEXT NOT NULL,
  done        BOOLEAN NOT NULL DEFAULT false,
  position    DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS subtasks_taskId_idx ON subtasks("taskId");

-- 8. Refresh tokens
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id                TEXT PRIMARY KEY,
  "userId"          TEXT NOT NULL REFERENCES users(id),
  "tokenHash"       TEXT NOT NULL UNIQUE,
  family            TEXT NOT NULL,
  "expiresAt"       TIMESTAMP(3) NOT NULL,
  "familyExpiresAt" TIMESTAMP(3) NOT NULL,
  "revokedAt"       TIMESTAMP(3),
  "replacedById"    TEXT,
  "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT now()
);
-- CAS: um único filho por token [SEC-004]
CREATE UNIQUE INDEX IF NOT EXISTS refresh_replacedby_uidx
  ON refresh_tokens("replacedById") WHERE "replacedById" IS NOT NULL;
CREATE INDEX IF NOT EXISTS refresh_tokens_userId_idx ON refresh_tokens("userId");
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family);

-- 9. Idempotência de criação [JOR-6]
CREATE TABLE IF NOT EXISTS idempotency_keys (
  key         TEXT PRIMARY KEY,
  "userId"    TEXT NOT NULL,
  "resultId"  TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT now()
);

-- 10. Trilha de auditoria de autorização (append-only) [SEC-112]
CREATE TABLE IF NOT EXISTS permission_audit (
  id             TEXT PRIMARY KEY,
  "actorId"      TEXT NOT NULL,
  "targetUserId" TEXT,
  action         TEXT NOT NULL,
  detail         JSONB NOT NULL DEFAULT '{}',
  "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS permission_audit_target_idx ON permission_audit("targetUserId");

COMMIT;

-- ===== Verificação (rodar após o COMMIT; esperado: 10) =====
-- SELECT count(*) FROM information_schema.tables
-- WHERE table_schema='public'
--   AND table_name IN ('organizations','users','refresh_tokens','projects','tasks','subtasks',
--                      'idempotency_keys','roles','project_members','permission_audit');
