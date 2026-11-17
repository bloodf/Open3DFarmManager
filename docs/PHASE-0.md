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

- No TURN, cloud slicing, server-enqueued commands or HTTP/server command fallback. Status, camera and signed commands use browser-to-Connector WebRTC.
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
| Packaged Connector runtime   | The fixed package at `17b4ac4` passed actual CLI collection, authenticated signalling and RTC status against the maintained application and a loopback Moonraker protocol fixture. Native loading remains lazy and the package notice/output manifest is recorded.                                                                                                      | Genuine pinned Moonraker/Klipper, standalone distribution and current native binary provenance remain pending.                                                                                                                           |
| Rendered farm view           | At `422e83f`, separate actual `/farm` disconnect and revocation runs passed. The page uses its production composable, existing IndexedDB key and genuine feed. It displays progress changes, then unavailable with the previous observation; pause stays disabled. No application API or RTC interception is used.                                                      | This uses synthetic Moonraker protocol data, not a simulator process. Camera and signed pause remain unavailable. Browser fixture TLS ignores certificate errors and does not prove production deployment.                               |
| Pause authority and safety   | The maintained 0018 issuer preparation passed twenty named PostgreSQL checks at `b21df2b`, followed by actual database restart and three fresh-process checks. The journal, dispatcher and fixed pause driver also have scoped tests.                                                                                                                                   | Actual browser control peer, issuer HTTP/runtime composition, driver integration and printing-simulator pause are not accepted. Restart replay used a new synthetic issuer key.                                                          |
| Simulators and camera        | Historical pinned Spoolman service runs passed the read-only adapter. The latest ARM64 pacing diagnostic observed 542 consecutive ready samples over about 71 s, but rejected its pacing summary. RTSP parser/helper and finite native moving-video results remain separate checkpoints.                                                                                | SV06 and four-tool scenarios, genuine Connector data, restart/network faults, actual bounded RTSP helper execution, MediaMTX and authenticated camera must be connected and validated. A ready sample or finite fixture is insufficient. |
| Full Phase 0                 | No exact candidate combines all required real services, browser flows, status, camera, signed pause and outage recovery.                                                                                                                                                                                                                                                | Incomplete.                                                                                                                                                                                                                              |

Detailed artifacts, limitations and historical failures remain in the
[rendered farm checkpoint](FARM-VIEW-CHECKPOINT.md),
[Connector runtime checkpoint](CONNECTOR-RTC-RUNTIME-CHECKPOINT.md),
[assignment binding checkpoint](RTC-ASSIGNMENT-BINDING-CHECKPOINT.md),
[pause issuer checkpoint](PAUSE-ISSUER-CHECKPOINT.md),
[native session result](SIMULATOR-ARM64-NATIVE-SESSION-RESULT.md) and
[Spoolman service validation](SPOOLMAN-ACTUAL-API-VALIDATION.md).

At `origin/main` `36d1198` the official migration catalog is contiguous through
0023 and the toolchain is pnpm 12.18.0 with Node 24.22.3. The table above was
recorded earlier and was not re-run on this head; no integrated gate exists for
it. The [implementation queue](IMPLEMENTATION-QUEUE.md) lists the remaining work
in dependency order. Use this ledger and the exact checkpoint receipts when
selecting remaining work. Historical counts and prepared-but-unrun tests are not current acceptance.

The separate pause transport subsequently passed five actual native cases at
`579f377`, recorded in [the control RTC checkpoint](PAUSE-CONTROL-RTC-CHECKPOINT.md).
Those cases use synthetic authority and execute no printer commands. They do
not close the integrated issuer, signalling, driver and simulator gate below.

## Acceptance scope still required

- **Runtime and database:** built application with PostgreSQL readiness, reversible journal-verified migrations, validated configuration and structured diagnostics. Run the final integrated CI on the exact candidate head.
- **Simulator and integrations:** SV06 plus the existing four-tool fixture; Moonraker identify, status/subscriptions and cameras through RTSP/MediaMTX; read-only Spoolman against its pinned service; startup/restart and network-fault cases. Repeat on required architectures with bounded logs and no hardware.
- **Login, pairing and inventory:** independent login/logout, authenticated farm approval, rate limits, current membership/session checks, least-privilege discovery and Connector inventory reads. Verify wrong-farm, wrong-role, expired/revoked session and missing-resource behavior.
- **Browser identity and transport:** register approved browser keys through the authenticated flow; demonstrate actual Node Connector interoperability over browser-to-Connector WebRTC for status and camera. Verify signed pause without TURN or server/HTTP fallback.
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
