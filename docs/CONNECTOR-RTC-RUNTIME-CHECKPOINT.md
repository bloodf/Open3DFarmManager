# Connector RTC runtime composition

`run --config --credential-file --data-dir` can now compose the maintained
authenticated signalling client and RTC status sender alongside its existing
Moonraker collection and durable telemetry drain. It shares the existing
subscriptions through raw observation and unavailability callbacks. It does not
open a second Moonraker subscription or duplicate telemetry records.

The private runtime configuration accepts an optional `signalling` object:

```json
{
  "endpoint": "wss://farm.example/api/signalling/connector",
  "origin": "https://farm.example",
  "audience": "configured-farm-audience",
  "retryMinMs": 1000,
  "retryMaxMs": 30000
}
```

The endpoint must exactly match the configured HTTPS origin and maintained
Connector path, without credentials, query or fragment. Configuration and the
bounded JWT payload lookup ID are validated before queue creation or network
access. This lookup does not verify the JWT or confer authority. The server
still verifies the credential, PoP and current records, and both RTC peers
independently verify the v2 assignment digest and actual DTLS peer identity.
There is no endpoint discovery or HTTP status/command fallback.

One session is active at a time. Admission does not trigger reconnection.
Termination closes the provider and client; socket/factory disposal must settle
before bounded exponential retry creates a fresh session. Disposal failure
stops the runtime. The existing client's disposal contract does not attest
native allocator destruction. Each new session retains its original eight-second
authentication and thirty-second lifetime caps. Credential expiry uses both
wall time and a fixed monotonic deadline, closes status transport and prevents
new attempts. Existing local collection may continue until operator shutdown.

The complete-snapshot provider uses the configured immutable assignments and
per-field observations from the existing collector. Missing, stale, partial,
oversized or disconnected observations terminate the status session. Configured
assignment IDs alone are not current authority; server v2 admission must match
the complete set. The provider's five-second display freshness policy is not a
command safety policy. Commands remain disabled.

## ICE bind address (loopback default, opt-in LAN)

Native RTC binds its ICE agent to `127.0.0.1` by default, for the read-only,
pause control and synthetic peers alike. The runtime configuration accepts one
optional section to change it:

```json
"rtc": { "bindAddress": "192.168.1.20" }
```

- Only a literal IPv4 or IPv6 address is accepted. All interfaces must be
  written exactly as `0.0.0.0` or `::`; other spellings of the unspecified
  address (`0:0:0:0:0:0:0:0`, `::0.0.0.0`) and IPv4-mapped forms
  (`::ffff:10.0.0.5`) are refused. Use the IPv4 literal instead.
- A non-loopback address is reported once at startup as
  `{"kind":"rtc-bind-non-loopback","address":…}` on the diagnostics output.
- Host names, ports, brackets, zone IDs (`%eth0`), surrounding spaces and
  unknown keys are refused. An invalid value stops startup before any task runs,
  with the strict configuration error.
- `packages/connector/src/config/rtc.ts` is the single place that validates the
  value and supplies the default. The agent passes it to both signalling clients,
  and every peer resolves it through the same function, so a peer given an
  invalid value refuses to start rather than binding anywhere.
- No STUN or TURN server is added, and nothing goes through the server: only the
  local candidate address changes.

**Security note.** A non-loopback address exposes the Connector's ICE/DTLS UDP
sockets on that interface, and `0.0.0.0` or `::` on every interface. The data
channels still require the authenticated signalling binding and the DTLS
fingerprint and proof checks, but the attack surface widens. Enable it only on a
trusted LAN, prefer one specific LAN address over all interfaces, and restrict
inbound UDP to the farm's LAN with the host firewall. Never use it on an
interface reachable from the internet. Binding to all interfaces also places
every interface address of the host in the SDP offer, which travels through the
signalling server and reaches the browser: the server and the browser learn the
host's addresses on every network it is attached to. A specific LAN address
discloses only that address.

Focused validation passed seven Node lifecycle/configuration tests and thirteen
actual Node CLI groups driven by Bun, with 131 assertions. The CLI fixture
exercised the default TLS WSS socket against a deliberately unavailable endpoint,
continued collection and SIGTERM cleanup. Its credentials and authorization are
synthetic. Existing no-signalling runtime behavior, zero-network startup
rejections and durable queue regressions passed. An initial dynamic-import type
annotation error was corrected with the derived instance type.

The separately recorded real HTTPS/RTC v2 acceptance at `40e1a63` used a finite
synthetic provider. It does not validate this new runtime composition. Actual
issued credentials/current PostgreSQL assignments, live simulator observations,
browser rendering and packaged runtime acceptance remain pending. No hardware
command or production service was started. `check:all` passed with 326 Bun tests,
382 Node tests and two runtime skips, lint, TypeScript and both builds. This final
results paragraph was added afterward and formatting/diff checks were repeated.

## Authenticated runtime acceptance

At `214b8f1cdf243d4b2d35fbf7307c55056e8cbfc9`, separate disconnect and
revocation runs passed in 10.948 and 13.973 seconds. They used the generated
HTTPS server, official PostgreSQL journal through 0019, real own-login,
browser-key approval, Connector pairing credential and assignment registration.
The child retained its Ed25519 identity on private local storage and invoked
`runConnectorAgent` with the issued credential and real assignment. No binding
or proof was fabricated by the fixture.

An original finite loopback Moonraker protocol fixture answered the maintained
subscribe and periodic query methods with their exact request IDs. The browser
received `printing` with progress 0.25 and then 0.75 after a real subscription
delta. Its actual DTLS certificate and both peer proofs passed before status.
The remote socket-drop and owner-revocation cases then closed the browser and
prevented subsequent status delivery. Local collection remained active until
fixture shutdown. The native child exited with code zero without forced kill.

Two earlier runs are retained as failures. They started the browser after the
first local queue record, which does not imply a ready authenticated inbox.
The server correctly rejects a browser context without a ready Connector.
The corrected fixture waits for the actual `connector.inbox-ready` frame via a
bounded runtime diagnostic. This event establishes availability only; it does
not trigger RTC admission, authority or status publication. The regression
checks that readiness is absent before the acknowledgement and that no peer or
RTC admission exists when it arrives. No deadline was extended.

The sealed artifact has 457 files and output digest
`0e0636e041a3655f82a152e82a23f125324dbfda15685bc7bd694453b603c9b3`.
Private receipts retain both failures, source/artifact pins and independent
cleanup audits. All recorded children, app/TLS/Moonraker ports, temporary login
roles and private runtime/TLS directories were absent afterward. The original
database identity, journal and eleven table counts remained equal to baseline.
The owned integration database and bridge remain intentionally retained.

This is runtime-function acceptance with a protocol fixture, not a packaged CLI
or genuine pinned Moonraker/Klipper acceptance. The fixture calls native cleanup
after joining runtime shutdown; that does not establish packaged CLI native
shutdown. Browser TLS uses the existing local ignore-certificate-errors model,
while the Connector verifies the private CA. Production browser deployment,
rendered farm-page integration, live simulator behavior, camera and pause remain
separate gates. The complete check after the fixture/readiness changes passed:
326 Bun tests, 383 Node tests with two runtime skips, lint, TypeScript and both
builds. Only final checkpoint prose changed afterward.

## Packaged CLI acceptance

At `17b4ac48c7e07731f62e8d3eb4e23e8ec4ba5a9f`, separate packaged CLI
runs passed the disconnect case in 10.988 seconds and revocation in 13.659
seconds. The fixture spawned `dist/cli.js run` as a separate Node process with
its private configuration, issued credential and persisted identity. It used
the same actual HTTP approvals, v2 assignment admission and Moonraker protocol
fixture described above. The browser received both progress observations and
closed after the corresponding real signalling drop or HTTP revocation.

The first packaged attempt at `5805a61` failed before RTC proof exchange. The
single bundle moved the native package loader into `dist`, where its optional
binary package could not be resolved. The corrected build keeps
`node-datachannel` external and splits dynamic imports so RTC remains lazy.
The installed dependency graph and versions are unchanged. A loader trap also
confirmed that `--version` does not resolve the native module.

The accepted package manifest covers nineteen files, including every emitted
chunk and retained notice, with SHA-256
`8906e57fffc6d729a491bd087f21bb28748713a89897ed1b74aef7bd415927ac`.
Its entry digest is
`9608f56157884a1d8809fc1c62cefad546b5d7e053b2cfc665af3de6a27f9629`.
The separately sealed HTTPS output covers 457 files with digest
`ddbc4eaf4b27284b3051dabebadb55baa678975db6a0969a60680b572ee0ee7f`.
Private receipts retain the failed baseline and both passing runs.

Both CLI processes completed shutdown with code zero within the six-second
grace period. The outer fixture did not load or clean up their native library.
Independent audits found all recorded CLI/helper/server processes absent,
ports closed, temporary directories removed, fixture roles absent and no other
task database clients. The original database identity, journal and eleven table
counts matched baseline. The integration database and bridge remain retained.

This validates the packaged CLI with its installed dependencies. It does not
establish a self-contained distributable, native binary provenance or license
clearance. Genuine pinned Moonraker/Klipper, rendered farm-page integration,
production browser TLS, RTSP camera and pause integration remain pending.

The complete check after the packaging correction passed 326 Bun tests and
383 Node tests with two runtime skips, lint, TypeScript and both builds. The
final checkpoint prose was added afterward and checked separately for formatting
and whitespace.
