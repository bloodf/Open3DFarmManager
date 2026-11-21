# Matriz de compatibilidade Spoolman v0.27.1

Corte: 2026-11-21. Upstream MIT em tag `v0.27.1`, revisão `ff8efd517b76a4b2783f29c89e9b9fbcd8cd167b`. Inventário: 54 rotas HTTP/WebSocket, 58 esquemas OpenAPI. Revisão estática do código e do OpenAPI exportado; nenhum servidor Spoolman foi exigido para gerar esta matriz.

## Atribuição

Spoolman é software MIT de Daniel Hultgren. A licença completa do pin está em `third_party/spoolman-reference/LICENSE`. O OpenAPI e o inventário de endpoints ficam em `docs/compatibility/spoolman-openapi-v0.27.1.json` e `docs/compatibility/spoolman-endpoint-inventory.json`. Nenhum código de aplicação upstream foi copiado para o produto.

## Legenda de status no produto

| Status                   | Significado                                                                  |
| ------------------------ | ---------------------------------------------------------------------------- |
| `implemented`            | Cliente mantido no Connector (somente leitura ou invalidação por websocket). |
| `experimental`           | Código presente, fora do espelho somente leitura principal.                  |
| `simulator_or_test_only` | Mock do simulador ou testes Node; não é compatibilidade de produção.         |
| `qualification_only`     | Scripts opt-in contra instância descartável documentada em outro relatório.  |
| `unimplemented`          | Endpoint upstream existente sem cliente mantido localizado.                  |

## Clientes mantidos (contratos de requisição)

### connector_spool_inventory_get

- **GET /api/v1/spool**
- Query: `{"limit": "configurable 1-200 (SpoolmanConfig.limit)", "offset": "non-negative integer, ascending pagination", "sort": "id:asc (fixed)", "allow_archived": "true (fixed)"}`
- Cabeçalhos: `{"accept": "application/json", "authorization": "optional bearer/basic from credentials/spoolman.json"}`
- Fonte: `packages/connector/src/spoolman/bounded-read.ts`

### connector_provision_probe_get

- **GET /api/v1/spool**
- Query: `{"limit": "1"}`
- Cabeçalhos: `{"accept": "application/json", "authorization": "optional"}`
- Fonte: `packages/connector/src/provisioning/spoolman.ts`

### connector_root_websocket

- **WS /api/v1/**
- Cabeçalhos: `{"authorization": "optional on handshake"}`
- Mensagens WS: type added|updated|deleted; resource spool|filament|vendor; date; payload
- Fonte: `packages/connector/src/runtime/spoolman-provider.ts`

### kobra_x_spool_use_put

- **PUT /api/v1/spool/{spool_id}/use**
- Cabeçalhos: `{"accept": "application/json", "content-type": "application/json"}`
- Corpo: `{"use_weight": "positive number (grams)"}`
- Fonte: `packages/connector/src/kobra-x/booking.ts`

## Áreas explicitamente não implementadas no produto

- **search**: 2/2 rotas upstream sem cliente mantido.
- **tag**: 8/8 rotas upstream sem cliente mantido.
- **external**: 3/3 rotas upstream sem cliente mantido.
- **location**: 2/2 rotas upstream sem cliente mantido.

## Websocket

Modelos de evento no pin: `SpoolEvent`, `FilamentEvent`, `VendorEvent`, `SettingEvent`, `TagScanEvent`. O Connector na raiz `/api/v1/` aceita apenas `resource` em `spool`, `filament`, `vendor` com `type` `added|updated|deleted`. `SettingEvent` e `TagScanEvent` (`scanned`, `tag_scan`) não invalidam o inventário.

## Erros e cabeçalhos documentados no pin

- ItemNotFoundError — HTTP 404
- Backup failure — HTTP 500
- Untrusted browser origin (HTTP writes or WS handshake) — WS close 4403
- Untrusted Host header (WS handshake) — WS close 4400
- Resposta `GET /api/v1/external/filament/search`: cabeçalho `x-total-count` (response).

## Fixtures e proveniência

- `tests/fixtures/spoolman/spools.json` (sha256 `ac6584e71b23f0ad…`): Synthetic Spoolman shapes for unit tests. Original MIT fixture data; field shapes aligned with packages/connector/src/spoolman/read.ts parsers and pinned upstream v0.27.1 models.py names. Not copied from upstream database dumps.
- `infra/sim/spoolman/seed.json` (sha256 `44a863cf491f7498…`): Docker sim:seed inventory fixture. Original MIT fixture data; field shapes aligned with packages/connector/src/spoolman/read.ts parsers and pinned upstream v0.27.1 models.py names. Not copied from upstream database dumps.

## Tabela completa de endpoints

| Método | Caminho                                    | Transporte | Status no produto        | Notas                                                                                                                 |
| ------ | ------------------------------------------ | ---------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| WS     | `/api/v1/`                                 | websocket  | `implemented`            | Root websocket for spool/filament/vendor added\|updated\|deleted; ignores setting/tag_scan. No subscription messages. |
| GET    | `/api/v1/article-number`                   | http       | `unimplemented`          | Location and facet listing endpoints not called by product code.                                                      |
| POST   | `/api/v1/backup`                           | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| GET    | `/api/v1/export/filaments`                 | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| GET    | `/api/v1/export/spools`                    | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| GET    | `/api/v1/export/vendors`                   | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| GET    | `/api/v1/external/filament`                | http       | `unimplemented`          | External catalog and x-total-count header not consumed.                                                               |
| GET    | `/api/v1/external/filament/search`         | http       | `unimplemented`          | External catalog and x-total-count header not consumed.                                                               |
| GET    | `/api/v1/external/material`                | http       | `unimplemented`          | External catalog and x-total-count header not consumed.                                                               |
| GET    | `/api/v1/field/{entity_type}`              | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| DELETE | `/api/v1/field/{entity_type}/{key}`        | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| POST   | `/api/v1/field/{entity_type}/{key}`        | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| GET    | `/api/v1/field/{entity_type}/{key}/values` | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| GET    | `/api/v1/filament`                         | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| POST   | `/api/v1/filament`                         | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| DELETE | `/api/v1/filament/{filament_id}`           | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| GET    | `/api/v1/filament/{filament_id}`           | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| PATCH  | `/api/v1/filament/{filament_id}`           | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| WS     | `/api/v1/filament/{filament_id}`           | websocket  | `unimplemented`          | Per-entity websocket paths exist upstream; product uses root /api/v1/ only.                                           |
| POST   | `/api/v1/filament/{filament_id}/tag`       | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| DELETE | `/api/v1/filament/{filament_id}/tag/{uid}` | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| GET    | `/api/v1/health`                           | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| GET    | `/api/v1/info`                             | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| GET    | `/api/v1/location`                         | http       | `unimplemented`          | Location and facet listing endpoints not called by product code.                                                      |
| PATCH  | `/api/v1/location/{location}`              | http       | `unimplemented`          | Location and facet listing endpoints not called by product code.                                                      |
| GET    | `/api/v1/lot-number`                       | http       | `unimplemented`          | Location and facet listing endpoints not called by product code.                                                      |
| GET    | `/api/v1/material`                         | http       | `unimplemented`          | Location and facet listing endpoints not called by product code.                                                      |
| GET    | `/api/v1/search`                           | http       | `unimplemented`          | Upstream search endpoint documented; no product client issues requests.                                               |
| GET    | `/api/v1/setting/`                         | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| GET    | `/api/v1/setting/{key}`                    | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| POST   | `/api/v1/setting/{key}`                    | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| WS     | `/api/v1/setting/{key}`                    | websocket  | `unimplemented`          | Per-entity websocket paths exist upstream; product uses root /api/v1/ only.                                           |
| GET    | `/api/v1/spool`                            | http       | `implemented`            | Paginated GET only; no writes. Bounded body and traversal limits in bounded-read.ts.                                  |
| POST   | `/api/v1/spool`                            | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| PATCH  | `/api/v1/spool/field/{field}`              | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| GET    | `/api/v1/spool/group`                      | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| DELETE | `/api/v1/spool/{spool_id}`                 | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| GET    | `/api/v1/spool/{spool_id}`                 | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| PATCH  | `/api/v1/spool/{spool_id}`                 | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| WS     | `/api/v1/spool/{spool_id}`                 | websocket  | `unimplemented`          | Per-entity websocket paths exist upstream; product uses root /api/v1/ only.                                           |
| PUT    | `/api/v1/spool/{spool_id}/measure`         | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| POST   | `/api/v1/spool/{spool_id}/tag`             | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| DELETE | `/api/v1/spool/{spool_id}/tag/{uid}`       | http       | `unimplemented`          | No maintained product client located in packages/connector, apps/farm or scripts except simulator/qualification.      |
| PUT    | `/api/v1/spool/{spool_id}/use`             | http       | `experimental`           | Not part of read-only farm mirror; used only by Kobra-X usage booking helper and node test e16-368.                   |
| GET    | `/api/v1/tag/reader`                       | http       | `unimplemented`          | Tag link/scan/websocket relay not integrated.                                                                         |
| POST   | `/api/v1/tag/scan`                         | http       | `unimplemented`          | Tag link/scan/websocket relay not integrated.                                                                         |
| WS     | `/api/v1/tag/scan`                         | websocket  | `unimplemented`          | Tag link/scan/websocket relay not integrated.                                                                         |
| WS     | `/api/v1/tag/scan/{reader_id}`             | websocket  | `unimplemented`          | Tag link/scan/websocket relay not integrated.                                                                         |
| GET    | `/api/v1/vendor`                           | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| POST   | `/api/v1/vendor`                           | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| DELETE | `/api/v1/vendor/{vendor_id}`               | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| GET    | `/api/v1/vendor/{vendor_id}`               | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| PATCH  | `/api/v1/vendor/{vendor_id}`               | http       | `simulator_or_test_only` | Not used by maintained Connector inventory mirror against real services.                                              |
| WS     | `/api/v1/vendor/{vendor_id}`               | websocket  | `unimplemented`          | Per-entity websocket paths exist upstream; product uses root /api/v1/ only.                                           |

## Lacunas

- Search, tag relay, external catalog, settings writes, export, backup and location rename are upstream features without maintained product clients.
- Per-entity websockets and TagScanEvent (resource tag_scan, type scanned) are not handled by the Connector provider.
- Farm UI stores Spoolman origin in Postgres; it does not proxy arbitrary Spoolman REST.
- Simulator mock implements a subset for tests; mock behavior is not claimed as full upstream parity.
- No live Spoolman execution was required for this matrix; disposable API receipts remain in docs/SPOOLMAN-ACTUAL-API-VALIDATION.md.

## Aceitação

Esta matriz não substitui qualificação contra um serviço real. Evidência offline: `node scripts/check-spoolman-matrix.mjs`. Evidência com contêiner descartável permanece em `docs/SPOOLMAN-ACTUAL-API-VALIDATION.md`.
