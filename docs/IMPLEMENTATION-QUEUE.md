# Implementation queue

This queue tracks the independent MIT project without private deployment configuration, accounts, credentials or planning documents. Phase 0 remains incomplete. Checkpoint evidence applies only to its named slice and recorded source; local test success is not product acceptance, publication or a merged release. The roadmap epics that own the remaining work are listed in [PLAN.md](PLAN.md).

## Current checkpoint

This file does not pin a head. Each checkpoint names the commit it proves, and the gate must be run on the exact candidate that is being accepted.

- **Migrations:** the official catalog in `infra/db/migrations` is contiguous through `0036`.
- **Toolchain:** pnpm 12.18.0 with Node 24.22.3. The gate is `pnpm run check:all`.
- **Integrated acceptance:** not complete. The last combined run, on candidate `1e3a029`, validated outage recovery and the three network-fault profiles, but three browser status/pause rows failed and the camera and two simulator rows were unavailable. See the [Phase 0 ledger](PHASE-0.md) and the [rendered farm checkpoint](FARM-VIEW-CHECKPOINT.md).
- **Accepted slices:** 0013 browser-device registry and 0014 credential proof ([browser key checkpoint](BROWSER-KEY-CHECKPOINT.md), [credential acceptance checkpoint](CONNECTOR-CREDENTIAL-ACCEPTANCE-CHECKPOINT.md)); 0015 printer ownership ([printer ownership checkpoint](PRINTER-OWNERSHIP-CHECKPOINT.md)); 0016 operation-bound telemetry ([atomic telemetry checkpoint](ATOMIC-TELEMETRY-CHECKPOINT.md)). The 0014 receipt is point-in-time context, not durable authorization.
- **Health endpoint:** `/healthz` reports process liveness only. Database readiness is a separate route added in [#113](https://github.com/bloodf/Open3DFarmManager/pull/113).

## Delivered since the previous queue revision

Each item below was merged to `main`. The checkpoint named in the item is the scope of its evidence.

- Moonraker identify, multi-tool and webcam discovery ([#106](https://github.com/bloodf/Open3DFarmManager/pull/106)).
- Structured JSON logger with secret redaction ([#107](https://github.com/bloodf/Open3DFarmManager/pull/107)).
- Connector pair and status CLI commands ([#109](https://github.com/bloodf/Open3DFarmManager/pull/109)).
- Database readiness route and fail-closed startup migrations ([#113](https://github.com/bloodf/Open3DFarmManager/pull/113)).
- Offline authorization lifetime bounded in the Connector ([#115](https://github.com/bloodf/Open3DFarmManager/pull/115)).
- Credential renewal client with atomic successor persistence, and server renewal activated with readback recovery ([#117](https://github.com/bloodf/Open3DFarmManager/pull/117), [#132](https://github.com/bloodf/Open3DFarmManager/pull/132)).
- Opt-in pause control path wired into the Connector runtime ([#118](https://github.com/bloodf/Open3DFarmManager/pull/118)); confirmed signed pause on the farm page, behind the pause availability rules ([#142](https://github.com/bloodf/Open3DFarmManager/pull/142); see [farm pause checkpoint](FARM-PAUSE-UI-CHECKPOINT.md)).
- Feed reconnect with bounded, jittered backoff in the farm view ([#121](https://github.com/bloodf/Open3DFarmManager/pull/121), [#136](https://github.com/bloodf/Open3DFarmManager/pull/136)).
- Automatic queue lock recovery and cursor acknowledgements ([#141](https://github.com/bloodf/Open3DFarmManager/pull/141)).
- Outage and restart recovery acceptance ([#133](https://github.com/bloodf/Open3DFarmManager/pull/133)).
- Live RTSP camera to the browser over the Connector WebRTC track, and the camera in the farm view ([#131](https://github.com/bloodf/Open3DFarmManager/pull/131), [#137](https://github.com/bloodf/Open3DFarmManager/pull/137); see [camera checkpoint](CAMERA-END-TO-END-CHECKPOINT.md)).
- Network fault harness and two-printer simulator acceptance ([#148](https://github.com/bloodf/Open3DFarmManager/pull/148)). Klipper simulators reach readiness reliably ([#139](https://github.com/bloodf/Open3DFarmManager/pull/139)).
- Read-only Spoolman inventory in the farm view ([#129](https://github.com/bloodf/Open3DFarmManager/pull/129)).
- One-command real-RTC farm-page acceptance runner, with its pause, camera and simulator rows ([#140](https://github.com/bloodf/Open3DFarmManager/pull/140), [#147](https://github.com/bloodf/Open3DFarmManager/pull/147), [#150](https://github.com/bloodf/Open3DFarmManager/pull/150), [#151](https://github.com/bloodf/Open3DFarmManager/pull/151)).
- Owner-run hardware acceptance checklist, documentation only ([#143](https://github.com/bloodf/Open3DFarmManager/pull/143)).
- Transition events uploaded through the telemetry queue ([#119](https://github.com/bloodf/Open3DFarmManager/pull/119)). Snapshot uploads are not covered by that PR.

## Remaining work, by epic

Work is ordered by dependency. Items marked "partly delivered" have merged slices, and the rest of their scope is still open.

1. **Simulator acceptance** ([E3, #184](https://github.com/bloodf/Open3DFarmManager/issues/184)): SV06 and the four-tool fixture, Spoolman read-only inventory and restart behaviour, using bounded diagnostics. Startup readiness was fixed in [#139](https://github.com/bloodf/Open3DFarmManager/pull/139); the acceptance matrix is not. Do not relax readiness or safety limits on inconclusive runs.
2. **Camera acceptance** ([E3, #184](https://github.com/bloodf/Open3DFarmManager/issues/184)): actual bounded RTSP helper execution against MediaMTX, authenticated camera over WebRTC and native memory measurement. The helper and the in-page camera are merged; the end-to-end measurement is not.
3. **Trusted-key cache in the Connector** ([E2, #177](https://github.com/bloodf/Open3DFarmManager/issues/177)): not covered by any merged PR listed above.
4. **Telemetry and snapshot uploads over the authenticated ingestion path** ([E6, #200](https://github.com/bloodf/Open3DFarmManager/issues/200), [E3](https://github.com/bloodf/Open3DFarmManager/issues/184)): partly delivered ([#119](https://github.com/bloodf/Open3DFarmManager/pull/119)). The durable PostgreSQL store is not yet wired to production; see [POSTGRES-TELEMETRY-CHECKPOINT.md](POSTGRES-TELEMETRY-CHECKPOINT.md). Event retention and a storage quota are not implemented.
5. **Pause readiness signal** ([E1, #168](https://github.com/bloodf/Open3DFarmManager/issues/168)): the farm page enables the pause button before the Connector has re-admitted its pause inbox after a reconnect. A dialog opened in that window fails closed. The page has no server-side readiness signal yet ([known UX gap](FARM-PAUSE-UI-CHECKPOINT.md)).
6. **Combined acceptance on one committed candidate** ([E5, #194](https://github.com/bloodf/Open3DFarmManager/issues/194)): real services, browser flows, status, camera, signed pause, outage and recovery, with the required gates for that exact head. Run `pnpm run check:all` and the required PostgreSQL, browser/WebRTC and simulator checks on that head, and report each separately.
7. **Owner-run hardware checklist** ([E13, #255](https://github.com/bloodf/Open3DFarmManager/issues/255)): after simulator acceptance and separate authorization.

## Phase 0 acceptance still required

Phase 0 must deliver independent login and browser-device approval, authenticated signalling, and actual browser-to-Connector WebRTC for live status, camera and signed commands. The Connector must enforce command safety through server outages. Browser commands stay WebRTC-only with no TURN or HTTP fallback; API-originated commands are allowed only with an owner-granted scope, delivered as issuer-signed envelopes, and enforced by the Connector, which refuses unsafe or unauthorized commands with a reason. Degraded mode stays read-only.

End-to-end evidence must cover signed pause, identity and farm authorization, tampering, replay, revocation, outage and recovery, bounded telemetry drain, and the offline-revocation lifetime tradeoff. The offline authorization lifetime is defined and enforced by [#115](https://github.com/bloodf/Open3DFarmManager/pull/115); its expiry must be verified on the candidate. Test with simulators only; never send automated commands to physical printers.

Simulator acceptance remains open, including the two-printer/four-tool scenarios, Spoolman read-only inventory, camera/RTSP behaviour, network faults and database readiness. Resolve startup and stability failures with bounded diagnostics; do not relax readiness or safety limits based on inconclusive runs. See the [simulator follow-up](SIMULATOR-ACCEPTANCE-FOLLOWUP.md), [evidence summary](SIMULATOR-EVIDENCE-SUMMARY.md), [UART experiment](SIMULATOR-UART-NATIVE-RESULT.md) and [CI diagnostics](KLIPPER-CI-DIAGNOSTICS.md).

## Later product work

After integrated Phase 0 acceptance, the remaining product work is owned by the open epics: Moonraker job history and file operations ([E7, #204](https://github.com/bloodf/Open3DFarmManager/issues/204)), additional adapter families and their journeys ([E10, #231](https://github.com/bloodf/Open3DFarmManager/issues/231)), the Spoolman integration per farm ([E14, #276](https://github.com/bloodf/Open3DFarmManager/issues/276)), and Bambu cloud import ([E15, #282](https://github.com/bloodf/Open3DFarmManager/issues/282)). Additional printer families need their own simulator acceptance and licensing review.

## Completion and publication gates

- Run `pnpm run check:all` on the final committed candidate and complete required PostgreSQL, browser/WebRTC and simulator checks for that same head. State pending local or remote checks explicitly.
- Keep diagnostic evidence bounded and outside committed reports; do not include private paths, host details, credentials or account identifiers.
- Review publication diffs for private material, secrets and license obligations. The existing local payload still requires its separate explicit publication authorization. Do not deploy, change DNS or credentials, start production services, or test physical printers without separate authorization.
- Preserve worktree outputs and other tasks' resources until ownership, active use and integration are verified. Report cleanup ownership at task completion.

## Historical checkpoint index

These documents retain earlier scoped evidence and limitations. Their historical test counts and statements must not be read as current repository status:

- [Local integration checkpoint](INTEGRATION-CHECKPOINT.md) — initial local integration and its then-current limits.
- [Container validation](CONTAINER-VALIDATION-CHECKPOINT.md), [simulator readiness diagnosis](SIMULATOR-READINESS-DIAGNOSIS.md), [simulator follow-up](SIMULATOR-ACCEPTANCE-FOLLOWUP.md) and [bounded Klipper diagnostics](KLIPPER-CI-DIAGNOSTICS.md) — separate experiments; they record the startup failures that were later addressed in [#139](https://github.com/bloodf/Open3DFarmManager/pull/139).
- [PostgreSQL sessions](POSTGRES-SESSIONS-CHECKPOINT.md), [pairing persistence](PAIRING-PERSISTENCE-CHECKPOINT.md), [pairing proof](PAIRING-PROOF-CHECKPOINT.md) and [credential issuance](CONNECTOR-CREDENTIAL-ISSUANCE-CHECKPOINT.md) — isolated database behaviours, not authenticated end-to-end acceptance.
- [Browser keys](BROWSER-KEY-CHECKPOINT.md), [frontend accessibility](FRONTEND-ACCESSIBILITY-CHECKPOINT.md), [HTTP telemetry](HTTP-TELEMETRY-CHECKPOINT.md) and [integration queue](IMPLEMENTATION-QUEUE.md) — component and mock/loopback evidence, not a complete product flow.

## Publication and hardware gates

Track work as local, tested, validated, published or merged, with the exact commit or PR head. Review the immutable publication diff for private material and license obligations. Required current-head checks, review resolution and repository protections still apply. Deployment, DNS and credential changes, and physical-printer tests remain separately authorized actions.
