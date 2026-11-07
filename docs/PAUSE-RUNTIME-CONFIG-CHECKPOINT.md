# Pause runtime configuration checkpoint

This slice prepares the production configuration for actual pause composition. It adds an optional
pause section to the Connector runtime configuration, keeps the exact provisioned printer handles
available to a future relay and driver, and loads the trusted issuer keyring as verification-only
public keys.

Nothing in this slice enables a pause. No command path is opened; existing `commandsEnabled`
flags remain false. No issuer issuance flow or signalling audience derivation is introduced. Public pause metadata
reports advisory availability only.

## Runtime configuration

`readAgentRuntimeConfig(path, credential)` keeps its existing call form, its existing returned
`collection`, `telemetry`, `assignments` and `signalling` values, and its existing synchronous
behaviour. The returned assignment snapshots and their order are unchanged.

The runtime JSON accepts one additional optional key:

```json
{
  "pause": {
    "version": 1,
    "signalling": {
      "endpoint": "wss://farm.example/api/signalling/pause-connector",
      "origin": "https://farm.example",
      "audience": "pause-audience",
      "credentialAudience": "credential-audience"
    },
    "issuers": [
      {
        "issuer": "farm:pause-issuer",
        "kid": "issuer-1",
        "publicKeySpki": "<base64url Ed25519 SPKI>"
      }
    ]
  }
}
```

### Migrating an existing version 1 configuration

This change is incompatible with the earlier keyring-only version 1 `pause` section.
Keeping that old section causes strict configuration parsing to reject Connector startup,
before telemetry starts. Before upgrading, either remove the entire optional `pause`
section to continue read-only operation, or provision all four signalling values:
`endpoint`, `origin`, `audience`, and `credentialAudience`. Provision the two audiences
independently from their respective server owners; do not infer or copy one from the other.
Adding these settings does not enable product pause or establish runtime acceptance.
Private and external configurations have not been inspected for migration needs.

An absent `pause` key means no authority. The read then performs no cryptographic work, opens no
socket and starts no runtime task. A present `pause` key is parsed strictly by
`packages/connector/src/config/pause.ts` and returned as a deeply immutable value. The parsed
section carries the issuer keyring and explicit signalling settings. It never carries a private key,
token or secret. The canonical HTTPS origin and exact same-host WSS pause Connector endpoint are
required. Pause and credential audiences are independently provisioned; neither defaults from
readonly configuration, the other audience, a key, a frame or a token.

The pause section is refused when it is not version 1, when the keyring is empty or larger than
eight entries, when two entries share the same issuer and key id, when the issuer or key id does
not match the shape the pause capability already uses, when an entry carries an unknown key, or
when the public key encoding is not a canonical Ed25519 SubjectPublicKeyInfo. A wrong algorithm, a
private PKCS#8 payload, a malformed DER and a noncanonical base64url encoding are all refused
before any key import.

## Key loading

`loadPauseIssuerKeys(config)` is the only place where a key is imported. It is explicit and
asynchronous, and it is separate from the synchronous configuration read. It produces the issuer
list the existing pause verifier already accepts: a public Ed25519 key with exactly the `verify`
usage, never extractable.

The loader never signs, never generates a key, never fetches anything and keeps no global cache.
An absent configuration returns an empty list without touching the cryptographic API. Every explicit
load imports its own keys, so a later load never reuses a stale key object.

The verifier and the relay keep their current contract. This slice does not change the pause
protocol, the capability shape, the admission flow, the dispatcher, the command journal or the
Moonraker pause driver.

## Local printer mapping

The runtime read previously discarded the opaque printer binding that the local registry produced.
The exact provisioned handles are now retained privately and exposed through one narrow resolver:

```ts
bindingFor(assignmentId: string): PrinterBinding | undefined
```

The resolver is backed by the same registry and map used during the read. It returns the same
handle object on every call, and `undefined` for an unknown or foreign assignment id. The handle is
never reconstructed, copied or serialized: it keeps the opaque behaviour of the local binding, and
serializing it throws.

A local mapping is a provisioning fact. It states that this Connector was configured with that
assignment. It never states that the server currently authorizes that assignment, and it is never
used as a source of remote authority. The relay still re-reads the binding and compares it with
the authenticated control binding before it uses it.

## What stays pending

This slice deliberately stops before runtime wiring. The following work remains open and is not
started here:

- Runtime signalling: the pause signalling mode still needs the production composition that
  consumes the loaded issuer keyring.
- Driver observation: the Moonraker pause driver still needs its production observation source and
  its ownership contract against the dispatcher.
- Command journal: the durable journal still needs its production owner and its retained handoff
  in the pause path.
- User interface: the pause surface still needs the reviewed client wiring and its accessible
  copy.
- The control transport and driver ownership contract still need review before the runtime
  composition is allowed to bind the relay to this configuration.

No `commandsEnabled` value is introduced and no command is enabled by this configuration. A
configured issuer keyring proves trust in a signer, not the permission to pause a printer.

## Validation boundary

Focused Node tests in `tests/node/pause-runtime-config.test.ts` cover the consumer relevant
invariants with genuine cryptography and temporary private configuration files. They cover the
optional default, the keyring bound, duplicate issuer and key id, wrong algorithm, private payload,
malformed and noncanonical encodings, the immutability of the parsed configuration and of the
loaded issuer list, the handle identity and mapping equality of the local resolver, the refusal of
unknown and foreign identifiers, the refusal to serialize a handle, and a real capability signed by
an issuer key that verifies against the loaded verification key.

The loader independently validates and copies the complete pause configuration and keyring before
its first asynchronous import. Tests mutate the caller's entries and append another key during loading, and verify that
the original issuer identities and key count survive. Invalid keyrings are rejected before any
import, including when a caller bypasses the synchronous runtime parser.

The complete repository gate, the Bun unit suite that consumes
`readAgentRuntimeConfig`, and the integrated pause acceptance flow remain pending on the
coordinator's head. No PostgreSQL, Docker, browser, native, simulator or physical printer was used.

## Public pause metadata

`GET /api/signalling/pause-metadata` returns only the existing three-field metadata shape, with
`no-store` caching. It reports the pause facade's origin and pause audience only while the current
live signalling runtime matches its origin, credential issuer, credential audience and database
identity. Closed, aborted, missing or mismatched owners return disabled. This read does not admit
a connection or create a pause coordinator, and it is neither authorization nor a readiness proof.
