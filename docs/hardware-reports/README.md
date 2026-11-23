# Hardware qualification reports

Reports written by the read-only [`scripts/qualify-printer.ts`](../QUALIFY-PRINTER.md) against real printers on the owner's LAN, for epic #255. A catalog status is `hardware` only when a report here matches that catalog entry and proves the capability; `tests/unit/catalog-hardware-evidence.test.ts` enforces it.

No command, G-code, upload or print start was sent in any run.

## Redaction

Each file is the CLI's JSON output with these changes:

- `host` is replaced by `<printer-host>`; a camera URL, when present, by `<camera-url>`; a device id / serial by `<device-id>`.
- File names are replaced by `<redacted-N>.gcode` and the list is cut to five entries. `files.count` keeps the real total.

No run needed a credential, so the reports never held one.

## Runs of 2026-11-21

| Report                                                                                   | Printer                                                                  | Result                                                                | Proven                                                     | Not proven                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [2026-11-21-sovol-sv06-moonraker.json](2026-11-21-sovol-sv06-moonraker.json)             | Sovol SV06, Klipper v0.13.0, Moonraker v0.11.0 (API 1.5.0)               | `qualified`. The printer was mid-print; the run only read.            | Telemetry (4 fields), file listing (18)                    | Camera: Moonraker lists no webcam.                                                               |
| [2026-11-21-snapmaker-u1-moonraker.json](2026-11-21-snapmaker-u1-moonraker.json)         | Snapmaker U1, four toolheads, vendor Klipper/Moonraker 2.0.0 (API 1.4.0) | `qualified`, idle.                                                    | Telemetry (4 fields, 4 tools), files (16)                  | Camera: the declared webcam is served from another host, not contacted.                          |
| [2026-11-21-anycubic-kobra-x-kobralink.json](2026-11-21-anycubic-kobra-x-kobralink.json) | Anycubic Kobra X (model id 20030, LAN mode)                              | `unreachable`: there is no KobraLink bridge in front of this printer. | Nothing                                                    | Everything. The `kobra-x` vendor below replaced this path.                                       |
| [2026-11-21-anycubic-kobra-x-native.json](2026-11-21-anycubic-kobra-x-native.json)       | Anycubic Kobra X (model id 20030, firmware 2.0.2.8), native LAN          | `qualified`, idle.                                                    | Telemetry: state, nozzle/bed temperatures, fans, ACE slots | Files: no `listLocal` report. Camera URL reachable but not wired to the product's media session. |

The CLI reports every Moonraker printer as `Moonraker Generic`, so both Klipper reports match the catalog entry `klipper-generic-moonraker`. The Kobra X was first tried through the `kobralink` bridge vendor (`unreachable`, no bridge) and then qualified through the native `kobra-x` vendor, which recovers identity and credentials over HTTP `18910` and reads telemetry over MQTTS `9883` with the bundled Anycubic Slicer client identity. Both runs were read-only.

## Catalog promotion

| Catalog entry               | Capability | From        | To         | Reports        |
| --------------------------- | ---------- | ----------- | ---------- | -------------- |
| `klipper-generic-moonraker` | telemetry  | `simulated` | `hardware` | SV06 and U1    |
| `anycubic-kobra-x`          | telemetry  | `simulated` | `hardware` | Native Kobra X |

Left as they were, on purpose:

- **Klipper files** stay `unknown`. Both reports list files, but the catalog rule is that the product cannot reach Moonraker files yet (`createFileTargets` builds no Moonraker file target).
- **Klipper camera, materials, pause, resume and cancel** stay `simulated`. A read-only run cannot prove them, and no camera answered.
- **Kobra X files, pause, resume and cancel** stay `simulated`. The native read-only run observed no file listing and cannot prove the commands.
- **Kobra X camera** stays `unknown`. The native run proved the camera URL is reachable (recorded in the report), but OpenFarm has no media route to display the Kobra X camera yet, so the product capability is not proven.
- **Kobra X materials** stays `unknown`. ACE slots appear inside the telemetry, but the product has no signed material-command path.
- **Bambu and Creality**: no such printer was on the LAN.
