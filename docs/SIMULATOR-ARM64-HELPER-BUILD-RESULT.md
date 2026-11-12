# Resultado do preflight sintético de build ARM64

Em 5 de novembro de 2026, uma tentativa autorizada parou na inicialização do
contêiner, antes de executar qualquer processo. O helper não foi compilado nem
carregado. Não houve nova tentativa ou alteração das restrições após a falha.

O Docker rejeitou a configuração de logs escolhida pelo runner privado:

```text
failed to create task for container: failed to initialize logging driver: compression cannot be enabled when max file count is 1
```

O driver `local` recebeu `max-size=1m` e `max-file=1`, com compressão padrão.
Essa combinação causou a falha. O estado final registrou `created`, PID 0,
`Running=false`, código 128 e nenhum instante de início ou término de processo.
O preflight completo, incluindo limpeza, durou 42,769 segundos, dentro do prazo
externo de 600 segundos. Não existe intervalo de execução do helper.

## Evidência anterior à tentativa de início

A imagem foi obtida pelo digest Linux ARM64
`sha256:4fa52c3d57722ef38cfd05a31fd0237347e0e6285fc1371b133a6789798602b7`.
A inspeção confirmou arquitetura, digest e ausência de volumes declarados.
A configuração do contêiner preservou UID e GID 1000, raiz somente leitura,
remoção de todas as capacidades, `no-new-privileges`, rede `none`, ausência de
portas publicadas, dispositivos adicionais e bind mounts. Os limites eram uma
CPU, 1 GiB e 256 PIDs.

O único tmpfs adicional configurado era o diretório resolvido do helper,
com `rw,exec,nosuid,nodev,size=134217728,uid=1000,gid=1000,mode=0755`.
O `/tmp` continuava com `rw,noexec,nosuid,nodev,size=64m`.
O runner não alterou TMPDIR. A falha impediu verificar mounts efetivos,
permissões, capacidade interna e ambiente em um processo iniciado.

O runner verificou no host os hashes e tamanhos dos 34 arquivos retidos.
Preparou um stream com somente os 32 arquivos do helper, totalizando
176.365 bytes de conteúdo. O manifesto acompanha os modos, timestamps em
nanossegundos, UID e GID esperados. Nenhum processo recebeu ou verificou esses
arquivos no contêiner. `reactor.py` e o aviso GPL não foram verificados na imagem
em execução. As fontes GPL e os artefatos privados permaneceram fora do
repositório MIT.

```text
SHA-256 do manifesto
c9da203c3cbec258b8165a1cf533cde29f58ec96db9efae88d92c78326ad368f
SHA-256 do stream preparado, 242417 bytes
851a8c8880b90ce4367e02a709c05f8a4727bcf44aec36339c292736887e5f0a
```

## Provas pendentes e limpeza

A tentativa não produziu resultado da sondagem SSE, identidade do compilador,
subprocessos do toolchain, comando de compilação executado, hash de saída ou
identidade de um objeto mapeado por dlopen. Também não produziu comportamento
sintético do reactor ou calibração RAW/MONOTONIC. A identidade anteriormente
observada de `pysimulavr` continua como evidência separada no
[preflight de sessão ARM64](SIMULATOR-ARM64-SESSION-PREFLIGHT.md).
Não há nova conclusão sobre deriva, proveniência de binários ou aceitação do
simulador. Nenhum AVR, firmware, emulador, SSH, banco ou dispositivo foi usado.
PG0016 permaneceu fora desta tarefa.

A limpeza removeu o único contêiner criado e a referência da imagem, ausente no
baseline e sem contêineres usuários na verificação de limpeza. Não houve tmpfs
em execução. Os inventários finais preservaram as identidades dos contêineres,
imagens, volumes e redes do baseline. Nenhum worktree, volume ou rede foi criado.
O espaço livre no filesystem do host passou de aproximadamente 145,1 GiB para
149,7 GiB. Essa diferença inclui atividade concorrente e não mede a limpeza.
O espaço livre interno da VM Docker não foi medido.

O runner, o payload e os recibos limitados permanecem em evidência privada.
O worktree e todos os commits anteriores foram preservados. Apenas este
relatório integra o commit local. `git diff --check` foi executado.
`pnpm run check:all` e as verificações de integração permanecem pendentes.
Não houve push, PR, publicação ou deploy.

## Tentativa única com correção dos logs

Em 5 de novembro de 2026, a tentativa corrigida compilou e carregou o helper,
mas parou na primeira falha diferente. O payload privado lançou o erro abaixo
ao tentar registrar o resultado sintético do reactor:

```text
TypeError: dict() got multiple values for keyword argument 'event'
```

A função `emit` já atribui a chave `event` ao tipo de registro.
A chamada `emit('synthetic_reactor', ..., event=event[0], ...)` tentou atribuí-la
novamente. O timer executou, o reactor terminou e a asserção de um único evento
no intervalo passou antes desse erro. O recibo do reactor não foi emitido.
A sondagem RAW/MONOTONIC não foi alcançada. Não houve correção do payload,
adaptação ou nova tentativa. O preflight continua incompleto.

### Única alteração e preservação

O runner recebeu somente `--log-opt compress=false`, imediatamente após
`--log-opt max-file=1`. O Docker confirmou a configuração efetiva:

```diff
 --log-driver local --log-opt max-size=1m --log-opt max-file=1
+--log-opt compress=false
```

O teste local dos argumentos avaliou a lista exata construída pelo runner,
sem chamar o Docker nem criar outro contêiner. O diff completo permanece
privado. O SHA-256 do runner corrigido é
`478e3af19526a420618ad3dfeea220cef54a7a733392b80a93480eef328cff00`.
O payload permaneceu com SHA-256
`e721e72cfe3a93511d718f63196a5d4c79bda61a91f619a833cd4fb71a75f5ef`.

Os 102 arquivos originais, incluindo o runner, o plano e o primeiro recibo,
permaneceram com conteúdo, tamanho, modos e timestamps inalterados.
Os dois recibos foram retidos. O manifesto e o stream mantiveram os hashes
registrados na tentativa anterior. O processo verificou os 32 arquivos do
helper, com 176.365 bytes, incluindo hashes, modos, timestamps em nanossegundos,
UID, GID e caminhos resolvidos. Também verificou `reactor.py` e `COPYING` na imagem.
Nenhuma fonte GPL foi copiada para este repositório MIT.

### Build e identidade do objeto carregado

A imagem manteve o digest ARM64 registrado acima. As inspeções confirmaram os
limites e restrições do plano, incluindo o tmpfs executável de 128 MiB somente
no diretório resolvido do helper e o `/tmp` de 64 MiB com `noexec`.
TMPDIR, fontes, flags, mounts e recursos não foram alterados.

A sondagem SSE exata retornou status de espera 256, correspondente a saída 1.
O wrapper executou o comando esperado com as 21 fontes e retornou status 0.
As flags foram `-Wall -g -O2 -shared -fPIC -flto -fwhole-program
-fno-use-linker-plugin`. O GCC era Debian `12.2.0-14+deb12u1`, versão 12.2.0,
com SHA-256
`dc53dbc5a583d03ae8ed6272ca9afc0f58873f9f9b86dd7d448b17fb3f88a8d0`.
O recibo privado guarda o comando expandido, a versão, os caminhos e hashes
das ferramentas configuradas e dos subprocessos observados.
A amostragem de `/proc` não encontrou descritores de escrita fora dos caminhos
permitidos. Essa amostragem não equivale a rastreamento exaustivo de syscalls.

O `c_helper.so` carregado tinha 315.336 bytes e SHA-256
`de41f025d48731ae9f8bae782c6d10a6f6dd32887b04c77e413a36e0be5ef32f`.
O hash foi calculado pelo descritor aberto. Os registros de `/proc/self/maps`
e o arquivo aberto concordaram em caminho, dispositivo 238 e inode 35.
O intervalo de compilação e carregamento registrado foi de
25.072.867.938.818 a 25.075.688.111.553 nanossegundos MONOTONIC.
Isso comprova esse build e carregamento sintético, sem comprovar calibração,
deriva futura ou aceitação do simulador completo.

### Limpeza e limites da conclusão

A execução terminou com código 1, sem OOM. O prazo total externo era de
600 segundos. O tempo total, incluindo limpeza, foi de 38,564 segundos.
A limpeza removeu o contêiner próprio, seus tmpfs e a referência da imagem
obtida pela tarefa, ausente no baseline e sem contêineres usuários.
Os comandos de parada, remoção do contêiner e remoção da imagem retornaram 0.
Os inventários finais preservaram as identidades de todos os contêineres,
imagens, volumes e redes do baseline. Nenhum worktree, volume ou rede foi criado.
O espaço livre no host passou de aproximadamente 152,2 GiB para 151,1 GiB.
A variação inclui atividade concorrente. A capacidade livre interna da VM
Docker e o pico de uso dos tmpfs não foram medidos.

A evidência privada limitada retém o novo runner, o diff exato, a preservação
dos originais, os inventários e o novo recibo para diagnóstico da falha.
Os artefatos temporários internos desapareceram com o contêiner.
Nenhum AVR, firmware, emulador, SSH, banco ou dispositivo foi usado.
Os serviços preexistentes permaneceram fora da tarefa.
Somente este relatório integra o novo commit local de documentação.
`git diff --check` passou. `pnpm run check:all` e as verificações de integração
permanecem pendentes. Não houve push, PR, publicação ou deploy.

## Tentativa única com correção do recibo

Em 5 de novembro de 2026, a nova tentativa sintética concluiu build, dlopen,
timer, 64 amostras RAW/MONOTONIC e o recibo final. O processo retornou 0,
sem primeira falha e sem OOM. A execução completa, incluindo limpeza, durou
55,422 segundos, dentro do prazo externo de 600 segundos. Houve uma única
invocação do runner, sem adaptação ou repetição da execução.

### Diff e testes locais anteriores à execução

Somente uma cópia privada nova recebeu a correção do payload:

```diff
-emit('synthetic_reactor',before=before,event=event[0],after=after,clock_callable=repr(r.monotonic))
+emit('synthetic_reactor',before=before,timer_event=event[0],after=after,clock_callable=repr(r.monotonic))
```

O runner recebeu somente nome e label exclusivos para identificar seu
contêiner. Uma comparação local confirmou igualdade com o runner anterior
após normalizar essas identidades. Nenhum guard, mount, recurso, fonte,
flag, TMPDIR, wrapper, probe SSE ou opção de logs foi alterado.

```text
SHA-256 do runner novo
ba356604c86622b86b01273f2b840e9b8f9f0c7a56d08657a7cc345725647730
SHA-256 do payload novo
729b8b701e54645c1074852ea334f14149c647f3d63d429dd640c6bca1795dd9
SHA-256 dos testes locais
2b596cb66c1c05ccf5d08560ef5b844c73d7f0520c17d719968ac9d1c018e3fe
```

Os testes executaram os nós AST exatos do payload, com eventos, relógio e
reactor sintéticos, sem compilador ou import do reactor upstream. Passaram as
14 construções e serializações de recibos: `tool_query`, `runtime`,
`input_set_verified`, `compiler`, `synthetic_reactor`, `clock_calibration`,
`complete`, `verified_input`, `configured_tool`, `actual_wrapper_command`,
`actual_wrapper_result`, `observed_subprocesses`, `helper_loaded_same_object`
e `first_failure`. A auditoria de todos os calls e dicionários literais do
payload e runner não encontrou keywords ou chaves literais duplicadas.
As expansões dos recibos foram exercitadas com dicionários sintéticos.

O bloco exato do timer e das 64 leituras passou, incluindo cálculo dos
intervalos, resolução e footer `complete`. O handler exato de falha produziu
JSON e saída 1 para exceções sintéticas de asserção do timer, asserção RAW/MONO,
consulta de identidade e footer. Isso testa a construção dos recibos de falha,
sem simular falhas reais do compilador ou do kernel. O controle negativo com
a chamada original reproduziu o TypeError anterior. Um erro de localização
AST no próprio teste foi corrigido localmente antes do resultado aprovado.

### Entradas, restrições e identidade do helper

A preservação verificou 389 arquivos anteriores por SHA-256, tamanho, modo
e mtime em nanossegundos. Os recibos, runners, payloads e manifestos anteriores
permaneceram inalterados. O manifesto continuou com SHA-256
`c9da203c3cbec258b8165a1cf533cde29f58ec96db9efae88d92c78326ad368f`.
O stream de 242.417 bytes continuou com SHA-256
`851a8c8880b90ce4367e02a709c05f8a4727bcf44aec36339c292736887e5f0a`.
O processo verificou os 32 arquivos do helper, com 176.365 bytes, modos,
mtime_ns, UID/GID e caminhos, além de `reactor.py` e `COPYING` na imagem.
Nenhuma fonte GPL entrou no repositório MIT. As entradas externas não mudaram.

A imagem ARM64 manteve o digest
`4fa52c3d57722ef38cfd05a31fd0237347e0e6285fc1371b133a6789798602b7`.
As inspeções confirmaram UID/GID 1000, raiz somente leitura, cap-drop ALL,
no-new-privileges, rede none, ausência de portas, dispositivos adicionais e
bind mounts, uma CPU, 1 GiB e 256 PIDs. Os logs continuaram em `local`,
`max-size=1m`, `max-file=1`, `compress=false`. Os mounts efetivos preservaram
`/tmp` de 64 MiB com noexec e somente o diretório do helper com tmpfs executável
de 128 MiB, nosuid, nodev, UID/GID 1000 e modo 0755. TMPDIR não foi alterado.

O GCC Debian 12.2.0-14+deb12u1 manteve SHA-256
`dc53dbc5a583d03ae8ed6272ca9afc0f58873f9f9b86dd7d448b17fb3f88a8d0`.
O recibo privado registra caminhos, versões e hashes de cc1, as, collect2,
ld, lto-wrapper e lto1, além das identidades dos subprocessos observados.
O comando SSE exato retornou status de espera 256, saída 1. O comando real de
build com as mesmas 21 fontes e flags `-Wall -g -O2 -shared -fPIC -flto
-fwhole-program -fno-use-linker-plugin` retornou 0. Os comandos expandidos
permanecem no recibo privado. A observação de `/proc` não encontrou descritores
de escrita inesperados; essa amostragem não é rastreamento exaustivo.

O helper carregado manteve 315.336 bytes e SHA-256
`de41f025d48731ae9f8bae782c6d10a6f6dd32887b04c77e413a36e0be5ef32f`.
O hash pelo descritor aberto, o pathname e todas as entradas correspondentes de
`/proc/self/maps` concordaram em dispositivo 238 e inode 35. A igualdade vale
para esse objeto nessa execução. O intervalo de build e carregamento foi de
25.430.479.805.957 a 25.434.428.997.771 ns MONOTONIC.

### Timer e intervalos observados dos relógios

O único callback ocorreu em 25.434,458505794 segundos, entre
25.434,436398878 e 25.434,458603711 segundos do relógio do reactor.
O reactor terminou e finalizou. O recibo agora preserva `event` como tipo e
registra o instante do callback em `timer_event`.

As 64 triplas RAW antes, MONOTONIC, RAW depois cobriram RAW de
25.434.458.701.086 a 25.434.646.697.878 ns. Para cada tripla `(a,m,b)`,
o intervalo observado MONOTONIC menos RAW é `[m-b,m-a]`. O envelope dessas
leituras foi de 5.211.637 a 5.215.956 ns. O maior bracket foi 4.250 ns,
com meia largura máxima de 2.125 ns. Ambos os relógios reportaram resolução
de 1 ns. Ao ampliar cada extremo pela soma dessas resoluções, 2 ns,
o envelope fica entre 5.211.635 e 5.215.958 ns e a meia largura máxima
fica em 2.127 ns. Os 64 intervalos individuais permanecem no recibo privado.

Resolução reportada não certifica exatidão. Esses intervalos descrevem apenas
as leituras observadas e não demonstram offset constante, deriva futura,
proveniência geral de binários ou prontidão do simulador completo.
A consulta final de identidade CPython/pysimulavr passou sem criar AVR.

### Limpeza e gate restante

O baseline registrou disco, status, worktrees e recursos Docker antes do pull,
com nova leitura de disco antes do pull e da criação. A limpeza removeu o
contêiner próprio e seus tmpfs. Removeu também a referência da imagem, ausente
no baseline e sem contêineres usuários. Stop, rm e image rm retornaram 0.
Os conjuntos finais de IDs de contêineres, imagens, volumes e redes foram
iguais aos do baseline. Nenhum volume, rede ou worktree foi criado.
O espaço livre do host passou de 159.353.452 para 158.042.668 KiB,
aproximadamente 150,72 GiB ao final. A variação inclui atividade concorrente;
a capacidade livre da VM Docker e o pico dos tmpfs não foram medidos.
O footer registrou 133.668.864 bytes livres no tmpfs do helper.

Somente a evidência privada limitada, os testes e as cópias novas permanecem
para auditoria. Nenhum processo ou simulador próprio permanece ativo.
Não houve remoção de cache ou recurso preexistente. O worktree vinculado,
a correlação e o histórico foram preservados. AVR, firmware, simulador
completo, SSH, PG, dispositivos e fixtures de navegador/HTTP permaneceram
fora da execução. A evidência anterior de build, dlopen e timer continua válida.

Somente este acréscimo documental integra o commit local.
`git diff --check` passou. `pnpm run check:all` e verificações de integração
continuam pendentes; a aceitação completa do simulador permanece aberta.
Não houve subagentes, novo checkout, push, PR, publicação ou deploy.
