# Persistência do workflow

Estado: proposta B2 preparada para revisão; **018 não aplicado**. A introdução do domínio não ativa o fluxo novo nem altera o status das tarefas existentes.

## Mudanças de banco

Script: `db/scripts/018_task_workflow.sql`. Pré-requisitos: FK composta de tarefas do 008 e ledger do 016. O 018 é uma transação aditiva com cinco tabelas, índices e registro no ledger. Não usa seed, backfill, PL/pgSQL, DROP, alteração de privilégios ou reset. Nenhuma tabela atual é preenchida ou alterada; o único índice acrescentado a uma tabela atual é a chave única `(users.id, users.orgId)` para garantir FKs de tenant.

`CREATE TABLE IF NOT EXISTS` permite repetir o script quando a definição existente já corresponde ao script. Não é reconciliação de drift: se já existir uma tabela homônima com outra estrutura, parar e investigar; nunca modificar silenciosamente uma migração já aplicada. Conferir o SQL de verificação após aplicação e comparar definições, além do ledger.

| Tabela | Contrato |
| --- | --- |
| task_workflows | Uma linha por tarefa/organização, etapa e versão consultáveis, aggregate JSONB com o estado completo |
| workflow_events | Uma linha append-only por versão da tarefa, ator/canal/operação e payload da mudança |
| workflow_operations | Resultado idempotente por organização/conexão/operação, digest do comando e vínculo ao evento, tarefa e versão resultante |
| workflow_outbox | Evento a publicar, com tentativas, lease e confirmação; conteúdo recuperado de workflow_events |
| task_action_requests | Fila com destinatário, estado, tipo, versão, pergunta, resposta e resolução explícitos |

Datas seguem o padrão TIMESTAMP(3) do banco existente. Aplicação trata todos os valores como UTC; apresentação ao usuário em BRT. IDs são gerados pelo servidor. A coluna sequencial da outbox usa bigint: serializar como string se ultrapassar o intervalo seguro do JavaScript.

### Aggregate JSONB e validação

O snapshot preserva os tipos de `src/modules/workflow/types.ts`. O SQL verifica objeto, campos presentes, tipos das coleções, identidade e igualdade entre stage/version/deliveryRevision do JSON e as colunas. Limite inicial: 1 MiB por aggregate, 1 MiB por evento e 2 MiB por resultado idempotente.

O SQL **não valida todos os campos de cada achado/revisão**. Um schema estrito de runtime deve validar snapshot e comando antes de invocar o domínio e antes de persistir; arrays não podem ser considerados seguros só por passarem o CHECK. IDs de responsáveis/executores dentro do JSON precisam ser resolvidos no escopo autorizado. Etapas, versões e fila permanecem em colunas para consulta e integridade, sem depender de buscas JSON não indexadas.

Tradeoff: inicialmente uma atualização faz CAS de um aggregate coeso, facilitando invariantes entre ciclos/achados, mas revisões extensas aumentam o tamanho da linha. Antes de atingir o limite, normalizar ciclos/achados com nova migração ou arquivar histórico fora do snapshot mediante projeto próprio, preservando IDs e eventos. Não truncar revisões para caber. O plano macro previa tabelas por entidade; esta representação é uma decisão de persistência a revisar antes da integração, não prova de que as entidades completas já estão entregues.

### Atomicidade e idempotência

O adaptador executará em uma mesma transação:

1. Autorizar usuário, tenant e tarefa. Acessos revogados não podem receber resultados antigos por idempotência.
2. Reservar/serializar a chave de operação para evitar corridas. A única chave é `(orgId, connectionId, operationId)`; o digest SHA-256 inclui ferramenta, alvo, expectedVersion e payload canônico.
3. Se houver resultado com o mesmo digest, devolver aquele resultado. Se o digest diferir, retornar CONFLITO. Uma operação ID não pode ser reutilizada para outra tarefa/ferramenta.
4. Carregar snapshot e aplicar domínio. Atualizar com `WHERE taskId = ... AND orgId = ... AND version = expectedVersion`; exigir uma linha afetada. Incrementar versão exatamente em um.
5. Inserir evento, resultado da operação e outbox; confirmar tudo junto. Qualquer falha reverte tudo, inclusive alteração de versão.

O índice único e as FKs impedem parte das inconsistências, mas **não implementam a transação sozinhos**. O adaptador deverá tratar corrida de unicidade após rollback consultando resultado persistido, sem reutilizar uma transação abortada. Nunca devolver estado calculado antes de commit. Não utilizar ON CONFLICT DO UPDATE para substituir resultado idempotente.

Eventos e resultados idempotentes têm contrato append-only na aplicação. Este script não introduz regras que silenciem UPDATE/DELETE. Uma restrição adicional de papel no banco será uma decisão explícita de implantação, fora desta migração; até lá não alegar imutabilidade forçada pelo banco. FKs usam RESTRICT para não apagar histórico por cascata. Usuários e tarefas seguem soft-delete.

### Outbox e cursores

O consumidor reivindica eventos ainda não publicados com lease e exclusão concorrente; publica de forma tolerante a repetição e marca publishedAt após confirmação. Um evento repetido tem o mesmo eventId e a mesma versão. Não haverá criação de worker/cron nesta etapa; a ativação do transporte depende da implementação correspondente.

**Não usar `outbox.id > maxSeen` como única leitura incremental:** uma sequência é alocada antes do commit; uma transação mais lenta pode confirmar um ID menor depois. O consumidor deve selecionar pendentes não publicados, incluindo leases expirados. O transporte de replay para clientes precisa de cursor atribuído na publicação ou estratégia equivalente que não perca commits atrasados. Eventos de uma tarefa podem ser entregues fora de ordem; comparar versão e refazer leitura do snapshot quando necessário.

### Fila Precisa de você

Solicitação usa FK composta para tarefa, destinatário, criador e resolvedor. OPEN não tem resposta/resolvedor/data; RESOLVED e CANCELLED exigem os três, usando response como resposta ou justificativa de cancelamento. Ler uma notificação não altera esta tabela. Resolução usa CAS próprio de version e reautorização; registrar evento da tarefa e outbox na mesma transação. Conta desativada continua existindo por soft-delete, mas a aplicação precisa impedir novos encaminhamentos e tratar reatribuição.

### Compatibilidade e ativação

`tasks.status` permanece TODO/DOING/DONE. Rotas atuais não passam a aceitar novas etapas por esta migração. Nenhum workflow é criado automaticamente; a integração precisa definir migração/bootstrap por tarefa e impedir que rotas legadas alterem status de tarefas com workflow ativo sem passar pelo domínio.

Não adicionar modelos Prisma nem gerar client alegando schema aplicado antes de comprovar aplicação no alvo autorizado. Não instalar OAuth stores neste script. A confirmação do usuário de que o banco é só dele não substitui revisão deste SQL e registro do alvo/aplicador/verificações.

## Verificação e liberação

`docs/workflow/018-verification.sql` contém somente SELECTs e resultados esperados. Antes de aplicação, uma revisão independente deve conferir schema, FKs, custo de índice e atomicidade do adaptador. Depois de aplicar, registrar hash do script, endpoint/branch sem credenciais, aplicador, horário e saída das verificações.

Testes transacionais em banco de desenvolvimento devem provar: rejeição cross-org; CAS concorrente; repetição idempotente; rollback sem evento órfão; operação vinculada à tarefa/versão correta; JSON incoerente rejeitado; resolução de fila com versão antiga rejeitada; consumidor tolerante a entrega duplicada e commit fora de ordem. Essas provas ainda não foram executadas.

Rollback operacional: desativar integração/feature e manter as tabelas. Não executar DROP automático nem converter silenciosamente etapas novas para status legado.

## Criação gerenciada e identidade do plano

`createManagedTask` valida os pais ativos e acesso atual do ator, reserva a operação e cria tarefa, snapshot inicial versão 1, evento, resultado e outbox na mesma transação. Não existe create-then-put fora da transação. `externalReference` opcional no store é obrigatório no adaptador MCP: usar identidade estável `repo/plano/item`. Unicidade `(orgId, externalReference)` impede outro chat/conexão de duplicar o item. A mesma operação retorna seu resultado original; uma nova operação com referência já existente recebe CONFLITO, mesmo se o texto coincidir. Não retorna dados de outra tarefa nessa colisão. Chave permanece reservada após soft-delete. A aplicação serializa referências com advisory lock; índice único é a barreira final.

`bootstrap-permissions.sql` é uma proposta operacional separada para conceder apenas revisar/aprovar ao usuário administrador explicitamente escolhido. Exige org/user, valida papel de sistema Administrador com perfis.gerenciar, e não concede automaticamente a todos. Não aplicado.
