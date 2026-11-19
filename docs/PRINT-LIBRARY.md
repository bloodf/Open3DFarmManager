# Print library

Each farm has one library mode, selected by an owner or admin. Connector mode is
the default. Mode changes apply to future uploads only: they do not migrate
files. The UI and API must report where prior versions remain, including the
Connector identity for Connector copies.

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

## Switching modes and replay

Switching mode never copies or deletes existing files. New uploads use the
selected mode; older versions stay at their recorded location until normal
retention and purge rules apply. Show each version's storage mode and, for
Connector storage, its Connector identity. Replay always retrieves the exact
selected version by hash, verifies it, and runs compatibility checks before
starting. A blocked version cannot be replayed.
