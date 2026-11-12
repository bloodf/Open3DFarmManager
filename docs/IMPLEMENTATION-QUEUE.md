# Implementation queue

This queue tracks the independent MIT project without private deployment configuration, accounts, credentials or planning documents. Phase 0 remains incomplete. Checkpoint evidence applies only to its named slice and recorded source; local test success is not product acceptance, publication or a merged release.

## Current checkpoint

The reference head is `36d1198` on `origin/main`. The official migration catalog is contiguous through `0023` (`infra/db/migrations`). The toolchain is pnpm 12.18.0 with Node 24.22.3; the gate is `pnpm run check:all`. No integrated gate has been run on this head. Earlier gate counts in checkpoint records describe their named sources only. Run the gate on the final committed candidate and report PostgreSQL, browser/WebRTC and simulator checks for that same head separately.

- **0013 browser-device registry and 0014 credential proof — accepted slices:** see [browser key checkpoint](BROWSER-KEY-CHECKPOINT.md) and [credential acceptance checkpoint](CONNECTOR-CREDENTIAL-ACCEPTANCE-CHECKPOINT.md). The 0014 receipt is point-in-time context, not durable authorization.
- **0015 printer ownership — committed and accepted on real PostgreSQL:** eleven synthetic behavior groups passed on a disposable cluster through the official contiguous runner, again after a PostgreSQL restart, with official 0015 down/up. See [printer ownership checkpoint](PRINTER-OWNERSHIP-CHECKPOINT.md).
- **0016 operation-bound telemetry — committed and accepted on real PostgreSQL:** the storage/proof slice binds current authorization, proof consumption and telemetry persistence into one operation. HTTP/client integration and authenticated transport are separate slices. See [atomic telemetry checkpoint](ATOMIC-TELEMETRY-CHECKPOINT.md).
- **Later migrations 0017–0023 are on `main`:** signalling authorization, pause authority, assignment-scoped signalling, password reset, credential successors, successor proofs and credential renewals. Their evidence is in the per-slice checkpoints and the [Phase 0 ledger](PHASE-0.md); this queue does not restate it. The server-side renewal and readback exist; the Connector renewal client does not.
- **WebRTC unbounded-queue blocker — fixed in the experiment adapter:** the adapter now bounds queue length, bytes and total budget and goes read-only on saturation, with sustained-input tests. Native SCTP, libdatachannel, N-API and Chromium memory is still unmeasured. Heartbeat, current authorization and revocation distribution remain pending. See [WebRTC interoperability checkpoint](WEBRTC-CONNECTOR-INTEROP-CHECKPOINT.md).
- **Health endpoint:** `/healthz` reports process liveness only; it does not check PostgreSQL.

## Active work and dependency order

Development resumed on 2026-11-11. Remaining Phase 0 work, in dependency order:

1. Simulator readiness: resolve the startup and stability failures with bounded diagnostics, then accept SV06 and the four-tool fixture, Spoolman read-only inventory and restart behavior. Do not relax readiness or safety limits on inconclusive runs.
2. PostgreSQL-backed `/healthz` and startup migrations (the migration runner is currently a disposable-database tool, not application startup).
3. Logger redaction and structured diagnostics.
4. Connector pair and status CLI (the CLI currently supports `collect`, `run` and local status only; it does not pair).
5. Connector credential-renewal client, against the existing server renewal and readback.
6. Offline authorization lifetime: define it, enforce it in the Connector and verify expiry fails closed.
7. Trusted-key cache in the Connector.
8. Event and snapshot uploads over the authenticated ingestion path.
9. Moonraker identify, webcams and multi-tool reporting.
10. Pause wired into the Connector runtime and the farm UI (the issuer, relay, journal and driver exist as separately tested slices; the page keeps the control disabled).
11. Feed reconnect in the farm view.
12. Camera end to end: RTSP helper, MediaMTX, authenticated camera over WebRTC and native memory measurement.
13. Network fault profiles in the simulator.
14. Combined acceptance on one committed candidate: real services, browser flows, status, camera, signed pause, outage and recovery, with the required gates for that exact head.
15. Owner-run hardware checklist, after simulator acceptance and separate authorization.

## Phase 0 acceptance still required

Phase 0 must deliver independent login and browser-device approval, authenticated signalling, and actual browser-to-Connector WebRTC for live status, camera and signed commands. The Connector must enforce command safety through server outages. Keep live data and signed commands peer-to-peer: no TURN and no HTTP/server command fallback. Degraded mode stays read-only.

End-to-end evidence must cover signed pause, identity and farm authorization, tampering, replay, revocation, outage and recovery, bounded telemetry drain, and the offline-revocation lifetime tradeoff. Define how long previously issued authorization may remain usable while a Connector is offline, then verify expiry fails closed. Test with simulators only; never send automated commands to physical printers.

Simulator acceptance remains open, including the two-printer/four-tool scenarios, Spoolman read-only inventory, camera/RTSP behavior, network faults and database readiness. Resolve startup and stability failures with bounded diagnostics; do not relax readiness or safety limits based on inconclusive runs. See the [simulator follow-up](SIMULATOR-ACCEPTANCE-FOLLOWUP.md), [evidence summary](SIMULATOR-EVIDENCE-SUMMARY.md), [UART experiment](SIMULATOR-UART-NATIVE-RESULT.md) and [CI diagnostics](KLIPPER-CI-DIAGNOSTICS.md).

## Later product work

After integrated Phase 0 acceptance, continue with Moonraker discovery, configuration, history, metadata and tool reporting, keeping Spoolman read-only. Later slices include costing, traceable material use, maintenance, inventory, quotes/orders, notifications and operational backup/restore guidance. Additional printer families need their own simulator acceptance and licensing review.

## Completion and publication gates

- Run `pnpm run check:all` on the final committed candidate and complete required PostgreSQL, browser/WebRTC and simulator checks for that same head. State pending local or remote checks explicitly.
- Keep diagnostic evidence bounded and outside committed reports; do not include private paths, host details, credentials or account identifiers.
- Review publication diffs for private material, secrets and license obligations. The existing local payload still requires its separate explicit publication authorization. Do not deploy, change DNS or credentials, start production services, or test physical printers without separate authorization.
- Preserve worktree outputs and other tasks' resources until ownership, active use and integration are verified. Report cleanup ownership at task completion.
