# Resultado nativo da observação UART

Em 5 de novembro de 2026, UTC, foi executado exatamente um controle nativo
amd64, seguido por uma execução instrumentada. Nenhuma execução observou
prontidão dentro do limite original de 90 segundos. A aceitação do simulador
continua pendente. Não houve terceiro teste nem comando para impressora física.

Os detalhes operacionais e as evidências brutas deste experimento permanecem
fora do repositório. Este registro preserva somente o resultado necessário para
a fila de trabalho; não publica configurações locais, detalhes do host ou logs.

## Resultado

O controle e a execução instrumentada não alcançaram prontidão dentro do limite
original de 90 segundos. Não é possível atribuir uma causa a partir deste par.

## Observações e limites

O controle terminou a amostragem com Klippy conectado e estado `shutdown`.
A execução instrumentada terminou a amostragem com Klippy conectado e estado
`startup`. Os logs das duas execuções registraram timeouts de identificação e
falhas de comunicação com o MCU. Nenhuma dessas observações estabelece a causa.

A captura instrumentada está incompleta: foi preservado somente um sufixo, sem
o registro inicial `start`. O analisador rejeitou a captura. Sem o fluxo completo,
footer e contadores de descarte não podem ser verificados. Este resultado não
representa silêncio UART nem efeito causal da instrumentação.

## Verificação e encerramento

Os testes do helper de observação são sintéticos e não iniciam emulador. Detalhes
do executor local e da sua verificação permanecem fora do repositório. A captura
inconclusiva precisa de uma nova execução autorizada que preserve o início do
fluxo limitado.

`git diff --check` passou. `bun run check:all` não foi executado nesta tarefa e
continua pendente antes de publicação. Não houve push, PR, publicação ou deploy.

A próxima discriminação continua sendo a correlação das operações nativas de I/O,
identidade dos endpoints, entrega D0 e atividade D1 com a identificação aceita.
Uma coleta futura também precisa preservar o início de todo o fluxo limitado do
helper. Nenhuma execução adicional foi autorizada ou realizada nesta tarefa.
