# Anycubic: pesquisa de compatibilidade de impressoras FDM

Estado: pesquisa de fontes públicas. Não é certificação de compatibilidade nem prova de integração.

- Data de corte: 2026-11-13
- Commit base: `bad76165aa4fbe86949ae624ddedc973721d5fcf`
- Data de acesso às fontes: 2026-11-13 (salvo indicação)
- Escopo: somente FDM, modelos base distintos. Pacotes e combos não são contados como modelos novos.
- Status: DONE_WITH_CONCERNS. Ranking dos cinco modelos incompleto, firmware e protocolo não comprovados.

## Resumo

1. A navegação oficial da loja Anycubic (`store.anycubic.com/collections/kobra-series`) lista Kobra 3 Max V2, Kobra 4, Kobra X, Kobra S1 Max e pacotes S1. Isso comprova presença no catálogo, não cronologia de lançamento.
2. Páginas de produto oficiais lidas: Kobra 4, Kobra X e Kobra 3 Max V2. Nenhuma delas traz data de lançamento, pré-venda ou envio com data fixa.
3. O ranking dos cinco modelos mais recentes é provisório. Há lacunas nos dois primeiros e no quinto lugar (ver "Lacunas de ranking").
4. Firmware: a página oficial cita "Kobra OS" como plataforma. Nenhuma versão foi estudada, então firmware é **desconhecido**.
5. Conectividade local/nuvem, telemetria, comandos e licenças não foram comprovados por documentação oficial lida. As informações sobre LAN e MQTT vêm de fontes comunitárias e aparecem como não comprovadas.
6. Não houve acesso a hardware, cadastro, credenciais, simuladores, builds ou testes. Nenhuma afirmação sobre integração com o Connector é feita aqui.

## Método e limitações de acesso

- Páginas lidas diretamente: [S1], [S2], [S3], [S4], [S5], [S6].
- Resultados de busca (resumos de terceiros ou de páginas não abertas): marcados como "resumo de busca" nas fontes. Não sustentam fatos sem confirmação.
- `store.anycubic.com` e alguns domínios `anycubic3d.com` retornaram HTTP 429 (limite de requisições) em tentativas repetidas. As tentativas foram limitadas. Nenhuma página bloqueada foi preenchida com fonte de terceiros.
- Bambu, Creality e outras marcas estão fora deste relatório.

## Ranking dos cinco modelos base (provisório)

Ordem por evidência de lançamento público disponível. Nenhuma ordem é certificada.

| # | Modelo base | Lançamento público mais forte | Situação da evidência |
|---|---|---|---|
| 1 | Kobra 3 Max V2 | Não confirmado. Anúncio citado em fórum em 2026-08-28; "September 2026" em SimplyPrint (terceiro) | Página oficial US lida (sem data); data de lançamento **não comprovada** |
| 2 | Kobra 4 | Revelação em RAPID+TCT (Anycubic, 2026-04-15, sem a palavra "lançamento"); "May 18, 2026" em review da Tom's Hardware (terceiro) | Página oficial lida (sem data); data **não comprovada** |
| 3 | Kobra X | Debut no Formnext 2025 (sem data exata); depósitos abertos em 2025-12-26 (ManufacturingTomorrow, reprodução de comunicado) | Página oficial lida (sem data de lançamento) |
| 4 | Kobra S1 Max | Pré-venda em novembro de 2025. Conflito: 2025-11-05 (Vertex3D) e 2025-11-25 (Fabbaloo) | Data oficial **não encontrada**; conflito não resolvido |
| 5 | Kobra 3 V2 | "Arrives May 15" (ALL3DP, título de busca; ano não confirmado no resultado) | Provisório; ano e dados **não comprovados** |

Alternativa para a posição 5: Kobra S1 (base), pré-venda com publicação de 2025-01-03 (Bradford Era, terceiro). Não foi resolvido qual dos dois é mais recente.

## Modelos

### Kobra 3 Max V2

- Região: página oficial US (`us.anycubic3d.com/products/kobra-3-max-v2-3d-printer`) [S3].
- Anúncio/lançamento: não comprovado. Fórum em 2026-08-28 menciona anúncio [S13]; SimplyPrint lista "Launched: September 2026" [S14]. Conflito entre fontes.
- Pré-venda: não encontrada.
- Envio: página US lida mostra "Ships in 24 hours" e preço de venda $429 (regular $599) [S3]. Resumo de busca cita "Estimated Shipping Time: Nov. 15 - Nov. 25" [S15]. Conflito não resolvido.
- Firmware: "Kobra OS" citado na página US [S3]. Versão: **desconhecida**.
- Conexão: resumo de busca da listagem Anycubic menciona modo WLAN com dados locais e app com nuvem para operação remota [S16]. SimplyPrint lista Wi-Fi e USB [S14]; 3DJake lista LAN [S17]. **Não comprovado**.
- Capacidades: volume 420 × 420 × 500 mm e 88 L [S3]. Câmera: SimplyPrint e FAQ de resumo indicam "sem câmera embutida" [S14, S15]; 3DJake indica 720p [S17], marcado como não confiável. Acessório "Live View Camera" listado na página US [S3]. Materiais e pacotes: PLA, PETG e similares em bundles 4 kg [S3]. Sistema de cores: ACE 2 Pro, quatro cores no combo [S3, S16].
- Telemetria, arquivos, comandos: **desconhecidos**.
- Nível de evidência: documentação (página oficial lida), com itens de conexão e lançamento não comprovados.

### Kobra 4

- Região: loja global `store.anycubic.com/products/kobra-4-3d-printer` [S1].
- Anúncio: revelado no booth da Anycubic em RAPID+TCT (Boston, 2026-04-15) como "additional new machine" [S7]. O comunicado não usa a palavra "lançamento".
- Lançamento público: "May 18, 2026" em review da Tom's Hardware (terceiro, resumo de busca) [S8]. All3DP mostra data "TBD" [S9]. **Não comprovado** por fonte oficial.
- Pré-venda: nenhuma pré-venda oficial encontrada na página lida.
- Disponibilidade: página oficial mostra preço de venda $279 (regular $379) e Combo $379 com quatro cores [S1]. Menu de navegação mostra "Combo from $299", divergindo da página do produto [S1].
- Envio: "Free Express Shipping", sem data [S1].
- Firmware: **desconhecido**.
- Conexão: página lida lista apenas "Smart Device Remote Control" [S1]. Resumos de review citam Wi-Fi e USB, com LAN no Combo [S8, resumo]. **Não comprovado**.
- Câmera: "720P Camera: Real-Time AI Monitoring" com detecção de anomalias [S1]. Diretório de terceiros diz "No" (conflito) [resumo].
- Sensores: acelerômetro para compensação de vibração [S1]. Sensor de fim de filamento citado em review [S8, resumo].
- Capacidades: volume 260 × 260 × 260 mm [S1]. Velocidade recomendada 300 mm/s e máxima 600 mm/s [resumo; Anycubic]. Materiais listados: PETG, PLA High Speed, PLA+, PLA Special, PLA Matte, PLA Silk [S1].
- Nível de evidência: documentação (página lida), com lançamento e conexão não comprovados.

### Kobra X

- Região: loja global `store.anycubic.com/pages/kobra-x-new-launch` [S2].
- Debut: Formnext 2025, Frankfurt. Sem data exata nas fontes lidas [S6].
- Pré-venda/depósito: abertura em 2025-12-26 via loja oficial. Depósito US$10 aplicado como desconto de US$30. Sem data de encerramento na fonte [S6].
- Early bird e Fantastic Weeks: citados em resumo de busca (3DPrinting.com e cobertura de terceiros) [resumo]. Não lidos diretamente.
- Disponibilidade: página lida mostra Kobra X (4 cores) a $299 (regular $399) e "Ships in 24 hours" [S2].
- Firmware: **desconhecido**. Comunicado cita "standard hardware and firmware features" sem versão [S6].
- Conexão: resumo cita Wi-Fi dual band 2,4/5 GHz, modo LAN, USB, app e slicer [resumo]. Não confirmado na página lida. **Não comprovado**.
- Câmera: não consta explicitamente. Comunicado cita "AI-assisted print monitoring" [S6]. Câmera **não comprovada**.
- Capacidades: volume 260 × 260 × 260 mm [S2]. Quatro canais ACE 2, até 19 filamentos com ACE 2 Pro (resumo) [resumo]. Materiais listados na página: PLA+, PETG, PLA High Speed, PETG-CF, PLA-CF, PLA Special, ASA, TPU [S2].
- Nível de evidência: documentação (página lida), com conexão e câmera não comprovadas.

### Kobra S1 Max

- Região: loja global e Europa/US (`store.anycubic.com/products/kobra-s1-max`) [resumo de busca; página não aberta].
- Pré-venda: depósito US$50 com crédito de US$100, citado em cobertura de novembro de 2025 [resumo de terceiros].
- Lançamento: conflito 2025-11-05 (Vertex3D) e 2025-11-25 (Fabbaloo) [resumo]. Early bird de 5 a 24 de novembro (Gadgetman, resumo). **Não comprovado** por comunicado oficial.
- Disponibilidade atual: página de revisão de setembro de 2026 trata o modelo como atual [resumo]. Preço não confirmado.
- Firmware: nome "Kobra OS" [resumo]. Versão **desconhecida**. Firmware de terceiros Rinkhals cita o S1 Max como suportado [GitHub, resumo].
- Conexão: Wi-Fi 6 dual band e Ethernet, com suporte a rede local [resumo da loja]. Manual de terceiros diz que LAN desliga app, nuvem e detecção de falhas por IA, e que atualizações exigem vínculo com conta [resumo]. Sem confirmação oficial.
- Câmera: HD 720p com detecção por IA [resumo da loja].
- Capacidades: volume 350 × 350 × 350 mm [resumo]. Câmara aquecida até 65 °C [resumo]. Até 16 cores com ACE 2 Pro, segundo comunicado Anycubic de 2026-04-15 [S7] (não específico do S1 Max Combo lido na íntegra).
- Nível de evidência: desconhecido (nenhuma página de produto lida diretamente).

### Kobra 3 V2 (provisório, posição 5)

- Data: "Kobra 3 V2 Arrives May 15" (ALL3DP) [resumo de busca]. Ano não confirmado.
- Não foram estudados firmware, conexão, câmera ou materiais.
- Nível de evidência: desconhecido.

## Variantes e pacotes (não contados como modelos novos)

- Kobra S1 ACE 2 Pro Combo: variante de hardware do Kobra S1, com ACE 2 Pro de até 16 cores. Anúncio em 2026-04-16 e disponibilidade em 2026-04-24, segundo resumo de Notebookcheck e loja europeia [resumo]. 3druck traz 2025 (provavelmente erro). Não conta como base nova.
- Kobra 3 Max Combo (2024) e Kobra 3 Max V2 Combo: pacotes e combos. Não contados como modelos novos.
- Kobra S1 Combo e Kobra 3 Max Combo: aparecem como exibidos no RAPID+TCT 2026 [S7] e na navegação [S5]. Não são lançamentos novos comprovados.
- Photon P1 e P1 Max: resina. Excluídos.

## Lacunas de ranking

1. Posições 1 e 2: a data pública de Kobra 3 Max V2 e Kobra 4 não está em fonte oficial lida. Há conflito entre fontes de terceiros.
2. Posição 4: Kobra S1 Max tem conflito entre 2025-11-05 e 2025-11-25. Não há comunicado oficial.
3. Posição 5: Kobra 3 V2 (maio, ano não confirmado) e Kobra S1 (2025-01) não foram resolvidos.
4. Kobra 3 Max V2 pode ser revisão do Kobra 3 Max (2024). Se for, a contagem de modelos base muda.
5. Três páginas da loja ficaram sem leitura por limite de requisições. Dados de preço e envio de Kobra 3 Max V2, Kobra 4 e Kobra S1 Max podem estar desatualizados.

## Conectividade, autenticação, telemetria e licenças

- Protocolo: fontes comunitárias (Rinkhals, printlog-bridge) citam MQTT nas portas 18910 e 9883 em Kobra 3 e S1 [GitHub, resumo]. **Não comprovado** por documentação oficial e não aplicado aos modelos deste relatório.
- LAN e nuvem: resumos citam que o modo LAN pode desvincular a impressora da conta e que alguns recursos de nuvem são desligados. Sem comunicado oficial lido. **Não comprovado**.
- Autenticação: conta Anycubic, vínculo por QR code e firmware atualizado via app [manual de terceiro, resumo]. Não comprovado diretamente.
- Telemetria: política de privacidade global (anycubic.com) cita web beacons e coleta de uso [resumo]. Declaração de dados da UE diz que dados de conta são coletados ao criar conta no app, e logs são locais [resumo]. Política não foi aberta diretamente. **Não comprovado**.
- Incidente de segurança: resumo cita falha em 2024 na nuvem para Kobra 2, com correção de firmware [resumo]. Não lido na fonte primária.
- Licenças e restrições de acesso: não revisadas. Rinkhals é firmware de terceiros com licença não verificada. **Desconhecido**.

## Comandos (um por um)

| Comando | Situação |
|---|---|
| Envio de arquivo / iniciar impressão | Resumo cita "remote operation and initiation of printing tasks" via nuvem (Kobra 3 Max V2) [S16]. Não comprovado na documentação oficial. |
| Pausar / retomar | Desconhecido |
| Cancelar | Desconhecido |
| Consultar status e progresso | Resumo cita progresso em LAN e stream de vídeo local (S1 Max, terceiro). Não comprovado. |
| Stream de câmera | Câmera 720p citada para Kobra 4 e S1 Max (resumo). Não comprovada para Kobra 3 Max V2 e Kobra X. |
| Calibração / homing | Desconhecido |
| Temperatura e ventilação | Desconhecido |
| Atualizar firmware | Resumo cita atualização via app/nuvem (S1 Max). Não comprovado. |
| Ligar/desligar luz, ventilação, câmara | Desconhecido |

Nenhum comando foi testado. Não há hardware, simulador ou acesso à API.

## Fontes

- [S1] Anycubic. Kobra 4 3D Printer, página de produto. `https://store.anycubic.com/products/kobra-4-3d-printer`. Publicação: não datada. Acesso: 2026-11-13. Método: leitura direta. Sustenta preço, dimensões, câmera, sensor e materiais; não sustenta lançamento.
- [S2] Anycubic. Kobra X new launch page. `https://store.anycubic.com/pages/kobra-x-new-launch`. Publicação: não datada. Acesso: 2026-11-13. Método: leitura direta. Sustenta preço, envio e materiais; não sustenta data de lançamento.
- [S3] Anycubic US. Kobra 3 Max V2 product page. `https://us.anycubic3d.com/products/kobra-3-max-v2-3d-printer`. Publicação: não datada. Acesso: 2026-11-13. Método: leitura direta. Sustenta preço, volume, "Kobra OS" e acessório de câmera; não sustenta lançamento.
- [S4] Anycubic. Kobra series navigation/catalog. `https://store.anycubic.com/collections/kobra-series`. Acesso: 2026-11-13. Método: leitura pelo coordenador (web.run). Sustenta apenas presença no catálogo.
- [S5] Anycubic. Black Friday 2026 early bird preview. `https://store.anycubic.com/blogs/news/anycubic-black-friday-3d-printer-deals-2026-early-bird-preview`. Publicação: 2026-10-22. Acesso: 2026-11-13. Método: leitura direta. Sustenta rótulo "New Arrivals" e nomes; não sustenta lançamento.
- [S6] ManufacturingTomorrow. "Anycubic Opens Deposits for Kobra X…". `https://www.manufacturingtomorrow.com/news/2025/12/26/anycubic-opens-deposits-for-kobra-x-following-formnext-debut-of-its-next-generation-entry-level-multicolor-fdm-printer/26773/`. Publicação: 2025-12-26. Acesso: 2026-11-13. Método: leitura direta. Sustenta depósito em 2025-12-26 e Formnext 2025; não sustenta data de fechamento.
- [S7] Anycubic (PR Newswire). "Anycubic Showcases Next-Generation 3D Printing Lineup at RAPID+TCT 2026…". `https://www.prnewswire.com/news-releases/anycubic-showcases-next-generation-3d-printing-lineup-at-rapidtct-2026-highlighting-multicolor-fdm-and-large-format-resin-innovation-302743844.html`. Publicação: 2026-04-15. Acesso: 2026-11-13. Método: leitura direta. Sustenta exibição de Kobra X, Kobra 4, S1 Max Combo, S1 Combo e Kobra 3 Max Combo; não diz "lançamento".
- [S8] Tom's Hardware. Kobra 4 Combo review. `https://www.tomshardware.com/3d-printing/anycubic-kobra-4-combo-3d-printer-review`. Acesso: 2026-11-13. Método: resumo de busca. Sustenta "May 18, 2026" como afirmação de terceiro, sem confirmação oficial.
- [S9] All3DP. Top 3D printers launched at RAPID+TCT 2026. `https://all3dp.com/1/top-3d-printers-launched-at-rapid-tct-2026/`. Acesso: 2026-11-13. Método: resumo de busca. Sustenta data "TBD" para Kobra 4.
- [S10] Fabbaloo. Kobra S1 Max Combo launch. `https://www.fabbaloo.com/news/anycubic-launches-kobra-s1-max-combo-with-larger-build-volume-and-enhanced-material-capabilities`. Acesso: 2026-11-13. Método: resumo de busca. Sustenta 2025-11-25 como afirmação de terceiro.
- [S11] Vertex3D. Kobra S1 Max Combo launching soon. `https://www.vertex3d.co/blog/anycubic-announcements-19/anycubic-kobra-s1-max-combo-launching-soon-big-build-volume-bigger-expectations-86`. Acesso: 2026-11-13. Método: resumo de busca. Sustenta 2025-11-05 como afirmação de terceiro.
- [S12] Notebookcheck. Kobra S1 ACE 2 Pro launch. `https://www.notebookcheck.net/Anycubic-Kobra-S1-ACE-2-Pro-3D-printer-launches-with-16-colors-filament-drying-and-discount.1277337.0.html`. Acesso: 2026-11-13. Método: resumo de busca. Sustenta abril de 2026 como afirmação de terceiro.
- [S13] Drucktipps3D forum. Kobra 3 Max V2 thread. `https://forum.drucktipps3d.de/forum/thread/49722-anycubic-kobra-3-max-v2/`. Acesso: 2026-11-13. Método: resumo de busca. Sustenta menção de 2026-08-28 como comunidade.
- [S14] SimplyPrint. Kobra 3 Max V2 Combo compatibility page. `https://simplyprint.io/compatibility/anycubic-kobra-3-max-v2-combo`. Acesso: 2026-11-13. Método: resumo de busca. Sustenta "Launched: September 2026" e "built-in camera: No" como afirmações de terceiro.
- [S15] Anycubic US listing (resumo). Estimated Shipping Time Nov. 15 to 25. Acesso: 2026-11-13. Método: resumo de busca. Conflita com "Ships in 24 hours" de [S3].
- [S16] Anycubic (EU/US) Kobra 3 Max V2 Combo listing. `https://eu.anycubic.com/products/kobra-3-max-v2-combo-3d-printer`. Acesso: 2026-11-13. Método: resumo de busca. Sustenta WLAN local e operação remota via nuvem como descrição do fabricante em resumo.
- [S17] 3DJake. Kobra 3 Max V2 Combo listing. `https://www.3djake.com/anycubic-3d-printer-and-accessories/kobra-3-max-v2-combo`. Acesso: 2026-11-13. Método: resumo de busca. Conflita com outras fontes sobre câmera e conexão. Não confiável nesses pontos.
- [S18] Rinkhals. Custom firmware for Kobra series. `https://github.com/jbatonnet/Rinkhals`. Acesso: 2026-11-13. Método: resumo de busca. Comunitário; licença não verificada.
- [S19] Rinkhals PR #219 (LAN e bridge). `https://github.com/rinkhals-community/Rinkhals/pull/219`. Acesso: 2026-11-13. Método: resumo de busca. Comunitário; não comprovado.
- [S20] printlog-bridge issue #96 (portas MQTT). `https://github.com/HoffmanEngineering/printlog-bridge/issues/96`. Acesso: 2026-11-13. Método: resumo de busca. Comunitário; não comprovado.
- [S21] Anycubic privacy policy. `https://www.anycubic.com/en/PrivacyPolicy`. Acesso: 2026-11-13. Método: resumo de busca (não aberto). Não usado como prova.
- [S22] Anycubic data information statement (UE). Acesso: 2026-11-13. Método: resumo de busca. Não usado como prova.
- [S23] Anycubic (PR Newswire). Black Friday 2026 sale release. `https://www.prnewswire.com/news-releases/anycubic-launches-2026-black-friday-and-cyber-monday-sale-across-13-global-markets-with-up-to-350-off-3d-printers-302927728.html`. Publicação: 2026-11-03 (resumo). Acesso: 2026-11-13. Método: resumo de busca. Sustenta presença de Kobra 3 Max V2 Combo e S1 Max Combo em promoção.
- [S24] Bradford Era. Kobra S1 Combo pre-sale. `https://www.bradfordera.com/2025/01/03/the-new-disruptor-anycubic-unveils-pre-sale-of-the-s1-combo-its-first-fully-enclosed-multi-color-corexy-3d-printer/`. Publicação: 2025-01-03. Acesso: 2026-11-13. Método: resumo de busca. Sustenta pré-venda do S1 Combo.

## Próximos passos

1. Obter comunicado oficial dated para Kobra 3 Max V2, Kobra 4 e Kobra S1 Max (press room Anycubic ou PR Newswire com data).
2. Abrir as páginas de Kobra S1 Max e Kobra 3 V2 e comparar com as listas da loja.
3. Ler a política de privacidade atual e a declaração de dados da UE na fonte primária.
4. Ler manual oficial de cada modelo e confirmar conexão (LAN/nuvem), versão de firmware e comandos suportados.
5. Verificar licença de firmware de terceiros (Rinkhals) antes de qualquer uso.
6. Decidir se Kobra 3 Max V2 é modelo base novo ou revisão do Kobra 3 Max, e fixar a posição 5.
7. Nenhuma ação de integração ou hardware deve partir deste relatório sem nova autorização.
