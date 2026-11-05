# Implementation queue

This queue describes the independent MIT product. It does not adopt private deployment configuration, shared authentication, another product's implementation or its commercial plans. Existing checkpoints remain evidence of their specific tests, not complete feature acceptance.

## Current work

1. Diagnose the pinned simulator's MCU identification failure. Capture progress before serial disconnect, distinguish observed traffic from inferred causes, and keep the existing readiness deadline and resource restrictions. A diagnostic result does not count as simulator acceptance.
2. Persist independent account session state in PostgreSQL. Prove expiry, logout, account-wide revocation, concurrency, restart persistence and restricted database permissions using synthetic data.
3. Make disposable database migrations repeatable. Record checksums and applied order, serialize concurrent migration attempts, reject changed history and demonstrate transactional rollback with a real isolated database.

These tasks can proceed independently. The coordinator owns container execution to avoid duplicate databases and simulators. Workers own distinct source files and report resources retained or removed.

## Authentication and enrollment

1. Review an established authentication library at an exact version, including its license and transitive dependencies. Implement original login/logout integration with a host-only secure cookie, current server-side session state, mutation-origin protection, bounded input and rate limits. Verify the built Node application; Bun-only storage tests are insufficient.
2. Add farm membership and explicit roles. Reject cross-farm reads and mutations. Serialize enrollment approval against session, membership and enrollment revocation instead of trusting a prior permission check.
3. Connect the pairing contracts to single-use expiring codes, bounded polling and fingerprint confirmation. Approve only from an authenticated authorized browser. Authenticate Connector transport with the approved identity and proof of possession.
4. Register browser signing keys through authenticated sessions. Bind keys to current farm permissions and distribute authenticated authorization context to the Connector.

The offline policy must state how long cached authorization can remain usable. A disconnected Connector cannot learn immediate remote revocation. Expiry must fail closed without claiming that loss of connectivity stops an ongoing print.

## Integrated Phase 0

1. Complete simulator acceptance for two virtual printers, four tools, camera and read-only Spoolman. Include negative faults and repeat startup on required architectures; retain bounded diagnostic evidence.
2. Authenticate telemetry ingestion and signalling. Exercise queue recovery after lost responses and server/database restart with durable idempotency. The server must never accept or return executable printer commands.
3. Select a WebRTC implementation through an isolated experiment. Authenticate the browser-to-Connector peer and carry live status, camera and signed commands over that connection. No TURN or command fallback.
4. Connect verified commands to the simulator driver behind Connector-local safety checks. Test tampering, replay, expired authorization, known revocation, wrong roles and wrong scope. Hardware is excluded from automated acceptance.
5. Build accessible pt-BR login, pairing, device management and farm views. Show data age and disable controls when P2P fails. Verify login-to-pairing-to-simulator behavior in a real browser and the built application.

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
