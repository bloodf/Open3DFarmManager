# Matriz de compatibilidade Spoolman v0.27.1

Corte: 2026-11-21. Upstream MIT, tag `v0.27.1`, revisão `ff8efd517b76a4b2783f29c89e9b9fbcd8cd167b`. Fonte pinada: OpenAPI 3.1.0; 54 rotas e 58 esquemas. A análise é estática; não declara qualificação contra servidor em execução.

## Atribuição

Spoolman é software MIT de Daniel Hultgren. A licença completa está em `third_party/spoolman-reference/LICENSE`. O OpenAPI exportado e o inventário de rotas estão em `docs/compatibility/spoolman-openapi-v0.27.1.json` e `docs/compatibility/spoolman-endpoint-inventory.json`. Nenhum código de aplicação upstream foi copiado.

## Como ler os status

| Campo                                                           | Significado                                                                                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `builtin_server_compatibility_status` (também `product_status`) | Compatibilidade do servidor Spoolman substituto embutido. `implemented` exige implementação desse servidor.                             |
| `external_client_coverage_status`                               | Cobertura de chamadas feitas por clientes externos mantidos no Connector; isso não significa que o servidor embutido implementa a rota. |
| `unimplemented`                                                 | Sem rota correspondente no servidor Spoolman substituto embutido.                                                                       |

## Inventário de esquemas (58)

Os nomes abaixo vêm de `components.schemas` no OpenAPI pinado: `BackupResponse`, `EntityType`, `EventType`, `ExportFormat`, `ExternalFilament`, `ExternalMaterial`, `ExtraField`, `ExtraFieldParameters`, `ExtraFieldType`, `Filament`, `FilamentEvent`, `FilamentParameters`, `FilamentUpdateParameters`, `Finish`, `HTTPValidationError`, `HealthCheck`, `Info`, `Message`, `MultiColorDirection-Input`, `Pattern`, `RenameFieldValueParameters`, `RenameFieldValueResult`, `RenameLocationBody`, `RootModel_str_`, `SearchResultFilament`, `SearchResultFilamentSpool`, `SearchResultSpool`, `SearchResultVendor`, `SearchResults`, `SettingEvent`, `SettingKV`, `SettingResponse`, `SettingType`, `Spool`, `SpoolEvent`, `SpoolGroup`, `SpoolGroupPreviewFilament`, `SpoolGroupPreviewSpool`, `SpoolMeasureParameters`, `SpoolParameters`, `SpoolType`, `SpoolUpdateParameters`, `SpoolUseParameters`, `Tag`, `TagConflictMessage`, `TagDecodedInfo`, `TagLinkParameters`, `TagReader`, `TagScan`, `TagScanEvent`, `TagScanParameters`, `ValidationError`, `Vendor`, `VendorEvent`, `VendorParameters`, `VendorUpdateParameters`, `spoolman__api__v1__models__MultiColorDirection`, `spoolman__externaldb__MultiColorDirection`. Os contratos de entrada e saída por operação aparecem em cada rota abaixo e no inventário JSON.

## Contratos de chamadas de clientes externos mantidos

### connector_spool_inventory_get

- **Rota:** GET `/api/v1/spool`
- **Query:** `{"limit":"configurable 1-200 (SpoolmanConfig.limit)","offset":"non-negative integer, ascending pagination","sort":"id:asc (fixed)","allow_archived":"true (fixed)"}`
- **Cabeçalhos:** `{"accept":"application/json","authorization":"optional bearer/basic from credentials/spoolman.json"}`
- **Resposta:** 200 application/json array of Spool models
- **Fonte:** `packages/connector/src/spoolman/bounded-read.ts`

### connector_provision_probe_get

- **Rota:** GET `/api/v1/spool`
- **Query:** `{"limit":"1"}`
- **Cabeçalhos:** `{"accept":"application/json","authorization":"optional"}`
- **Resposta:** reachable when 200 JSON array; 401/403 => unauthorized
- **Fonte:** `packages/connector/src/provisioning/spoolman.ts`

### connector_root_websocket

- **Rota:** WS `/api/v1/`
- **Cabeçalhos:** `{"authorization":"optional on handshake"}`
- **Mensagens WS:** type added|updated|deleted; resource spool|filament|vendor; date; payload
- **Fonte:** `packages/connector/src/runtime/spoolman-provider.ts`

### kobra_x_spool_use_put

- **Rota:** PUT `/api/v1/spool/{spool_id}/use`
- **Corpo:** `{"use_weight":"positive number (grams)"}`
- **Cabeçalhos:** `{"accept":"application/json","content-type":"application/json"}`
- **Fonte:** `packages/connector/src/kobra-x/booking.ts`

## Eventos WebSocket upstream

- **SpoolEvent:** Documented in models.py; code 299 examples on entity HTTP routes.
- **FilamentEvent:** Documented in models.py; code 299 examples on entity HTTP routes.
- **VendorEvent:** Documented in models.py; code 299 examples on entity HTTP routes.
- **SettingEvent:** Documented in models.py; code 299 examples on entity HTTP routes.
- **TagScanEvent:** Documented in models.py; code 299 examples on entity HTTP routes.

O servidor upstream também emite respostas de atualização 101. As rotas WS, modelos de evento, status e limitações do Connector são discriminados nas seções endpoint por endpoint.

## Erros e guardas documentados

- `{"kind":"ItemNotFoundError","http_status":404,"body":{"message":"string"}}`
- `{"kind":"Backup failure","http_status":500,"body":{"message":"Backup failed. See server logs for more information."}}`
- `{"kind":"Untrusted browser origin (HTTP writes or WS handshake)","websocket_close_code":4403}`
- `{"kind":"Untrusted Host header (WS handshake)","websocket_close_code":4400}`

## Cabeçalhos notáveis

- `{"endpoint":"GET /api/v1/external/filament/search","name":"x-total-count","direction":"response"}`
- `{"endpoint":"GET /api/v1/spool","name":"x-total-count","direction":"response"}`

## Fixtures e proveniência

- `tests/fixtures/spoolman/spools.json` — SHA-256 `ac6584e71b23f0ad93e0c8d770fb48f4a63b09390deb481df871918fa57b69f6`. Synthetic Spoolman shapes for unit tests. Original MIT fixture data; field shapes aligned with packages/connector/src/spoolman/read.ts parsers and pinned upstream v0.27.1 models.py names. Not copied from upstream database dumps.
- `infra/sim/spoolman/seed.json` — SHA-256 `44a863cf491f74989a813141a5031e1e9a5d621609542cf59befa53835410ad9`. Docker sim:seed inventory fixture. Original MIT fixture data; field shapes aligned with packages/connector/src/spoolman/read.ts parsers and pinned upstream v0.27.1 models.py names. Not copied from upstream database dumps.
- `tests/fixtures/spoolman/spool-api/cases.json` — SHA-256 `3d479dfce543250e86d223235047d3d408ca34506ee6952c39a684d10ae3c1f7`. Spool API request corpus for upstream capture and built-in server parity tests (#540). Original MIT test request definitions exercising all 7 Spoolman v0.27.1 HTTP spool endpoints, filters, sorting, pagination, extra fields, archive, use and measure semantics.
- `tests/fixtures/spoolman/spool-api/upstream.json` — SHA-256 `b911b367a139e88049ff393eecaeb63f4416aaa06738eaeb0d0643dfe1a11612`. Recorded upstream Spoolman v0.27.1 HTTP responses for spool API contract replay (#540). Captured directly from local digest-pinned ghcr.io/donkie/spoolman:0.27.1 (revision ff8efd517b76a4b2783f29c89e9b9fbcd8cd167b) with --network none via scripts/capture-spoolman-spool-api.mjs.

## Endpoints detalhados

### WS `/api/v1/`

- **Transporte:** websocket
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `partial`
- **Entrada:** `{"handshake":"HTTP Upgrade; optional authorization as configured by server/source","messages_sent_by_client":"none documented"}`
- **Saída:** `{"handshake":"101 Switching Protocols","event_models":["SpoolEvent","FilamentEvent","VendorEvent"]}`
- **Status:** `[{"code":"101","meaning":"WebSocket upgrade"}]`
- **Erros:** `["Handshake refusal/close codes are source-level behavior, not represented in OpenAPI responses; see documented_errors_and_guards."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Eventos WebSocket:** `["SpoolEvent","FilamentEvent","VendorEvent"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1/websocket-source-inventory","packages/connector/src/runtime/spoolman-provider.ts"]`
- **Lacunas:** `[]`
- **Nota:** External Connector client coverage only (connector_root_websocket); this does not establish built-in replacement-server compatibility. See the request contract and evidence fields.

### GET `/api/v1/article-number`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Find_article_numbers_article_number_get`
- **Entrada:** `{"parameters":[],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<string>"}}`
- **Status:** `[{"code":"200","description":"A list of all article numbers."}]`
- **Erros:** `["No error response documented for this endpoint in pinned OpenAPI/source inventory."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1article-number/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### POST `/api/v1/backup`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `backup_backup_post`
- **Entrada:** `{"parameters":[],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"BackupResponse"},"500":{"application/json":"Message"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"500","description":"Internal Server Error"}]`
- **Erros:** `[{"code":"500","description":"Internal Server Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1backup/post"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/export/filaments`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Export_filaments_export_filaments_get`
- **Entrada:** `{"parameters":[{"in":"query","name":"fmt","required":true,"schema":{"$ref":"#/components/schemas/ExportFormat"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"inline schema"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1export~1filaments/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/export/spools`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Export_spools_export_spools_get`
- **Entrada:** `{"parameters":[{"in":"query","name":"fmt","required":true,"schema":{"$ref":"#/components/schemas/ExportFormat"}},{"in":"query","name":"allow_archived","required":false,"schema":{"default":false,"description":"Whether to include archived spools in the export.","title":"Allow Archived","type":"boolean"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"inline schema"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1export~1spools/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/export/vendors`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Export_vendors_export_vendors_get`
- **Entrada:** `{"parameters":[{"in":"query","name":"fmt","required":true,"schema":{"$ref":"#/components/schemas/ExportFormat"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"inline schema"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1export~1vendors/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/external/filament`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Get_all_external_filaments_external_filament_get`
- **Entrada:** `{"parameters":[],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<ExternalFilament>"}}`
- **Status:** `[{"code":"200","description":"Successful Response"}]`
- **Erros:** `["No error response documented for this endpoint in pinned OpenAPI/source inventory."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1external~1filament/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/external/filament/search`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Search_external_filaments_external_filament_search_get`
- **Entrada:** `{"parameters":[{"in":"query","name":"query","required":true,"schema":{"description":"Search query, matched word-by-word against manufacturer, name and material.","examples":["polymaker pla"],"title":"Query","type":"string"}},{"in":"query","name":"limit","required":false,"schema":{"default":20,"description":"Maximum number of results to return.","maximum":100,"minimum":1,"title":"Limit","type":"integer"}},{"in":"query","name":"offset","required":false,"schema":{"default":0,"description":"Number of matches to skip, for paging through the results.","minimum":0,"title":"Offset","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<ExternalFilament>"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1external~1filament~1search/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/external/material`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Get_all_external_materials_external_material_get`
- **Entrada:** `{"parameters":[],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<ExternalMaterial>"}}`
- **Status:** `[{"code":"200","description":"Successful Response"}]`
- **Erros:** `["No error response documented for this endpoint in pinned OpenAPI/source inventory."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1external~1material/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/field/{entity_type}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Get_extra_fields_field__entity_type__get`
- **Entrada:** `{"parameters":[{"in":"path","name":"entity_type","required":true,"schema":{"$ref":"#/components/schemas/EntityType","description":"Entity type this field is for"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<ExtraField>"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1field~1{entity_type}/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### DELETE `/api/v1/field/{entity_type}/{key}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Delete_extra_field_field__entity_type___key__delete`
- **Entrada:** `{"parameters":[{"in":"path","name":"entity_type","required":true,"schema":{"$ref":"#/components/schemas/EntityType","description":"Entity type this field is for"}},{"in":"path","name":"key","required":true,"schema":{"maxLength":64,"minLength":1,"pattern":"^[a-z0-9_]+$","title":"Key","type":"string"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<ExtraField>"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1field~1{entity_type}~1{key}/delete"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### POST `/api/v1/field/{entity_type}/{key}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Add_or_update_extra_field_field__entity_type___key__post`
- **Entrada:** `{"parameters":[{"in":"path","name":"entity_type","required":true,"schema":{"$ref":"#/components/schemas/EntityType","description":"Entity type this field is for"}},{"in":"path","name":"key","required":true,"schema":{"maxLength":64,"minLength":1,"pattern":"^[a-z0-9_]+$","title":"Key","type":"string"}}],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/ExtraFieldParameters"}}}`
- **Saída:** `{"200":{"application/json":"array<ExtraField>"},"400":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1field~1{entity_type}~1{key}/post"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/field/{entity_type}/{key}/values`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Get_extra_field_values_field__entity_type___key__values_get`
- **Entrada:** `{"parameters":[{"in":"path","name":"entity_type","required":true,"schema":{"$ref":"#/components/schemas/EntityType","description":"Entity type this field is for"}},{"in":"path","name":"key","required":true,"schema":{"maxLength":64,"minLength":1,"pattern":"^[a-z0-9_]+$","title":"Key","type":"string"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<string>"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1field~1{entity_type}~1{key}~1values/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/filament`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Find_filaments_filament_get`
- **Entrada:** `{"parameters":[{"in":"query","name":"vendor_name","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"deprecated":true,"description":"See vendor.name.","title":"Vendor Name"}},{"in":"query","name":"vendor_id","required":false,"schema":{"anyOf":[{"pattern":"^-?\\d+(,-?\\d+)*$","type":"string"},{"type":"null"}],"deprecated":true,"description":"See vendor.id.","title":"Vendor ID"}},{"in":"query","name":"vendor.name","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the filament vendor name. Separate multiple terms with a comma. Specify an empty string to match filaments with no vendor name. Surround a term with quotes to search for the exact term.","title":"Vendor Name"}},{"in":"query","name":"vendor.id","required":false,"schema":{"anyOf":[{"pattern":"^-?\\d+(,-?\\d+)*$","type":"string"},{"type":"null"}],"description":"Match an exact vendor ID. Separate multiple IDs with a comma. Specify -1 to match filaments with no vendor.","examples":["1","1,2"],"title":"Vendor ID"}},{"in":"query","name":"name","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the filament name. Separate multiple terms with a comma. Specify an empty string to match filaments with no name. Surround a term with quotes to search for the exact term.","title":"Filament Name"}},{"in":"query","name":"material","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the filament material. Separate multiple terms with a comma. Specify an empty string to match filaments with no material. Surround a term with quotes to search for the exact term.","title":"Filament Material"}},{"in":"query","name":"article_number","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the filament article number. Separate multiple terms with a comma. Specify an empty string to match filaments with no article number. Surround a term with quotes to search for the exact term.","title":"Filament Article Number"}},{"in":"query","name":"color_hex","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Match filament by similar color.","title":"Filament Color"}},{"in":"query","name":"color_similarity_threshold","required":false,"schema":{"default":20,"description":"The similarity threshold for color matching. A value between 0.0-100.0, where 0 means match only exactly the same color.","examples":[20],"title":"Color Similarity Threshold","type":"number"}},{"in":"query","name":"external_id","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Find filaments imported by the given external ID. Separate multiple IDs with a comma. Specify empty string to match filaments with no external ID. Surround a term with quotes to search for the exact term.","examples":["polymaker_pla_polysonicblack_1000_175"],"title":"External Id"}},{"in":"query","name":"tag","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Match the filament that an NFC/RFID tag with this UID is linked to. Exact match on the normalized UID: separators are ignored and case does not matter. Only a tag linked to the filament itself matches, not a tag on one of its spools; look those up on the spool endpoint. Returns either one filament or none. Returns 400 if the UID is not hexadecimal.","examples":["04A2B3C4D5E6F7","04:a2:b3:c4:d5:e6:f7"],"title":"Tag UID"}},{"in":"query","name":"sort","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Sort the results by the given field. Should be a comma-separate string with \"field:direction\" items.","examples":["vendor.name:asc,spool_weight:desc"],"title":"Sort"}},{"in":"query","name":"limit","required":false,"schema":{"anyOf":[{"type":"integer"},{"type":"null"}],"description":"Maximum number of items in the response.","title":"Limit"}},{"in":"query","name":"offset","required":false,"schema":{"default":0,"description":"Offset in the full result set if a limit is set.","title":"Offset","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<Filament>"},"299":{"application/json":"FilamentEvent"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"299","description":"Websocket message"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1filament/get","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### POST `/api/v1/filament`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Add_filament_filament_post`
- **Entrada:** `{"parameters":[],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/FilamentParameters"}}}`
- **Saída:** `{"200":{"application/json":"Filament"},"400":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1filament/post","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### DELETE `/api/v1/filament/{filament_id}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Delete_filament_filament__filament_id__delete`
- **Entrada:** `{"parameters":[{"in":"path","name":"filament_id","required":true,"schema":{"title":"Filament Id","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"Message"},"403":{"application/json":"Message"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"403","description":"Forbidden"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"403","description":"Forbidden"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1filament~1{filament_id}/delete","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/filament/{filament_id}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Get_filament_filament__filament_id__get`
- **Entrada:** `{"parameters":[{"in":"path","name":"filament_id","required":true,"schema":{"title":"Filament Id","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"Filament"},"299":{"application/json":"FilamentEvent"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"299","description":"Websocket message"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1filament~1{filament_id}/get","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### PATCH `/api/v1/filament/{filament_id}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Update_filament_filament__filament_id__patch`
- **Entrada:** `{"parameters":[{"in":"path","name":"filament_id","required":true,"schema":{"title":"Filament Id","type":"integer"}}],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/FilamentUpdateParameters"}}}`
- **Saída:** `{"200":{"application/json":"Filament"},"400":{"application/json":"Message"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1filament~1{filament_id}/patch","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### WS `/api/v1/filament/{filament_id}`

- **Transporte:** websocket
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **Entrada:** `{"handshake":"HTTP Upgrade; optional authorization as configured by server/source","messages_sent_by_client":"none documented"}`
- **Saída:** `{"handshake":"101 Switching Protocols","event_models":["FilamentEvent"]}`
- **Status:** `[{"code":"101","meaning":"WebSocket upgrade"}]`
- **Erros:** `["Handshake refusal/close codes are source-level behavior, not represented in OpenAPI responses; see documented_errors_and_guards."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Eventos WebSocket:** `["FilamentEvent"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1filament~1{filament_id}/websocket-source-inventory"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### POST `/api/v1/filament/{filament_id}/tag`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Link_a_tag_to_a_filament_filament__filament_id__tag_post`
- **Entrada:** `{"parameters":[{"in":"path","name":"filament_id","required":true,"schema":{"title":"Filament Id","type":"integer"}}],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/TagLinkParameters"}}}`
- **Saída:** `{"201":{"application/json":"Tag"},"400":{"application/json":"Message"},"404":{"application/json":"Message"},"409":{"application/json":"TagConflictMessage"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"201","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"409","description":"Conflict"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"409","description":"Conflict"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1filament~1{filament_id}~1tag/post"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### DELETE `/api/v1/filament/{filament_id}/tag/{uid}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Unlink_a_tag_from_a_filament_filament__filament_id__tag__uid__delete`
- **Entrada:** `{"parameters":[{"in":"path","name":"filament_id","required":true,"schema":{"title":"Filament Id","type":"integer"}},{"in":"path","name":"uid","required":true,"schema":{"description":"The tag's UID, in any shape. Normalized before matching.","examples":["04A2B3C4D5E6F7"],"title":"Tag UID","type":"string"}}],"body_required":false,"body":{}}`
- **Saída:** `{"204":{},"400":{"application/json":"Message"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"204","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1filament~1{filament_id}~1tag~1{uid}/delete"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/health`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `health_health_get`
- **Entrada:** `{"parameters":[],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"HealthCheck"}}`
- **Status:** `[{"code":"200","description":"Successful Response"}]`
- **Erros:** `["No error response documented for this endpoint in pinned OpenAPI/source inventory."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1health/get","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/info`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `info_info_get`
- **Entrada:** `{"parameters":[],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"Info"}}`
- **Status:** `[{"code":"200","description":"Successful Response"}]`
- **Erros:** `["No error response documented for this endpoint in pinned OpenAPI/source inventory."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1info/get","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/location`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Find_locations_location_get`
- **Entrada:** `{"parameters":[],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<string>"}}`
- **Status:** `[{"code":"200","description":"A list of all spool locations."}]`
- **Erros:** `["No error response documented for this endpoint in pinned OpenAPI/source inventory."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1location/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### PATCH `/api/v1/location/{location}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Rename_location_location__location__patch`
- **Entrada:** `{"parameters":[{"in":"path","name":"location","required":true,"schema":{"title":"Location","type":"string"}}],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/RenameLocationBody"}}}`
- **Saída:** `{"200":{"application/json":"RootModel_str_"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1location~1{location}/patch"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/lot-number`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Find_lot_numbers_lot_number_get`
- **Entrada:** `{"parameters":[],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<string>"}}`
- **Status:** `[{"code":"200","description":"A list of all lot numbers."}]`
- **Erros:** `["No error response documented for this endpoint in pinned OpenAPI/source inventory."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1lot-number/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/material`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Find_materials_material_get`
- **Entrada:** `{"parameters":[],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<string>"}}`
- **Status:** `[{"code":"200","description":"A list of all filament materials."}]`
- **Erros:** `["No error response documented for this endpoint in pinned OpenAPI/source inventory."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1material/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/search`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Search_search_get`
- **Entrada:** `{"parameters":[{"in":"query","name":"q","required":true,"schema":{"description":"The search query.","examples":["red"],"minLength":1,"title":"Query","type":"string"}},{"in":"query","name":"color_similarity_threshold","required":false,"schema":{"default":20,"description":"The similarity threshold for color matching, when the query is a color. A value between 0.0-100.0, where 0 means match only exactly the same color.","examples":[20],"maximum":100,"minimum":0,"title":"Color Similarity Threshold","type":"number"}},{"in":"query","name":"limit","required":false,"schema":{"default":20,"description":"Maximum number of results per category (spools, filaments, vendors).","maximum":100,"minimum":1,"title":"Limit","type":"integer"}},{"in":"query","name":"allow_archived","required":false,"schema":{"default":false,"description":"Whether to include archived spools in the results.","title":"Allow Archived","type":"boolean"}},{"in":"query","name":"spools_per_filament","required":false,"schema":{"default":0,"description":"How many of each matching filament's spools to include with it, so a filament hit can be followed straight to one of its spools. 0 (the default) omits them entirely.","maximum":10,"minimum":0,"title":"Spools Per Filament","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"SearchResults"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1search/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/setting/`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Get_all_settings_setting__get`
- **Entrada:** `{"parameters":[],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"object"}}`
- **Status:** `[{"code":"200","description":"Successful Response"}]`
- **Erros:** `["No error response documented for this endpoint in pinned OpenAPI/source inventory."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1setting~1/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/setting/{key}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Get_setting_setting__key__get`
- **Entrada:** `{"parameters":[{"in":"path","name":"key","required":true,"schema":{"title":"Key","type":"string"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"SettingResponse"},"299":{"application/json":"SettingEvent"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"299","description":"Websocket message"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1setting~1{key}/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### POST `/api/v1/setting/{key}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Set_setting_setting__key__post`
- **Entrada:** `{"parameters":[{"in":"path","name":"key","required":true,"schema":{"title":"Key","type":"string"}}],"body_required":true,"body":{"application/json":{"title":"Body","type":"string"}}}`
- **Saída:** `{"200":{"application/json":"SettingResponse"},"404":{"application/json":"Message"},"415":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"404","description":"Not Found"},{"code":"415","description":"Unsupported Media Type"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"404","description":"Not Found"},{"code":"415","description":"Unsupported Media Type"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1setting~1{key}/post"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### WS `/api/v1/setting/{key}`

- **Transporte:** websocket
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **Entrada:** `{"handshake":"HTTP Upgrade; optional authorization as configured by server/source","messages_sent_by_client":"none documented"}`
- **Saída:** `{"handshake":"101 Switching Protocols","event_models":["SettingEvent"]}`
- **Status:** `[{"code":"101","meaning":"WebSocket upgrade"}]`
- **Erros:** `["Handshake refusal/close codes are source-level behavior, not represented in OpenAPI responses; see documented_errors_and_guards."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Eventos WebSocket:** `["SettingEvent"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1setting~1{key}/websocket-source-inventory"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/spool`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `implemented`
- **Cobertura do cliente externo:** `partial`
- **OpenAPI operationId:** `Find_spool_spool_get`
- **Entrada:** `{"parameters":[{"in":"query","name":"filament_name","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"deprecated":true,"description":"See filament.name.","title":"Filament Name"}},{"in":"query","name":"filament_id","required":false,"schema":{"anyOf":[{"pattern":"^-?\\d+(,-?\\d+)*$","type":"string"},{"type":"null"}],"deprecated":true,"description":"See filament.id.","title":"Filament ID"}},{"in":"query","name":"filament_material","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"deprecated":true,"description":"See filament.material.","title":"Filament Material"}},{"in":"query","name":"vendor_name","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"deprecated":true,"description":"See filament.vendor.name.","title":"Vendor Name"}},{"in":"query","name":"vendor_id","required":false,"schema":{"anyOf":[{"pattern":"^-?\\d+(,-?\\d+)*$","type":"string"},{"type":"null"}],"deprecated":true,"description":"See filament.vendor.id.","title":"Vendor ID"}},{"in":"query","name":"filament.name","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the filament name. Separate multiple terms with a comma. Specify an empty string to match spools with no filament name. Surround a term with quotes to search for the exact term.","title":"Filament Name"}},{"in":"query","name":"filament.id","required":false,"schema":{"anyOf":[{"pattern":"^-?\\d+(,-?\\d+)*$","type":"string"},{"type":"null"}],"description":"Match an exact filament ID. Separate multiple IDs with a comma.","examples":["1","1,2"],"title":"Filament ID"}},{"in":"query","name":"filament.material","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the filament material. Separate multiple terms with a comma. Specify an empty string to match spools with no filament material. Surround a term with quotes to search for the exact term.","title":"Filament Material"}},{"in":"query","name":"filament.multi_color_direction","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Match spools by their filament's multi-color direction, e.g. coaxial or longitudinal. Separate multiple terms with a comma. Specify an empty string to match single-color filaments. Surround a term with quotes to search for the exact term.","examples":["\"coaxial\"","\"longitudinal\""],"title":"Filament Multi-Color Direction"}},{"in":"query","name":"filament.vendor.name","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the filament vendor name. Separate multiple terms with a comma. Specify an empty string to match spools with no vendor name. Surround a term with quotes to search for the exact term.","title":"Vendor Name"}},{"in":"query","name":"filament.vendor.id","required":false,"schema":{"anyOf":[{"pattern":"^-?\\d+(,-?\\d+)*$","type":"string"},{"type":"null"}],"description":"Match an exact vendor ID. Separate multiple IDs with a comma. Set it to -1 to match spools with filaments with no vendor.","examples":["1","1,2"],"title":"Vendor ID"}},{"in":"query","name":"location","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the spool location. Separate multiple terms with a comma. Specify an empty string to match spools with no location. Surround a term with quotes to search for the exact term.","title":"Location"}},{"in":"query","name":"lot_nr","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the spool lot number. Separate multiple terms with a comma. Specify an empty string to match spools with no lot nr. Surround a term with quotes to search for the exact term.","title":"Lot/Batch Number"}},{"in":"query","name":"tag","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Match the spool that an NFC/RFID tag with this UID is linked to. Exact match on the normalized UID: separators are ignored and case does not matter, so 04:a2:b3:c4, 04-A2-B3-C4 and 04a2b3c4 all find the same spool. A tag is linked to at most one spool, so this returns either one spool or none. Returns 400 if the UID is not hexadecimal.","examples":["04A2B3C4D5E6F7","04:a2:b3:c4:d5:e6:f7"],"title":"Tag UID"}},{"in":"query","name":"allow_archived","required":false,"schema":{"default":false,"description":"Whether to include archived spools in the search results.","title":"Allow Archived","type":"boolean"}},{"in":"query","name":"first_used","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Filter by the spool's first_used timestamp. Give an inclusive range as `<start>|<end>`(ISO 8601; either end may be omitted to leave it open), a bare timestamp to match it exactly, or an empty string to match spools that have no first_used timestamp at all. Separate multiple of these with a comma to OR them. A timestamp with no UTC offset is interpreted as UTC.","examples":["2024-05-01T00:00:00Z|","|2024-05-01T00:00:00Z","2024-05-01T00:00:00Z|2024-06-01T00:00:00Z",""],"title":"First Used"}},{"in":"query","name":"last_used","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Filter by the spool's last_used timestamp. Give an inclusive range as`<start>|<end>`(ISO 8601; either end may be omitted to leave it open), a bare timestamp to match it exactly, or an empty string to match spools that have no last_used timestamp at all. Separate multiple of these with a comma to OR them. A timestamp with no UTC offset is interpreted as UTC.","examples":["2024-05-01T00:00:00Z|","|2024-05-01T00:00:00Z","2024-05-01T00:00:00Z|2024-06-01T00:00:00Z",""],"title":"Last Used"}},{"in":"query","name":"registered","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Filter by the spool's registered timestamp. Give an inclusive range as`<start>|<end>` (ISO 8601; either end may be omitted to leave it open), a bare timestamp to match it exactly, or an empty string to match spools that have no registered timestamp at all. Separate multiple of these with a comma to OR them. A timestamp with no UTC offset is interpreted as UTC.","examples":["2024-05-01T00:00:00Z|","|2024-05-01T00:00:00Z","2024-05-01T00:00:00Z|2024-06-01T00:00:00Z",""],"title":"Registered"}},{"in":"query","name":"sort","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Sort the results by the given field. Should be a comma-separate string with \"field:direction\" items.","examples":["filament.name:asc,filament.vendor.id:asc,location:desc"],"title":"Sort"}},{"in":"query","name":"limit","required":false,"schema":{"anyOf":[{"type":"integer"},{"type":"null"}],"description":"Maximum number of items in the response.","title":"Limit"}},{"in":"query","name":"offset","required":false,"schema":{"default":0,"description":"Offset in the full result set if a limit is set.","title":"Offset","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<Spool>"},"299":{"application/json":"SpoolEvent"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"299","description":"Websocket message"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["x-total-count"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool/get","packages/connector/src/spoolman/bounded-read.ts","packages/connector/src/spoolman/read.ts","packages/connector/src/runtime/spoolman-provider.ts","apps/farm/server/routes/spoolman/[...path].ts","apps/farm/server/utils/spool-library/legacy-api/spool.ts","scripts/test-spoolman-spool-api.mjs","tests/fixtures/spoolman/spool-api/upstream.json"]`
- **Lacunas:** `[]`
- **Nota:** Implemented on the farm-scoped built-in legacy API (/spoolman/<token>/api/v1/spool) with upstream v0.27.1 filtering (including deprecated aliases, nested filament/vendor/extra filters, datetime ranges, allow_archived), sorting, pagination and x-total-count header; proven by scripts/test-spoolman-spool-api.mjs against captured upstream fixtures and literal client contracts (Moonraker, OctoPrint, Home Assistant, OrcaSlicer, Connector). External Connector client coverage is tracked separately.

### POST `/api/v1/spool`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `implemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Add_spool_spool_post`
- **Entrada:** `{"parameters":[],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/SpoolParameters"}}}`
- **Saída:** `{"200":{"application/json":"Spool"},"400":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool/post","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs","apps/farm/server/routes/spoolman/[...path].ts","apps/farm/server/utils/spool-library/legacy-api/spool.ts","scripts/test-spoolman-spool-api.mjs","tests/fixtures/spoolman/spool-api/upstream.json"]`
- **Lacunas:** `[]`
- **Nota:** Implemented on the farm-scoped built-in legacy API (/spoolman/<token>/api/v1/spool...) with pinned Spoolman v0.27.1 schemas, extra-field validation/merge/clear, archive semantics, cross-farm isolation and error parity; proven by scripts/test-spoolman-spool-api.mjs against captured upstream fixtures.

### PATCH `/api/v1/spool/field/{field}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Rename_a_spool_field_value_spool_field__field__patch`
- **Entrada:** `{"parameters":[{"in":"path","name":"field","required":true,"schema":{"description":"The spool field to rename a value of: location, or extra.<key> for one of the spool's custom text or single-choice fields. Fields belonging to the filament or its vendor (material, vendor) cannot be renamed here.","examples":["location","extra.shelf"],"title":"Field","type":"string"}}],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/RenameFieldValueParameters"}}}`
- **Saída:** `{"200":{"application/json":"RenameFieldValueResult"},"400":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool~1field~1{field}/patch"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/spool/group`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Find_spool_groups_spool_group_get`
- **Entrada:** `{"parameters":[{"in":"query","name":"group_by","required":true,"schema":{"description":"The field to group spools by: filament, vendor, material, location, or extra.<key> for one of the spool's custom fields (text and single-choice fields only).","examples":["location","extra.shelf"],"title":"Group By","type":"string"}},{"in":"query","name":"filament.name","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the filament name. See the spool search endpoint.","title":"Filament Name"}},{"in":"query","name":"filament.id","required":false,"schema":{"anyOf":[{"pattern":"^-?\\d+(,-?\\d+)*$","type":"string"},{"type":"null"}],"description":"Match an exact filament ID. Separate multiple IDs with a comma.","title":"Filament ID"}},{"in":"query","name":"filament.material","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the filament material.","title":"Filament Material"}},{"in":"query","name":"filament.multi_color_direction","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Match by the filament's multi-color direction, e.g. coaxial or longitudinal. Specify an empty string to match single-color filaments.","examples":["\"coaxial\"","\"longitudinal\""],"title":"Filament Multi-Color Direction"}},{"in":"query","name":"filament.vendor.name","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the filament vendor name.","title":"Vendor Name"}},{"in":"query","name":"filament.vendor.id","required":false,"schema":{"anyOf":[{"pattern":"^-?\\d+(,-?\\d+)*$","type":"string"},{"type":"null"}],"description":"Match an exact vendor ID. Separate multiple IDs with a comma. Set it to -1 to match spools with filaments with no vendor.","title":"Vendor ID"}},{"in":"query","name":"location","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the spool location.","title":"Location"}},{"in":"query","name":"lot_nr","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the spool lot number.","title":"Lot/Batch Number"}},{"in":"query","name":"allow_archived","required":false,"schema":{"default":false,"description":"Whether to include archived spools in the aggregates.","title":"Allow Archived","type":"boolean"}},{"in":"query","name":"include_empty","required":false,"schema":{"default":false,"description":"Also return matching filaments (group_by=filament) or manufacturers (group_by=vendor) that hold no matching spools, as groups of zero, instead of omitting them. In vendor mode the group of filaments with no manufacturer is not listed, since this mode lists manufacturers. Every other axis is keyed by a value read off the spools themselves and so has no empty groups to list. Filters on the spools themselves (location, lot_nr, the date filters, spool extra fields) are rejected in combination with it, since a filament with no spools has no value for them.","title":"Include Empty","type":"boolean"}},{"in":"query","name":"preview","required":false,"schema":{"default":false,"description":"Attach a few members to each group: up to 5 spools (id, remaining_weight, initial_weight) for group_by=filament, up to 4 filaments (id and colors) for group_by=vendor. Ignored for other axes.","title":"Preview","type":"boolean"}},{"in":"query","name":"first_used","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Filter by the spool's first_used timestamp. Give an inclusive range as `<start>|<end>`(ISO 8601; either end may be omitted to leave it open), a bare timestamp to match it exactly, or an empty string to match spools that have no first_used timestamp at all. Separate multiple of these with a comma to OR them. A timestamp with no UTC offset is interpreted as UTC.","examples":["2024-05-01T00:00:00Z|","|2024-05-01T00:00:00Z","2024-05-01T00:00:00Z|2024-06-01T00:00:00Z",""],"title":"First Used"}},{"in":"query","name":"last_used","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Filter by the spool's last_used timestamp. Give an inclusive range as`<start>|<end>`(ISO 8601; either end may be omitted to leave it open), a bare timestamp to match it exactly, or an empty string to match spools that have no last_used timestamp at all. Separate multiple of these with a comma to OR them. A timestamp with no UTC offset is interpreted as UTC.","examples":["2024-05-01T00:00:00Z|","|2024-05-01T00:00:00Z","2024-05-01T00:00:00Z|2024-06-01T00:00:00Z",""],"title":"Last Used"}},{"in":"query","name":"registered","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Filter by the spool's registered timestamp. Give an inclusive range as`<start>|<end>` (ISO 8601; either end may be omitted to leave it open), a bare timestamp to match it exactly, or an empty string to match spools that have no registered timestamp at all. Separate multiple of these with a comma to OR them. A timestamp with no UTC offset is interpreted as UTC.","examples":["2024-05-01T00:00:00Z|","|2024-05-01T00:00:00Z","2024-05-01T00:00:00Z|2024-06-01T00:00:00Z",""],"title":"Registered"}},{"in":"query","name":"sort","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Sort the groups by the given field. Comma-separated \"field:direction\" items. Available fields: group.title, group.vendor_name (manufacturer name, groups with no manufacturer last), group.total_remaining, group.last_used, group.spool_count, group.in_use_count, group.filament_count, any filament column as filament.<column> (e.g. filament.material) or manufacturer column as filament.vendor.<column> (e.g. filament.vendor.name), and extra fields as filament.extra.<key> or filament.vendor.extra.<key>. Empty values sort last; unknown fields are ignored.","examples":["group.last_used:desc"],"title":"Sort"}},{"in":"query","name":"limit","required":false,"schema":{"anyOf":[{"type":"integer"},{"type":"null"}],"description":"Maximum number of groups in the response.","title":"Limit"}},{"in":"query","name":"offset","required":false,"schema":{"default":0,"description":"Offset in the full group result set if a limit is set.","title":"Offset","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<SpoolGroup>"},"400":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool~1group/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### DELETE `/api/v1/spool/{spool_id}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `implemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Delete_spool_spool__spool_id__delete`
- **Entrada:** `{"parameters":[{"in":"path","name":"spool_id","required":true,"schema":{"title":"Spool Id","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"Message"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool~1{spool_id}/delete","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs","apps/farm/server/routes/spoolman/[...path].ts","apps/farm/server/utils/spool-library/legacy-api/spool.ts","scripts/test-spoolman-spool-api.mjs","tests/fixtures/spoolman/spool-api/upstream.json"]`
- **Lacunas:** `[]`
- **Nota:** Implemented on the farm-scoped built-in legacy API (/spoolman/<token>/api/v1/spool...) with pinned Spoolman v0.27.1 schemas, extra-field validation/merge/clear, archive semantics, cross-farm isolation and error parity; proven by scripts/test-spoolman-spool-api.mjs against captured upstream fixtures.

### GET `/api/v1/spool/{spool_id}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `implemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Get_spool_spool__spool_id__get`
- **Entrada:** `{"parameters":[{"in":"path","name":"spool_id","required":true,"schema":{"title":"Spool Id","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"Spool"},"299":{"application/json":"SpoolEvent"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"299","description":"Websocket message"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool~1{spool_id}/get","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs","apps/farm/server/routes/spoolman/[...path].ts","apps/farm/server/utils/spool-library/legacy-api/spool.ts","scripts/test-spoolman-spool-api.mjs","tests/fixtures/spoolman/spool-api/upstream.json"]`
- **Lacunas:** `[]`
- **Nota:** Implemented on the farm-scoped built-in legacy API (/spoolman/<token>/api/v1/spool...) with pinned Spoolman v0.27.1 schemas, extra-field validation/merge/clear, archive semantics, cross-farm isolation and error parity; proven by scripts/test-spoolman-spool-api.mjs against captured upstream fixtures.

### PATCH `/api/v1/spool/{spool_id}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `implemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Update_spool_spool__spool_id__patch`
- **Entrada:** `{"parameters":[{"in":"path","name":"spool_id","required":true,"schema":{"title":"Spool Id","type":"integer"}}],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/SpoolUpdateParameters"}}}`
- **Saída:** `{"200":{"application/json":"Spool"},"400":{"application/json":"Message"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool~1{spool_id}/patch","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs","apps/farm/server/routes/spoolman/[...path].ts","apps/farm/server/utils/spool-library/legacy-api/spool.ts","scripts/test-spoolman-spool-api.mjs","tests/fixtures/spoolman/spool-api/upstream.json"]`
- **Lacunas:** `[]`
- **Nota:** Implemented on the farm-scoped built-in legacy API (/spoolman/<token>/api/v1/spool...) with pinned Spoolman v0.27.1 schemas, extra-field validation/merge/clear, archive semantics, cross-farm isolation and error parity; proven by scripts/test-spoolman-spool-api.mjs against captured upstream fixtures.

### WS `/api/v1/spool/{spool_id}`

- **Transporte:** websocket
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **Entrada:** `{"handshake":"HTTP Upgrade; optional authorization as configured by server/source","messages_sent_by_client":"none documented"}`
- **Saída:** `{"handshake":"101 Switching Protocols","event_models":["SpoolEvent"]}`
- **Status:** `[{"code":"101","meaning":"WebSocket upgrade"}]`
- **Erros:** `["Handshake refusal/close codes are source-level behavior, not represented in OpenAPI responses; see documented_errors_and_guards."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Eventos WebSocket:** `["SpoolEvent"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool~1{spool_id}/websocket-source-inventory"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### PUT `/api/v1/spool/{spool_id}/measure`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `implemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Use_spool_filament_based_on_the_current_weight_measurement_spool__spool_id__measure_put`
- **Entrada:** `{"parameters":[{"in":"path","name":"spool_id","required":true,"schema":{"title":"Spool Id","type":"integer"}}],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/SpoolMeasureParameters"}}}`
- **Saída:** `{"200":{"application/json":"Spool"},"400":{"application/json":"Message"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool~1{spool_id}~1measure/put","apps/farm/server/routes/spoolman/[...path].ts","apps/farm/server/utils/spool-library/legacy-api/spool.ts","scripts/test-spoolman-spool-api.mjs","tests/fixtures/spoolman/spool-api/upstream.json"]`
- **Lacunas:** `[]`
- **Nota:** Implemented on the farm-scoped built-in legacy API (/spoolman/<token>/api/v1/spool/{spool_id}/measure) with upstream v0.27.1 gross-weight measurement, initial_weight reset when measured weight exceeds initial gross weight, lower-bound spool-weight clamping, and 400/422 error parity; proven by scripts/test-spoolman-spool-api.mjs against captured upstream fixtures.

### POST `/api/v1/spool/{spool_id}/tag`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Link_a_tag_to_a_spool_spool__spool_id__tag_post`
- **Entrada:** `{"parameters":[{"in":"path","name":"spool_id","required":true,"schema":{"title":"Spool Id","type":"integer"}}],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/TagLinkParameters"}}}`
- **Saída:** `{"201":{"application/json":"Tag"},"400":{"application/json":"Message"},"404":{"application/json":"Message"},"409":{"application/json":"TagConflictMessage"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"201","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"409","description":"Conflict"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"409","description":"Conflict"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool~1{spool_id}~1tag/post"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### DELETE `/api/v1/spool/{spool_id}/tag/{uid}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Unlink_a_tag_from_a_spool_spool__spool_id__tag__uid__delete`
- **Entrada:** `{"parameters":[{"in":"path","name":"spool_id","required":true,"schema":{"title":"Spool Id","type":"integer"}},{"in":"path","name":"uid","required":true,"schema":{"description":"The tag's UID, in any shape. Normalized before matching.","examples":["04A2B3C4D5E6F7"],"title":"Tag UID","type":"string"}}],"body_required":false,"body":{}}`
- **Saída:** `{"204":{},"400":{"application/json":"Message"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"204","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool~1{spool_id}~1tag~1{uid}/delete"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### PUT `/api/v1/spool/{spool_id}/use`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `implemented`
- **Cobertura do cliente externo:** `covered`
- **OpenAPI operationId:** `Use_spool_filament_spool__spool_id__use_put`
- **Entrada:** `{"parameters":[{"in":"path","name":"spool_id","required":true,"schema":{"title":"Spool Id","type":"integer"}}],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/SpoolUseParameters"}}}`
- **Saída:** `{"200":{"application/json":"Spool"},"400":{"application/json":"Message"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1spool~1{spool_id}~1use/put","packages/connector/src/kobra-x/booking.ts","tests/node/e16-368.test.mjs","apps/farm/server/routes/spoolman/[...path].ts","apps/farm/server/utils/spool-library/legacy-api/spool.ts","scripts/test-spoolman-spool-api.mjs","tests/fixtures/spoolman/spool-api/upstream.json"]`
- **Lacunas:** `[]`
- **Nota:** Implemented on the farm-scoped built-in legacy API (/spoolman/<token>/api/v1/spool/{spool_id}/use) with upstream v0.27.1 use_weight/use_length exclusivity, negative clamping to 0, first_used/last_used stamping, and error parity; proven by scripts/test-spoolman-spool-api.mjs against captured upstream fixtures and literal Moonraker/Kobra X contracts. External Connector client coverage is tracked separately.

### GET `/api/v1/tag/reader`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `List_recently_seen_tag_readers_tag_reader_get`
- **Entrada:** `{"parameters":[],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<TagReader>"}}`
- **Status:** `[{"code":"200","description":"Successful Response"}]`
- **Erros:** `["No error response documented for this endpoint in pinned OpenAPI/source inventory."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1tag~1reader/get"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### POST `/api/v1/tag/scan`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Report_a_tag_scan_tag_scan_post`
- **Entrada:** `{"parameters":[],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/TagScanParameters"}}}`
- **Saída:** `{"200":{"application/json":"TagScan"},"299":{"application/json":"TagScanEvent"},"400":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"299","description":"Websocket message"},{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1tag~1scan/post"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### WS `/api/v1/tag/scan`

- **Transporte:** websocket
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **Entrada:** `{"handshake":"HTTP Upgrade; optional authorization as configured by server/source","messages_sent_by_client":"none documented"}`
- **Saída:** `{"handshake":"101 Switching Protocols","event_models":["TagScanEvent"]}`
- **Status:** `[{"code":"101","meaning":"WebSocket upgrade"}]`
- **Erros:** `["Handshake refusal/close codes are source-level behavior, not represented in OpenAPI responses; see documented_errors_and_guards."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Eventos WebSocket:** `["TagScanEvent"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1tag~1scan/websocket-source-inventory"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### WS `/api/v1/tag/scan/{reader_id}`

- **Transporte:** websocket
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **Entrada:** `{"handshake":"HTTP Upgrade; optional authorization as configured by server/source","messages_sent_by_client":"none documented"}`
- **Saída:** `{"handshake":"101 Switching Protocols","event_models":["TagScanEvent"]}`
- **Status:** `[{"code":"101","meaning":"WebSocket upgrade"}]`
- **Erros:** `["Handshake refusal/close codes are source-level behavior, not represented in OpenAPI responses; see documented_errors_and_guards."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Eventos WebSocket:** `["TagScanEvent"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1tag~1scan~1{reader_id}/websocket-source-inventory"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/vendor`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Find_vendor_vendor_get`
- **Entrada:** `{"parameters":[{"in":"query","name":"name","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Partial case-insensitive search term for the vendor name. Separate multiple terms with a comma. Surround a term with quotes to search for the exact term.","title":"Vendor Name"}},{"in":"query","name":"external_id","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Exact match for the vendor external ID. Separate multiple IDs with a comma. Specify empty string to match filaments with no external ID. Surround a term with quotes to search for the exact term.","title":"Vendor External ID"}},{"in":"query","name":"sort","required":false,"schema":{"anyOf":[{"type":"string"},{"type":"null"}],"description":"Sort the results by the given field. Should be a comma-separate string with \"field:direction\" items.","examples":["name:asc,id:desc"],"title":"Sort"}},{"in":"query","name":"limit","required":false,"schema":{"anyOf":[{"type":"integer"},{"type":"null"}],"description":"Maximum number of items in the response.","title":"Limit"}},{"in":"query","name":"offset","required":false,"schema":{"default":0,"description":"Offset in the full result set if a limit is set.","title":"Offset","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"array<Vendor>"},"299":{"application/json":"VendorEvent"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"299","description":"Websocket message"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1vendor/get","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### POST `/api/v1/vendor`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Add_vendor_vendor_post`
- **Entrada:** `{"parameters":[],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/VendorParameters"}}}`
- **Saída:** `{"200":{"application/json":"Vendor"},"400":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1vendor/post","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### DELETE `/api/v1/vendor/{vendor_id}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Delete_vendor_vendor__vendor_id__delete`
- **Entrada:** `{"parameters":[{"in":"path","name":"vendor_id","required":true,"schema":{"title":"Vendor Id","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"Message"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1vendor~1{vendor_id}/delete","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### GET `/api/v1/vendor/{vendor_id}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Get_vendor_vendor__vendor_id__get`
- **Entrada:** `{"parameters":[{"in":"path","name":"vendor_id","required":true,"schema":{"title":"Vendor Id","type":"integer"}}],"body_required":false,"body":{}}`
- **Saída:** `{"200":{"application/json":"Vendor"},"299":{"application/json":"VendorEvent"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"299","description":"Websocket message"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1vendor~1{vendor_id}/get","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### PATCH `/api/v1/vendor/{vendor_id}`

- **Transporte:** http
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **OpenAPI operationId:** `Update_vendor_vendor__vendor_id__patch`
- **Entrada:** `{"parameters":[{"in":"path","name":"vendor_id","required":true,"schema":{"title":"Vendor Id","type":"integer"}}],"body_required":true,"body":{"application/json":{"$ref":"#/components/schemas/VendorUpdateParameters"}}}`
- **Saída:** `{"200":{"application/json":"Vendor"},"400":{"application/json":"Message"},"404":{"application/json":"Message"},"422":{"application/json":"HTTPValidationError"}}`
- **Status:** `[{"code":"200","description":"Successful Response"},{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Erros:** `[{"code":"400","description":"Bad Request"},{"code":"404","description":"Not Found"},{"code":"422","description":"Validation Error"}]`
- **Cabeçalhos relevantes:** `["Content-Type"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1vendor~1{vendor_id}/patch","packages/sim-tools/src/mocks/spoolman-mock.ts","tests/node/e16-353.test.mjs"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

### WS `/api/v1/vendor/{vendor_id}`

- **Transporte:** websocket
- **Compatibilidade do servidor embutido:** `unimplemented`
- **Cobertura do cliente externo:** `not_covered`
- **Entrada:** `{"handshake":"HTTP Upgrade; optional authorization as configured by server/source","messages_sent_by_client":"none documented"}`
- **Saída:** `{"handshake":"101 Switching Protocols","event_models":["VendorEvent"]}`
- **Status:** `[{"code":"101","meaning":"WebSocket upgrade"}]`
- **Erros:** `["Handshake refusal/close codes are source-level behavior, not represented in OpenAPI responses; see documented_errors_and_guards."]`
- **Cabeçalhos relevantes:** `["No endpoint-specific request/response headers documented in pinned OpenAPI/source."]`
- **Eventos WebSocket:** `["VendorEvent"]`
- **Evidências:** `["docs/compatibility/spoolman-openapi-v0.27.1.json#/paths/~1vendor~1{vendor_id}/websocket-source-inventory"]`
- **Lacunas:** `[]`
- **Nota:** No maintained external Connector client call is recorded for this route, and no matching built-in Spoolman replacement-server route was found. The pinned upstream contract is documented above; compatibility remains an explicit gap.

## Limitações gerais

- Search, tag relay, external catalog, settings writes, export, backup and location rename are upstream features without maintained product clients.
- Per-entity websockets and TagScanEvent (resource tag_scan, type scanned) are not handled by the Connector provider.
- Farm UI stores Spoolman origin in Postgres; it does not proxy arbitrary Spoolman REST.
- Simulator mock implements a subset for tests; mock behavior is not claimed as full upstream parity.
- No live Spoolman execution was required for this matrix; disposable API receipts remain in docs/SPOOLMAN-ACTUAL-API-VALIDATION.md.

A matriz não substitui qualificação com serviço real. Evidência offline: `node scripts/check-spoolman-matrix.mjs`. Registros de execução com contêiner descartável, quando existentes, ficam em `docs/SPOOLMAN-ACTUAL-API-VALIDATION.md`.
