# Farm-scoped spool library storage

Foundation for the built-in Spoolman-compatible spool library (epic #538,
issue #541). It adds PostgreSQL storage that is isolated per farm, a reusable
scoped interface for the API units that follow, and a per-farm credential for
existing Spoolman clients that cannot authenticate. The external Spoolman
connector is unchanged and keeps working; this storage is additive.

`GET /spoolman/<token>/api/v1/health` is served when the library is enabled.
The body is the pinned Spoolman v0.27.1 `HealthCheck`, `{"status":"healthy"}`.
Other paths on that mount use the same credential and `withScope` context.
Further endpoints and migration of existing data belong to later units.

## Storage (migration `0085_spool_library_storage`)

| Table                            | Purpose                                                          |
| -------------------------------- | ---------------------------------------------------------------- |
| `farm.spool_vendors`             | Vendors, key `(farm_id, id)`.                                    |
| `farm.spool_filaments`           | Filaments; `(farm_id, vendor_id)` references the vendors table.  |
| `farm.spools`                    | Spools; `(farm_id, filament_id)` references the filaments table. |
| `farm.spool_library_counters`    | Per-farm id allocator, so every farm has its own `1, 2, 3, ...`. |
| `farm.spool_library_credentials` | Legacy-client credentials (SHA-256 of the secret only).          |

Isolation does not rest on application code alone:

- Every row carries `farm_id`, and every reference is a composite
  `(farm_id, id)` foreign key. A spool cannot point at another farm's filament,
  and a filament cannot point at another farm's vendor, even through raw SQL.
- The runtime database role `farm_spool_library` is least-privilege: it reads
  members and sessions, writes the spool tables (column-level `UPDATE`, so a row can never be moved to
  another farm or renumbered), inserts credentials and may update only
  `last_used_at` and `revoked_at` on them. It cannot change a
  credential's secret hash or delete credentials, and it has no access to
  connector or other farm tables. `validateSpoolLibraryRole` refuses a
  connection whose role holds anything more. Give the farm server a login role
  that is a member of `farm_spool_library` and nothing else.
- Savepoints isolate each repository call, so a rejected write never leaves a
  half-written row or poisons the surrounding transaction.

## Scoped interface

`apps/farm/server/utils/spool-library/scope.ts` defines the contract and
`apps/farm/server/storage/postgres-spool-library.ts` implements it.

```ts
const library = new PostgresSpoolLibrary(sql)

// A signed-in member (viewer reads, operator writes, owner/admin manage):
await library.withScope(
  { kind: 'session', sessionRecordId, policy, farmId },
  (repository) => repository.spools.get(1),
)

// A legacy client holding a credential token. There is no farm argument:
// the credential decides the farm.
await library.withScope({ kind: 'legacy-credential', token }, (repository) =>
  repository.spools.use(1, 12.5),
)
```

Rules for API units:

- Get a repository only through `withScope`. A repository has no farm
  parameter on any method; it is fixed from the resolved authority.
- Results are `{ ok: true, value }` or `{ ok: false, reason }` with a fixed
  reason (`unauthorized`, `forbidden`, `denied`, `not-found`, `conflict`,
  `invalid-input`, `limit`, `storage-unavailable`). Reasons never carry driver
  text, tokens or hashes.
- A record from another farm is indistinguishable from a missing one
  (`not-found`); a foreign reference on write is `conflict`.
- A `read` scope (viewer, read-only credential) resolves every mutation to
  `denied`.
- Run each request in one `withScope` call. It is one transaction: if the work
  returns a failure, or the session expires before it finishes, everything it
  wrote is rolled back.

## Farm server

The route stays off until the process has a login that is a member of
`farm_spool_library` and nothing else:

```
NUXT_SPOOL_LIBRARY_ENABLED=true
NUXT_SPOOL_LIBRARY_DATABASE_URL=postgres://...
```

That setting does not change printer configuration.

## Legacy clients (Moonraker and similar)

Moonraker's `[spoolman]` section accepts a server URL with a path and sends no
authentication. An owner or admin issues a credential for the farm, and the
client's server URL carries it:

```
https://<farm host>/spoolman/<token>
```

The client appends its usual `/api/v1/...` paths. `splitLegacyPath` separates
the token from the API path; the token resolves to exactly one farm.

Credential properties:

- Format `sl1.<32 hex credential id>.<43 base64url secret>`: 256 random bits.
  The token is shown once at creation. Only the SHA-256 of the secret is
  stored, compared in constant time, and an unknown id costs the same as a
  wrong secret.
- Bound to one farm and one access level: `read` or `write`. It cannot manage
  credentials and cannot reach another farm: an id from another farm is
  `not-found`, and no input names a different farm.
- At most 16 active credentials per farm. Revocation takes effect on the next
  request. Issue one credential per client so one can be revoked alone.
- Malformed, unknown, wrong-secret and revoked tokens all return the same
  `unauthorized`.

### Spoolman vendor and filament API (migration `0087_spoolman_vendor_filament`)

The legacy path serves the pinned Spoolman v0.27.1 vendor and filament
endpoints for the credential's farm:

| Path                             | Methods                    |
| -------------------------------- | -------------------------- |
| `/api/v1/vendor`                 | `GET` (find), `POST` (add) |
| `/api/v1/vendor/{vendor_id}`     | `GET`, `PATCH`, `DELETE`   |
| `/api/v1/filament`               | `GET` (find), `POST` (add) |
| `/api/v1/filament/{filament_id}` | `GET`, `PATCH`, `DELETE`   |

They follow upstream's source: the same fields (null fields omitted, `extra`
always present, filament `vendor` nested and `tags` listed), pydantic
validation answered as FastAPI `422 {"detail": [...]}`, `400`/`404`/`403`
`{"message": ...}` errors with upstream's text, `405` for other methods,
string filters (partial and case-insensitive, `"quoted"` exact, empty for
unset, comma for alternatives), `vendor.id`/`vendor_id` (`-1` for none),
`vendor.name`, colour similarity, `extra.<key>` filters and `extra.<key>`
sorting for registered extra fields, `sort=field:asc|desc` with nested
`vendor.<field>` and NULLs last, `limit`/`offset` and `x-total-count`.
Extra values are validated against the farm's extra-field registry
(`farm.spool_library_fields`); an update merges extra values per key and a
`null` value clears one. Deleting a vendor clears it from its filaments;
deleting a filament a spool still uses answers upstream's `403`. A read
credential gets `403` for every mutation, before validation.

Recorded upstream answers live in
`tests/fixtures/spoolman/vendor-filament/`: `cases.json` lists the requests,
and `node scripts/capture-spoolman-vendor-filament.mjs` replays them against
the local `ghcr.io/donkie/spoolman:0.27.1` image (no network, fresh database,
container removed on exit) to write `upstream.json`.

Deliberate differences: non-finite numbers (`"inf"`, `"nan"`) are rejected
with `422 finite_number` instead of being stored; a malformed `color_hex`
filter answers `500` as upstream does but without a stack trace; a find scans
at most 20 000 records per kind and farm; the JSON-decode `422` cannot repeat
Python's parser position and message. NFC/RFID tag linking
(`POST /filament/{id}/tag`, `DELETE /filament/{id}/tag/{uid}`) belongs to the
tag module: until it exists no tag is linked, so `tags` is empty, a valid
`tag=` filter matches nothing and an invalid one answers upstream's `400`.

Endpoints are modules (`legacy-api/types.ts`, `LegacyApiModule`): the shared
dispatcher authenticates the credential, opens one farm-bound transaction and
offers the request to each module in `LEGACY_API_MODULES`. A module returns a
response, a repository failure (which rolls the transaction back), or
`undefined` for paths it does not own. Field, setting, tag, grouping and other
auxiliary endpoints are added as further modules.

### Spoolman spool API (migration `0088_spoolman_spool_api`)

The legacy path serves the pinned Spoolman v0.27.1 spool endpoints for the
credential's farm (`apps/farm/server/utils/spool-library/legacy-api/spool.ts`):

| Path                             | Methods                    |
| -------------------------------- | -------------------------- |
| `/api/v1/spool`                  | `GET` (find), `POST` (add) |
| `/api/v1/spool/{spool_id}`       | `GET`, `PATCH`, `DELETE`   |
| `/api/v1/spool/{spool_id}/use`     | `PUT`                      |
| `/api/v1/spool/{spool_id}/measure` | `PUT`                      |

They follow upstream v0.27.1 semantics: nested `filament` (with nested `vendor`)
and derived `remaining_weight`, `used_length`, `remaining_length`, `tags` list,
`extra` field validation/merge/clear against `farm.spool_library_fields`
(migration `0088_spoolman_spool_api` widens `spools_extra_check` to 9 MiB to
match upstream `max_length` sizing), `allow_archived` default `false`, deprecated
and nested filters (`filament.*`, `filament.vendor.*`, `extra.<key>`,
`filament.extra.<key>`, `filament.vendor.extra.<key>`), ISO 8601 `first_used`,
`last_used`, and `registered` range/exact/empty filters, multi-field sorting with
NULLs last, `limit`/`offset` with `x-total-count`, `use` (`use_weight` or
`use_length`, mutually exclusive, negative consumption clamped to `0`,
`first_used`/`last_used` stamped), and `measure` (gross-weight consumption,
`initial_weight` reset when gross weight exceeds initial gross weight, and
lower-bound spool-weight clamping). Sibling endpoints (`/spool/group`,
`/spool/field/{field}`, `/spool/{id}/tag*`, `WS /spool/{id}`) are left unclaimed.

Recorded upstream answers live in `tests/fixtures/spoolman/spool-api/`:
`cases.json` defines the request corpus and
`node scripts/capture-spoolman-spool-api.mjs` replays it against the local
digest-pinned `ghcr.io/donkie/spoolman:0.27.1` image (no network, fresh database,
container removed on exit) to produce `upstream.json`.

### Owner-applied Moonraker configuration

Printers and their configuration are not changed by OpenFarm. The farm owner
edits `moonraker.conf` on each printer host by hand, then restarts Moonraker
themselves:

```ini
[spoolman]
server: https://<farm host>/spoolman/<token>
sync_rate: 5
```

Leave the rest of the printer configuration as it is. To stop a client,
revoke its credential; to rotate, issue a new one, update `server:` and revoke
the old one.

Treat the token like a password:

- Serve it over HTTPS only. The token is in the URL path, so the farm reverse
  proxy and any access log in front of it must not record request paths, or
  must mask the `/spoolman/<token>` segment.
- Moonraker itself logs the Spoolman WebSocket URL at startup. The token
  therefore appears in that printer host's `moonraker.log`; keep that log and
  any bundle made from it private and rotate the credential if it was shared.
- OpenFarm's storage layer never logs tokens, and a credential is never
  returned after creation (listings show label, access and timestamps only).

## Evidence

```
node scripts/test-spool-library-storage.mjs
node scripts/test-spool-library-legacy-access.mjs
node scripts/test-spoolman-vendor-filament.mjs
node scripts/test-spoolman-spool-api.mjs
```

`test-spoolman-spool-api.mjs` applies the migrations through `0088`, serves the
legacy dispatcher over loopback HTTP, replays every recorded upstream v0.27.1
spool fixture on one farm (status, body, key order and `x-total-count`), replays
literal Moonraker/OctoPrint/Home Assistant/OrcaSlicer/Connector/Kobra X client
contracts, verifies cross-farm isolation across all 7 spool endpoints, checks
read-only `403` and invalid/forged/revoked `401` handling, confirms
`/api/v1/spool/group` remains unclaimed, and proves no credential reaches app
output or the PostgreSQL statement log. Its container is labelled
`o3dfm.task=spoolman-spool-api-540`; set `SPOOL_API_EVIDENCE_DIR` for its
ledger.

`test-spoolman-vendor-filament.mjs` applies the migrations through `0087`,
replays every recorded upstream answer on one farm (status, body, key order and
`x-total-count`), then proves the other farm sees and changes nothing of it,
read credentials cannot mutate, invalid, forged and revoked credentials get
`401`, extra modules plug into the dispatcher, and no credential reaches the
application output or the PostgreSQL statement log. Its container is labelled
`o3dfm.task=spoolman-vendor-filament-547`; set
`SPOOL_VENDOR_FILAMENT_EVIDENCE_DIR` for its ledger.

The script starts one PostgreSQL 17 container from the already-present,
digest-pinned `postgres:17` image (nothing is pulled), on a loopback port with a
read-only root and tmpfs data, applies the migrations through `0085`, and runs
the checks below against a least-privilege runtime role. It starts no other
server and touches no printer.

It proves: the migration round trip; separate farms with their own ids;
member-role limits; credential management limited to owners/admins of that farm;
unauthenticated legacy access scoped to its farm; rejection of forged,
cross-farm, wrong-secret, revoked and malformed credentials; foreign references
rejected by both the store and the database; read-only credentials; unique ids
under concurrency; bounded credential count; and that no secret appears in
results, stored rows or the PostgreSQL statement log (statement logging is on).

The container is labelled `o3dfm.task=farm-storage-541`, removed on exit, and
removal is verified. The ledger and, on failure, the retained diagnostics
(error, Docker stderr and stdout, the CLI signal when the command was killed,
and the container log with credentials masked) are written
outside the repository: set `SPOOL_LIBRARY_EVIDENCE_DIR`, or a temporary
directory is used and printed. The legacy-access script uses
`SPOOL_LEGACY_EVIDENCE_DIR` and the label `o3dfm.task=farm-legacy-541`.

## Not in this unit

Spoolman routes other than health, vendor, filament and the 7 HTTP spool
endpoints (such as `/spool/group`, `/spool/field/{field}`, tags, settings,
search, export, backup, external catalog), WebSocket, importing from an
external Spoolman, web pages and the owner UI for issuing credentials.
