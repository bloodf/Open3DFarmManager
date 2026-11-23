# Security design obligations

These are acceptance obligations for later implementation, not claims about completed features.

- Browser commands stay WebRTC-only with no TURN or HTTP fallback; API-originated commands are allowed only with an owner-granted scope, delivered as issuer-signed envelopes, and enforced by the Connector, which refuses unsafe or unauthorized commands with a reason. No automatic retry of uncertain commands, and never command physical printers in automated tests. An unavailable direct WebRTC connection leaves browser farm operations read-only.
- Bind approved browser identity and each signed command to its farm, Connector, printer, device, authenticated session, unique command identifier and nonce. Cross-farm/session substitutions must fail.
- Persist replay protection before execution. A timeout after sending a physical command has an uncertain outcome; do not automatically retry it. Reconcile device state before another user action.
- Verify signatures, roles, freshness and local safety at the Connector. Schema validation alone does not prove authenticity.
- Nonextractable browser keys protect private-key export, but hostile same-origin JavaScript can still request signatures. Use CSP, safe rendering, minimal third-party scripts and visible device enrollment/revocation.
- Offline operation cannot guarantee immediate remote revocation. Before enabling commands, define and test a bounded authorization lease. Expired authorization must fail closed for remote control while local watchdogs and audit persistence continue. The offline-control window is defined in [offline authorization lifetime](OFFLINE-AUTHORIZATION-LIFETIME.md): 30 s by default, at most 60 s. The bounded-lease obligation stays open until the runtime supplies an authenticated `confirm()` source (see the wiring prerequisites there); until then the relay has no production freshness source, and an unconfirmed tracker rejects every command.
- Keep revocation propagation, server-down safety, queue recovery, tampering, replay and cross-tenant access as explicit integration tests. Never test them against real printers without owner authorization.
- Independent login must use its own account store, host-only secure session and origin checks. No credentials or shared-session assumptions from another product belong here.
