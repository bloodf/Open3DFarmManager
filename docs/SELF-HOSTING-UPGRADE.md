# Self-hosted upgrades

Use a complete deployment Compose file containing `postgres`, `connector`, and the application. The repository database-only Compose file is insufficient. Every data mount must use an explicitly named volume. Keep the same Compose project, environment file, and volume names across releases. Keep credentials outside this repository.

The application image must interpolate `${O3DFM_VERSION}` and its environment must forward `${NUXT_DATABASE_MIGRATIONS}`. The command sets the latter to `apply`. Use immutable release tags. Configure `/readyz` to validate database readiness.

```sh
node scripts/self-host-upgrade.ts --version v2 --compose /private/deploy.yml --backup /private/backups/pre-v2.dump --dry-run
node scripts/self-host-upgrade.ts --version v2 --compose /private/deploy.yml --backup /private/backups/pre-v2.dump
```

Create the backup directory first. Use a new backup filename; existing files are never overwritten. Reserve at least 1 GiB and enough additional space for your database dump and image layers. Pause application writers before upgrading. Do not run concurrent upgrades or edit deployment configuration during an upgrade. Dry run prints the plan without contacting Docker.

The command validates the rendered deployment, checks backup disk space, dumps PostgreSQL, rechecks volume names, pulls images, starts services, and waits for readiness. It never removes volumes. Connector data stays in its existing volume. Command stderr and rendered environment are not printed.

On failure, execution stops. Keep the backup and all volumes. Stop application writers, select the previous release, and restore the dump with `pg_restore` into the dedicated database using your database administrator procedure. Start the previous release and verify `/readyz` before reopening access. A failed dump may leave a partial file: never use it as a confirmed backup. Restoring data can discard writes made after the backup; coordinate downtime and retain forensic copies first.
