# Separate pause signalling coordinator

The new internal coordinator manages only fresh pause negotiation contexts. It
never upgrades a read-only handle or binding and has no command/capability relay.
Its nominal handles belong to one coordinator instance. Endpoints explicitly
identify pause purpose and expose `bindControl`, not `bindReadOnly`.

`open` consumes the maintained pause negotiation reader and produces a fresh
server UUID/browser challenge. Its original eight-second transport admission
and thirty-second lifetime begin before the first authority read. Connector
attachment supplies a fresh current credential proof through the maintained
0014 issue/accept interfaces, capped by the original context and inbox lifetime.
Credential audience is configured separately from the pause binding audience.
Key/SPKI fingerprint, RFC7638 thumbprint, token hash, connection, JTI, origin and
scope must match the fresh challenge. Browser proof uses the distinct pause
transport P-256 domain.

The full authority identity, role and selected private printer key are pinned;
revalidation cannot replace them. Database budget expiry may only shorten the
context. No session, role or authority is derived from SDP or an incoming proof.
Both transport proofs are necessary before SDP relay. Only Connector offer,
browser answer, bounded direct ICE and terminal close are accepted, with exact
per-peer sequence order. Binding hashes the exact transmitted descriptions,
revalidates current authority after hashing, and emits the strict `pause-rtc`
binding to both endpoints. The binding is transport metadata, never permission
to invoke the dispatcher. Actual negotiated certificate verification and dual
control proofs remain the responsibility of the new endpoint peers.

Internal bounds are 64 contexts, two per key, four per Connector, eight actual
authority tasks and eight actual cryptographic/credential tasks. Four outstanding
relay frames and 32 KiB UTF-8 include the active awaited relay. Closing a context
settles queued frames, but an active frame and pending authority/credential
work remain accounted until their actual promises settle. These ceilings do not
replace the shared global upgrade/runtime admission caps when integrated.

Five-second authority revalidation is opportunistic. It cannot renew the
original lifetime or claim immediate offline revocation. Lifecycle checks follow
awaits and endpoint callbacks; reentrant close prevents subsequent relay or
binding delivery. Cleanup is idempotent and attempts both endpoint closures.

Focused tests use explicit current-authority/credential boundary doubles with
native P-256 and Ed25519 signatures. They are not PostgreSQL, JWT issuance, WSS,
DTLS or browser/Connector runtime acceptance. Wiring the dedicated pause context
into server admission, implementing separate actual control peers, then composing
issuer admission and the durable dispatcher remain required. No TURN, HTTP
command fallback, physical printer execution or publication is introduced.

Validation: ten focused tests pass on Node 24.20.0 and Bun 1.4.2; scoped
strict TypeScript and targeted formatting pass. These tests use boundary
doubles and do not establish actual PostgreSQL or network acceptance.

## Real PostgreSQL negotiation reader

At source `22a7216813ae7d293327332ea9f836cac2f648c1`, the maintained
negotiation fixture passed on Bun 1.4.2 against the existing isolated PostgreSQL
17.11 database with all 19 official migration checksums validated. The run took
4.60 seconds under a 30-second outer deadline. It exercised the actual restricted
role, current scope, a membership downgrade committed while the reader waited
on a row lock, unchanged session activity, and absolute session expiry during a
second observed lock wait. The fixture used maintained pairing and browser-key
approval but synthetic account/session/assignment rows. This is reader acceptance,
not coordinator WSS or control RTC acceptance.

The initial Node 24.20.0 invocation failed before opening any connection because
a maintained dependency uses a TypeScript parameter property unsupported by
Node's strip-only mode. That receipt was preserved; no production source was
changed to accommodate the runner. The subsequent Bun run passed. Independent
audits found the original database unchanged, roles restored, zero remaining
fixture backends and zero bridge errors; the logged connection high-water was
three. The caller-owned disposable database and bridge remain reserved for later
integration. No reset, migration, restart or command execution occurred.
