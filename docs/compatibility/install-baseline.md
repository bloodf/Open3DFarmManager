# Linha de base de instalação própria

Data de corte: 2026-11-13. Revisão inspecionada: `35c86d67b0df17f6d43e36d4ea06b6b42533b5bf`; descendente de `bad76165aa4fbe86949ae624ddedc973721d5fcf`.

## Instalação e verificações

`docs/LOCAL-CI.md` documenta `bash scripts/test-local-ci.sh` e `bash scripts/local-ci.sh code`. O job de código requer Node 24.22.2, pnpm 12.18.0, dependências existentes, Chromium e bibliotecas do sistema. Instalação congelada executa scripts desabilitados; não prepara dependências do sistema. CI Ubuntu instala Playwright com `--with-deps`.

No baseline, `package.json` fixa `packageManager` em pnpm 12.18.0 e engine Node `>=24.22.2 <25`. `check:all` cobre lint, typecheck, testes Vitest, Node, supervisão RTSP, framing RTSP e build. O runner local também executa lint à parte. Playwright padrão deixa farm-view opt-in; experimentos WebRTC têm comandos próprios e não estão em `check:all` nem workflow.

## Preservação e limites

Os documentos locais de CI descrevem jobs opcionais de imagem e Klipper com opt-in explícito; pressupõem Docker e imagens base previamente disponíveis, e condicionam execução a espaço livre. Não executados nesta inspeção. Fontes consultadas não estabelecem procedimento completo de instalação própria, migração/upgrade, backup/restore ou preservação de configuração. Isso é evidência ausente, não falha observada.

Firmware/hardware permanece desconhecido. Escopo inicial FDM; nenhuma alegação de suporte por fabricante ou modelo decorre deste relatório. Nenhum serviço, instalação, build ou hardware foi iniciado. A árvore do grafo não estava inicializada; foi usado conteúdo Git pontual no SHA declarado.

## Próximos passos

Documentar pré-requisitos por sistema operacional, instalação limpa, upgrade, backup/restore e localização/configuração preservada. Depois, validar em ambiente descartável com dados sintéticos e registrar versões e resultados. Confirmar checks remotos e PRs concorrentes sem assumir sua titularidade.
