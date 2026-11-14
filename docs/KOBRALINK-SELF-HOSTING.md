# Hospedar o KobraLink

Este guia descreve a preparação manual do serviço KobraLink e a configuração OpenFarm. O operador administra a instância; a pessoa que usa uma impressora continua usando a interface OpenFarm normal.

## Instalação

O repositório mantém o script `scripts/kobralink-source.mjs` para buscar e verificar o código upstream fixado em `infra/kobralink/upstream.lock`. Ele não inicia serviços. Escolha um destino absoluto fora do repositório e de todos os worktrees; o destino e seus ancestrais existentes devem pertencer ao usuário atual e não conter symlinks.

```sh
node scripts/kobralink-source.mjs clone /srv/openfarm/kobralink-src
node scripts/kobralink-source.mjs verify /srv/openfarm/kobralink-src
```

A sintaxe é `<verify|clone> <external-destination-path>`; `--help` imprime o uso e termina com código 1. O checkout é externo e não deve ser copiado para o repositório. Confira [THIRD_PARTY.md](../THIRD_PARTY.md) e os avisos upstream antes de distribuir componentes.

A receita [infra/kobralink/docker-compose.yml](../infra/kobralink/docker-compose.yml) requer `KOBRALINK_SRC` apontando ao checkout verificado. Seu serviço usa volume SQLite próprio, segredo Better Auth próprio e publica a porta de gerenciamento somente em `127.0.0.1`. Não publica Moonraker. A receita não inicia automaticamente: revisão e execução são atos explícitos do operador. Não exponha a porta de gerenciamento publicamente.

## Configuração

O servidor lê um objeto JSON privado de `OPEN3DFARM_CONFIGURATION`. Sem `enabled: true`, a configuração permanece desativada. Habilitar não prova readiness: o lifecycle exige banco migrado, papéis restritos, autenticação HTTPS com timeout ocioso de 1800000 ms, registro público válido e chave persistente válida.

Prepare o objeto abaixo substituindo todos os marcadores antes de serializá-lo na variável de ambiente privada (os marcadores não são valores válidos):

```json
{
  "enabled": true,
  "publicKeyRegistryPath": "/srv/openfarm/private/telemetry-public-keys.json",
  "databaseUrl": "postgresql://<configuration-user>:<password>@<db-host>/<database>",
  "proofDatabaseUrl": "postgresql://<credential-acceptor-user>:<password>@<db-host>/<database>",
  "issuerKeyPath": "/srv/openfarm/private/configuration-issuer.json",
  "issuerPublicKeySpki": "<pin-SPKI-DER-base64url-da-chave-Ed25519-59-caracteres>",
  "issuer": "<emissor-configurado>",
  "kid": "<identificador-da-chave>",
  "audience": "<audiencia-configurada>",
  "credentialIssuer": "<emissor-das-credenciais>",
  "credentialAudience": "<audiencia-das-credenciais>",
  "tokenTtlSeconds": 300,
  "proofTtlMs": 10000
}
```

Os TTLs acima são escolhas do operador: os limites são 86400 segundos e 30000 ms. `databaseUrl` usa o papel `farm_configuration_authority`; `proofDatabaseUrl` usa `farm_connector_credential_acceptor`. São conexões com usuários distintos ao mesmo banco/host/porta, sem superusuário, propriedade do banco/esquema ou papéis adicionais. Não são o SQLite do KobraLink. Prepare migrações e autenticação seguindo [banco](DATABASE-MIGRATIONS.md) e [conta](ACCOUNT-CREATION.md).

Persista a chave de assinatura e confira seu pin público; não a regenere a cada inicialização nem reutilize a chave de pausa. O formato é validado por [issuer-key.ts](../apps/farm/server/utils/configuration/issuer-key.ts). Restrinja arquivos privados a `0600` e diretórios a `0700`. Origem HTTPS do login, emissor e audiências devem corresponder aos valores provisionados; consulte [pareamento](PAIRING-CONTRACTS.md). Não reutilize contas, banco, sessão ou segredos de outro produto.

Para a receita Compose, prepare um arquivo de ambiente privado com `KOBRALINK_SRC` (checkout externo verificado), `KOBRALINK_AUTH_SECRET` (segredo exclusivo) e, opcionalmente, `KOBRALINK_MGMT_PORT` (porta local; padrão 7100). Exemplo de nomes, não de segredos:

```dotenv
KOBRALINK_SRC=/srv/openfarm/kobralink-src
KOBRALINK_AUTH_SECRET=<segredo-aleatorio-exclusivo>
KOBRALINK_MGMT_PORT=7100
```

Restringa esse arquivo ao usuário operador (modo `0600`) e não o registre no Git, navegador ou logs. O Compose fixa `DATABASE_URL=file:/data/kobralink.db`, `BETTER_AUTH_URL` em loopback, desativa atualização e origens extras. O arquivo não substitui a configuração do OpenFarm.

O Connector faz bootstrap local da conta de máquina durante o provisionamento autorizado; credenciais permanecem no ambiente local protegido e não são mostradas ao navegador. Configure-o pela CLI existente, após build documentado em [README do Connector](../packages/connector/README.md):

```sh
pnpm --dir packages/connector build
node packages/connector/dist/cli.js --help
node packages/connector/dist/cli.js configure --provisioning /caminho/privado/provisioning.json --data-dir /caminho/privado/dados --credential-file /caminho/privado/credential.json --check
```

A ajuda é global; `configure --help` é rejeitado pelo parser. `--check` lê identidade e credencial existentes, confere escopo e validade e informa readiness local sem iniciar o serviço ou aplicar provisionamento. Não substitui a qualificação da conexão.

O JSON de provisionamento deve corresponder ao schema aceito por `packages/connector/src/config/provisioning.ts`; não fabrique campos. `--check` verifica configuração sem aplicar provisionamento. Proteja diretório e arquivos contra leitura por outros usuários. Para conta, banco e pareamento, siga [migrações](DATABASE-MIGRATIONS.md), [criação de conta](ACCOUNT-CREATION.md) e [pareamento](PAIRING-CONTRACTS.md).

Não há segundo painel ou login KobraLink para usuários OpenFarm, iframe ou fallback de comandos HTTP. O transporte genérico da arquitetura não significa suporte ao adaptador KobraLink.

## Recuperação

- **Bridge indisponível:** verifique se o processo Connector está em execução, se a rede local alcança a ponte configurada e se o estado local mostra a credencial válida; corrija endereço/conectividade e reinicie o Connector pelo procedimento operacional. Não publique a porta de gerenciamento para contornar a falha.
- **Telemetria desconhecida ou antiga:** trate-a como indisponível. Confirme a conectividade e aguarde uma nova leitura confirmada antes de qualquer operação que dependa do estado; estado degradado é somente leitura.
- **Confirmação de inventário pendente:** não repita criação. Aguarde ou recupere a resposta da mesma operação e confirme seu inventário no servidor.
- **ACK perdido ou nova sessão:** autorize e envie o status da mesma operação; só depois passe uma nova confirmação de inventário do servidor. Não crie outra operação para substituir a primeira.
- **Controle não suportado:** não tente contornar pela interface KobraLink, HTTP ou acesso direto. Use apenas controles explicitamente habilitados na interface OpenFarm.

## Limites de validação

A integração não qualifica câmera nem controles físicos para este adaptador. Firmware e hardware Kobra X ainda não foram qualificados. A evidência atual da interface e do RTC, com seus limites, está no [registro de aceitação RTC](KOBRALINK-RTC-ACCEPTANCE.md). Não interprete a arquitetura genérica de transporte como validação desses recursos. Confira [avisos de terceiros](../THIRD_PARTY.md) e avisos de origem/licença upstream; este guia não faz conclusão jurídica.
