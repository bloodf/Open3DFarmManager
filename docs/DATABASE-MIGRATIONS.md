# Disposable database migration runner

This opt-in local tool applies reviewed SQL to a fresh synthetic PostgreSQL database. The same runner is used by application startup (below) when enabled; the `bun scripts/migrate-disposable-db.ts` CLI itself remains a disposable-fixture tool and is not a production migration procedure.

Set `MIGRATION_SYNTHETIC_TEST_DISPOSABLE=yes` and `MIGRATION_SYNTHETIC_TEST_PORT` to the loopback-published port of a task-owned disposable PostgreSQL instance. Both database and user must be `fixture`; the host is fixed to `127.0.0.1`. No `DATABASE_URL` is read. The operator must verify resource ownership before invoking this destructive tool; the flag and fixture name cannot prove a database is disposable.

Run `node scripts/migrate-disposable-db.ts up`. To reverse exactly one migration, run `node scripts/migrate-disposable-db.ts down 0004_account_sessions`, substituting the actual last applied ID. Rollback may destroy data and is never automatic. Existing schemas created by older manual test scripts cannot be adopted automatically: use a fresh disposable database.

Files must be contiguous numbered pairs, starting at `0001`, named `NNNN_lowercase_name.up.sql` and `.down.sql`. Every directory entry must be a regular SQL file. The runner hashes the ID and exact contents of both directions. Changing an already applied file, removing it, or finding unknown/out-of-order history prevents further migration SQL from executing. Restore the reviewed source or investigate the fixture; do not rewrite the journal to hide drift.

A transaction-scoped advisory lock serializes cooperating runners. History validation, pending migrations and journal updates share one transaction, so an error rolls back the entire attempt. The journal is `public.open3dfarm_migrations`, outside `farm`, allowing migration 0001 to remove the farm schema without erasing history. Unrelated processes executing SQL directly do not participate in this lock. Run with an isolated migration owner, never the restricted application roles.

Concurrent runners queue on the advisory lock (no lock timeout while waiting); every statement, including that wait, is limited to thirty seconds, and DDL lock waits to five seconds. Migration files are trusted code. They must not include transaction control, modify the journal, or use operations prohibited inside PostgreSQL transactions. Checksums detect drift, not malicious SQL. This runner adds no credentials or dependencies.

Unit tests cover catalog naming, pairing, order and history validation. `testPostgresMigrations(sql)` in `tests/helpers/postgres-migrations-integration.ts` requires a fresh isolated database and exercises concurrent application, idempotence, digest/history rejection, transactional DDL failure and complete up/down/up. It cleans its schema, roles and journal on success; on failure, retain the disposable database for diagnosis and remove only its task-owned resources afterward. Real PostgreSQL execution must be reported separately from unit-test results.

The coordinator ran this helper successfully against a disposable native ARM64 PostgreSQL 17.11 instance with migrations 0001 through 0004. All six integration groups passed, including concurrent migration attempts and rollback of both DDL and journal after a deliberate SQL error. This validates local migration tooling, not application startup or production deployment.

## Application startup, readiness and database service

Startup gating is opt-in through the `database` runtime config: `NUXT_DATABASE_ENABLED` must be exactly `true`, `false` or unset (any other value is an invalid configuration and stops startup), plus `NUXT_DATABASE_DATABASE_URL`, `NUXT_DATABASE_MIGRATIONS` (`verify`, default, or `apply`) and `NUXT_DATABASE_MIGRATIONS_DIR` (the image sets `/app/migrations`).

Pinned Nitro does not await plugins, so the `database-lifecycle` plugin sets the phase to `starting` synchronously and verification runs in the background. While the phase is not `ready` (or `disabled`), `server/middleware/00.database-gate.ts` answers every route except `/healthz` and `/readyz` with 503 and `Retry-After`, and signalling WebSocket upgrades (which bypass middleware) are destroyed. On failure the process logs one fixed message (`database unreachable`, `schema has pending migrations`, `schema does not match this build`, `migration failed`, `invalid database configuration`, `migration files unavailable`; never driver text, hosts or users) and exits 1. The plugin does nothing during build/prerender.

- `verify` compares `public.open3dfarm_migrations` with the catalog read-only. A missing journal, pending migrations or a changed/unknown/out-of-order history stop startup. This is the recommended production mode; run migrations as a separate step with the migration owner.
- `apply` runs pending migrations first, then verifies. Concurrent instances queue on the advisory lock (each statement, including the wait, is bounded to 30 s), so rolling starts are safe but a long migration can make waiting instances exit and restart. Use it with the migration owner role only.
- A journal that extends the catalog (an older build started after a newer one migrated) is state `ahead`: it is accepted and `/readyz` reports `ahead` with 200. This assumes expand/contract migrations, where the previous release still works against the newer schema; apply never runs against an ahead journal.
- When enabled, every enabled feature `*DatabaseUrl` must target the same host, port and database as `database.databaseUrl`; otherwise startup fails closed, because the verified schema would not be the one in use.

`GET /healthz` is cheap process liveness (used by the container `HEALTHCHECK`). `GET /readyz` is for the orchestrator or an internal network only and must not be routed through the public proxy. It runs the read-only journal comparison with a 1.5 s bound (the in-flight query is cancelled on timeout and the pool uses a 2 s `statement_timeout`), is single-flight, and caches the result for 1 s. It returns 200 for `ok`, `ahead` or `disabled`, otherwise 503 with `unavailable`, `schema-pending` or `schema-mismatch`.

### Roles

Startup verification and `/readyz` only read `public.open3dfarm_migrations`, which lives outside `farm`. Migration `0025_schema_reader` creates the NOLOGIN role `farm_schema_reader` with `SELECT` on that table (and `USAGE` on `public`). The application login used by `database.databaseUrl` in `verify` mode should inherit only that role (plus whatever `farm_*` runtime roles it needs elsewhere); the other `farm_*` roles cannot read the journal. A permission failure at startup (SQLSTATE `42501`) is reported as `database permission denied`, not `database unreachable`. `apply` mode needs the migration owner below.

Do not point the application at the superuser created by the compose file. After the first start create a non-superuser migration owner and a separate application login. On PostgreSQL 17 the owner needs `CREATE` on `public` (the journal lives there), and `createrole_self_grant` so that roles it creates grant it `SET`/`INHERIT` (migrations 0017/0018 run `ALTER FUNCTION ... OWNER TO farm_*_owner`, which requires `SET` on those roles):

```sql
CREATE ROLE o3dfm_migrator LOGIN PASSWORD :'migrator_password' NOSUPERUSER CREATEROLE;
ALTER ROLE o3dfm_migrator SET createrole_self_grant = 'set, inherit';
GRANT CREATE ON DATABASE open3dfarm TO o3dfm_migrator;
GRANT CREATE ON SCHEMA public TO o3dfm_migrator;
CREATE ROLE o3dfm_app LOGIN PASSWORD :'app_password' NOSUPERUSER NOCREATEDB NOCREATEROLE;
-- after migrations: GRANT farm_schema_reader TO o3dfm_app; plus the farm_* runtime roles it needs
```

The same-target check compares host, port and database name as written, so spell the host identically in every `*DatabaseUrl` (do not mix `localhost`, `127.0.0.1` and aliases).

### Database service and tests

`infra/app/docker-compose.yml` defines the dedicated application PostgreSQL 17 service (digest-pinned image, own network and named volume, port published on `127.0.0.1` only, `no-new-privileges`, 30 s stop grace, 256 MB shm). `O3DFM_DB_PASSWORD` is required and nothing secret is committed; `O3DFM_DB_NAME`, `O3DFM_DB_USER`, `O3DFM_DB_PORT` and `COMPOSE_PROJECT_NAME` are optional. Unit tests (`tests/unit/database-readiness.test.ts`) cover schema states, gating, phases, config and the startup lifecycle with a stubbed client. `scripts/test-postgres-startup-gating.ts` runs against a real fresh disposable PostgreSQL and requires `STARTUP_GATING_DISPOSABLE=yes`, a loopback `STARTUP_GATING_DATABASE_URL` and a database named `fixture` without an existing journal.
