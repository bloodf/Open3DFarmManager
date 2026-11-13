# Creality: pesquisa de compatibilidade FDM

Estado: pesquisa documental pública; não certifica compatibilidade nem comprova integração.

- Corte: 2026-11-13. Acesso às fontes: 2026-11-13.
- Base declarada: `bad76165aa4fbe86949ae624ddedc973721d5fcf`.
- Escopo: impressoras FDM, modelos base; combos e CFS não contam como modelos separados.
- Resultado: `DONE_WITH_CONCERNS`; ranking dos cinco lançamentos mais recentes permanece incompleto.

## Síntese

O K3 tinha pré-venda anunciada para meados de outubro de 2026, mas o FAQ oficial de 30 de setembro não informa data de envio. O site oficial atualmente oferece pré-venda do K3; isso prova disponibilidade para pedido, não expedição. O Ender-3 V3 Neo e Mega tiveram evento de pré-venda anunciado para 13 de outubro e têm páginas de produto, mas disponibilidade e envio variam por região. A SPARKX i8 aparece em página oficial de produto e wiki, mas as fontes consultadas não estabeleceram quando terminou o crowdfunding, início de venda regular ou expedição. Logo, não é possível certificar os cinco modelos mais recentemente lançados e disponíveis nem fechar as posições relativas.

## Ranking provisório e etapas

| Modelo-base | Evidência pública e estado em 2026-11-13 | Limite |
|---|---|---|
| Creality K3 | FAQ oficial, 2026-09-30: pré-venda prevista para meados de outubro; homepage oficial oferece “Preorder Now”. | Data de envio e prova de unidades expedidas não encontradas. |
| Ender-3 V3 Neo | Evento oficial marca pré-venda em 2026-10-13; página oficial lista produto e compra. | Não foi estabelecida data de envio por região. |
| Ender-3 V3 Mega | Mesmo evento Neo/Mega; página de produto e firmware datado de 2026-11-13. Loja dos EUA consultada mostrava ambos os modelos como esgotados. | Indício regional de oferta, não prova de disponibilidade global nem primeiro envio. |
| SPARKX i8 | Página oficial traz especificações FFF e a wiki tem guia e firmware (V2.0.1.3, nota de 2026-11-05). | Campanha de crowdfunding, venda varejista e envio não datados nas fontes consultadas. |
| Ender-3 V4 | Manual presente no índice oficial da Wiki. | Apenas presença de documentação; lançamento e disponibilidade não confirmados. Posição ilustrativa, não parte de ranking comprovado. |

SPARKX i7 também aparece na iniciativa aberta e documentação oficial, porém as fontes consultadas não estabelecem sua cronologia em relação ao grupo. Modelos acima não devem ser tratados como os cinco mais recentes até obter datas oficiais comparáveis de anúncio, pré-venda/crowdfunding e primeiro envio em cada região. CFS, CFS nano, CFS Lite e versões Combo são acessórios/pacotes, não modelos-base adicionais.

## Firmware, conectividade e capacidades

- **K3:** FAQ oficial descreve firmware baseado em Klipper, publicação do código em fases e acesso root disponível de fábrica para usuários avançados. Não informa interface Moonraker nem endpoints. Impressora multicolor com troca de bicos e compatibilidade declarada com Creality Print 7+ e OrcaSlicer. Conexão LAN, nuvem, autenticação, comandos individuais e licença/código efetivamente publicado não foram verificados.
- **SPARKX i7/i8:** iniciativa oficial de 20 de outubro afirma acesso a Fluidd, Moonraker e SSH em ambos. Isso é evidência documental de interfaces, não teste de acesso por unidade ou firmware. i8: firmware V2.0.1.3 listado em 5 de novembro; FFF, 260 × 260 × 255 mm, Wi-Fi 2,4 GHz, controle remoto web/app, cloud e OTA listados pela página de produto. FAQ recomenda PLA/PETG; quatro canais são coordenados pelo firmware. Comandos Moonraker por método, autorização/autenticação local e estado LAN sem nuvem não foram documentados nas fontes abertas. Não assumir que qualquer firmware derivado de Klipper expõe Moonraker.
- **Ender-3 V3 Neo/Mega:** as páginas oficiais descrevem monitoramento e controle via Creality Cloud; Mega especifica Wi-Fi 2,4 GHz e transferência por USB/Wi-Fi/Cloud. Neo tem câmera integrada; Mega usa Nebula Camera opcional para visualização remota. Nenhuma interface local Moonraker, autenticação LAN ou comandos foi comprovada. Página de suporte lista firmware, mas não inspecionei imagem/binário, versão exata, licença nem modificação.
- **Licenças e root/flash:** não foram verificados arquivos de licença completos para firmware dos modelos. Não executei root, flash, login, pareamento ou comandos. SPARKX Open Initiative menciona recursos técnicos publicados para i7 e planos faseados para i8; isso não demonstra licença permissiva do firmware inteiro. Não se deve inferir capacidade ou autorização de modificação a partir de “Klipper-based”.

## Fontes oficiais consultadas

As datas de publicação abaixo são as informadas pela própria página quando disponíveis; acesso em 2026-11-13.

1. [K3 FAQ](https://www.creality.com/blog/k3-questions-answered), publicado 2026-09-30 — calendário de pré-venda, firmware Klipper-derived, root e slicers; não indica envio.
2. [Homepage Creality](https://www.creality.com/), consultada 2026-11-13 — K3 em pré-venda; Neo/Mega à venda no catálogo. Estado dinâmico, não prova de expedição.
3. [Agenda oficial de transmissões](https://store.creality.com/pages/live-stream), consultada 2026-11-13 — pré-venda Neo/Mega indicada para 2026-10-13.
4. [Ender-3 V3 Mega](https://www.creality.com/products/ender-3-v3-mega), consultada 2026-11-13 — capacidades, variações Combo/standalone, conexão e câmera.
5. [Loja oficial Ender-3 V3 Mega](https://store.creality.com/products/ender-3-v3-mega-3d-printer), consultada 2026-11-13 — preço e estado “Sold Out” regional; página apresentava janela estimada de envio Oct 9–11 sem ano visível, portanto não usada como prova de expedição.
6. [Suporte Mega](https://www.creality.com/support/ender-3-v3-mega) e [downloads Mega](https://www.creality.com/download/ender-3-v3-mega), consultados 2026-11-13 — firmware listado em 2026-11-13 e software.
7. [SPARKX i8](https://store.creality.com/pages/sparkx-i8), consultada 2026-11-13 — FFF, especificações, Wi-Fi, cloud/app e OTA.
8. [Iniciativa aberta SPARKX](https://www.creality.com/blog/sparkx-open-initiative), publicada 2026-10-20 — acesso declarado a Fluidd/Moonraker/SSH em i7/i8; publicação técnica gradual.
9. [Notas de firmware i8](https://wiki.creality.com/en/sparkx/i8/firmware-update), nota V2.0.1.3 publicada 2026-11-05 — funções e correções listadas.
10. [FAQ i8](https://wiki.creality.com/en/sparkx/i8/FAQ) e [guia i8](https://wiki.creality.com/en/sparkx/i8), consultados 2026-11-13 — materiais, canais e documentação do produto.
11. [Índice oficial da série Ender](https://wiki.creality.com/en/ender-series), consultado 2026-11-13 — manuais Neo, Mega e V4; presença no índice não é lançamento.
12. [Guia Neo/Mega](https://store.creality.com/uk/blogs/news/ender-3-v3-neo-mega-new-arrival), publicado 2026-10-21 — anúncio editorial, diferenças de hardware e CFS nano opcional.

## Próximos passos

- Encontrar comunicados oficiais datados de crowdfunding i8, abertura de venda regular e primeiro envio; verificar regiões separadamente.
- Confirmar datas oficiais de primeiro envio do K3 e Neo/Mega em cada região. Tratar preorder e “Buy Now” como estados distintos de envio.
- Pesquisar anúncios de outros modelos Creality FDM do período para completar cronologia e confirmar os cinco mais recentes sem duplicar combos.
- Obter documentação oficial de LAN/autenticação e comandos por método/firmware; manter `unknown` onde não houver documentação ou teste autorizado.
- Revisar licenças dos componentes e firmware publicados, sem root ou flash nesta pesquisa.

Nenhum hardware, conta, firmware, comando ou endpoint foi acessado. Nenhuma alegação de compatibilidade com Connector é feita.
