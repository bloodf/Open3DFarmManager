# Plano de qualificação sintética de adaptadores

Corte e consulta: 2026-11-13. Escopo inicial FDM. Base de produto `bad76165aa4fbe86949ae624ddedc973721d5fcf`; HEAD inspecionado `fcc9c962b27041f1be4934cd61bc5239298f86f8`. Ancestralidade confirmada por `git merge-base --is-ancestor`, exit 0. A diferença de HEAD é admitida.

Inspeção estática somente. Nenhum teste, simulador ou hardware executado. CodeGraph 1.6.2 retornou `initialized:false`; sync e query não puderam operar. Não foi criado índice. Foram usadas buscas delimitadas e leituras locais. Datas de publicação dos arquivos não foram apuradas; o SHA identifica a revisão, não uma data de lançamento. Não há afirmações de fabricante nesta entrega, portanto não foi necessária pesquisa web de fabricante.

## Evidência e reaproveitamento

- [S1] `tests/unit/moonraker-client.test.ts@fcc9c962b27041f1be4934cd61bc5239298f86f8:L37-114,259-319,461-542`: Fixture local registra requests/RPCs, encerra timers e sockets; testes declaram reconnect, stale e mensagens inválidas.
- [S2] `tests/unit/moonraker-discovery.test.ts@fcc9c962b27041f1be4934cd61bc5239298f86f8:L96-128,347-364`: Testes declaram seleção limitada de ferramentas, temperatura inválida nula e webcam ausente não fatal.
- [S3] `tests/unit/moonraker-parser.test.ts@fcc9c962b27041f1be4934cd61bc5239298f86f8:L19-119`: Casos declarados para ausência, estados desconhecidos, limites e framing.
- [S4] `tests/node/moonraker-pause-driver.test.ts@fcc9c962b27041f1be4934cd61bc5239298f86f8:L130-154,204-236,445-473`: Casos declarados para guarda final, ACK incerto, expiração e binding diferente.
- [S5] `tests/helpers/signalling-runtime-moonraker.ts@fcc9c962b27041f1be4934cd61bc5239298f86f8:L19-125`: Fixture exige opt-in explícito e apenas uma assignment; requests estritos separam pausa de coleta.
- [S6] `tests/helpers/connector-outage-fixtures.ts@fcc9c962b27041f1be4934cd61bc5239298f86f8:L148-185`: Proxy sintético possui modos pass/reset e registra eventos de ingestão. Não é fallback de comandos.
- [S7] `tests/unit/moonraker-collect.test.ts@fcc9c962b27041f1be4934cd61bc5239298f86f8:L220-238,406-445,535`: Casos declarados de persistência, falha de fila e mensagens excessivas.

O helper `fixture` de S1 é privado ao teste: reutilizar no mesmo arquivo primeiro. Não criar exportação compartilhada sem necessidade comprovada. O proxy S6 serve falhas de ingestão; não qualifica transporte browser–Connector. A fixture S5 é candidata para integração futura, não para os casos puros desta etapa.

## Casos propostos e ownership futuro

Os oráculos abaixo são propostas, não resultados obtidos. Um escritor por caminho; casos no mesmo arquivo pertencem ao mesmo responsável. Fixtures devem usar identidades sintéticas e nenhum segredo.

| Caso | Caminho de responsabilidade futura | Fonte | Estímulo e aceitação proposta |
| --- | --- | --- | --- |
| Reconexão | `tests/unit/moonraker-client.test.ts` | [S1] | Fechar socket após baseline t=100; reabrir com t=1. Exigir baseline novo, descarte do epoch anterior e nenhum callback após abort. Duas conexões, deadline 5 s. |
| Expiração | `tests/unit/moonraker-client.test.ts` | [S1] | Baseline válido seguido apenas de evento antigo; cruzar prazo configurado. Exigir stale sem renovar freshness, sem converter unknown em offline. Cobrir imediatamente antes/no/depois do prazo. |
| Ordem e ausência | `tests/unit/moonraker-parser.test.ts` | [S3] | Enviar delta antigo, duplicado, conflito com mesmo tempo e snapshot sem campo obrigatório. Exigir ausência explícita, sem estado idle inventado; política de conflito deve ser definida por contrato. |
| Malformados | `tests/unit/moonraker-client.test.ts` | [S1] | Corpus finito: JSON inválido, envelope errado, id desconhecido, binário e resposta prematura. Exigir rejeição, diagnóstico sem conteúdo remoto e nenhuma atualização aceita. |
| Múltiplos bicos | `tests/unit/moonraker-discovery.test.ts` | [S2] | Usar extruder e extruder1 com temperaturas distintas; alternar ativo, remover leitura e exceder MAX_TOOLS em um. Exigir identidade estável, nulo para leitura inválida e limite respeitado. Não inferir AMS/ACE/CFS. |
| Limites | `tests/unit/moonraker-collect.test.ts` | [S7] | Testar N-1/N/N+1 bytes e fragmentos conforme constantes atuais; incluir UTF-8 multibyte. Exigir rejeição antes de callback/fila, sem crescimento ilimitado. Não inventar limites de fabricante. |
| Capacidade indisponível | `tests/unit/moonraker-discovery.test.ts` | [S2] | Simular webcam ausente e capability desconhecida versus explicitamente não suportada para dispositivo/firmware sintético. Coleta restante continua; comando indisponível produz zero writes. Enumeração genérica depende de contrato futuro. |
| Isolamento | `tests/node/moonraker-pause-driver.test.ts` | [S4] | Dois bindings sintéticos A/B; trocar endpoint, identidade e resposta, um campo por caso. Exigir zero envio ao destino errado. Telemetria A não altera B; queda de A não invalida B. Parte de telemetria exige teste novo separado. |
| Autoridade e ACK | `tests/node/moonraker-pause-driver.test.ts` | [S4] | Expirar validade antes do envio, falhar guarda final, perder ACK após envio. Exigir zero write nos dois primeiros; resultado incerto sem retry no último. Manter autoridade no Connector. |

Manter WebRTC browser–Connector, sem TURN ou fallback HTTP de comandos, e autoridade no Connector conforme `AGENTS.md`. Unsupported é por dispositivo/firmware. Unknown não equivale a offline. Encerrar sockets, timers e processos próprios em finally; reservar deadlines explícitos e corpus finito. Estes são requisitos dos futuros testes, não alegações de comportamento já qualificado.

## Lacunas

- Testes não executados nesta entrega; nomes de testes são evidência de intenção, não aprovação runtime.
- Contrato multimarcas de capabilities, epochs e ausência ainda precisa ser admitido antes de exigir semântica uniforme.
- Fixture RTC inspecionada aceita uma assignment; não prova isolamento simultâneo entre duas impressoras.
- Firmware, hardware e acesso a protocolos de fabricantes desconhecidos. Nenhum ranking ou suporte físico declarado.

## Próximos passos

1. Revisar independentemente as fontes no HEAD registrado e admitir os oráculos propostos.
2. Atribuir cada caminho a um único responsável; separar telemetria de autoridade e reservar tests/unit/adapter-isolation.test.ts como arquivo futuro, ainda inexistente.
3. Implementar primeiro casos puros, depois loopback limitado; só em autorização futura executar integração RTC/simulador com ledger e cleanup.
4. Registrar SHA, comando, exit, logs e recursos por execução; hardware requer autorização e evidência própria.

O gate estrutural desta entrega valida formato e whitespace. Não certifica fatos, execução dos testes, compatibilidade com firmware ou hardware. Check de integração e `pnpm run check:all` permanecem não executados, fora do escopo autorizado deste relatório.
