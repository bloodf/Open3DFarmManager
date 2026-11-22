# Phase 0 acceptance ledger

This is an independent MIT project. Accounts, sessions, credentials and databases belong to this product. Private hosting details and the original private planning documents stay outside this repository. The checkpoints linked below prove only the behavior and revision they name; Phase 0 is not complete.

## Sequence

1. E0.1: accept isolated Klipper simulators, including SV06 and a four-tool printer, Spoolman, cameras through RTSP/MediaMTX, network faults and integration CI.
2. E1.1/E1.2: complete pnpm workspaces, Nuxt 4, Connector packaging, Docker, Postgres migrations, configuration validation, readiness and structured logs.
3. E2.1/E2.4: complete independent login and sessions, farm authorization, limits, secure pairing, credential recovery and revocation.
4. E3.1/E3.2: connect Connector identity, configuration, durable offline telemetry and authenticated ingestion.
5. E5.1a/E5.4a: connect Moonraker discovery/subscriptions/webcam and a read-only Spoolman inventory mirror.
6. E2.3/E4.1–E4.5: register approved browser keys, authenticate signalling, carry live status, camera and signed pause over WebRTC, and verify local safety with read-only degradation.
7. E6.1: deliver the farm view with age indicators and links to existing printer interfaces.
8. Hardware acceptance follows simulator acceptance and is owner-run. Deployment and physical-printer control require separate authorization.

## Invariants

- No TURN or cloud slicing. Browser commands stay WebRTC-only with no TURN or HTTP fallback; API-originated commands are allowed only with an owner-granted scope, delivered as issuer-signed envelopes, and enforced by the Connector, which refuses unsafe or unauthorized commands with a reason. No automatic retry of uncertain commands, and never command physical printers in automated tests. Status and camera use browser-to-Connector WebRTC.
- The Connector enforces identity, signature, farm/role scope, expiry, revocation, replay protection and safety while the server is unavailable. Offline expiry fails closed; loss of connectivity alone does not stop an ongoing print.
- Camera/video and bulk files stay on P2P transport. The server receives bounded snapshots and metadata only.
- Simulators never connect to physical printers. Automated tests never send commands to hardware.
- Do not mark Phase 0 complete until the full scope below passes in the built application, browser and simulators.

## Current status snapshot

The table below retains the rendered farm-page checkpoint from 2026-11-05.
Later source is published in [PR #14](https://github.com/bloodf/Open3DFarmManager/pull/14).
PR #14 was merged into `main` as `094fe1f`, containing head `60a702b` after
its local complete gate and remote code, image and Klipper checks passed. The
CPU-only comparison led to a two-CPU budget per simulator without changing the
90-second readiness requirement. This is startup evidence, not the full
simulator acceptance matrix.

The first exact-artifact pause HTTPS/WSS/RTC attempt at `60a702b` completed
login, enrollment and pairing but failed during Connector admission. Its owned
processes, ports and roles were cleaned; the protected original database
remained unchanged. No capability acceptance or printer command is claimed.
A subsequent instrumented attempt at `2913588` passed actual WSS/control RTC,
HTTP capability issuance and Connector verification. No printer command ran;
the earlier failure remains unexplained. The exact scope is recorded in the
[pause control checkpoint](PAUSE-CONTROL-RTC-CHECKPOINT.md).
Publication does not establish deployment or complete Phase 0 acceptance.
Source, packaged artifacts, database fixtures and native diagnostics retain
their distinct scopes.

| Gate                         | Verified evidence                                                                                                                                                                                                                                                                                                                                                       | Remaining scope                                                                                                                                                                                                                          |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local application gate       | The source through `422e83f` passed 326 Bun tests, 383 Node tests and two runtime skips, lint, TypeScript and both builds. `10a3f92` subsequently recorded the rendered-page results in documentation.                                                                                                                                                                  | Repeat the complete gate after later implementation changes. Remote CI and publication of the local payload are not established.                                                                                                         |
| Login, pairing and inventory | Historical real-handler HTTPS flows cover enrollment, pairing, recovery and revocation. The newer rendered-page fixture uses real independent login, approved IndexedDB key, issued Connector credential, current assignment readback and official journal through 0019. Three actual restricted-role session tests cover lock-wait touch, expiry and clock regression. | Full current-head negative coverage, production TLS and all concurrent session/inventory transitions remain distinct gates.                                                                                                              |
| Assignment-bound RTC         | The generated HTTPS fixture at `40e1a63` passed actual browser/Connector peers, v2 assignment commitments, DTLS checks, mutual proofs and status, with separate disconnect and revocation cases. The official 0019 authorization and privilege/down-up suite passed at `ea741f5`.                                                                                       | Migration 0019 restart, cross-network behavior, native provenance/buffering and control/media authorization are not established by read-only transport.                                                                                  |
| Packaged Connector runtime   | The fixed package at `17b4ac4` passed actual CLI collection, authenticated signalling and RTC status against the maintained application and a loopback Moonraker protocol fixture. Native loading remains lazy and the package notice/output manifest is recorded.                                                                                                      | Genuine pinned Moonraker/Klipper and standalone distribution remain pending. The [Connector provenance record](../packages/connector/THIRD_PARTY.md) documents the native checksum gate and pending embedded-component review.           |
| Rendered farm view           | At `422e83f`, separate actual `/farm` disconnect and revocation runs passed. The page uses its production composable, existing IndexedDB key and genuine feed. It displays progress changes, then unavailable with the previous observation; pause stays disabled. No application API or RTC interception is used.                                                      | This uses synthetic Moonraker protocol data, not a simulator process. Camera and signed pause remain unavailable. Browser fixture TLS ignores certificate errors and does not prove production deployment.                               |
| Pause authority and safety   | The maintained 0018 issuer preparation passed twenty named PostgreSQL checks at `b21df2b`, followed by actual database restart and three fresh-process checks. The journal, dispatcher and fixed pause driver also have scoped tests.                                                                                                                                   | Actual browser control peer, issuer HTTP/runtime composition, driver integration and printing-simulator pause are not accepted. Restart replay used a new synthetic issuer key.                                                          |
| Simulators and camera        | Historical pinned Spoolman service runs passed the read-only adapter. The latest ARM64 pacing diagnostic observed 542 consecutive ready samples over about 71 s, but rejected its pacing summary. RTSP parser/helper and finite native moving-video results remain separate checkpoints.                                                                                | SV06 and four-tool scenarios, genuine Connector data, restart/network faults, actual bounded RTSP helper execution, MediaMTX and authenticated camera must be connected and validated. A ready sample or finite fixture is insufficient. |
| Issue #9 loopback acceptance | At candidate `37ddf77b`, `npm run test:rtc-farm:all` passed all 12 built RTC rows, all 10 outage rows, the farm build and the flag-removal check. The loopback ledger below records the browser and simulator results.                                                                                                                                                  | The Docker topology, remote integration CI and owner hardware gates remain open.                                                                                                                                                         |

The dispatch-only simulator profile matrix has one complete successful run on
both native amd64 and arm64 runners at
[`ecef5cb`](https://github.com/bloodf/Open3DFarmManager/actions/runs/44744359687).
This records the matrix evidence required by epic #184; it does not supersede
the remaining browser and full Phase 0 acceptance gates above.

Detailed artifacts, limitations and historical failures remain in the
[rendered farm checkpoint](FARM-VIEW-CHECKPOINT.md),
[Connector runtime checkpoint](CONNECTOR-RTC-RUNTIME-CHECKPOINT.md),
[assignment binding checkpoint](RTC-ASSIGNMENT-BINDING-CHECKPOINT.md),
[pause issuer checkpoint](PAUSE-ISSUER-CHECKPOINT.md),
[native session result](SIMULATOR-ARM64-NATIVE-SESSION-RESULT.md) and
[Spoolman service validation](SPOOLMAN-ACTUAL-API-VALIDATION.md).

The earlier full run at `1e3a029` passed six RTC rows, ten outage rows and the three Docker network-fault profiles. Three RTC browser rows failed and the camera and two simulator fixtures were unavailable. The earlier standalone loopback mock contract remains available via `node scripts/test-farm-mock-acceptance.ts`.

## Issue #9 built loopback acceptance

Run `npm run test:rtc-farm:all` from a clean checkout after `npm ci`.
The default simulator mode is `OPENFARM_SIM=mock`. It uses a disposable
PostgreSQL 17 cluster, Chromium and the Go RTSP ingest helper built from this
checkout. Set `OPENFARM_PG_BIN` if PostgreSQL 17 is outside `PATH`. On Linux the local runner uses the selected PostgreSQL installation’s
`pg_config --libdir` to locate its libraries independently of Chromium. Set `TMPDIR` to a writable directory outside the checkout.

Validated candidate `37ddf77bfc2cc0c2e47c8fcacc2e50169c0644fb`. The command exited 0. All 12 RTC rows and 10 outage rows passed, along with the farm build and flag-removal check. This run sourced PostgreSQL before Chromium, matching the gate environment.

The run seals the Nitro build, provisions disposable
accounts and assignments in PostgreSQL, and exercises the built pages and
Connector over HTTPS, WSS and native WebRTC. The printing and inventory rows launch the packaged Connector CLI. Each mock listening socket binds
to loopback. The runner writes a commit-pinned `summary.json` plus per-row
receipts outside the repository.

| Issue #9 gate | Runner row                          | Evidence                                                                                                                                                                                                                                    |
| ------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E5.1          | `farm-page-printing-pause`          | Uploaded and started a no-motion job on the owned SV06 mock. Observed `printing` before confirmation, then `paused` through Moonraker, the browser result and one applied Connector journal entry. Resumed with no duplicate journal entry. |
| E5.2          | `command-rejected-tampered`         | Modified signature rejected over native WebRTC with the relay’s scope reason. Zero pause-driver calls or pauses.                                                                                                                            |
| E5.2          | `command-rejected-replayed`         | Original applied once. Duplicate closed the control session and caused zero additional pause-driver calls or pauses.                                                                                                                        |
| E5.2          | `command-rejected-expired`          | Expired signed command rejected. Zero pause-driver calls or pauses.                                                                                                                                                                         |
| E5.2          | `command-rejected-wrong-farm`       | Signed command with the wrong farm rejected. Zero pause-driver calls or pauses.                                                                                                                                                             |
| E5.2          | `command-rejected-wrong-assignment` | Signed command with the wrong assignment rejected. Zero pause-driver calls or pauses.                                                                                                                                                       |
| E5.2          | `command-rejected-revoked-device`   | Revoked the browser device over HTTPS while the received command was held before dispatch. Releasing the command after the Connector closed caused zero pause-driver calls or pauses.                                                       |
| E5.3          | `farm-page-disconnect`              | Rendered status changes, read-only degradation and recovery with a new observation.                                                                                                                                                         |
| E5.3          | `farm-page-revocation`              | Rendered read-only degradation after Connector revocation and no reconnect for 31 seconds.                                                                                                                                                  |
| E5.3          | `farm-page-pause`                   | Disabled control while degraded. After recovery, one explicit signed pause, then disabled control after revocation. The server received authority and signalling traffic only.                                                              |
| E5.3          | `farm-page-camera`                  | Browser decoded advancing RTSP video frames over WebRTC, stopped and restarted playback, then detached the video and stopped the helper after revocation.                                                                                   |
| E5.3          | `farm-page-simulator-inventory`     | Four-tool profile, live idle state and temperatures, six seeded Spoolman rows, then read-only degradation.                                                                                                                                  |
| E9.3          | `farm-page-simulator-inventory`     | `farm-page-printer-ui-origin-link` verified the link derives the printer UI origin from the observed Moonraker origin.                                                                                                                      |
| E9.4          | `farm-page-simulator-inventory`     | `farm-page-tablet-grid` and `printers-page-tablet-grid` verified one rendered column at 767 CSS px and two at 768 on both pages.                                                                                                            |
| E9.6          | `farmview-flag-removed`             | The built farm route rendered with the normal authenticated setup. Source checks verified the application and README contain no `farmView` feature gate.                                                                                    |
| E13.1         | Owner hardware run                  | Pending. Follow the [hardware acceptance checklist](HARDWARE-ACCEPTANCE-CHECKLIST.md).                                                                                                                                                      |

The outage runner passed these rows.

- `1-server-process-down`
- `5-network-blip-shorter-than-backoff`
- `2-database-unavailable-and-startup-gate-503`
- `3-connector-sigkill-after-commit-before-ack`
- `exactly-once-and-order-summary`
- `4-queue-cap-during-long-outage`
- `6-credential-renewal-across-outage`
- `7-pause-authority-expires-during-server-outage`
- `8-pause-authority-recovers-after-confirmation`
- `9-pause-authority-audit-survives-restart-in-order`

The loopback run leaves the Docker NAT, netem and UDP-block topology profiles,
containerized Klipper, Spoolman and MediaMTX, and remote integration CI for
separate runs. The owner-run checklist covers physical printer operation,
physical camera and LAN checks, and supervised pause and recovery.

## Docker network-fault job (Simulator workflow)

The dispatch-only [Simulator](../.github/workflows/sim.yml) workflow includes a
`network-fault` job on `ubuntu-24.04`. It sets `OPENFARM_SIM=docker` and runs
only the three Docker topology profiles (NAT, netem, UDP-block) via:

```sh
node scripts/test-rtc-farm-acceptance.ts --network-fault
```

That flag skips browser RTC rows, the farm build and outage suites. It never
contacts hardware. The E13.1 owner hardware row stays deferred and named in the
summary. The job uploads `sim-diagnostics/network-fault/` (including
`summary.json` and evidence) as the `sim-network-fault` artifact.

Dispatch from the Actions tab (or `gh workflow run sim.yml`). The coordinator
records the run result after the dispatch completes. Expected wall time is about
15–25 minutes on a cold runner (router image build plus one repeat per profile).

## Acceptance scope still required

- **Runtime and database:** built application with PostgreSQL readiness, reversible journal-verified migrations, validated configuration and structured diagnostics. Run the final integrated CI on the exact candidate head.
- **Simulator and integrations:** SV06 plus the existing four-tool fixture; Moonraker identify, status/subscriptions and cameras through RTSP/MediaMTX; read-only Spoolman against its pinned service; startup/restart and network-fault cases. Repeat on required architectures with bounded logs and no hardware.
- **Login, pairing and inventory:** independent login/logout, authenticated farm approval, rate limits, current membership/session checks, least-privilege discovery and Connector inventory reads. Verify wrong-farm, wrong-role, expired/revoked session and missing-resource behavior.
- **Browser identity and transport:** register approved browser keys through the authenticated flow; demonstrate actual Node Connector interoperability over browser-to-Connector WebRTC for status and camera. Verify signed pause over WebRTC without TURN or HTTP fallback.
- **Safety and recovery:** reject tampered, replayed, expired, wrong-scope and revoked commands; verify credential delivery/recovery after known and ambiguous failures, server/database outage recovery and read-only degradation. Define and enforce the offline authorization lifetime in the Connector.
- **Farm interface:** verify the built pt-BR interface from login through pairing and farm/device views, including data age and disabled controls when P2P is unavailable.

No single component helper, browser mock or synthetic service store satisfies these end-to-end gates. The seven-scenario experiment is not Node/Bun interoperability. The latest native amd64 control with no valid Moonraker sample is not an architecture comparison.

## Historical checkpoint index

These documents retain earlier scoped evidence and limitations. Their historical test counts and statements must not be read as current repository status:

- [Local integration checkpoint](INTEGRATION-CHECKPOINT.md) — initial local integration and its then-current limits.
- [Container validation](CONTAINER-VALIDATION-CHECKPOINT.md), [simulator readiness diagnosis](SIMULATOR-READINESS-DIAGNOSIS.md), [simulator follow-up](SIMULATOR-ACCEPTANCE-FOLLOWUP.md) and [bounded Klipper diagnostics](KLIPPER-CI-DIAGNOSTICS.md) — separate experiments; startup remains blocked.
- [PostgreSQL sessions](POSTGRES-SESSIONS-CHECKPOINT.md), [pairing persistence](PAIRING-PERSISTENCE-CHECKPOINT.md), [pairing proof](PAIRING-PROOF-CHECKPOINT.md) and [credential issuance](CONNECTOR-CREDENTIAL-ISSUANCE-CHECKPOINT.md) — isolated database behaviors, not authenticated end-to-end acceptance.
- [Browser keys](BROWSER-KEY-CHECKPOINT.md), [frontend accessibility](FRONTEND-ACCESSIBILITY-CHECKPOINT.md), [HTTP telemetry](HTTP-TELEMETRY-CHECKPOINT.md) and [integration queue](IMPLEMENTATION-QUEUE.md) — component and mock/loopback evidence, not a complete product flow.

## Publication and hardware gates

Track work as local, tested, validated, published or merged, with the exact commit/PR head. Review the immutable publication diff for private material and license obligations. The owner has authorized publication and merging ready PRs. Required current-head checks, review resolution and repository protections still apply. Deployment, DNS/credential changes and physical-printer tests remain separately authorized actions.
