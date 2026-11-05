# Disposable database migration runner

This opt-in local tool applies reviewed SQL to a fresh synthetic PostgreSQL database. It is not wired into application startup and is not a production migration procedure.

Set `MIGRATION_SYNTHETIC_TEST_DISPOSABLE=yes` and `MIGRATION_SYNTHETIC_TEST_PORT` to the loopback-published port of a task-owned disposable PostgreSQL instance. Both database and user must be `fixture`; the host is fixed to `127.0.0.1`. No `DATABASE_URL` is read. The operator must verify resource ownership before invoking this destructive tool; the flag and fixture name cannot prove a database is disposable.

Run `bun scripts/migrate-disposable-db.ts up`. To reverse exactly one migration, run `bun scripts/migrate-disposable-db.ts down 0004_account_sessions`, substituting the actual last applied ID. Rollback may destroy data and is never automatic. Existing schemas created by older manual test scripts cannot be adopted automatically: use a fresh disposable database.

Files must be contiguous numbered pairs, starting at `0001`, named `NNNN_lowercase_name.up.sql` and `.down.sql`. Every directory entry must be a regular SQL file. The runner hashes the ID and exact contents of both directions. Changing an already applied file, removing it, or finding unknown/out-of-order history prevents further migration SQL from executing. Restore the reviewed source or investigate the fixture; do not rewrite the journal to hide drift.

A transaction-scoped advisory lock serializes cooperating runners. History validation, pending migrations and journal updates share one transaction, so an error rolls back the entire attempt. The journal is `public.open3dfarm_migrations`, outside `farm`, allowing migration 0001 to remove the farm schema without erasing history. Unrelated processes executing SQL directly do not participate in this lock. Run with an isolated migration owner, never the restricted application roles.

Lock waits are limited to five seconds and statements to thirty seconds in this disposable runner. Migration files are trusted code. They must not include transaction control, modify the journal, or use operations prohibited inside PostgreSQL transactions. Checksums detect drift, not malicious SQL. This runner adds no credentials or dependencies.

Unit tests cover catalog naming, pairing, order and history validation. `testPostgresMigrations(sql)` in `tests/helpers/postgres-migrations-integration.ts` requires a fresh isolated database and exercises concurrent application, idempotence, digest/history rejection, transactional DDL failure and complete up/down/up. It cleans its schema, roles and journal on success; on failure, retain the disposable database for diagnosis and remove only its task-owned resources afterward. Real PostgreSQL execution must be reported separately from unit-test results.

The coordinator ran this helper successfully against a disposable native ARM64 PostgreSQL 17.11 instance with migrations 0001 through 0004. All six integration groups passed, including concurrent migration attempts and rollback of both DDL and journal after a deliberate SQL error. This validates local migration tooling, not application startup or production deployment.
