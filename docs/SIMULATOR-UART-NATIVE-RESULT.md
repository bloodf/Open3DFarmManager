# Resultado nativo da observação UART

Em 5 de novembro de 2026, UTC, foi executado exatamente um controle nativo
amd64, seguido por uma execução instrumentada. Nenhuma execução observou
prontidão dentro do limite original de 90 segundos. A aceitação do simulador
continua pendente. Não houve terceiro teste nem comando para impressora física.

As duas preparações anteriores não executaram o emulador. O impedimento era a
ausência do executor privado, não uma autorização pendente.

## Condições preservadas

A imagem usada foi
`sha256:c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47`.
Antes de cada partida, a inspeção do contêiner ainda parado confirmou que o
`avrsim.py` tinha SHA-256
`a9561837163fae9dff45f056593ddec5b4919c4f3546b110401057c221bf238c`.
Essa verificação não executou o emulador.

Foram mantidos o inicializador e a configuração retidos, UID e GID 1000, uma
CPU, 1 GiB, 256 PIDs, todas as capacidades removidas e `no-new-privileges`.
Não foram adicionados rede, portas, dispositivos ou privilégios. A ordem de
partida, a espera inicial, as políticas de reinício e os tmpfs foram preservados.
A instrumentação substituiu somente a chamada do emulador pelo helper revisado,
com um arquivo montado somente para leitura e a captura necessária de stderr.

O executor armou a parada com relógio monotônico antes de iniciar cada
contêiner. As solicitações de parada ocorreram no prazo de 90 segundos, com
atraso registrado inferior a um milissegundo. A conclusão das chamadas Docker de
parada levou aproximadamente 0,7 segundo adicional. Esse tempo não conta como
janela de prontidão. As últimas amostras de estado ocorreram antes de 88 segundos.

Os arquivos da aplicação foram capturados antes da parada, entre aproximadamente
88,0 e 88,1 segundos. Depois da parada, foram retidos stdout, stderr e a inspeção
do estado, antes da remoção. O contêiner de controle foi removido antes da criação
do contêiner instrumentado.

## Observações e limites

O controle terminou a amostragem com Klippy conectado e estado `shutdown`.
A execução instrumentada terminou a amostragem com Klippy conectado e estado
`startup`. Os logs das duas execuções registraram timeouts de identificação e
falhas de comunicação com o MCU. Nenhuma dessas observações estabelece a causa.

A captura instrumentada está incompleta. O executor reteve somente o último
1 MiB de cada arquivo. Esse limite descartou o início do arquivo UART, incluindo
o registro `start`. O recorte preservou 2.714 registros completos: 54 retornos de
`read` e 2.660 retornos de `write`. Esses números descrevem apenas o recorte,
não os totais da execução. O analisador rejeitou a entrada com `missing start`.

Não há footer normal. As duas inspeções posteriores à parada registraram saída
137, sem OOM, após a parada forçada prevista pelo executor. A falta do footer e
a perda do início impedem verificar completude e descartes. Não representam
silêncio UART. Retornos dos métodos não comprovam entrega, recepção pelo firmware,
validação de quadros, dicionário carregado ou prontidão. A diferença entre os
estados finais também não prova efeito causal da instrumentação.

## Verificação e encerramento

O executor privado usa somente a biblioteca padrão e código original. Seus três
testes passaram localmente e no host nativo. Eles verificaram a ordem normal,
falhas injetadas em cada uma das seis etapas do ciclo, limpeza em `finally`,
retenção de saída anterior ao timeout e limites de saída. Os nove testes
sintéticos existentes do helper também passaram. Nenhum teste sintético iniciou
um emulador.

Os dois contêineres foram removidos. A referência da imagem, ausente na linha de
base e sem outro contêiner usuário, foi removida. Os inventários de contêineres,
volumes e redes voltaram à linha de base. Nenhum volume ou rede foi criado.
Os arquivos temporários remotos foram removidos após a cópia e conferência das
evidências. O checkout e o grupo de processos do coordenador foram preservados.
Logs, configurações, inventários e evidências operacionais permanecem fora do
repositório. Código GPL externo não foi copiado para este documento.

`git diff --check` passou. `bun run check:all` não foi executado nesta tarefa e
continua pendente antes de publicação. Não houve push, PR, publicação ou deploy.

A próxima discriminação continua sendo a correlação das operações nativas de I/O,
identidade dos endpoints, entrega D0 e atividade D1 com a identificação aceita.
Uma coleta futura também precisa preservar o início de todo o fluxo limitado do
helper. Nenhuma execução adicional foi autorizada ou realizada nesta tarefa.
