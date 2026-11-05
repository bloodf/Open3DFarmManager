# Resultado diagnóstico da sessão ARM64 nativa

Uma sessão diagnóstica local usou a imagem fixada `sha256:4fa52c3d57722ef38cfd05a31fd0237347e0e6285fc1371b133a6789798602b7`, o mesmo launcher e os mesmos limites de recursos aprovados. O relógio de 90 segundos começou antes do start, com a cópia e a verificação do helper dentro desse prazo. O adaptador previa o corte de novas consultas aos 88 segundos; o instante real de saída do laço não foi registrado. O watchdog independente confirmou a parada 201,4 ms após o prazo. A execução do adaptador terminou sem erro e observou a condição original de Moonraker conectado e pronto, mas **isso não demonstra prontidão sustentada nem aceitação do simulador**.

O último resultado pronto preservado pelo adaptador ocorreu em t0 + 30,796 s. Não é possível determinar o primeiro resultado pronto das consultas: `ready.json` é sobrescrito e não existe um histórico de todas as consultas. O log de Moonraker registrou Klippy pronto às 05:50:19,341 UTC e, às 05:50:32,314 UTC, registrou seu desligamento. O log de Klippy relata `MCU 'mcu' shutdown: Timer too close`. Essas são observações do mesmo ensaio; não estabelecem a causa do desligamento.

O laço de observação encerra consultas ao atingir o corte ou quando uma chamada lança `TimeoutError`, e não registra qual dessas condições encerrou o laço nem o resultado de cada consulta. Como o indicador de prontidão permanece verdadeiro após uma única resposta pronta, o código de saída zero não prova prontidão no restante da janela. Os logs observados mostram que Klippy entrou em shutdown após ter ficado pronto. Não se pode inferir que a última consulta pronta preservada foi a última consulta executada, nem que houve prontidão contínua até então.

## Identificação e relógios observados

No prefixo host, uma sessão registrou início, espera de identificação, início e retorno da identificação, conclusão da espera e conclusão bem-sucedida da sessão. A identificação durou 2,858447 s entre os eventos instrumentados; a espera observada durou 2,858843 s. O argumento real da espera era uma data-limite baseada em `reactor.monotonic`, sem alteração do timeout.

O prefixo AVR contém 763 pares de leitura de relógio, do primeiro intervalo monotônico `[31361653092938, 31361653101396]` ns ao último `[31440009706824, 31440009720616]` ns: cerca de 78,357 s entre esses limites. Vinte e oito pares têm intervalos numéricos que cruzam a janela de identificação host; os pares externos mais próximos ficam cerca de 82,9 ms antes e 28,7 ms depois. Essa sobreposição numérica e a mesma identidade de boot registrada nos processos não demonstram, por si, alinhamento completo dos domínios ou cobertura de todas as operações. O par do reactor observado fornece apenas um bracket local, não uma prova de alinhamento durante toda a sessão.

A atestação no próprio processo vinculou o helper carregado ao SHA-256 `de41f025d48731ae9f8bae782c6d10a6f6dd32887b04c77e413a36e0be5ef32f` e a extensão AVR carregada ao SHA-256 `875945972e2e8303f5cccd921b2b1d54aa13b25c209c8ce902061cb074356b3c`, com conferência dos mapeamentos e descritores. Isso identifica os objetos carregados; não prova a unidade de `GetCurrentTime` nem a relação fonte-binário da extensão. As unidades dos ticks permanecem desconhecidas e nenhuma taxa nominal foi usada para convertê-los.

Os prefixos host e AVR foram estruturalmente válidos, sem descartes de captura ou transporte observados; continham respectivamente 7 e 764 eventos. A parada forçada não produziu footers normais. A integridade integral dos streams, cobertura do intervalo e dos reinícios, alinhamento de relógios e overhead total continuam não verificados. Os dados não demonstram causalidade de arquitetura, CPU, throttling ou agendamento para o shutdown.

## Próxima evidência necessária

Antes de uma nova conclusão de aceitação, o coletor de prontidão precisa registrar, de forma limitada, cada resposta, falha e tempo de consulta, além da razão e do instante em que o laço termina. A condição de pronto e o prazo original não devem ser relaxados. Um experimento posterior deve ter uma variável discriminante justificada e medir também as condições de escalonamento relevantes; repetir a mesma execução não resolve a causa. Qualquer comparação de ticks exige verificar a implementação e a unidade da extensão carregada e o domínio comum de relógio. A evidência privada preserva os recibos de identidade, o archive, os prefixos, os logs e os resultados do watchdog; dados de configuração privada não foram incorporados ao repositório.

A preparação verificou 62 testes sintéticos com Python 3.11 e os recibos do helper. A primeira invocação nativa anterior parou antes do start por usar Python 3.9; o ensaio acima usou uma nova preparação e Python 3.11. O contêiner e a referência de imagem criados para o ensaio foram removidos após a captura; o banco compartilhado não foi alterado. Não houve teste com impressora física. `bun run check:all` e a aceitação completa permanecem pendentes.

## Continuação: leitura dos relógios e próximo experimento

A fonte fixada do helper usa `CLOCK_MONOTONIC_RAW` para `reactor.monotonic`. Na amostra pareada de `identify_wait`, o valor retornado pelo reactor ficou dentro do bracket RAW e fora do bracket Python `CLOCK_MONOTONIC`; os domínios diferiam cerca de 4,73 ms naquele instante. Esse único par sustenta a identificação local do domínio, não uma equivalência contínua entre processos ou uma estimativa de deriva.

Condicionalmente à comparação numérica dos brackets RAW dos dois processos, os pares AVR dentro da janela de identificação variaram 265.135.350 ticks em 2,766150–2,766165 s, ou 95,849–95,850 milhões de ticks por segundo. Nos intervalos de aproximadamente dois segundos antes e depois do timestamp RAW de recebimento do shutdown, as faixas calculadas foram 133,105–133,110 e 126,636–126,638 milhões de ticks por segundo, respectivamente. Os brackets limitam somente essas observações amostradas. Eles não estabelecem unidade dos ticks, domínio comum completo, atraso de tarefa ou causa do shutdown.

O `avrsim.py` fixado declara uma constante nominal de 10⁹ para o pacing e usa `time.time()` nessa rotina. Essa suposição da fonte não identifica a unidade da extensão nativa carregada. A evidência ainda não discrimina atraso de escalonamento do host, avanço do AVR em relação ao relógio real, conversão de ticks, ou efeito da instrumentação. Os contadores agregados de outra execução não podem ser atribuídos a este shutdown.

Uma cópia privada do adaptador agora registra consultas de prontidão limitadas, estado conectado e estado de Klippy, timeouts, razão de término e quantidade descartada. O relatório separa prontidão já observada de cobertura **amostrada** após a primeira resposta pronta, com intervalo máximo predefinido de 2 s, pelo menos duas amostras, corte previsto alcançado e sem erro, timeout, perda ou estado posterior não pronto. Isso não prova prontidão contínua entre amostras. A cópia preserva o gate histórico e o deadline; 21 testes sintéticos passaram, incluindo pronto seguido de shutdown e timeout. A alteração ainda não foi executada no simulador.

Um próximo experimento discriminante possível é manter imagem, configuração, limites e relógio de 90 s idênticos, com os wrappers de relógio da sessão desativados como única variável e a nova observação limitada de prontidão. Isso testa se a instrumentação é necessária para reproduzir o sintoma; um único resultado não provaria causalidade. A decisão de executá-lo e a análise de equivalência do launcher exigem revisão separada. Para investigar escalonamento ou throttling, seriam necessários contadores e evidência por processo no mesmo intervalo, com seus limites e overhead registrados.

## Controle sem wrappers de relógio

Um controle ARM64 nativo posterior manteve imagem, configuração, launcher, identidade, limites e janela originais; a única mudança no produtor foi não instalar os wrappers host e AVR de relógio da sessão. Os mesmos carregamentos verificados e a atestação dos objetos nativos foram preservados. Os hashes do helper e da extensão carregados coincidiram com a sessão instrumentada. O relatório adicional de consultas não altera o gate histórico nem estabelece prontidão contínua.

Foram registradas 424 consultas: uma expirou, 15 terminaram com erro de comando, duas observaram desconexão, 68 observaram startup, 50 observaram pronto e 288 observaram shutdown. A primeira resposta pronta ocorreu em t0 + 19,851 s e a última em t0 + 34,687 s; o primeiro shutdown observado ocorreu em t0 + 34,998 s e o último estado amostrado, em t0 + 87,841 s, também foi shutdown. Não houve descarte de registros de consulta. A cobertura amostrada de prontidão foi **falsa**. O log de Klippy registrou novamente `MCU 'mcu' shutdown: Timer too close`; o log de Moonraker registrou pronto às 06:22:14,330 UTC e shutdown às 06:22:29,046 UTC. O adaptador retornou zero pelo gate histórico de ter observado pronto, não por estabilidade nem por aceitação completa.

Como o mesmo sintoma ocorreu sem os wrappers, eles não foram necessários para os dois shutdowns observados. Isso não mede o overhead deles e não demonstra a causa. Os recibos privados de resultado e consultas têm respectivamente SHA-256 `f63f4bb41c09ace4aece5e62deb2506191ce7a5af34b86bc9b2465e46a4fb86e` e `fcbcc81726ea0430535e168baa0f8669468f145eb1b9dee46392fe0fad12db0d`. O contêiner e a referência de imagem criados para o controle foram removidos; a identidade e o estado Docker do contêiner PostgreSQL compartilhado permaneceram iguais ao inventário anterior, sem consulta ou alteração no banco.

A leitura da fonte fixada mostra que o comando observado não fornece `-r`; o default da opção de pacing é zero, portanto o ramo opcional de pacing não é ativado. A constante nominal 10⁹ e `SetClockFreq` mostram a suposição do driver, não provam a unidade ou implementação interna da extensão nativa. Próximo ao shutdown, os logs do host reportaram estimativas `freq` em torno de 2,03 milhões, diante da configuração nominal de 20 MHz; essas estimativas não medem diretamente a frequência física nem demonstram por que o timer atrasou. A presença ou ausência de pacing, o avanço efetivo do AVR e o escalonamento do processo continuam hipóteses distintas.

A próxima intervenção diagnóstica proposta é acrescentar somente coleta limitada e somente leitura de contadores de CPU do cgroup e de escalonamento por processo ao mesmo controle sem wrappers, com timestamps e limites de overhead registrados, mantendo a condição de pronto, o prazo e os limites de recursos. A comparação temporal pode verificar se há throttling ou atrasos observáveis próximos ao shutdown; contadores agregados não provam causalidade nem descartam outras causas. A opção `-r 1` mudaria o pacing da simulação e não aceleraria necessariamente um processo já atrasado; não deve ser tratada como correção ou comparação equivalente sem revisão e autorização próprias. Nenhum novo ensaio foi executado nesta continuação.

## Ensaio posterior de observação do pacing

Um ensaio posterior, autorizado separadamente, acrescentou `-r 1` e um produtor
limitado de estatísticas ao AVR. Preservou a imagem, o firmware, o helper, a
extensão, o launcher, os limites de recursos e o prazo original de 90 s. O
watchdog confirmou a parada cerca de 170 ms após esse prazo. O adaptador
terminou em 90,860 s, sem erro de lifecycle; esse resultado não equivale a
aceitação do simulador.

Das 659 consultas registradas, 23 tiveram erro durante a inicialização, 94
observaram estado não pronto e 542 observaram pronto. Após a primeira resposta
pronta, não houve outra resposta não pronta: as amostras prontas abrangem
71,148 s, com intervalo máximo de aproximadamente 297 ms. Os logs de Klippy,
Moonraker e Supervisor foram capturados sem truncamento; não contêm o shutdown
`Timer too close` observado nos ensaios anteriores. O relatório estrito de
cobertura amostrada continua falso porque seu predicado também rejeita os
erros de consulta anteriores à primeira prontidão. Nenhum critério foi
relaxado e a ausência de falha entre amostras não prova prontidão contínua.

O coletor rejeitou o resumo AVR por um defeito concreto de metadados:
`main()` atribui `_PACING_PROBE_OPTIONS` localmente, enquanto o emissor lê esse
nome no namespace global. O evento contém `options: {}` em vez das opções
exigidas. O evento bruto registra 34.345 observações de offset e zero chamadas
de espera na janela inicial de 36 s, mas não é um recibo validado pelo coletor.
Nem esse dado bruto nem a prontidão observada demonstram que o pacing causou
a diferença em relação ao controle. As unidades da extensão e a cobertura de
reinícios continuam não verificadas; a parada forçada não produziu footers
normais.

Dois testes sintéticos reproduziram o resumo vazio executando o parser real
de opções de `main()` até um limite nativo substituído. Uma declaração
`global` corrige a passagem das opções ao emissor. Os dois testes, junto com
cinco verificações existentes do gerador, passaram; o resumo com velocidade
não autorizada continua rejeitado pelo validador estrito. A fonte corrigida
tem SHA-256 `b25b26690221b8865e8a7a805afffbffc20f01c2f86f435f0fa446a687625648`.
Não houve execução nativa dessa correção. O arquivo executado, os recibos e
as falhas anteriores foram preservados, sem reclassificação retroativa.

O recibo original de resultado tem SHA-256
`3c89e13e5190112852866435cb509fe1f0436d3e0dd052bb99dfd8386688f317`;
o relatório de consultas,
`0e557c07402c985a3043388a58696254cd22cb48085cc04f3556baa3d6d7efff`.
O contêiner e a referência de imagem criados para o ensaio foram removidos.
Os dois contêineres preexistentes foram preservados. Não houve SQL, comando
para impressora, integração com o Connector ou aceitação completa da Fase 0
nesse diagnóstico.
