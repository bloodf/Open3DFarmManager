# Fronteira de autoridade: auditoria para novos protocolos

Identificador: `authority-boundary`. Data de corte: 2026-11-13. Base do produto: `bad76165aa4fbe86949ae624ddedc973721d5fcf` (commit de 2026-11-12). HEAD inspecionado: `e04c6dfeedf70b35f0323b817452790901251689`, descendente da base que acrescenta apenas documentos de compatibilidade; a ancestralidade foi conferida com `git merge-base`.

Este relatório é uma leitura de código-fonte e de documentação. Nenhum teste, build, simulador, navegador ou impressora foi executado ou contatado. Nenhum comando foi enviado a equipamento. Tudo o que aparece como "confirmado" significa **confirmado por leitura do fonte na base indicada**, não comportamento observado em execução.

Escopo: caminho navegador–Connector por WebRTC, comandos assinados, identidade do dispositivo, prova de papel, journal de replay, expiração, revogação, indisponibilidade do servidor e driver de pausa. Apenas FDM. Firmware e hardware das marcas novas são desconhecidos; este documento não afirma acesso nem suporte a nenhuma delas.

As referências `[Sn]` apontam para a lista de fontes no final. Caminhos são relativos à raiz do repositório.

## 1. Como a autoridade flui hoje

Existe um único comando com caminho de execução montado: pausar, para uma única atribuição de impressora configurada localmente.

1. **Sessão de controle.** Navegador e Connector assinam o mesmo `ControlSessionBinding`. O vínculo fixa fazenda, agente, conta, chave do navegador, atribuição, chave pública e impressão digital do Connector, identificador da credencial, origem, audiência, nonces, hashes das descrições SDP e as duas impressões digitais DTLS. A validade máxima é de 30 s [S1].
2. **Prova de papel.** Cada lado assina o vínculo com sua própria chave e algoritmo: navegador com ECDSA P-256, Connector com Ed25519. O texto assinado inclui um prefixo de domínio e o nome do papel, portanto a assinatura de um papel não vale para o outro [S1]. O verificador exige `role` igual a `browser` e a `connector` nas provas correspondentes [S4].
3. **Capacidade emitida pelo servidor.** O servidor emite `PauseCapabilityV1`, assinada com Ed25519, com vida máxima de 30 s. O campo `actions` é a tupla literal `['pause']` e `role` aceita apenas `owner`, `admin` ou `operator` [S2]. A emissão relê, dentro de uma transação, sessão, associação e papel, chave do navegador, cadastro do Connector, credencial e atribuição [S14].
4. **Admissão no Connector.** `createPauseCapabilityVerifier` gera um nonce local, compara cada campo da capacidade e do desafio com o vínculo local, exige emissor presente no chaveiro local e verifica quatro assinaturas, reconferindo a validade entre cada etapa assíncrona. A ficha de admissão é de uso único e toda falha é terminal [S4].
5. **Comando assinado.** `SignedCommandV2` tem `action` literal `pause`, `args` vazio, vida máxima de 5 s e nonce de 128 bits. O quadro precisa ser JSON canônico e limitado a 8192 bytes [S3].
6. **Despacho.** `createPauseDispatcher` confere escopo contra a capacidade e o mapeamento local, verifica a assinatura com a chave do navegador presente na capacidade, registra o comando no journal, prepara o driver e só então permite um envio [S6].
7. **Journal.** `claimCommand` recusa repetição por `cmd_id` ou pelo par `key_id` e `nonce`, recusa atribuição ocupada, aplica capacidade máxima e limite de dez comandos por minuto por impressora, e detecta retrocesso do relógio [S5].
8. **Driver.** `openFixedMoonrakerPause` abre uma conexão por tentativa, envia uma única vez o texto fixo `printer.print.pause`, aceita apenas a resposta `ok` e faz no máximo oito consultas de estado para confirmar `paused` [S8].

O transporte dos quadros de comando é o canal de dados `pause-control-v1`, ordenado, criado no par WebRTC de controle [S10].

## 2. Achados confirmados por leitura do fonte

- **F1.** O contrato executável é somente pausa. `actions` é `z.tuple([z.literal('pause')])`, `action` é `z.literal('pause')` e `purpose` é `printer-pause`. Retomar, cancelar, iniciar e enviar arquivo não têm esquema, capacidade nem driver. Evidência: `packages/farm-protocol/src/pause-capability.ts:84`; `packages/farm-protocol/src/command-v2.ts:16,25` [S2][S3]
- **F2.** O verificador da versão 1 (`authorizeCommand`) e `PersistentReplayStore` não têm chamadores em `packages`, `apps` ou `scripts`; aparecem apenas em testes. É o único lugar onde `resume`, `cancel` e `emergency_stop` existem como ações. A documentação do próprio projeto o descreve como protótipo de biblioteca sem driver nem transporte. Evidência: `packages/connector/src/auth/verify.ts:88`; `packages/connector/src/auth/replay.ts:23`; `packages/farm-protocol/src/command.ts:20`; `docs/COMMAND-SECURITY.md` [S7][S15]
- **F3.** O Connector não lê o campo `role` da capacidade ao admitir. O papel é restringido pelo esquema e pela assinatura do emissor; não existe tabela papel-por-ação no Connector. Evidência: `packages/farm-protocol/src/pause-capability.ts:58`; `packages/connector/src/auth/pause-capability.ts:364-388` [S2][S4]
- **F4.** Linhas `outcome-unknown` do journal têm `retain_until` nulo e nunca são removidas; a limpeza cobre apenas `not-sent` e `applied`. Uma linha `claimed`, `write-started` ou `outcome-unknown` faz novos comandos para a mesma atribuição ou impressora serem recusados como `assignment-busy`. Não foi encontrado código de reconciliação. Evidência: `packages/connector/src/control/command-journal.ts:140,360,378,514`; `docs/MOONRAKER-PAUSE-DRIVER-CHECKPOINT.md` [S5][S16]
- **F5.** A fronteira de driver está acoplada a Moonraker em três pontos: o esquema da atribuição local exige `moonraker_origin`; o roteador chama `openFixedMoonrakerPause` diretamente; o runtime aceita uma única atribuição de controle. A interface `PauseDriver` em si não menciona Moonraker. Evidência: `packages/connector/src/control/printer-binding.ts:19,61`; `packages/connector/src/runtime/pause-driver-router.ts:54`; `packages/connector/src/runtime/pause-control.ts:105,138`; `packages/connector/src/control/pause-dispatcher.ts:54` [S6][S9]
- **F6.** A autoridade em cache tem vida padrão de 30 s e máxima de 60 s, fica só em memória e nasce vencida a cada reinício. Somente a caixa de entrada autenticada pela credencial do Connector chega a `confirm()`. `server_seq` precisa crescer estritamente; uma revogação eleva o piso. Evidência: `packages/connector/src/auth/offline-authority.ts:8-9,92-113`; `packages/connector/src/runtime/agent.ts:244-320`; `packages/connector/src/cloud/authenticated-signalling-client.ts:389-416` [S11][S12]
- **F7.** Os quadros `connector.authority-confirm` e `connector.authority-revoked` não carregam assinatura própria. A proveniência depende da conexão TLS e da admissão da credencial. O servidor relê a autoridade a cada 5 s. Evidência: `packages/farm-protocol/src/signalling-socket.ts:97-109`; `apps/farm/server/services/signalling-runtime.ts:907-958` [S13]
- **F8.** Verificador e despachante fixam uma linha de base entre relógio de parede e relógio monotônico na primeira amostra. Um desvio acima de 1000 ms marca `clockBroken`, e nada no código volta esse estado. Evidência: `packages/connector/src/auth/pause-capability.ts:153-176`; `packages/connector/src/control/pause-dispatcher.ts:145-168` [S4][S6]
- **F9.** O estado público da impressora admite `idle`, `printing`, `paused`, `error` e `offline`. Não há `unknown` nem recurso não suportado. O leitor Moonraker converte `webhooks.state = startup` em `offline`. A observação de controle tem `unknown`, mas o driver de pausa nunca o emite: estados fora de `printing`, `paused` e `error` viram `idle`. Evidência: `packages/farm-protocol/src/state.ts:5`; `packages/connector/src/moonraker/parse.ts:117`; `packages/connector/src/control/pause-dispatcher.ts:37`; `packages/connector/src/moonraker/pause-driver.ts:324-327` [S17][S8]
- **F10.** Os pares WebRTC são criados com `iceServers: []`. O vínculo de controle rejeita SDP com candidato `typ relay` e exige exatamente uma impressão digital DTLS SHA-256. Evidência: `packages/connector/src/webrtc/pause-control-peer.ts:135`; `packages/connector/src/webrtc/readonly-peer.ts:139`; `packages/farm-protocol/src/control-session-binding.ts:227-248` [S10][S1]
- **F11.** A chave privada do Connector fica encapsulada em `ConnectorIdentity`; o chamador recebe operações de assinatura por finalidade, não a chave. Diretório e arquivos são criados com modos `0o700` e `0o600`. Evidência: `packages/connector/src/identity/store.ts:89-241,303-345` [S18]
- **F12.** O chaveiro de emissores é configuração local, limitado a oito entradas, com origem `https`. Nenhum emissor vem do par ou do comando. Evidência: `packages/connector/src/config/pause.ts:16,38,49,141` [S19]
- **F13.** O despachante nunca reenvia. Resposta ausente, estado não confirmado, quebra de contrato do driver ou falha ao persistir o resultado terminam em `outcome-unknown`. Evidência: `packages/connector/src/control/pause-dispatcher.ts:314-341,608-687,735-740` [S6]
- **F14.** O driver de pausa e a validação de origem não têm cabeçalho de API, token ou login Moonraker. A busca delimitada por `api_key`, `oneshot`, `authorization` e `access_token` em `packages/connector/src/moonraker` e nos arquivos de configuração relacionados não retornou ocorrências. Evidência: Busca delimitada; `packages/connector/src/config/moonraker.ts:28-65` [S20]
- **F15.** Não há ocorrência de Anycubic, Bambu ou Creality em arquivos TypeScript de `packages`, `apps` e `tests`. Evidência: Busca delimitada, sem distinção de maiúsculas

Fatos externos usados como referência do contrato Moonraker: a documentação oficial lista `printer.print.pause` com retorno `"ok"` e `printer.objects.query` com `eventtime` e `status` [S21]. A mesma documentação afirma que clientes não confiáveis precisam de JWT ou chave de API [S22]. Nenhuma das duas páginas exibe data de publicação; ambas foram acessadas em 2026-11-13.

## 3. Riscos concretos

Cada item decorre diretamente de um achado da seção 2.

- **R1. Bloqueio permanente após resultado incerto (F4, F13).** Um único `outcome-unknown` impede novas pausas na mesma impressora até intervenção manual no armazenamento local. O comportamento falha fechado, mas não existe procedimento de reconciliação no código. Protocolos com confirmação menos confiável tornam esse estado mais frequente.
- **R2. Caminho de execução inexistente tratado como pronto (F1, F2).** Quem adicionar marcas pode supor que retomar, cancelar ou parada de emergência já têm autorização, porque existem no esquema da versão 1. Esse verificador recebe o contexto do chamador e não tem transporte nem driver.
- **R3. Papel sem granularidade por ação (F3).** Enquanto só existe pausa, os três papéis são equivalentes. Qualquer ação nova herda essa equivalência se o emissor apenas ampliar `actions`.
- **R4. `startup` vira `offline` e desconhecido vira `idle` (F9).** O contrato atual não consegue representar "desconhecido" nem "recurso não suportado" por dispositivo. Um adaptador novo seria forçado a escolher um estado incorreto.
- **R5. Acoplamento Moonraker na identidade local da impressora (F5).** A atribuição local só descreve um destino `http` ou `https`. Um protocolo local diferente não cabe no esquema sem alterar a peça que hoje ancora a autorização do destino.
- **R6. Moonraker com autorização obrigatória não é atendido (F14).** Instalações que tratam o Connector como cliente não confiável exigem credencial que o driver não sabe apresentar. Não há armazenamento local de credenciais de impressora.
- **R7. Relógio (F8).** Um desvio acumulado desativa pausa até o processo reiniciar. A documentação do projeto estima cerca de 14 h a 20 ppm; esse número não foi medido nesta auditoria.
- **R8. Uma atribuição de controle por Connector (F5).** Fazendas com várias impressoras não têm caminho de pausa para todas com a composição atual.

## 4. Hipóteses não verificadas

Estas afirmações **não** foram confirmadas. Não devem ser citadas como fatos.

- **H1.** Protocolos locais de fabricantes podem não permitir a garantia "um único envio na mesma pilha síncrona após `beforeSend()`" exigida por `PauseDriver`. Depende de biblioteca e transporte ainda não estudados.
- **H2.** Protocolos de fabricantes podem não oferecer leitura de estado com ordenação estrita comparável a `eventtime`, o que impediria confirmar `applied` com a mesma regra.
- **H3.** A ausência de autenticação Moonraker pode se estender a outros módulos fora da busca delimitada de F14.
- **H4.** Um terminador TLS comprometido entre servidor e Connector poderia forjar `authority-confirm` (F7). A documentação do projeto reconhece que o rastreador não defende contra servidor comprometido; nenhum teste foi feito.
- **H5.** Linhas `claimed` deixadas por uma queda do processo bloqueiam a atribuição da mesma forma que `outcome-unknown`. A consulta SQL indica que sim; não foi executado.
- **H6.** O comportamento do lado do navegador (`apps/farm/app`) e de `pause-command-relay.ts` além dos trechos lidos corresponde ao descrito na documentação do projeto.
- **H7.** Renovação e revogação de credencial do Connector funcionam como descrito em `docs/CONNECTOR-REVOCATION-CHECKPOINT.md`; o código correspondente não foi lido nesta auditoria.

## 5. Restrições de aceitação imutáveis para novos protocolos

Um adaptador ou comando novo só pode ser aceito se todas as condições abaixo continuarem verdadeiras. Elas descrevem o que o código já impõe e o que as regras do projeto exigem [S23].

1. **AC1. Autoridade só pelo caminho navegador–Connector em WebRTC.** Sem TURN, sem candidato `relay`, sem comando por HTTP ou pelo servidor. Modo degradado é somente leitura.
2. **AC2. O trecho Connector–impressora é separado.** Um protocolo local próprio é permitido nesse trecho, mas nunca transporta, substitui ou estende a autoridade do trecho navegador–Connector.
3. **AC3. Uma capacidade por ação.** Iniciar, enviar arquivo, pausar, retomar e cancelar são capacidades distintas, cada uma com esquema versionado, `purpose` próprio e prefixo de domínio próprio na assinatura. Nenhuma ação genérica, nenhum G-code ou carga arbitrária.
4. **AC4. O verificador da versão 1 não é caminho de produção.** Não ligar `authorizeCommand` a um driver sem contexto autenticado, capacidade emitida e journal equivalentes aos da versão 2.
5. **AC5. Papel decidido na emissão e assinado.** Qualquer ação nova define explicitamente quais papéis a recebem; o Connector rejeita capacidade cujo papel não esteja previsto para a ação.
6. **AC6. Destino vem só do provisionamento local.** Endereço, porta, identificador ou credencial da impressora nunca chegam por comando, capacidade, par WebRTC ou servidor. O destino passa por lista de permissão local.
7. **AC7. Identidade e capacidades por dispositivo e firmware.** Suporte é declarado por dispositivo e versão de firmware, nunca por marca. Recurso ausente é "não suportado" para aquele dispositivo.
8. **AC8. Desconhecido não é offline.** `unknown`, `offline`, `stale` e não suportado são estados distintos. Um adaptador que não consegue determinar o estado publica desconhecido e nega elegibilidade de comando.
9. **AC9. Journal antes do efeito.** Todo comando é registrado de forma durável antes de qualquer escrita no dispositivo. Journal e replay nunca concedem autoridade.
10. **AC10. No máximo um envio, sem repetição.** Tempo esgotado não prova rejeição. Resultado incerto é `outcome-unknown`, fica visível e não é reenviado automaticamente.
11. **AC11. `applied` exige observação posterior.** Só com estado lido depois do envio, na mesma conexão e geração, dentro do limite de frescor. Confirmação do transporte sozinha não basta.
12. **AC12. Limites preservados.** Capacidade até 30 s, admissão até 8 s, comando até 5 s, estado fresco até 2 s, autoridade em cache até 60 s. Um adaptador não pode ampliar esses valores para acomodar um protocolo lento.
13. **AC13. Falha fechada em indisponibilidade.** Sem confirmação recente do servidor, todo comando é recusado. Reinício começa sem autoridade. Revogação tem efeito imediato e não pode ser revertida por confirmação antiga.
14. **AC14. Segredos fora do alcance do navegador.** Credenciais de impressora não entram em logs, fixtures públicas, diagnósticos ou DTOs do navegador. Diagnósticos usam razões de conjunto fechado.
15. **AC15. Entrada limitada e canônica.** Toda mensagem de dispositivo ou par tem limite de bytes, profundidade e quantidade de valores, e é rejeitada se malformada.
16. **AC16. Sem comando a impressora física em testes automatizados.** Validação física é etapa manual, autorizada e identificada por equipamento e firmware.

## 6. Lacunas

- Nenhuma execução: testes, verificações agregadas, simuladores e hardware não foram rodados. Nada aqui certifica comportamento em tempo de execução.
- Leitura parcial: `pause-command-relay.ts`, `pause-signalling-client.ts`, `pause-control-session.ts`, `signalling-runtime.ts` e `postgres-pause-authority.ts` foram lidos por trechos e buscas, não integralmente.
- Não lidos: código do navegador em `apps/farm/app`, renovação e revogação de credencial, caminho de câmera, fila de telemetria.
- O índice CodeGraph não estava inicializado neste checkout e não foi criado, por ser tarefa só de pesquisa. A inspeção usou leituras delimitadas e buscas exatas; chamadas dinâmicas podem ter escapado.
- Protocolos locais de Anycubic, Bambu Lab e Creality não foram estudados aqui. Nenhuma afirmação de acesso, suporte ou classificação de modelos decorre deste relatório.
- A documentação Moonraker consultada não mostra data nem versão; o driver fixa o contrato em um commit específico que não foi comparado com a página atual.
- Formatador não executado: `prettier` não está instalado neste checkout e instalações não foram autorizadas. Os dois arquivos foram formatados manualmente e conferidos apenas com `git diff --check`.

## 7. Próximos passos

1. Decidir e documentar o procedimento de reconciliação de `outcome-unknown` antes de qualquer protocolo novo (R1).
2. Propor estado público com `unknown` e não suportado por dispositivo, preservando o comportamento atual de Moonraker (R4).
3. Propor a menor generalização da atribuição local: tipo de destino explícito e validado por adaptador, mantendo lista de permissão local (R5).
4. Definir a tabela papel-por-ação antes do segundo comando (R3).
5. Para cada família de protocolo candidata, responder H1 e H2 com documentação primária antes de desenhar um driver.
6. Marcar o verificador da versão 1 como não produtivo no próprio código ou removê-lo, em tarefa separada (R2).
7. Executar, em tarefa autorizada, as verificações já existentes do projeto na base e registrar resultado; esta auditoria não as substitui.
8. Revisão independente deste relatório contra o fonte antes de usá-lo como critério de aceitação.

## Fontes

Arquivos do repositório foram lidos na base `bad76165aa4fbe86949ae624ddedc973721d5fcf` (commit de 2026-11-12), em 2026-11-13.

- **S1.** `packages/farm-protocol/src/control-session-binding.ts`. Sustenta: vínculo de sessão, provas por papel, DTLS, rejeição de `relay`.
- **S2.** `packages/farm-protocol/src/pause-capability.ts`. Sustenta: capacidade de pausa, limites de política, prova de admissão.
- **S3.** `packages/farm-protocol/src/command-v2.ts`. Sustenta: comando assinado versão 2.
- **S4.** `packages/connector/src/auth/pause-capability.ts`. Sustenta: admissão e inspeção no Connector.
- **S5.** `packages/connector/src/control/command-journal.ts`. Sustenta: journal durável, replay, retenção.
- **S6.** `packages/connector/src/control/pause-dispatcher.ts`. Sustenta: despacho, interface `PauseDriver`, resultados.
- **S7.** `packages/connector/src/auth/verify.ts`, `packages/connector/src/auth/replay.ts`, `packages/farm-protocol/src/command.ts`. Sustenta: verificador e replay da versão 1.
- **S8.** `packages/connector/src/moonraker/pause-driver.ts`. Sustenta: driver fixo de pausa.
- **S9.** `packages/connector/src/control/printer-binding.ts`, `packages/connector/src/runtime/pause-driver-router.ts`, `packages/connector/src/runtime/pause-control.ts`. Sustenta: atribuição local, roteador, composição do runtime.
- **S10.** `packages/connector/src/webrtc/pause-control-peer.ts`, `packages/connector/src/webrtc/readonly-peer.ts`. Sustenta: par WebRTC, canal de dados, `iceServers`.
- **S11.** `packages/connector/src/auth/offline-authority.ts`. Sustenta: vida da autoridade em cache.
- **S12.** `packages/connector/src/runtime/agent.ts`, `packages/connector/src/cloud/authenticated-signalling-client.ts`. Sustenta: origem de confirmação e revogação.
- **S13.** `packages/farm-protocol/src/signalling-socket.ts`, `apps/farm/server/services/signalling-runtime.ts`. Sustenta: quadros de autoridade e releitura no servidor.
- **S14.** `apps/farm/server/storage/postgres-pause-authority.ts`. Sustenta: emissão transacional da capacidade.
- **S15.** `docs/COMMAND-SECURITY.md`. Sustenta: situação de protótipo da versão 1.
- **S16.** `docs/MOONRAKER-PAUSE-DRIVER-CHECKPOINT.md`. Sustenta: ausência de reconciliação e de repetição.
- **S17.** `packages/farm-protocol/src/state.ts`, `packages/connector/src/moonraker/parse.ts`. Sustenta: estados públicos e mapeamento.
- **S18.** `packages/connector/src/identity/store.ts`. Sustenta: identidade do Connector.
- **S19.** `packages/connector/src/config/pause.ts`. Sustenta: chaveiro de emissores.
- **S20.** `packages/connector/src/config/moonraker.ts`. Sustenta: validação de origem Moonraker.
- **S21.** <https://moonraker.readthedocs.io/en/latest/external_api/printer/> (publicação: não exibida; acesso: 2026-11-13). Sustenta: métodos `printer.print.pause` e `printer.objects.query`.
- **S22.** <https://moonraker.readthedocs.io/en/latest/external_api/authorization/> (publicação: não exibida; acesso: 2026-11-13). Sustenta: requisito de autorização para clientes não confiáveis.
- **S23.** `AGENTS.md`, `docs/OFFLINE-AUTHORIZATION-LIFETIME.md`. Sustenta: regras do projeto e limites de autoridade offline.
