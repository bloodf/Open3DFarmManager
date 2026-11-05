# Implementation queue

This queue tracks the independent MIT project without private deployment configuration, accounts, credentials or planning documents. Phase 0 remains incomplete. Checkpoint evidence applies only to its named slice and recorded source; local test success is not product acceptance, publication or a merged release.

## Current checkpoint

The shared head is `e5b50ca`. The latest `bun run check:all` passed formatting, type checks, 222 Bun tests, 110 Node tests and both production builds using the `0014` source and a frozen, uncommitted `0015` source snapshot. It does not establish a clean committed-head result or `0015` PostgreSQL acceptance. Rerun the gate after current source changes settle on a committed candidate.

- **0013 browser-device registry — accepted slice:** source `828bd579` was integrated at `741dd1f`. The official contiguous migration history, rollback/reapply, restart persistence and bundled browser proof were exercised. This is an internal registry and proof component; it does not supply enrollment/approval HTTP, authenticated signalling, transport leases or browser-to-Connector dispatch. See [browser key checkpoint](BROWSER-KEY-CHECKPOINT.md).
- **0014 credential proof — accepted point-in-time slice:** `e5b50ca` records eleven real PostgreSQL groups passing twice, official 0014 down/up, and a fresh-process check across a database restart. The consumed proof is a point-in-time receipt, not a durable authorization or telemetry write. The offline Connector cannot learn remote revocation immediately. No HTTP telemetry endpoint or transport lease is accepted. See [credential acceptance checkpoint](CONNECTOR-CREDENTIAL-ACCEPTANCE-CHECKPOINT.md).
- **0015 printer ownership — in progress:** migration and storage sources are uncommitted. Focused checks and the `check:all` snapshot cover static/unit/build behavior only. No real PostgreSQL, official migration reversal, or race/privilege acceptance is claimed. See [printer ownership checkpoint](PRINTER-OWNERSHIP-CHECKPOINT.md).
- **0016 operation-bound telemetry — in progress:** source work is uncommitted. It must bind current authorization, proof consumption and telemetry persistence into one database operation. Do not reuse the 0014 receipt as authority for a later write. Real PostgreSQL acceptance and integrated checks remain pending.

A separate pairing HTTP branch has exact-catalog evidence at `8352a1e` and the root recovery rate-limit fix at `14d018e`. Its full HTTPS gate is running and is not accepted yet. Keep its result distinct from the `0013`/`0014` acceptance.

## Active work and dependency order

1. Finish `0015` against a disposable PostgreSQL cluster using the official contiguous migration runner. Validate down/up, races, privilege boundaries and current authorization checks. Commit the slice, then run the integrated gate on that committed candidate rather than treating the frozen `0015` snapshot as committed-head acceptance.
2. Finish `0016` operation-bound telemetry after its storage and authorization interfaces settle. Test concurrent proof/revocation/write outcomes, retries and rollback against real PostgreSQL, then verify bounded outage recovery and exact event acknowledgement. Keep the HTTP gate separate until its HTTPS checks complete.
3. Resolve the WebRTC queue blocker. Native Node/Chromium interoperability passed at `1e1ceba`, but independent review found an unbounded queue. Corrective work is uncommitted and unvalidated. Define bounded queue/backpressure behavior, test saturation and disconnect/reconnect, then rerun interoperability and review. The earlier pass is not current acceptance.
4. Re-run simulator evidence with the bounded collector. The UART pair at `bf6c368` was inconclusive because collector startup output was lost. The local collector fix at `da5d377` has 52 experimental checks only; it is not simulator acceptance and establishes no printer or architecture claim. Preserve failure evidence and the original failing exit status.
5. Once these slices have settled on one committed candidate, run the required integrated, database, browser/WebRTC and simulator gates for that exact head. Report each local, validated, integrated, published and merged state separately.

## Phase 0 acceptance still required

Phase 0 must deliver independent login and browser-device approval, authenticated signalling, and actual browser-to-Connector WebRTC for live status, camera and signed commands. The Connector must enforce command safety through server outages. Keep live data and signed commands peer-to-peer: no TURN and no HTTP/server command fallback. Degraded mode stays read-only.

End-to-end evidence must cover signed pause, identity and farm authorization, tampering, replay, revocation, outage and recovery, bounded telemetry drain, and the offline-revocation lifetime tradeoff. Define how long previously issued authorization may remain usable while a Connector is offline, then verify expiry fails closed. Test with simulators only; never send automated commands to physical printers.

Simulator acceptance remains open, including the two-printer/four-tool scenarios, Spoolman read-only inventory, camera/RTSP behavior, network faults and database readiness. Resolve startup and stability failures with bounded diagnostics; do not relax readiness or safety limits based on inconclusive runs. See the [simulator follow-up](SIMULATOR-ACCEPTANCE-FOLLOWUP.md), [evidence summary](SIMULATOR-EVIDENCE-SUMMARY.md), [UART experiment](SIMULATOR-UART-NATIVE-RESULT.md) and [CI diagnostics](KLIPPER-CI-DIAGNOSTICS.md).

## Later product work

After integrated Phase 0 acceptance, continue with Moonraker discovery, configuration, history, metadata and tool reporting, keeping Spoolman read-only. Later slices include costing, traceable material use, maintenance, inventory, quotes/orders, notifications and operational backup/restore guidance. Additional printer families need their own simulator acceptance and licensing review.

## Completion and publication gates

- Run `bun run check:all` on the final committed candidate and complete required PostgreSQL, browser/WebRTC and simulator checks for that same head. State pending local or remote checks explicitly.
- Keep diagnostic evidence bounded and outside committed reports; do not include private paths, host details, credentials or account identifiers.
- Review publication diffs for private material, secrets and license obligations. The existing local payload still requires its separate explicit publication authorization. Do not deploy, change DNS or credentials, start production services, or test physical printers without separate authorization.
- Preserve worktree outputs and other tasks' resources until ownership, active use and integration are verified. Report cleanup ownership at task completion.
