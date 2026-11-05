# Connector proof-of-possession checkpoint

The server side of the existing Connector identity proof is now implemented as `ConnectorProofChallenges`, an internal, single-process challenge registry. It is a local continuation toward authenticated pairing/signalling. It does not create an authenticated agent context, approve pairing, issue a JWT, accept telemetry or expose an endpoint.

## Implemented flow

The service accepts a binding supplied by future trusted server code: farm, agent, connection, public Ed25519 key, matching SHA-256 fingerprint and non-revoked state. Structural/key checks are not proof that this binding was authorized. A random 32-byte challenge is stored alongside a copied binding and expiry. The caller explicitly supplies a lifetime; this bounded prototype accepts at most 60 seconds and 1,000 outstanding challenges. These resource limits do not choose the separate offline authorization policy.

The existing disk-backed Connector identity signs the challenge using its existing domain-separated Ed25519 `signProof` method. The server checks the signature with Node's standard crypto implementation against the expected key. The nonce-to-binding registry ties the proof to the original connection, farm, agent and fingerprint; those identifiers are not additional fields in the signed message. The current supplied binding must still match and must not be revoked.

A pending nonce is deleted before validating the response signature/binding. A valid-clock lookup therefore allows only one completion attempt, including a failed signature. Unknown, expired or consumed challenges fail. Clock rollback fails closed. Connection teardown can discard its outstanding challenges. Restart loses the registry and invalidates all pending challenges rather than accepting them without state.

## Validation

Seven Node tests exercise identity-file reload through challenge issue/sign/verify, replay rejection, changed scope/key/revocation, wrong signing key, wrong signature domain, malformed encoding, expiry, clock rollback, registry restart, capacity, invalid issuance input, copied bindings, connection teardown and two completions yielding exactly one success.

All tests use temporary or in-memory synthetic keys and no network. The registry is actual ephemeral service code, not a persistent enrollment database. The concurrent-completion test establishes one-process synchronous ordering only; it does not establish distributed atomicity. `check:all` passed with 148 Bun and 61 Node tests, lint, typecheck and builds. Browser tests were unchanged and not repeated at this checkpoint.

## Remaining security dependencies

A future authenticated middleware must verify credentials and retrieve the current authorized agent/farm/key record before issuing or completing a challenge. Passing a caller-invented binding proves nothing about farm membership. Enrollment approval, JWT verification, server-side revocation lookup and rate limiting remain unimplemented.

The Connector must authenticate the server/transport before signing challenges. This helper does not implement channel binding, server authentication or relay-attack defenses; domain separation alone supplies none of those. Do not wire the service into a public route or treat its boolean result as sufficient authorization.

For multiple server processes, challenge issue and completion must use the same owning connection/process or a reviewed shared atomic store. A restart requires a fresh challenge. There is no production storage, automatic credential issuance, physical action or change to the pending offline revocation design.
