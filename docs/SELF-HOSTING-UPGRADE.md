# Self-hosted upgrades

## Retenção de telemetria e histórico

Com `NUXT_TELEMETRY_PRUNE_ENABLED=true`, o servidor executa uma limpeza a cada hora. Os padrões retêm eventos de telemetria por 30 dias e histórico de trabalhos por 365 dias; cada execução apaga no máximo 500 linhas de cada tabela. Uma execução pode ser limitada por `NUXT_TELEMETRY_PRUNE_INTERVAL_MS` (60.000 a 86.400.000), `NUXT_TELEMETRY_PRUNE_TELEMETRY_RETENTION_DAYS` e `NUXT_TELEMETRY_PRUNE_JOB_HISTORY_RETENTION_DAYS` (1 a 3.650 dias), e `NUXT_TELEMETRY_PRUNE_BATCH_SIZE` (1 a 10.000 linhas). Se houver mais linhas expiradas, a próxima execução continua em outro lote.

Defina `NUXT_TELEMETRY_PRUNE_DATABASE_URL` para um usuário PostgreSQL dedicado, com associação somente ao papel `farm_telemetry_pruner` criado pela migração 0036. O papel não pode apagar diretamente tabelas: só pode executar a função limitada de retenção. A limpeza nunca acessa `farm.printer_latest_state`. A configuração é opcional e permanece desligada sem `enabled=true`.

Use a complete deployment Compose file containing `postgres`, `connector`, and the application. The repository database-only Compose file is insufficient. Every data mount must use an explicitly named volume. Keep the same Compose project, environment file, and volume names across releases. Keep credentials outside this repository.

The application image must interpolate `${O3DFM_VERSION}` and its environment must forward `${NUXT_DATABASE_MIGRATIONS}`. The command sets the latter to `apply`. Use immutable release tags. Configure `/readyz` to validate database readiness.

```sh
node scripts/self-host-upgrade.ts --version v2 --compose /private/deploy.yml --backup /private/backups/pre-v2.dump --dry-run
node scripts/self-host-upgrade.ts --version v2 --compose /private/deploy.yml --backup /private/backups/pre-v2.dump
```

Create the backup directory first. Use a new backup filename; existing files are never overwritten. Reserve at least 1 GiB and enough additional space for your database dump and image layers. Pause application writers before upgrading. Do not run concurrent upgrades or edit deployment configuration during an upgrade. Dry run prints the plan without contacting Docker.

The command validates the rendered deployment, checks backup disk space, dumps PostgreSQL, rechecks volume names, pulls images, starts services, and waits for readiness. It never removes volumes. Connector data stays in its existing volume. Command stderr and rendered environment are not printed.

On failure, execution stops. Keep the backup and all volumes. Stop application writers, select the previous release, and restore the dump with `pg_restore` into the dedicated database using your database administrator procedure. Start the previous release and verify `/readyz` before reopening access. A failed dump may leave a partial file: never use it as a confirmed backup. Restoring data can discard writes made after the backup; coordinate downtime and retain forensic copies first.

## Ensaio isolado antes do upgrade

Configure a imagem imutável da versão de destino e execute com um backup PostgreSQL em formato customizado (`pg_dump -Fc`):

```sh
export O3DFM_REHEARSAL_IMAGE=registry.example.org/open3dfarmmanager:v2
node scripts/self-host/rehearse-upgrade.ts --backup /private/backups/pre-v2.dump --to v2
# A opção --image registry.example.org/open3dfarmmanager:v2 substitui a variável.
```

A imagem deve seguir o contrato de `apps/farm/Dockerfile`: iniciar a aplicação, conter suas próprias migrações e aceitar `NUXT_DATABASE_ENABLED`, `NUXT_DATABASE_DATABASE_URL` e `NUXT_DATABASE_MIGRATIONS=apply`. A prontidão deve retornar `checks.database=ok` em `/readyz`. O ensaio não usa o código de migração do checkout para simular outra versão.

O comando gera um Compose privado com projeto `o3dfm-rehearse-<UUID>`, PostgreSQL 17 e rede interna sem portas publicadas. Não lê o Compose de produção, não monta o backup nem volumes existentes e não inicia o Connector. O backup é lido em memória e enviado à entrada de `pg_restore --exit-on-error --no-owner --no-acl`. Reserve RAM suficiente para o arquivo e espaço para os dados restaurados e as imagens. Use apenas backups confiáveis: a restauração executa SQL no banco descartável. O Docker deve estar disponível e conseguir obter as duas imagens.

Após restaurar, o ensaio conta as linhas das tabelas não sistêmicas e calcula SHA-256 dos registros de `farm.configuration_*`, ordenados por conteúdo JSON. Inicia a nova imagem com migrações habilitadas, aguarda a prontidão e para a aplicação antes de repetir a leitura. O relatório JSON contém contagens, divergências e checksums, sem registros de configuração. A tabela `public.open3dfarm_migrations` fica fora da comparação porque o upgrade altera seu histórico. Tabelas novas aparecem no relatório; tabelas de configuração novas e vazias não alteram o checksum. Perda de tabela, alteração de contagem existente ou mudança na configuração faz o comando sair com código 1. Mudanças intencionais exigem análise do operador; o ensaio não as aprova automaticamente.

O comando remove o volume e a rede do próprio projeto mesmo quando a restauração ou a migração falha. Se a limpeza falhar, retorna código 1 e informa o projeto e o manifesto temporário retido. Use exclusivamente esse manifesto e esse projeto para recuperar a limpeza, com `docker compose --project-name <projeto-informado> -f <manifesto-informado> down --volumes --remove-orphans`. Não use o Compose de produção nesse comando. Imagens obtidas permanecem no Docker para reutilização.

Este ensaio verifica dados e configuração persistidos no banco. Não valida permissões de produção, arquivos privados do Connector, hardware ou funcionamento dos comandos de impressão. O dump de uma única base não inclui papéis globais de PostgreSQL; referências a papéis ausentes fazem a restauração ou migração falhar, em vez de produzir um resultado positivo incompleto. Preserve a configuração externa do Connector e o backup original para o upgrade real.

## Ensaio real com duas revisões Docker (opt-in)

```sh
pnpm run test:upgrade-rehearsal # informa skip; não acessa Docker
OPENFARM_DOCKER_REHEARSAL=1 pnpm run test:upgrade-rehearsal
```

Use Node e pnpm nas versões do projeto, Docker com Compose e Buildx e pelo menos
10 GiB livres. O teste constrói `origin/main~1` e `HEAD` a partir de arquivos Git,
registra os SHAs completos e usa tags exclusivas. Não usa serviços de produção.
`check:all` não inclui este ensaio. A referência anterior deve ser ancestral do
checkout; o relatório registra a revisão efetivamente utilizada.

O teste cria uma conta, uma farm e a associação de proprietário pela API normal
`/api/auth/bootstrap` da versão anterior. Para os escritores, chama o caminho de
backup e upgrade de `scripts/self-host/upgrade.ts` e verifica prontidão e contagens
antes/depois. As imagens são locais: a etapa de pull valida sua existência em vez
de consultar um registro. O dump customizado também é restaurado em outra base
descartável e seu snapshot é comparado com o original.

Um volume separado guarda um arquivo privado de coleta v1 do Connector, sem
credenciais reais. O utilitário `scripts/connector-config-backup.ts` valida e copia
esse arquivo para backup e restauração; o teste compara bytes e SHA-256 após
recriar os serviços com a imagem atual. O serviço que mantém esse volume é passivo:
o ensaio comprova persistência da configuração, sem iniciar coleta nem conexões a
impressoras. Não comprova hardware nem upgrade de firmware.

Cada execução usa projeto, rede interna, volumes, tags e builder BuildKit próprios.
O bloco de limpeza remove os serviços, os volumes, a rede, as tags e o builder,
inclusive em falhas. Não executa prune global. Os logs e os relatórios
`baseline.json`, `report.json` e `cleanup.json` ficam em um diretório privado fora
do checkout, informado na saída. `OPENFARM_REHEARSAL_EVIDENCE` permite escolher esse
diretório. Se a limpeza falhar, o manifesto é retido e o teste falha.

### Evidência executada em 15/11/2026

No Docker OrbStack deste ambiente, o ensaio construiu a revisão anterior
`bdeba78d49fc46b724f2922c5969712edd3a188b` (`origin/main~1`) e a revisão atual
`8ed8e3d8004d5fd6e1ba94c903bbe5daa014472a`. Ambas usaram o Dockerfile do produto
e PostgreSQL 17. As 27 tabelas existentes conservaram suas contagens: uma conta,
uma credencial, uma farm, uma associação de proprietário, uma sessão, dois
registros de limite de autenticação e um watermark; as demais ficaram vazias.
O dump foi restaurado com sucesso em uma segunda base descartável.

A configuração de coleta v1 conservou o SHA-256
`29fd631b5dd188ab0ae48d8109cb75b44ef4cce3edb202b42ece82b080fa3c06`.
A restauração pelo utilitário do Connector produziu bytes idênticos aos do volume.
O teste registra os SHAs e contagens novamente em cada execução; este resultado
se aplica às revisões acima e aos dados descritos, sem afirmar cobertura de todas
as versões antigas ou de configurações reais de produção.

## Password reset

Owner-issued reset links are off by default. Set `NUXT_AUTH_PASSWORD_RESET=true` to enable them and grant the auth connection role `farm_password_reset`. See [Account creation](ACCOUNT-CREATION.md#password-reset-owner-issued-links).

OpenID Connect sign-in is off by default. Set `NUXT_AUTH_OIDC=true` only together with `NUXT_AUTH_ENABLED=true`, `NUXT_AUTH_OIDC_ISSUER` and `NUXT_AUTH_OIDC_CLIENT_ID`. Apply migration `0038_oidc_identities`. The connection role needs `farm_password_auth` to sign in and `farm_account_registration` to attach a new subject through an invite. See [Account creation](ACCOUNT-CREATION.md#openid-connect).
