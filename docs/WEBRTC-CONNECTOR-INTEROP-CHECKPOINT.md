# Interoperabilidade WebRTC do Connector sintético

O experimento conecta um Chromium real a um peer nativo executado pelo código do Connector, em processo separado. O adaptador fica em `packages/connector/src/webrtc/synthetic-peer.ts` e não é importado pelo CLI. A sessão compartilhada em `synthetic-session.ts` usa Web Crypto. A fixture do navegador importa somente essa sessão portátil. Não há impressoras, comandos executáveis, autenticação de conta ou serviço de produção.

## Limite da prova

O backend local selecionado é `node-datachannel` 0.33.5. O binário macOS ARM64 usado informa libdatachannel 0.24.5. A revisão de dependências e os avisos ficam em [THIRD_PARTY.md do experimento](../packages/webrtc-experiment/THIRD_PARTY.md). O pin e o teste local não atestam a origem completa do binário nativo. A revisão de licenças/proveniência não autoriza distribuição ou produção. Outros sistemas operacionais e arquiteturas ainda precisam de verificação própria.

O transporte usa ICE sem servidores STUN ou TURN, UDP local e DTLS/SCTP. O peer nativo fixa o bind em loopback; o Chromium pode apresentar o par direto como `host` ou `prflx`. O teste rejeita candidatos relay. Um servidor HTTP temporário serve apenas HTML/JavaScript estáticos. Oferta, resposta, confiança sintética e observações passam pelo harness local e stdin/stdout do processo de teste; essa IPC controla somente a fixture e relata observações, incluindo valores já aceitos pelo RTC. Ela nunca entrega status à aplicação de qualquer endpoint como fallback de controle. O literal percorre o DataChannel nos dois sentidos e cada endpoint registra sua própria aceitação.

## Identidade e certificado efetivo

Cada execução gera duas identidades Ed25519 sintéticas e fixa as respectivas chaves públicas fora do canal. Elas são reutilizadas entre os casos de uma mesma execução para que o replay dependa da sessão nova, não de trocar a chave. Cada conexão recebe sessão e nonces novos de 256 bits. O domínio assinado inclui sessão, ambos os papéis, SPKIs, nonces e fingerprints SHA-256 DTLS.

Cada endpoint reconstrói sua transcrição usando suas próprias descrições SDP local e remota. Antes de enviar ou aceitar provas, o adaptador compara `PeerConnection.remoteFingerprint()` com o fingerprint da descrição remota e exige SHA-256. No navegador, `getStats()` fornece o registro do certificado remoto apontado pelo registro do transporte; seu fingerprint também deve corresponder à descrição remota. O teste exige ambas as comparações, DTLS conectado no Chromium, conexão nativa conectada e entrega independente nos dois sentidos.

A configuração nativa mantém `disableFingerprintVerification: false`. A revisão da fonte de libdatachannel 0.24.5, commit `443f6934d9007eb7076ab7825ba330f355fcbead`, identificou a verificação no callback OpenSSL em `src/impl/dtlstransport.cpp` e a comparação do hash efetivamente recebido em `src/impl/peerconnection.cpp`. A negociação passa por `SSL_do_handshake`, que verifica as mensagens criptográficas de handshake, incluindo CertificateVerify. Esta é evidência da fonte revisada, sem atestação de que o prebuild derive exatamente daquele commit. O teste adversarial troca o fingerprint SHA-256 na oferta e, separadamente, na resposta, mantendo os certificados reais; ambos devem falhar no transporte antes de enviar provas ou aceitar dados. Ele não é um teste de adulteração direta de CertificateVerify ou uma auditoria completa de OpenSSL.

## Falhas e estado permanente

A sessão começa pendente. Uma assinatura válida do papel esperado verifica apenas a identidade sintética daquela conexão. A prova local deve sair antes de qualquer status, mesmo quando a verificação remota termina antes da assinatura local. Entradas são serializadas para evitar que um status ultrapasse a verificação assíncrona da prova anterior.

Identidade incorreta, transcrição substituída, replay, frame inválido, prazo vencido, erro ou fechamento levam a `readonly`. O estado tem armazenamento privado e nunca volta a verificado. O adaptador também retém falhas anteriores à criação da sessão e recusa respostas tardias ou renegociação do mesmo objeto fechado. Escopo e opções são copiados antes de operações assíncronas. A falha de um endpoint desativa a recepção, cancela os timers e fecha seu canal e o peer inteiro uma única vez; o outro observa seu próprio evento de transporte, sem receber estado compartilhado da aplicação.

O prazo de autenticação é de oito segundos desde a construção do adaptador, incluindo coleta ICE, espera pela resposta e prova. A resposta não reinicia esse prazo. Uma oferta sem resposta expira e fecha automaticamente. O teste também suprime a notificação de coleta ICE para comprovar que a expiração encerra uma chamada de oferta ainda pendente. No caso de prazo, a fixture retém os envios do navegador e o Connector fecha o peer ao vencer o prazo. A prova retida não cruza o canal depois de fechado. O teste portátil separado entrega provas e status após expiração e fecha a sessão durante a verificação criptográfica, comprovando que nem recepção tardia nem conclusão assíncrona restauram acesso. Não há heartbeat ou lease de autorização após o handshake neste experimento.

## Limites na fronteira dos callbacks

A admissão de frames é síncrona, antes de criar trabalho pendente. Um teste barato de tipo e unidades UTF-16 precede a codificação UTF-8. Uma única fila FIFO aguarda o certificado efetivo e serializa a verificação; todos os inputs de um lote compartilham a mesma Promise de conclusão. Não há cadeia de Promises ou closures por mensagem em espera nos callbacks nativo ou do navegador. Entrada antes de configurar uma sessão no peer nativo falha fechada sem reter o payload.

| Recurso da aplicação                                                | Limite                    |
| ------------------------------------------------------------------- | ------------------------- |
| Frame no fio                                                        | 2048 bytes UTF-8          |
| Frames admitidos pendentes, incluindo o ativo                       | 8                         |
| Payload bruto retido, contabilizado como 2 bytes por unidade UTF-16 | 32768 bytes               |
| Frames admitidos por sessão                                         | 1024                      |
| Amostras de status aceito / rejeição                                | 16 / 8                    |
| Texto de cada motivo                                                | 64 caracteres             |
| Prova local capturada                                               | 1                         |
| Histórico de transporte / fases de resposta                         | 16 / 3                    |
| Contadores de observação RTC                                        | saturação em 2048 eventos |
| Prazo da construção até autenticação                                | 8 segundos                |
| Vida total da fixture, inclusive após autenticação                  | no máximo 30 segundos     |

Exceder fila, bytes ou orçamento total leva a `readonly` e encerra o peer. A fila libera imediatamente os payloads pendentes; no máximo um frame já em processamento criptográfico continua retido até a conclusão, dentro dos mesmos limites. Nenhuma nova recepção altera contadores ou diagnósticos após o estado terminal. A conclusão criptográfica tardia libera o slot restante sem restaurar acesso. Snapshots copiam somente as amostras limitadas. O fechamento é idempotente e cancela os timers de autenticação e vida total.

A vida de 30 segundos é um limite de recursos da fixture, não uma lease de autorização ou garantia de revogação. Opções confiáveis de teste podem apenas encurtá-la, nunca ultrapassar 30 segundos. Os testes usam 150 ms na sessão portátil e 1,5 s no adaptador já autenticado, com verificação do fechamento real e cancelamento dos timers. Permanecem pendentes heartbeat, autorização corrente e distribuição de revogação.

Esses limites abrangem o trabalho e os payloads retidos pela aplicação JavaScript a partir do callback. Eles não estabelecem um limite de memória de SCTP, libdatachannel, N-API, Chromium ou do processo inteiro, que podem alocar antes do callback. Essa avaliação continua pendente.

Os testes portáteis submetem 100 mil entradas antes do certificado, 100 mil entradas gigantes após o encerramento e 100 mil status autenticados sequenciais, sem armazenar uma Promise por input no chamador. Eles exigem valores observados de pico, retenção zerada após liberação, 1023 status totais no fluxo autenticado e somente 16 amostras. Também exercitam sobrecarga com uma verificação Ed25519 real em andamento.

No teste RTC, a fixture do navegador retém a ativação do certificado enquanto recebe frames reais e exige rejeição por fila cheia sem processar ou aceitar nenhum deles. Outro caso autentica ambos os peers antes de um flood real de status e exige encerramento por fila ou orçamento total, com observações estáveis após o encerramento. O produtor malicioso da fixture envia no máximo 1200 literais sintéticos; somente esse produtor interrompe o loop e registra um motivo limitado quando o receptor fecha o canal durante o envio. Erros ordinários de SDP, assinatura ou envio do adaptador continuam sendo falhas.

## Executar e verificar

Com as dependências do workspace instaladas e o Chromium do Playwright disponível:

```sh
pnpm --dir packages/webrtc-experiment run typecheck
pnpm --dir packages/webrtc-experiment run test:session
pnpm --dir packages/webrtc-experiment run test:interop
```

O harness de interoperabilidade usa Node 24 como driver do Playwright e compila o módulo do navegador com esbuild em memória. Os testes portáteis usam Vitest. Uma execução anterior do driver completo em `bun:test` (registro histórico, pré-pnpm) concluiu as observações RTC, mas ficou pendente em `browser.close()` mesmo após os processos de peers e Chromium terminarem; esse caminho não é declarado aprovado. Um probe mínimo e a execução completa devem incluir encerramento normal de todos os atores para aprovação.

O teste de interoperabilidade executa os mesmos dez casos em processos Node e Bun reais: entrega válida, identidade incorreta, transcrição substituída, replay de prova anterior, prazo, peer fechado, fingerprint SDP adulterado em cada sentido, sobrecarga antes do certificado e flood após autenticação. Ambos os casos de SDP adulterado exigem, simetricamente no nativo e no navegador, zero envio e recepção de provas, zero frames RTC recebidos e zero dados de aplicação aceitos. Os contadores de prova RTC medem o envio efetivo ou o recebimento dos frames canônicos da fixture, separadamente das tentativas locais de assinatura. A saída registra as versões efetivamente usadas, fingerprints sintéticos, tipos de candidatos, contadores RTC e decisões locais. Evidências operacionais, portas e caminhos de executáveis ficam somente no ledger local da tarefa.

A execução usa um navegador, um processo de Connector por vez, porta HTTP escolhida pelo sistema e portas UDP efêmeras. Coleta ICE e RPC têm limites. `finally` fecha peers, processo filho, navegador e servidor. A fixture chama a limpeza global nativa apenas ao encerrar seu processo exclusivo; isso não é uma política para um processo compartilhado de produção.

## Resultado local e limitações observadas

A correção de limites passou nos dez casos RTC em cada runtime, vinte no total, com Node 24.20.0, Bun 1.4.2 e Chromium 156.0.8078.4. A execução completa terminou em 44,39 segundos, com saída normal dos processos filhos e encerramento do navegador e servidor. Os testes portáteis passaram em nove casos e 32 asserções, incluindo os floods de 100 mil inputs e a expiração após autenticação. O typecheck do pacote passou. A cobertura inclui expiração automática de oferta abandonada, oferta ainda aguardando notificação ICE, fechamento idempotente e contadores de prova simétricos nos dois casos de SDP adulterado.

A execução histórica anterior à correção de limites passou nos oito casos em cada runtime, com Node 24.20.0 e Bun 1.4.2, Chromium 156.0.8078.4 e libdatachannel informando 0.24.5. `node --test packages/webrtc-experiment/interop.test.ts` terminou em 29,61 segundos, incluindo encerramento normal dos dois processos filhos, navegador e servidor. Os testes portáteis passaram em quatro casos com onze asserções. O typecheck do pacote também passou.

Uma execução anterior do harness Node recebeu a exceção nativa `Got a remote candidate without ICE transport` entre o caso Bun válido e a próxima observação. A causa permanece sem confirmação. A fonte revisada permite essa exceção quando um transporte ICE é removido enquanto candidatos remotos são processados, mas isso é hipótese, não diagnóstico comprovado. O adaptador retém falhas de descrição remota como estado terminal e fecha o peer mesmo antes de criar a sessão. A fixture inclui uma regressão com SDP inválido para essa fronteira. Essa regressão não explica nem demonstra correção da exceção anterior com SDP legítimo. A exceção com SDP legítimo continua fatal ao teste; não há retry nem tratamento como sucesso esperado. O probe reduzido e a execução completa posterior passaram, sem estabelecer estabilidade universal do backend. Os diagnósticos limitados permanecem no ledger local.

## Candidato descartado

Werift 0.26.0 foi avaliado e removido antes de executar interoperabilidade Chromium com ele. A revisão estática encontrou no DTLS `flight/client/flight5` a aceitação de `ServerKeyExchange.publicKey` sem verificação aparente da assinatura. Em `flight/server/flight6`, CertificateVerify apenas exigia um certificado e registrava o algoritmo, e Finished apenas registrava a mensagem. Não foi encontrado outro caminho de verificação correspondente na fonte instalada revisada. A comparação de fingerprint isolada não estabelece posse da chave privada do certificado. Não foi construído um exploit nem alterada a biblioteca criptográfica. Os smokes anteriores entre dois peers werift não satisfazem a prova de canal autenticado.

## Integração que continua pendente

A confiança permanece fornecida pela fixture. Uma integração real deverá fornecer identidade aprovada, vínculo conta/farm/Connector, metadados atuais, prova recente de posse, origem/audiência, desafios consumidos uma vez, sinalização autenticada e política de expiração/revogação. Uma credencial de emissão isolada não autentica o transporte. Reconexão, mudança de certificado ou renegociação exigirão nova sessão e nova verificação.

Este adaptador aceita somente `synthetic-status` com valor `fixture-idle`. Não chama verificadores de comandos ou drivers. A integração futura deve continuar aplicando autorização e segurança no Connector, inclusive com falhas do servidor. Ausência de P2P mantém somente leitura; não há caminho de comandos por HTTP, servidor ou TURN. Câmera, NAT entre redes, hardware e distribuição permanecem fora desta prova.
