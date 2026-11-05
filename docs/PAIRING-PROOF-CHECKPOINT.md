# Durable pairing proof checkpoint

This slice verifies possession of the Ed25519 private key belonging to one persisted, pending pairing request. Successful verification is an internal result, not a session, device token, enrollment approval or authenticated Connector transport.

## Signed contract

The server-issued challenge contains the pairing's internal agent ID, canonical public SPKI and derived SHA-256 fingerprint, a random 32-byte nonce, issue/expiry times, version, and the origin and audience from server configuration. Ed25519 signs the UTF-8 bytes of `Open3DFarmManager/pairing-proof/v1` followed by a NUL byte and the existing canonical JSON serialization of the challenge. This domain differs from existing Connector transport proofs and browser commands.

The contract accepts canonical HTTPS origins, with HTTP permitted only for loopback simulators. Paths, credentials, trailing slashes and opaque origins are rejected. The server never accepts a submitted origin or audience as authority. The Connector signing primitive requires matching independently configured origin/audience, its own matching key/fingerprint, and a current challenge. It uses Node's existing cryptography implementation and adds no dependency.

## Durable lifecycle

Migration `0008_pairing_proofs` stores challenges separately from requests. The pairing row supplies the immutable identity and is locked before the proof row. Both issue and completion require the unguessable device code, compared by its stored hash. A public agent ID, fingerprint or nonce cannot address an attempt alone.

A challenge lasts at most 60 seconds and never outlives its pairing. A repeat issue request redelivers the same pending challenge at most once every five seconds. Expired or rejected challenges can be replaced while pairing remains pending, with at least five seconds between allocations and at most three attempts total per pairing. There is one pending challenge and at most one verified proof per pairing, enforced by unique indexes. Exhausting three attempts requires starting a new pairing. Changed server origin/audience also requires a new pairing instead of reusing the previous server's proof.

A transaction advisory lock bounds active challenges to 1,000 across instances. Only pending, unexpired attempts count against active capacity. At most three retained records exist for each pairing; this does not bound total historical storage because the pairing table retains tombstones. Retention and HTTP abuse controls still need a separate policy.

Completion reconstructs the expected signed payload from the current locked database rows and configured origin/audience. Unrelated pairing, nonce, identity, origin or audience input is denied without consuming a challenge. An exact addressed challenge with an invalid signature consumes that attempt as rejected. This policy requires possession of the secret device code and cannot be triggered using public challenge fields alone. Someone who obtains that secret can exhaust their pairing's attempts; start a new pairing after resolving the disclosure.

The completion transaction samples time after both locks and again after cryptographic verification. Terminal pairing states, expired challenges and clock rollback cannot verify a proof. Successful verification and one-time consumption commit together. Failed commits report storage unavailable and preserve the previous state, allowing retry. Terminal proof records cannot be reset, edited or removed by the runtime capability.

The `farm_pairing_proof_runtime` role has no login or elevated cluster privileges. It can read/lock pairing requests, read/insert proof records and update only proof lifecycle and polling fields. It cannot approve pairings, edit pairing identities, create memberships, touch accounts or create schema objects. These permissions protect trusted backend responsibilities; they do not isolate data from another holder of the same backend credentials. A backend capable of directly updating proof status remains trusted, so no downstream service may treat a caller-provided boolean as proof.

## Verification

`testPostgresPairingProof(admin, port)` uses the caller-owned disposable loopback PostgreSQL fixture with migrations 0001 through 0008. It creates and removes its restricted runtime login role and closes its connections. Synthetic rows remain for caller teardown. Its controlled child process completes a committed challenge through a new pool without an in-memory registry, and replay from the original process is denied. PostgreSQL itself is not restarted.

Acceptance checks cover:

- Exact persisted identity, domain, origin/audience and device-code binding; unrelated or malformed input leaves legitimate challenges usable; concurrent completion verifies once.
- Wrong-key signatures consume only their addressed attempt; five-second throttling, three-attempt exhaustion, expiry replacement and old-nonce replay follow the recorded lifecycle.
- Exact deadlines, expiration while waiting for either row lock, terminal pairing denial and a challenge shortened to the pairing's remaining lifetime.
- Deferred commit failure, fresh-process completion/replay, restricted privileges, immutable tombstones, and concurrent allocation at the 1,000-active-proof boundary. The last test inserts synthetic parent requests directly to isolate this layer's limit from the independently tested pairing-start limit.

A fresh isolated synthetic cluster applied migrations 0001 through 0009 through the official migration runner. The runner validated all nine journal entries against the catalog. The updated pairing CLI passed 16 PostgreSQL check groups and this proof helper passed 11 groups. The helper now also uses a stepped clock to cross the deadline or regress immediately after real Ed25519 verification; both attempts become terminally expired and cannot be replayed. Exact applied checksums are retained in the local task evidence. The earlier shared fixture with manually applied migrations is not evidence of journal validation.

The official runner verifies migration 0009 down/up and the final journal. `bun run check:all` passed formatting, root and Nuxt type checks, 213 Bun tests, 100 Node tests, and both production builds. The focused Connector build also preserves and byte-compares the project and Zod license notices alongside the bundle. Temporary database resources are stopped and removed after acceptance, while preserving the original shared fixture.

## Approval and claim integration

`PostgresPairing.decide` requires a current verified proof before approval. `claim` requires the same proof before returning a real credential and rechecks its deadline after the enrollment lock, asynchronous signing and metadata/consumption writes. Each check reads the proof inside the transaction holding the shared pairing-row lock order. Origin and audience come from mandatory server configuration. Both stages must finish inside the at-most-60-second proof lifetime; an expired verified challenge cannot be renewed, so recovery requires a new pairing. This strict prototype policy does not automatically revoke an existing enrollment after proof expiry.

Migration 0009 records observed proof expiry in an immutable `proof_expired_at` marker on the pairing request. Approval or claim commits that marker before denying an expired proof, even if approval committed earlier. Subsequent clock regression cannot restore usability. Session expiry observed during the proof lock wait is also committed as terminal session revocation. Denial grants no authority and does not require proof, but retains session, membership and fingerprint checks.

`ConnectorIdentity.signPairingProof` delegates internally to the reviewed signer with its existing private key. Its input excludes a private-key parameter; a runtime property with that name also cannot replace the internal key. Reloaded identities produce the same signature for the same challenge. Public JSON and inspection expose only public identity metadata. The method does not export the key, sign arbitrary bytes or perform network access.

The verifier SQL role remains trusted, as does a backend that can directly manipulate authorization records. Verified database state is meaningful only through the reviewed service boundaries; a submitted boolean or standalone result is not a transport credential.

Real credential issuance is integrated atomically with consumption as described in the [issuance checkpoint](CONNECTOR-CREDENTIAL-ISSUANCE-CHECKPOINT.md). Delivery/recovery/revocation semantics, independent-session approval endpoints with origin/CSRF and abuse checks, and browser/Connector simulator flows remain pending. This slice sends no printer command and provides no HTTP/server command fallback.
