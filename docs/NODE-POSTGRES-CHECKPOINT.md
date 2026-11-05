# Node PostgreSQL adapter transition

The farm application uses Nitro's `node-server` preset. Its PostgreSQL repositories and isolated database harnesses now import the pinned `postgres@3.4.9` driver instead of Bun SQL. Bun remains the workspace package manager and unit-test runner. The driver is declared directly by the application and root test workspace, with one version resolved in `bun.lock`. License provenance and the retained notice are in `THIRD_PARTY.md`.

## Preserved behavior

Enrollment, telemetry and session repositories retain their SQL, transaction boundaries, row locks, statement/lock timeouts and restricted-role requirements. Session expiry remains terminal after observation. Postgres.js `begin` reserves one connection and waits for commit before resolving; commit failure cannot return successful authorization. Telemetry supplies JSONB values through `tx.json`. SQLSTATE assertions inspect the driver's `code` field.

Migration and integration scripts use the same driver, explicit loopback fixture configuration and existing disposable-database opt-in. Async waits use `node:timers/promises`. Pool cleanup uses `end`, which permanently ends the pool; Postgres.js `close` can reconnect and would not establish the required closed-pool failure behavior. Connector queue `close` calls retain their original meaning.

The implementation retains safe-integer SQL conversions and existing runtime checks. Query projection types describe the selected columns; they do not establish authentication or farm authorization. No database driver compatibility layer, second driver, automatic migration startup hook or HTTP authentication endpoint was added by this transition.

## Validation and pending gates

The exact registry tarball's SHA-512 and package metadata were verified without executing package scripts. It declares Unlicense and no runtime dependencies. Dependency installation used `bun install --ignore-scripts`. Root TypeScript and Nuxt type checking passed after the driver migration. Node 24.20.0 imported all three repositories and all four PostgreSQL integration helpers without database access.

The coordinator executed the enrollment and session harnesses with Node 24.20.0 against isolated PostgreSQL 17.11, including each post-restart phase. Proof/revocation, restricted-role denials, telemetry JSONB conflicts and idempotence, session expiry/revocation races, COMMIT failure and closed-pool rejection passed. The migration helper also passed under Node with migrations 0001 through 0005, including concurrent runners and transactional DDL rollback.

The compiled Nuxt Node application subsequently passed the independent-login HTTPS/Chromium harness using a restricted synthetic database role. That exercise verifies the selected runtime and pool integration for login, not every future endpoint or complete Phase 0 acceptance. The integrated `check:all` passed with 189 Bun tests, 95 Node tests and both builds; twelve existing browser tests also passed.

The implementation worker did not start resources. The coordinator owned the disposable database and application processes used for validation; no physical printer, production service or published change was involved. Production account provisioning and authenticated enrollment remain separate work.
