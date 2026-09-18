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

## Ledger de migrations (a partir do 016)

A tabela `schema_migrations (name, applied_at)` registra **o que já rodou neste banco**. Como dev e
prod são o **mesmo Neon**, o ledger é único e evita rodar (ou esquecer) um script duas vezes.

**Regra nova:** todo script `NNN_*.sql` **se auto-registra** — a última linha antes do `COMMIT` é o
insert do próprio nome (sem `.sql`), idempotente:

```sql
BEGIN;

-- ... suas mudanças idempotentes ...

INSERT INTO schema_migrations (name) VALUES ('NNN_nome_do_script') ON CONFLICT (name) DO NOTHING;

COMMIT;
```

**Status — o que já foi aplicado** (rode e compare com os arquivos da pasta pra achar pendências):

```sql
SELECT name, applied_at FROM schema_migrations ORDER BY name;
```

Pendências conhecidas hoje: **013_notif_assignment_index** (não aplicado) e **014_task_attachments**
(anexos estacionado) — ambos ficam de fora do ledger até serem rodados; aí cada um insere seu nome.
Scripts 001–012 e 015 foram backfillados pelo `016_migrations_ledger.sql`.
