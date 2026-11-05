# Preflight sintético de relógio ARM64

Em 5 de novembro de 2026, o preflight local usou a imagem Linux ARM64 fixada
`sha256:4fa52c3d57722ef38cfd05a31fd0237347e0e6285fc1371b133a6789798602b7`.
O servidor Docker e o processo no contêiner informaram ARM64. Esta imagem é
irmã da imagem amd64 `sha256:c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47`;
não é prova de equivalência binária ou aceitação amd64. Os rótulos de origem
registrados em [proveniência](SIMULATOR-IMAGE-PROVENANCE.md) não são atestado
de build.

O contêiner executou somente introspecção, com UID/GID 1000, todas as
capacidades removidas, `no-new-privileges`, rede desabilitada, sem portas ou
dispositivos, uma CPU, 1 GiB, 256 PIDs, raiz somente leitura e `/tmp` noexec.
Não executou firmware, AVR, simulador completo ou comandos de impressora.

| Artefato observado                     | SHA-256                                                            |
| -------------------------------------- | ------------------------------------------------------------------ |
| `klippy/serialhdl.py`                  | `72b1a8090d57b9ad7b03d379ce4385b35f8a3a14da709bce554a20f5aeb07dad` |
| `scripts/avrsim.py`                    | `a9561837163fae9dff45f056593ddec5b4919c4f3546b110401057c221bf238c` |
| `klippy/klippy.py`                     | `aa9eb47fbe3598fc814d40ed8e0b2b814a0af459fca7acab6732c59bf42e4659` |
| `pysimulavr.py` carregado              | `ed85d9ff7e772f4944ba03b0d15cb530ae788021fb450a43f96d47c7791e6e72` |
| extensão ARM64 `_pysimulavr` carregada | `875945972e2e8303f5cccd921b2b1d54aa13b25c209c8ce902061cb074356b3c` |

Os dois primeiros hashes coincidem com os gates registrados em
[relógio por sessão](SIMULATOR-SESSION-CLOCK-RESULT.md). Sob o mesmo
`/usr/bin/env python3` do comando AVR retido, Python 3.12 carregou a extensão;
`/proc/self/maps` confirmou o arquivo mapeado. Duas leituras de um relógio recém
criado retornaram zero. Isso não estabelece sua unidade, comportamento durante
execução ou vínculo verificável entre fonte e binário. Uma tentativa inicial com
`/usr/bin/python3` diretamente usou Python 3.11 e falhou no import; esse não é o
interpretador resolvido pelo comando retido.

O host usa o Python 3.11 do ambiente Klipper. Sua inicialização sintética de
reactor tentou compilar o helper C e falhou porque a raiz estava somente leitura.
Não houve alteração das restrições para contornar a falha. O domínio comum entre
`reactor.monotonic`, Python e os demais timestamps permanece desconhecido.
A identidade e o hash do helper efetivamente carregado também permanecem
indisponíveis. Fontes presentes na imagem e valores nominais não comprovam a
relação fonte/binário ou a unidade do relógio nativo.

O launcher privado retido valida UID/GID, prepara diretórios e inicia Supervisor.
O comando AVR encontra Python 3.12 e importa a extensão nesta inspeção isolada.
Isto não valida a preparação completa, permissões de escrita, configuração,
coleta ou inicialização conjunta. A configuração privada e o código GPL externo
permanecem fora deste repositório; nenhum launcher foi alterado para passar.

## Proposta, sem autorização de execução

Antes de uma única execução ARM64 futura, concluir o pareamento e coordenar a
CPU local. Comprovar a identidade e relação fonte/binário do helper e da
extensão carregados, a unidade de `GetCurrentTime` e o domínio monotônico comum.
Validar em privado o launcher UID 1000, os canais e a coleta limitada, inclusive
logs antes da parada e recibos Docker depois dela. Armar os coletores de prefixo
antes do start. Preservar limites, timeouts, baud, pacing, ordem e prazo original
de 90 segundos. A proposta exige autorização específica antes de executar AVR.
O orçamento separado de 90 segundos amd64 permanece não utilizado.

A inspeção não estabelece prontidão, causa do timeout, overhead ou aceitação de
qualquer arquitetura. Não houve SSH, banco, dispositivo ou publicação. O
contêiner e a referência da imagem criados para este preflight foram removidos;
os registros privados e recursos preexistentes foram preservados.
