# Disposable database migration runner

This opt-in local tool applies reviewed SQL to a fresh synthetic PostgreSQL database. The same runner is used by application startup (below) when enabled; the `bun scripts/migrate-disposable-db.ts` CLI itself remains a disposable-fixture tool and is not a production migration procedure.

Set `MIGRATION_SYNTHETIC_TEST_DISPOSABLE=yes` and `MIGRATION_SYNTHETIC_TEST_PORT` to the loopback-published port of a task-owned disposable PostgreSQL instance. Both database and user must be `fixture`; the host is fixed to `127.0.0.1`. No `DATABASE_URL` is read. The operator must verify resource ownership before invoking this destructive tool; the flag and fixture name cannot prove a database is disposable.

Run `node scripts/migrate-disposable-db.ts up`. To reverse exactly one migration, run `node scripts/migrate-disposable-db.ts down 0004_account_sessions`, substituting the actual last applied ID. Rollback may destroy data and is never automatic. Existing schemas created by older manual test scripts cannot be adopted automatically: use a fresh disposable database.

Files must be contiguous numbered pairs, starting at `0001`, named `NNNN_lowercase_name.up.sql` and `.down.sql`. Every directory entry must be a regular SQL file. The runner hashes the ID and exact contents of both directions. Changing an already applied file, removing it, or finding unknown/out-of-order history prevents further migration SQL from executing. Restore the reviewed source or investigate the fixture; do not rewrite the journal to hide drift.

A transaction-scoped advisory lock serializes cooperating runners. History validation, pending migrations and journal updates share one transaction, so an error rolls back the entire attempt. The journal is `public.open3dfarm_migrations`, outside `farm`, allowing migration 0001 to remove the farm schema without erasing history. Unrelated processes executing SQL directly do not participate in this lock. Run with an isolated migration owner, never the restricted application roles.

Lock waits are limited to five seconds and statements to thirty seconds in this disposable runner. Migration files are trusted code. They must not include transaction control, modify the journal, or use operations prohibited inside PostgreSQL transactions. Checksums detect drift, not malicious SQL. This runner adds no credentials or dependencies.

Unit tests cover catalog naming, pairing, order and history validation. `testPostgresMigrations(sql)` in `tests/helpers/postgres-migrations-integration.ts` requires a fresh isolated database and exercises concurrent application, idempotence, digest/history rejection, transactional DDL failure and complete up/down/up. It cleans its schema, roles and journal on success; on failure, retain the disposable database for diagnosis and remove only its task-owned resources afterward. Real PostgreSQL execution must be reported separately from unit-test results.

The coordinator ran this helper successfully against a disposable native ARM64 PostgreSQL 17.11 instance with migrations 0001 through 0004. All six integration groups passed, including concurrent migration attempts and rollback of both DDL and journal after a deliberate SQL error. This validates local migration tooling, not application startup or production deployment.

## Application startup, readiness and database service

Startup gating is opt-in through the `database` runtime config (`NUXT_DATABASE_ENABLED=true`, `NUXT_DATABASE_DATABASE_URL`, `NUXT_DATABASE_MIGRATIONS` = `verify` (default) or `apply`, `NUXT_DATABASE_MIGRATIONS_DIR`; the container image sets the directory to `/app/migrations`). The Nitro plugin `database-lifecycle` runs startup before the server accepts traffic:

- `verify` compares `public.open3dfarm_migrations` with the catalog read-only. Missing journal, pending migrations, a changed/unknown/out-of-order history or an unreachable database reject startup, so the process exits instead of serving. This is the recommended production mode; run migrations as a separate step with the owner role.
- `apply` first runs the pending migrations with the runner described above (advisory lock, single transaction), then verifies. The configured role must own the schema; use it only for an isolated migration owner or a single-instance deployment, not for the restricted application roles.
- Invalid enabled configuration also rejects startup. Startup failures log a short message (no URL or driver detail) and exit the process with code 1. Disabled (default) skips the database entirely and `/readyz` reports `database: "disabled"`.

`GET /healthz` stays a cheap process-liveness check with no database access (used by the container `HEALTHCHECK`). `GET /readyz` runs the same read-only journal comparison on the pooled connection with a 2 second bound and returns 200 only for `database: "ok"` (or `"disabled"`). Otherwise it returns 503 with one of `unavailable`, `schema-pending` or `schema-mismatch`; driver errors, hosts and credentials are never included.

`infra/app/docker-compose.yml` defines the dedicated application PostgreSQL 17 service (digest-pinned image, own network and named volume, port published on `127.0.0.1` only). `O3DFM_DB_PASSWORD` is required and nothing secret is committed; `O3DFM_DB_NAME`, `O3DFM_DB_USER`, `O3DFM_DB_PORT` and `COMPOSE_PROJECT_NAME` are optional. Unit tests (`tests/unit/database-readiness.test.ts`) cover gating and readiness with a stubbed client; `scripts/test-postgres-startup-gating.ts` exercises them against a real disposable PostgreSQL (`STARTUP_GATING_DATABASE_URL`, loopback only).
