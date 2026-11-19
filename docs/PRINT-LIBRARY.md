# Print library: storage, retention and replay rules

Status: rule set for [E17.1, #373](https://github.com/bloodf/Open3DFarmManager/issues/373). Nothing in this document is implemented on this branch. Values marked **proposed** are conservative starting values chosen for this rule set; the implementing issue may change them only by amending this file.

Scope boundary: [E7, #204](https://github.com/bloodf/Open3DFarmManager/issues/204) excludes server-side print file storage. A library and replay need stored files, so this document is the only place that permits them, and only under the two modes below. The integration API keeps its existing rule: the Connector fetches a job file from an HTTPS `fileUrl`, and the server does not host it (see [INTEGRATION-API.md](INTEGRATION-API.md)).

## Terms

- **Library**: the files a farm keeps for re-printing. A library belongs to one farm.
- **Print file**: a named file (for example a `.gcode` or `.3mf`) with one or more immutable **versions**.
- **Version**: one stored byte sequence of a print file, identified by its lowercase SHA-256 digest and its exact size.
- **Blob**: the stored bytes for one digest within one farm.
- **Thumbnail**: a small preview image stored with the version's metadata.

## Storage modes

Each library uses exactly one mode. The mode is selected by one of:

- a farm-wide default set by an `owner` or `admin` of the farm; or
- an override on one library, set by an `owner` or `admin` when the library is created or while it has no live versions.

Valid modes are `server` and `connector`. No other value is accepted; an unknown value is refused. The mode of a library with live versions changes only through the switching procedure below.

| What                               | `server` mode                                                   | `connector` mode                                |
| ---------------------------------- | --------------------------------------------------------------- | ----------------------------------------------- |
| Print file bytes                   | Server, `OPENFARM_LIBRARY_DIR` on local disk                    | Connector host, configured library directory    |
| Metadata (names, versions, hashes) | PostgreSQL                                                      | PostgreSQL                                      |
| Thumbnails                         | Server                                                          | Server                                          |
| Quota and retention enforced by    | Server                                                          | Connector (same defaults, locally configurable) |
| Who fetches bytes                  | Connector, by hash, over its authenticated HTTPS credential     | Nobody remote; the Connector reads its own copy |
| Replay starts from                 | Connector cache filled from the server, after hash verification | Connector's own copy, after hash verification   |
| Works when the server cannot store | No                                                              | Yes                                             |

### Server mode

- Files are stored in a content-addressed store on local disk under `OPENFARM_LIBRARY_DIR`. The path is `<OPENFARM_LIBRARY_DIR>/<farmId>/<sha256>`, with the file named by its lowercase SHA-256 digest and no extension.
- Writes go to a temporary file in the same directory, are hashed while written, are flushed, and only then renamed to the final name. A rename onto an existing name is not an error: the temporary file is discarded and the existing blob is used, after its size is checked. A temporary file found at startup is removed by the server.
- Upload is rejected unless the streamed digest and byte count match the declared `sha256` and `sizeBytes`. A mismatch leaves no blob and no metadata row.
- **Per-farm dedupe**: a digest is stored once per farm. The same bytes uploaded by two farms create two blobs, so one farm cannot learn from the server whether another farm holds a given file.
- **Connector fetch**: the Connector requests a blob by farm and digest over its authenticated HTTPS credential. It verifies the SHA-256 and size of the received bytes before use; a mismatch is discarded and reported as `checksum-mismatch`, and nothing is cached.
- **Connector cache**: the Connector keeps fetched blobs in a bounded least-recently-used cache. The default limit is **2 GiB** (proposed) and it is configurable. Cache files use the same temporary-then-rename write. The cache is disposable: deleting it only costs a re-fetch. A blob larger than the whole cache is verified and used once, not cached.
- Replay re-verifies the cached or fetched bytes against the digest before the start command is sent.

### Connector mode

- Files live on the Connector host in its configured library directory, using the same `<farmId>/<sha256>` layout and the same temporary-then-rename write as server mode.
- The server keeps only metadata, thumbnails and hashes. It never receives the bytes.
- The web lists files from server metadata and fetches file bytes through the Connector, not from the server.
- Replay starts from the Connector's copy. The Connector re-hashes the file immediately before the start command. If the copy is missing or does not match, the start is refused (`not-ready`); the server is never used as a fallback.
- Quota and retention are enforced by the Connector. The server may show the Connector's reported usage but does not decide it.

## Versioning

- Each print file has version numbers starting at 1 and increasing by one. A version is immutable: its digest, size and metadata never change.
- Uploading bytes identical to the latest live version of the same print file creates no new version and returns the existing one.
- Replay names a version by its ID and digest. A file name alone never selects bytes.

## Quota and retention

Defaults are **proposed** and apply to both modes unless the Connector configures otherwise:

- Maximum file size: **256 MiB** per version.
- Farm quota: **20 GiB** of unique blob bytes per farm, counting live and soft-deleted versions until they are purged. An upload that would exceed the quota is refused with `quota-exceeded` before any bytes are written.
- Version retention: at most **10 live versions** per print file. An upload beyond that marks the oldest live version deleted.
- Soft delete: a delete (explicit or from retention) sets `deleted_at`. A soft-deleted version is hidden from listings and cannot be replayed.
- Purge: **30 days** after soft delete (proposed), the metadata row is removed and the blob is removed when no live or pending version references its digest. Purge never runs on a version that is the target of a queued or running replay.

## Compatibility levels

Each version records compatibility checks against the target printer's known state. Levels:

- **block**: the start is refused. Used for a bed-size or axis-bounds violation from the file's declared bounding box, and for a tool count that exceeds the printer's tool count.
- **warn**: the operator must acknowledge the warning in the start command. Used for a nozzle-diameter mismatch, a filament-type mismatch and a printer-model mismatch declared in the file.
- **info**: shown only. Used for everything else the file declares.

Enforcement: the Connector always enforces `block` itself, because it holds the printer's live state. It enforces the presence of an operator acknowledgement for `warn` in the signed start command. It does not enforce `info`. The server may display all three levels but cannot clear a `block` result.

## Replay checks

A library start is refused unless every check below passes, in this order. Checks 8 and 9 are the signature, freshness, replay and rate-limit checks defined for every signed command in [COMMAND-SECURITY.md](COMMAND-SECURITY.md); the others are specific to library starts.

1. Caller role is `operator` or higher in the farm, and not `viewer` (see the `start_library_print` rule in COMMAND-SECURITY.md).
2. The printer is assigned to the farm and bound to the Connector.
3. The version exists, is live and is not purged.
4. The storage mode is the one the Connector currently serves for this library; the server and Connector agree on the version.
5. The bytes match the version's SHA-256 and size. Server mode verifies the cache or fetched copy; Connector mode re-hashes its copy.
6. Compatibility `block` results are clear; each `warn` result has an acknowledgement in the command.
7. The printer is idle: not printing, not paused, not in an error or fault state, and the bed-clear state reported by the printer is satisfied.
8. Signature, freshness and replay claim pass, as for every signed command.
9. Rate limit (ten commands per minute per printer, shared with other start commands).

A start is sent once. An uncertain outcome is reported as `outcome-unknown` and is never retried automatically.

## Mode switching

- Switching is an explicit action by an `owner` or `admin`. It is refused while an upload, replay or purge is running for that library.
- Switching never changes version IDs, digests or sizes.
- **server → connector**: the Connector fetches each live version by digest, verifies it, and stores it in its library directory. Only after verification does the metadata record the Connector copy. The server blob is purged on the normal schedule, not immediately.
- **connector → server**: the Connector sends each live version; the server verifies the digest while writing and records it. The Connector copy is kept until an owner confirms its removal.
- The switch reports, per version: `migrated`, `already-present`, `failed` (with the verification reason) or `pending` (Connector offline). A version that is not migrated keeps its old-mode copy, and the library stays in its old mode for that version. Reads and replay of the old-mode copy remain available during the switch.
- A switch never silently drops a version. A library with any `failed` or `pending` version reports a partial state until the owner retries or removes that version.

## Tests

Tests for these rules use only in-process mocks from `packages/sim-tools/src/mocks` (the E16 harness, [#351](https://github.com/bloodf/Open3DFarmManager/issues/351)): the HTTP mock for the Connector fetch, the network guard and fault injection for interrupted writes and checksum mismatches. Servers bind to `127.0.0.1` on port `0`. No Docker, no network, and no physical printer is used. Printer state is supplied by the Moonraker or Kobra-X mock.

## Farm manager decisions

These decisions apply where the rules above leave a choice open. Where they differ, they describe the farm manager as built.

- **Default mode**: a farm with no stored setting uses `connector` mode.
- **One setting per farm**: each farm has one storage mode, read and changed only by an `owner` or `admin` of that farm (`GET`/`PUT /settings` below).
- **A switch applies to future uploads**: changing the mode never copies or deletes files by itself. Existing versions keep their recorded location until a migration moves them (see "Migration over the Connector session"). The UI and API report where each version actually is, including the Connector identity for Connector copies.

### Connector host store

The host store (`packages/connector/src/runtime/library-store.ts`) keeps files at
`<directory>/<sha256>`, writes through a temp file and rename, keeps one copy per
hash, applies the quota and retention rules of server mode (oldest unpinned
versions are evicted; the removal is reported) and reports quota and usage with
the `library.storage.report` frame. File listings carry metadata, thumbnail and
hash only (`packages/farm-protocol/src/library-storage.ts`). Errors for a full
disk, a missing file and a hash mismatch are distinct and shown in pt-BR.

`packages/connector/src/library/store.ts` (`ConnectorLibraryStore`) is the
published in-memory store contract with the same content-addressed, quota and
hash-verification rules; the host store above adds the persistent index, the
streaming upload path and the protocol reports that Connector mode needs.

### Print file metadata

G-code metadata is read by `packages/shared/src/print-file/gcode-meta.ts`
(`readGcodeMetadata`, first and last 256 KiB only, `schema.ts` shape). The
library stores a flat shape (`print-file/metadata.ts`); `fromGcodeMetadata`
maps the parser result onto it for uploads, 3MF plate G-code and replay
compatibility checks.

### Migration over the Connector session

Switching mode alone never copies or deletes files. A migration, in either
direction, runs on the Connector over the existing session
(`packages/connector/src/runtime/library-migration.ts`): one transfer per hash,
bytes verified against SHA-256 before they are stored or sent, and a per-version
result (`moved`, `already-there` or `stays` with a reason: purged, disk full,
quota, hash mismatch, not found, unconfirmed transfer, refused). A version that
stays keeps its recorded location, and a transfer that ends without
confirmation is never retried automatically (the source copy is kept). Show each
version's storage mode and, for Connector storage, its Connector identity.
Replay always retrieves the exact
selected version by hash, verifies it, and runs compatibility checks before
starting. A blocked version cannot be replayed.

### Session API

Routes live under `/api/farms/{farmId}/library`. Viewers read; operators and
above upload; owners and admins delete and change settings. A farm the caller
does not belong to answers 404 on reads and 403 on writes.

- `POST /` uploads a raw `application/octet-stream` body (`.gcode` or `.3mf`,
  at most 512 MiB) with `name`, optional `title`, `itemId` (adds a version),
  repeated `tag`, `notes` and, in Connector mode, `agentId`. Server mode stores
  the file under `OPENFARM_LIBRARY_DIR`; Connector mode relays it to the
  Connector and keeps no bytes on the server.
- `GET /` lists items newest first. Filters `title`, `tag`, `printerModel`,
  `nozzle`, `material` and `slicer` combine; `limit` (max 100) and `cursor`
  page without skipping or repeating items when new ones arrive.
- `GET /versions/{id}`, `GET /versions/{id}/thumbnail` (immutable cache
  headers, `ETag` is the file hash), `DELETE /versions/{id}` (soft delete),
  `GET /items/{id}/versions`.
- `GET`/`PUT /settings` read and change `storageMode`, `quotaBytes` and
  `retentionDays`. Both answers include `locations`: how many files and bytes
  stay on the server and on each Connector. Nothing is migrated.

Connector mode goes through the Connector relay. The server cannot dial a
Connector, so the Connector asks: it long-polls
`POST /api/connector/library/relay/poll` with the same credential headers
telemetry and library downloads use (`authorization`, `x-connector-agent`,
`x-connector-farm`), is handed one operation (`put`, `read`, `discard`, `purge`
or `sweep`; schemas in `packages/farm-protocol/src/library-relay.ts`) and runs
it on its own store. An upload's bytes are pulled once through
`GET .../relay/{op}/body` (capped at the operation's size limit) straight from
the browser upload into the Connector store; ranges for parsing come back in the
body of `POST .../relay/{op}/result`. The server keeps no file bytes and no
Connector connection: the hub (`utils/library/connector-relay.ts`, started by
the `library-relay-lifecycle` plugin) holds operations in memory only, so a
server restart fails the ones in flight. `libraryRuntime()` always carries the
relay; an upload answers 503 while the target Connector is not polling, and 507
when the Connector reports its quota or disk full. List, search and get never
need the Connector. Retention reaches the Connector copy through the same hub
(`purge` and `sweep`).

The Connector builds its store from the optional `library` section of its
runtime configuration (`directory`, `quotaBytes`, `retentionDays`,
`keepVersions`, `cacheMaxBytes`; default directory `<data dir>/library`) in
`createConnectorLibrary`, and the agent serves the relay while it runs. Moving
files from the Connector back to the server still needs a server-side receiver;
until it exists those versions report that they stay.

### Quota and retention job

The default quota is 20 GiB per farm; `OPENFARM_LIBRARY_QUOTA_BYTES` changes the
default for farms with no stored setting. An upload that does not fit is refused
before any file is accepted, with an accessible pt-BR message. Server mode counts
the unpurged files on the server disk. Connector mode checks the quota the
Connector host reports for its own library directory (`farm.library_connector_storage`);
the Connector enforces it too. The Connector posts its `library.storage.report`
(quota and used bytes) to `POST /api/connector/library/relay/storage` with the
same credential headers as the relay: when it starts, every five minutes and after
each operation that can change usage. The owner sees used and available space for the
active mode.

The retention job (`libraryRetention`, off by default, login in
`farm_library_retention` from migration 0057) runs beside the telemetry prune:

- when the owner sets "keep newest N versions", older live versions of an item are
  soft-deleted;
- a stored file is purged once every version using it has been soft-deleted for
  the retention window (30 days by default) and none is live; files no version
  references are removed after a one-hour grace;
- the file is removed on the server disk, or on the Connector host in Connector
  mode (the server records the purge only after the Connector confirms it);
  without the disk or a Connector transport the purge is deferred;
- version rows are kept: a purged version shows "arquivo removido" instead of
  being replayed, and uploading the same bytes again restores the file.
