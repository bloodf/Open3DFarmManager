# KobraLink - Instalação e Execução Local

Esta pasta contém a receita original (MIT) e os metadados de pin para a construção e execução local isolada do [KobraLink](https://github.com/NatHacks/Kobralink) sem modificações, atuando como ponte local para impressoras Anycubic Kobra OS sem exigir que o usuário utilize um segundo painel administrativo.

## 1. Diretrizes de Licença e Material de Terceiros

- **Licença do Upstream:** O KobraLink é licenciado sob **GPL-3.0-only** (`LICENSE` na raiz e `apps/api/package.json`).
- **Material de Terceiros da Anycubic:** O repositório upstream versiona certificados de cliente e chave privada extraídos do Anycubic Slicer Next (`apps/api/certs/anycubic_slicer.crt` e `anycubic_slicer.key`) para interoperabilidade com o broker MQTT das impressoras, sem licença declarada para esse material.
- **Ausência de Redistribuição:** O Open3DFarmManager **não copia, não incorpora e não redistribui** código-fonte, certificados, chaves privadas ou imagens de contêiner pré-construídas do KobraLink.
- **Separação de Processos:** O código do Open3DFarmManager e do seu Connector permanece integralmente sob licença MIT. A execução do KobraLink em processo/contêiner distinto comunicado via HTTP em loopback é uma escolha de arquitetura e isolamento operacional; **este repositório não afirma que a separação de processos ou contêineres resolve ou afasta obrigações da GPL-3.0**. Quem construir, executar ou distribuir imagens do KobraLink deve cumprir a GPL-3.0 de forma independente e avaliar o status jurídico do material de terceiros da Anycubic.

## 2. Pré-requisitos

1. **Docker e Docker Compose** instalados e controlados manualmente pelo operador (nenhum script do Open3DFarmManager inicia o motor de contêiner automaticamente).
2. **Git** para clonar e verificar o commit fixado do upstream.
3. **Diretório Externo Dedicado:** O checkout do KobraLink deve residir **fora** da árvore do Open3DFarmManager e de todos os seus worktrees, em diretório de propriedade exclusiva do usuário atual.

## 3. Obtenção e Verificação do Código-Fonte

Use o utilitário `scripts/kobralink-source.mjs` para buscar ou validar o checkout externo no commit fixado (`5a5e5d9b1e3b9ad4f0760672cf7dc4bb8c85f5e1`, versão `0.5.0`):

```bash
# Clonar no commit exato em diretório externo limpo:
node scripts/kobralink-source.mjs clone /caminho/externo/kobralink-src

# Verificar um checkout externo já existente:
node scripts/kobralink-source.mjs verify /caminho/externo/kobralink-src
```

O verificador recusa:

- Caminhos dentro do repositório Open3DFarmManager ou de qualquer worktree vinculado.
- Links simbólicos (`symlink`) no destino, nos diretórios pais ou nos metadados Git.
- Diretórios pertencentes a outro usuário do sistema operacional (`UID` divergente).
- Árvores sujas (arquivos modificados, preparados ou não rastreados), commits diferentes do SHA fixado ou repositórios Git de origem divergente.

## 4. Isolamento de Rede, Credenciais e Bootstrap sem Segundo Painel

A receita `infra/kobralink/docker-compose.yml` aplica as seguintes restrições:

- **Acesso Exclusivo em Loopback:** A porta de gestão `7100` é publicada apenas em `127.0.0.1:${KOBRALINK_MGMT_PORT:-7100}:7100`.
- **Portas Moonraker Ocultas:** As portas `7125-7140` **não são publicadas** no host, evitando controle não autenticado de impressoras pela LAN.
- **Segredo e Banco Independentes:** O serviço exige `KOBRALINK_AUTH_SECRET` próprio (distinto do Open3DFarmManager) e utiliza banco SQLite dedicado em `/data/kobralink.db` no volume nomeado `openfarm-kobralink-data`.
- **Sem Auto-Update ou Origens Extras:** `KOBRALINK_UPDATE_REPO` e `KOBRALINK_EXTRA_ORIGINS` são definidos como vazios (`''`), desativando consultas automáticas ao GitHub e origens de desenvolvimento (`:5173`).
- **Sem Painel Duplicado:** O usuário final não precisa abrir nem configurar a interface web do KobraLink. O bootstrap da conta administrativa inicial e a configuração de chave Moonraker são conduzidos pelo Connector do Open3DFarmManager via API local em `127.0.0.1`.

### Privilégios Mínimos e Limites Não Verificados

O serviço executa com `security_opt: [no-new-privileges:true]`, `cap_drop: [ALL]` e limites de CPU, memória e PIDs, sem `network_mode: host`, sem `privileged: true` e sem montagem de `docker.sock`. Como o `infra/Dockerfile` oficial do upstream utiliza `oven/bun:1.4.2-slim` sem declarar `USER` não-root e realiza escritas no diretório de dados e trabalho, **não declaramos compatibilidade com execução não-root arbitrária ou sistema de arquivos raiz somente leitura (`read_only: true`)** enquanto essa configuração não for qualificada em execução real.

## 5. Atualização, Backup e Rollback Escopados

As migrações SQLite/Prisma do KobraLink são aplicadas automaticamente na inicialização e avançam apenas em sentido único (não há migração reversa). Por isso, **atualização e rollback exigem preservar tanto a tag da imagem quanto o volume de dados**:

### Antes de Atualizar

1. Pare o serviço local:
   ```bash
   docker compose -f infra/kobralink/docker-compose.yml down
   ```
2. Exporte um backup datado do volume `openfarm-kobralink-data` (incluindo `kobralink.db`, `.auth-secret` e `gcodes`):
   ```bash
   docker run --rm \
     -v openfarm-kobralink-data:/data:ro \
     -v /caminho/externo/backups:/backup \
     busybox tar czf /backup/kobralink-data-5a5e5d9b1e3b-$(date +%Y%m%d%H%M%S).tar.gz -C /data .
   ```
3. Mantenha a imagem anterior identificada por commit (`kobralink-local:5a5e5d9b1e3b`) antes de construir uma nova tag.

### Rollback

Trocar apenas a imagem Docker após uma migração de esquema deixará o banco incompatível com a versão anterior. Para reverter com segurança:

1. Pare o contêiner da versão nova:
   ```bash
   docker compose -f infra/kobralink/docker-compose.yml down
   ```
2. Restaure o conteúdo do volume `openfarm-kobralink-data` a partir do arquivo de backup criado antes da atualização:
   ```bash
   docker run --rm \
     -v openfarm-kobralink-data:/data \
     -v /caminho/externo/backups:/backup:ro \
     busybox sh -c 'find /data -mindepth 1 -maxdepth 1 -exec rm -rf -- {} + && tar xzf /backup/kobralink-data-5a5e5d9b1e3b-<timestamp>.tar.gz -C /data'
   ```
3. Inicie novamente apontando `KOBRALINK_IMAGE=kobralink-local:5a5e5d9b1e3b` e `KOBRALINK_SRC` para o commit anterior verificado. Nunca remova volumes ou imagens pertencentes a outras tarefas ou instalações.

## 6. Modo LAN da Impressora e Incertezas de Firmware

- **Modo LAN Manual na Impressora:** Para que o KobraLink alcance a impressora na rede local (HTTP na porta `18910` para descoberta de credenciais e MQTT sobre TLS na porta `9883`), o operador deve ativar manualmente a opção de **Modo LAN (LAN Mode)** diretamente na tela física da impressora Anycubic Kobra X.
- **Incerteza de Firmware e Modelo:** O comportamento de autenticação MQTT, o certificado aceito pelo broker da impressora e os códigos de estado em pausa dependem da versão de firmware instalada na Kobra X. Atualizações de firmware ou do Anycubic Slicer Next podem alterar certificados ou parâmetros do protocolo sem aviso prévio; o Open3DFarmManager não declara compatibilidade irrestrita com versões de firmware não qualificadas.
