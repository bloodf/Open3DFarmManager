# Qidi and Flashforge driver evidence

All models remain **unqualified**. These are original synthetic fixtures
exercising the adapter transports through loopback. Firmware designations in
the tables identify source or allowlist evidence. Camera byte fixtures test
transport and framing. The evidence does not include stock-printer captures,
Connector runtime bindings, or live hardware journeys.

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

| Model                                         | Accepted firmware   | Observed in the simulator and gaps                                                                                                                                                                      |
| --------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adventurer 5M (0x0023)                        | 3.2.7, 5.1.8        | UDP identity, authenticated detail and flat file listing. Upload, start, pause, resume, cancel, nozzle and bed targets, and cooling fan readback. Base fixture reports no camera URL.                   |
| Adventurer 5M Pro (0x0024)                    | 3.2.7, 5.1.8        | Same operations plus internal and external filtration state and MJPEG stream read. Filtration control and camera activation are outside the adapter.                                                    |
| AD5X (0x0026)                                 | 1.1.7, 1.2.1, 3.1.0 | UDP identity, authenticated detail, detailed file listing, optional MJPEG and IFS slot presence, material and color. Writes are refused pending a separate review of multi-tool files and slot mapping. |
| Adventurer 3 and 4 Pro                        | Outside allowlist   | PID refusal in discovery and authenticated detail. These families use the legacy TCP protocol.                                                                                                          |
| Guider 2, Finder 3, Guider 4 and Guider 4 Pro | Outside allowlist   | PID refusal in discovery and authenticated detail. Adapter-specific firmware and protocol evidence is pending.                                                                                          |
| Creator 5 and Creator 5 Pro                   | Outside allowlist   | PID refusal in discovery and authenticated detail. Their HTTP interface describes a separate four-tool schema and command set.                                                                          |

Firmware and wire references include the [PID table](https://github.com/Parallel-7/flashforge-api-docs/wiki/Printer-PIDs),
[5M family firmware analysis](https://github.com/Parallel-7/flashforge-api-docs/wiki/Adventurer-5M-Series),
[AD5X firmware analysis](https://github.com/Parallel-7/flashforge-api-docs/wiki/AD5X),
[Creator 5 family](https://github.com/Parallel-7/flashforge-api-docs/wiki/Creator-5-Series),
[UDP discovery](https://github.com/Parallel-7/flashforge-api-docs/wiki/Discovery-Protocol)
and [HTTP REST operations](https://github.com/Parallel-7/flashforge-api-docs/wiki/HTTP-REST-API).

- The simulator applies the authenticated write and exposes the effect through
  subsequent `/detail` or `/gcodeList` reads. Upload adds a file without
  changing job state. Start publishes the new job name and progress, pause and
  resume change its phase, and cancel clears the active filename. Fan and
  heater assertions read the resulting cooling percentage or target. Heater
  targets and current temperatures are distinct.
- The adapter refuses unlisted firmware, unsafe filenames and setpoints,
  unauthorized requests, and commands that conflict with the observed job
  state. The two 5M variants require caller authority, including the start
  interlock. The adapter sends no automatic retry after an uncertain result.
  [Flashforge protocol and integration gaps](../../protocols/flashforge.md).
- File listing is the available file inventory. Completed-run history,
  measured spool use, slot writes, filtration control, camera activation and
  browser media delivery remain outside the adapter surface. Temperature
  readback here confirms target changes in the simulator. It provides no
  evidence of heating behavior or physical safety.

Before qualification, capture installed firmware identities, actual LAN
authentication and discovery behavior, per-model optional telemetry, cameras,
and independent readback of authorized actions. Verify runtime binding and
Connector safety enforcement with the intended command and media routes.
