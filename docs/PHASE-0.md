# Phase 0 acceptance ledger

This independent MIT repository supersedes the former monorepo destination. Accounts, session cookies and database belong to this product. Hosting-specific details remain private. No code from the former application has been copied.

## Sequence

1. E0.1: isolated Klipper simulators (single and four tools), Spoolman seed, cameras, network faults and integration CI.
2. E1.1: Bun workspaces, Nuxt 4, protocol contracts, Connector CLI, checks, Docker packaging and feature flags.
3. E1.2: dedicated Postgres 17, reversible migrations, validated environment, readiness, structured logs and portable Compose.
4. E2.1/E2.4: independent login and session, authorization, rate limits and secure Connector pairing.
5. E3.1/E3.2: Connector identity, configuration, durable offline queue and batched persistence.
6. E5.1a/E5.4a: Moonraker identify/subscriptions/webcam and read-only Spoolman mirror.
7. E2.3/E4.1–E4.5: approved browser keys, WebRTC spike, authenticated signalling, signed commands, local verification and read-only degradation.
8. E6.1: hidden farm view with age indicators and direct links to existing printer UIs.
9. Hardware acceptance is an owner-run gate after simulator acceptance. Deployment and physical printer control require separate authorization.

## Invariants

- No TURN, cloud slicing, server-enqueued commands or command fallback outside WebRTC.
- Connector enforces signatures, roles, expiry, replay protection and safety when the server is unavailable.
- Camera/video and bulk files stay on P2P transport. Server receives bounded snapshots and batched metadata only.
- Simulators never connect to physical printers. Four-tool fixtures approximate capabilities, not unverified vendor internals.
- Do not mark Phase 0 complete until login, pairing, signed pause, tamper/replay/revocation rejection, outage recovery and degraded mode pass integration and browser tests.

## Current acceptance checks

| Gate                                            | Check                                 | Status                                  |
| ----------------------------------------------- | ------------------------------------- | --------------------------------------- |
| Workspace dependencies                          | Offline frozen-lockfile installation  | Passed locally                          |
| Type safety, unit tests, build                  | `bun run check:all`                   | Passed locally: 173 Bun + 92 Node tests |
| Browser smoke and hidden view                   | `bun run test:e2e`                    | Passed locally: 9 Chromium tests        |
| Connector distribution                          | Built CLI identity/help/version tests | Passed locally                          |
| Simulator lifecycle and protocol responses      | Container acceptance                  | Failed Klipper readiness; partial pass  |
| Docker packaging                                | Image build and health probe          | Passed locally: image and liveness      |
| Auth, database, pairing, WebRTC, offline safety | Full Phase 0 acceptance               | Incomplete                              |

See [the integration checkpoint](INTEGRATION-CHECKPOINT.md) for merged source branches, conflict resolutions, verification and limitations.

`/healthz` initially reports process liveness only. Database readiness will be added with E1.2; it must not be interpreted as a complete deployment health check.

Authorized local Docker execution now passed the application image build and liveness probe. Camera and Spoolman checks passed locally and on an isolated native x86_64 test host. Klipper readiness failed in both environments; the simulator gate remains incomplete. See the [container validation checkpoint](CONTAINER-VALIDATION-CHECKPOINT.md). GitHub Actions execution remains separately pending; workflows are unchanged.

## Simulator extension checkpoint

Prepared on `farm/simulator-harness`: separate SV06/U1 volumes; original synthetic four-tool configuration; Moonraker webcam entries; digest-pinned Spoolman and repeatable seed (2 vendors, 4 filaments, 6 spools); original JPEG/MJPEG source with connection and response-size limits; full integration acceptance script.

Local validation: 46 Bun tests and one Node runtime test passed. Typecheck and Compose parsing passed. The camera tests exercise only a generated test pattern on loopback. No physical devices are used.

Container execution was subsequently exercised with explicit authorization. The checkpoint above supersedes the earlier Docker-unavailable status; it records partial successes and actual failures rather than full simulator acceptance.

E0 still requires actual container acceptance, RTSP/MediaMTX, network fault scenarios and CI evidence. The initial foundation PR does not complete Phase 0. Database, independent login, authenticated pairing and WebRTC remain subsequent work. Signed-command verification is now a locally tested library prototype; authenticated context and physical dispatch are not implemented.

The subsequent [focused security review](SECURITY-REVIEW-INTEGRATION.md) records reproduced findings, fixes and remaining storage/authentication risks.

The [independent authentication threat model](INDEPENDENT-AUTH-THREAT-MODEL.md) records remaining login work and the tested host-only cookie configuration and strict mutation-origin predicate. These helpers are not wired to endpoints and do not issue or validate sessions.

The [session persistence contract](SESSION-PERSISTENCE-CONTRACT.md) adds a pure server-state decision and adapter requirements for atomic touch/revocation. It is not a database adapter or working authentication system.

A test-only in-memory session repository now exercises serialized authorization/revocation, outage rejection and fixture isolation. It has no durability or application integration and is not Connector storage.

The [browser key checkpoint](BROWSER-KEY-CHECKPOINT.md) connects persistent nonextractable IndexedDB keys across reload to the existing Chromium-to-Node signing/replay test. Server enrollment and device management remain unimplemented.

The [telemetry delivery checkpoint](TELEMETRY-DRAIN-CHECKPOINT.md) verifies synthetic observation → disk queue → lost response → reopen → idempotent delivery/acknowledgement. A real authenticated transport and server ingestion remain unimplemented.

The [internal ingestion checkpoint](TELEMETRY-INGESTION-CHECKPOINT.md) connects strict server-side validation and scoped deduplication in a test store to the real Connector queue. There is no exposed ingestion route or production persistence adapter.

The [command rejection checkpoint](COMMAND-BOUNDARIES-CHECKPOINT.md) tests real Chromium signatures against Node scope, revocation, role, time, tamper and persistent-replay boundaries. It does not authenticate the supplied context or dispatch commands.

The [Connector proof checkpoint](CONNECTOR-PROOF-CHECKPOINT.md) verifies the existing persisted Ed25519 identity against a bounded, single-use server challenge bound to expected scope. It proves key possession only; enrollment and authenticated agent context remain unimplemented.

The [enrollment-gated proof checkpoint](ENROLLMENT-PROOF-CHECKPOINT.md) rejects unpaired/pending/revoked identities before completing possession checks against the key in a current enrollment record. Approval permissions and durable enrollment storage remain unimplemented.

The [bounded HTTP telemetry checkpoint](HTTP-TELEMETRY-CHECKPOINT.md) verifies real loopback POST, response limits and cancellation through the queue/ingestion flow. Production credentials, authenticated endpoints and scheduling remain unimplemented.

The [HTTP transport review](HTTP-TRANSPORT-REVIEW.md) records configuration/error hardening and local redirect/streaming/decompression tests. DNS rebinding protection and an untrusted-URL policy are not implemented.

Destination-selection integration tests now cover injected fields, URL-shaped data, malicious response fields and all standard redirect statuses. Latest verification reran lint, typecheck and 82 Node tests; 148 Bun tests, builds and nine Chromium tests retain their previously recorded checkpoints.

E3.1.3 now exposes explicit, idempotent local identity initialization through the built Connector CLI. Source and distribution tests verify restart stability and possession using a synthetic challenge; this does not implement pairing or a running Connector. See the [Connector usage guide](../packages/connector/README.md).

The [simulator readiness diagnosis](SIMULATOR-READINESS-DIAGNOSIS.md) reproduces the MCU identification failure with upstream defaults alone. The initial cause is unresolved; the simulator acceptance gate remains failed.

Simulator JSON responses now reject malformed UTF-8 rather than replacing bytes before parsing. Three malformed-byte regressions and a valid split-multibyte response pass; the complete lint, typecheck, 158 Bun tests, 84 Node tests and builds passed. This does not resolve MCU startup.

Simulator JSON clients now reuse the existing local bounded parser to reject duplicate keys and excessive nesting/value counts. The added workspace dependency resolves offline with no external package changes. Complete checks passed with 164 Bun tests, 84 Node tests, lint, typecheck and builds; MCU startup remains separately unresolved.

An opt-in [bounded PTY launch experiment](SIMULATOR-BOUNDED-PTY-VALIDATION.md) passed ten separate Python tests and rejected missing/silent MCU faults under the unchanged readiness criterion. It is not enabled in Compose or CI and does not complete simulator acceptance.

The [complete native amd64 harness attempt with the PTY candidate](SIMULATOR-AMD64-HARNESS-RESULT.md) failed Klipper readiness. Independent camera and repeatable Spoolman checks passed, but default mitigation integration is not approved by these results. CI and Compose remain unchanged.

The [offline Spoolman inventory traversal](SPOOLMAN-INVENTORY-CHECKPOINT.md) now validates full supplied page sequences with cross-page uniqueness, completeness, observation ordering and aggregate budgets. Full local checks passed with 173 Bun tests and 84 Node tests plus lint, typecheck and builds. It does not fetch or persist an atomic upstream snapshot.

The [local Spoolman HTTP reader](SPOOLMAN-HTTP-CHECKPOINT.md) connects bounded GET pagination to inventory validation with a cumulative deadline and synthetic loopback coverage. It remains a local prototype without persistence or production authentication.

The [disposable actual Spoolman API test](SPOOLMAN-ACTUAL-API-VALIDATION.md) passed locally with the pinned image: empty inventory, repeatable seed, pagination and archived inclusion. This validates the reader against that API version; production mirroring and full Klipper acceptance remain incomplete.

The [PostgreSQL enrollment lookup checkpoint](POSTGRES-ENROLLMENT-CHECKPOINT.md) connects proof verification to a real transaction and validates concurrent revocation plus restart persistence in a disposable PostgreSQL 17 database. It remains unwired; account authentication, approval permissions, runtime DB roles and full pairing acceptance are incomplete.
