# Flashforge LAN protocol

All entries are unqualified pending owner hardware checks. Firmware versions below are the adapter allowlist, based on published firmware analysis. Tests use original synthetic fixtures on temporary loopback endpoints.

| Model / PID                | Stock firmware      | Implemented capability                                                                                                                                                                             |
| -------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Adventurer 5M / 0x0023     | 3.2.7, 5.1.8        | Authenticated status and file listing, upload-only G-code, start, pause, resume, cancel, nozzle/bed setpoints, part-cooling fan. Optional camera URL when reported.                                |
| Adventurer 5M Pro / 0x0024 | 3.2.7, 5.1.8        | Same operations plus filtration fan state and factory camera URL when reported.                                                                                                                    |
| AD5X / 0x0026              | 1.1.7, 1.2.1, 3.1.0 | Read-only status, file names, reported IFS slot presence/material/color, optional camera URL when reported. Writes need a separate qualification pass, including multi-tool file and slot mapping. |

Discovery probes a provisioned IPv4 address over UDP 48899 and validates the modern binary identity, vendor ID, LAN-only flag and HTTP service port. The documented broadcast format works in the simulator with a targeted probe. Unicast acceptance on each physical firmware is pending. Treat discovery as an unauthenticated hint. Verify identity with authenticated `POST /detail` on HTTP 8898. Requests carry the serial number and printer check code. LAN HTTP is plaintext. Keep credentials in Connector-local secret storage. Device-supplied hosts are ignored for API calls.

Status includes reported job state, filename, progress ratio, current and target temperatures, part-cooling fan percentage, material label and current alert code. The reported weight is a job estimate in grams, with no measured spool deduction or per-run attribution. File lists describe available/recent files and cannot establish completed runs. Historical jobs, measured consumption, alert history, slot commands and filtration fan control are outside the implemented surface.

The adapter validates the advertised MJPEG source against the provisioned host and the documented HTTP 8080 stream path. The adapter opens an existing stream and returns its multipart body to the Connector with caller-controlled cancellation. Stream activation, JPEG decoding and browser-to-Connector WebRTC delivery remain pending.

Uploads use multipart `gcodeFile` with credentials and size in headers and `printNow: false`. Uploads and explicit starts accept restricted basename-only `.gcode` names. The adapter caps upload size at 32 MiB. Starts request leveling and require a fresh ready observation and authorization. The caller must enforce scope, printer and job binding, envelope signature, exclusion across callers, command journaling, file compatibility, material temperature limits and bed-clear verification. Nozzle setpoints must be whole numbers from 0 to 265 °C, inclusive. The adapter rejects out-of-range setpoints before sending a control command. A successful vendor reply yields `{ acknowledged: true }` as an acknowledgment of dispatch. Verify the resulting printer state through telemetry before reporting completion. Timeouts, disconnects and malformed results leave the outcome uncertain. The transport sends one request and never retries. It has no cloud or raw TCP fallback.

Older 5M firmware, other AD5X firmware, Creator, Guider, Finder, Adventurer 3/4 and modified firmware remain outside this adapter allowlist.

## Integration follow-up

- Add a binding discriminator and local credentials in `packages/farm-protocol/src`, `packages/connector/src/config` and `packages/connector/src/control/printer-binding.ts`.
- Wire discovery in `packages/connector/src/runtime/configuration-discovery.ts` and status in `packages/connector/src/runtime/collect.ts`. Integrate controls through `pause-driver-router.ts` and `api-command.ts`, and files through `file-targets.ts`, `file-upload.ts` and `library-print-start.ts` in the same directory. Use the existing Connector authorization, interlocks and command confirmation path.
- Register camera sources in `packages/connector/src/camera/source-policy.ts` and attach them through the existing WebRTC media path. Verify MJPEG and stream activation on hardware before enabling.
- Add sourced model profiles in `packages/farm-protocol/src/machine-profile.ts` and capability evidence in `docs/compatibility/`. Keep firmware and capability qualification explicit in `apps/farm/app/pages/compatibilidade.vue`. Add pt-BR LAN setup fields under `apps/farm/app/components/printer-setup/` and expose only enabled controls.

## Sources

- [Flashforge 5M series specifications](https://en.fss.flashforge.com/10000/software/2a9ce576d4dc68efa85e202d82bff905.pdf) gives the hardware temperature ceilings.
- Firmware analysis and protocol observations cover [5M series](https://github.com/Parallel-7/flashforge-api-docs/wiki/Adventurer-5M-Series), [AD5X](https://github.com/Parallel-7/flashforge-api-docs/wiki/AD5X), [PID assignments](https://github.com/Parallel-7/flashforge-api-docs/wiki/Printer-PIDs), [discovery](https://github.com/Parallel-7/flashforge-api-docs/wiki/Discovery-Protocol), [authentication](https://github.com/Parallel-7/flashforge-api-docs/wiki/Authentication) and [HTTP messages](https://github.com/Parallel-7/flashforge-api-docs/wiki/HTTP-REST-API).

Protocol references informed the wire fields and firmware allowlist. No third-party code, firmware, or fixture captures are included.
