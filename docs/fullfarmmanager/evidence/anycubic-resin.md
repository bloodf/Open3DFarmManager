# Anycubic resin driver evidence

Sources read on 2026-11-25. Simulator results are not hardware evidence. OpenFarm has run nothing on a printer. Every Anycubic resin catalog row stays unqualified.

## Sources

| Key | Source                                                                                                                                                                                                             | What it records                                                                                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | [anycubic-cloud-api PR 2](https://github.com/Nino6689/anycubic-cloud-api/pull/2), merged 2026-11-23 as `9a67074`                                                                                                   | Its author's P1 Max (132) connected in LAN Mode and answered `status` with `free`. Broker accepts only the issued client ID, refuses `#`, and ignores queries without timestamp and msgid. |
| C2  | [P1 Max report tests](https://github.com/Nino6689/anycubic-cloud-api/blob/9a6707477b74f943d2513986686d92ac38ed0406/tests/test_lan_photon_p1_max.py)                                                                | Captured status, resin temperature, release film, peripherals, light and local file list. Camera replies and request shape, which are test constructions rather than quoted captures.      |
| C3  | [P1 Max print tests](https://github.com/Nino6689/anycubic-cloud-api/blob/9a6707477b74f943d2513986686d92ac38ed0406/tests/test_lan_photon_p1_max_print.py)                                                           | One run from USB: copy, `printing` at layer 0, checks, refused pause and resume, `waiting` code 1301 (empty vat), stop reported as `stoped` code 601.                                      |
| C4  | [LAN command map](https://github.com/Nino6689/anycubic-cloud-api/blob/9a6707477b74f943d2513986686d92ac38ed0406/src/anycubic_cloud_api/lan/commands.py)                                                             | States that a USB start (`taskid` `-1`) was verified on a P1 Max. Gives the local forms of stop and file list.                                                                             |
| C5  | [Camera commit](https://github.com/robertzaage/hass-anycubic/commit/0f0f30c)                                                                                                                                       | The P1 Max opens its stream only for a full request envelope. The picture arrives sideways.                                                                                                |
| H1  | [PrintLog Bridge PR 121](https://github.com/HoffmanEngineering/printlog-bridge/pull/121) and [handshake](https://github.com/HoffmanEngineering/printlog-bridge/tree/8a205eb/src/printlog_bridge/adapters/anycubic) | Older P1 Max run: `/info` (`ctrlType` `net`) and `/ctrl` worked, then ports 8883 and 9883 refused connections.                                                                             |
| P1  | [Photon P1 notes](https://github.com/modrzew/hass-anycubic-photon-p1/blob/f33ceb5bc47388412a7a378ed58649736a5a6834/docs/protocol.md)                                                                               | Model **131**, from app analysis and a probe. Used for TLS properties and camera stream lifetime only.                                                                                     |

C1 to C4 come from a GPL-3.0 library. The adapter uses wire facts only and contains none of its code. No dependency was added.

The sources conflict. H1 ended at a refused broker, and C1 later records a working session. Neither C1 to C5 nor H1 records the firmware version, and C1 does not record `ctrlType`. The cause of the H1 refusal is unknown. A printer that refuses the broker still yields no session.

## Session by model

| Model               | LAN session                        | Connector behavior                 | Source and gap                                                                                                                                                |
| ------------------- | ---------------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Photon P1 Max (132) | Cited (C1); firmware unknown       | Operations below, after live proof | C1 to C5, with H1 as the contrary run.                                                                                                                        |
| Photon Mono M7      | Unverified; outside fleet catalog  | Refused before `/ctrl`; no control | [Product page](https://store.anycubic.com/products/photon-mono-m7). No LAN capture found.                                                                     |
| Photon Mono M7 Pro  | Unverified                         | Refused before `/ctrl`; no control | [Workshop manual](https://wiki.anycubic.com/photon-p1/%E5%88%87%E7%89%87%E8%BD%AF%E4%BB%B6/Anycubic%20Photon%20Workshop-EN-V1.0.0.pdf) shows a workflow only. |
| Photon Mono M7 Max  | Unverified                         | Refused before `/ctrl`; no control | Same manual: a LAN entry only.                                                                                                                                |
| Photon Mono 4 Ultra | Unverified                         | Refused before `/ctrl`; no control | Same manual: LAN transfer only.                                                                                                                               |
| Photon Mono M5s     | Unverified                         | Refused before `/ctrl`; no control | [Manual](https://wiki.anycubic.com/m5s/Photon%20Mono%20M5s-EN-V0.0.7.pdf): app operation, no LAN API.                                                         |
| Photon M3 Max       | Unverified; USB input documented   | No LAN operation                   | [Model wiki](https://wiki.anycubic.com/en/resin-3d-printer/photon-m3-max).                                                                                    |
| Photon P1 (131)     | Not P1 Max evidence; not cataloged | Refused before `/ctrl`             | P1.                                                                                                                                                           |

The manual and wiki links repeat the 2026-11-22 review in [the protocol note](../../protocols/anycubic-resin.md). On 2026-11-25 the wiki pages tried returned only a title or 404, and the store pages tried returned 429, so their text was not re-read. `photonResinModels` in `packages/connector/src/anycubic-resin/models.ts` holds this table. These rows have no read access through the adapter either.

## How a session earns capabilities

1. `openSession` needs the printer's serial and an owner-supplied SHA-256 pin of the broker certificate or public key. A bad pin value stops before any exchange.
2. It runs the existing `/info` and `/ctrl` exchange once, then connects to the configured address with the issued client ID. The pin is checked before the MQTT login is sent. The cipher setting admits the weak printer certificate (P1), so the pin is the only broker identity check. OpenFarm has no way yet to obtain or confirm the pin. Pinning on first use would trust whatever answers then.
3. It subscribes to `.../printer/public/132/<device>/+/report` and requires a `status` report. Refused login, refused subscription, silence or a lost link yields an error and no session.
4. `capabilities()` lists only what this session has received: for example `camera` needs a peripherals report with a camera, `print-stop` a job report in a stoppable state. A closed session lists nothing.

The camera row of the source table (C5) and the P1 notes (P1, MIT) are the stream evidence for the runtime: HTTP-FLV on `:18088/flv`, tied to the MQTT client that started it. P1 also lists H.264 Constrained Baseline, 640×480 at 10 fps, without saying which model was measured; no source measures the P1 Max codec.

Requests use the `web` topic origin that C1 to C3 used with the P1 Max. H1 and P1 name `pc` for resin printers; H1 never sent it to a P1 Max. There is no automatic reconnect. The broker takes one client with that ID, so a session can displace Photon Workshop.

## P1 Max operations

| Operation             | Evidence                                                                                                 | Adapter rule                                                                                                                                                                 | Simulator coverage                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Authenticated session | C1                                                                                                       | As above.                                                                                                                                                                    | Pin, login, subscription, silence, lost link, refused port, weak certificate.                           |
| Status                | C1, C2                                                                                                   | `free` is free. Any other value is unknown.                                                                                                                                  | Reported on query.                                                                                      |
| Job report            | C3                                                                                                       | `copying`, `printing`, `waiting`, `stoped`. Other states are unknown. Check lists and captured refusals leave the job unchanged. Time fields are omitted (units unverified). | Reported after start and on query in a new session.                                                     |
| Resin temperature     | C2                                                                                                       | Pushed `properties` report.                                                                                                                                                  | Simulator changes its value and pushes it.                                                              |
| Release film counter  | C2                                                                                                       | Wear counter only. Reset is refused.                                                                                                                                         | Reported on `get`.                                                                                      |
| Peripherals           | C2                                                                                                       | Gates camera and USB start.                                                                                                                                                  | Present and absent camera and USB.                                                                      |
| Local file list       | C2, C4                                                                                                   | Root only, with `path` `/`.                                                                                                                                                  | Reported list.                                                                                          |
| Camera start and stop | C5 and C2 (replies are test constructions); P1 for the stream lifetime                                   | Start needs a reported camera and `initSuccess` code 200. Stop accepts the three replies in C2. Returns `http://<host>:18088/flv`, rotation 270.                             | The simulator's FLV endpoint serves FLV bytes only after it applies start. Missing report is uncertain. |
| Start a file from USB | C4 (stated verified), C3 (run reports). Request fields come from library source, not a captured request. | `.pp1m` name in the USB root; fresh `free` status and USB report; no unstopped job. Confirmed by `printing` or `waiting` naming that file.                                   | Applied to simulator state: copy, then printing or the empty-vat wait. A missing file is ignored.       |
| Stop (cancel)         | C3, C4                                                                                                   | Caller names the file. Needs a fresh status answer and a reported `printing` or `waiting` job with that name. Confirmed only by `stoped` for the same file and task.         | Applied to simulator state, including ignored and unreported faults.                                    |

## Runtime wiring

All of this is simulator evidence. No write below is offered on any printer today.

### Collection

A collector v8 `drivers[]` entry with `family: "anycubic-resin"` names the `/info` origin (literal local IPv4), the owner-supplied broker pin, the expected serial and `Anycubic Photon P1 Max`. Any other model is refused at configuration with the reason from the model table. `brokerPort` and `cameraPort` override 8883 and 18088.

The Connector keeps one session per printer, polls it every second and shares it with signed control and the camera, because the broker takes one client. It publishes state (`free` as idle; a current `printing` or `waiting` report as printing), file name, progress, layers and the model. It publishes no firmware version, because none is reported. Anything else stays unknown, including a job report older than 5 seconds. A lost session is withdrawn and reopened after 30 seconds, which can still displace Photon Workshop.

Resin temperature, release film counter, peripherals, local file list and the job volume estimate are read by the session but not published: the farm protocol has no field or screen for them.

### Writes and qualification

`PHOTON_RESIN_QUALIFIED_WRITES` in `packages/connector/src/anycubic-resin/qualification.ts` lists `(operation, model, firmwareVersion)` and is **empty**. Neither the wire nor the runtime file can add an entry. No cited exchange reports firmware, so the only version a session can present is `unreported`: an owner who adds it qualifies a printer whose later firmware updates the Connector cannot detect.

| Write                         | Path                                                                                                                                              | While unqualified                                  | With a qualification entry                                                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Job stop (signed `cancel`)    | Signed command or API envelope, Connector dispatcher, `anycubic-resin/control-driver.ts`. Needs local `pause.control` opt-in. Wire: C3, C4.       | Not advertised; refused with `DriverRefusalError`  | Advertised only while a current report names a `printing` or `waiting` job. One publish after a fresh status answer; confirmed only by the matching `stoped` report; never resent.   |
| Camera start and stop         | Camera-purpose statement countersigned by the browser device, then `anycubic-resin/camera.ts`; FLV copied to H.264 over WebRTC. Wire: C2, C5, P1. | `startCapture` refused and logged; nothing is sent | One `startCapture` per viewing and one `stopCapture` after it. The camera is not a dispatcher action: there is no signed command for it, and the command journal does not record it. |
| USB start (`start_print`)     | Not wired. The adapter method exists (C4, C3).                                                                                                    | Refused: `resin-artifact-requires-library-version` | Still refused. Resin files start only as a validated library version, and no P1 Max upload is documented.                                                                            |
| Pause, resume, upload, others | None                                                                                                                                              | Refused                                            | Refused                                                                                                                                                                              |

The camera needs the runtime camera entry `{"kind": "anycubic-photon-resin", "address", "port"}` matching the printer's address and camera port.

### Tests

`tests/node/anycubic-resin-runtime.test.ts` covers configuration, collection and withdrawal, the refusals, the guarded and uncertain stop, and the camera source. `tests/journey/anycubic-resin.spec.ts` runs the farm app, a Connector and the simulator in a browser: first with the packaged Connector (status, no controls, camera refused, no write received), then with the test-only entry `tests/journey/anycubic-resin-connector.ts`, which qualifies stop and camera in code (camera over WebRTC, stop on leaving the view, lost session and recovery, one signed cancel). The journey encoder and the FLV tags are synthetic stand-ins; real FFmpeg decoding of this stream is untested.

While writing the journey, some signed attempts ended before anything was sent, and once the farm page's direct link did not return within a minute until the view was reopened. The Connector had kept its single printer session. The spec therefore reopens the view before each attempt, as the other signed journeys retry; the cause in the farm app was not investigated.

## Adapter tests

Tests: `tests/node/anycubic-resin-session.test.ts` and the unchanged `tests/node/anycubic-resin-protocol.test.ts`. Assertions on success read the report-derived session state and the simulator's own state.

Command results are `confirmed`, `rejected`, `refused` (no command sent; read-only queries may have been) or `uncertain`. An uncertain command is never resent by the adapter. After an uncertain start or stop, another start is refused until a report settles it or the caller opens a new session. A later stop is accepted only as a new explicit call. Retained MQTT reports are ignored.

## Refused

| Operation                                                                                                          | Reason                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause, resume                                                                                                      | C3 holds only `unablePause` (9000) and `unable-resume` (102) during pre-print. No accepted pause or resume on 132. The payloads in P1 are for model 131.                                                                |
| Upload                                                                                                             | The handshake names an upload URL, but no P1 Max request is documented. P1 lists `POST /upload/` with unknown authentication. The FDM `gcode_upload` route is another family.                                           |
| Measured resin use, vat level, resin ledger entries                                                                | C3 shows `supplies_usage` 25.17914 at layer 0, so it is the job estimate, and `Actual_volume` is null at the end. It is exposed only as `estimatedVolumeMl`. Nothing is derived from progress or written to the ledger. |
| Release film reset, light, exposure, axis, residue cleaning, resin feed, purifier, file delete, firmware, settings | Out of scope or without a verified P1 Max effect. C4 leaves out the film reset. No method exists.                                                                                                                       |
| USB file list                                                                                                      | C4 maps the request; no P1 Max reply is quoted.                                                                                                                                                                         |
| Every operation on other models                                                                                    | No cited session.                                                                                                                                                                                                       |

## Gaps

- Installed firmware is unknown for every source. No capability can be tied to a firmware version.
- C3 stopped a stalled job at layer 0. Stopping during exposure or movement is unobserved, though the adapter offers it for a reported `printing` job.
- C3 does not cover a completed, failed or paused job. Those states read as unknown, which blocks stop, and blocks another start in that session. The printer screen remains the way to cancel.
- Status values other than `free` are uncaptured. The simulator's `busy` is made up.
- No capture shows the reply to `print/query` for a running job, a rejected start, or whether replies echo `msgid`. The adapter matches on state, file and task, not `msgid`. The simulator's silent rejection and query reply are made up.
- Retained-message handling has no simulator case, because the mock broker does not set the retain flag.
- The copy report, the job values and the FLV bytes in the simulator are minimal synthetic fixtures.
- The session adapter itself verifies no authorization; only the runtime paths above reach it. [Driver registration](../DRIVER-REGISTRATION.md) still describes the refused-broker design.
- The P1 Max picture arrives sideways (C5, rotation 270). WebRTC delivery copies H.264 without re-encoding and the farm view applies no rotation.
- Whether a real P1 Max answers `print/query` during a job is uncaptured. If it only reports changes, a long job reads as unknown after 5 seconds and no stop is offered.
- Each broker reply is awaited for 2 seconds in runtime; a slower printer makes a stop or camera start uncertain. A stop and a camera command cannot overlap: the second is refused.
- The browser has no setup form, file list or compatibility row change for this driver.
- Owner checks needed before qualification: firmware version, `ctrlType`, certificate fingerprint, stream codec, and one supervised trace per operation above.
