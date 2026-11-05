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

## Remaining integration

Signalling admission and issuer authority in this fixture are synthetic and
trusted by construction. Current database authorization, real pause WSS
admission, capability verification, durable command replay protection, the
fixed Moonraker driver and a real isolated simulator pause must still be
composed and validated together. No command was executed, and readonly peers
were never upgraded to control peers. Native artifact provenance and resource
limits retain their existing documented limitations.
