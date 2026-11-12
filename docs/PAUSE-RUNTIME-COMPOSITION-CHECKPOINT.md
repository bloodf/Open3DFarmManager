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

**Freshness gate.** The relay requires the offline authority freshness gate (`authority.freshness`, see `OFFLINE-AUTHORIZATION-LIFETIME.md`). The agent creates a real `createOfflineAuthority()` tracker and passes only its frozen `freshness` view. It is confirmed only by `connector.authority-confirm` frames on the credential-authenticated read-only Connector inbox; without the read-only `signalling` section, or while confirmations are missing, authority is stale and every capability is rejected as `expired-or-inactive`. `onStale` emits `pause-authority-stale` and appends to `<data>/pause-journal/authority-audit.jsonl`. Production never passes an always-fresh stub. `createPauseCommandRelay` throws when `authority.freshness.freshAt` is not a function.

Each command runs at most once. Nothing retries, queues or falls back to HTTP; a closed transport closes its peer. The session lifecycle reconnects with bounded backoff and stops at credential expiry. On shutdown the relay closes and the journal stays open until every driver attempt actually settled.

A pause-path runtime failure (key import, journal open, lifecycle error) emits `pause-failed` with a fixed reason (`journal`, `credential` or `runtime`; no free text) and ends only the pause task. A diagnostic sink that throws cannot reject the pause task. If relay construction fails after the journal opened, the journal is closed first; telemetry, local status and read-only signalling keep running. Configuration errors still fail startup. Pause diagnostics have their own budget so they cannot exhaust read-only diagnostics.

## Journal lockout and manual recovery

A journal row in `claimed`, `write-started` or `outcome-unknown` reserves its assignment and printer indefinitely: every later command for that printer is rejected as busy, across restarts. This is deliberate. Such a row means the Connector cannot prove whether a pause reached the printer, and a retry could act on a state nobody observed. Rows are never cleared automatically.

If shutdown waits longer than 10 s for driver settlement, the agent emits `pause-close-stalled` and keeps waiting; the journal is never force-closed.

Manual recovery, by the local operator only:

1. Stop the Connector and confirm the printer state at the printer or in Mainsail/Fluidd.
2. Back up `<data>/pause-journal/pause-commands.sqlite` (with any `-wal`/`-shm` files).
3. Inspect the reserved rows: `SELECT cmd_id, assignment_id, printer_key, status, claimed_at FROM pause_commands WHERE status IN ('claimed','write-started','outcome-unknown');`
4. After confirming the physical state, record the resolution outside the journal and remove only those rows, or move the whole journal directory aside to start a new one. Keep the backup as the audit record.
5. Restart the Connector.

## Validation boundary

`tests/node/pause-control-runtime.test.ts` uses real configuration files, real signing keys, the real relay, journal and router, and the synthetic loopback Moonraker, with a recorded transport double in place of the signalling client. It covers the default-disabled path, unprovisioned control assignment refusal, the inert stale path (no printer contact), the relay freshness guard, one applied and journaled pause with no second printer request, replay after a restart on the same data directory, a leftover `write-started` row keeping the printer busy, and peer closure on transport terminal. Tests confirm a real tracker in place of the missing server confirmation. Native RTC and HTTPS acceptance remain covered by the existing execution fixture; no physical printer is involved.
