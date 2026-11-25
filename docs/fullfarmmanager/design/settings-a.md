# Conta, membros, convites, integrações e administração

Capturas dentro do shell, com respostas sintéticas, pt-BR e movimento reduzido, em 1440 × 900 e 390 × 844 (página inteira). Convites mostra o link recém-criado; Integrações mostra um aplicativo ativo e um revogado. Nenhum comando chega a impressoras.

## O que mudou

Somente a aparência; comportamento, rotas e textos permanecem.

- `apps/farm/app/assets/css/ops-screen.css` aplica o contrato `--ops-*` a `main#conteudo.ops-screen`: título compacto com régua, painéis planos com barra de título, rótulos de instrumento, campos com borda visível, ação principal preenchida, ação destrutiva e avisos nas cores de estado, identificadores em fonte monoespaçada.
- `/conta` usa duas colunas a partir de 75rem, na mesma ordem de leitura; `/convites` põe farm, papel e botão na mesma linha a partir de 64rem.
- `rede.vue` e o painel de aprovações em `farm.vue` não recebem a classe e não mudam.

## Pares

| Tela                  | Tamanho | Tema   | Antes                                                           | Depois                                                          |
| --------------------- | ------- | ------ | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Conta                 | desktop | claro  | [Antes](settings-a-conta-before-desktop-light.png)              | [Depois](settings-a-conta-after-desktop-light.png)              |
| Conta                 | desktop | escuro | [Antes](settings-a-conta-before-desktop-dark.png)               | [Depois](settings-a-conta-after-desktop-dark.png)               |
| Conta                 | mobile  | claro  | [Antes](settings-a-conta-before-mobile-light.png)               | [Depois](settings-a-conta-after-mobile-light.png)               |
| Conta                 | mobile  | escuro | [Antes](settings-a-conta-before-mobile-dark.png)                | [Depois](settings-a-conta-after-mobile-dark.png)                |
| Membros e convites    | desktop | claro  | [Antes](settings-a-membros-before-desktop-light.png)            | [Depois](settings-a-membros-after-desktop-light.png)            |
| Membros e convites    | desktop | escuro | [Antes](settings-a-membros-before-desktop-dark.png)             | [Depois](settings-a-membros-after-desktop-dark.png)             |
| Membros e convites    | mobile  | claro  | [Antes](settings-a-membros-before-mobile-light.png)             | [Depois](settings-a-membros-after-mobile-light.png)             |
| Membros e convites    | mobile  | escuro | [Antes](settings-a-membros-before-mobile-dark.png)              | [Depois](settings-a-membros-after-mobile-dark.png)              |
| Convidar pessoa       | desktop | claro  | [Antes](settings-a-convites-before-desktop-light.png)           | [Depois](settings-a-convites-after-desktop-light.png)           |
| Convidar pessoa       | desktop | escuro | [Antes](settings-a-convites-before-desktop-dark.png)            | [Depois](settings-a-convites-after-desktop-dark.png)            |
| Convidar pessoa       | mobile  | claro  | [Antes](settings-a-convites-before-mobile-light.png)            | [Depois](settings-a-convites-after-mobile-light.png)            |
| Convidar pessoa       | mobile  | escuro | [Antes](settings-a-convites-before-mobile-dark.png)             | [Depois](settings-a-convites-after-mobile-dark.png)             |
| Integrações           | desktop | claro  | [Antes](settings-a-integracoes-before-desktop-light.png)        | [Depois](settings-a-integracoes-after-desktop-light.png)        |
| Integrações           | desktop | escuro | [Antes](settings-a-integracoes-before-desktop-dark.png)         | [Depois](settings-a-integracoes-after-desktop-dark.png)         |
| Integrações           | mobile  | claro  | [Antes](settings-a-integracoes-before-mobile-light.png)         | [Depois](settings-a-integracoes-after-mobile-light.png)         |
| Integrações           | mobile  | escuro | [Antes](settings-a-integracoes-before-mobile-dark.png)          | [Depois](settings-a-integracoes-after-mobile-dark.png)          |
| Provedores de entrada | desktop | claro  | [Antes](settings-a-provedores-entrada-before-desktop-light.png) | [Depois](settings-a-provedores-entrada-after-desktop-light.png) |
| Provedores de entrada | desktop | escuro | [Antes](settings-a-provedores-entrada-before-desktop-dark.png)  | [Depois](settings-a-provedores-entrada-after-desktop-dark.png)  |
| Provedores de entrada | mobile  | claro  | [Antes](settings-a-provedores-entrada-before-mobile-light.png)  | [Depois](settings-a-provedores-entrada-after-mobile-light.png)  |
| Provedores de entrada | mobile  | escuro | [Antes](settings-a-provedores-entrada-before-mobile-dark.png)   | [Depois](settings-a-provedores-entrada-after-mobile-dark.png)   |

## Verificações de acessibilidade

- `tests/unit/design-design-settings-a-screens.test.ts`: em cada tela, tamanho e tema, um único `h1`, ausência de rolagem horizontal da página e axe (regras padrão) sem violações no conteúdo `#conteudo`.
- Specs Playwright existentes, sem alterações (`account-security`, `account-creation-pages`, `members-page`, `polish-settings`, `polish-members`, `polish-integrations`): axe, teclado, foco visível, retorno do foco, diálogo e largura em 360 px e desktop.
- Revisão pelas Web Interface Guidelines do que a mudança toca: foco com `:focus-visible`, hover em botões, `touch-action: manipulation`, `overscroll-behavior: contain` no diálogo, `text-wrap: balance` nos títulos, `tabular-nums` nas contagens, nomes longos quebrando linha e campos com 16 px em ponteiros de toque.
- Não verificado: zoom e leitor de tela manuais. O axe cobre só o contraste detectável automaticamente, no estado capturado.
- Fora do escopo visual, ficaram como estavam: confirmações com `window.confirm` em Integrações e campos sem atributo `name`.

Para recapturar: `DESIGN_SCREENSHOTS=1 npx vitest run tests/unit/design-design-settings-a-` (`DESIGN_PHASE` assume `after`).
