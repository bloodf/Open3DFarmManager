# Elegoo: SDCP control and upload evidence

All evidence here is documentary and simulator-based. No physical printer was
contacted. **No model or firmware is qualified; catalog rows stay unqualified.**

## Sources

| Key  | Repository @ commit                                                                                                                                                      | Path used                                                                                             |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| SPEC | [cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0](https://github.com/cbd-tech/SDCP-Smart-Device-Control-Protocol-V3.0.0) @ `f977215761ee2e8c6d02ab06a68dc4d2b710a255` | `SDCP(Smart Device Control Protocol)_V3.0.0_EN.md`                                                    |
| S16K | [alfiedennen/sdcp-saturn-4-ultra](https://github.com/alfiedennen/sdcp-saturn-4-ultra) @ `d2535192c5808b38378398996c1f08440939faab` (MIT)                                 | `README.md`                                                                                           |
| LINK | [ELEGOO-3D/elegoo-link](https://github.com/ELEGOO-3D/elegoo-link) @ `ec2d2269b588608a1b9ccb4ff9627ddb758ea482` (Apache-2.0)                                              | `src/lan/adapters/elegoo_fdm_cc/elegoo_fdm_cc_message_adapter.cpp`, `elegoo_fdm_cc_http_transfer.cpp` |
| CENT | [bjan/pycentauri](https://github.com/bjan/pycentauri) @ `2f6d9ed53922ea1d733394706ce2bafd875ae5b4` (Apache-2.0)                                                          | `docs/PROTOCOL.md`, `src/pycentauri/upload.py`, `models.py`                                           |
| HA   | [danielcherubini/elegoo-homeassistant](https://github.com/danielcherubini/elegoo-homeassistant) @ `ce9c1559cb439e8d77ba860d42572d3c2b404a26` (MIT)                       | `README.md`, `custom_components/elegoo_printer/websocket/client.py`, `__init__.py`                    |

Only wire facts were used. No code was copied and no dependency was added.

## Operations

| Operation | Wire                                                                                                                        | Confirmed only by a later status report showing                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Start     | Cmd 128 `{Filename, StartLayer: 0}`; Carbon adds `Calibration_switch: 1, PrintPlatformType: 0, Tlp_Switch: 0, slot_map: []` | the requested file name, printing or paused                           |
| Pause     | Cmd 129 `{}`                                                                                                                | `PrintInfo.Status` 6 with machine status 1                            |
| Resume    | Cmd 131 `{}`                                                                                                                | a job phase with machine status 1                                     |
| Cancel    | Cmd 130 `{}`                                                                                                                | machine status 0 with `PrintInfo.Status` 8                            |
| Upload    | `POST /uploadFile/upload`, multipart, 1 MiB chunks, `S-File-MD5`, `Check`, `Offset`, `Uuid`, `TotalSize`, `File`            | each chunk answered `code: "000000"`; the upload never starts a print |

Commands go through the Connector's signed-command dispatcher: capability,
signature, role, replay journal and fresh printer state are checked before the
single send. Control is a local opt-in (`pause.control.assignmentIds`); without
it an SDCP assignment stays read-only. A non-zero `Ack`, a missing `Ack` or a
missing state change ends the attempt; nothing is retried. Identity (board ID
and model) is rediscovered before every command session and upload.

## Start qualification

Cmd 128 is neither offered nor sent unless the exact model and firmware pair is
in `SDCP_QUALIFIED_STARTS` (`packages/connector/src/sdcp/models.ts`). **The
list is empty, so no printer is offered a start** through the browser or the
API. Pause, resume, cancel and upload are unaffected. A supervised run on idle
hardware, recorded here, is required before a pair is added. Neither the wire
nor the local runtime file can add one.

With a listed model, the Connector reads the firmware when control starts and
offers start only on an exact match. If that read fails, start stays off until
control starts again. The driver checks the firmware again against the identity
it rediscovers for each command session.

Even on a qualified pair, a resin file (`.ctb`, `.goo`) is never started by
name: its name cannot show which resin model it was sliced for. The browser
path now applies the API path's rule
(`resin-artifact-requires-library-version`). The validated resin library
dispatch is a separate path. A qualified Connector capability must validate
the library artifact and upload it before asking the SDCP driver to start the
same file. The driver still requires a qualified model and firmware pair.

## Per model

In this table, "start" means documented on the wire and built by the Connector.
It is subject to the qualification and resin rules above.

| Catalog model                       | Control and upload                                              | Evidence                                                                                                                  | Limits and gaps                                                                                                                                                 |
| ----------------------------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Saturn 4 Ultra 16K                  | pause, resume, cancel, start, upload; `.ctb`, `.goo`; port 3030 | SPEC; S16K observed Cmd 128 to 131 and the upload endpoint on firmware V1.5.6                                             | S16K: start right after an upload can answer `Ack: 1` (busy). It is reported as failed, not retried. Nested discovery attributes seen in probes are not parsed. |
| Saturn 4 Ultra (12K)                | same                                                            | SPEC (board vendor, no model or firmware matrix); HA lists the range as supported over SDCP WebSocket                     | No model-specific command or upload capture. `.goo` acceptance is inferred from the 16K.                                                                        |
| Mars 5 Ultra                        | same                                                            | SPEC; HA lists the range as supported over SDCP WebSocket                                                                 | No model-specific command or upload capture. File types inferred from the family.                                                                               |
| Centauri Carbon (not a catalog row) | pause, resume, cancel, start, upload; `.gcode`; port 80         | LINK (Elegoo's SDK); CENT confirmed Cmd 128 to 131 on V0.3.0-o and V1.1.46 and documents the upload                       | See the crash warnings below. Not found by background discovery; must be configured by hand. Temperatures, fans, light and camera are not exposed.              |
| Saturn 3 Ultra                      | none                                                            | HA classifies it as legacy SDCP over MQTT (V1), not v3                                                                    | Unsupported.                                                                                                                                                    |
| Mars 4 Ultra                        | none                                                            | HA classifies it as legacy SDCP over MQTT (V1)                                                                            | Unsupported.                                                                                                                                                    |
| Jupiter 2                           | none                                                            | HA `README.md` "Not supported yet": the wire protocol is unknown and does not appear to be this one                       | Unsupported.                                                                                                                                                    |
| Saturn 2, Mars 3 Pro                | none                                                            | [Resin catalog](../catalog-resin.md): official USB-drive workflow (HA also lists some older units under MQTT, unverified) | Unsupported.                                                                                                                                                    |
| Centauri Carbon 2 / 2 Combo         | none                                                            | CENT "CC2 protocol notes": MQTT, no SDCP WebSocket                                                                        | Unsupported by exact model-name match.                                                                                                                          |

Neptune and OrangeStorm Giga models are Klipper machines, outside SDCP.

## Safety warnings from the sources

- CENT `docs/PROTOCOL.md`: on the Centauri Carbon an unknown command or an
  unexpected payload shape can crash the firmware process and kill the running
  print. The Connector builds only Cmd 0, 128, 129, 130 and 131 in the exact
  documented shapes.
- HA `README.md` and `__init__.py` state that Cmd 128 crashed the first-generation
  Centauri Carbon and resin printers (they cite their #297), and HA exposes no
  start service for them. This conflicts with CENT (start confirmed on the
  Carbon) and S16K (`Ack: 0` on V1.5.6). The payload HA used is not documented
  there. **Verify start on idle hardware under supervision before qualifying it.**
- SDCP is unauthenticated and unencrypted. Anyone on the LAN can command the
  printer without the Connector. Use only a trusted network.

## What is refused, and why

| Request                                                                | Refusal                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Temperature, fan, light, speed, homing, motion, G-code, emergency stop | Not advertised. No documented command in SPEC; Carbon Cmd 403 variants are out of scope.   |
| `start_library_print`                                                  | Not advertised: the library holds no CTB/GOO and SDCP telemetry reports no nozzle profile. |
| Plate or AMS mapping arguments                                         | Rejected before sending. Canvas mapping is not implemented.                                |
| File listing and deletion (Cmd 258, 259)                               | Not implemented.                                                                           |
| File name with a path, quote, or another model's extension             | Rejected before any request.                                                               |
| Start on a model and firmware pair that is not qualified               | Not advertised; refused as `unsupported-action` if sent anyway.                            |
| Start of a `.ctb` or `.goo` file by name, on the browser or API path   | Refused before sending. An API job is refused before its file is fetched.                  |
| Printer still busy when the idle wait before start ends                | Not sent, reason `state` (or `deadline` if the dispatcher's result window ends first).     |
| Print state in transition or unrecognised                              | Decoded as unknown: permits no command and confirms none.                                  |
| Changed board ID or model behind the address                           | No WebSocket command and no upload.                                                        |

The upload channel does not check the print state before storing a file. No
source documents the effect of an upload during a resin print.

## Simulator coverage

`packages/sim-tools/src/sdcp-simulator.ts` is spec-derived. With `simulate()` it
applies Cmd 128 to 131 to a printer model, answers the `Ack`, reports the
resulting status (resin and Carbon shapes), stores a chunked upload after
checking offsets and MD5, and can ignore or refuse a command or reject a chunk.
An unknown command or payload shape drops the connection. The shipped
qualification list is empty, so start tests pass their own list in code.

Every refusal before the write is typed (`DriverRefusalError`), so it is
recorded as not sent with a reason and does not block later commands. After the
write, a failure is still an unknown outcome.

- `tests/node/sdcp-control.test.ts`: pause, resume and cancel on all four
  controllable models and start on a test-qualified Carbon, asserted from
  reported state; the resin frame shape and refusal of a bare resin start;
  signed dispatch; refusals; no retry; runtime opt-in; Carbon status
  collection.
- `tests/node/rv-elegoo-safety.test.ts`: start refused on unqualified pairs
  through the browser and API paths; the resin file rule; invalid commands and
  idle-wait timeouts ending as not sent with a reason.
- `tests/node/sdcp-upload.test.ts`: chunking and stored content on all four
  models, start of the stored file on the Carbon (resin refuses a bare start),
  rejected chunk, revoked authority, changed identity, file-type limits.

Not covered: real firmware timing (heating, levelling and resin preheat),
transitional frames from hardware, upload speed, connection limits, the browser
journey for control, and the runtime file-transfer channel end to end.
