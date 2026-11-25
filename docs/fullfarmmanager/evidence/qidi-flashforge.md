# Qidi and Flashforge driver evidence

All models remain **unqualified**. These are original synthetic fixtures
exercising the adapter transports through loopback. Firmware designations in
the tables identify source or allowlist evidence. Camera byte fixtures test
transport and framing. The evidence does not include stock-printer captures,
live hardware journeys, or Qidi Connector command bindings. The Flashforge
section describes its simulator-only runtime binding.

## Qidi

The vendor calls the X-Plus 4 **Plus4**. The model labels in the tests describe
provisioned variants. The Moonraker version in the fixture is shared synthetic
data. The operator supplies the local origin and model identity.

| Model     | Vendor evidence                                                                                                                                                                                                                                                  | Model-specific fixture and gap                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1 Pro    | [Printer configuration](https://github.com/QIDITECH/QIDI_Q1_Pro/blob/main/config/printer.cfg), [part fan macro](https://github.com/QIDITECH/QIDI_Q1_Pro/blob/main/config/gcode_macro.cfg), [firmware releases](https://github.com/QIDITECH/QIDI_Q1_Pro/releases) | Maps `fan_generic cooling_fan` to part-fan telemetry. The vendor's M106 part fan branch targets this object. Live readback for the installed firmware remains open. |
| Plus4     | [Vendor firmware and configuration](https://github.com/QIDITECH/QIDI_PLUS4/blob/main/config/printer.cfg)                                                                                                                                                         | Named part fan. Chamber and QIDI Box fields need dedicated evidence.                                                                                                |
| Q2        | [Vendor firmware and configuration](https://github.com/QIDITECH/QIDI_Q2/blob/main/config/printer.cfg)                                                                                                                                                            | Named part fan. Chamber, Box and stock endpoint behavior remain open.                                                                                               |
| Max4      | [Vendor firmware and configuration](https://github.com/QIDITECH/QIDI_MAX4/blob/main/config/printer.cfg)                                                                                                                                                          | Named part fan. The configuration lists two auxiliary fans. Their individual mapping, chamber and Box remain open.                                                  |
| X-Max 3   | [Vendor Moonraker fork and Fluidd documentation](https://github.com/QIDITECH/QIDI_MAX3)                                                                                                                                                                          | Common telemetry fixture omits fan. Stock fan object, camera and history availability remain open.                                                                  |
| X-Plus 3  | [Vendor Moonraker fork and Fluidd documentation](https://github.com/QIDITECH/QIDI_PLUS3)                                                                                                                                                                         | Common telemetry fixture omits fan. Stock fan object, camera and history availability remain open.                                                                  |
| X-Smart 3 | [Vendor Moonraker fork and Fluidd documentation](https://github.com/QIDITECH/QIDI_SMART3)                                                                                                                                                                        | Common telemetry fixture omits fan. Stock fan object, camera and history availability remain open.                                                                  |

- Each row exercises the targeted server probe, queried print state and
  progress, extruder and bed readings, newest history page and a configured
  same-origin JPEG snapshot. Missing objects stay unknown. The part-fan read
  accepts the standard object and falls back to the configured named part fan
  when present. Auxiliary and chamber fan readings stay outside this field.
  [Moonraker external API](https://moonraker.readthedocs.io/en/latest/external_api/),
  [Klipper status fields](https://www.klipper3d.org/Status_Reference.html#fan),
  [Qidi fork's named fan status implementation](https://github.com/QIDITECH/klipper/blob/master/klippy/extras/fan_generic.py).
- API-key G-code upload writes to the simulated `gcodes` root. An independent
  HTTP download from that root verifies the stored bytes, and a later adapter
  status verifies the active job is unchanged. The download is a simulator
  observation endpoint. Bearer uploads remain unsupported by the upload
  helper. Missing history and unconfigured snapshots return unsupported.
  [Moonraker file API](https://moonraker.readthedocs.io/en/latest/external_api/file_manager/),
  [Moonraker history API](https://moonraker.readthedocs.io/en/latest/external_api/history/).
- Start, pause, resume, cancel, heater and fan writes, chamber controls and Box
  operations are outside this adapter's exposed surface. Stock per-variant
  command semantics and authorization and interlock integration remain open.
  [Qidi protocol and integration gaps](../../protocols/qidi.md).

## Flashforge

| Model                                         | Accepted firmware   | Observed in the simulator and gaps                                                                                                                                                            |
| --------------------------------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adventurer 5M (0x0023)                        | 3.2.7, 5.1.8        | UDP identity, authenticated detail and flat file listing. Adapter upload, start, pause, resume, cancel, nozzle and bed targets, and cooling fan readback. Base fixture reports no camera URL. |
| Adventurer 5M Pro (0x0024)                    | 3.2.7, 5.1.8        | Same operations plus filtration state and MJPEG stream read. Signed lifecycle, temperatures, fan and camera activation under a test-only qualification. Camera frames over WebRTC.            |
| AD5X (0x0026)                                 | 1.1.7, 1.2.1, 3.1.0 | Identity, detail, detailed files, optional MJPEG and IFS trays. Signed lifecycle, temperatures, fan, slot load and slot record under a test-only qualification. Start and upload refused.     |
| Adventurer 3 and 4 Pro                        | Outside allowlist   | PID refusal in discovery and authenticated detail. These families use the legacy TCP protocol.                                                                                                |
| Guider 2, Finder 3, Guider 4 and Guider 4 Pro | Outside allowlist   | PID refusal in discovery and authenticated detail. Adapter-specific firmware and protocol evidence is pending.                                                                                |
| Creator 5 and Creator 5 Pro                   | Outside allowlist   | PID refusal in discovery and authenticated detail. Their HTTP interface describes a separate four-tool schema and command set.                                                                |

### Sources

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

### Write gate and command binding

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
  and database migration `0126_camera_stream_filament_slot`.
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
  runs cover every signed action: the 5M Pro actions including camera off and
  on, and on AD5X pause, cancel, slot record and slot load. The AD5X journey
  also verifies that a signed repeat of the same slot record is refused before
  any additional printer write.

### Camera

The `flashforge-mjpeg` camera source reads the documented
`:8080/?action=stream` MJPEG and sends it over the existing WebRTC media path.
The journey decodes frames from a synthetic stream, served separately from the
simulator that receives activation commands. The source only reads. Starting the
stream is the gated `set_camera_stream` command, never a side effect of viewing.
Real stream framing is unverified.

### Refused or not bound

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

### Remaining

File listing is the available file inventory. Measured spool use remains outside
the adapter. Simulator readback is no evidence of heating, motion or physical
safety.

Before qualification, capture installed firmware identities, actual LAN
authentication and discovery behavior, per-model optional telemetry, cameras,
and independent readback of authorized actions, including Connector safety
enforcement on the command and media routes.
