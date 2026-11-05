# Plano de uma execução ARM64 de identificação e relógio por sessão

Proposta de **uma única execução nativa Linux ARM64, com prazo de 90 s**.
Esta tarefa preparou o plano e testes sintéticos locais. Não iniciou contêiner,
pull, build, AVR, SSH, PG ou serviço. O coordenador deve reservar a CPU antes
de liberar a execução. Não há execução de controle, repetição automática ou
variante amd64 neste plano. O orçamento nativo permanece não utilizado.

O ponto de partida é `5ae3a526f86922a557b810c728cf9b0e9dede69e`, no checkout
já vinculado. Duas alterações parciais da sonda foram preservadas e completadas.
O trabalho não retoma a conversa bloqueada em outro cliente e não interfere
nesse cliente. Os recibos anteriores são imutáveis.

## Objetivo e limites da inferência

Observar, na mesma janela, a entrada real de `_start_session`, o callback real
de identificação, seu término, o argumento real de `completion.wait` e o ramo
que retorna `None`. Correlacionar essas fronteiras por identidade de processo
e sessão com amostras de `GetCurrentTime` feitas nas chamadas de I/O existentes.
Não criar leitor concorrente do PTY nem repetir o tracing amplo de UART.

A unidade nativa de ticks continua desconhecida. Registrar `simulation_ticks`
como contagem bruta, inclusive zero, regressão ou ausência. Não converter para
segundos com frequência nominal, não extrapolar deriva e não atribuir causa a
CPU agregada, lacunas de amostragem ou diferença de estado final. Esta proposta
atualiza a exigência anterior de conhecer a unidade antes de observar. Mantém
a exigência de atestar os objetos carregados e explicitar a incerteza temporal.

Cada evento tem RAW antes, MONOTONIC e RAW depois. A leitura de ticks tem seu
próprio bracket RAW dentro do bracket MONOTONIC. O evento `identify_wait`
retém `actual_deadline` sem recalculá-lo e observa `reactor.monotonic()` dentro
de brackets RAW e MONOTONIC próprios. A amostra extra não altera o argumento do
wait. Erro de observação produz `null` e preserva o resultado original.

O host usa segundos do domínio do reactor para o deadline. Converter apenas a
representação dessa amostra para comparar intervalos, com erro de representação
float explícito. Para uma tripla RAW `(a)`, MONOTONIC `(m)`, RAW `(b)`, registrar
`[m-b, m-a]`, com resolução reportada separada de exatidão. Não transportar o
envelope histórico para a nova execução. Cada processo deve informar relógios,
resoluções, PID e identidades de namespace de tempo. Sem demonstração de domínio
comum, apresentar as linhas do tempo separadas, sem sobreposição afirmada.

Para cada sessão, reter os timestamps de entrada e término, o deadline observado,
o resultado do wait e os brackets de ticks que realmente ocorreram nesse
intervalo. A identidade do callback fica presa à sessão mesmo após timeout ou
nova sessão. Uma sessão sem ticks sobrepostos fica sem cobertura. O footer e
um prefixo válido não estabelecem cobertura do intervalo nem captura completa.

## Artefatos fixados e atestação

| Artefato                                                            | SHA-256 obrigatório                                                |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Imagem `ghcr.io/mainsail-crew/virtual-klipper-printer`, Linux ARM64 | `4fa52c3d57722ef38cfd05a31fd0237347e0e6285fc1371b133a6789798602b7` |
| Manifesto externo do helper                                         | `c9da203c3cbec258b8165a1cf533cde29f58ec96db9efae88d92c78326ad368f` |
| Helper carregado, 315.336 bytes                                     | `de41f025d48731ae9f8bae782c6d10a6f6dd32887b04c77e413a36e0be5ef32f` |
| `serialhdl.py`                                                      | `72b1a8090d57b9ad7b03d379ce4385b35f8a3a14da709bce554a20f5aeb07dad` |
| `avrsim.py`                                                         | `a9561837163fae9dff45f056593ddec5b4919c4f3546b110401057c221bf238c` |
| Entrada `klippy.py`                                                 | `aa9eb47fbe3598fc814d40ed8e0b2b814a0af459fca7acab6732c59bf42e4659` |
| Módulo `pysimulavr.py`                                              | `ed85d9ff7e772f4944ba03b0d15cb530ae788021fb450a43f96d47c7791e6e72` |
| Extensão ARM64 `_pysimulavr`                                        | `875945972e2e8303f5cccd921b2b1d54aa13b25c209c8ce902061cb074356b3c` |

Preservar exatamente os 32 arquivos externos do helper, 176.365 bytes, incluindo
hash, caminho relativo, modo, mtime_ns e UID/GID do manifesto. Conferir também
`reactor.py` e `COPYING`. O recibo do build anterior atesta esse helper naquele
processo, não um arquivo hoje disponível. Seu tmpfs foi removido. A preparação
futura precisa disponibilizar e atestar novamente o objeto antes de iniciar AVR.
Se exigir reconstrução, reproduzir o procedimento externo já verificado, mesmas
21 fontes, ferramentas e flags; qualquer hash diferente bloqueia esta proposta.
Não substituir pelo helper fornecido na imagem nem ignorar a verificação.

Na execução futura, conferir hash pelo descritor aberto e igualdade de dispositivo
e inode com todas as entradas correspondentes em `/proc/self/maps` do processo
host. Atestar também a extensão realmente mapeada no processo AVR. O pathname
isolado, import em outro processo ou digest de imagem não bastam. Registrar
artefatos de firmware/configuração realmente usados e compará-los com a
referência privada retida. Divergência exige parada, sem adaptação automática.
A proveniência geral de build e a unidade nativa continuam questões separadas.

Fontes GPL, compilação externa, configurações derivadas e avisos ficam privados.
Somente código original MIT e documentação entram no repositório. Nenhuma nova
dependência foi adicionada.

## Preparação fora da janela e transferência do helper

O tmpfs removido não fornece um helper para a próxima execução. Um contêiner
parado também não expõe o tmpfs que existirá após start. Copiar o binário para
o caminho desse tmpfs no contêiner parado deixaria a cópia oculta pelo mount.
Compilar depois de start consumiria a janela original de prontidão.

A proposta privada separa preparação e medição. Antes de armar os 90 s, o
coordenador revisa e autoriza a reconstrução nativa e a exportação do helper
exato, ainda disponível no tmpfs da preparação. Essa preparação tem limite
próprio de 600 s. Recriar seu contêiner removido exige revisão explícita do
coordenador; esta tarefa não cria esse recurso. A exportação ocorre antes da
limpeza original, com nova atestação por descritor e maps no mesmo processo.
O recibo histórico sozinho não atende a esse gate.

Um arquivo tar privado de até 2 MiB transporta o binário, os 32 inputs, o
manifesto fixado e os adaptadores originais. Antes da medição, `docker cp -a`
o coloca em um diretório de preparação na camada gravável do runtime parado.
A releitura compara membros, bytes e metadados, sem exigir igualdade dos headers
do tar. Não acrescenta imagem, volume, bind executável ou mount. O diretório
de staging e o diff privado do launcher exigem revisão do coordenador.

Depois de start, o launcher copia e confere os artefatos no tmpfs exec já
previsto, preservando UID/GID 1000, os metadados e TMPDIR. A cópia e a atestação
no processo real consomem parte dos 90 s originais. Não há compilação nessa
janela, nem novo prazo após a cópia. O guard original permanece inalterado e
continua sem estabelecer prontidão. Host e AVR verificam seus objetos realmente
carregados antes do main, inclusive em cada reinício permitido.

Os dois coletores de pipes existem antes do único `docker start --attach`.
Isso evita depender de `docker attach` em um contêiner parado. O watchdog em
processo separado confirma que está armado antes do start, sem renovar o
deadline já fixado. O diff privado propõe canais distintos em stdout e stderr,
sem TTY. Mudanças de launcher, configuração e logging permanecem sob revisão.
Uma falha de propriedade ou stop impede remoção forçada e retém o recurso.

## Sequência única proposta

1. O coordenador reserva uma CPU local sem trabalhos pesados concorrentes e
   confirma a autorização da execução. Registra disco do host e da VM Docker,
   camadas/cache/logs, Git/head/worktrees e inventário de recursos. Confirma
   propriedade antes de reusar qualquer recurso. Usa um nome/label exclusivo e
   um marcador de tentativa criado exclusivamente antes do start. Se houver
   colisão, espaço insuficiente ou arquitetura não nativa, não inicia.
2. Em preparação privada, disponibiliza os artefatos fixados e revisa o diff
   exato do launcher/configuração contra a referência retida. Preserva UID/GID
   1000, diretórios e guard de preparação, MCU `atmega644p`, clock configurado
   `20000000`, baud `250000`, firmware, PTY, espera inicial de 10 s, ordem e
   políticas originais de reinício. O relógio configurado do MCU não define a
   unidade observada de `GetCurrentTime`. Nenhum guard vira prontidão.
3. Inspeciona o único contêiner ainda parado. Mantém uma CPU, 1 GiB, 256 PIDs,
   cap-drop ALL, no-new-privileges, rede none, sem portas, dispositivos ou
   privilégio. Preserva os mounts e a política de escrita do launcher completo
   retido. Não confunde a raiz somente leitura do preflight isolado com a
   configuração histórica do simulador completo. `/tmp` continua noexec;
   somente o diretório do helper recebe a exceção exec específica de 128 MiB,
   nosuid/nodev, UID/GID 1000, modo 0755 já validada. TMPDIR não muda. Não
   adicionar exceção global de escrita/exec, capacidade, ptrace ou seccomp.
   Código original da sonda e configuração privada têm mounts somente leitura.
4. Arma os canais host/AVR e seus coletores antes de liberar os produtores.
   Arma uma parada independente com deadline `start_monotonic + 90`, antes
   de `docker start`. Não reinicia o prazo após start, readiness ou coleta.
   Registra identidade do contêiner e processo em cada canal, inclusive após
   reinício permitido pela configuração original. Inicia exatamente uma vez.
   O guard de 90 s fica independente de chamadas bloqueantes de evidência.
5. Observa estado e coleta logs tmpfs antes da parada. Aos 88 s, encerra novas
   consultas e tenta salvar os logs até o deadline original, sem atrasar stop.
   Aos 90 s solicita a parada, registra seu atraso observado e conclusão à
   parte. Drena canais por até 1 s após stop; captura logs Docker stdout/stderr
   e inspect após parada, antes de remover. Erro em qualquer etapa segue
   `capture -> stop -> post -> remove` em finally, sem novo start. Se stop
   falhar ou propriedade ficar incerta, retém o recurso e reporta o bloqueio.

Prontidão exige o critério original, `klippy_connected == true` e
`klippy_state == ready`, em resposta local observada antes de 90 s. Consultas
internas Moonraker somente leitura verificam esse gate do simulador; não são
fallback de comandos do produto. Não enviar G-code ou comandos de impressora.
Identificação retornada, PTY disponível ou tempo expirado não significam ready.

## Retenção limitada e testes antes do start

Cada produtor retém até 4.096 eventos, com footer separado. Cada coletor mantém
cabeçalho até 4.096 bytes, prefixo contíguo até 1 MiB, linhas até 65.536 bytes
e 4.096 registros. Continua drenando após o limite para observar footer e
metadados de descarte. Não usar tail. Reter separadamente prefixo bruto de
diagnóstico até 2 MiB por canal e distinguir seu descarte do transporte do
coletor. Usar logs Docker `local`, `max-size=1m`, `max-file=1`, compress=false.
Limitar cada arquivo de log tmpfs a 1 MiB com leitura de prefixo e tamanho de
origem; limitar o diretório de evidência de execução a 32 MiB, com truncamentos
explícitos. Falta de footer, EOF, linhas cortadas, descartes do produtor/coletor,
retorno, erro e parada deliberada permanecem campos distintos.

O runner privado anterior é preparação sintética local, não um launcher Docker.
Dois leitores de pipes, um por canal, alimentam o `Collector` desde o início.
O armazenamento bruto cheio não interrompe a drenagem nem esconde o footer do
coletor. O prazo inclui launch; pipes herdados por filhos não o estendem.
A limpeza sinaliza somente o novo grupo sintético próprio. O recibo mede apenas
cópia de bytes, não overhead total da instrumentação ou do coletor.

Passaram 20 testes da sonda e 11 do coletor. Seis testes privados passaram com
pipes reais sintéticos, adaptador, saturação, footer depois do limite, metadados,
serialização JSON, prazo fixo, pipes herdados e falha de launch. Os testes da
sonda exercitam sucesso, None/timeout, exceção, callback tardio, resultado original,
deadline exato, brackets, relógio indisponível e restauração dos wrappers.
Foi reproduzida e testada a construção dos 14 recibos exatos do payload externo
anterior, seus quatro caminhos de falha e o controle negativo do campo `event`.
Esses testes não executam as fontes GPL, compiladores ou reactor nativo.

```sh
PYTHONDONTWRITEBYTECODE=1 python3.13 -m unittest discover -s infra/sim/experiments -p 'test_session_clock_probe.py' -v
PYTHONDONTWRITEBYTECODE=1 python3.13 -m unittest discover -s infra/sim/experiments -p 'test_bounded_event_collector.py' -v
git diff --check
```

O `python3` padrão local é 3.9 e não carrega os tipos existentes do coletor;
essa tentativa falhou antes dos testes. Python 3.13 executou os testes sem
instalação ou alteração de dependências.

A continuação preparou um candidato privado de integração Docker com runtime
bloqueado. Passaram 18 testes privados novos, além dos 20 testes da sonda e
dos 11 testes do coletor. Os testes privados usam apenas subprocessos que
emulam a CLI, pipes reais e relógio monotônico local. Exercitam inspect, população e releitura, falha de
launch do coletor e de start, captura bloqueante, stop independente, post,
remoção, colisão do marcador e perda de propriedade. Verificam também limites
de retenção, pipes herdados e correspondência sintética de todos os maps.
Esses testes não comprovam Docker real, supervisord, arquitetura nativa ou
atestações carregadas. Um Collector por papel sinaliza starts duplicados como
erro estrutural. O prefixo bruto retém as identidades, mas não prova cobertura
completa após reinícios. O coordenador precisa revisar essa limitação antes da
execução única. Os recibos e diffs privados permanecem fora do repositório.

## Gates abertos e encerramento

Antes do start faltam conclusão do trabalho de imagem e reserva de CPU pelo
coordenador, inventário atual de runtime/espaço e confirmação de Linux ARM64
nativo. Faltam revisão e autorização da preparação/exportação, nova reconstrução
e atestação do helper, além da verificação dos artefatos transferidos. O
coordenador deve revisar os diffs privados, o inspect efetivo exato, os hashes
de firmware/configuração retidos e a interpretação de reinícios parciais.
A integração nativa e seus recibos continuam pendentes. Os campos sintéticos
de preparação não substituem evidência real. Só depois desses gates o
coordenador pode autorizar e agendar uma única execução. Nenhuma nova execução
é autorizada por este texto.

Unidade nativa, domínio comum observado, cobertura temporal, overhead total,
prontidão e causa permanecem desconhecidos. O resultado ARM64 não comprovará
aceitação amd64 ou aceitação completa da fazenda. `bun run check:all` e integração
continuam pendentes antes de publicação; não foram executados porque incluem
build fora do escopo autorizado.

A tarefa criou somente um diretório privado limitado para ledger, snapshots,
runner e recibos de testes. Não criou worktree, imagem, contêiner, volume ou
rede. Temporários sintéticos foram removidos e processos próprios encerrados.
O diretório fica retido para revisão dos gates abertos. Na futura execução,
remover somente recursos próprios após salvar evidência; imagem só se ausente
no baseline e sem outro usuário. Nunca podar caches globais ou recursos alheios.
Não houve push, PR, publicação, deploy ou alteração dos recibos anteriores.
