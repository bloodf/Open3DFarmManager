# Browser-device HTTP checkpoint

This slice connects browser-device enrollment, approval, and terminal revocation to HTTP handlers and an explicit `/dispositivos` page. It retains the durable registry's proof and authorization rules. It does not issue transport sessions, authorization leases, signalling credentials, or printer commands.

## HTTP contract

The protocol DTOs live in `packages/farm-protocol/src/browser-device-http.ts`. The audience is fixed to `open3dfarmmanager:browser-device`. Request schemas reject extra identity, role, session, and purpose fields.

| Method and path                                 | Request                                                         | Response                                                               |
| ----------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `GET /api/browser-devices`                      | `farm_id`, optional `limit` from 1 to 50, optional UUID `after` | Current account and role, bounded device metadata, next cursor, limits |
| `POST /api/browser-devices/challenges`          | `farm_id`, canonical public JWK                                 | Enrollment challenge and limits                                        |
| `POST /api/browser-devices/recovery-challenges` | `farm_id`, canonical public JWK                                 | Recovery challenge and limits                                          |
| `POST /api/browser-devices/proofs`              | `challenge_id`, signature                                       | Safe device metadata and limits                                        |
| `POST /api/browser-devices/approve`             | `farm_id`, `key_id`, `expected_thumbprint`                      | Safe device metadata and limits                                        |
| `POST /api/browser-devices/revoke`              | `farm_id`, `key_id`, `expected_thumbprint`                      | Safe device metadata and limits                                        |

The GET handler rejects duplicate or unknown query parameters and defaults to 20 records. Current owners and administrators can list their farm's devices. Other active members can list their own devices. The new registry `list` method locks and revalidates the current account, session, and membership before returning. The existing mutation methods and migration semantics are unchanged.

Listings contain `keyId`, `accountId`, thumbprint, status, proof time, creation time, and the pending deadline. Approved and revoked records have no pending deadline. Mutation responses omit creation and deadline fields, so the page refreshes the listing after a mutation. Metadata responses contain no private login reference, public JWK, or proof-session reference. Challenges retain their separate public proof-session UUID and private server-side login association.

## Authentication and request limits

`server/services/browser-devices.ts` calls the maintained `authenticatedSession` helper, then reads the sealed cookie's internal session reference. Only after successful database session validation does it consume the durable operation budget. Anonymous, malformed-cookie, and already revoked sessions consume no budget. The namespace is specific to the operation and internal session. Each operation permits 60 attempts per 15-minute window. The registry repeats account, session, membership, and role authorization inside its own transaction.

Mutations require POST, an empty query, JSON with UTF-8 encoding, and the configured authentication origin. Host and forwarded headers do not supply trusted origin or identity. The reader rejects duplicate JSON members, malformed UTF-8, compressed bodies, excess structure, and bodies over 4 KiB. Its deadline is five seconds. Process admission permits 16 requests through authentication, body reads, cryptography, and SQL. A `finally` block releases admission on success and failure. HTTP errors use fixed pt-BR messages and omit backend diagnostics. The client does not retry mutations automatically.

The separate runtime uses private `browserDevices.enabled` and `browserDevices.databaseUrl` configuration. Commit `3471da5` adds those Nuxt fields with disabled and empty defaults, sanitized environment placeholders, and the pt-BR homepage link to `/dispositivos`. Absent or disabled configuration returns 404. This wiring preserves the existing authentication and Connector pairing configuration and copy. It does not enable a service by default. The configured pool has four connections, a three-second connection timeout, two-second statements, one-second lock waits, and PostgreSQL 17's ten-second transaction timeout. Startup requests the `farm_browser_device_runtime` role. The real PostgreSQL gate below verifies startup-role and timeout enforcement.

## Local key custody and recovery

The legacy single-key helper remains available. Explicit enrollment uses new IndexedDB slots under a separate enrollment prefix, scoped to the current account and farm. Each scope permits at most 32 local keys. Enumeration creates nothing, and creation never overwrites existing slots. Private keys remain nonextractable. Corrupt records fail before enrollment. If another tab inserts corruption during creation, the serialized insert can leave an orphan local key before later validation fails. The helper does not promise rollback of that committed insert.

The page loads current account and farm authorization before creating a key. It repeats scope checks around challenge receipt, signing, and proof completion. Navigation, detected account changes, and authorization failures clear displayed authority and cancel pending work. An explicit resume action uses the same unproven local key after reload. Owner and administrator actions require fingerprint confirmation, while the server independently checks current authority.

Successful proof does not approve a new key. A pending record keeps its original 24-hour lifetime. Every key permits three lifetime challenges, including failures, expiry, and successful recovery. A new login can prove possession of the same approved key through recovery, subject to current authorization and that lifetime limit. Recovery does not extend authority or the pending lifetime. Lost storage requires a new key and explicit approval. It does not replace or revoke older records. Revocation remains terminal.

## Verification and remaining gates

The first coordinator `bun run check:all` passed formatting, type checks, 227 Bun tests, 107 Node tests, and both builds. Seven HTTP service tests passed with 46 assertions. They use real login and sealed-cookie cryptography with synthetic session and registry storage. Coverage includes authentication before quota, fixed route purpose, operation namespaces, malformed bodies, the five-second body deadline, and rejection of the seventeenth concurrent request.

Six enrollment tests passed against the built Nuxt page with real IndexedDB and WebCrypto. API responses are intercepted except for the disabled-route check. Coverage includes verification of the browser signature in the test process, reload persistence, private-export denial, account isolation, corrupt storage, and account changes after challenge receipt. A held IndexedDB read/write transaction exercises an account change while a cursor read is pending. Explicit resume keeps the same unproven key. Explicit recovery keeps the same approved key after reload and produces a verified signature, without establishing real new-login semantics. Administrator approval and revocation require the confirmed fingerprint. Unintercepted GET and POST requests to the actual unconfigured Nuxt endpoints both return 404.

The page displays the 24-hour pending lifetime, 60-second proof lifetime, and three-challenge limit. An earlier combined run of three enrollment tests with the eight existing browser key, signing, and boundary tests passed all 11 tests.

The initial service and intercepted browser tests above did not establish browser authority against a real PostgreSQL-backed service. The later real gate below supplies that login-to-HTTP evidence. Earlier registry persistence and migration evidence remains in [the browser key checkpoint](BROWSER-KEY-CHECKPOINT.md). Full Phase 0 still requires authenticated WebRTC, signed command rejection, revocation, and outage recovery end to end.

The browser-device slice adds no dependencies or license revisions. Development used synthetic fixtures without physical printers, deployment, or production services. Temporary resources and final cleanup are tracked outside the repository by the coordinator.

## Real database and HTTP acceptance

The fixture commit `db8cc43` adds two opt-in runners. Neither runner creates a PostgreSQL cluster or container. The caller supplies an explicitly disposable loopback database named `fixture` and owns its final disposal. Both runners validate the maintained migration catalog against the exact journal. The HTTP runner requires the real catalog through `0016_telemetry_operation_proofs` and a coordinator build marker matching its source HEAD. It records the built server entry checksum in its external ledger.

`test-postgres-browser-device-http.ts` exercises the maintained registry through a restricted login granted `farm_browser_device_runtime`. Its checks inspect the effective role and timeout settings, cause actual statement and lock timeouts, verify termination of an idle transaction after ten seconds, and check subsequent connection recovery. It also attempts forbidden schema creation, role escalation, and key deletion. Listing fixtures cover owner and administrator farm visibility, operator and viewer account visibility, UUID pagination, foreign-farm denial, role downgrade, and revocation. Controlled membership row locks test the listing's result after a blocked revocation or downgrade commits. All three SQL check groups passed against the exact maintained 16-entry migration journal.

`test-browser-device-http.ts` creates separate restricted logins for the current authentication, inventory, and browser-device capabilities. It seeds synthetic accounts and memberships, starts the built Nuxt application, and fronts its loopback HTTP listener with disposable HTTPS. The fixture reuses the existing `pairingHttpProxy` from the root pairing merge. Its claim-response-drop control is unused. The proxy forwards browser-device requests to the real server without intercepted API responses. Pairing remains disabled in the fixture.

The accepted Chromium scenario uses the actual login form and host-only session cookie, creates a nonextractable IndexedDB key, and completes a durable proof through the real handlers. Database assertions compare the private login reference with the distinct public proof-session UUID. The scenario also covers replay, wrong origin, caller-selected identity or purpose, foreign-farm denial, administrator approval, reload, logout and new-login recovery, current role downgrade, terminal revocation, explicit new-key enrollment, and account isolation. The test uses an administrative database connection only for assertions and deliberate fixture state changes. No browser receives database credentials.

The runner disables trace, video, and screenshot artifacts. It limits app diagnostics, keeps secrets in child-process environments, and writes its operational ledger outside the repository. Its cleanup stops owned Nuxt and browser processes, closes the TLS proxy, removes temporary TLS and browser output, and drops its restricted login roles. Durable fixture rows remain in the caller-owned disposable database until that database is removed. The runner does not release the PostgreSQL ownership window.

The real HTTPS Chromium scenario passed one test in 10.7 seconds without API interception at source commit `ae3b5d615f984f15658920b087f1736671608ca4`. The preceding full `bun run check:all` passed 234 Bun tests, 114 Node tests, formatting, types, and builds at `db8cc43`. The only subsequent code change added the fixture's Playwright base URL. Targeted type and formatting checks and a fresh build passed at the tested `ae3b5d6` candidate.

The accepted artifact identities are:

| Artifact                | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| Built server entry      | `747cf64d17924e1f82c2108df756a5ddc7fe77b01f60958301cfcdca08e4f880` |
| Build artifact manifest | `c26353a3fd7a3ccfdc7afddf039c2bd06bfe4dac000900be5ba4b293bc491bb4` |

The real browser scenario does not independently exercise membership or session revocation, or the exact 24-hour and three-attempt boundaries. Earlier registry tests cover those boundaries. The new SQL gate separately verifies listing results after membership revocation and downgrade commit behind row-lock waits. These distinctions prevent a passing browser flow from overstating its coverage.

The coordinator audit confirms removal of the task-owned PostgreSQL cluster, proxy, application and browser processes, TLS files, and restricted login roles. The original PostgreSQL instance remains healthy. Its system identifier, start time, database, user, and six-entry migration journal are byte-identical to the baseline. No Docker resources were created. The PostgreSQL ownership window is released. Local dependency and build-output cleanup remains underway, with no runtime work remaining. This fixture does not supply authenticated WebRTC, command dispatch, authorization-lease distribution, or offline immediate revocation.
