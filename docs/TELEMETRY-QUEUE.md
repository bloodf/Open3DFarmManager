# Durable telemetry queue prototype

`TelemetryQueue` is an isolated Connector component for E3.2.5. It stores validated printer-state records in a private append-only JSONL file. The queue does not accept commands, credentials, arbitrary event payloads, images or executable instructions. No cloud transport, runtime loop or production service uses it yet.

Each record receives a random stable event ID. Normal appends are synced before returning. Reading a batch does not remove it; only an explicit acknowledgement matching the current FIFO prefix removes records. The caller must acknowledge only after the server durably accepts the batch. Server upserts must deduplicate by authenticated agent and event ID: delivery is at least once, not exactly once. An outage after server acceptance but before local acknowledgement must cause a harmless repeated delivery.

Defaults retain at most 24 hours and 50 MiB. Expiration uses queue time, not the printer's observation time. At capacity, the oldest records are discarded. Enqueue, batch and recovery return explicit loss counters; runtime integration must log those counters as warnings. Batch limits include JSON array framing and default to 100 records and 64 KiB. A smaller limit that cannot hold the first record returns an empty batch without discarding it. Acknowledgements and retention compact by writing a private temporary file, syncing it, atomically renaming it and syncing the directory. Compaction temporarily needs up to another queue's worth of disk space; the cap is on the live JSONL data, not the whole directory.

Only one process may own a queue directory. An exclusive lock (`telemetry.lock`) rejects concurrent opens and graceful close releases it. The lock records the owner's PID, hostname, kernel boot ID, PID namespace, process start time (`/proc/<pid>/stat` field 22) and a random instance ID.

After a hard crash the next open takes the lock over only when the recorded owner certainly cannot be running. The hostname and PID namespace must match, and one of these must hold: the boot ID differs (the host rebooted), the PID does not exist (`ESRCH`), or the PID exists with a different start time (the PID was reused). A live owner, an unreadable start time, an unknown boot ID on either side, another host or namespace, a legacy PID-only lock and an unparseable lock all fail closed with the original `EEXIST` error, leaving the lock untouched. Takeover holds an exclusive `telemetry.lock.recover` file, re-reads the lock, writes a new lock to a unique private file and atomically renames it into place, then syncs the directory. A recovery that finds `telemetry.lock.recover` already present fails closed. If a recovery crashes while holding that file, an operator must remove it. The queue reports `recoveredStaleLock`, and collection emits a `queue-lock-recovered` diagnostic. Do not run a second Connector or delete the directory to get around this guard.

Reopening validates the complete log. A final unterminated record is treated as an interrupted append, truncated and reported. Complete corrupt JSON, invalid UTF-8, duplicate IDs, oversized partial tails, unexpected fields and a backwards queue clock fail closed without discarding complete records. Filesystem errors invalidate the current instance because an append or rename may have succeeded before an error was reported. Restart recovery and server deduplication resolve that ambiguity.

The directory is private to the current OS user; shared, linked or symlinked queue files are rejected. This is a local single-user storage boundary, not protection against a hostile process with the same account. The implementation loads a bounded file during recovery. A missing main log together with a compaction candidate requires explicit recovery; startup preserves the candidate rather than creating an empty replacement. Appends and recovery operations validate opened descriptors, and reads use nonblocking/no-follow flags to reject special files. Compaction uses one reserved temporary filename. After validating the committed log, recovery removes a regular private orphan at that path; symlinked or oversized orphans fail closed. No automatic migration of older layouts is supplied.

Tests exercise FIFO delivery, restart persistence, repeat delivery before acknowledgement, stale acknowledgements, expiration, byte limits including Unicode, partial append recovery, complete corruption, exclusive ownership across processes, sparse acknowledgements, orphan compaction recovery, clock regression and rejection of command fields. These tests use temporary local directories and never contact printers or start containers.

## Acknowledgement cursor (drain throughput)

Before this change every acknowledgement rewrote and fsynced the whole live log. With a full 50 MiB queue that measured 33 to 39 records/s, about two hours for a full backlog. Each batch also re-serialized every record to measure the byte cap.

Acknowledgements now leave the log in place and record progress in a small cursor file, `telemetry.ack`, containing `{"lastAcked":"<eventId>"}`. The cursor is written to `telemetry.ack.tmp` (exclusive, private), fsynced, atomically renamed and followed by a directory fsync. On open, records up to and including `lastAcked` are treated as acknowledged. If that ID is not in the log, nothing in the current log is acknowledged: an earlier compaction or retention rewrite already removed it. Event IDs are unique in a log, so a cursor can never point at a later record.

The acknowledged prefix is reclaimed by the existing compaction (temporary file, fsync, rename, directory fsync) once it reaches 8 MiB or the queue becomes empty. The order is cursor first, then compaction, so a crash at any step leaves one of these states:

- Old cursor, old log: the batch is delivered again and the server deduplicates it (at least once, as before).
- New cursor, old log: the prefix is skipped on open.
- New cursor, compacted log: the cursor ID is absent, so every remaining record is live.

A leftover `telemetry.ack.tmp` or `telemetry.compact` is validated as a private regular file and removed during recovery. No complete record is lost and none is duplicated except by idempotent replay. Record sizes are cached per record, so capacity checks no longer re-serialize the backlog.

Caps are unchanged: 50 MiB of live records, 24 hours and 64 KiB per record. The log on disk may additionally hold up to 8 MiB of acknowledged prefix, so recovery accepts a file of up to 58 MiB plus one partial record. Memory stays bounded by that file, because the acknowledged prefix is parsed during recovery and then discarded.

Compatibility: a queue from an older Connector has no cursor, so all of its records are live and it opens unchanged. An older Connector reading a newer queue ignores `telemetry.ack` and re-sends the acknowledged prefix, which the server deduplicates. A fresh scoped queue directory containing `telemetry.ack` requires operator review, like the other queue files.

## Release note: printer-transition records

The queue now also holds `printer-transition` records (printer state changes) alongside `printer-state` records. Older Connectors reject unknown record kinds on recovery and cannot read a queue containing them. Drain the queue (let it reach depth 0) before downgrading a Connector.
