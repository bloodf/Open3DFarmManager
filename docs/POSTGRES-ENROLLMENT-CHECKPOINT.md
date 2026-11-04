# PostgreSQL enrollment lookup checkpoint

`PostgresEnrollmentSource` connects the existing enrollment-gated Ed25519 proof service to PostgreSQL using Bun's built-in SQL client. It is not wired to routes or startup, creates no accounts or credentials, and exposes no approval operation. It does not grant an authenticated application session or telemetry context.

The caller owns a dedicated PostgreSQL connection pool. A parameterized query selects the exact farm/agent row under `FOR SHARE`; synchronous proof evaluation occurs under that row lock, and the source returns only after transaction commit. Database errors become a fixed redacted error, which the existing proof service converts to denial and challenge removal. Queries and callbacks do not escape the transaction. The adapter uses local 1-second lock and 2-second statement limits; these are operational database bounds, not offline authorization policy or a complete pool/connection deadline.

This follows [PostgreSQL 17 row-lock semantics](https://www.postgresql.org/docs/17/explicit-locking.html) and [Bun SQL transaction behavior](https://bun.com/docs/runtime/sql). A committed revocation serializes before a later proof read; an authorization already committed before revocation is not retroactively cancelled. No uncommitted record is used as a fallback.

The explicit draft migration creates a standalone `farm` schema and enrollment table. Inserts start pending; identity bindings are immutable; revocation is terminal; deletion and truncation are rejected to retain tombstones. The schema only checks key lengths: the existing proof service performs canonical public-key/fingerprint validation. Database owners can bypass triggers or drop objects, so production privilege separation and a migration ownership model remain necessary. The migration contains no user/membership references or permission-checked approval workflow yet.

The down migration destroys the enrollment table and schema. It is solely for an explicitly disposable development database, is never run at application startup, and is not a safe production rollback of revocation history. Backup restoration and migration rollout policies remain open.

## Opt-in integration fixture

`scripts/test-postgres-enrollment.ts` requires `ENROLLMENT_SYNTHETIC_TEST_DISPOSABLE=yes` and a loopback port in `ENROLLMENT_SYNTHETIC_TEST_PORT`. It uses a synthetic `fixture` database/user, refuses an existing `farm` schema on initial execution, applies the draft migration, creates a fresh in-memory Ed25519 key and performs fixture-only SQL transitions. Operators must verify ownership of the disposable database before invoking it. This test is excluded from CI and `check:all`.

Coverage includes missing/pending/approved enrollment, valid proof, replay, wrong farm, parameterization/error redaction, rolled-back revocation, a measured PostgreSQL lock wait followed by committed revocation, immutable bindings and tombstone retention. A second `--after-restart` invocation checks that revocation survives a database restart, then exercises explicit down/up migrations and missing-table denial. A closed pool must also deny proof issuance.

This is persistent enrollment lookup under test, not a working pairing product. Independent login, farm approval permissions, least-privilege runtime roles, production pool/TLS settings, schema integration, migrations runner, distributed challenges and HTTP/channel binding remain incomplete. Successful synthetic tests cannot establish those properties.

## Measured local result

On 2026-11-04 both initial and post-restart integration phases exited 0 using native ARM64 PostgreSQL 17.11 on OrbStack, pinned to `postgres@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b`. The concurrent test observed `pg_stat_activity.wait_event_type = Lock` for the enrollment read while another transaction held the revocation update, then confirmed denial after that update committed. The restart check used an actual container/database restart with the same task-owned volume, not a new in-memory adapter. This is normal restart persistence, not a power-loss or backup-restore guarantee.

The disposable fixture used a unique labeled network/volume/container, loopback-only port, UID/GID 70, all capabilities dropped, no-new-privileges, no devices, 1 CPU, 512 MiB and 128 PIDs. Passwordless trust was limited to this synthetic disposable database; this configuration must never become production defaults. The dedicated bridge was not an outbound firewall. Containers, volumes, networks and the newly acquired unused image were removed; label-filtered inventories were empty afterward, and unrelated resources were preserved.

An earlier run stopped before test setup because Unix-socket readiness matched the image's temporary initialization server. The corrected harness waits for final TCP readiness. Failure and success evidence remain local outside the public repository.

Full existing checks passed with 173 Bun tests, 92 Node tests, lint, typecheck and Connector/Nuxt builds. The separate PostgreSQL integration phases are not included in those unit-test counts. CI is unchanged and this work remains unpublished.
