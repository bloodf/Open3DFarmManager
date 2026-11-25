# Self-hosted upgrade procedure

Use this procedure for each release. Keep credentials and deployment files outside this repository. Use the same Compose project, environment file, and explicitly named data volumes across releases. The deployment Compose file must define `postgres`, `connector`, and the application; the repository database-only Compose file is not sufficient. Pin application images to immutable release tags, forward `NUXT_DATABASE_MIGRATIONS=apply`, and configure `/readyz` to check database readiness.

## Upgrade order: server first

Upgrade the application first, then each Connector. Both orders keep telemetry flowing, but they degrade differently while versions differ. The difference is the per-record send age (`ageAtSendMs`) in telemetry.

**New server, older Connector (recommended order).** The Connector sends no send age, so the server counts freshness from the time it received the report. It ignores a report dated more than 30 seconds ahead of that time.

- Pause, cancel and emergency stop stay available in the browser.
- All other controls require a fresh observation with a send age.
- Binding a physical spool to a Spoolman spool is refused (`spool-not-observed`) until the Connector is upgraded.
- The receipt-time window for stop actions lasts up to two minutes. The Connector still checks the printer state and refuses unsafe commands with a reason.

**New Connector, older server.** The older server refuses records that carry a send age (HTTP 400). The Connector then sends the same batch again without it, before anything is committed. Telemetry keeps flowing, at the cost of one extra request per batch with printer state or inventory. Server behavior is that of the old release. The same applies after rolling the application back. Once the server is upgraded, it receives the send age on the next batch, with no Connector restart.

An idle printer reports no progress. A server that still requires progress refuses that record (HTTP 400), and the Connector sends the batch again with progress 0 for the idle printer before anything is committed. It keeps the send age if the server accepts it. A server older than both changes costs two extra requests for such a batch.

**Resend after a lost acknowledgement.** If the server version changes between committing a batch and the Connector receiving the answer, the resend can carry the other idle shape. The server treats an idle printer with no progress and one with progress 0 as the same observation. A server without this rule answers HTTP 409. The Connector never resends a batch whose upload got a 409: it drops that batch, logs `telemetry-batch-refused` with the number of records dropped (and the total since it started), and continues with newer telemetry. Records in a dropped batch that the server had not stored yet are lost. A Connector without this change keeps resending the batch, which blocks its newer telemetry until the batch expires (24 hours). Other failures are retried as before.

A new Connector uses the timestamps saved in its queue to age reports recovered after a restart. It reports at least the full queue retention window for recovered observations because elapsed time across the restart cannot be verified from the wall clock alone. Reports without a usable age are eligible only for the stop-action fallback.

## 1. Rehearse the application upgrade

Create a trusted PostgreSQL custom-format backup with `pg_dump -Fc`. Set the destination image to the immutable release tag and run the isolated rehearsal:

```sh
export O3DFM_REHEARSAL_IMAGE=registry.example.org/open3dfarmmanager:v2
node scripts/self-host/rehearse-upgrade.ts --backup /private/backups/pre-v2.dump --to v2
```

The rehearsal restores the backup into an isolated PostgreSQL instance, runs migrations from the destination image, and compares table counts and configuration checksums. Review its report and investigate all differences before proceeding. It does not verify production permissions, private Connector files, hardware, or printer commands.

## 2. Back up application and Connector data

Pause application writers. Create a new backup filename; commands refuse to overwrite existing files. Allow at least 1 GiB plus space for the database dump and image layers.

Back up the database using the deployment's PostgreSQL administrator procedure and `pg_dump -Fc`. Back up the Connector's private runtime configuration using the repository's Connector config backup procedure, storing the backup outside the repository. Keep both backups and record their locations. Do not assume the database dump contains Connector configuration or global PostgreSQL roles.

## 3. Upgrade the application

From the deployment host, use the canonical application upgrade entry point:

```sh
node scripts/self-host/upgrade.ts --version v2 --compose /private/deploy.yml --backup /private/backups/pre-v2.dump --dry-run
node scripts/self-host/upgrade.ts --version v2 --compose /private/deploy.yml --backup /private/backups/pre-v2.dump
```

Review the dry-run plan, then run the upgrade. It validates the rendered deployment, checks backup space, creates the PostgreSQL dump, confirms volume names, pulls images, starts services, and waits for readiness. Dry run does not contact Docker. The upgrade does not remove volumes, and Connector data remains in its existing volume. Do not run concurrent upgrades or edit deployment configuration during the operation. Command stderr and rendered environment are not printed.

## 4. Migrate Connector configuration

After the application upgrade, run the Connector configuration migration against the restored runtime configuration file:

```sh
node scripts/connector-config-migrate.ts /private/connector/runtime-config.json
```

The command validates and migrates the versioned runtime configuration in place. Preserve the separate backup until verification and rollback are no longer needed. If migration reports an error, keep services in the safe state and follow rollback before reopening access.

A journal upgraded from v18 cannot recover whether an earlier `config_write` requested a restart. If one was sent immediately before the upgrade, wait 60 seconds from that send before allowing another printer restart; it may not count toward the restart cap during that window.

## 5. Verify

Confirm the application and Connector services are healthy, `/readyz` reports database readiness, and expected application data is available. Confirm the Connector runtime configuration loads in the new version. Reopen writers only after these checks succeed. Do not use automated tests to command physical printers.

## 6. Roll back

A Connector version that predates journal v19 refuses to open a journal already upgraded to v19 (`Unknown command journal version`). Keep that Connector stopped and retain the journal; do not replace or delete it to bypass the refusal, because it contains command safety and replay history. Use a Connector compatible with v19 while resolving the rollback.

Keep all backups and volumes. Restoring the dump discards writes made after the backup. Coordinate downtime and retain forensic copies. Never use a partial or failed dump as a backup.

1. Stop all application processes and Connectors. Keep access closed throughout the restore. Prepare the PostgreSQL roles referenced by the dump, a new dedicated database name, and an absent path for the restored configuration. From the previous release's checkout, use Node 22 and a trusted custom-format dump. Confirm the release supports the restore command and the Connector restore marker before proceeding.
2. On each remote Connector host, run the fence command as the Connector service user against its actual state directory. Preserve the marker, identity, credentials, and command journals.

   ```sh
   node scripts/self-host/restore.ts fence /private/connector/state
   ```

3. Run the restore on the Docker host. Replace `postgres` with the PostgreSQL container name. Include every local Connector state directory. Use `collector` instead of `provisioning` for a collector v1 backup.

   ```sh
   node scripts/self-host/restore.ts restore postgres rollback_v1 /private/backups/pre-v2.dump provisioning /private/backups/connector.json /private/connector/restored.json /private/connector/state
   ```

   The command restores into a new isolated database, validates migration history, revokes sessions and browser keys, increments session versions, fences the listed Connector directories, and copies validated configuration before allowing ordinary database connections. If any step fails, keep access closed. The command attempts to drop the new database; if cleanup fails, remove it manually before retrying. Already written fence markers remain in place, and a copied configuration may need a new target path on retry.

4. Select the previous immutable application release and apply its pending migrations. Reconcile accounts, memberships, Connector and integration credentials, and revocations changed since the backup. Check separately managed files referenced by the restored configuration.
5. Point the application at the restored database and configuration. Verify `/readyz`, expected data, and configuration loading. Restart only Connectors that support the restore marker. Verify a pre-backup session is rejected and its browser key is revoked. Confirm browser control remains blocked until an authenticated current key set is confirmed. Users must sign in again and register new browser keys for approval. Reopen access only after every check succeeds; on any failure, keep access closed and investigate.
