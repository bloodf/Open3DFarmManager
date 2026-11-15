# Self-hosted upgrades

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
