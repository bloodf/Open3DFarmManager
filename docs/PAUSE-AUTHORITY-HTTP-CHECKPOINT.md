# Pause authority HTTP checkpoint

The metadata issuer has two new POST boundaries: `/api/pause-authority/challenges`
and `/api/pause-authority/capabilities`. They call the maintained concrete issuer
service using only the session reference from the application's sealed login.
They neither accept commands nor upgrade a read-only RTC connection.

The private Nuxt configuration and sanitized environment placeholders are wired
with the runtime disabled by default. Restricted-role PostgreSQL HTTPS issuance
and generated Nitro startup passed in the isolated fixture described below.
No production issuer key is
created, and no service is enabled by this checkpoint.

## Boundary and custody

The challenge accepts only `browserProofWire`, `connectorProofWire` and
`admissionNonce`; capability issuance accepts only `admissionProofWire`. Each
canonical inner wire retains its maintained 8192-byte limit. The finite outer
JSON limits are 100 KiB and 50 KiB respectively to accommodate JSON escaping,
with a five-second monotonic body deadline checked around reads and parsing,
a pending-read timer, and a 1024-chunk ceiling. Malformed UTF-8,
duplicate keys, unknown fields, compressed bodies, query parameters and wrong
origins fail closed. Responses contain only validated challenge/capability
metadata and use no-store headers.

Maintained own-login authorization precedes the distinct authenticated
per-operation HTTP quota. The issuer still rechecks current account, session,
membership, browser key, enrollment, credential and immutable assignment under
its existing 0018 locks and deadlines. Eight process-wide HTTP requests include
body cleanup and actual pending service settlement; existing service limits
remain independent. Closing the service cannot convert an already committed
outcome into a claim of nonissuance. Lost responses must not be retried
automatically or redelivered with renewed deadlines.

The dedicated runtime uses a four-connection pool, exact 2 s statement/1 s
lock/10 s transaction settings and the existing `farm_pause_authority` role.
Startup checks both effective privileges and the login's role reachability,
including column grants and the two permitted definer functions. No role or
migration is created at runtime. The actual validator subsequently passed on the
retained disposable PostgreSQL 17 cluster: the minimal dedicated login was
accepted, additional `pg_monitor` membership and whole-table UPDATE were each
rejected, and restoring the minimal grants was accepted. Its temporary login
was removed and the complete role-name inventory returned to its 34-role
baseline. No application data or migration was changed. This narrow real SQL
gate does not establish authenticated HTTP issuance or every privilege negative.

A separately provisioned owner-only regular issuer file is limited to 4 KiB,
rejects symlinks and hardlinks, and contains only version, issuer, kid and
canonical Ed25519 PKCS8. Import makes the signing key nonextractable. An
independently configured SPKI pin must match through a native domain-separated
signature check before publication. No authentication secret, pairing key or
private key from a request is used. Temporary byte buffers are cleared;
JavaScript strings are not claimed to be securely erasable.

Startup reserves ownership while asynchronous work remains pending. Close
removes the published service immediately, prevents late publication and joins
startup and pool disposal. Failed pool cleanup is reported and retains the
startup reservation until process restart; it is not treated as a clean pool.

## Separate control peer required

A new bounded control peer must first negotiate exact offer/answer bytes and
verify actual DTLS certificates. The browser and Connector sign the separate
`pause-rtc` transcript while commands remain unavailable. The Connector then
creates the original eight-second admission nonce; the browser obtains and
signs the HTTP challenge and requests the capability. Only successful local
verification of the pinned issuer, original transcript, current local mapping,
peer generation and deadlines may produce a dispatcher handle. Command writes
remain browser-to-Connector RTC only, with the existing durable journal and
fixed driver safety boundary.

The HTTP slice does not implement control signalling, user confirmation,
Connector issuer-pin provisioning, current simulator state collection or
browser-to-Connector pause acceptance. Existing read-only status transport
remains read-only; there is no HTTP/server command fallback.

## Validation scope

Focused source tests exercise real login unsealing and native cryptographic key
import with explicit synthetic session/storage/SQL boundaries. They do not prove
actual DB authority, privilege enforcement, generated HTTP routes or a control
peer. The focused Node run passed 12 tests; targeted strict TypeScript passed for all
ten new TypeScript paths, including the plugin using existing generated Nitro
types. Formatting and whitespace checks cover the owned files. These checks
are not the full repository gate.
No publication or full Phase 0 completion is implied.

## Built HTTPS acceptance, 2026-11-05

The actual maintained HTTPS fixture passed once at
`b7abaaf8559ef3a6f7a89025f49c5c380e09de44` in 8.994 seconds. Its sealed private
Nuxt build contains 463 files, manifest SHA256
`5d658414969ab4b1b23d714084136433e0ce181860c8d48a92f3e48b7bf83074`, and server
entry SHA256 `0529069f2c036c72ccd83eff7e2345666e28fe6dc4aae7167bde7cb68079d8e9`.
Artifact and fixture source were the same immutable commit. The runner verified
all 19 official migration IDs and checksums before provisioning test identities.

Maintained HTTP login, browser-key approval, Connector pairing and immutable
printer assignment preceded actual challenge and capability issuance. Negative
authentication, origin, shape and body-limit requests allocated nothing. SQL
audit observed one pending challenge, then one issued capability; replay left
its stored hash and allocation count unchanged. A second pending challenge was
denied after actual owner logout, with SQL confirming session revocation and no
second issuance. The dedicated issuer signature and capability scope were
verified against an independent public pin.

The bridge recorded eight concurrent connections at its high-water mark, zero
rejections/errors and all connection closures. Independent post-run checks found
no remaining test backends and the original role inventory restored. The original
database identity, journal and table counts matched the prior baseline before
and after execution. Fixture rows remain in the separately owned disposable DB.
Runtime children, proxy and private issuer/TLS directory were closed or removed.

`check:all` passed at parent `6a208d883d8167dac3f7aab21d1fe46e00caec73`, including
424 Node passes with two explicit skips and 66 RTSP supervisor passes. The later
runner-only correction fixed external-layer dependency resolution and the app
source alias; root TypeScript and formatting passed, followed by the fresh
private build and this HTTPS run. The earlier two build failures are retained
as evidence, not counted as successful runs. Full CI on the final integrated
head remains required before publication.

Control transcript descriptions and certificate pins were synthetic. Browser
enrollment used the native fixture's nonextractable P-256 key, not IndexedDB key
custody. Chromium ignored the private fixture certificate error; native HTTPS
requests verified the private CA explicitly. This proves the issuer HTTP/DB
boundary, not browser TLS deployment, control RTC negotiation, command delivery,
driver execution or an isolated simulator pause. The separate control peer and
end-to-end pause remain pending.
