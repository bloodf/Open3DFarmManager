# Separate pause transport contracts

This source slice defines a separate pause signalling protocol and bounded
control DataChannel messages. It does not create a peer, read current database
authority, issue a capability or dispatch a command. Existing read-only domains,
wire limits and protocol exports remain unchanged.

## Signalling

`pause-signalling.ts` provides strict canonical client/server codecs with a
12,288-byte UTF-8 limit. Fresh browser admission signs a distinct
`pause-signalling-admission` challenge with the exact immutable assignment,
account, farm, Connector, key, origin, audience and transport scope. Its proof
uses the separate `Open3DFarmManager/pause-transport-proof/v1` domain and native
nonextractable P-256 signing. Cryptographic verification checks the public-key
thumbprint; callers still pin the fresh expected scope independently.

The protocol includes standalone pause Connector inbox begin/proof/ready frames,
so a pause context need not pass through a read-only wrapper. Connector
challenges retain the existing generic `signalling` credential proof purpose.
The context challenge's connection, farm and Connector must equal its outer
context. Assignment is pinned in context metadata and later in the dual control
proofs; generic credential PoP is not assignment or command authority.

Only bounded SDP/ICE/close metadata is reused. The server must bind each such
frame to the freshly admitted context and its immutable pause purpose. There is
no client-submitted completed binding, command or capability on this signalling
wire. Server `pause.binding` carries the existing strict `ControlSessionBinding`.
All ready/context leases contain `commands_enabled:false`.

The browser transport challenge lasts at most eight seconds and advertised peer
leases at most thirty seconds. Existing generic credential challenges retain
their existing schema lifetime; actual wrappers must cap all processing and
retry against their original eight-second transport admission deadline. A retry
frame is scheduling metadata, never permission to renew a deadline. No codec
consults a clock or grants authority.

## Control channel

`pause-channel.ts` admits one canonical inner proof, capability, admission proof
or signed command per frame. Existing inner 8,192-byte limits are enforced by
the maintained inner decoders. Each inner transport UUID must equal the outer
UUID. Frames have finite sequences from zero through 255. A 17,408-byte outer
UTF-8 cap is derived from twice the maximum already-canonical inner JSON size,
plus 1,024 bytes for fixed envelope fields. Output encoding enforces the same
byte limit; the inner cap is never widened.

`control.proofs-ready` denotes peer-proof readiness only. The local genuine
capability verifier determines capability acceptance. `control.admission-nonce`
carries the Connector's independently generated nonce and at most eight-second
interval. `control.result` carries only command UUID and one public audit
outcome: rejected, not-sent, applied or outcome-unknown. A malformed command with
no validated correlation UUID must close rather than invent a result. No raw
error, diagnostic or secret field is allowed.

These codecs enforce shapes and correlations, not message ordering, role,
monotonic freshness or total outstanding work. Future peers must independently
enforce those properties, reject duplicate/out-of-phase messages, bound queues
including active asynchronous validation, verify actual negotiated certificates
and both exact control proofs, and close on terminal lifetime or revocation.
Commands cannot be buffered before capability admission.

## Required composition

The intended order is a new authenticated control peer and dual control proofs,
then a Connector-generated admission nonce, current-DB issuer challenge,
browser admission signature, committed signed capability, genuine local verifier
and finally the durable dispatcher/fixed driver. Issuance cannot be a
prerequisite for generating the very peer proofs that issuance requires.

The original peer lifetime remains capped at thirty seconds. Later capability
admission has its own at-most-eight-second interval, further capped by that
peer/binding expiry. Neither HTTP nor signalling carries command payloads;
there is no TURN or server command fallback.

## Evidence and remaining gates

Focused Node and Bun tests exercise native P-256 signatures, purpose/domain and
assignment tampering, canonical parsing, escaped UTF-8 output limits, bounded
individual inner frames and transport correlation. Scoped strict TypeScript
covers these new modules and their test. These are contract checks only.

Server authority/routing, new browser and Connector peers, actual DTLS/dual-proof
exchange, issuer/dispatcher integration, complete repository checks and isolated
Klipper/Moonraker acceptance remain pending. No production command acceptance,
physical-printer execution or publication is established by this slice.
