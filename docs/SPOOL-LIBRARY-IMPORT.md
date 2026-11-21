# Importing an existing spool library

Part of the built-in spool library (epic #538, issue #544). It moves an existing
Spoolman installation, or a JSON/CSV export, into one farm's library from
[SPOOL-LIBRARY-STORAGE.md](SPOOL-LIBRARY-STORAGE.md). Importing is optional and
never changes how the external Spoolman connector works: the farm's connector
setting (`farm.spoolman_connector_settings`) is not read or written, and the
import database role has no privilege on it.

## Operation

`POST /api/farms/{farmId}/spool-library/import`

- Signed-in **owner or admin** of that farm only (`403` for operators and
  viewers, `404` for anyone who is not a member). Same-origin, `application/json`,
  at most 12 MiB, rate limited per session. The response is a report, never the
  source data.
- Enabled with the `spoolLibraryImport` runtime config: `databaseUrl` must be a
  login that is a member of `farm_spool_import` (migration 0086) and nothing
  else; the server refuses to start the operation otherwise.
  `allowedOrigins` is a comma-separated list of exact Spoolman origins the server
  may read; leave it empty to accept only JSON and CSV uploads.

Request body, one of three formats. Common optional fields:

| Field         | Values                       | Default      | Meaning                                                                                |
| ------------- | ---------------------------- | ------------ | -------------------------------------------------------------------------------------- |
| `source`      | `[a-z0-9][a-z0-9._:-]{0,95}` | per format   | Stable name of the upstream library. Records are identified by `(source, kind, id)`.   |
| `dryRun`      | boolean                      | `false`      | Run everything, report, roll back. Only an audit row remains.                          |
| `onCollision` | `adopt`, `create`            | `adopt`      | An upstream vendor/filament equals an unlinked local one: link it, or add a duplicate. |
| `onConflict`  | `keep-local`, `overwrite`    | `keep-local` | Upstream and local copy both changed since the last import.                            |

```jsonc
// 1. Read a Spoolman through its REST API (GET only)
{ "format": "spoolman-api", "origin": "http://spoolman.lan:7912", "bearerToken": "optional" }

// 2. A JSON document in Spoolman's shapes (the API/export objects)
{ "format": "json", "data": { "vendors": [], "filaments": [], "spools": [], "fields": {}, "settings": {} } }

// 3. One CSV in Spoolman's flattened export layout: vendors, filaments or spools
{ "format": "csv", "entity": "spools", "csv": "id,filament.id,...\n1,5,..." }
```

- **API**: the origin must be an exact entry of `allowedOrigins` (otherwise
  `403`), plain `http(s)` with no credentials, path, query or fragment. The
  server issues only `GET`s (`/info`, `/field/{vendor,filament,spool}`,
  `/setting/`, then `/vendor`, `/filament`, `/spool?allow_archived=true` in pages
  of 200), refuses redirects, and bounds time and size (16 MiB per response). The
  optional token is sent as `Authorization: Bearer` to that origin only; it is
  not stored, logged, put in a URL, an error or the report.
- **JSON**: any of `vendors`, `filaments`, `spools` (arrays), `fields`
  (`{vendor:[...],filament:[...],spool:[...]}` or an array whose items carry
  `entity_type`), `settings` (Spoolman's `{key:{value,is_set,type}}` or a plain
  `{key: value}` map). Vendors and filaments that appear only nested inside
  filaments/spools are derived, so a bare spool export is a complete library.
  Every record needs a positive integer `id`: that is its stable identity.
- **CSV**: header row required, a column named `id` required; dotted headers
  (`filament.vendor.name`, `extra.shelf`) are nested like Spoolman's CSV export.
  `entity` says what a row is. Spreadsheet quoting, a BOM and CRLF are accepted.

## What is imported

| Upstream                                                                                                                        | Farm library                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| vendors, filaments, spools (including archived)                                                                                 | `farm.spool_vendors`, `spool_filaments`, `spools`, with upstream `registered`, `first_used`, `last_used` kept. Local ids are allocated per farm; upstream ids are not reused. |
| extra-field **values**                                                                                                          | the record's `extra` object, as given.                                                                                                                                        |
| extra-field **definitions** (`/field/*`)                                                                                        | `farm.spool_library_fields`, keyed by entity kind and key.                                                                                                                    |
| settings (`/setting/`)                                                                                                          | `farm.spool_library_settings` for settings the owner actually set. `base_url` and `extra_fields_*` describe the old installation and are skipped (listed in the report).      |
| columns the farm schema has no column for (article number, nozzle and bed temperature, multi-colour, vendor empty-spool weight) | kept in `extra` as `o3dfm_upstream_<name>`; a real extra field of that name wins.                                                                                             |

Values longer than the storage limits (names 256, comments 1024, locations 256,
materials 64) are shortened and counted in `truncated`. A reference to a record
that is neither in the payload nor in an earlier import from the same `source`
fails the import (`422`, `unresolved-reference`).

## Idempotency and updates

Every upstream record gets one identity row, `(farm, source, kind, upstream id)`,
linked to exactly one local record. Repeating an import therefore writes nothing
for unchanged records (`unchanged`); a changed upstream record updates its local
record (`updated`); a new one is created (`created`). To repeat an import across
formats (for example an API import, later a JSON dump of the same Spoolman), pass
the same `source`. Without `source` the API default is derived from the origin
(`spoolman-<hash>`), JSON uses `json-default`, CSV `csv-default`.

- **Local edits.** The import remembers the hash of each record as it left it. If
  the local copy was edited and upstream did not change, the edit is kept. If both
  changed, the record is a **conflict**: with `keep-local` (default) it is left
  alone and reported again on every repeat until resolved; with `overwrite` the
  upstream values win.
- **Collisions.** A new upstream vendor (same name, case-insensitive) or filament
  (same vendor, name, material, colour, density, diameter) that equals an unlinked
  local record is **adopted**: linked without rewriting it. `create` adds a
  duplicate instead. Spools have no natural key and are never merged.
- **Removal.** The import never deletes. A record removed upstream stays. A record
  deleted locally loses its identity and is created again by the next import.
- **Fields and settings** from the same source update; ones from another source or
  created locally are conflicts handled like records.

## Failure behavior

- One import is one transaction per farm and source, serialised by an advisory
  lock, so two identical imports at once create each record once. Any failure,
  including a database error halfway, rolls back **every** write of the run. Only
  an audit row (`farm.spool_import_runs`: counts, status, fixed error code, actor,
  time; no payload, origin or token) is kept, in a second transaction.
- Source failures (unreachable, refused credentials, redirect, not JSON, too
  large, second page failing) are reported before the transaction starts and
  change nothing: `502`/`413`, `source-unavailable|unauthorized|invalid|too-large`.
- Invalid data returns `422` with up to 20 `{path, problem}` entries and never
  echoes the offending values. Authorization failures leave no trace at all.
- A session that is revoked or expires while the import runs commits nothing.

## Isolation and secrets

Every table is keyed by `farm_id` with composite foreign keys, so an identity,
field or setting can never point at another farm's record, even through raw SQL.
The `farm_spool_import` role is separate from `farm_spool_library`, can insert and
update only the library and import columns, cannot delete or re-home any row, and
cannot read connector tables. `validateSpoolImportRole` rejects a login that holds
anything more. The Spoolman token is never persisted, never in a SQL statement and
never in a result or log line.

## Evidence

```
node scripts/test-spool-library-import.mjs
```

Two task-owned containers, both from images already present locally (nothing is
pulled), both on loopback ports with a read-only root and no capabilities: the
digest-pinned `postgres:17` (statement logging on) and a **mock Spoolman**
(`tests/helpers/spoolman-import-mock-server.mjs`, run by the local `node:24`
image) that serves Spoolman 0.27.1-shaped data and can inject failures. The
importer runs in the script process. It proves: the migration round trip; who may
import; API import of 2 vendors, 3 filaments, 450 spools (three pages) with
fields, settings and extra; the exact repeat writing nothing; upstream updates,
additions and removals; local edits, conflicts and `overwrite`; recreation after a
local delete; collisions with `adopt` and `create`; separate farms and database
backstops; the external connector row unchanged; rollback of a run that fails
halfway (two different database error classes) and recovery; unresolved
references and invalid data; source failures (500 on a later page, redirect, HTML,
oversized, wrong token); dry run; concurrent identical imports; JSON (nested,
partial, repeat) and CSV (quotes, BOM, extras, repeat, rejections); and that the
upstream token appears nowhere in results, stored rows or the PostgreSQL log.

Containers are labelled `o3dfm.task=spool-import-544`, removed on exit and the
removal is verified. The ledger and, on failure, diagnostics (credentials masked)
go outside the repository: set `SPOOL_IMPORT_EVIDENCE_DIR`.
