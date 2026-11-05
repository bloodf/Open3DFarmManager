# Experimento único de correlação UART

Estado: plano local, sem autorização de execução nativa. Base preservada
`da5d37790cc2b365233d2833495980d8128d2fcb`. O resultado histórico permanece
inconclusivo. Seus 56 arquivos, 4.009.180 bytes, executor e commits não mudam.
Este plano precede a implementação local. Não repetir coleta somente de métodos.

## Pergunta e decisão

Uma única execução futura instrumentada de até 90 segundos deve localizar a
primeira fronteira sem correspondência observada na mesma sessão de identificação.
Não há novo controle nesta autorização local. O controle histórico não mede o
custo dos novos probes; qualquer conclusão causal sobre overhead ou escalonamento
exigiria autorização e controles adicionais.

| Hipótese ainda não comprovada                               | Observação que discrimina na janela retida                                                                                                 |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Pedido não saiu do host ou saiu parcialmente                | `do_write`: bytes solicitados, retorno real, errno e prefixo efetivamente escrito; comparar com leitura master do mesmo par PTY            |
| Bytes chegaram ao master mas não foram transmitidos em D0   | Leitura master, inserção na fila e retirada/transição D0 com IDs de byte e ticks distintos; fila não comprova transmissão nem recepção AVR |
| Resposta não apareceu ou falhou na decodificação            | D1 no pino ligado ao TX AVR, amostras/bits e resultado do decoder; ausência de byte decodificado não prova ausência de transições          |
| Resposta foi perdida ou rejeitada no host                   | Decoder D1, retorno de escrita master, leitura host, buffer de quadro, CRC, sequência e identificação por sessão/offset                    |
| Janela de identificação acabou antes do progresso observado | Intervalos monotônicos alinhados a ticks e prazo de sessão; não atribuir starvation sem evidência por thread                               |

Ausência de observação, canal perdido, identidade incerta e silêncio são estados
diferentes. Este experimento não atesta silêncio físico, causa ou prontidão.

## Fontes, binários e licenças

Fixar Klipper `ee2c6fb6b00b2b5d097ef70d0868df7d74943b51`, projeto de imagem
`e272bcd1060dad6cee1598d6debdaa5d5afae3c7` e imagem
`sha256:c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47`.
Conferir bytes externos antes de transformar/importar e rejeitar divergência.

| Arquivo externo                | SHA-256 esperado                                                   |
| ------------------------------ | ------------------------------------------------------------------ |
| `scripts/avrsim.py`            | `a9561837163fae9dff45f056593ddec5b4919c4f3546b110401057c221bf238c` |
| `klippy/chelper/serialqueue.c` | `d519a5554233070f2560aff550899fa2402d69de08569df68b1306914823869d` |
| `klippy/chelper/msgblock.c`    | `6a7c6db524c38408ddf5718b13626cc4c5e5f2fdf85259c2b70f5dc2c34257ef` |
| `klippy/serialhdl.py`          | `72b1a8090d57b9ad7b03d379ce4385b35f8a3a14da709bce554a20f5aeb07dad` |
| `src/avr/serial.c`             | `987c33388e07514671782b046141ce43da04abba9d484e0bfb8d1459868eb0f6` |
| `klipper.elf`                  | `a1fd3c9723d5217b534cc4876700d9931b3db22f60b1f9410a8108b5de37ddef` |
| `klipper.dict`                 | `056531bf5ab68f337622fce947e5152a968593a0da39132ac7f7dc0aab86fe0a` |

As referências e a revisão de licenças estão em
[coletor](SIMULATOR-UART-COLLECTOR.md) e
[métodos](SIMULATOR-UART-METHOD-DIAGNOSTIC.md). A revisão privada Terra foi lida.
Klipper e o simulador externo têm avisos GPLv3. Não copiar suas implementações,
parser, CRC ou decoder para o projeto MIT. Probes novos são originais, stdlib,
sem dependências novas. Uma transformação futura fica somente na árvore externa,
com fonte original, diff exato, hash transformado e avisos GPL preservados
separadamente. Revisar licença e forma de distribuição antes desse passo.

Hash de fonte ou imagem não identifica binário carregado. Antes da execução,
registrar SHA-256 dos bytes do chelper, extensão pysimulavr, dependências ELF e
firmware realmente abertos. Registrar build ID quando presente, toolchain,
flags, mapa de ligação e vínculo reproduzível fonte/build. Durante a execução
futura autorizada, obter identidade de processo com geração/starttime, mapas
carregados, dispositivo/inode e hash do objeto mapeado, sem confiar só no caminho.
Rejeitar arquivo trocado/apagado ou identidade não resolvida. Observar o caminho
real usado por CFFI/import; não aceitar hash de um candidato em disco como prova.
Hoje esses binários e a revisão exata do simulavr continuam desconhecidos.

## Mecanismo mínimo escolhido

Preferir instrumentação controlada nos locais exatos de chamada existentes.
Não usar um segundo leitor PTY, proxy, fallback, alteração de baud ou pacing.
`TerminalIO` externo esconde errno e retorno de write; seu wrapper não satisfaz
a fronteira de syscall. Um adaptador original de chamada Python pode observar
`os.read/os.write` no namespace exclusivo do módulo externo antes do tratamento
original de erro, sem alterar globalmente `os` e sem repetir a operação.

No host C, envolver somente os `read/write` reais de `input_event/do_write`,
registrando errno imediatamente após a chamada e restaurando-o após telemetria.
Também registrar `tcflush`, reconexão e trocas de endpoint. A implementação C e
sua integração externa ficam bloqueadas até obter a identidade do build e revisar
a transformação exata. Não fingir que um adaptador Python intercepta chelper C.
ABI `LD_PRELOAD` foi considerado e não escolhido: ligação estática, símbolos
ocultos, chamadas diretas, versões de símbolo e `readv/writev` podem escapar.
Mesmo uma biblioteca carregada não prova cobertura. Não pressupor ptrace
permitido. Não mudar seccomp, capacidades, no-new-privileges ou credenciais.

Antes de aceitar cobertura, revisar todos os caminhos efetivos de I/O do build,
inspecionar chamadas/relocações e código gerado, impedir rebuild automático não
atestado, e executar no futuro um controle sintético do mesmo artefato mostrando
cada local instrumentado, inclusive erro e short I/O. Observar bindings/mappings
reais. Qualquer bypass não excluído mantém a cobertura não verificada.

Em avrsim, distinguir entrada na fila D0, retirada da fila, cada transição TX e
fim do byte. Registrar D1 no pino, amostragem e byte entregue a TerminalIO como
estágios separados. Confirmar conexões D0 RX/D1 TX, ATmega644p, 20 MHz e 250000
baud no ELF/config e no objeto efetivo, com unidade de ticks verificada.
Instrumentar decisões existentes de `msgblock_check` e `handle_message`, sem
reimplementar CRC: retorno zero incompleto, negativo descarte, positivo quadro;
registrar sequência aceita/rejeitada depois, separadamente. Em serialhdl registrar
sessão, offset solicitado, chunk aceito de identificação e timeout/conclusão.
Quadro válido não implica sequência aceita; chunk aceito não implica dicionário
completo. Mapear intervalos de bytes do buffer de entrada aos quadros observados.

## Correspondência e limites

Cada registro terá run, produtor, sequência local, PID/starttime/TID, local de
chamada, direção, FD/geração, dispositivo/inode/rdev e par PTY verificado. Registrar
identidade antes/depois da operação; troca ou erro invalida a associação. Linux
master e slave não precisam compartilhar inode; conferir associação PTY por
metadados próprios do par no mesmo namespace. Um caminho ou FD sozinho não basta.

Solicitação e retorno real ficam separados. Capturar hex limitado da solicitação
write e dos bytes realmente retornados em read, contagem total e truncamento.
Retorno negativo exige errno; sucesso usa errno nulo. Preservar erro original,
sem retries. Concatenar somente bytes efetivamente transferidos, por direção,
sessão e geração, preservando ordem e offsets. Short I/O e retransmissões exigem
intervalos distintos. Comparar host-write -> master-read -> D0-fila -> D0-TX;
comparar D1-pino -> D1-decoder -> master-write -> host-read -> quadro -> sequência
-> identificação. Hex repetido sozinho não estabelece identidade causal.

Bracketing antes/depois usa CLOCK_MONOTONIC ns e CPU por processo; ticks são
outro domínio. Confirmar boot/namespace de relógio comum dos processos, registrar
amostras pareadas monotônico/ticks e incerteza. Não ordenar intervalos sobrepostos
como causalidade; CPU agregada não mede starvation. Tick ausente ou regressão
mantém alinhamento desconhecido, sem converter ticks em tempo real por suposição.

Reusar `Collector` e `Completion` de da5d377 sem editar. Cabeçalho separado de
4 KiB, prefixo contíguo de 1 MiB, linha de 64 KiB, 4096 registros; produtores
limitam payload por evento a 64 bytes e declaram descartes. Nunca substituir
prefixo por cauda. Preservar footer quando observado e metadados externos de
início/fim, timeout, parada deliberada, EOF, retorno, erro de processo e perda
anterior ao coletor. Drenagem e prazo pertencem ao futuro executor, não ao parser.
Sem footer ou após truncamento, não afirmar fluxo completo ou silêncio.

## Entrega local e gates nativos restantes

A entrega local contém somente adaptador original de syscall Python, validador
limitado de recibos/correspondência e testes em memória. Nenhum runner executável
nativo será apresentado como pronto. O runner privado executado e scripts raiz
ficam intactos. Testes exercitam partial I/O, errno, reutilização de endpoint,
relógios, matching por prefixo, truncamento e rejeição de identidade não verificada.
São fixtures declaradas, não validação do binário, hardware ou emulador.

Antes de uma única execução instrumentada, exigir autorização específica,
transformação externa licenciada/revisada, provas de cobertura/binários/pinos,
integração de drenagem limitada sem deadlock e parada externa armada antes do
start. Preservar UID/GID 1000, no-new-privileges, cap-drop ALL, network none,
sem portas/dispositivos, 1 CPU, 1 GiB, 256 PIDs, 90 s, inicializador, ordem/delay,
reinícios, tmpfs, firmware, baud e pacing. Se qualquer gate falhar, não executar.
Nenhuma execução nativa está autorizada agora. `bun run check:all` continua
pendente antes de publicação; não há push, publicação, deploy ou prontidão.

## Contrato da implementação local

`uart_correlation_probe.py` não inicia programa nem instala hooks. `observe_io`
recebe uma chamada já escolhida pelo integrador e invoca-a uma vez. Retorna o
objeto original ou relança a mesma exceção, incluindo `BlockingIOError`. Registra
retorno curto/zero e errno de `OSError` antes do tratamento de erro externo.
O adaptador não observa errno C nem garante cobertura. Identidade de endpoint é
fornecida por callback; falha torna o recibo inválido. O callback deve comprovar
a geração e o par PTY externamente, não fabricá-los a partir do número do FD.

`verify_sources` exige todos os streams externos com hashes fixados.
`verify_bytes` compara bytes limitados com hash previamente revisado; não importa
ou executa o arquivo. Para binários, o chamador deve fornecer hashes revisados
independentes do log. Não existe hash nativo padrão permissivo. Recibos com hash
divergente ou ausente são rejeitados. Mesmo correspondência exata de recibos não
atesta objeto carregado: o relatório mantém `native_identity: unverified`.

`Recorder` emite cabeçalho, até 4094 eventos e footer reservado, com linhas de
até 4096 bytes. Falha/short write de telemetria desabilita saída. `collect` recebe
stream binário já aberto, `Completion` explícito e hashes nativos revisados.
Reutiliza o coletor original sem alterar seus limites ou semântica. Este sink
pode bloquear; não substitui drenagem/deadline do executor futuro.

A correspondência implementada compara apenas prefixos de bytes de syscall
no mesmo par/sessão. Reporta bytes e `equal-observed-prefix`,
`different-observed-prefix`, `not-observed` ou `incomplete`. Igualdade não prova
entrega ou causalidade. Reutilização de FD, mudança de identidade durante chamada
ou payload maior que 64 bytes impede correspondência conclusiva daquela sessão.
Clocks inválidos/regressivos são rejeitados; clocks nulos permanecem explícitos.
O relatório mantém alinhamento desconhecido mesmo com domínio comum declarado.

Registros `stage` locais apenas contam ocorrências rotuladas separadamente de
D0-fila, D0-TX, D1-pino, D1-decoder, quadro, sequência e identificação. Não validam
payload de decisão, CRC, pinagem ou associação de intervalos. Essas integrações
não foram implementadas sem fonte/build efetivos; `stage_mapping` continua
`unverified`. Não usar contagens como aceitação desses gates.

Verificação local, somente fixtures em memória e sem bytecode:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/sim/experiments -p 'test_uart_correlation_probe.py' -v
git diff --check
```
