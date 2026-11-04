# Browser key persistence checkpoint

Review of the Phase 0 task list identified E2.3.2 as a bounded continuation of the existing E4.3.2 signature implementation. Independent login, registration and device revocation still require server integration; they are not simulated as working product features here. No original private planning documents or deployment details are reproduced.

## Completed local flow

The browser-only `app/utils/device-key.ts` uses the existing protocol's WebCrypto P-256 generator and native IndexedDB to retain a nonextractable private key. Keys are scoped by farm and user IDs supplied by a future authenticated caller. This scope is storage organization, not an access-control boundary against same-origin JavaScript.

A read/write transaction chooses one winner when tabs generate candidates concurrently. The helper returns only after transaction completion, checks stored algorithm/usages/extractability and verifies that the private/public pair matches. Invalid records and unavailable storage fail with a fixed error. It never overwrites a corrupt record or falls back to an ephemeral key. The browser APIs follow the documented [IndexedDB transaction lifecycle](https://developer.mozilla.org/en-US/docs/Web/API/IDBTransaction) and [CryptoKey properties](https://developer.mozilla.org/en-US/docs/Web/API/CryptoKey); no new dependency or cryptographic format was introduced.

The existing Chromium-to-Node signature test now persists a key, reloads the page, confirms the same public JWK, confirms private export is denied, signs a synthetic command and verifies acceptance once followed by replay rejection in Node. Other browser tests cover simultaneous tabs, separate scopes, inconsistent key pairs, denied storage and aborted insertion. The original homepage/hidden-route test remains in the suite.

## Boundaries and next dependencies

- No route or UI automatically invokes key creation. A future enrollment flow must use authenticated farm/user IDs and explicitly register the public key before any device is trusted.
- No server registration, device identifier assignment, account authorization, remote revocation, WebRTC or printer dispatch is supplied by this helper. Node verification in the browser test uses synthetic trusted context.
- Clearing browser storage or browser eviction loses the key. The future registration flow must detect that it differs from an enrolled public key and require enrollment again; it must not silently replace server trust. Browser persistence is not a backup or a crash-durability guarantee.
- A nonextractable key still permits hostile same-origin JavaScript to request signatures. CSP, XSS prevention, authenticated UI state and server/Connector authorization remain necessary.
- Chromium was verified locally. Other browsers, private browsing behavior, blocked upgrades and actual quota exhaustion remain unverified. Failure injection covers a denied open and aborted insert, not every browser failure mode.

The broader review still leaves E1.2 database/migrations and E2.1 login as dependencies for pairing, agent ingestion and device registration. Existing telemetry decoders and queue have local integration tests, but authenticated ingestion and outage-drain acceptance require their server endpoints. E0 simulator acceptance and the network/WebRTC scenarios remain behind the pending container permission. This checkpoint closes a local persistence/signing flow, not Phase 0 or the complete device-management feature.
