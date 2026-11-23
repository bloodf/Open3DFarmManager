# Hardware qualification reports

Reports written by the read-only [`scripts/qualify-printer.ts`](../QUALIFY-PRINTER.md) against real printers on the owner's LAN, for epic #255. A catalog status is `hardware` only when a report here matches that catalog entry and proves the capability; `tests/unit/catalog-hardware-evidence.test.ts` enforces it.

No command, G-code, upload or print start was sent in any run.

## Redaction

Each file is the CLI's JSON output with these changes:

- `host` is replaced by `<printer-host>`; a camera URL, when present, by `<camera-url>`; a device id / serial by `<device-id>`.
- Hostnames and camera labels are replaced with placeholders when present.
- File names are replaced by `<redacted-N>.gcode` and the list is cut to five entries. `files.count` keeps the real total.

The published reports contain no credentials.

## Runs of 2026-11-21

| Report                                                                                   | Printer                                                                  | Result                                                                | Proven                                                     | Not proven                                                                                       |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| [2026-11-21-sovol-sv06-moonraker.json](2026-11-21-sovol-sv06-moonraker.json)             | Sovol SV06, Klipper v0.13.0, Moonraker v0.11.0 (API 1.5.0)               | `qualified`. The printer was mid-print; the run only read.            | Telemetry (4 fields), file listing (18)                    | Camera: Moonraker lists no webcam.                                                               |
| [2026-11-21-snapmaker-u1-moonraker.json](2026-11-21-snapmaker-u1-moonraker.json)         | Snapmaker U1, four toolheads, vendor Klipper/Moonraker 2.0.0 (API 1.4.0) | `qualified`, idle.                                                    | Telemetry (4 fields, 4 tools), files (16)                  | Camera: the declared webcam is served from another host, not contacted.                          |
| [2026-11-21-anycubic-kobra-x-kobralink.json](2026-11-21-anycubic-kobra-x-kobralink.json) | Anycubic Kobra X (model id 20030, LAN mode)                              | `unreachable`: there is no KobraLink bridge in front of this printer. | Nothing                                                    | Everything. The `kobra-x` vendor below replaced this path.                                       |
| [2026-11-21-anycubic-kobra-x-native.json](2026-11-21-anycubic-kobra-x-native.json)       | Anycubic Kobra X (model id 20030, firmware 2.0.2.8), native LAN          | `qualified`, idle.                                                    | Telemetry: state, nozzle/bed temperatures, fans, ACE slots | Files: no `listLocal` report. Camera URL reachable but not wired to the product's media session. |

The CLI reports both Moonraker printers in the 2026-11-21 run as `Moonraker Generic`, so both Klipper reports match the catalog entry `klipper-generic-moonraker`. The Kobra X was first tried through the `kobralink` bridge vendor (`unreachable`, no bridge) and then qualified through the native `kobra-x` vendor, which recovers identity and credentials over HTTP `18910` and reads telemetry over MQTTS `9883` with the bundled Anycubic Slicer client identity. Both runs were read-only.

## Runs of 2026-11-23

The owner authorized these read-only probes for #255, #256, and #259. The CLI and Connector snapshot reader ran from commit `2755aa9fbe4c1bb09eed4e40746bffc7006ab465` on Node.js 24.22.2. Supplemental Moonraker GETs queried printer state, heater temperatures, progress, and the active spool assignment. No POST, G-code, control, or file upload was sent.

| Report                                                                        | Status and temperatures                                                                                                                                                             | Camera                                                                                                                                                    | Spool data                        | File listing                             |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ---------------------------------------- |
| [Snapmaker U1 via Moonraker](2026-11-23-snapmaker-u1-moonraker.json)          | Pass. Idle after a completed job, four tool temperatures and bed temperature observed. Klipper paxx12, Moonraker API 1.4.0.                                                         | Pass for one JPEG snapshot. The Connector's `createMoonrakerSnapshotSource` fetched and validated the JPEG. The second declared source returned HTTP 404. | Pass for active spool assignment. | Pass. Three entries.                     |
| [Sovol SV06 via Moonraker](2026-11-23-sovol-sv06-moonraker.json)              | Pass. Production job `printing` at 28.6%, with nozzle and bed temperatures. Moonraker API 1.5.0.                                                                                    | Skipped.                                                                                                                                                  | Pass for active spool assignment. | Skipped.                                 |
| [Anycubic Kobra X via direct LAN MQTT](2026-11-23-anycubic-kobra-x-mqtt.json) | Fail. The native identity GET confirmed the Kobra X in LAN mode. MQTT TLS validation failed with `CERT_HAS_EXPIRED` before subscription, so status and temperatures are unverified. | Unverified.                                                                                                                                               | Unverified.                       | Outside the Anycubic LAN MQTT qualifier. |

The SV06 requests were limited to status and active-spool queries. A local guard skipped the CLI's connection registration, webcam, system information, and file-list requests for that printer.

The Kobra X run used `--vendor anycubic` on the printer's MQTT port 9883, with the serial read privately from `GET /info`. The MQTT report includes the TLS diagnostic captured during the CLI run. The run had no independently verified broker pin or printer MQTT account credentials. TLS failed before authentication or subscription. The guard blocked MQTT publishes throughout the run.

These reports cover direct read-only qualification. WebRTC farm display and Spoolman inventory were outside this run. The signed pause in checklist section 8 and all steps involving heat or motion are **pending owner window**. #255, #256, and #259 remain open.

## Catalog promotion

| Catalog entry               | Capability | From        | To         | Reports                      |
| --------------------------- | ---------- | ----------- | ---------- | ---------------------------- |
| `klipper-generic-moonraker` | telemetry  | `simulated` | `hardware` | SV06 and U1                  |
| `klipper-generic-moonraker` | camera     | `simulated` | `hardware` | U1 JPEG snapshot, 2026-11-23 |
| `anycubic-kobra-x`          | telemetry  | `simulated` | `hardware` | Native Kobra X               |

Left as they were, on purpose:

- **Klipper files** stay `unknown`. The CLI listed files. The product catalog requires a Moonraker file target, which `createFileTargets` does not build.
- **Klipper materials, pause, resume and cancel** stay `simulated`. The spool reads cover active assignment only. Signed pause remains pending the owner window.
- **Kobra X files, pause, resume and cancel** stay `simulated`. The native read-only run observed no file listing and cannot prove the commands.
- **Kobra X camera** stays `unknown`. The 2026-11-21 native run verified URL reachability. Product media validation remains pending.
- **Kobra X materials** stays `unknown`. ACE slots appear inside the telemetry, but the product has no signed material-command path.
- **Bambu and Creality**: no such printer was on the LAN.
