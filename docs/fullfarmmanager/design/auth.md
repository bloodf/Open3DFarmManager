# Acesso, conta e pareamento: comparação de design

Telas `/entrar`, `/criar-conta`, `/redefinir-senha`, `/primeiro-acesso`, `/parear`, `/sair` e `/` com o contrato `--ops-*`: coluna centrada, cabeçalho de 18 px, painéis planos com borda de 1 px, rótulos de 12 px e ação principal preenchida. Rotas, requisições, comportamento e textos não mudaram. Nenhuma dessas telas mostra bobina. `/dispositivos` usa os mesmos componentes e mantém a aparência anterior: o novo estilo é ativado pela propriedade `access` de `OnboardingPage`.

As capturas mostram a página inteira dentro do shell, com respostas sintéticas, 1440 × 900 e 390 × 844, movimento reduzido. Em `/entrar`, Google e OpenID Connect aparecem habilitados. Para gerar de novo: `DESIGN_SCREENSHOTS=1 DESIGN_PHASE=after npx vitest run tests/unit/design-design-auth-`.

| Tela            | Tamanho | Tema  | Antes                                                  | Depois                                                 |
| --------------- | ------- | ----- | ------------------------------------------------------ | ------------------------------------------------------ |
| entrar          | desktop | light | [Antes](auth-entrar-before-desktop-light.png)          | [Depois](auth-entrar-after-desktop-light.png)          |
| entrar          | desktop | dark  | [Antes](auth-entrar-before-desktop-dark.png)           | [Depois](auth-entrar-after-desktop-dark.png)           |
| entrar          | mobile  | light | [Antes](auth-entrar-before-mobile-light.png)           | [Depois](auth-entrar-after-mobile-light.png)           |
| entrar          | mobile  | dark  | [Antes](auth-entrar-before-mobile-dark.png)            | [Depois](auth-entrar-after-mobile-dark.png)            |
| criar-conta     | desktop | light | [Antes](auth-criar-conta-before-desktop-light.png)     | [Depois](auth-criar-conta-after-desktop-light.png)     |
| criar-conta     | desktop | dark  | [Antes](auth-criar-conta-before-desktop-dark.png)      | [Depois](auth-criar-conta-after-desktop-dark.png)      |
| criar-conta     | mobile  | light | [Antes](auth-criar-conta-before-mobile-light.png)      | [Depois](auth-criar-conta-after-mobile-light.png)      |
| criar-conta     | mobile  | dark  | [Antes](auth-criar-conta-before-mobile-dark.png)       | [Depois](auth-criar-conta-after-mobile-dark.png)       |
| redefinir-senha | desktop | light | [Antes](auth-redefinir-senha-before-desktop-light.png) | [Depois](auth-redefinir-senha-after-desktop-light.png) |
| redefinir-senha | desktop | dark  | [Antes](auth-redefinir-senha-before-desktop-dark.png)  | [Depois](auth-redefinir-senha-after-desktop-dark.png)  |
| redefinir-senha | mobile  | light | [Antes](auth-redefinir-senha-before-mobile-light.png)  | [Depois](auth-redefinir-senha-after-mobile-light.png)  |
| redefinir-senha | mobile  | dark  | [Antes](auth-redefinir-senha-before-mobile-dark.png)   | [Depois](auth-redefinir-senha-after-mobile-dark.png)   |
| primeiro-acesso | desktop | light | [Antes](auth-primeiro-acesso-before-desktop-light.png) | [Depois](auth-primeiro-acesso-after-desktop-light.png) |
| primeiro-acesso | desktop | dark  | [Antes](auth-primeiro-acesso-before-desktop-dark.png)  | [Depois](auth-primeiro-acesso-after-desktop-dark.png)  |
| primeiro-acesso | mobile  | light | [Antes](auth-primeiro-acesso-before-mobile-light.png)  | [Depois](auth-primeiro-acesso-after-mobile-light.png)  |
| primeiro-acesso | mobile  | dark  | [Antes](auth-primeiro-acesso-before-mobile-dark.png)   | [Depois](auth-primeiro-acesso-after-mobile-dark.png)   |
| parear          | desktop | light | [Antes](auth-parear-before-desktop-light.png)          | [Depois](auth-parear-after-desktop-light.png)          |
| parear          | desktop | dark  | [Antes](auth-parear-before-desktop-dark.png)           | [Depois](auth-parear-after-desktop-dark.png)           |
| parear          | mobile  | light | [Antes](auth-parear-before-mobile-light.png)           | [Depois](auth-parear-after-mobile-light.png)           |
| parear          | mobile  | dark  | [Antes](auth-parear-before-mobile-dark.png)            | [Depois](auth-parear-after-mobile-dark.png)            |
| sair            | desktop | light | [Antes](auth-sair-before-desktop-light.png)            | [Depois](auth-sair-after-desktop-light.png)            |
| sair            | desktop | dark  | [Antes](auth-sair-before-desktop-dark.png)             | [Depois](auth-sair-after-desktop-dark.png)             |
| sair            | mobile  | light | [Antes](auth-sair-before-mobile-light.png)             | [Depois](auth-sair-after-mobile-light.png)             |
| sair            | mobile  | dark  | [Antes](auth-sair-before-mobile-dark.png)              | [Depois](auth-sair-after-mobile-dark.png)              |
| index           | desktop | light | [Antes](auth-index-before-desktop-light.png)           | [Depois](auth-index-after-desktop-light.png)           |
| index           | desktop | dark  | [Antes](auth-index-before-desktop-dark.png)            | [Depois](auth-index-after-desktop-dark.png)            |
| index           | mobile  | light | [Antes](auth-index-before-mobile-light.png)            | [Depois](auth-index-after-mobile-light.png)            |
| index           | mobile  | dark  | [Antes](auth-index-before-mobile-dark.png)             | [Depois](auth-index-after-mobile-dark.png)             |

## Acessibilidade

Verificações automáticas em `tests/unit/design-design-auth-screens.test.ts`:

- axe no conteúdo de cada tela, nos dois tamanhos e temas;
- ausência de rolagem horizontal da página em 1440, 390 e 320 px;
- botões, campos e links de navegação das telas com pelo menos 44 px de altura;
- axe nos estados de erro (entrar, criar conta, pareamento indisponível) e de sucesso (redefinição), nos dois temas;
- envio de `/entrar` por teclado: o foco vai para o alerta, com contorno visível.

Os specs `polish-auth`, `polish-onboarding`, `polish-overview`, `auth-pages`, `account-creation-pages`, `pre-hydration-forms`, `frontend-accessibility` e `auth-lockout-session` passaram sem alteração (ordem de tabulação, anel de foco, nomes acessíveis, regiões ativas).

Revisão pelas Web Interface Guidelines: foco visível com `:focus-visible`, estados de hover, ícones decorativos ocultos de leitores de tela, erro e sucesso com ícone além da cor, `text-wrap: balance` nos títulos, campos com 16 px em telas de toque e cores somente por tokens. As bordas dos campos misturam `--ops-muted` e `--ops-panel` para ficarem mais nítidas que `--ops-border`.

Fora do escopo visual e não alterados: campos sem atributo `name`, marca sem `translate="no"` e mensagens de carregamento sem reticências. A inspeção manual com leitor de tela está pendente.
