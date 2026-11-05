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

The separate runtime uses `browserDevices.enabled` and `browserDevices.databaseUrl`. Absent or disabled configuration returns 404. This slice does not add Nuxt configuration or enable the runtime. It leaves authentication runtime, protocol index exports, the homepage, pairing routes, and Connector pages unchanged. The configured pool has four connections, a three-second connection timeout, two-second statements, one-second lock waits, and PostgreSQL 17's ten-second transaction timeout. Startup requests the `farm_browser_device_runtime` role. Actual startup-role and timeout enforcement remain part of the pending PostgreSQL integration gate.

## Local key custody and recovery

The legacy single-key helper remains available. Explicit enrollment uses new IndexedDB slots under a separate enrollment prefix, scoped to the current account and farm. Each scope permits at most 32 local keys. Enumeration creates nothing, and creation never overwrites existing slots. Private keys remain nonextractable. Corrupt records fail before enrollment. If another tab inserts corruption during creation, the serialized insert can leave an orphan local key before later validation fails. The helper does not promise rollback of that committed insert.

The page loads current account and farm authorization before creating a key. It repeats scope checks around challenge receipt, signing, and proof completion. Navigation, detected account changes, and authorization failures clear displayed authority and cancel pending work. An explicit resume action uses the same unproven local key after reload. Owner and administrator actions require fingerprint confirmation, while the server independently checks current authority.

Successful proof does not approve a new key. A pending record keeps its original 24-hour lifetime. Every key permits three lifetime challenges, including failures, expiry, and successful recovery. A new login can prove possession of the same approved key through recovery, subject to current authorization and that lifetime limit. Recovery does not extend authority or the pending lifetime. Lost storage requires a new key and explicit approval. It does not replace or revoke older records. Revocation remains terminal.

## Verification and remaining gates

The first coordinator `bun run check:all` passed formatting, type checks, 227 Bun tests, 107 Node tests, and both builds. Seven HTTP service tests passed with 46 assertions. They use real login and sealed-cookie cryptography with synthetic session and registry storage. Coverage includes authentication before quota, fixed route purpose, operation namespaces, malformed bodies, the five-second body deadline, and rejection of the seventeenth concurrent request.

Six enrollment tests passed against the built Nuxt page with real IndexedDB and WebCrypto. API responses are intercepted except for the disabled-route check. Coverage includes verification of the browser signature in the test process, reload persistence, private-export denial, account isolation, corrupt storage, and account changes after challenge receipt. A held IndexedDB read/write transaction exercises an account change while a cursor read is pending. Explicit resume keeps the same unproven key. Explicit recovery keeps the same approved key after reload and produces a verified signature, without establishing real new-login semantics. Administrator approval and revocation require the confirmed fingerprint. Unintercepted GET and POST requests to the actual unconfigured Nuxt endpoints both return 404.

The page displays the 24-hour pending lifetime, 60-second proof lifetime, and three-challenge limit. An earlier combined run of three enrollment tests with the eight existing browser key, signing, and boundary tests passed all 11 tests.

These tests do not establish browser authority against a real PostgreSQL-backed login or enrollment service. This slice has not exercised the new listing SQL, membership races, the actual runtime pool role, or transaction timeout against PostgreSQL. A separate database window must verify those checks and actual login-to-HTTP integration. Earlier registry persistence and migration evidence remains in [the browser key checkpoint](BROWSER-KEY-CHECKPOINT.md). Full Phase 0 still requires authenticated WebRTC, signed command rejection, revocation, and outage recovery end to end.

No dependencies or license revisions changed. Development used synthetic fixtures without physical printers, deployment, or production services. Temporary resources and final cleanup are tracked outside the repository by the coordinator.
