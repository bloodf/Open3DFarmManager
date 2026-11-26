# Flashforge driver evidence

All models remain **unqualified**. These are original synthetic fixtures
exercising the adapter transports and the Connector runtime binding through
loopback. Firmware designations identify source or allowlist evidence. Camera
byte fixtures test transport and framing. The evidence does not include
stock-printer captures or live hardware journeys. The command binding is proven
against the simulator only.

## Models

| Model                                         | Accepted firmware   | Observed in the simulator and gaps                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adventurer 5M (0x0023)                        | 3.2.7, 5.1.8        | UDP identity, authenticated detail and flat file listing. Adapter upload, start, pause, resume, cancel, nozzle and bed targets, and cooling fan readback. Base fixture reports no camera URL. Browser journey covers status loss/recovery, shipped read-only behavior and test-only qualified lifecycle, temperatures, fan and optional camera control. |
| Adventurer 5M Pro (0x0024)                    | 3.2.7, 5.1.8        | Same operations plus filtration state and MJPEG stream read. Signed lifecycle, temperatures, fan and camera activation under a test-only qualification. Camera frames over WebRTC.                                                                                                                                                                      |
| AD5X (0x0026)                                 | 1.1.7, 1.2.1, 3.1.0 | Identity, detail, detailed files, optional MJPEG and IFS trays. Signed lifecycle, temperatures, fan, slot load and slot record under a test-only qualification. Start and upload refused.                                                                                                                                                               |
| Adventurer 3 and 4 Pro                        | Outside allowlist   | PID refusal in discovery and authenticated detail. These families use the legacy TCP protocol.                                                                                                                                                                                                                                                          |
| Guider 2, Finder 3, Guider 4 and Guider 4 Pro | Outside allowlist   | PID refusal in discovery and authenticated detail. Adapter-specific firmware and protocol evidence is pending.                                                                                                                                                                                                                                          |
| Creator 5 and Creator 5 Pro                   | Outside allowlist   | PID refusal in discovery and authenticated detail. Their HTTP interface describes a separate four-tool schema and command set.                                                                                                                                                                                                                          |

## Sources

Wire formats come from `Parallel-7/flashforge-api-docs`, a third-party
reference, not a maker specification: wiki commit `885702f` (GitHub) and
endpoint files at commit `7e3bc8b` (GitHub), identical to GitLab commit
`3dad711`. The GitLab wiki was empty when checked. No licence file was found in
either repository. Protocol facts informed original code; no code, firmware or
capture was copied.

The pinned endpoint paths are [5M 3.2.7](https://github.com/Parallel-7/flashforge-api-docs/blob/7e3bc8b8d196f0bab25205cf0fde2c99c010798b/endpoints/endpoints_5m_3.2.7.yaml),
[AD5X 1.1.7](https://github.com/Parallel-7/flashforge-api-docs/blob/7e3bc8b8d196f0bab25205cf0fde2c99c010798b/endpoints/endpoints_ad5x_1.1.7.yaml)
and [AD5X 1.2.1](https://github.com/Parallel-7/flashforge-api-docs/blob/7e3bc8b8d196f0bab25205cf0fde2c99c010798b/endpoints/endpoints_ad5x_1.2.1.yaml).
The open-source client [GhostTypes/ff-5mp-api-py, release 1.6.0](https://pypi.org/project/flashforge-python-api/1.6.0/#files)
(MIT) corroborates the command names in `flashforge/api/constants/commands.py`,
the lifecycle body in `flashforge/api/controls/job_control.py`, the temperature
body in `flashforge/api/controls/temp_control.py` and the fan and slot bodies
in `flashforge/api/controls/control.py`. The released source archive has SHA-256
`fa4ebeaede1acab54ef365c3b5ae4f693ab0eb724624eb7f60454aff543522d0`.
The pinned endpoint files and wiki supply the rest of the HTTP and UDP framing.

Pages used: [PID table](https://github.com/Parallel-7/flashforge-api-docs/wiki/Printer-PIDs),
[5M family](https://github.com/Parallel-7/flashforge-api-docs/wiki/Adventurer-5M-Series),
[5M Pro features](https://github.com/Parallel-7/flashforge-api-docs/wiki/Adventurer-5M-Pro-Features),
[AD5X](https://github.com/Parallel-7/flashforge-api-docs/wiki/AD5X),
[material station](https://github.com/Parallel-7/flashforge-api-docs/wiki/AD5X-IFS-Material-Station),
[capability matrix](https://github.com/Parallel-7/flashforge-api-docs/wiki/Capability-Matrix),
[Creator 5 family](https://github.com/Parallel-7/flashforge-api-docs/wiki/Creator-5-Series),
[UDP discovery](https://github.com/Parallel-7/flashforge-api-docs/wiki/Discovery-Protocol)
and [HTTP REST operations](https://github.com/Parallel-7/flashforge-api-docs/wiki/HTTP-REST-API).

## Write gate and command binding

- `FLASHFORGE_QUALIFIED_WRITES` in
  `packages/connector/src/flashforge/qualification.ts` is empty. The shipped
  Connector offers no Flashforge command and sends no write. A signed command
  is refused as `unsupported-action`, and the driver raises
  `DriverRefusalError` before writing. Add a model and firmware pair only with
  its supervised hardware run recorded in this file. With a pair listed, the
  firmware is read once when command control starts, so a printer unreachable
  then stays without controls until the Connector restarts. Every write reads
  the firmware again.
- Command binding needs `control: true` on the local v8 driver binding and the
  assignment in `pause.control.assignmentIds`. Either one alone leaves the
  printer read-only. Only a command-bound printer queues telemetry, which the
  command issuer needs to grant its controls.
- Signed actions: `pause`, `resume`, `cancel`, `set_temperature` (nozzle
  0-265 °C, bed 0-100 °C; chamber refused) and `set_fan` (part fan 0-100 %) on
  all three models; `set_camera_stream` on 5M and 5M Pro; `load_filament`
  (`ms_cmd` action 0) and `set_filament_slot` (`msConfig_cmd`) on AD5X. Signed
  trays 0-3 map to slots 1-4. The Connector uses the documented LAN command
  range even though the [maker’s AD5X specifications](https://www.flashforge.com/products/flashforge-ad5x-3d-printer)
  list higher hardware ceilings of 300 °C and 110 °C.
  The REST wiki and Python client express part cooling as a percentage. The
  pinned AD5X YAML describes 0-255, so qualification must resolve the scale
  against the intended firmware's readback.
- `set_camera_stream` and `set_filament_slot` are new browser-only signed
  actions. No API envelope carries them. They need command journal version 20
  and database migration `0127_camera_stream_filament_slot`.
- `/control` acknowledges commands the firmware ignores. Only a `/detail` read
  that began after the acknowledgement confirms a result. Without it the
  outcome is unknown and nothing is sent again.
- A slot load needs a ready printer, an idle station, detected filament, 1-4
  slot numbering and a different active slot. It is confirmed when the station
  is idle again with that slot active. The pinned AD5X endpoint schema
  distinguishes operation mode (`stateAction`) and progress (`stateStep`).
  The sources give no load duration or confirmation that `currentSlot`
  identifies the loaded slot after completion. Both need hardware validation.
  The Connector allows 24 seconds for the result.
- Camera activation sends `streamCtrl_cmd` `open` or `close`. The endpoint
  files define the readback: `cameraStreamUrl` is empty while the camera is off,
  otherwise the stream URL. A request for the state already reported is refused,
  as is one without an explicit report. A 5M without a camera acknowledges and
  does nothing, which ends as an unknown outcome.
- **Camera off during a print is refused** (#956). The stream-control section of
  the [5M Pro features page](https://github.com/Parallel-7/flashforge-api-docs/wiki/Adventurer-5M-Pro-Features#stream-control)
  documents `open` and `close` and states no print-state rule, so the source does
  not show that closing is harmless during a job. The camera is the operator's
  remote view of the print, and nothing in a print needs it off, so the Connector
  sends `close` only when the send-time `/detail` read says `ready`, `completed`
  or `cancel`. During `printing` or `pause` the operator gets "A câmera não pode
  ser desligada durante uma impressão, para não interromper o monitoramento
  remoto."; the other states were already refused. `open` stays allowed during a
  print. Closing the view in the browser does not stop the printer's stream. The
  printer's own touchscreen and apps are outside this rule.
- A slot record sends `msConfig_cmd` with a listed material and a colour. It
  needs a ready printer, an idle station and a record that differs from the
  report, and is confirmed by that slot's `materialName` and `materialColor`.
  The wiki gives `rgb` without `#`; the endpoint file example includes it. The
  Connector follows the wiki and compares the readback with or without `#`.
  Hardware must verify the stored format.
- The collector publishes AD5X trays as `ifs:0` to `ifs:3` only with 1-4
  numbering, so the farm page can name a slot for load and record.
- Node tests drive each signed action through the shipped dispatcher and
  command journal. `flashforge.spec.ts` runs the shipped build (no command, no
  write), then edits the freshly built Connector for the run to qualify one
  pair, and restores it. No runtime setting can qualify a pair. The browser
  runs cover every signed action: the 5M and 5M Pro actions including a camera off
  refused during the print and camera off and on after it, and on AD5X pause, cancel, slot record and slot load. The AD5X journey
  also verifies that a signed repeat of the same slot record is refused before
  any additional printer write.

## Camera

The `flashforge-mjpeg` camera source reads the documented
`:8080/?action=stream` MJPEG and sends it over the existing WebRTC media path.
The journey decodes frames from a synthetic stream, served separately from the
simulator that receives activation commands. The source only reads. Starting the
stream is the gated `set_camera_stream` command, never a side effect of viewing.
Real stream framing is unverified.

## Refused or not bound

| Operation             | Source                                                                                                                                     | Reason                                                                                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job history           | No history route in the wiki or endpoint files. `cumulativeFilament` and `cumulativePrintTime` are lifetime totals; `/gcodeList` is files. | `readHistory()` rejects with the reason.                                                                                                                        |
| AD5X camera control   | Capability matrix: `streamCtrl_cmd` "No" for AD5X.                                                                                         | `set_camera_stream` is not offered.                                                                                                                             |
| Slot unload           | `ms_cmd` action 1; unload "requires the extruder to be heated".                                                                            | No temperature requirement is given. `unload_filament` is not offered.                                                                                          |
| Slot operation cancel | `ms_cmd` action 2.                                                                                                                         | Not bound: the signed `cancel` means the print job, and no source says which printer state an operation reports, which the signed state rules need.             |
| AD5X start and upload | `/printGcode` with `useMatlStation` and `materialMappings`.                                                                                | Deferred: signed start arguments do not carry the colour and tool mapping, and the file list holds only 10 recent files.                                        |
| 5M start and upload   | `/printGcode`, `/uploadGcode`.                                                                                                             | Adapter only. Bed-clear and material temperature interlocks are not bound.                                                                                      |
| Print speed           | `printerCtl_cmd` `speed`: 50-150 on 5M and 5M Pro, 50-500 on AD5X.                                                                         | Not bound: `currentPrintSpeed` and `printSpeedAdjust` are typed but never described, so no readback is cited. Named `set_speed` modes also exceed the 5M limit. |
| Filtration and light  | `circulateCtl_cmd` (pages disagree on AD5X), `lightControl_cmd`.                                                                           | Outside this work order.                                                                                                                                        |
| Manual motion         | `moveCtrl_cmd`, `extrudeCtrl_cmd`, `homingCtrl_cmd`, `errorCodeCtrl_cmd`.                                                                  | Outside this work order.                                                                                                                                        |

The material station page and endpoint files number slots 1-4, while one
example in the AD5X page shows slot 0. The adapter reads 0-4, which fixes the
earlier rejection of slot 4, and refuses a load when any reported slot is 0.

## Browser journey

`flashforge.spec.ts` runs one harness per model and build: status loss and
recovery and the shipped build for the 5M and 5M Pro, and test-only qualified 5M, 5M Pro and AD5X. The 5M journey fixture reports an optional camera stream, while the base fixture covers absent camera metadata. [PID assignments](https://github.com/Parallel-7/flashforge-api-docs/wiki/Printer-PIDs), [5M series](https://github.com/Parallel-7/flashforge-api-docs/wiki/Adventurer-5M-Series), and the [HTTP API](https://github.com/Parallel-7/flashforge-api-docs/wiki/HTTP-REST-API) document identity and commands. The
command journeys open the telemetry upload only until the server holds the
advertised controls, then close it. Telemetry, status and control inboxes share
one proof slot per Connector credential, and a permanently open upload keeps
displacing the live and control sessions. The upload is reopened before the
issuer's two-minute freshness window ends.

## Remaining

File listing is the available file inventory. Measured spool use remains outside
the adapter. Simulator readback is no evidence of heating, motion or physical
safety.

Before qualification, capture installed firmware identities, actual LAN
authentication and discovery behavior, per-model optional telemetry, cameras,
and independent readback of authorized actions, including Connector safety
enforcement on the command and media routes.
