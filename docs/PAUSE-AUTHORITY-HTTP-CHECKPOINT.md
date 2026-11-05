# Pause authority HTTP checkpoint

The metadata issuer has two new POST boundaries: `/api/pause-authority/challenges`
and `/api/pause-authority/capabilities`. They call the maintained concrete issuer
service using only the session reference from the application's sealed login.
They neither accept commands nor upgrade a read-only RTC connection.

The private Nuxt configuration and sanitized environment placeholders are wired
with the runtime disabled by default. Actual restricted-role PostgreSQL HTTP
validation, generated Nitro startup and
`check:all` remain separate integration gates. No production issuer key is
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
