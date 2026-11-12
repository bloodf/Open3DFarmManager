# Experimentos locais de transporte WebRTC

A prova original deste pacote privado MIT comprova um RTCDataChannel real e criptografado entre dois peers nativos do Chromium. Um peer representa o navegador e o outro representa um Connector sintético. Não executa o Connector de produção, não acessa impressoras e não contém despacho de comandos. O único dado aceito é o literal `fixture-idle`, com tipo `synthetic-status`.

## Interoperabilidade real com o Connector

A prova histórica em `interop.test.ts` conectou o Chromium ao adaptador isolado em `packages/connector/src/webrtc`, executado em processos Node e Bun reais com `node-datachannel` 0.33.5. Ela exige entrega sintética nos dois sentidos, comparação dos certificados efetivos com SDP e rejeição de identidade, transcrição, replay e fingerprints SDP adulterados. O código não inicia o CLI ou um serviço de produção.

O harness atual usa somente Node 24.22.3, conforme o runtime do workspace. Os manifests agora fixam `node-datachannel` 0.33.6; a atualização gerada do lock pnpm, a execução nativa e a aceitação por plataforma dessa versão permanecem pendentes. A evidência acima refere-se à versão 0.33.5. Consulte a [proveniência atual](../../THIRD_PARTY.md#experimental-connector-webrtc-dependency).

```sh
pnpm --dir packages/webrtc-experiment run test:session
node --test packages/webrtc-experiment/interop.test.ts
```

O receptor limita o payload bruto da aplicação a 32 KiB e oito frames pendentes, incluindo o ativo, com 2048 bytes UTF-8 por frame e 1024 frames admitidos por sessão. Diagnósticos têm tamanho fixo; sobrecarga e prazo encerram o peer inteiro. O prazo de oito segundos começa na construção, incluindo ofertas abandonadas, e a fixture tem vida total máxima de 30 segundos, sem conceder autorização de produção. Os testes cobrem filas antes do certificado, flood autenticado, expiração e zero provas nos dois sentidos quando o fingerprint SDP é adulterado. Os limites não abrangem alocações anteriores ao callback em SCTP, N-API ou no navegador.

O [checkpoint de interoperabilidade](../../docs/WEBRTC-CONNECTOR-INTEROP-CHECKPOINT.md) descreve o backend nativo, a revisão de DTLS, o candidato descartado, limites da evidência e o contrato de integração pendente. Consulte também os avisos de dependências. O restante desta página descreve a prova original entre dois peers do Chromium, preservada como comparação.

## Executar a prova original

Na raiz, com as dependências de desenvolvimento já instaladas pelo lockfile e o Chromium correspondente ao Playwright disponível:

```sh
pnpm --dir packages/webrtc-experiment typecheck
pnpm --dir packages/webrtc-experiment exec vitest run transport.test.ts --config vitest.config.ts
```

O teste original usa o Playwright 1.64.1 do workspace e as APIs nativas WebRTC e Web Crypto. Não adiciona biblioteca de RTC, dependência de execução ou lockfile. Consulte [THIRD_PARTY.md](THIRD_PARTY.md) para licenças e avisos.

Um único processo de navegador executa sete casos sequenciais. Cada caso cria dois peers e os fecha em `finally`. Um servidor HTTP temporário escuta somente em `127.0.0.1`, em porta escolhida pelo sistema, para servir a página e o módulo estáticos. Apenas `/` e `/fixture.js` aceitam GET; outros caminhos recebem 404 e outros métodos recebem 405. Esse servidor não recebe sinalização, status ou comandos. A sinalização do teste passa diretamente entre objetos locais em memória. Não há STUN, TURN, relay ou fallback HTTP de controle.

O teste limita a coleta ICE a três segundos por peer, a autenticação da sessão a oito segundos e o teste completo a sessenta segundos. Não inicia Docker, simuladores, banco ou hardware. O bundle permanece em memória. O navegador e o servidor são encerrados mesmo quando a execução falha.

## Identidade e vínculo ao canal

O módulo gera identidades Ed25519 sintéticas não exportáveis. As chaves públicas ficam fixadas fora do canal, em memória. As mesmas identidades participam dos casos subsequentes para que a rejeição do replay dependa da sessão nova, sem depender de troca de chave. Nada persiste após fechar a página.

Cada peer constrói sua expectativa a partir de suas próprias descrições SDP local e remota. A transcrição contém domínio de protocolo, identificador aleatório de sessão de 256 bits, ambos os papéis, ambas as chaves públicas SPKI, um nonce de 256 bits por peer e ambos os fingerprints SHA-256 DTLS efetivamente negociados. O RTC nativo verifica o certificado remoto contra a descrição SDP remota durante o DTLS. Uma assinatura Ed25519 separada por papel cobre essa transcrição completa. O receptor verifica com a chave pública esperada para o outro papel antes de aceitar o dado sintético.

A codificação é um array JSON de posição fixa, gerado localmente; o canal recebe apenas uma prova de assinatura hexadecimal e o dado literal. Frames maiores que 2 KiB, JSON inválido, provas repetidas e tipos de mensagem desconhecidos falham fechados. Esta codificação experimental não substitui a canonicalização ou os envelopes existentes de autorização de comandos.

Falha de identidade, transcrição ou canal muda ambos os estados locais para `readonly`. O prazo também torna esse estado permanente para a sessão. O teste envia uma prova válida e um status após o prazo para comprovar que mensagens tardias não restauram acesso. Não há reconexão ou repetição automática de operações.

## Evidência que o teste exige

- Entrega de `fixture-idle` somente depois de verificar ambas as identidades, com os dois peers conectados, DTLS conectado e candidatos ICE locais `host` e remotos `host` ou `prflx`, sem relay.
- Rejeição de uma assinatura feita por outra identidade, de um fingerprint substituído na transcrição e de uma prova capturada na sessão válida anterior, todos em canais RTC conectados.
- Estado `readonly` sem dados aceitos após prazo de autenticação, inclusive com prova válida tardia, após fechar o DataChannel autenticado ou após fechar diretamente o RTCPeerConnection autenticado.

A saída JSON registra versão do Chromium, estados, fingerprints sintéticos, tipos dos candidatos e decisões. Não registra endereços ICE, chaves privadas, contas ou caminhos locais. O fechamento do DataChannel pode anteceder a mudança do estado global do peer; por isso o teste de fechamento exige o estado da aplicação, não um evento de conexão posterior.

## Contrato para futura integração

Uma integração posterior deve fornecer identidades aprovadas e chaves públicas autenticadas antes de receber qualquer prova pelo canal. A chave enviada pelo próprio peer nunca pode se tornar sua própria âncora de confiança. Pairing, conta, farm, autorização, expiração e revogação continuam fora deste pacote.

A sinalização autenticada deverá vincular o identificador de sessão, o papel, a identidade esperada, a origem/audiência e os nonces aos participantes autorizados, transportar oferta/resposta e candidatos com limites de tamanho e prazo e consumir os desafios uma única vez. Cada endpoint deverá reconstruir a transcrição com suas próprias descrições SDP e verificar o fingerprint do canal efetivo antes de liberar qualquer mensagem de aplicação. Troca de certificado, renegociação ou reconexão exige uma nova sessão autenticada.

Somente depois dessa verificação uma integração poderá entregar envelopes aos verificadores existentes de autorização do Connector. As regras de segurança e o despacho devem permanecer no Connector, inclusive durante falhas do servidor. Este experimento não implementa autorização de comandos, políticas offline, câmera, integração Moonraker/Spoolman, leases, persistência antirreplay, revogação ou compatibilidade com o runtime de produção do Connector. O sucesso local não prova conectividade entre redes ou NAT e não autoriza uso em produção. Ausência de P2P deve manter somente leitura, sem fallback de comandos por servidor.
