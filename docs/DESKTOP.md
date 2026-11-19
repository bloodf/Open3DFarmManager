# Desktop offline

Prepare um Linux x64 com Node.js 22.18 ou superior, npm, Google Chrome e os executáveis PostgreSQL (`initdb`, `pg_ctl` e `postgres`, versão 13 ou superior). O `package.json` deste checkout exige Node 24.22.2 ou superior e inferior a 25; use essa versão para instalar o projeto. Go 1.26 ou superior é opcional e necessário para compilar o helper de câmeras RTSP. Instale tudo antes de bloquear a rede.

Com rede disponível, instale as dependências na raiz do repositório:

```sh
npm ci --ignore-scripts
```

Para uma máquina sem rede, gere em outra máquina um cache para Linux x64 e transfira o arquivo com o código do mesmo checkout. Veja [o guia do cache offline](desktop-offline-install.md) para detalhes e limitações de arquitetura.

```sh
node scripts/desktop-bundle.mjs --out /tmp/open3dfarmmanager-npm-cache-linux-x64.tar.gz
```

No desktop, extraia o arquivo transferido e instale a partir dele:

```sh
mkdir -p /tmp/openfarm-npm-cache
tar -xzf open3dfarmmanager-npm-cache-linux-x64.tar.gz -C /tmp/openfarm-npm-cache
npm ci --offline --ignore-scripts --cache /tmp/openfarm-npm-cache
```

Para verificar o conjunto offline, execute:

```sh
npm run desktop:check
```

O teste cria um cluster PostgreSQL local isolado e temporário, inicia mocks de impressoras e Spoolman, compila o servidor e abre `/farm` no Chrome. Ele encerra os recursos ao terminar. O teste atual verifica que a página carrega e contém texto; não comprova que os cartões de impressoras aparecem. Consulte [desktop-check.md](desktop-check.md) para isolamento de rede, opções e resultados.

Para executar a interface de desenvolvimento, use `npm run dev` e abra http://127.0.0.1:3000/farm no Chrome. Como alternativa, execute `npm run build` e depois `node apps/farm/.output/server/index.mjs`. Esses comandos não criam contas, banco ou farm de demonstração. Configure banco e autenticação conforme [DATABASE-MIGRATIONS.md](DATABASE-MIGRATIONS.md); a página depende da flag `farmView` e de acesso autorizado. Ainda não há comando documentado para manter a farm simulada aberta interativamente.

Os testes usam mocks locais por padrão. `OPENFARM_SIM=docker` e `OPENFARM_PG=docker` selecionam caminhos Docker explícitos em runners compatíveis; `desktop:check` rejeita ambos. Bambu cloud permanece desligada offline. Sem Go, o helper RTSP não é compilado e câmeras RTSP ficam indisponíveis. Sem conexão WebRTC direta, o navegador fica em modo somente leitura; comandos continuam sujeitos à autorização e às verificações do Connector.
