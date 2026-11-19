# Glossário da interface

| Termo      | Uso na interface                                                            |
| ---------- | --------------------------------------------------------------------------- |
| Connector  | Aplicativo que conecta a farm às impressoras. Mantenha a inicial maiúscula. |
| impressora | Equipamento que executa a impressão.                                        |
| farm       | Grupo de impressoras administradas em conjunto.                             |
| trabalho   | Uma execução de impressão.                                                  |
| biblioteca | Coleção de arquivos disponíveis para impressão.                             |
| versão     | Revisão de um arquivo ou versão instalada de um software.                   |
| placa      | Superfície de impressão ou placa selecionável em um arquivo de impressão.   |

Use minúsculas no meio da frase, exceto para Connector.

Use os formatadores compartilhados em `apps/farm/app/utils/ui-format.ts` para
exibir datas e valores em português do Brasil. As datas usam o fuso de São
Paulo. Informe durações em segundos, temperaturas em graus Celsius, pesos em
gramas e porcentagens em pontos percentuais (50 representa 50%). Para valores
indisponíveis, exiba “Não informado” ou ajuste a concordância ao rótulo do campo.
