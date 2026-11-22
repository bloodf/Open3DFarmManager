# Sandbox local de integrações

Com as dependências do workspace instaladas, execute `node scripts/sandbox.ts`.
O comando requer Docker Compose local com suporte a `!override` e OpenSSL.
Ele compila o aplicativo e o Connector quando os artefatos ainda não existem,
inicia Klipper e Bambu simulados e imprime as variáveis de ambiente para consultar a API em HTTPS. As portas do
host são efêmeras e vinculadas a `127.0.0.1`. Após alterar o código, execute
`npm run build` antes de reiniciar o sandbox.

As credenciais OAuth têm os escopos `printers:read` e `inventory:read` na
fazenda de sandbox. Use o certificado local indicado na saída para validar
a conexão TLS. Guarde a saída do comando em um local privado.

Para testar o cliente de referência, aplique as variáveis impressas e execute:

```sh
OPENFARM_INTEGRATION_E2E=1 node --test --test-force-exit tests/node/integration-client-example.test.ts
```

`node scripts/sandbox.ts stop` interrompe os serviços e conserva a fazenda.
A credencial inicial do Connector vale uma hora. Quando ela expirar, execute
`node scripts/sandbox.ts down` para descartar a fazenda local e depois execute
`node scripts/sandbox.ts` para criar outra.
