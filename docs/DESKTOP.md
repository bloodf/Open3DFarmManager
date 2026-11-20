# Rodar o Open3DFarmManager no desktop

Este guia leva uma máquina de desktop do zero até uma página da farm com impressoras simuladas, sem Docker e sem rede externa. Os comandos abaixo são os mesmos que o `npm run desktop:check` exercita; a seção do README é a versão curta.

Os detalhes de cada etapa do check estão em [desktop-check.md](desktop-check.md). O bundle offline de dependências está em [desktop-offline-install.md](desktop-offline-install.md).

## Pré-requisitos

| Item          | Requisito                                                                                            | Observação                                                                                                                                |
| ------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Node.js       | 22.22.3+ ou 24.22.2+ (`package.json` declara `^22.22.3 \|\| >=24.22.2 <25`; o `.nvmrc` fixa 22.23.5) | O preflight do `desktop:check` aceita de 22.18 até 24.x, mas Nuxt e cssnano exigem 22.22.3+ na série 22. A aceitação desktop usa 22.23.5. |
| npm           | Incluído no Node.js                                                                                  | Não use pnpm: o lockfile é do npm.                                                                                                        |
| Google Chrome | Instalado no sistema                                                                                 | Defina `OPENFARM_CHROME_PATH` se ele não estiver em um caminho padrão. O Playwright não baixa navegadores offline.                        |
| PostgreSQL    | 17 ou superior (`initdb`, `pg_ctl`, `postgres`)                                                      | Os testes de banco exigem 17+.                                                                                                            |
| Go            | 1.26+, opcional                                                                                      | Só para o helper RTSP (`npm run build:rtsp-ingest`). Sem Go, esse passo é pulado e o resumo informa o motivo.                             |
| Docker        | Não necessário                                                                                       | Recusado por padrão. Veja [Chaves de ambiente](#chaves-de-ambiente).                                                                      |

## 1. Instalar as dependências

Com rede, a partir da raiz do repositório:

```sh
npm ci --ignore-scripts
```

Sem rede, use o bundle offline `linux-x64` descrito em [desktop-offline-install.md](desktop-offline-install.md):

```sh
mkdir -p "$HOME/openfarm-npm-cache"
tar -xzf open3dfarmmanager-npm-cache-linux-x64.tar.gz -C "$HOME/openfarm-npm-cache"
npm ci --offline --ignore-scripts --cache "$HOME/openfarm-npm-cache"
```

Para listar as lacunas do mirror e os pacotes de plataforma Linux x64 presentes no lockfile, sem rede:

```sh
node scripts/desktop-deps-report.mjs
```

O `.npmrc` mantém `ignore-scripts=true`. A instalação não executa scripts de pacotes.

## 2. Compilar

```sh
npm run build
```

Isso gera `apps/farm/.output/` e o Connector compilado.

## 3. Criar o banco local

O banco roda no próprio computador, escuta só em `127.0.0.1` e não usa Docker. O exemplo usa a porta `5433` e autenticação `trust`, adequada apenas a este cluster local de desenvolvimento.

```sh
export OPENFARM_DB_DIR="$HOME/openfarm-pg"
initdb -D "$OPENFARM_DB_DIR" -U openfarm --auth=trust
pg_ctl -D "$OPENFARM_DB_DIR" -o "-h 127.0.0.1 -p 5433" -l "$OPENFARM_DB_DIR/server.log" start
createdb -h 127.0.0.1 -p 5433 -U openfarm openfarm
```

Para o servidor aplicar as migrações ao iniciar:

```sh
export NUXT_DATABASE_ENABLED=true
export NUXT_DATABASE_DATABASE_URL=postgres://openfarm@127.0.0.1:5433/openfarm
export NUXT_DATABASE_MIGRATIONS=apply
```

Para parar o banco depois: `pg_ctl -D "$OPENFARM_DB_DIR" stop`.

## 4. Subir o servidor

Modo de desenvolvimento, com recarga automática:

```sh
npm run dev
```

Abra **http://127.0.0.1:3000**. Esse modo mostra a interface de desenvolvimento. Sem as variáveis de banco da etapa 3, não há contas nem persistência.

Modo compilado, depois de `npm run build`:

```sh
NITRO_HOST=127.0.0.1 NITRO_PORT=3000 node apps/farm/.output/server/index.mjs
```

## 5. Farm de demonstração com simuladores

Os simuladores (Moonraker sv06 e u1, Spoolman e câmera) são processos de teste em loopback. Não existe um comando persistente que os mantenha de pé para navegação manual:

- `npm run sim:verify` sobe os mocks, verifica as quatro ferramentas, a troca de extrusora, as webcams e o Spoolman, e encerra os mocks ao final.
- `npm run desktop:check -- --only app-smoke` sobe o banco descartável, os mocks, o Connector real e o app compilado; então carrega a rota **/farm** em uma porta livre de loopback no Chrome com todo host não local bloqueado no navegador. Exige `npm run build` antes.

Para abrir a página da farm no seu próprio Chrome, use o endereço do servidor da etapa 4 e acrescente `/farm`. As impressoras aparecem nessa página somente após o pareamento do Connector, que o `app-smoke` faz sozinho. O `app-smoke` verifica que a página carrega, renderiza texto e não contata hosts externos; ele não confere os nomes das impressoras na tela.

## 6. Verificar o ambiente

```sh
npm run desktop:check -- --list                  # nomes dos passos
npm run desktop:check                            # cada passo, em ordem
npm run desktop:check -- --only lint,build       # subconjunto (marcado como parcial)
npm run desktop:check -- --skip test-e2e --receipt receipt.json
```

Em Linux, para provar que nada sai da máquina, rode o check em um namespace de rede vazio, conforme [desktop-check.md](desktop-check.md#network-guard):

```sh
npm run desktop:check -- --require-isolated-network
```

O `desktop:check` não envia comandos a impressoras físicas. Ele registra cada tentativa de conexão não loopback e falha quando há alguma.

## Chaves de ambiente

| Variável               | Padrão                     | Efeito                                                                                                                                                                                                                     |
| ---------------------- | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENFARM_SIM`         | `mock`                     | `mock` usa os simuladores em processo e em loopback. `docker` é opt-in para o Compose de `infra/sim/` e é recusado pelo `desktop:check`.                                                                                   |
| `OPENFARM_PG`          | local                      | Cluster PostgreSQL descartável criado com `initdb`/`pg_ctl` em loopback. `docker` é opt-in e recusado pelo `desktop:check`. `OPENFARM_TEST_DATABASE_URL` aponta para um superusuário existente em vez de criar um cluster. |
| `OPENFARM_CHROME_PATH` | caminhos padrão do sistema | Chrome usado pelos testes de interface e pelo `app-smoke`.                                                                                                                                                                 |
| `DOCKER_HOST`          | não definido               | Se definido, o preflight falha: Docker não é permitido em uma execução de desktop.                                                                                                                                         |
| `NUXT_BAMBU_CLOUD`     | desligado                  | Mantenha desligado. Com `true`, o preflight falha.                                                                                                                                                                         |

## O que funciona offline e o que não funciona

- **Bambu Cloud:** desligada. A importação pela nuvem exige rede e fica fora do modo desktop.
- **Câmeras RTSP:** o helper de ingestão precisa de Go 1.26+ (`npm run build:rtsp-ingest`). Sem Go, a ingestão RTSP não é construída e o vídeo fica indisponível. O resumo do `desktop:check` informa o motivo.
- **WebRTC:** o binário nativo de `node-datachannel` pode estar ausente em um pacote offline. Sem ele, a conexão WebRTC falha fechada e a interface fica somente leitura. Não há fallback por TURN ou HTTP para comandos do navegador.
- **Impressoras físicas:** nenhum teste automatizado envia comandos a elas. O guia não muda isso.
- **Docker:** não é usado. Os simuladores em Compose e o PostgreSQL em contêiner são opt-in e ficam fora do caminho desktop.

## Limites conhecidos

- O preflight aceita Node a partir de 22.18 (piso do type stripping), mas o `package.json` declara `^22.22.3 || >=24.22.2 <25`: Nuxt, `@nuxt/*` e cssnano exigem `^22.22.3`, e a série 24 mantém o piso 24.22.2. Node 23 fica de fora porque essas dependências também o excluem. Use 22.23.5 (`.nvmrc`) ou 24.22.x.
- O `package-lock.json` ainda registra `>=24.22.2 <25` no campo `engines` da raiz. O npm não valida esse campo: o `npm ci --offline --engine-strict` passa no Node 22.23.5. O contrato é o do `package.json`.
- O fixture opt-in `scripts/test-telemetry-http-postgres.ts` em modo build (`TELEMETRY_HTTP_TEST_BUILT=yes`) exige exatamente Node 24.22.3. Ele não faz parte do `desktop:check`.
- O preflight aceita PostgreSQL 13 ou superior, mas os testes de banco exigem 17 ou superior. Use 17+.
- O `app-smoke` não confere nomes de impressoras na página da farm.
- `npm run dev` não é executado pelo `desktop:check`.
- Nada deste guia foi validado em hardware físico (not proven on hardware).
