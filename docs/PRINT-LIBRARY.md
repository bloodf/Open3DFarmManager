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
