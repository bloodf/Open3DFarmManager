# Site do Open3DFarmManager

Site estático de uma página, em pt-BR, sem servidor, sem dependências de execução e sem requisições externas. Os textos se baseiam em `README.md`, `docs/SELF-HOSTING.md`, `docs/PHASE-0.md`, `docs/compatibility/` e `LICENSE`, e seguem o [glossário da interface](../../docs/UI-GLOSSARY.md). O site descreve um projeto em desenvolvimento: não afirma suporte comprovado em hardware físico.

## Uso local

Pré-requisito: dependências do repositório instaladas (`npm ci --ignore-scripts` na raiz) e um Chromium do Playwright (`npx playwright install chromium`). A construção em si só precisa do Node.js.

```sh
node apps/website/build.mjs      # gera apps/website/dist/
node apps/website/verify.mjs     # constrói e valida no navegador
```

- **Saída:** `apps/website/dist/index.html` (ignorada pelo Git). Abra o arquivo direto no navegador, via `file://`; não há servidor. `build.mjs --out <pasta>` usa outro destino; só limpa pastas que já tenham o marcador `.openfarm-website-build`.
- **Determinismo:** a mesma entrada gera os mesmos bytes. `dist/.openfarm-website-build` guarda o SHA-256 de cada arquivo.
- **`verify.mjs`:** constrói duas vezes e compara os hashes. Abre cada `.html` de `dist/` por `file://` em 1280 px e 360 px, nos temas claro e escuro, e confere: erros de console e de página, requisições fora do site, estouro horizontal, estrutura semântica, texto alternativo, ordem de Tab e foco visível, `<summary>` pelo teclado, movimento reduzido, alternância de tema e axe (WCAG 2.0 a 2.2 A/AA e boas práticas). Também confere a atribuição de cada captura de tela em relação a `docs/images/README.md` e os bytes de `docs/images/`. Sai com código 1 em qualquer falha.
- **Capturas de tela e `report.json`:** vão para fora do repositório, em uma pasta nova e exclusiva de cada execução (`$TMPDIR/openfarm-website-verify-XXXXXX`); o caminho real é impresso no início e no fim. `OPENFARM_WEBSITE_SHOTS=<pasta>` escolhe outra pasta (os `.png`/`.json` antigos dela são apagados). A pasta é recusada, antes de criar ou apagar qualquer arquivo, se ela ou o destino real dela (link simbólico no último componente ou em qualquer pasta acima) estiver dentro do repositório (`apps/website/lib/evidence-dir.mjs`, coberto por `tests/node/website-evidence-dir.test.ts`). Cada execução também constrói em uma pasta temporária própria (removida ao final), então execuções simultâneas não compartilham arquivos e não tocam em `apps/website/dist/`.

## Estrutura

```text
apps/website/
  build.mjs            construção estática
  verify.mjs           evidência: build + navegador + axe
  lib/                 utilitários da construção e verificações executadas na página
  src/layout.html      casca: cabeçalho, navegação, rodapé
  src/styles/          tokens.css (cores, tipografia, espaços), base.css, shell.css
  src/scripts/         theme-init.js (inline, evita flash) e site.js (alternar tema)
  src/assets/          favicon
  sections/<id>/       <id>.html e <id>.css de cada seção
```

## Seções independentes

A ordem fica em `SECTIONS` no `build.mjs`: `hero`, `features`, `how`, `install`, `faq`. Cada unidade posterior troca apenas a sua pasta em `sections/<id>/`:

- `<id>.html` começa com `<section id="..." aria-labelledby="...">`. O atributo `data-nav="Rótulo"` coloca a seção na navegação. Sem scripts e sem URLs externas em `src`/`href` de recursos.
- `<id>.css` é concatenado depois dos estilos da casca. Prefixe as classes com o nome da seção (`.faq__list`) para não afetar as outras. Use os tokens de `tokens.css` (`var(--ink)`, `var(--copper)`, ...) e os componentes de `base.css` (`.section`, `.section-head`, `.btn`, `.callout`, `.tag`, `.shot`, `.code`).
- `{{repo}}` vira a URL do repositório no GitHub.
- Capturas de tela reais vêm de `docs/images/` (copiadas sem alteração para `assets/screenshots/`). Cada `<figure>` precisa de `<figcaption>` com “Captura real”, rota, viewport, data, commit e link para `docs/images/README.md`; o `verify.mjs` confere isso.

## Tema, movimento e acessibilidade

O tema segue o sistema (`prefers-color-scheme`). O botão do cabeçalho alterna claro/escuro e guarda a escolha em `localStorage` (opcional). Sem JavaScript, vale a preferência do sistema. As cores usam `light-dark()` em `tokens.css`. Animações e rolagem suave só existem com `prefers-reduced-motion: no-preference`. As fontes são pilhas do sistema, sem arquivos de fonte.
