# Linha de base de instalação própria

Data de corte: 2026-11-13. Produto base `bad76165aa4fbe86949ae624ddedc973721d5fcf`; HEAD inspecionado `ba9c2e6031dbea6793b6fb89e97242d5d19c7def`. Diagnóstico estático; runtime NOT_RUN. Status de evidência: apenas fonte; este relatório não executou testes de produto. Qualificação sintética nesta frente autorizada permanece como próximo trabalho; hardware, deploy e credenciais exigem autorização separada.

## README.md

Node 24.22.2, engine >=24.22.2 <25; pnpm 12.18.0. Instalação: pnpm install --frozen-lockfile --ignore-scripts; interface: pnpm run dev. Imagem usa node:24.22.2-alpine e inicia node server/index.mjs como UID 10001, copiando migrations. Não configura contas automaticamente.

Fontes inspecionadas: `README.md; package.json; apps/farm/Dockerfile`.

## docs/LOCAL-CI.md

Verificação prevista: bash scripts/test-local-ci.sh; bash scripts/local-ci.sh code; pnpm run check:all; pnpm exec playwright install chromium; pnpm run test:e2e após build. Ubuntu CI usa pnpm exec playwright install --with-deps chromium. Chromium e bibliotecas do SO devem ser preparados separadamente. Instalação com --ignore-scripts não comprova preparação de módulos nativos. Experimentos RTC e farm-view são separados.

Fontes inspecionadas: `docs/LOCAL-CI.md; scripts/local-ci.sh; .github/workflows/ci.yml`.

## infra/app/docker-compose.yml

Banco dedicado: docker compose -f infra/app/docker-compose.yml up -d, somente com configuração e autorização futuras. O3DFM_DB_PASSWORD obrigatório; volume nomeado app-db-data em /var/lib/postgresql/data, nome derivado de COMPOSE_PROJECT_NAME. PostgreSQL 17 fixado em sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b. Recriar container preserva volume quando mantido; remover volume perde dados. Bootstrap superuser exige criação separada de migrator e login restrito.

Fontes inspecionadas: `infra/app/docker-compose.yml; docs/DATABASE-MIGRATIONS.md`.

## scripts/db/migrations.ts: migrationCatalog, runMigrations

Catálogo pareado e checksums; journal public.open3dfarm_migrations; advisory lock e SQL/journal na mesma transação. CLI node scripts/migrate-disposable-db.ts up exige MIGRATION_SYNTHETIC_TEST_DISPOSABLE=yes e MIGRATION_SYNTHETIC_TEST_PORT, host loopback e fixture. down EXACT_LAST_ID pode destruir dados. Não é procedimento de produção.

Fontes inspecionadas: `scripts/db/migrations.ts: migrationCatalog, runMigrations; scripts/migrate-disposable-db.ts`.

## apps/farm/server/plugins/database-lifecycle.ts

Plugin chama beginDatabaseStartup, que valida configuração e mesmo destino dos bancos antes de startDatabaseRuntime. Falha encerra com código 1; build/prerender não toca banco. NUXT_DATABASE_ENABLED=true, NUXT_DATABASE_DATABASE_URL, NUXT_DATABASE_MIGRATIONS=verify ou apply e NUXT_DATABASE_MIGRATIONS_DIR configuram startup. Verify é padrão; apply requer migration owner. Documentação admite journal ahead sob pressuposto expand/contract, não prova compatibilidade de todo upgrade.

Fontes inspecionadas: `apps/farm/server/plugins/database-lifecycle.ts; apps/farm/server/utils/database/lifecycle.ts: beginDatabaseStartup; docs/DATABASE-MIGRATIONS.md`.

## packages/connector/src/cli.ts

CLI init-identity --data-dir cria ou reutiliza; identity --data-dir apenas lê. Identidade existente não é sobrescrita; publicação usa hard link, fsync e lock. Diretório 0700 e arquivos 0600, usuário atual; corrupção falha sem regenerar chave. Preservar data-dir; recuperação de lock/pending requer análise, não remoção automática.

Fontes inspecionadas: `packages/connector/src/cli.ts; packages/connector/src/identity/store.ts: loadOrCreateIdentity; docs/CONNECTOR-IDENTITY.md`.

## packages/connector/src/config/local.ts: readPrivateJsonFile

run --config <arquivo> --credential-file <segredo> --data-dir <dir> recebe caminhos explícitos. Leitura privada rejeita links, proprietário/permissões inválidos e Windows; não regrava configuração. Credencial deve coincidir com fingerprint e não estar expirada. Preservar configuração e envelope não dispensa validade/revogação.

Fontes inspecionadas: `packages/connector/src/config/local.ts: readPrivateJsonFile; packages/connector/src/config/credential.ts: readRuntimeCredential; packages/connector/src/cli.ts`.

## docs/SESSION-PERSISTENCE-CONTRACT.md

Backup/restore exige impedir reativação de sessões revogadas; contrato aponta epoch separado ou invalidação obrigatória, mas procedimento permanece pendente. Persistência normal e transação não equivalem a backup ou garantia contra perda de energia.

Fontes inspecionadas: `docs/SESSION-PERSISTENCE-CONTRACT.md; docs/CONNECTOR-IDENTITY.md`.

## Limites e próximos passos

Resta qualificar instalação limpa, preparação nativa por SO e arquitetura, upgrade e restauração com dados sintéticos. Nenhum comando de runtime foi executado.

Não foi identificado procedimento operacional completo de backup/restore nas buscas limitadas em docs e scripts. Existem migração e persistência implementadas.

Documentos antigos de identidade dizem que pareamento não existe; CLI atual contém pair. Não usar esse texto histórico como inventário atual.

Firmware/hardware desconhecido; sem alegação de suporte.

Definir retenção e restauração de banco, roles, configuração externa e identidade, incluindo invalidação de sessões.

Qualificar com dados sintéticos em ambiente descartável nesta frente autorizada; hardware, deploy e credenciais mantêm autorização separada.

CodeGraph 1.6.2 sem índice; query/explore tentados, fallback por buscas limitadas. Ledger privado registra observação atual de disco, Git e worktrees; ledger anterior ausente. Nenhum baseline histórico foi reconstruído. Nenhuma instalação, serviço, build ou hardware executado.

## PRs abertos observados

Inventário read-only por título e arquivos, sem análise completa dos diffs, custody ou merge. Lista inclui branches de preservação; seus arquivos estão no JSON. PRs 102 e 114 concorrem na atualização Node. 123 altera PostgreSQL; 101 altera cliente PostgreSQL; 154 credenciais de signalling; 152 persistência da fila; 122 e 98 imagens de integração. Demais dependências e branches preservadas podem afetar runtime e requerem revisão antes de integração.

- [test(signalling): record why an HTTPS harness cleanup step failed](https://github.com/bloodf/Open3DFarmManager/pull/155), HEAD `49d98d13bc1b968a4176b32c5ae2de6f5f559c7f`.
- [feat(farm): accept renewed Connector credentials on signalling](https://github.com/bloodf/Open3DFarmManager/pull/154), HEAD `a9c526419ad2b14787b90adbcc7f6302449189e6`.
- [fix(connector): release queue locks on failed publish and keep the lock error](https://github.com/bloodf/Open3DFarmManager/pull/152), HEAD `4b677a4b85dbb7711a5e1d7c25ab5e00a7ec4107`.
- [test(rtc): farm-page row against genuine simulators and Spoolman](https://github.com/bloodf/Open3DFarmManager/pull/151), HEAD `a0f7387d4d75c2db80f49eadbf1409b8c696f222`.
- [feat(sim): network fault harness and two-printer simulator acceptance](https://github.com/bloodf/Open3DFarmManager/pull/148), HEAD `28dfe6eac8d581567bd260c29eddd75753e6aa15`.
- [chore(deps): update postgres:17 docker digest to 846a7dd](https://github.com/bloodf/Open3DFarmManager/pull/123), HEAD `f08b108949fb9feec4203cf9a12944d249f5a532`.
- [chore(deps): update bluenviron/mediamtx docker digest to 59e4355](https://github.com/bloodf/Open3DFarmManager/pull/122), HEAD `0a5d7dbe02c0e6a5d0b76c8e5014fb5abc772b69`.
- [chore: bump pinned Node.js to 24.22.3](https://github.com/bloodf/Open3DFarmManager/pull/114), HEAD `1ca2714834a92a5c0b1f99adf354bd306cd6d549`.
- [chore(deps): update dependency prettier to v3.10.1](https://github.com/bloodf/Open3DFarmManager/pull/103), HEAD `b19ad7c2277acfa59abb12d0ae8e9dafc29f27a3`.
- [chore(deps): update node.js to v24.22.3](https://github.com/bloodf/Open3DFarmManager/pull/102), HEAD `e6479f7985a67b1c86a5f604b4851ccd5a69fd82`.
- [fix(deps): update dependency postgres to v4.1.1](https://github.com/bloodf/Open3DFarmManager/pull/101), HEAD `1bc1be699e5d34440bb7749969c1191a383e08db`.
- [fix(deps): update dependency vue-router to v5.5.0](https://github.com/bloodf/Open3DFarmManager/pull/100), HEAD `097533db47d1f499cd91058c24a902a688bb54e3`.
- [fix(deps): update dependency effect to v4.1.4](https://github.com/bloodf/Open3DFarmManager/pull/99), HEAD `2a2268b3b7a3654a1a4aa1c50507818a66997645`.
- [chore(deps): update ghcr.io/mainsail-crew/virtual-klipper-printer docker digest to 27ea11e](https://github.com/bloodf/Open3DFarmManager/pull/98), HEAD `c0f5a69130ea4148e48dd98db1cb4e09c769e0c7`.
- [chore: preserve paused mac 55f15eee28ec for review](https://github.com/bloodf/Open3DFarmManager/pull/96), HEAD `f03b6bb3d78775cfd295a899e8532b85e8378546`.
- [chore: preserve paused mac e1ebdf35fe1a for review](https://github.com/bloodf/Open3DFarmManager/pull/95), HEAD `bc5ec3bf2c6018010b150dff9c25bdae67824537`.
- [chore: preserve paused mac 75c3f492c761 for review](https://github.com/bloodf/Open3DFarmManager/pull/94), HEAD `33c0201ae08ee9c3e7af1289e1e2a0ff18c6bd73`.
- [chore: preserve paused mac c221ce8cf589 for review](https://github.com/bloodf/Open3DFarmManager/pull/93), HEAD `78c085da7c8d9e03c10ec77aebd3dd62f19178c5`.
- [chore: preserve paused mac 66cb33a4dc0b for review](https://github.com/bloodf/Open3DFarmManager/pull/92), HEAD `7bf46202996ec4d81a6524bae07a40b5228e81fc`.
- [chore: preserve paused mac e5de8131b6ee for review](https://github.com/bloodf/Open3DFarmManager/pull/91), HEAD `46fff855fc004cfcf2a9bb8d357be7aeadafba4e`.
- [chore: preserve paused mac 6c69aa9807fe for review](https://github.com/bloodf/Open3DFarmManager/pull/90), HEAD `22c2404c034fb2b8ec3fc52412d4f823a8554454`.
- [chore: preserve paused mac 93532f51e7ce for review](https://github.com/bloodf/Open3DFarmManager/pull/89), HEAD `5cc39e875074c728909f6882d54bfb42896bea6b`.
- [chore: preserve paused mac bd5a48092b88 for review](https://github.com/bloodf/Open3DFarmManager/pull/88), HEAD `f9797021b11994747191fc0674f3671eba403a02`.
- [chore: preserve paused mac 609f0bfcaeb6 for review](https://github.com/bloodf/Open3DFarmManager/pull/87), HEAD `d591f1ecd30f86a75cb73016d4cb0740fbed6497`.
- [chore: preserve paused mac beceb9f49057 for review](https://github.com/bloodf/Open3DFarmManager/pull/86), HEAD `63af2c11dfd55e9ca63e60b2ea18f31f78ec53e3`.
- [chore: preserve paused mac 0a7d899535da for review](https://github.com/bloodf/Open3DFarmManager/pull/85), HEAD `612e6b116d3c6c3c78adc664ac3c0f9aeb7c5c54`.
- [chore: preserve paused mac 3f5dd3da0b62 for review](https://github.com/bloodf/Open3DFarmManager/pull/84), HEAD `e22f9a49078e9f453594fa65e163eb63c578f4d9`.
- [chore: preserve paused mac 0631f078f1db for review](https://github.com/bloodf/Open3DFarmManager/pull/83), HEAD `86b3605a05c49415413720c5a3ad78fc9c4db4cf`.
- [chore: preserve paused mac eaebddbb5028 for review](https://github.com/bloodf/Open3DFarmManager/pull/82), HEAD `a1a6bab3ed79667ce06e3dea6659ad8c02c66407`.
- [chore: preserve paused cortex 3269cf585c90 for review](https://github.com/bloodf/Open3DFarmManager/pull/81), HEAD `a1095feb8299c89137fefd4ba583acdfd3936c37`.
- [chore: preserve paused cortex 7d258abb4c1b for review](https://github.com/bloodf/Open3DFarmManager/pull/80), HEAD `dee9add8c292401dd2ebcda4c5fa7b1edc2a547e`.
- [chore: preserve paused cortex 645c9d5cd25e for review](https://github.com/bloodf/Open3DFarmManager/pull/79), HEAD `04b61fbcd2ab8bbf265be17a4225d3e655edcf61`.
- [chore: preserve paused cortex 718f8f1cbad2 for review](https://github.com/bloodf/Open3DFarmManager/pull/78), HEAD `badf9d8a21bbc713de93ca8455aff2d7a7d6ea8a`.
- [fix(deps): update dependency jose to v6.2.17](https://github.com/bloodf/Open3DFarmManager/pull/77), HEAD `2a94dd285f84cb24e2feccb4aa54d431492ca102`.
- [fix(deps): update dependency ws to v8.23.0](https://github.com/bloodf/Open3DFarmManager/pull/76), HEAD `667b1d477dc8817927d4054086eb4546d376987d`.
