# Implementation queue

This queue describes the independent MIT product. It does not adopt private deployment configuration, shared authentication, another product's implementation or its commercial plans. Existing checkpoints remain evidence of their specific tests, not complete feature acceptance.

## Verified component work

- PostgreSQL adapters run under Node. Isolated real-database checks passed for session persistence, expiry/revocation, concurrency and restricted permissions, and for migration ordering/checksums, concurrent runners and transactional rollback.
- Independent login/logout passed against the built Node application, a temporary HTTPS endpoint and Chromium. The flow uses its own host-only secure cookie and current database session state. Authentication dependencies and their notices were reviewed. Login remains opt-in; production account provisioning and recovery are incomplete.
- Real PostgreSQL credential checks passed for stale password/version rejection, disabled accounts, session-version changes, transaction/COMMIT failures, restricted permissions and shared rate limits.
- Farm approval helpers passed real PostgreSQL checks for allowed roles, farm scope, session/membership revocation ordering, rollback/COMMIT failures and restricted permissions. These are internal service checks, not a completed authenticated pairing API.

These results cover their tested components. The farm isolation check includes two existing farms. Migration reversals passed in an isolated PostgreSQL cluster. `bun run check:all` passed with 190 Bun tests, 95 Node tests and builds. Full enrollment, WebRTC and simulator acceptance remain incomplete.

## Current work

1. Diagnose the pinned simulator's MCU identification failure. Capture progress before serial disconnect, distinguish observed traffic from inferred causes, and keep the existing readiness deadline and resource restrictions. A diagnostic result does not count as simulator acceptance.
2. Connect the verified authentication, authorization and persistence components to enrollment without weakening their transaction boundaries.

The coordinator owns container execution to avoid duplicate databases and simulators. Workers own distinct source files and report resources retained or removed.

## Authentication and enrollment

1. Extend the verified independent login with account provisioning/recovery and operational audit requirements. Keep authentication opt-in until deployment configuration and remaining acceptance gates are addressed; do not treat isolated login success as complete Phase 0.
2. Wire the verified farm-membership and approval service into authenticated request boundaries. Enforce farm scope on every exposed read and mutation; retain atomic approval checks against session, membership and enrollment revocation.
3. Connect the pairing contracts to single-use expiring codes, bounded polling and fingerprint confirmation. Approve only from an authenticated authorized browser. Authenticate Connector transport with the approved identity and proof of possession.
4. Register browser signing keys through authenticated sessions. Bind keys to current farm permissions and distribute authenticated authorization context to the Connector.

The offline policy must state how long cached authorization can remain usable. A disconnected Connector cannot learn immediate remote revocation. Expiry must fail closed without claiming that loss of connectivity stops an ongoing print.

## Integrated Phase 0

1. Complete simulator acceptance for two virtual printers, four tools, camera and read-only Spoolman. Include negative faults and repeat startup on required architectures; retain bounded diagnostic evidence.
2. Authenticate telemetry ingestion and signalling. Exercise queue recovery after lost responses and server/database restart with durable idempotency. The server must never accept or return executable printer commands.
3. Select a WebRTC implementation through an isolated experiment. Authenticate the browser-to-Connector peer and carry live status, camera and signed commands over that connection. No TURN or command fallback.
4. Connect verified commands to the simulator driver behind Connector-local safety checks. Test tampering, replay, expired authorization, known revocation, wrong roles and wrong scope. Hardware is excluded from automated acceptance.
5. Extend the tested accessible pt-BR login/logout pages with pairing, device management and farm views. Show data age and disable controls when P2P fails. Verify login-to-pairing-to-simulator behavior in a real browser and the built application.

## After the integrated core

1. Complete Moonraker discovery, configuration, history, metadata and tool reporting; keep Spoolman as a read-only source of inventory truth.
2. Add original job costing and traceable material attribution, then maintenance, inventory, quotes/orders and notifications with farm-scoped access.
3. Add installation/update documentation, packaging, synthetic backup/restore, retention, resource limits and operational diagnostics.
4. Evaluate additional printer families only with their own simulator and licensing review. Product integrations and commercial features require independent configuration rather than shared secrets or accounts.

## Completion and publication gates

- Every task names a behavior, its test evidence, remaining integration gaps and its cleanup result. Do not count an idle or queued agent as active implementation.
- Run `bun run check:all` for integrated changes, plus the relevant real database, simulator and browser checks. Existing CI gates remain enabled.
- Review the complete publication diff for private material, secrets and license obligations. Obtain the pending explicit publication authorization before pushing or opening draft PRs.
- Keep local, published, validated and merged states separate. Deployment, DNS/credential changes and physical printer testing require separate authorization.
