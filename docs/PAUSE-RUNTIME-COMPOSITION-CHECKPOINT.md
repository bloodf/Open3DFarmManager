# Pause runtime composition checkpoint

The production Connector agent (`packages/connector/src/runtime/agent.ts`) can now run the pause control path. It is disabled by default and starts only when the runtime `pause` section carries an explicit control entry:

```json
{ "pause": { "version": 1, "issuers": [...], "signalling": {...}, "control": { "assignmentId": "<uuid>" } } }
```

Without `control`, the agent creates no journal, socket, relay or driver; an existing pause section keeps its earlier advisory meaning. The named assignment must be provisioned locally, or configuration reading fails before startup. One assignment is served because the server keeps one pause inbox per agent.

`packages/connector/src/runtime/pause-control.ts` mirrors the verified execution fixture composition (`tests/helpers/pause-execution-rtc-connector-child.ts`):

1. The authenticated pause signalling client (`/api/signalling/pause-connector`) yields actual control proofs.
2. The relay opens one peer per control binding, then verifies the issued capability and browser admission proof against the locally configured issuer keyring.
3. The signed command is verified by the dispatcher, which claims the durable local journal (`<data>/pause-journal`) before any printer contact. The journal refuses replays and a busy assignment and is the local audit record.
4. Only then is the fixed Moonraker pause driver prepared for the locally provisioned binding. No endpoint arrives from the wire.

Each command runs at most once. Nothing retries, queues or falls back to HTTP; a closed transport closes its peer. The session lifecycle reconnects with bounded backoff and stops at credential expiry. On shutdown the relay closes and the journal stays open until every driver attempt actually settled.

`runPauseControl` accepts an optional `authorizeDispatch` guard, checked immediately before driver preparation. A refusal leaves the command `not-sent`. It is the injection point for a later offline-authorization freshness check; the agent does not pass one yet.

## Validation boundary

`tests/node/pause-control-runtime.test.ts` uses real configuration files, real signing keys, the real relay, journal and router, and the synthetic loopback Moonraker, with a recorded transport double in place of the signalling client. It covers the default-disabled path, unprovisioned control assignment refusal, one applied and journaled pause with no second printer request, the dispatch guard, and peer closure on transport terminal. Native RTC and HTTPS acceptance remain covered by the existing execution fixture; no physical printer is involved.
