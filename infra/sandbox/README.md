# Sandbox local de integrações

Com as dependências do workspace instaladas, execute `node scripts/sandbox.ts`.
O comando requer Docker Compose local com suporte a `!override` e OpenSSL.
Ele compila o aplicativo e o Connector quando os artefatos ainda não existem,
inicia Klipper e Bambu simulados e imprime as variáveis de ambiente para consultar a API em HTTPS. As portas do
host são efêmeras e vinculadas a `127.0.0.1`. Após alterar o código, execute
`npx nuxt build infra/sandbox` e `npm run build -w @open3dfarmmanager/connector` antes de reiniciar o sandbox.

As credenciais OAuth incluem leitura de impressoras, estoque, arquivos e histórico,
envio de trabalhos e ações de controle na fazenda de sandbox. O Connector
simulado recebe envelopes assinados por uma chave criada para esse sandbox;
os comandos continuam sujeitos às verificações de segurança do Connector.
O sandbox usa arquivos e impressoras simulados; o Klipper e o Bambu aceitam
trabalhos e cancelamentos, e o histórico registra a duração das impressões.
Use o certificado local indicado na saída para validar
a conexão TLS. Guarde a saída do comando em um local privado.

Para testar o cliente de referência, aplique as variáveis impressas e execute:

```sh
OPENFARM_INTEGRATION_E2E=1 node --test --test-force-exit tests/node/integration-client-example.test.ts
```

`node scripts/sandbox.ts stop` interrompe os serviços e conserva a fazenda.
O estado fica em `XDG_STATE_HOME/open3dfarmmanager` ou, se a variável não
estiver definida, em `~/.local/state/open3dfarmmanager`. Instalações que usavam
o diretório temporário começam uma nova fazenda nesse local persistente.
A mudança na configuração inicial exige `node scripts/sandbox.ts down` e uma
nova execução para recriar uma fazenda de sandbox anterior.
A credencial inicial do Connector vale uma hora. Quando ela expirar, execute
`node scripts/sandbox.ts down` para descartar a fazenda local e depois execute
`node scripts/sandbox.ts` para criar outra.

Em cada inicialização, as migrações pendentes são aplicadas antes de iniciar o
aplicativo. Se uma migração falhar, a inicialização é interrompida; corrija a
causa e execute o comando novamente. As credenciais e a fazenda existentes são
preservadas. Cada diretório de estado canônico tem seu próprio projeto Compose.
Um sandbox anterior é adotado quando o volume PostgreSQL existente comprova,
pelas opções e etiquetas do Docker, que pertence ao diretório de estado atual. Se esse
volume não existir ou não comprovar a associação, o projeto antigo não é
adotado automaticamente.
