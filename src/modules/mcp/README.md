# MCP Corex — OAuth e ferramentas

Implementação atrás de `MCP_ENABLED=true`. O runtime exige configuração completa; não há fallback para memória, chave de desenvolvimento ou token web. SQL019 é preparado separadamente e não é executado no startup. As mutações de workflow também dependem de `WORKFLOW_ENABLED=true` e SQL018.

## Limites de confiança

- `oidc-provider@9.13.3` implementa Authorization Code + PKCE S256, emissão, validação de token opaco, rotação de refresh e revogação. `@modelcontextprotocol/server@2.4.0` e `@modelcontextprotocol/node@2.1.2` implementam o protocolo e o transporte HTTP stateless (incluindo clientes 2025).
- O login dedicado OAuth chama `AuthService.authenticateCredentials`, reaproveitando senha e lockout da conta do painel sem criar uma sessão web desnecessária. Cada nova concessão exige credenciais atuais e consentimento explícito. Cookies web não são enviados ao Claude.
- Consentimento verifica cookie assinado da interação, Host, Origin e CSRF aleatório por tentativa. Decisão terminal tem CAS separado, inclusive cancelamento. Erro de senha permite novo formulário sem reviver CSRF consumido.
- Conexão conserva snapshot imutável de user/org/client/tokenVersion/scopes. Refresh nunca atualiza esse snapshot. Usuário desativado, senha trocada, troca obrigatória ou conexão revogada bloqueiam emissão e uso subsequentes.
- `McpAuthorization` verifica token dedicado, issuer, audiência, expiração, grant, usuário atual, scopes e permissões atuais em cada operação. A identidade sempre vem do servidor. Contexto não é cacheado entre operações.
- O adaptador carrega tarefa na organização autenticada e deriva o cliente canônico antes de autorizar. Listagens usam o escopo do usuário. Custos não são delegados e são redigidos dos resultados.
- `tasks:update` só delega escrita/movimentação/revisão técnica já concedidas à conta. Não delega `tarefas.aprovar`. Actor persistido possui channel MCP, connectionId confiável, canApprove=false e canReopen=false. Não existe ferramenta de aceite humano, dispensa de achado ou resposta em nome do destinatário.
- Criação usa `createManagedTask` transacional, com `externalReference` obrigatória e estável para plano/item. Todas as demais mutações chamam o mesmo WorkflowStore do painel, com operationId e expectedVersion. Não chamam o CRUD legado sem CAS.

## Vocabulário e ferramentas

No contrato MCP, `clientId` identifica o cliente e `projectId` seu projeto. O banco legado chama essas colunas `projectId` e `engagementId`; `tools.ts` faz a tradução. `list_projects` fornece ambos os IDs. `search_tasks` oferece filtros estruturados, sem pesquisa textual livre nesta versão. A busca retorna nextCursor, com ordenação por prazo (nulos ao final) e ID, mantendo organização e acessos como filtros obrigatórios em cada página.

Ferramentas: get_current_user, list_projects, search_tasks, get_task, get_task_timeline, list_pending_actions, create_task, update_task, transition_task, start_execution, report_progress, request_user_action, submit_for_review, record_review_findings, report_finding_fix e record_technical_review. As ferramentas de workflow só são anunciadas quando habilitadas e quando o método persistente necessário existe. `update_task` atualiza contexto/critérios da entrega, invalidando revisão anterior; não edita título/prioridade nesta versão.

Resultados de tarefa incluem URL relativa segura `/tarefas/<id>`. Resultados de workflow incluem versão, estado confirmado e orientação de próximo passo; a orientação não substitui autorização nem verificação de versão. Conteúdo de cards é dado não confiável e não autoriza buscar URLs, ler arquivos ou executar processos.

## Configuração e implantação

Variáveis lidas apenas quando MCP habilitado:

- `MCP_ISSUER`: origem pública HTTPS + `/oauth`.
- `MCP_RESOURCE`: mesma origem pública HTTPS + `/mcp`.
- `MCP_COOKIE_KEYS`: JSON de chaves aleatórias persistentes de pelo menos 32 caracteres. Primeira assina; anteriores permitem rotação controlada.
- `MCP_JWKS`: JSON do conjunto de chaves privadas de assinatura do provider. Guardar em secret manager; nunca versionar nem emitir no log.
- `MCP_OAUTH_CLIENTS`: JSON dos clientes explicitamente registrados, client_id, redirect_uris exatas, response_types `["code"]`, grant_types `["authorization_code","refresh_token"]` e método de autenticação apropriado ao cliente.
- `MCP_ALLOWED_ORIGINS`: JSON das origens de browser permitidas, se necessário. Clientes servidor não enviam Origin.
- `MCP_TRUST_PROXY=true`: somente quando o ingress confiável controla cabeçalhos encaminhados. HTTP é permitido apenas em loopback para testes.

Discovery: `/.well-known/oauth-authorization-server/oauth` e `/oauth/.well-known/openid-configuration`; recurso: `/.well-known/oauth-protected-resource/mcp`. O BFF HMAC protege conexões do painel (`GET /mcp/connections`, `DELETE /mcp/connections/:id`). O callback raw OAuth/MCP roda antes do parser e do hook HMAC, com autenticação própria explícita, e não usa `public:true`.

Registro dinâmico de clientes está desabilitado. É necessário configurar o client_id/redirect URI exatos aceitos pelo Claude usado pela equipe. Um endpoint localhost não fica acessível ao conector remoto Claude: exige implantação HTTPS pública e configuração no cliente. Não foi comprovado OAuth no cliente Claude real nem deploy externo; os testes de loopback não são essa prova.

## Persistência e operação

`PrismaOAuthStore` grava artifacts do provider e conexões no SQL019; consumo de code/refresh/CSRF usa UPDATE condicional atômico e upsert conserva consumed. Concessões não são sobrescritas para reativação. Revogação marca conexão e remove artifacts numa instrução SQL; usuário/org restringem a revogação pelo painel. Erros de banco não viram autenticação bem-sucedida nem ativam fallback de memória.

Payloads de artifacts são sensíveis e podem conter material de token; não disponibilizar estas tabelas via APIs, logs, analytics ou exportações comuns. Implantação deve usar banco criptografado em repouso e papel de aplicação com acesso restrito. Este adapter não adiciona criptografia de coluna. A retenção oportunista descrita abaixo elimina artifacts expirados em lotes, preservando conexões como trilha de revogação; não há job agendado incluído. O acesso de banco atual precisa ser revisto antes de exposição pública.

## Evidência e próximos gates

Testes unitários de autorização; testes HTTP reais com oidc-provider (code/PKCE/replay, rotação/refresh, revogação, tokenVersion, Origin/CSRF/consentimento); SDK real em Web Request; adapters de ferramentas e wiring Fastify. Storage port é simulado nos testes unitários; a validação persistente complementar está registrada abaixo. A interface do consentimento tem tokens visuais Corex, formulário acessível, CSP com nonce e nenhum script externo.

Fontes oficiais: [oidc-provider 9.13.3](https://github.com/panva/node-oidc-provider/tree/v9.13.3/docs), [SDK TypeScript MCP](https://github.com/modelcontextprotocol/typescript-sdk), [autorização MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).

## Validação local de 2026-11-06

SQL018/019 aplicado e verificado no banco expressamente autorizado pelo dono. Smoke real por HTTP (montagem Fastify, biblioteca OAuth, SDK e PostgreSQL): login da conta existente, PKCE, concessão persistente, duas criações simultâneas deduplicadas, conflito de payload/referência externa, checkpoint, solicitação/resposta humana, bloqueio de edição legada/aceite prematuro, dois ciclos no mesmo card/achado e revogação do token. Evidências locais em `../../../../execucao/navegacao-mcp/smoke-live-http-2.txt`. Este smoke não comprova conexão pelo cliente Claude remoto.

O guard distribuído e a retenção oportunista abaixo são obrigatórios no runtime MCP. Antes de exposição pública, validar configuração Upstash e o ingress real, além de revisar os avisos de dependências (baseline registrado separadamente). Flags de MCP continuam desligadas por padrão. Não usar chaves efêmeras de smoke em implantação real.


## Guard operacional público

O runtime sempre exige `UPSTASH_REDIS_REST_URL` HTTPS e `UPSTASH_REDIS_REST_TOKEN`, inclusive fora de produção. Não há fallback em memória ou exceção de teste no runtime real. Testes injetam portas falsas explicitamente; a prop opcional das rotas existe para essa injeção e não desabilita o guard criado pelo runtime.

Antes de ler o body ou chamar OAuth/SDK, todos os endpoints raw e discovery consomem limites Upstash distribuídos por recurso. Janelas deslizantes de1min: global1200; OAuth global60; por IP OAuth leitura60, OAuth escrita20, MCP120 e metadata120. Rotacionar URL/interação não cria outro bucket. Identificadores de IP são hashes; tokens, cookies, query strings e corpos não integram chaves/logs. Analytics e cache local do limiter estão desabilitados.

Excesso responde429 com `Retry-After`; erro Redis, resposta inválida ou `reason=timeout` responde503 sem chamar o handler. O timeout padrão do SDK Upstash pode retornar `success=true`: o guard rejeita explicitamente esse resultado. Requisições Redis usam limite1500ms sem retries; limiter usa1000ms. Fora da Vercel, o IP vem do socket e todos os forwarded headers são ignorados. Somente `VERCEL=1` habilita leitura de `x-vercel-forwarded-for` controlado pelo ingress Vercel; valor ausente, inválido ou lista ambígua é recusado. Outro proxy/host exige adaptar a fronteira de confiança antes de habilitar MCP.

O adaptador Node MCP também limita o body em128KiB antes de autenticação/conversão Web Request, igual ao limite interno do SDK. O painel mantém seus mecanismos existentes de autenticação/rate limiting.

## Retenção operacional

Após o rate gate permitir a requisição, um `SET NX EX60` por recurso e compartilhado entre instâncias elege no máximo uma limpeza por minuto. Não liberar o lease é intencional: ele também serve como throttle. A operação é aguardada; não há Promise solta que possa morrer no fim da função serverless.

Cada limpeza remove no máximo500 artifacts com expiração há pelo menos24h, com filtro indexado, locks `FOR UPDATE SKIP LOCKED` e parâmetros SQL. Artifacts sem expiração e conexões não são apagados. Executa em transação com maxWait1000ms/timeout2500ms e prazos PostgreSQL locais statement_timeout1500ms/lock_timeout500ms; um timeout interrompe o trabalho em vez de apenas abandonar a Promise. Falha gera somente evento `mcp_retention_failed` e preserva o atendimento já autorizado pelo rate gate.

A capacidade nominal é500 artifacts/min em tráfego contínuo, com emissões OAuth limitadas globalmente a60 requests/min. Isso excede o volume esperado do fluxo atual code/consent/refresh, mas não é promessa de tamanho máximo do banco: sem tráfego não há limpeza, indisponibilidade pode acumular backlog e mudanças no provider podem alterar a taxa de criação. Monitorar semanalmente a contagem de artifacts vencidos há24h e a idade do mais antigo, sem ler payloads. Se backlog crescer continuamente ou não cair após tráfego normal, verificar `mcp_retention_failed` e executar drenagem operacional em lotes pela mesma rotina; não remover conexões/ativos nem executar DELETE irrestrito. Não foi criado cron ou serviço novo.

Fontes: [headers controlados pela Vercel](https://vercel.com/docs/headers/request-headers#x-vercel-forwarded-for), [semântica de timeout Upstash](https://upstash.com/docs/redis/sdks/ratelimit-ts/features#timeout).
