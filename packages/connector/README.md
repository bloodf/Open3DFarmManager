# Open3DFarmManager Connector

Local Phase 0 CLI for Node.js >=22.18.0 <25. No package has been published. Build from this checkout with the project's installed npm dependencies:

```sh
npm run build -w @open3dfarmmanager/connector
node packages/connector/dist/cli.js --help
```

The built `dist/` directory includes `LICENSE`, `THIRD_PARTY.md` and `ZOD-LICENSE`. Keep these notices alongside `cli.js` in any distribution; copying only the bundled JavaScript omits required notices.

## Initialize and inspect local identity

Choose a private data directory owned by your OS user. Replace the example path below with that directory. Initialization is explicit; there is no default path and help/version do not create files.

```sh
node packages/connector/dist/cli.js init-identity --data-dir /path/to/private-data
node packages/connector/dist/cli.js identity --data-dir /path/to/private-data
```

`init-identity` creates an Ed25519 identity only when none exists, or reuses a valid existing identity. Repeating it preserves the key and fingerprint. `identity` only reads. Successful output is JSON containing algorithm, fingerprint and public SPKI; it does not contain the private key.

`init-identity` and `identity` are local only: no network request, no service. Initializing an identity does not register or authorize it with a farm.

## Pair and inspect status

```sh
node packages/connector/dist/cli.js pair --server https://farm.example --audience <audience> --data-dir /path/to/private-data --credential-file /path/to/private-data/credential.json
node packages/connector/dist/cli.js status --data-dir /path/to/private-data --credential-file /path/to/private-data/credential.json
```

`pair` needs an existing identity. It starts pairing, signs the server challenge with the identity (proof of key possession), then prints a short code and the local fingerprint. Confirm in the browser that the fingerprint is identical and approve the code; the server requires approval within 60 seconds of the proof. The CLI polls with the server-provided interval, retries transient network failures with capped backoff (five attempts) and stops at the pairing deadline (15 minutes). The credential is written with mode `0600` and is never overwritten; remove an old file deliberately. The credential path and its directory are checked before any network call (directory owned by you and not group/world writable), and the file is created atomically via a temporary file. Polling stops when the proof expires (a message asks you to start over). If a proof or claim response is lost, pairing fails closed: run `pair` again. `--audience` is the farm's configured pairing audience and is never taken from the server response.

`status` reads local state only and prints JSON: the identity fingerprint and, when `--credential-file` is given, credential presence, validity, expiry, agent and farm IDs. The device token is never printed. Persisted server or printer state does not exist locally yet, so none is reported.

On failure the CLI exits nonzero with a fixed pt-BR message. Existing corrupt identity data is not overwritten. Incomplete initialization may leave recovery files; do not delete them or generate replacement keys without reviewing [identity recovery constraints](../../docs/CONNECTOR-IDENTITY.md).

Private files are protected with OS ownership and permissions, not encryption. Windows remains unsupported until an ACL implementation exists. Keep the data directory private and do not commit it. Backup, rotation and credential storage remain unimplemented.

## Verification

The source and built CLI are tested against disposable temporary directories: initialization, repeat invocation, read-only inspection, unchanged private bytes, argument rejection, corrupt-file preservation and use of the persisted identity in a synthetic server challenge. No production identity, account or real device is used.

### Página de estado local

A página fica desativada por padrão. Para habilitá-la no processo `run`, acrescente
`--status-port 8080` aos argumentos existentes. Abra `http://127.0.0.1:8080/`.
`GET /status` fornece os mesmos dados em JSON para consulta por CLI, por exemplo
`curl --fail http://127.0.0.1:8080/status`.

A porta aceita inteiros de 1 a 65535. O listener usa somente o endereço literal
127.0.0.1, rejeita Host/Origin diferentes e métodos de mutação. Não exponha a porta
por proxy ou túnel. A página não autentica usuários locais do sistema operacional.
Ela mostra a profundidade real da fila, totais de envio/tentativas e expiração da
credencial. Não contém identidade, credenciais, caminhos, endpoints nem dados de
impressoras. Atualize a página para consultar novamente. Não há controle de
impressoras nem fallback de estado ao vivo da fazenda por HTTP.

O listener acompanha o `run`: falha ao ocupar a porta encerra o processo pelo fluxo
normal de limpeza; SIGINT/SIGTERM e falhas do agente fecham conexões e liberam o
listener antes de fechar a fila. `collect` não aceita a opção.

## Serviço systemd no Raspberry Pi

Use Raspberry Pi OS com systemd, Node.js 22.18 ou superior da série 22 e npm. Instale uma versão de Node compatível com a arquitetura do host em `/usr/bin/node`. Os comandos abaixo pressupõem um checkout desta versão do projeto e acesso administrativo. Consulte a documentação da fazenda para obter a URL HTTPS e o audience de pareamento.

1. No checkout, instale as dependências com `npm ci` e execute `npm run build -w @open3dfarmmanager/connector`. Crie a conta e instale o pacote completo, incluindo os avisos de licença:

   ```sh
   sudo useradd --system --home-dir /var/lib/openfarm-connector --shell /usr/sbin/nologin openfarm-connector
   sudo install -d -o openfarm-connector -g openfarm-connector -m 700 /var/lib/openfarm-connector
   sudo install -d -m 755 /opt/openfarm-connector
   sudo cp -R packages/connector/dist /opt/openfarm-connector/
   ```

2. Inicialize e pareie usando a conta do serviço. Substitua a URL e o audience pelos valores da sua fazenda; confira o fingerprint no navegador antes de aprovar o código.

   ```sh
   sudo -u openfarm-connector /usr/bin/node /opt/openfarm-connector/dist/cli.js init-identity --data-dir /var/lib/openfarm-connector
   sudo -u openfarm-connector /usr/bin/node /opt/openfarm-connector/dist/cli.js pair --server https://farm.example --audience AUDIENCE --data-dir /var/lib/openfarm-connector --credential-file /var/lib/openfarm-connector/credential.json
   sudo -u openfarm-connector /usr/bin/node /opt/openfarm-connector/dist/cli.js status --data-dir /var/lib/openfarm-connector --credential-file /var/lib/openfarm-connector/credential.json
   ```

3. Crie `/var/lib/openfarm-connector/runtime.json` com proprietário `openfarm-connector` e modo `600`. Configure os IDs retornados pelo pareamento e as atribuições da fazenda conforme [configuração de runtime](../../docs/CONNECTOR-AGENT-RUNTIME-CHECKPOINT.md) e o [exemplo de configuração](../../docs/HARDWARE-ACCEPTANCE-CHECKLIST.md#appendix-a-redacted-configuration-samples). Não publique esse arquivo nem a credencial.

4. Instale e inicie a unidade:

   ```sh
   sudo install -m 644 infra/systemd/open3dfarm-connector.service /etc/systemd/system/
   sudo systemd-analyze verify /etc/systemd/system/open3dfarm-connector.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now open3dfarm-connector.service
   systemctl status open3dfarm-connector.service
   journalctl -u open3dfarm-connector.service -e
   ```

   `active (running)` indica o processo ativo; confira também os logs e o estado da fazenda. Em caso de falha, corrija a configuração ou o pareamento antes de reiniciar.

5. Para atualizar, pare o serviço e preserve um backup privado da identidade, credencial e configuração. No checkout da nova versão, execute `npm ci` e o build acima. Execute a migração com a conta do serviço a partir do checkout atualizado:

   ```sh
   sudo systemctl stop open3dfarm-connector.service
   sudo -u openfarm-connector /usr/bin/node scripts/connector-config-migrate.ts /var/lib/openfarm-connector/runtime.json
   ```

   Se a migração falhar, mantenha o serviço parado e examine o erro e o backup. Após sucesso, substitua `/opt/openfarm-connector/dist` pelo novo diretório completo, instale a unidade atualizada se necessário, execute `sudo systemctl daemon-reload` e `sudo systemctl start open3dfarm-connector.service`. Confira o status e os logs como acima. A migração exige o código-fonte e as dependências da versão nova no checkout.
