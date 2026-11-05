# Coletor limitado de prefixos UART

Implementação local original MIT, somente com a biblioteca padrão Python.
`infra/sim/experiments/bounded_event_collector.py` não inicia processos, não abre
PTY, não controla prazos e não executa simuladores. Não integra o Compose, um
executor, a aplicação ou o CI. Nenhuma execução nativa foi realizada nesta
tarefa. Nenhuma dependência ou implementação GPL foi incorporada.

O resultado histórico do commit `bf6c36855ffccfb57e81bd3274c12aa55205355d`
continua inconclusivo: a captura por sufixo perdeu o início. Este coletor não
recupera os bytes perdidos, não altera o experimento anterior nem reinterpreta
a evidência antiga. Detalhes de executor, host e captura permanecem fora deste
repositório.
O [resultado nativo](SIMULATOR-UART-NATIVE-RESULT.md) permanece inalterado.

## Contrato local

O chamador entrega um fluxo binário já aberto, desde seu início, com linhas JSON
marcadas pelo prefixo do produtor. `Collector.consume` retém o primeiro `start`
separadamente, com limite próprio de 4.096 bytes. Retém um prefixo contíguo dos
eventos seguintes de até 1 MiB, com linhas de até 65.536 bytes e até 4.096
registros observados, incluindo `start`. Não substitui o início pela cauda.
Um cabeçalho maior que seu limite invalida o prefixo explicitamente.

Após preencher a retenção, continua drenando e contando bytes e registros,
observando duplicações de `start` e a presença do footer. Nunca retoma a retenção
depois de uma lacuna. A análise dos métodos cobre apenas os eventos retidos.
Linhas alheias ao prefixo contam em `observed_bytes`, mas não são retidas.
`dropped_bytes` conta bytes de linhas descartadas pelo parser ou pela retenção,
não os diagnósticos alheios. Um footer descartado pelo limite não é concatenado
aos eventos retidos. Sua estrutura é validada separadamente, com o cabeçalho.

A memória depende dos limites configurados, mais uma linha e seu JSON. O tempo
e a quantidade total de entrada não são limitados pelo coletor. A leitura pode
bloquear. O futuro chamador precisa impor o prazo original e drenar stdout e
stderr sem bloqueio mútuo. Não usar `consume` como controlador de processo nem
como leitor concorrente do PTY. Uma futura integração aprovada deve começar a captura na origem, preservar
metadados fora dos logs e registrar qualquer perda anterior ao coletor. Ler uma cauda antiga não atende ao contrato.

`report` exige `Completion` explícito. O chamador fornece o código real de saída
ou `None`, a categoria de erro de processo, a parada deliberada, a observação de
EOF e o truncamento do transporte. O coletor não infere parada deliberada de
`137` ou `-9`. Esses valores também não identificam a causa da saída.
`process_error` aceita `launch`, `read`, `wait`, `timeout` ou `None`, sem mensagens
que possam revelar caminhos ou configuração. Uma falha de leitura deve ser
registrada pelo chamador antes de solicitar o relatório. Os metadados são
relatos do chamador, não uma atestação autenticada pelo coletor.

| Campo                                                                                 | Significado e limite                                                                                                                                                                  |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prefix_valid`                                                                        | Cabeçalho único, na primeira posição, hash esperado e estrutura válida dos eventos retidos. Exige metadados explícitos; não exige footer. Não verifica eventos de método descartados. |
| `capture_bound_drop`, `dropped_records`, `dropped_bytes`                              | Limites de retenção atingidos e descartes observados, separados dos erros de processo.                                                                                                |
| `capture_gap`, `parser_truncated`, `structural_errors`                                | Lacuna na retenção, linha longa/inacabada e erros estruturais. `start` ausente, duplicado, malformado ou com hash diferente impede validade.                                          |
| `footer_missing`, `footer_valid`, `normal_footer_observed`, `producer_dropped_events` | Presença e estrutura do footer, término normal declarado pelo produtor e descartes que ele declarou. Sem footer, seus contadores são desconhecidos.                                   |
| `completion`                                                                          | Fatos independentes de processo, EOF, transporte e parada deliberada. Footer normal não implica processo bem-sucedido.                                                                |
| `protocol_prefix_facts`                                                               | Contagens apenas do prefixo retido, inclusive valores nulos de relógio. Não são totais da execução.                                                                                   |

O adaptador `validate_uart_prefix` reutiliza o analisador histórico sem alterá-lo
e verifica também os campos de relógio e exceção. Relógios devem ser inteiros
não negativos ou `null`; valores nulos são contados. Esses fatos não provam
progresso, saúde ou alinhamento entre relógios. Um erro estrutural observado
invalida o relatório de prefixo. Um registro cortado pela parada também é erro
de parser, mesmo quando os registros anteriores pareciam válidos.

Todo relatório usa `scope: observed-prefix-only` e `complete_stream: false`.
Mesmo com footer normal, saída zero e nenhum descarte observado, este contrato
não atesta a integridade do transporte ou a completude do fluxo. Sem footer,
uma parada deliberada documentada permite apenas validade estrutural do prefixo
observado. Entrega permanece desconhecida, prontidão não observada e causa não
resolvida. Um fluxo vazio não prova silêncio UART.

Uso como biblioteca em um futuro coletor autorizado, sem iniciar processo:

```python
from bounded_event_collector import Collector, Completion, validate_uart_prefix
from uart_method_diagnostic import PREFIX

collector = Collector(PREFIX.encode())
collector.consume(existing_binary_stream)
report = collector.report(
    Completion(returncode=observed_returncode, process_error=observed_error,
               forced_stop=observed_forced_stop, eof_observed=observed_eof,
               transport_truncated=observed_transport_truncation),
    validate_uart_prefix,
)
```

## Próxima discriminação proposta, sem autorização de execução

Não repetir outro experimento somente de métodos. A próxima tentativa precisa
correlacionar I/O nativo, identidade dos endpoints e transições D0/D1 com quadros
e identificação aceita. Ausência em um único ponto não decide onde houve perda.

A revisão de interfaces usa Klipper
`ee2c6fb6b00b2b5d097ef70d0868df7d74943b51`. Os hashes de `avrsim.py`,
`serialqueue.c`, `msgblock.c` e `serial.c` foram conferidos por leitura dos bytes
dessa revisão nesta tarefa. O hash de `serialhdl.py` é o gate já registrado em
[diagnóstico serial](SIMULATOR-SERIAL-DIAGNOSTIC.md), a conferir novamente antes
de qualquer execução futura.

| Interface exata                                                                                                                                                                                | SHA-256 do arquivo de fonte                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`scripts/avrsim.py`](https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/scripts/avrsim.py), `TerminalIO.read/write`, fila D0 e amostragem D1                  | `a9561837163fae9dff45f056593ddec5b4919c4f3546b110401057c221bf238c` |
| [`klippy/chelper/serialqueue.c`](https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/klippy/chelper/serialqueue.c), `input_event`, `do_write`, `handle_message` | `d519a5554233070f2560aff550899fa2402d69de08569df68b1306914823869d` |
| [`klippy/chelper/msgblock.c`](https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/klippy/chelper/msgblock.c), `msgblock_check` e validação CRC                  | `6a7c6db524c38408ddf5718b13626cc4c5e5f2fdf85259c2b70f5dc2c34257ef` |
| [`klippy/serialhdl.py`](https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/klippy/serialhdl.py), sessão de identificação e desconexão                          | `72b1a8090d57b9ad7b03d379ce4385b35f8a3a14da709bce554a20f5aeb07dad` |
| [`src/avr/serial.c`](https://github.com/Klipper3d/klipper/blob/ee2c6fb6b00b2b5d097ef70d0868df7d74943b51/src/avr/serial.c), `serial_init` e interrupções RX/TX                                  | `987c33388e07514671782b046141ce43da04abba9d484e0bfb8d1459868eb0f6` |

As revisões de fonte Klipper e os hashes dos arquivos públicos examinados são
registrados acima para tornar a análise do código upstream reproduzível. Imagens,
binários locais, configurações e outros identificadores de execução ficam fora
deste documento; hashes de fonte não comprovam quais binários foram carregados.
Nenhum binário nativo foi inspecionado ou executado nesta tarefa.

1. Antes de executar, obter autorização específica para a coleta correlacionada,
   seu orçamento e mecanismo de observação. Fazer inventário de espaço e recursos,
   registrar hashes do coletor, executor futuro, fontes e binários carregados,
   preservando o hash do executor histórico. Confirmar identidade do endpoint por
   processo/FD, dispositivo/inode e associação master/slave no mesmo instante;
   caminhos ou números de FD isolados podem ser reutilizados.
2. Revisar uma observação limitada no caminho de I/O já existente. Registrar
   tamanho solicitado, retorno real, errno, bytes limitados e relógio antes/depois
   das chamadas host e master. Correlacionar envios do host com retorno master,
   fila/transições D0, recepção pelo firmware, atividade D1, decodificação,
   escrita master e leitura host. Retorno de método que descarta `os.write`
   continua sem contagem de bytes do syscall. Não abrir leitor concorrente do PTY.
3. Na mesma janela, registrar resultado de `msgblock_check`, sequência aceita ou
   rejeitada e avanço contíguo de identificação. Verificar sinal/pino, baud e
   relógio do firmware efetivo. Registrar ticks de simulação e monotônico com
   domínio comum demonstrado ou incerteza explícita. CPU agregada não decide
   starvation; dados por thread exigem revisão de disponibilidade e permissões.
4. Manter isolamento não privilegiado, capacidades removidas, sem rede, portas,
   dispositivos ou impressoras físicas. Não adicionar ptrace, capacidades ou
   exceções de seccomp. Se a observação necessária não for permitida, parar nessa
   fronteira e registrar a lacuna. Não substituir por mais uma coleta só de
   métodos. Não mudar baud, pacing, timeouts, ordem de partida ou configuração
   para tornar o resultado favorável. Controlar overhead com controle sem probes
   sob o mesmo limite original de 90 segundos, após aprovação.
5. Preservar cabeçalho, prefixo limitado e metadados independentes de parada,
   perdas, EOF, código de saída e prazos. Cada canal deve declarar seus limites.
   Só decidir uma hipótese quando houver correspondência entre fronteiras; falta
   de correspondência parcial permanece inconclusiva. Prontidão continua sendo
   gate independente do aplicativo. Encerrar e limpar somente recursos próprios.

## Verificação local

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/sim/experiments -p 'test_bounded_event_collector.py' -v
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s infra/sim/experiments -v
git diff --check
```

Os novos testes usam somente fluxos e recibos de processo sintéticos em memória,
incluindo mais de 1 MiB, parada forçada sem footer e último registro cortado.
Não iniciam subprocesso nem simulador. A suíte experimental existente também
inclui fixtures locais de processo e PTY sintéticos, sem firmware. Os testes não
comprovam a futura integração do executor, prazos reais ou comportamento nativo.
`bun run check:all` continua obrigatório antes de publicação; não faz parte desta
suíte Python. Não instalar dependências apenas para formatar estes arquivos.
