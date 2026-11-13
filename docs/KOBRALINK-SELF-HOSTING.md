# Hospedar o KobraLink

Este guia descreve a preparação manual do serviço KobraLink e a configuração OpenFarm. O operador administra a instância; a pessoa que usa uma impressora continua usando a interface OpenFarm normal.

## Instalação

O repositório mantém o script `scripts/kobralink-source.mjs` para buscar e verificar o código upstream fixado em `infra/kobralink/upstream.lock`. Ele não inicia serviços. Escolha um destino absoluto fora do repositório e de todos os worktrees; o destino e seus ancestrais existentes devem pertencer ao usuário atual e não conter symlinks.

```sh
node scripts/kobralink-source.mjs --help
node scripts/kobralink-source.mjs fetch --destination /srv/openfarm/kobralink-src
node scripts/kobralink-source.mjs verify --destination /srv/openfarm/kobralink-src
```

Use apenas subcomandos e opções exibidos pelo `--help` da versão atual; `fetch` e `verify` ilustram a sequência suportada. O checkout é externo e não deve ser copiado para o repositório. Confira [THIRD_PARTY.md](../THIRD_PARTY.md) e os avisos upstream antes de distribuir componentes.

A receita [infra/kobralink/docker-compose.yml](../infra/kobralink/docker-compose.yml) requer `KOBRALINK_SRC` apontando ao checkout verificado. Seu serviço usa volume SQLite próprio, segredo Better Auth próprio e publica a porta de gerenciamento somente em `127.0.0.1`. Não publica Moonraker. A receita não inicia automaticamente: revisão e execução são atos explícitos do operador. Não exponha a porta de gerenciamento publicamente.

## Configuração

O servidor lê a configuração autoritativa de `OPEN3DFARM_CONFIGURATION`; veja [a documentação de configuração](CONFIGURATION.md) e [implantação](DEPLOYMENT.md) para os campos completos. Configure uma instância e credenciais independentes: origem HTTPS de autenticação, banco dedicado, chaves privadas do emissor e respectivos pins públicos independentes. Não reutilize contas, banco, sessão ou segredos de outro produto. Não invente valores: use os formatos e validadores descritos nos documentos vinculados.

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
node packages/connector/dist/cli.js configure --help
node packages/connector/dist/cli.js configure --provisioning /caminho/privado/provisioning.json --data-dir /caminho/privado/dados --credential-file /caminho/privado/credential.json --check
```

O JSON de provisionamento deve corresponder ao schema aceito por `packages/connector/src/config/provisioning.ts`; não fabrique campos. `--check` verifica configuração sem aplicar provisionamento. Proteja diretório e arquivos contra leitura por outros usuários. Para conta, banco e pareamento, siga [implantação](DEPLOYMENT.md), [criação de conta](ACCOUNT-REGISTRATION.md) e [pareamento](PAIRING.md), conforme disponíveis nesta instalação.

Não há segundo painel ou login KobraLink para usuários OpenFarm, iframe ou fallback de comandos HTTP. O transporte genérico da arquitetura não significa suporte ao adaptador KobraLink.

## Recuperação

- **Bridge indisponível:** verifique se o processo Connector está em execução, se a rede local alcança a ponte configurada e se o estado local mostra a credencial válida; corrija endereço/conectividade e reinicie o Connector pelo procedimento operacional. Não publique a porta de gerenciamento para contornar a falha.
- **Telemetria desconhecida ou antiga:** trate-a como indisponível. Confirme a conectividade e aguarde uma nova leitura confirmada antes de qualquer operação que dependa do estado; estado degradado é somente leitura.
- **Confirmação de inventário pendente:** não repita criação. Aguarde ou recupere a resposta da mesma operação e confirme seu inventário no servidor.
- **ACK perdido ou nova sessão:** autorize e envie o status da mesma operação; só depois passe uma nova confirmação de inventário do servidor. Não crie outra operação para substituir a primeira.
- **Controle não suportado:** não tente contornar pela interface KobraLink, HTTP ou acesso direto. Use apenas controles explicitamente habilitados na interface OpenFarm.

## Limites de validação

A integração não qualifica câmera nem controles físicos para este adaptador. Firmware e hardware Kobra X ainda não foram qualificados; também permanecem pendentes a qualificação final da interface e do RTC. Não interprete a arquitetura genérica de transporte como validação desses recursos. Confira [avisos de terceiros](../THIRD_PARTY.md) e avisos de origem/licença upstream; este guia não faz conclusão jurídica.
