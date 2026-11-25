# Spoolman, Connectors, dispositivos, rede, compatibilidade e Bambu Cloud

Mudança visual. Comportamento, rotas e textos em pt-BR são os mesmos.

## O que mudou

- `assets/css/ops-screen.css` aplica o contrato `--ops-*` às telas com `ops-screen` no `<main>`: título de 18 px com régua, painéis planos com barra de título, cantos de 3 a 6 px, rótulos de medidas em fonte monoespaçada e identificadores com algarismos tabulares. Os componentes são os do kit Vue existente.
- Os componentes compartilhados com outras telas (`SettingsPage`, `OnboardingPage`, `OverviewHeader`, `FarmScopeSelector` e `components/ui`) e o shell não foram editados.
- Uma ação principal preenchida por contexto; revogação e desconexão usam o papel de falha.
- Spoolman: a situação salva virou selo (conectado, atenção ou falha), sem mudar o texto.
- Rede: o mapa e a tabela usam os papéis `--ops-*`. Conexão usa a cor de ação; reconectando, degradado e pendente pedem atenção; offline usa cinza com hachura na tabela (antes, vermelho). Glifo, texto e traço continuam identificando cada estado.
- Compatibilidade: modelos revisados e produtos aparecem em grade quando há largura.
- Nenhuma dessas seis telas mostra uma bobina, por isso os desenhos de bobina não foram usados.

## Capturas

Respostas sintéticas locais, pt-BR, movimento reduzido, 1440 × 900 e 390 × 844. Cada tela é montada sem o shell. O harness não carrega `<style src>`, então o seletor de farm da tela de rede aparece sem `farm-view.css`; os testes Playwright abaixo usam o build real, com o shell e essa folha. Para gerar de novo: `DESIGN_SCREENSHOTS=1 DESIGN_PHASE=after npx vitest run tests/unit/design-design-settings-b-`.

| Tela            | Tamanho | Tema  | Antes                                                        | Depois                                                       |
| --------------- | ------- | ----- | ------------------------------------------------------------ | ------------------------------------------------------------ |
| spoolman        | desktop | light | [Antes](settings-b-spoolman-before-desktop-light.png)        | [Depois](settings-b-spoolman-after-desktop-light.png)        |
| spoolman        | desktop | dark  | [Antes](settings-b-spoolman-before-desktop-dark.png)         | [Depois](settings-b-spoolman-after-desktop-dark.png)         |
| spoolman        | mobile  | light | [Antes](settings-b-spoolman-before-mobile-light.png)         | [Depois](settings-b-spoolman-after-mobile-light.png)         |
| spoolman        | mobile  | dark  | [Antes](settings-b-spoolman-before-mobile-dark.png)          | [Depois](settings-b-spoolman-after-mobile-dark.png)          |
| connectors      | desktop | light | [Antes](settings-b-connectors-before-desktop-light.png)      | [Depois](settings-b-connectors-after-desktop-light.png)      |
| connectors      | desktop | dark  | [Antes](settings-b-connectors-before-desktop-dark.png)       | [Depois](settings-b-connectors-after-desktop-dark.png)       |
| connectors      | mobile  | light | [Antes](settings-b-connectors-before-mobile-light.png)       | [Depois](settings-b-connectors-after-mobile-light.png)       |
| connectors      | mobile  | dark  | [Antes](settings-b-connectors-before-mobile-dark.png)        | [Depois](settings-b-connectors-after-mobile-dark.png)        |
| dispositivos    | desktop | light | [Antes](settings-b-dispositivos-before-desktop-light.png)    | [Depois](settings-b-dispositivos-after-desktop-light.png)    |
| dispositivos    | desktop | dark  | [Antes](settings-b-dispositivos-before-desktop-dark.png)     | [Depois](settings-b-dispositivos-after-desktop-dark.png)     |
| dispositivos    | mobile  | light | [Antes](settings-b-dispositivos-before-mobile-light.png)     | [Depois](settings-b-dispositivos-after-mobile-light.png)     |
| dispositivos    | mobile  | dark  | [Antes](settings-b-dispositivos-before-mobile-dark.png)      | [Depois](settings-b-dispositivos-after-mobile-dark.png)      |
| rede            | desktop | light | [Antes](settings-b-rede-before-desktop-light.png)            | [Depois](settings-b-rede-after-desktop-light.png)            |
| rede            | desktop | dark  | [Antes](settings-b-rede-before-desktop-dark.png)             | [Depois](settings-b-rede-after-desktop-dark.png)             |
| rede            | mobile  | light | [Antes](settings-b-rede-before-mobile-light.png)             | [Depois](settings-b-rede-after-mobile-light.png)             |
| rede            | mobile  | dark  | [Antes](settings-b-rede-before-mobile-dark.png)              | [Depois](settings-b-rede-after-mobile-dark.png)              |
| compatibilidade | desktop | light | [Antes](settings-b-compatibilidade-before-desktop-light.png) | [Depois](settings-b-compatibilidade-after-desktop-light.png) |
| compatibilidade | desktop | dark  | [Antes](settings-b-compatibilidade-before-desktop-dark.png)  | [Depois](settings-b-compatibilidade-after-desktop-dark.png)  |
| compatibilidade | mobile  | light | [Antes](settings-b-compatibilidade-before-mobile-light.png)  | [Depois](settings-b-compatibilidade-after-mobile-light.png)  |
| compatibilidade | mobile  | dark  | [Antes](settings-b-compatibilidade-before-mobile-dark.png)   | [Depois](settings-b-compatibilidade-after-mobile-dark.png)   |
| bambu-cloud     | desktop | light | [Antes](settings-b-bambu-cloud-before-desktop-light.png)     | [Depois](settings-b-bambu-cloud-after-desktop-light.png)     |
| bambu-cloud     | desktop | dark  | [Antes](settings-b-bambu-cloud-before-desktop-dark.png)      | [Depois](settings-b-bambu-cloud-after-desktop-dark.png)      |
| bambu-cloud     | mobile  | light | [Antes](settings-b-bambu-cloud-before-mobile-light.png)      | [Depois](settings-b-bambu-cloud-after-mobile-light.png)      |
| bambu-cloud     | mobile  | dark  | [Antes](settings-b-bambu-cloud-before-mobile-dark.png)       | [Depois](settings-b-bambu-cloud-after-mobile-dark.png)       |

## Verificações de acessibilidade

- `tests/unit/design-design-settings-b-screens.test.ts`: axe sem violações e sem rolagem horizontal da página nas seis telas, nos dois tamanhos e temas, no estado preenchido das capturas.
- `polish-settings`, `polish-integrations`, `polish-onboarding`, `polish-overview` e `polish-spools` (Playwright, build de produção): 490 testes aprovados sem alterar nenhum teste. Eles cobrem os estados de cada tela com axe, teclado, foco visível, largura em 360 px, alvos de toque e anúncios.
- `tests/unit/network-map.test.ts`: axe, larguras de 320, 768 e 1280 px e ordem de teclado do mapa e da tabela.
- Contraste calculado para o que o axe não mede por completo: texto offline sobre a faixa mais forte da hachura, 5,9:1 no claro e 6,0:1 no escuro; rótulos SVG do mapa, pelo menos 6,2:1; borda dos campos e botões neutros, pelo menos 7,0:1; cor do foco, pelo menos 6,4:1.
- Revisão pelas Web Interface Guidelines: foco com `:focus-visible`, estados de hover, `touch-action: manipulation`, `text-wrap: balance` no título, fundo e cor explícitos em `select`, texto de 16 px em campos em telas de toque e nenhuma animação nova. O botão de visualização pressionado se distingue por preenchimento e sublinhado, além de `aria-pressed`.
- Não verificado: zoom do navegador, leitor de tela e aparelho físico.
- Fora do escopo visual e ainda pendente: parte dos campos não tem atributo `name`; os campos de código do Bambu Cloud não desativam o corretor ortográfico; marcas e identificadores não usam `translate="no"`.
