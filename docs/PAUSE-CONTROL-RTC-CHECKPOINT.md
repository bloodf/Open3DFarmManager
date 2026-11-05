# Separate pause control RTC transport

Five isolated native transport cases passed on source
`579f377867d0864a952de4eb03fc3acfcc6c82e0`. Each ran once, sequentially,
with Node 24.20.0, Chromium 156.0.8078.4 and libdatachannel 0.24.5.
The fixture used one browser, one Connector child and an ephemeral loopback
HTTP server. No ICE server, TURN, PostgreSQL or printer command was involved.

The valid exchange independently required both actual DTLS certificates to
match, one sent and one received role-specific proof at each endpoint, and
identical expected control bindings. The Connector's admission nonce and a
synthetically signed capability arrived intact over the separate DataChannel.
This proves transport of the capability, not admission by the capability
verifier or permission to dispatch a command.

| Case                    | Required outcome                                                                               | Outer process duration |
| ----------------------- | ---------------------------------------------------------------------------------------------- | ---------------------- |
| Valid                   | Both proofs and certificates verified; nonce and capability delivered                          | 2.034 s                |
| Wrong assignment        | Browser rejects the trusted binding with `binding-rejected`                                    | 2.200 s                |
| Wrong local signing key | Browser rejects its own proof with `local-proof`                                               | 2.089 s                |
| Missing admission       | Original eight-second authentication deadline closes the peer; late binding cannot activate it | 8.792 s                |
| Oversized capability    | Browser rejects before delivery with `invalid-send`                                            | 1.165 s                |

The wrong-key case is local proof rejection, not evidence that a malicious
remote proof was delivered over the network. The oversize case exercises the
sender boundary, not an adversarial native receive-buffer measurement.

All five Connector children exited and closed with code zero; stdout and
stderr drained. Both endpoints reported one close, zero pending frames, zero
retained bytes and zero cleanup failures. The fixture independently attempted
browser, child and server disposal. A subsequent process/listener audit found
the recorded child PIDs absent and loopback ports closed. No retry or deadline
extension was used. Private execution receipts remain outside Git.

The same source passed `bun run check:all` before these opt-in executions:
326 Bun tests, 458 Node tests with three explicit runtime skips, 66 RTSP
supervisor tests, seven framing tests, type checks, formatting and builds.
The five native cases are additional evidence, not included in those counts.

## Integrated authority and transport

A separate generated-application attempt passed at
`2913588be3002c68c13bb9a03b3347d899dd1197`. The sealed application contained
467 output files with manifest digest
`019fcb33bdeb9aea636e738a000dd36dd517e1024220fd993b20561cf533dda3`.
The complete process took 13.778 seconds under its 120-second outer guard.

This fixture performed independent owner/admin HTTP login, approved a
page-local nonextractable browser key, paired the Connector's own identity,
and read back a current printer assignment from the real restricted database
path. The actual browser and Node Connector used the maintained WSS clients
and separate native control peers. Both endpoints required matching actual
DTLS certificates and one sent/received proof each. The browser obtained the
capability through the maintained HTTP issuer; the Connector accepted it
through the maintained verifier. Commands remained disabled. The local
printer mapping was synthetic and no Moonraker driver or printer was contacted.

The browser fixture ignores HTTPS certificate errors; the Connector uses its
private fixture CA with explicit verification. This does not prove production
browser TLS. Original eight-second admission and thirty-second lifetime limits
were unchanged. Cleanup independently confirmed all recorded processes absent,
ports closed, temporary TLS files removed, role and migration baselines
unchanged, and the protected original database byte-identical.

The preceding attempt at `60a702b` failed during Connector admission without
retaining its internal stage. Only bounded diagnostic collection changed
before this successful attempt. Its cause remains unresolved; one passing
attempt does not establish stability or close that historical failure.

## Diagnostic review follow-up

Unexpected signalling termination before capability acceptance now records
`client-terminal`, including after `start()` has resolved at proof readiness.
Requested disposal while verification is pending does not become a verifier
failure. Unknown rejection details are omitted, and a missing child observation
retains only the child exit code and signal, never stderr. Null exit fields do
not prove process closure.

Twelve focused contract tests pass, including pre-issuance projection and
unknown rejection redaction. These tests do not execute native child lifecycle
races. The actual runtime receipt above predates this follow-up; no fresh
HTTPS/WSS/RTC acceptance is claimed for it.

## Remaining integration

Durable command replay protection, the fixed Moonraker driver and a real
isolated printing simulator must still be composed with this authority and
transport path. Integrated rejection, revocation, outage and recovery cases
remain pending. No command was executed, and readonly peers were never upgraded
to control peers. Native artifact provenance and resource limits retain their
existing documented limitations.
