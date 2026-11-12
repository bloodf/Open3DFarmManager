# Resultado da sonda de relógio por sessão

A implementação local e 11 testes sintéticos passaram. O preflight nativo ficou
bloqueado por timeout de conexão SSH. Nenhum contêiner, imagem ou execução AVR
foi iniciado nesta tarefa. Não há medição do intervalo real de identificação,
prontidão observada ou conclusão de causa.

O trabalho parte de `b8957c788f241a7c36603ddd6f5cf9b74901c59d`. A sonda nova
`infra/sim/experiments/session_clock_probe.py` é código original MIT, usa somente
a biblioteca padrão e o coletor existente. Não modifica o executor histórico,
a cadeia ampla de tracing, os scripts raiz, autenticação, WebRTC ou banco.
Nenhum agente ou checkout adicional foi criado.

## Fonte exata e fronteira de licença

Os bytes externos destas duas fontes foram obtidos novamente e seus SHA-256
conferidos contra a documentação, na revisão Klipper
`ee2c6fb6b00b2b5d097ef70d0868df7d74943b51`:

| Fonte                 | SHA-256                                                            |
| --------------------- | ------------------------------------------------------------------ |
| `klippy/serialhdl.py` | `72b1a8090d57b9ad7b03d379ce4385b35f8a3a14da709bce554a20f5aeb07dad` |
| `scripts/avrsim.py`   | `a9561837163fae9dff45f056593ddec5b4919c4f3546b110401057c221bf238c` |

`instrument_verified` valida tamanho e hash antes de executar os mesmos bytes em
memória, emitir o cabeçalho e instalar wrappers. Retorna o `Capture`, cujo
`finish` cabe ao chamador no término normal ou excepcional. O namespace externo deve fornecer `__file__` e os
imports normais do projeto externo. O chamador deve usar esse ponto de entrada;
`install_host` e `install_avr` também atendem fixtures sintéticas e, isoladamente,
não atestam fonte. Não há launcher executável integrado nesta etapa bloqueada.

As implementações GPL externas não foram copiadas para o repositório MIT.
Seus arquivos e avisos permanecem externos. Não foi adicionada dependência.
Hash de fonte não atesta biblioteca nativa carregada, vínculo fonte/binário,
unidade de ticks ou domínio de relógio.

## Eventos e limites

O wrapper host identifica a sessão com contador local ao processo. A identidade
fica presa ao callback registrado, inclusive quando ele termina após o timeout
ou após outra sessão começar. `session_start` observa entrada em `_start_session`;
`identify_start` observa entrada no callback real `_get_identify_data`.
`identify_completion` observa retorno ou exceção desse callback.

O proxy envolve somente o completion retornado pelo registro daquele callback.
`identify_wait.actual_deadline` recebe o argumento real passado a `wait`, sem
recalculá-lo. Na fonte conferida, linha 98, esse argumento vem de
`reactor.monotonic() + 5.`. O evento declara `reactor.monotonic` como domínio;
não afirma que esse domínio já foi alinhado a Python. Um retorno `None` desse
wait corresponde ao ramo de timeout de conexão na fonte exata. Exceções são
registradas separadamente e propagadas. O registro original do reactor é
restaurado no `finally`, preservando overrides preexistentes.

O wrapper AVR amostra `SystemClock.Instance().GetCurrentTime()` nas chamadas já
existentes de `TerminalIO.read/write`, no máximo uma vez a cada 100 ms quando o
monotônico funciona. Cada tick fica entre duas leituras monotônicas. Não cria
leitor PTY, thread, sleep ou syscall serial adicional. Não muda bytes, baud,
pacing, timeouts, ordem, atraso ou reinício. Preserva resultado e exceção dos
métodos. A amostragem depende de chamadas existentes; lacunas não provam parada
do relógio. Relógio indisponível produz `null`.

Cada produtor emite cabeçalho `start`, até 4.096 registros incluindo cabeçalho e
footer separado com descartes explícitos. O footer registra o tempo acumulado de
emissão anterior ao próprio footer. Esse valor não mede toda a instrumentação:
ficam de fora wrappers, leituras de relógio nativo, agendamento e trabalho do
coletor. O overhead total não foi medido; não há controle nem execução nativa.

`collect` reutiliza `Collector` com cabeçalho separado, prefixo contíguo de até
1 MiB, linhas de até 65.536 bytes e 4.096 registros. Exige `Completion` explícito
com retorno, erro de processo, parada forçada, EOF e truncamento de transporte.
Descartes, footer ausente, registros cortados e início ausente ficam separados.
O relatório sempre declara `complete_stream: false` e cobertura de intervalo
não verificada. Nem um footer normal estabelece captura completa.

A biblioteca não inicia processos nem arma canais. A integração privada ainda
precisa armar e drenar todos os canais antes do start, impor o prazo original de
90 s sem estendê-lo pela coleta, medir overhead de coleta separadamente, salvar
logs tmpfs limitados antes da parada e stdout/stderr/inspect Docker depois dela,
antes da remoção. Não deve usar tail. Essa integração não foi executada nem
validada como efeito desta tarefa.

## Gate nativo bloqueado

A tentativa de inventário pelo procedimento SSH retido terminou com timeout de
conexão à porta 22. Não foi possível obter inventário remoto atual nem abrir o
preflight sintético da imagem fixada
`sha256:c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47`.
Nenhuma exceção de privilégio, configuração, destino ou transporte foi tentada.

Continuam faltando a identidade e o hash dos binários efetivamente carregados,
o vínculo verificável com sua fonte/build, evidência sintética da implementação
e unidade de `GetCurrentTime`, e demonstração de domínio monotônico comum entre
host, Python e reactor. A declaração nominal de 1 GHz do driver e fonte de
pacote não satisfazem esses gates. Portanto, a execução AVR única de 90 s não
foi consumida. Não há hash, cobertura ou overhead de uma nova execução a relatar.

A análise histórica de cauda continua restrita aos seus 2.714 registros, sem
cabeçalho e sem fronteiras da sessão. CPU agregada não estabelece causalidade ou
starvation. Nenhuma razão nominal de ticks foi promovida a unidade verificada.

## Verificação e recursos

Comando local, sem simulador, subprocesso ou dispositivo nos testes novos:

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/sim/experiments -p 'test_session_clock_probe.py' -v
git diff --check
```

11 testes passaram, incluindo argumento exato do wait, retorno por identidade,
exceção por identidade, timeout, callback tardio, restauração do reactor, rejeição
de fonte antes de execução, falhas de saída/relógio, descarte no produtor,
prefixo superior a 1 MiB, parada forçada, footer e início ausentes.
`pnpm run check:all` e integração nativa continuam pendentes. Não houve publicação,
push, PR, deploy, alteração de DNS ou credenciais.

O ledger e a evidência limitada ficam fora do repositório. Foram preservados os
hashes dos arquivos históricos de execução e análise, o worktree vinculado e o
grupo de processos pai. Nenhum recurso remoto foi criado por esta tarefa e
nenhum recurso preexistente foi removido. O erro de acesso impede auditoria
remota atual; isso não atesta o estado remoto. O inventário local e a auditoria
final de espaço ficam no ledger privado.

## Continuação local de 5 de novembro de 2026

Esta seção atualiza o estado acima sem substituir os registros históricos.
A continuação parte do commit `643fca588d2b2d0058a9e90340f519e00474ad4c`,
no mesmo worktree. Não criou agentes nem checkouts.

A única rechecagem autorizada usou o alias SSH estabelecido, `BatchMode`,
`ConnectTimeout` de 10 s e limite total de 15 s. Terminou em 10,018 s, com
código 255 e erro de conexão à porta 22, `Operation timed out`. O timeout foi
reportado pela fase de conexão do SSH. Não houve erro de resolução DNS nem
rejeição de autenticação reportados. O comando remoto não retornou o marcador
fixo esperado. Não há evidência de que autenticação ou comando remoto tenham
começado. O limite total do subprocesso não foi atingido; não se trata de um
timeout observado de comando remoto. Não houve nova tentativa nem outra ação
remota após esse erro.

O preflight sintético sem AVR da imagem fixada continua **bloqueado por
conectividade**. Não houve inventário remoto atual, pull, criação de contêiner
ou execução nativa. A unidade e a implementação carregada de `GetCurrentTime`,
o vínculo fonte/binário e o domínio monotônico comum continuam desconhecidos.
O orçamento de uma execução AVR de 90 s permanece **não utilizado**.

### Integração executável local

`run_verified` agora fornece adaptadores host e AVR, acessíveis pelo ponto de
entrada executável de `session_clock_probe.py`. Os argumentos originais vêm
após `--`; a sonda escreve eventos em stderr e preserva stdout do programa.
O adaptador AVR carrega os bytes validados, instala os wrappers e chama o
`main` externo. O host instala `serialhdl` instrumentado antes de executar a
entrada Klippy. A entrada host exige um SHA-256 fixado no procedimento privado,
além do hash fixo de `serialhdl`; esse hash adicional ainda não foi obtido de
uma imagem acessível nesta continuação. A leitura é limitada e os mesmos
buffers verificados são compilados, sem reabrir os arquivos para execução.

Os adaptadores preservam argumentos, métodos, baud, pacing e timeouts externos.
O footer indica saída normal ou excepcional. `argv`, caminho de imports e a
entrada anterior de `serialhdl` são restaurados. O adaptador não prova gates
nativos e não substitui o launcher UID 1000 retido. Nenhum adaptador foi
executado contra AVR, firmware, impressora ou dispositivo nesta continuação.

O runner privado local arma os dois destinos e coletores antes de iniciar um
subprocesso sintético. Drena stdout e stderr por selectors, mesmo após encher
a retenção de até 2 MiB por canal. Depois aplica o coletor de cabeçalho/prefixo
já existente aos bytes retidos. O truncamento de transporte e footer ausente
permanecem explícitos; um footer além do limite bruto pode não ser observado.
O prazo usa monotônico desde antes do launch e não cresce com a coleta. A
parada mata somente o grupo novo do subprocesso; a drenagem posterior tem um
limite separado de 1 s. O tempo ativo de drenagem e análise é registrado
separadamente, sem chamá-lo de overhead total da instrumentação.

Esse runner é uma integração **sintética local**, não um executor Docker
validado. Ainda não prova coleta de logs tmpfs antes da parada, logs/inspect
Docker depois dela, nem coordenação dos canais do launcher remoto. Essas
etapas permanecem pendentes, sem execução remota para desenvolvê-las nesta
continuação bloqueada. Não há aceitação simulada, alinhamento de relógios,
prontidão, causa ou medição de overhead nativo a declarar.

### Verificação e encerramento da continuação

Passaram 15 testes da sonda, 11 do coletor existente e cinco testes privados do
runner. Os testes cobrem os adaptadores com fontes originais sintéticas,
restauração após exceção, rejeição de hash antes de execução, manutenção do
buffer verificado após alteração do arquivo, argumentos da CLI, pipes reais,
drenagem além do limite, prazo fixo, processo filho com pipes herdados e falha
de launch. O hash sintético não é aceito como hash de produção pelo coletor.
`git diff --check` passou. `pnpm run check:all` permanece pendente; não houve
publicação, push, PR ou deploy.

A evidência nova limitada, o runner privado e os recibos ficam em um único
diretório privado de continuação, dentro da evidência session-clock existente.
Os temporários dos testes foram removidos pelos respectivos context managers;
os subprocessos e seus grupos foram encerrados. Nenhuma imagem, contêiner,
volume, rede ou worktree foi criado ou removido. Os 60 arquivos do manifesto
histórico permaneceram com os hashes originais. O worktree e o grupo pai foram
preservados. A auditoria final e o espaço livre estão no recibo privado; a
indisponibilidade SSH impede auditoria remota atual.
