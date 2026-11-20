# Self-hosted upgrade procedure

Use this procedure for each release. Keep credentials and deployment files outside this repository. Use the same Compose project, environment file, and explicitly named data volumes across releases. The deployment Compose file must define `postgres`, `connector`, and the application; the repository database-only Compose file is not sufficient. Pin application images to immutable release tags, forward `NUXT_DATABASE_MIGRATIONS=apply`, and configure `/readyz` to check database readiness.

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

## 5. Verify

Confirm the application and Connector services are healthy, `/readyz` reports database readiness, and expected application data is available. Confirm the Connector runtime configuration loads in the new version. Reopen writers only after these checks succeed. Do not use automated tests to command physical printers.

## 6. Roll back

If the upgrade, Connector migration, or verification fails, keep all backups and volumes. Stop application writers. Restore the pre-upgrade PostgreSQL dump into the dedicated database using the database administrator procedure, restore the Connector configuration backup, and select the previous immutable application release. Start the previous release and verify `/readyz` and Connector configuration before reopening access. Restoring data can discard writes made after the backup; retain forensic copies and coordinate downtime first. Never treat a partial or failed dump as a valid backup.
