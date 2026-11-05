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
command safety policy. Commands remain disabled. Native RTC remains restricted
to its existing loopback-only policy.

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
