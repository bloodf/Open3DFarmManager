# Decisão de admissão de adaptador

Corte: 2026-11-13. Base: `bad76165aa4fbe86949ae624ddedc973721d5fcf`. HEAD inspecionado: `c0c988c9151099aaaaefbe4c4378819ee5a43983`. Ancestralidade confirmada, exit 0. Escopo FDM. Proposta para revisão do coordenador; nenhum código de produto admitido por este documento.

## Decisão única

Extrair a projeção pura de snapshot Moonraker validado em `packages/connector/src/moonraker/normalize.ts`. Manter `parseMoonrakerSnapshot` como entrada pública, com contexto, framing, limites, schemas, códigos e ordem de erros intactos. A função interna recebe apenas campos já validados e contexto validado, retorna a mesma estrutura com `sourceEventtime` e `printer`, e não faz I/O. Manter `PrinterState.parse` e a precedência atual. Não criar interface universal, registry, SDK ou transporte novo. Esta é uma proposta baseada em [parse.ts](../../packages/connector/src/moonraker/parse.ts), não uma implementação existente.

Um implementador possui exatamente estes caminhos futuros:

- `packages/connector/src/moonraker/normalize.ts`, novo módulo puro, sem dependência circular de parse.ts.
- `packages/connector/src/moonraker/parse.ts`, delegação depois das validações existentes; exports públicos preservados.
- `tests/unit/moonraker-parser.test.ts`, ampliar oráculos pela entrada pública.

Reutilizar tipos existentes; quando necessário, declarar somente a forma estreita dos campos consumidos. Não duplicar schemas nem mover validações. Nenhum outro caminho de produto, configuração, protocolo, UI, manifesto ou teste está admitido nesta fatia.

## Como os relatórios informam a decisão

[Moonraker](moonraker-baseline.md) identifica acoplamento entre coleta, assinatura e observação. Extrair toda essa fronteira agora ampliaria o escopo. [Autoridade](authority-boundary.md) exige conservar identidade, validade, replay e reconciliação; nenhum desses mecanismos entra na extração. [Fixtures](fixture-plan.md) fornece casos de falha e isolamento, mas seus casos de capacidades genéricas dependem de contrato futuro. [UI](ui-diagnostics.md) distingue inventário e conectividade; não haverá mudança visual. [Instalação](install-baseline.md) registra requisitos e lacunas de instalação, sem exigir migração nesta fatia.

[Anycubic](anycubic.md), [Bambu](bambu.md), [Creality](creality.md) e [consolidação](matrix-consolidation.md) são entradas documentais, não provas de integração. A consolidação revisa critérios de disponibilidade dos relatórios anteriores; suas lacunas de cronologia e firmware permanecem fora desta decisão. Não repetimos datas de modelos nem declaramos acesso ou suporte. Ausência de contrato verificável bloqueia adaptador de fabricante, mas não bloqueia esta extração local.

## Callers e comportamento preservado

Busca limitada `rg -n 'parseMoonrakerSnapshot' packages tests` encontrou o caller de produção em `packages/connector/src/moonraker/subscription.ts:181`. Os consumidores indiretos são coleta e fonte de snapshots conforme [baseline](moonraker-baseline.md). Callers de teste adicionais: `tests/unit/integrated-decoders.test.ts`, `tests/node/integrated-telemetry.test.ts`, `tests/node/telemetry-drain.test.ts`, `tests/node/connector-credential-renewal.test.ts`, `tests/node/telemetry-ingestion.test.ts` e `tests/helpers/postgres-telemetry-integration.ts`. Todos conservam assinatura e import existentes. A busca não prova cobertura de chamadas dinâmicas.

O parser atual mapeia startup para offline, shutdown/error para error, e estados conhecidos de conclusão para idle. Ausências e enums desconhecidos são rejeitados. Preservar esse comportamento legado não autoriza mapear unknown para offline em outro protocolo. [Fonte](../../packages/connector/src/moonraker/parse.ts).

A documentação oficial informa que objetos/atributos inexistentes são omitidos e que subscribe requer conexão persistente. Publicação não informada; acesso em 2026-11-13; página latest sem pin de firmware. [Moonraker Printer Administration](https://moonraker.readthedocs.io/en/latest/external_api/printer/). Isso não certifica equipamento.

## Aceitação e regressões propostas

1. Manter saída exata para as 24 combinações dos quatro estados webhooks e seis print_stats, com progress 0 e 1, contexto e eventtime fixos. Usar tabela de resultados explícita, sem calcular esperado com a implementação.
2. Preservar rejeição e código para ausências, null, enums desconhecidos, progresso fora do intervalo, NaN/infinito quando representável na entrada, contexto inválido e framing inválido. Quando contexto e frame forem inválidos juntos, preservar precedência invalid-context.
3. Preservar stripping de campos remotos, sem mutar fixture/contexto. Não adicionar temperatura, firmware, capacidade ou valores default.
4. Confirmar diff restrito aos três caminhos. Assinatura, fila, epochs, tempos monotônicos, deduplicação, invalidação, allowlist, autenticação, WebRTC browser–Connector e segurança do Connector permanecem intactos. Não introduzir TURN nem fallback HTTP de comandos, conforme [AGENTS](../../AGENTS.md).
5. Rodar os comandos abaixo antes/depois no ambiente compatível com [package.json](../../package.json). Fixtures sintéticas, corpus finito e relógios fixos nos novos casos; nenhum hardware. Registrar SHA, exits e primeira falha. Não aceitar testes skipped como cobertura.

```sh
pnpm exec vitest run tests/unit/moonraker-parser.test.ts tests/unit/integrated-decoders.test.ts tests/unit/moonraker-client.test.ts tests/unit/moonraker-collect.test.ts
node --test --test-timeout=120000 --test-force-exit tests/node/farm-snapshot-provider.test.ts tests/node/integrated-telemetry.test.ts tests/node/telemetry-drain.test.ts tests/node/connector-credential-renewal.test.ts tests/node/telemetry-ingestion.test.ts
pnpm run check:all
```

Comandos propostos, NOT_RUN nesta entrega. Dependências e requisitos nativos devem estar preparados antes da qualificação, conforme [instalação](install-baseline.md). Integração PostgreSQL/RTC e hardware permanecem gates separados, não comprovados por esses comandos.

## Riscos, rollback e bloqueios

Riscos da extração: alterar precedência de erro, admitir campo antes rejeitado, criar ciclo de imports ou perder stripping. Os oráculos acima são critérios de rejeição do candidato. Não alterar o DTO para encaixar dados desconhecidos.

Rollback da futura fatia: reverter seu commit coerente, removendo módulo novo e restaurando delegação/testes correspondentes; sem migração de dados ou configuração. Preservar commits posteriores e trabalho alheio. Revisar e repetir regressões no rollback antes de publicação.

CodeGraph 1.6.2 estava sem índice; sync/query/explore falharam e status informou initialized:false. Nenhum índice criado. Inspeção estática delimitada; nenhum teste de produto, build, instalação, simulador ou hardware executado. Gate estrutural valida formato, não fatos nem segurança. O bloqueio real para código é a admissão separada pelo coordenador; para protocolo novo falta evidência por dispositivo/firmware. Nenhum novo HOLD geral é imposto.
