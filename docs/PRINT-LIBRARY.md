# Print library

Each farm has one library mode, selected by an owner or admin. Connector mode is
the default. A mode change applies to future uploads; existing files can be
migrated over the Connector session (see "Switching modes and replay"). The UI
and API must report where each version actually is, including the Connector
identity for Connector copies.

Files are immutable versions identified by SHA-256. Uploading identical bytes
within a farm deduplicates storage. Compatibility checks report `block`, `warn`
or `info`; the Connector independently enforces blocking safety and
compatibility rules before replay. Warnings and information are advisory.

## Server mode

The server stores content-addressed files on local disk under
`OPENFARM_LIBRARY_DIR`, named by SHA-256. It writes to a temporary file and
renames it into place. PostgreSQL stores metadata, versions and farm ownership;
deduplication is per farm. The default quota is 20 GiB per farm and soft-deleted
files are retained for 30 days before purge. Delete first hides a version; a
later purge removes eligible content when no live references remain.

A Connector fetches a requested hash over its authenticated HTTPS credential,
checks the bytes against SHA-256, then uses a bounded LRU cache. The cache
defaults to 2 GiB and is configurable. Replay starts from the verified server
copy/cache.

## Connector mode

The Connector host stores files in its configured library directory, using a
content-addressed SHA-256 layout, with quota and retention enforced there. The
server keeps metadata, thumbnails and hashes only. The web library lists and
fetches files through the assigned Connector; replay starts from that
Connector's copy. This mode works when the server cannot store file contents.

Configure the Connector's storage directory, quota and retention on that host;
report those values and the Connector identity to the farm. The Connector
checks SHA-256 before serving or replaying a version.

The host store (`packages/connector/src/runtime/library-store.ts`) keeps files at
`<directory>/<sha256>`, writes through a temp file and rename, keeps one copy per
hash, applies the quota and retention rules of server mode (oldest unpinned
versions are evicted; the removal is reported) and reports quota and usage with
the `library.storage.report` frame. File listings carry metadata, thumbnail and
hash only (`packages/farm-protocol/src/library-storage.ts`). Errors for a full
disk, a missing file and a hash mismatch are distinct and shown in pt-BR.

## Switching modes and replay

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

## Quota and retention

The default quota is 20 GiB per farm; `OPENFARM_LIBRARY_QUOTA_BYTES` changes the
default for farms with no stored setting. An upload that does not fit is refused
before any file is accepted, with an accessible pt-BR message. Server mode counts
the unpurged files on the server disk. Connector mode checks the quota the
Connector host reports for its own library directory (`farm.library_connector_storage`);
the Connector enforces it too. The owner sees used and available space for the
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
