# Câmera, biblioteca e arquivos: comparação de design

Mudança apenas visual: rotas, comportamento e textos em pt-BR são os mesmos. As capturas usam 1440 × 900 e 390 × 844, dados fixos e as páginas sem o shell. A sessão da câmera, a lista de arquivos e o estado das impressoras vêm de substitutos locais; o quadro da câmera é um desenho em canvas. Nada se conecta a um Connector ou a uma impressora.

## Pares

| Tela                    | Tamanho | Tema  | Antes                                               | Depois                                              |
| ----------------------- | ------- | ----- | --------------------------------------------------- | --------------------------------------------------- |
| câmera (`/camera-view`) | desktop | light | [Antes](camera-view-before-desktop-light.png)       | [Depois](camera-view-after-desktop-light.png)       |
| câmera (`/camera-view`) | desktop | dark  | [Antes](camera-view-before-desktop-dark.png)        | [Depois](camera-view-after-desktop-dark.png)        |
| câmera (`/camera-view`) | mobile  | light | [Antes](camera-view-before-mobile-light.png)        | [Depois](camera-view-after-mobile-light.png)        |
| câmera (`/camera-view`) | mobile  | dark  | [Antes](camera-view-before-mobile-dark.png)         | [Depois](camera-view-after-mobile-dark.png)         |
| biblioteca              | desktop | light | [Antes](camera-biblioteca-before-desktop-light.png) | [Depois](camera-biblioteca-after-desktop-light.png) |
| biblioteca              | desktop | dark  | [Antes](camera-biblioteca-before-desktop-dark.png)  | [Depois](camera-biblioteca-after-desktop-dark.png)  |
| biblioteca              | mobile  | light | [Antes](camera-biblioteca-before-mobile-light.png)  | [Depois](camera-biblioteca-after-mobile-light.png)  |
| biblioteca              | mobile  | dark  | [Antes](camera-biblioteca-before-mobile-dark.png)   | [Depois](camera-biblioteca-after-mobile-dark.png)   |
| arquivos                | desktop | light | [Antes](camera-arquivos-before-desktop-light.png)   | [Depois](camera-arquivos-after-desktop-light.png)   |
| arquivos                | desktop | dark  | [Antes](camera-arquivos-before-desktop-dark.png)    | [Depois](camera-arquivos-after-desktop-dark.png)    |
| arquivos                | mobile  | light | [Antes](camera-arquivos-before-mobile-light.png)    | [Depois](camera-arquivos-after-mobile-light.png)    |
| arquivos                | mobile  | dark  | [Antes](camera-arquivos-before-mobile-dark.png)     | [Depois](camera-arquivos-after-mobile-dark.png)     |

## O que mudou

- `assets/css/ops-screen.css` aplica o contrato `--ops-*` ao kit Vue existente, só dentro de `.ops-screen`: painéis planos com uma borda e cantos de 6 px, título de seção com divisória, controles com 44 px de altura e borda mais forte que a dos painéis, ação principal preenchida e ação destrutiva em `--ops-fault`.
- Cabeçalho com o nome do produto em fonte mono e o `PageHeader` de 18 px.
- Biblioteca: cartões com área de miniatura no topo e ação alinhada na base, alternância Grade/Lista como controle segmentado, rótulos mono nos metadados, situação das versões com `StatusBadge` (ícone, texto e hachura para arquivo removido), tabela de versões em um diálogo mais largo. O carretel desenhado (`FarmSpool`) dos materiais continua o mesmo.
- Reimpressão: grupos de impressoras com borda por nível, sempre com o título em texto, e confirmação da mesa destacada. O diálogo também é aberto pelo histórico e recebe esse mesmo ajuste lá.
- Arquivos: miniaturas em blocos, confirmação de impressão destacada, aviso de conexão indisponível em `--ops-attention` e barra de operação com tom de erro.
- Câmera: o visor fica em um painel com marcador decorativo ao lado de “Câmera ao vivo.”. `CameraDisplay.vue` não mudou; os ajustes valem só nesta página.

## Verificações de acessibilidade

- `tests/unit/design-design-camera-library-screens.test.ts` roda axe e verifica ausência de rolagem horizontal da página nas três telas, nos dois tamanhos e temas. Com `DESIGN_SCREENSHOTS=1` (e `DESIGN_PHASE=before|after`) grava as capturas.
- Antes da mudança, o axe apontava em `/camera-view` a falta de um marco `main` e conteúdo fora de marcos. A página agora usa `main`.
- Verificação pontual, fora da suíte, com axe nos dois tamanhos e temas: visão em lista, envio de arquivo, armazenamento, detalhes, histórico de versões e diálogo de reimpressão; no link da câmera indisponível, só axe. Sem violações; os estados da biblioteca também não tiveram rolagem horizontal da página.
- Testes existentes, sem alteração: `library-page` (axe, teclado, Escape, retorno de foco e larguras de 320, 768 e 1280 px), `replay-dialog`, `camera-display` e os e2e `polish-files`, `polish-cameras` e `polish-jobs` (axe, foco visível, ordem de títulos, larguras).
- Revisão pelas Web Interface Guidelines: foco visível com os tokens existentes, rótulos associados, rótulo clicável junto da caixa de seleção (em Arquivos, o bloco de confirmação inteiro é o rótulo), nome do produto com `translate="no"`, `touch-action: manipulation` nos botões, `overscroll-behavior: contain` nos diálogos destas telas, campos com 16 px em ponteiro grosso, margem de rolagem para a barra fixa não cobrir o foco, números tabulares e cor nunca como único sinal.
- Pendências que exigem mudança de comportamento ou de texto, fora deste escopo: filtros e modo de exibição da biblioteca não vão para a URL; campos de texto sem `name` e `autocomplete`.

## Pendente

As imagens de referência `library-*-darwin.png` de `tests/e2e/farm-manager/visual.spec.ts` mostram o desenho anterior. Elas precisam ser geradas de novo no macOS.
