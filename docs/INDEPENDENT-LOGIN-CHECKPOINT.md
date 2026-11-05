# Login independente por senha

Esta etapa implementa `POST /api/auth/login`, `GET /api/auth/me` e `POST /api/auth/logout` no servidor Node da aplicação Nuxt. O recurso permanece desligado por padrão. Não cria contas reais nem habilita autorização por fazenda, pareamento ou comandos de impressora.

## Ativação e identidade

A configuração exige `NUXT_AUTH_ENABLED=true`, `NUXT_AUTH_ORIGIN` com origem HTTPS, `NUXT_AUTH_SESSION_SECRET` independente com pelo menos 32 caracteres e `NUXT_AUTH_DATABASE_URL` para o banco dedicado. Segredos não pertencem ao repositório. Mesmo o teste local exige HTTPS no navegador. O endpoint de saúde permanece independente do login.

A role `farm_password_auth` lê credenciais, cria sessões, mantém limites de tentativas e herda as capacidades de revogação de `farm_session_runtime`. Não cria contas nem altera hashes. A migração `0005_password_auth` depende da `0004`; aplique e reverta na ordem correta.

O identificador de login é `username`, com 3 a 64 caracteres ASCII minúsculos, números, `_` ou `-`. Não há associação automática por e-mail. Contas e credenciais pertencem exclusivamente a este produto. Recuperação de senha, cadastro público, OAuth e provisionamento de produção continuam pendentes.

## Sessão e proteção

O código usa o `useSession` mantido pelo Nuxt 4.6.4, com um segredo explícito independente. O cookie `__Host-open3dfarmmanager-session` é Secure, HttpOnly, SameSite=Lax e Path=/, sem Domain. O leitor dessa versão obtém a sessão somente do cookie, sem aceitar `Authorization` ou `x-session` como substitutos.

A senha usa `@adonisjs/hash` 9.1.1, com scrypt de custo 131072, bloco 8, paralelismo 1 e limite de memória de 160 MiB por operação. Cada processo admite duas operações simultâneas, sem fila ilimitada. Esses limites exigem medição sob carga antes de operação real. Usuário inexistente também executa verificação de hash sintético. As respostas não distinguem usuário ausente, senha incorreta ou conta desabilitada.

Após verificar a senha, a transação bloqueia primeiro a conta e depois a credencial. Revalida estado desabilitado, versão de sessões, hash e versão da credencial antes de inserir uma sessão com UUID aleatório novo. A aplicação só grava o cookie após confirmar a transação. O cookie carrega a referência interna da sessão, sem senha ou permissões. Cada consulta autenticada verifica o estado atual no banco. Logout confirma a revogação antes de apagar o cookie; falha do banco retorna erro e não anuncia sucesso.

As sessões têm validade absoluta de oito horas e inatividade máxima de trinta minutos. São escolhas explícitas desta implementação, sujeitas a revisão de produto. Revogação de uma sessão remota não resolve a política de comandos de um Connector desconectado.

POST exige Origin exatamente igual à configuração HTTPS. Não há confiança em Host ou cabeçalhos de proxy para essa comparação. O corpo exige JSON, no máximo 4096 bytes, UTF-8 válido, ausência de chaves duplicadas e exatamente `username` e `password`. Há prazo de cinco segundos para leitura. Senhas têm limite de 1024 bytes.

O PostgreSQL limita tentativas em janelas de quinze minutos: sessenta por endereço de transporte e quinze por username. Os identificadores dos contadores são hashes. Cabeçalhos `X-Forwarded-For` são ignorados; se o runtime não fornecer endereço, as solicitações compartilham um contador restritivo. Um proxy, portanto, pode compartilhar o limite entre usuários. Uma política de proxy confiável permanece pendente. Contadores antigos são removidos em lotes limitados. Falhas do limitador negam o login.

## Verificação e limites

Os testes de corpo usam `Request` real e o leitor JSON compartilhado. Os testes de cookie executam a implementação de selagem do Nuxt, com repositório de memória somente como substituto de persistência. Cobrem atributos do cookie, rejeição de bearer em cabeçalho, Origin, revogação, replay após logout e falha de armazenamento no logout. TypeScript da raiz e Nuxt passaram durante a implementação.

O coordenador executou `scripts/test-independent-login.ts` com PostgreSQL 17.11 descartável, a aplicação compilada em Node 24.20.0, proxy HTTPS temporário e Chromium real. Passaram login, rotação, consulta de identidade, logout e rejeição do cookie revogado; atributos do cookie e ausência de Domain; Origin ausente/cruzado, cookie adulterado e bearer somente em cabeçalhos; erros genéricos e corpos inválidos; páginas reais de entrada/saída; limite compartilhado entre dois processos Node; e rejeição com banco indisponível mesmo apresentando cookie válido. O script encerrou seus processos, navegador e proxy e removeu o certificado/diretório temporário.

`check:all` passou com 190 testes Bun, 95 testes Node e builds. Os doze testes Playwright existentes também passaram. Esses resultados comprovam o fluxo de login isolado, não a aceitação integrada da Fase 0. Continuam pendentes recuperação de conta, provisionamento de produção, auditoria operacional, medição de limites e pareamento autenticado. A autorização por fazenda foi verificada separadamente como serviço interno.

Para criar exclusivamente a conta sintética em um banco `fixture` descartável acessível por loopback:

```sh
AUTH_SYNTHETIC_TEST_DISPOSABLE=yes AUTH_SYNTHETIC_TEST_PORT=15433 bun scripts/create-disposable-account.ts
```

O script cria `fixture_user` com a senha pública de teste `synthetic-password-for-isolated-tests-only`. Não aceita URL nem credenciais de produção. A segunda execução falha pela unicidade, sem substituir uma conta existente. A instância PostgreSQL, seus dados e o processo da aplicação pertencem ao coordenador do teste e devem ser removidos ao terminar, preservando somente evidências necessárias.

As migrações 0005 e 0006 foram aplicadas, revertidas na ordem inversa, reaplicadas e revertidas novamente em um cluster PostgreSQL descartável isolado.
