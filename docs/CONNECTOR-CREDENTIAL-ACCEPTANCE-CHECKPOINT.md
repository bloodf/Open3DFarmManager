# Current-state Connector credential acceptance checkpoint

The internal slice passed pure signing/type checks and real PostgreSQL acceptance through the official contiguous 0014 journal. No HTTP route or authenticated transport is connected by this slice.

`PostgresConnectorCredentialAcceptance` validates a real EdDSA JWT against the exact immutable issued metadata and current approved enrollment, then consumes a fresh persisted Ed25519 proof. A token alone never authorizes a connection, telemetry write or printer command.

## Internal contract

Trusted server configuration supplies issuer, audience, public signing keys, exact credential lifetime, canonical origin, proof lifetime (1–60,000 ms) and a fixed purpose: `signalling` or `telemetry-ingestion`. The constructor snapshots the key map. Request parsing bounds JWT input to 8,192 characters. At most sixteen configured verification keys are accepted.

`issue` takes the token, agent ID, farm ID and connection ID. The connection ID must be generated and owned by the trusted server/transport caller, and tied to its intended operation. Browser input cannot establish that authority. `accept` additionally requires the exact challenge and signature. The narrow `ConnectorIdentity.signCredentialProof` signs that domain without exporting its key.

The canonical, domain-separated payload binds the exact agent, farm, public key, fingerprint, key thumbprint, credential `jti`, SHA-256 of the compact token, configured origin and audience, purpose, server-owned connection ID, monotonic generation, random 256-bit nonce and deadline. No compact JWT or private key is stored in the database or printed.

The JWT verifier requires the configured issuer/audience and EdDSA/Ed25519 key. The database check additionally matches actual issued `jti`, signing key ID, issuance/expiry times, fingerprint, thumbprint and exact enrollment identity. Revoked enrollment or any revocation tombstone denies issuance and completion. A correctly signed but unissued credential is denied.

## Serialization and bounds

Lock order is enrollment SHARE, immutable credential SHARE, then proof slot UPDATE. Revocation uses pairing, enrollment UPDATE, then credential SHARE. Acceptance never acquires a pairing lock, so both operations serialize at enrollment without a reverse pairing dependency. A successful acceptance can precede a revocation, or a committed revocation can deny it. No result promises continued authority after that point.

Migration 0014 keeps one proof slot per issued credential. New requests cannot allocate unbounded challenge rows. A live pending slot is returned only for the same exact context; another context receives a bounded busy/retry response until the slot expires or becomes terminal. Replacement increments generation and never resets the time watermark or observed credential-expiry marker. Expiry and consumption do not permanently brick an otherwise current credential; a new nonce is required for the next proof.

A verified token permits at most one challenge/signature operation per second per credential. Three bad signatures reject that challenge. Wrong context, nonce or payload cannot consume it or increase its signature-failure counter. A stolen valid JWT can cause bounded temporary denial of service by spending its credential's rate or bad-signature budget; it cannot produce acceptance without the private key. A fresh challenge is available after the rate deadline. JWTs that fail cryptographic verification do not consume proof attempts or move that rate deadline. Continuing abuse with a stolen valid token can starve the legitimate bearer; this policy bounds work and allocations, not availability against bearer theft.

Each instance admits at most 32 calls. Thirty-two fixed transaction advisory slots also bound concurrent cryptographic verification across processes connected to the same PostgreSQL database. These are concurrency limits, not an external request-rate service. A future HTTP adapter still needs bounded request admission and must not queue unbounded work. SQL locks and statements have short timeouts. The least-privileged acceptance role cannot enroll, approve, revoke, issue credentials or write telemetry.

Clock checks occur after lock waits, asynchronous JOSE work, synchronous Ed25519 verification and proof writes. Expired credential observations remain terminal through clock regression. Proof consumption is atomic and successful output waits for COMMIT. A final clock check also rejects a result whose deadline passed while COMMIT waited; that observation is retained without returning authority. A consumed proof cannot be replayed through another process or service instance. A commit failure cannot return success.

The accepted result contains only exact context, identity, acceptance time and expiry. It is a point-in-time consumed-proof receipt, not a durable verified flag, transport lease or command permission. Later requests, leases and sockets require appropriate current-state rechecks. An offline Connector cannot immediately learn remote revocation. Connector safety stays local; live status, camera and commands remain browser-to-Connector WebRTC with no HTTP/server command fallback.

## Verification

The dedicated disposable-fixture runner validates the official contiguous migration journal through 0014 before invoking real PostgreSQL tests. It does not backfill migration history or use the original manually prepared fixture as acceptance evidence. The real catalog included pending 0015 source, but an immutable first-fourteen migration snapshot was applied by the official runner. 0015 was not applied or validated in this slice.

Three pure Node tests passed for exact canonical signing/domain separation, changed credential/context bindings, wrong key/trust/deadline denial, and strict challenge bounds. Root and focused strict TypeScript checks passed. Eleven real PostgreSQL groups passed before and after official 0014 down/up:

- Actual JOSE-issued metadata and live identity signing, cross-instance pending reuse, one concurrent winner and consumed-proof replay denial.
- Token-alone, altered token, wrong farm/agent/origin/audience/purpose/context/nonce denial without burning an unrelated challenge.
- A correctly signed but unissued `jti` denied against exact metadata.
- One-second rate limit, three bad signatures, bounded replacement and retained generation/watermark.
- Proof expiry and replacement, durable credential expiry and clock-regression denial.
- Deferred COMMIT failure rolling back consumption, followed by a known-rollback retry.
- Proof expiry while waiting for its row lock or consumption write, with no success and a retained watermark.
- Fixed same-database cryptographic admission returning busy without unbounded challenge allocation.
- Both actual 0011 revocation/acceptance race orders, serialized at enrollment.
- Token expiry after JOSE, Ed25519 verification, SQL writes and COMMIT, retained through clock regression.
- Restricted SQL privileges and immutable monotonic proof slots; no enrollment, revocation, issuance or telemetry write capability.

A separate fresh-process verifier passed after an actual restart of the isolated PostgreSQL cluster: the pre-restart pending proof completed once, and pre-restart consumed proof remained unusable. All fourteen migration journal entries were byte-equal before/after down/up and restart. The synthetic private restart fixture was removed; it contained no private key and its tokens were never logged. Restricted fixture roles and pools were removed, the temporary cluster and proxy were stopped and removed, and the original shared fixture remained healthy. Bounded logs/checksums and a local resource ledger preserve the evidence.

`bun run check:all` passed on base `741dd1f` with the complete 0014 source and the separate frozen, uncommitted 0015 source: formatting, root/Nuxt types, 222 Bun tests, 110 Node tests with no failures/cancellations/skips, and both production builds. Required output license notices matched source bytes. That gate validates 0015 static/unit/build behavior only; its PostgreSQL acceptance remains separate and unclaimed. This factual checkpoint update did not change implementation. No HTTP flow or authenticated telemetry write is claimed: a later operation must bind exact request bytes and consume the proof with authorization and its write in one transaction, rather than reuse this point-in-time receipt.

The operation-bound extension in migration 0016 shares this transaction implementation. The current source and its regression runners require the official schema through 0016; the 0014 validation above remains historical evidence for its original committed source. Generic v1 APIs retain their input/output contract and do not authorize a later operation.

The schema-0016 regression run passed all twelve generic credential groups, including durable retention of an expiry observed before a regressing lock sample (`b2a5169`). Atomic telemetry acceptance is recorded separately in [its checkpoint](ATOMIC-TELEMETRY-CHECKPOINT.md). This result does not replace the pending integrated current-head gate.
