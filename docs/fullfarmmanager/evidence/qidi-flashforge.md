# Qidi and Flashforge driver evidence

All models remain **unqualified**. These are original synthetic fixtures
exercising the adapter transports through loopback. Firmware designations in
the tables identify source or allowlist evidence. Camera byte fixtures test
transport and framing. The evidence does not include stock-printer captures,
live hardware journeys, or Qidi Connector command bindings.

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

Moved to [Flashforge driver evidence](flashforge.md).
