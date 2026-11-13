# Consolidação documental FDM

Corte e acesso: 2026-11-13. Base `bad76165aa4fbe86949ae624ddedc973721d5fcf`; HEAD inspecionado `c7feac52fda5e344df670cfff1b2be484bc7678b`, descendente confirmado. Estado: DONE_WITH_CONCERNS.

Não se aceita uma matriz fechada de 15 modelos. Os relatórios admitidos [Bambu](bambu.md), [Anycubic](anycubic.md) e [Creality](creality.md) são entradas de pesquisa, não certificações. Esta adjudicação distingue anúncio, pré-venda, oferta e primeira entrega. Combo, AMS, ACE e CFS não criam modelos adicionais. Não houve hardware, firmware instalado ou teste de integração.

## Posições e fila

| Marca | Posições ainda não aceitas | Decisão e evidência |
| --- | --- | --- |
| Bambu Lab | 1–5 por disponibilidade | B1 confirma anúncios H3C 2026-11-03, A2L 2026-06-01, X2D 2026-04-14, H2C 2025-11-14 e P2S 2025-10-14. Isso confirma a sequência desses anúncios, não catálogo exaustivo ou primeira expedição. R1 é laser e fica excluído. |
| Anycubic | 1–2 | Kobra 3 Max V2 e Kobra 4 têm páginas oficiais A1/A2, mas datas comparáveis não comprovadas. A ordem anterior não foi admitida. |
| Anycubic | 3–4 | Kobra X e S1 Max permanecem candidatos sem ordem oficial revalidada. O conflito anterior de novembro para S1 Max continua aberto; A3 é produto, não anúncio datado. |
| Anycubic | 5 | Kobra 3 V2 versus Kobra S1 continua aberto. A tentativa da página oficial V2 falhou A4. Datas de terceiros não resolvem a posição. A distinção de revisões V2 precisa de critério explícito. |
| Creality | 1–5 | K3, Neo, Mega, i8 e V4 não constituem cinco disponíveis comprovados. C3 acrescenta estreia e pré-venda norte-americana do i7; C4 mostra oferta. Isso ainda não determina sua posição entre cinco. |

Fila de futuros ou disponibilidade não comprovada: K3, Ender-3 V3 Neo, Ender-3 V3 Mega, SPARKX i8 e Ender-3 V4. A fila não afirma que nunca foram enviados; impede usar ausência de prova como disponibilidade. K3 tem pré-venda e firmware baseado em Klipper declarados C6; Neo/Mega têm anúncio editorial britânico C7; i8 mostra Sold Out e janela sem ano C5; V4 aparece como exposição no CES C3. Nenhum preenche automaticamente uma vaga.

Investigar primeiro i7 como alternativa: C3 foi publicado em 2026-01-07 19:00 ET, com corpo datado de 8 janeiro e estreia no CES. Não converter essa diferença em dois lançamentos. C4 identifica Color Combo e Nano Combo como pacotes da base i7. Primeira entrega permanece desconhecida. K2/K2 Pro e Ender-5 Max são próximos nomes para pesquisa, sem classificação admitida nesta entrega.

A2L tem venda global declarada em 1 junho e Japão/Coreia em 2 junho B2. A oferta US da Anycubic A2 não prova disponibilidade brasileira ou global. As janelas Nov 5–7 de i7/i8 não exibem ano e não são prova de envio C4/C5. H3C e os demais Bambu sem primeira entrega comprovada permanecem candidatos, sem admissão no ranking de disponíveis.

## Implementabilidade, por evidência

A ordem abaixo é julgamento documental, não promessa de suporte.

1. SPARKX i7 é a primeira investigação local. C1 declara Fluidd, Moonraker e SSH para i7/i8. i8 tem a mesma pista de protocolo, mas continua na fila de disponibilidade. Autenticação, versão exata e métodos precisam de confirmação por dispositivo.
2. S1 Max e Bambu ficam sem desempate. A3 documenta Wi-Fi 6, Ethernet, rede local, transferência de arquivos e Kobra OS. Não fornece contrato público de API. B3 distingue status MQTT de operações autorizadas e descreve Bambu Connect; o aviso começa em X1 01.08.03.00 e não estabelece firmware dos cinco candidatos.
3. K3, Neo/Mega e demais Anycubic não têm evidência suficiente aqui para uma ordem local. Root ou derivação Klipper C6 não comprova Moonraker acessível. Ausência de documentação não significa offline nem unsupported.

C1 aplica OCL v1.1 aos recursos estruturais e interfaces de hardware descritos. Não comprova licença de firmware. C2 retornou **404 Not Found** nesta verificação: a alegação i8 **V2.0.1.3 / 2026-11-05** fica **não verificada**, sem substituição inventada.

## Comandos separados

Cada célula descreve a evidência para integração de terceiros, não a existência de um botão no aplicativo.

| Capacidade | Anycubic | Bambu Lab | SPARKX i7/i8 |
| --- | --- | --- | --- |
| Upload | S1 Max anuncia transferência local A3; API desconhecida | Connect transmite arquivos B3; API por candidato desconhecida | Acesso Moonraker declarado C1; método/firmware não qualificado |
| Iniciar | API desconhecida | Autorização LAN/cloud descrita B3; firmware dos candidatos desconhecido | Método/firmware não qualificado |
| Pausar | API desconhecida | API por candidato desconhecida | Método/firmware não qualificado |
| Retomar | API desconhecida | API por candidato desconhecida | Método/firmware não qualificado |
| Cancelar | API desconhecida | API por candidato desconhecida | Método/firmware não qualificado |

Telemetria, câmera, arquivos, materiais/multicor e emergência exigem contratos próprios. Câmera anunciada não prova stream acessível; transferência não prova início; recuperação após falta de energia não prova comando remoto de retomada. Licenças de SDK e redistribuição continuam pendentes. Nenhuma capacidade física foi certificada.

## Próximas etapas e limites

1. Obter anúncios e registros oficiais regionais de envio dos candidatos, sem usar posição no catálogo como cronologia.
2. Pesquisar Kobra 3 V2/S1 e Creality i7, K2/K2 Pro e Ender-5 Max como candidatos alternativos; só admitir com cronologia primária e identidade comprovadas.
3. Localizar notas oficiais válidas do i8 e identificar versão, autenticação e licença por firmware.
4. Documentar upload, start, pause, resume e cancel individualmente antes de qualquer adaptador; qualificação simulada e física permanecem pendentes.

Preservar WebRTC direto browser–Connector, autoridade e verificações de segurança no Connector; modo degradado somente leitura. Não introduzir fallback de comandos pelo servidor. Suporte deve ser por dispositivo/firmware.

CodeGraph 1.6.2: query e sync informaram índice não inicializado; status confirmou initialized:false. Nenhum índice grande foi criado. Leitura delimitada dos relatórios e documentação substituiu o índice. A verificação estrutural não certifica fatos, hardware ou integração. Builds e testes de produto não executados neste escopo documental.

## Fontes verificadas nesta rodada

- [B1](https://blog.bambulab.com/tag/press-release/). Publicação: não datada ou não recuperada. Acesso: 2026-11-13. Datas dos cinco anúncios Bambu; índice não prova disponibilidade nem exaustividade.
- [B2](https://blog.bambulab.com/bambu-lab-a2l-creative-playground-extra-large/). Publicação: 2026-06-01. Acesso: 2026-11-13. Venda global A2L em 1 junho; Japão/Coreia em 2 junho.
- [B3](https://blog.bambulab.com/firmware-update-introducing-new-authorization-control-system-2/). Publicação: 2025-01-16. Acesso: 2026-11-13. Autorização de comandos, MQTT status e Bambu Connect; escopo inicial X1, não firmware dos candidatos.
- [A1](https://store.anycubic.com/products/kobra-4-3d-printer). Publicação: não datada ou não recuperada. Acesso: 2026-11-13. Catálogo e oferta Kobra 4, sem cronologia comprovada.
- [A2](https://us.anycubic3d.com/products/kobra-3-max-v2-3d-printer). Publicação: não datada ou não recuperada. Acesso: 2026-11-13. Página regional US Kobra 3 Max V2, sem data de lançamento comprovada.
- [A3](https://store.anycubic.com/products/kobra-s1-max). Publicação: não datada ou não recuperada. Acesso: 2026-11-13. Kobra OS, Wi-Fi 6, Ethernet, LAN e transferência de arquivos anunciados; sem contrato de API.
- [A4](https://store.anycubic.com/pages/kobra-3-v2-combo-global-new-launch). Publicação: não datada ou não recuperada. Acesso: 2026-11-13. Tentativa falhou: URL não acessível pela ferramenta; não valida data.
- [C1](https://www.creality.com/blog/sparkx-open-initiative). Publicação: 2026-10-20. Acesso: 2026-11-13. Declara Fluidd/Moonraker/SSH i7/i8; OCL v1.1 restrita aos recursos estruturais/hardware descritos.
- [C2](https://wiki.creality.com/en/sparkx/i8/firmware-update). Publicação: não datada ou não recuperada. Acesso: 2026-11-13. Retornou 404; V2.0.1.3 e 2026-11-05 não verificados.
- [C3](https://www.prnewswire.com/news-releases/from-idea-to-print-creality-sparkx-i7-debuts-at-ces-2026-for-everyday-creators-302655772.html). Publicação: 2026-01-07. Acesso: 2026-11-13. Comunicado Creality: estreia i7 CES, pré-venda América do Norte; corpo datado 8 janeiro. V4 exibida, não envio.
- [C4](https://store.creality.com/products/sparkx-i7-3d-printer). Publicação: não datada ou não recuperada. Acesso: 2026-11-13. Oferta i7, Color/Nano Combo identificam mesma base; janela Nov 5-7 sem ano não prova envio.
- [C5](https://store.creality.com/pages/sparkx-i8). Publicação: não datada ou não recuperada. Acesso: 2026-11-13. Redireciona a produto i8, Sold Out; janela Nov 5-7 sem ano não prova expedição.
- [C6](https://www.creality.com/blog/k3-questions-answered). Publicação: 2026-09-30. Acesso: 2026-11-13. Pré-venda K3; firmware baseado em Klipper e root declarados, sem contrato Moonraker.
- [C7](https://store.creality.com/uk/blogs/news/ender-3-v3-neo-mega-new-arrival). Publicação: 2026-10-21. Acesso: 2026-11-13. Anúncio editorial Neo/Mega no Reino Unido; não comprova primeira entrega.
