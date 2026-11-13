# Diagnóstico de UI: descoberta, configuração e estado

Data de corte: 2026-11-13. Escopo: FDM. Firmware e hardware não foram identificados; este relatório é diagnóstico de código, não certificação de compatibilidade.

## Fluxos observados

`/impressoras` carrega farms, atribuições e connectors em páginas separadas. Atribuir uma impressora exige confirmação de configuração local e informa explicitamente que registro não prova conexão nem autoriza comandos. Erros de consulta limpam os dados e movem foco ao resumo acessível. Evidência: `apps/farm/app/pages/impressoras.vue`.

`/connectors` consulta inventário aprovado; a própria interface explica que registro de pareamento não indica conexão atual. Em falha, limpa o inventário, diferencia sessão 401 e foca o alerta. Evidência: `apps/farm/app/pages/connectors.vue`.

A menor extensão recomendada é um resumo por impressora que combine modelo base e firmware somente quando reportados por evidência identificada, e mostre capacidades individualmente como `documentada`, `desconhecida` ou `não suportada neste modelo/firmware`. Não inferir suporte de marca, família ou protocolo. Sem telemetria recente, indicar estado desconhecido; dados previamente válidos vencidos devem aparecer como desatualizados; somente sinal explícito de transporte perdido sustenta desconectado. Manter a autoridade e as verificações de segurança no Connector.

## Aceitação proposta

- Teclado: seleção, expansão e atualização alcançáveis sem mouse; foco visível e ordem lógica; alerta de erro recebe foco sem apagar contexto de formulário não sensível.
- Mobile: cartões empilham sem rolagem horizontal, capacidades e estado continuam associados ao dispositivo e rótulos não dependem apenas de cor.
- Desconexão: exibir desconectado somente após evidência de transporte; desconhecido e desatualizado permanecem estados distintos; comandos indisponíveis continuam bloqueados pelo Connector.

Esses critérios são propostas, não resultados de testes. Não foram executados browser, testes, builds, simuladores ou hardware. CodeGraph 1.6.2 informou `initialized:false`; consultas e sync não puderam operar sem índice. Fontes oficiais de fabricantes não foram consultadas nesta tarefa. Logo não há alegações de modelo, disponibilidade ou compatibilidade.

## Próximos passos

1. Associar metadados de modelo/firmware a cada dispositivo com origem e instante de observação.
2. Definir capacidades por combinação exata de modelo e firmware, mantendo desconhecido como padrão.
3. Validar estados e critérios com testes de teclado, viewport móvel e perda/recuperação de WebRTC, sem comandos físicos.
4. Obter documentação oficial datada antes de publicar qualquer alegação de suporte.
