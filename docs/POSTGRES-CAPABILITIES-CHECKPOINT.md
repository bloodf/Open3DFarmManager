# Restricted PostgreSQL capability checkpoint

Migration 0003 is an explicit draft for the dedicated product database. It creates two non-login capability roles, without credentials or application users: `farm_enrollment_reader` and `farm_telemetry_writer`. Nothing applies this migration or connects these roles to application startup automatically.

The enrollment reader has schema usage, enrollment SELECT and UPDATE on `agent_id` only. The existing lifecycle trigger rejects changes to that immutable ID. PostgreSQL requires UPDATE on at least one column for `FOR SHARE`; granting SELECT alone would break the current serialized proof lookup. See the [PostgreSQL 17 SELECT privilege requirements](https://www.postgresql.org/docs/17/sql-select.html) and [column-level GRANT syntax](https://www.postgresql.org/docs/17/sql-grant.html). A same-ID no-op update remains possible for enrollment and may acquire a lock, but cannot approve, revoke or rebind an enrollment.

The telemetry writer has SELECT/INSERT and UPDATE on `event_id` only, satisfying its shared row lock. A new trigger rejects every telemetry UPDATE, including no-op ID updates. Neither role has DELETE, TRUNCATE, schema CREATE, trigger alteration, ownership, role administration, replication or superuser powers. Enrollment and telemetry permissions are separated. Runtime login identities and secure credentials remain deployment work; the roles themselves cannot log in.

These capabilities reduce accidental or injected SQL write authority, but are not per-farm authorization or row-level security. The reader can read all enrollments; the writer can insert events for arbitrary supplied scopes and read all telemetry. The application must establish authenticated context and current farm/printer permissions before calling the stores. Do not expose these services directly to clients. Database owners/superusers remain trusted and can bypass triggers; membership administration must also remain trusted.

## Explicit disposable integration

The existing opt-in PostgreSQL integration script now applies 0003 after migrations 0001/0002 and creates two synthetic login fixtures with only the respective capability membership. Actual adapter calls verify approved Ed25519 possession and idempotent telemetry insertion/conflict handling through separate restricted connections.

Negative SQL tests require the expected PostgreSQL permission or trigger error code, rather than accepting arbitrary failures. They cover attempted approval, enrollment ID substitution, deletion, truncation, disabling triggers, cross-table reads, schema creation, changing telemetry payload/ID and escalation to the fixture administrator. The stored event is checked after denied mutations. The administrator deletes only the added synthetic event to preserve the older integration fixture's row-count assertions.

The second invocation after an actual database restart rechecks role flags, restrictions, revocation rejection and telemetry behavior, then explicitly reverses 0003 before older migrations. All fixtures exist only in the task-owned disposable cluster; no real database accounts or credentials are involved. The roles are cluster-wide names, so this draft intentionally fails if they already exist rather than replacing existing roles.

No CI workflow changes, production schema rollout, account login, approval endpoints, database TLS setup, event-retention policy or complete Phase 0 acceptance are included.

## Observed result

On 2026-11-04 both integration phases passed against native ARM64 PostgreSQL 17.11 on OrbStack, pinned to `postgres@sha256:266d3c257594e195b309ae9d1805e54c788f1d7b375f56bf6c367aac6c917e7b`. Restricted adapter success and expected SQL denial codes were measured before and after normal database restart. Existing enrollment race/timeout, durable queue, conflict and restart checks also passed.

The disposable container used loopback-only publication, UID/GID 70, all capabilities dropped, no-new-privileges, 1 CPU, 512 MiB and 128 PIDs. It used a dedicated labeled bridge/volume and synthetic trust authentication; the bridge did not block outbound traffic, and trust is not a production configuration. Container, volume, network and newly acquired unused image were removed, with no remaining resources matching the task label. Unrelated resources were preserved. Detailed execution/cleanup evidence remains local outside the repository.

`check:all` passed: lint, typecheck, 173 Bun tests, 95 Node tests and Connector/Nuxt builds. The explicitly invoked database integration is additional evidence, not part of those counts or CI. Work is local and unpublished.
