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
```

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

Spoolman routes other than `GET /api/v1/health`, WebSocket, importing from an
external Spoolman, web pages and the owner UI for issuing credentials.
