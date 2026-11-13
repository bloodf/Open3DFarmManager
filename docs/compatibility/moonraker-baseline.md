# Baseline Moonraker para telemetria somente leitura

Corte: 2026-11-13. Base: `bad76165aa4fbe86949ae624ddedc973721d5fcf`. HEAD inspecionado: `e04c6dfeedf70b35f0323b817452790901251689`. O diff de produto entre essas revisões é vazio; os acréscimos são relatórios Anycubic. Análise de fonte, sem execução de produto.

## Fluxo atual

### collect

A CLI chama collectLocalTelemetry, que abre a fila local e chama collectIntoQueue. Este cria uma assinatura Moonraker por impressora, registra indisponibilidade apenas em diagnóstico e enfileira snapshots e transições. A primeira amostra após reinício não gera transição. [Fonte na base fixada: collectLocalTelemetry; collectIntoQueue](../../packages/connector/src/runtime/collect.ts).

### callers

O agente conecta onRawObservation a snapshots.observe e onRawUnavailable a snapshots.invalidate. A coleta compartilhada também alimenta a fila; os consumidores de exibição e persistência têm contratos diferentes. [Fonte na base fixada: collectIntoQueue, linhas 512–531; createFarmSnapshotSource](../../packages/connector/src/runtime/agent.ts).

### validation

A validação exige origem HTTP(S) sem credenciais, caminho adicional, query ou fragmento, presente na allowlist. Limita mensagens a 256 KiB e valida tempos e ordem do backoff. [Fonte na base fixada: validateMoonrakerInput; Limits](../../packages/connector/src/config/moonraker.ts).

### local

A configuração v1 admite de uma a 16 impressoras, rejeita chaves duplicadas e valida todas antes da rede/fila. A leitura privada limita bytes, verifica proprietário/permissões e rejeita symlink final e arquivos não regulares. [Fonte na base fixada: LocalCollectorConfigSchema; parseLocalCollectorConfig; readPrivateJsonFile](../../packages/connector/src/config/local.ts).

### runtime

O runtime compara quantidade e pares printer_key/moonraker_origin com assignments provisionados, verifica farm/agent e mantém handles privados. Uma interface genérica de coleta não torna essa configuração multiprotocolo automaticamente. [Fonte na base fixada: readAgentRuntimeConfig](../../packages/connector/src/config/runtime.ts).

### client

A prontidão usa GET /server/info sem redirects e com credentials omit. A assinatura usa printer.objects.subscribe para webhooks.state, print_stats.state e virtual_sdcard.progress. O caminho completo opcional consulta também extruder.temperature e heater_bed.temperature. Falhas incluem offline, stale, not-ready e invalid-response; HTTP não exitoso também vira offline, portanto esse rótulo não certifica impressora fisicamente desligada. [Fonte na base fixada: readMoonrakerReady; openMoonrakerClient; selectedObjects; completeObjects](../../packages/connector/src/moonraker/client.ts).

### subscription

A assinatura mantém baseline por conexão, época, tempos monotônicos por campo, ordenação por eventtime e invalidação. Deltas antigos são ignorados; conflitos no mesmo tempo invalidam. Observações brutas precedem deduplicação por estado/progresso; ausência de mudança não impede renovação da evidência completa. RawMoonrakerUnavailable transporta chave e época, sem motivo. [Fonte na base fixada: createMoonrakerSubscription; RawMoonrakerObservation; RawMoonrakerUnavailable](../../packages/connector/src/moonraker/subscription.ts).

### parse

A normalização exige objetos e progresso válidos. startup vira offline; shutdown/error de webhooks viram error; printing/paused/error são preservados e os demais estados conhecidos de impressão viram idle. Campo ausente ou enum desconhecido é rejeitado, não convertido em idle. [Fonte na base fixada: parseMoonrakerSnapshot; klippyReady](../../packages/connector/src/moonraker/parse.ts).

### state

O DTO contém chave, estado idle/printing/paused/error/offline, progresso obrigatório, observedAt e temperaturas opcionais. Não representa unknown, stale, unsupported, versão de firmware ou capacidades por recurso. [Fonte na base fixada: PrinterState](../../packages/farm-protocol/src/state.ts).

### temperature

A leitura distingue absent, invalid e reading para extruder e heater_bed. Isso não identifica unsupported por firmware; o caminho contínuo inspecionado não representa uma lista de múltiplos bicos. [Fonte na base fixada: parseTemperatureFields; TemperatureFields](../../packages/connector/src/moonraker/temperature-observation.ts).

### provider

A fonte exige o conjunto completo de assignments e tempos válidos por campo. A validade é limitada a cinco segundos por campo e pelo deadline de admissão. Invalidação retira épocas; temperaturas usam carimbo próprio. Se falta um membro ou expira evidência, não fornece snapshot completo. O tipo importado ainda depende de RawMoonrakerObservation. [Fonte na base fixada: createFarmSnapshotSource; observe; invalidate; snapshot](../../packages/connector/src/runtime/farm-snapshot-provider.ts).

### discovery

Existe descoberta separada com identify, server.info, printer.objects.list/query e webcams. identify registra conexão visível. Na busca limitada em packages/connector/src e tests, os chamadores encontrados de discoverMoonraker são testes; collectIntoQueue usa diretamente a assinatura. Descoberta de ferramentas não comprova integração multibico no fluxo contínuo. [Fonte na base fixada: discoverMoonraker](../../packages/connector/src/moonraker/discovery.ts).

### control

PauseDriver é uma fronteira de operação fixa com beforeSend síncrono e confirmação posterior. ControlObservation admite unknown, mas pertence ao controle. Não deve ser reutilizado como autorização de telemetria nem ampliado para comandos arbitrários. [Fonte na base fixada: PauseDriver; PreparedPauseDriver; ControlObservation](../../packages/connector/src/control/pause-dispatcher.ts).

### pause

O driver de pausa declara pin de contrato Moonraker v0.9.3, commit 71f9e677b81afcc6b99dd5002f595025c38edc7b. Esse comentário não comprova firmware instalado nem certifica a coleta em toda versão. [Fonte na base fixada: openFixedMoonrakerPause](../../packages/connector/src/moonraker/pause-driver.ts).

## Testes existentes, não executados

- [tests/unit/moonraker-parser.test.ts](../../tests/unit/moonraker-parser.test.ts): Rejeição de campos ausentes/desconhecidos, limites, framing e prontidão.
- [tests/unit/moonraker-client.test.ts](../../tests/unit/moonraker-client.test.ts): Reconexão, stale, origens inválidas, abort, conflitos de tempo, respostas completas e temperaturas fora da fila normalizada.
- [tests/unit/moonraker-collect.test.ts](../../tests/unit/moonraker-collect.test.ts): CLI Node, persistência, transição antes de snapshot, validação anterior à rede, falha de append e descarte de sockets.
- [tests/unit/moonraker-discovery.test.ts](../../tests/unit/moonraker-discovery.test.ts): Handshake, ferramentas, webcams, deadlines e erros.
- [tests/node/farm-snapshot-provider.test.ts](../../tests/node/farm-snapshot-provider.test.ts): Conjunto completo, validade por campo, retirada de época, deadlines e temperaturas ausentes/inválidas.

## Fonte oficial

A documentação descreve list/query/subscribe; objetos ou atributos inexistentes são omitidos sem erro e subscribe requer conexão persistente. [Printer Administration](https://moonraker.readthedocs.io/en/latest/external_api/printer/). Publicação: não informada. Acesso: 2026-11-13. Página latest, sem revisão fixada; não comprova versão instalada. A URL anterior /en/latest/web_api/ retornou HTTP 404.

## Menor separação proposta

Inferência baseada na [coleta](../../packages/connector/src/runtime/collect.ts) e na [fonte de snapshots](../../packages/connector/src/runtime/farm-snapshot-provider.ts): extrair a criação da assinatura e o contrato interno de observação. Preservar fila, exibição, épocas e validade por campo. Trocar apenas a factory não resolve os tipos brutos nem os assignments específicos de Moonraker. Não preencher dados desconhecidos para satisfazer PrinterState.

Manter WebRTC browser–Connector, autoridade e segurança do Connector é condição de aceitação. Não ampliar PauseDriver nem usar evidência de exibição como autorização. [Regras](../../AGENTS.md), [contrato de controle](../../packages/connector/src/control/pause-dispatcher.ts).

## Lacunas e limites

- Firmware, hardware, autenticação efetiva e configuração de cada dispositivo permanecem desconhecidos; nenhuma compatibilidade de marca foi estabelecida.
- O DTO atual perde motivos de indisponibilidade e não carrega capacidades por dispositivo/firmware. Ausência de campo não autoriza unsupported; offline do cliente não é diagnóstico físico.
- A coleta contínua usa um extruder e uma mesa; descoberta multibico separada não basta para afirmar cobertura contínua.
- Índice CodeGraph ausente: sync/query/explore falharam; status informou initialized:false e versão 1.6.2. Usadas buscas delimitadas e leitura de arquivos; nenhum índice criado.
- Testes de produto, check:all, integração, simuladores e hardware NOT_RUN. Nomes e corpos limitados de testes são evidência de intenção, não de aprovação.

## Próximos passos

1. Revisar independentemente este mapa na base fixada.
2. Em tarefa futura autorizada, extrair somente a fronteira interna de assinatura/observação entre collectIntoQueue e createMoonrakerSubscription, mantendo o adaptador Moonraker como implementação padrão e o ciclo done/AbortSignal/callback síncrono.
3. Separar observação normalizada de status bruto Moonraker sem perder épocas, tempos por campo, invalidação e temperaturas. Preservar DTO/fila existentes nesta primeira extração; não transformar dados incompletos em PrinterState.
4. Antes de outro protocolo, especificar resultado discriminado para unknown/offline/stale/unsupported e capacidades por dispositivo, firmware e recurso, com origem da evidência. Evolução de configuração e assignments exige revisão separada.
5. Qualificar equivalência com os testes mapeados e fixtures de ausência, reconexão, mensagens malformadas, ordem, múltiplos bicos e isolamento; depois executar check:all no candidato autorizado. Hardware permanece gate manual separado.

## Aceitação

O gate estrutural não certifica fatos, firmware ou hardware. Revisão independente deve conferir referências no SHA indicado e equivalência dos contratos antes de qualquer implementação. Nenhum ranking ou suporte de marca é reivindicado.
