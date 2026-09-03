# db/scripts — mudanças de banco (SQL manual versionado)

Convenção YMA: o banco **nunca** é alterado por `prisma migrate`/`db push`. Prisma é só
schema source-of-truth + client tipado. Toda mudança é um `.sql` idempotente, revisado e
**rodado manualmente pelo dono (JP)** — dev primeiro; staging/prod com ok separado.

## Ordem de aplicação (dev)
1. Aplicar `001_init.sql` no Neon (branch dev) via psql/DBeaver/console do Neon.
2. Rodar a query de verificação no fim do arquivo (esperado: **10** tabelas).
3. `npm run prisma:generate` (gera o client — não toca no banco).
4. Bootstrap do admin: `ADMIN_EMAIL=... ADMIN_NAME="..." npm run db:seed`.

## Regras
- SQL idempotente (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` + `ADD`).
- **Sem `DO $$`/PL-pgSQL** (quebra no runner do Neon).
- SQL já aplicado **nunca é editado** — correção vira novo arquivo `NNN_*.sql`.
- Neon: `DATABASE_URL` (com `-pooler`) no runtime; `DIRECT_URL` (sem) para psql/diff.
