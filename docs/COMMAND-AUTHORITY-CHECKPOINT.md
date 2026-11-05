# Pause authority contract checkpoint

The initial sections retain the original contract-slice scope. The later
encapsulated-signing section records the subsequent Connector identity addition.

This slice adds pause-only contracts and an internal Connector capability verifier. It does not create an authenticated command path or grant permission to dispatch. Current database authorization, a server issuer, a control transport adapter, and the dispatcher remain separate integration work.

## Files and contracts

The implementation consists of five new files:

- `packages/farm-protocol/src/command-v2.ts`
- `packages/farm-protocol/src/pause-capability.ts`
- `packages/farm-protocol/src/control-session-binding.ts`
- `packages/connector/src/auth/pause-capability.ts`
- `packages/connector/src/control/printer-binding.ts`

A new focused Node test file and this checkpoint accompany those files. Existing v1 commands, index exports, read-only RTC contracts, SQL, runtime, CLI, native transport, and Connector identity APIs remain unchanged. No migration number is reserved.

Command v2 accepts only `pause` with empty arguments. It carries the exact text account identifier, a public transport UUID, an assignment UUID, and the capability and key identities. It has no internal login reference or synthetic account UUID. Browser signatures use P-256 P1363. Issuer signatures use Ed25519 with an explicitly supplied trusted verification key. No algorithm negotiation or embedded issuer key is accepted.

The new `pause-rtc` transcript includes both endpoint identities, browser and Connector nonces, offer and answer hashes, and SHA-256 DTLS fingerprints. Separate role domains distinguish browser and Connector proofs. Admission, capability, and command signatures also have distinct domains. Helpers check canonical public keys through native cryptography, including the P-256 point and matching thumbprints. Private-key signing helpers accept explicit trusted keys. They do not expose existing Connector private identity material.

Encoders and decoders enforce canonical JSON and an 8 KiB UTF-8 limit, including escaped characters. Decoders reject duplicates, extra fields, alternate encodings, private JWK fields, and excessive input structure before verification. Signing helpers check the final envelope limit before returning it. SDP hashes preserve exact UTF-8 bytes and line endings. Transcript metadata does not establish the actual negotiated DTLS certificate.

## Policy and Connector admission

The approved hard maximums are 30 seconds for a capability, eight seconds for admission, five seconds for a command, and two seconds for fresh printer state. Configured values can only decrease these limits. Zero, nonfinite, unsafe, and upward values fail validation. The five-second command and two-second state limits are contract policy only. No current driver or dispatcher enforces them in this slice.

The Connector verifier receives trusted issuer keys, an expected peer transcript, a local assignment, a peer-generation callback, and wall and monotonic clocks. These are explicit provisioning and adapter inputs, not authenticated network inputs supplied by this implementation. The future transport adapter must compare actual negotiated certificates and transcript bytes before supplying them.

Admission records its fixed deadline before validation or asynchronous cryptography and creates a fresh Connector nonce. The admission token is consumed before awaits, including failed attempts. The verifier requires the issuer signature, both endpoint proofs, fresh browser admission proof, exact scope and transcript, and the original nonce. Receiving a delayed proof never resets admission.

Successful verification returns a nonserializable opaque handle held in module-private state. Forged or copied objects provide no authority. Handle inspection rechecks deadlines, peer generation, and local assignment activity. Clock regression or an untrustworthy wall-to-monotonic comparison fails closed. An admitted capability remains bounded by its signed expiry and the control transcript lifetime. This does not provide immediate offline revocation or current database revalidation.

The local assignment registry permits only explicitly allowlisted canonical Moonraker origins. An assignment cannot be rebound, and retirement is terminal. This mapping is in memory. Durable disk provisioning, authenticated printer identity, and restart persistence are not implemented.

## Focused verification and remaining work

Isolated strict type checks passed for the new protocol and Connector files. Ten focused Node tests passed using native WebCrypto P-256 signatures verified with Node P1363 and Ed25519 issuer signatures. Coverage includes domain separation, invalid key material, strict canonical wire formats, escaped UTF-8 bounds, and downward policy validation.

Verifier tests cover complete issuer, dual-peer, and fresh-admission proof verification; one-use and forged tokens; serialization rejection; altered farm, account, key, assignment, nonce, and transcript; wrong issuer; expiry after asynchronous hashing; peer-generation changes; local retirement; clock regression; and exact capability expiry. Issuer keys and peer configuration are injected test fixtures. These tests do not establish a genuine server issuer, current database authority, actual WebRTC authentication, or printer eligibility.

No SQL, migration, route, runtime admission, driver, durable command journal, dispatch hook, or transport connection is added. Full repository checks remain pending integration because unrelated workspace dependencies are absent. No dependencies were installed, builds run, database or container resources used, network services started, or physical printers contacted for this slice. The coordinator tracks the small local verification artifacts and final cleanup outside the repository.

A future runnable pause gate must connect real login and approved browser keys to current transactional authority, authenticated direct WebRTC, durable replay-before-write, a fixed pause RPC, and fresh observed paused state on an isolated simulator. That acceptance would still leave other Phase 0 command and safety requirements incomplete. Nonextractable browser keys do not prevent hostile same-origin JavaScript from requesting signatures.

## Encapsulated Connector control proof

`ConnectorIdentity.signControlSessionProof({ binding, expectedAgentId })`
signs the maintained Connector control domain using its existing private
Ed25519 key. The method snapshots and validates the binding before asynchronous
key checks, fixes the Connector role, compares the independently supplied
enrolled agent and derives its own SPKI/fingerprint from the private key.
It does not export private key material or sign arbitrary command payloads.

Seventeen focused Node tests passed, including existing identity, credential and
read-only RTC signing tests. New cases cover native signature verification,
cross-role/domain rejection, foreign identity, malformed keys, input mutation
across awaits, public-property tampering and a private-export trap. Scoped strict
TypeScript and formatting passed. The first external TypeScript configuration
could not locate installed Node/Bun types; the corrected scoped configuration
uses the existing repository Node types without installing dependencies.

This is a possession-proof method only. The trusted caller still owns current
enrollment, transcript and actual DTLS verification, control-peer lifetime and
capability admission. Actual control signalling, browser/issuer composition,
printing-simulator pause and the final repository gate remain pending.
