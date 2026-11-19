# Creality detail page: sources and unsupported areas (E22.2)

Status: simulator only. Nothing below was run on a physical printer. Every statement is a documented source fact (cited), a bound set by the OpenFarm control rules (E18.1), or a behaviour exercised against the in-process Creality simulator of the E16 harness (`tests/unit/creality-detail.test.ts`).

## Sources

The wire names are the ones already pinned in [creality-commands.md](./creality-commands.md): the stock LAN WebSocket on port 9999, the `{"method":"set","params":{...}}` envelope and the status frame fields decoded in `packages/connector/src/creality/index.ts`.

- OrcaSlicer `CrealityPrint.cpp` (native LAN transport and command serialization): <https://github.com/OrcaSlicer/OrcaSlicer/blob/07f38df2a4fd3439cffbf991ee41ee99ec71fbee/src/slic3r/Utils/CrealityPrint.cpp>
- ChestnutLabs `printer-protocol-orchard`, `protocols/creality.md` L153-176 (`pause`, `stop`, `nozzleTempControl`, `bedTempControl`, `fan`, `fanAuxiliary`, `fanCase`, `lightSw`, `autohome`, `gcodeCmd`): <https://github.com/ChestnutLabs/printer-protocol-orchard/blob/fd5026ef9ec8b6b0f7b22884a2f2389e614c8fdf/protocols/creality.md#L153-L176>
- Status frame fields (`modelFanPct`, `auxiliaryFanPct`, `caseFanPct`, `lightSw`, `printFileName`, `printJobTime`, `layer`, `TotalLayer`): <https://github.com/DaviBe92/k2-websocket-re>
- `gcodeCmd`: Erinell `src/Requests.ts` L40-41, AccessSlice `app/creality_lan.py` L701, orchard L174 (links in creality-commands.md).

## Supported panels

| Area         | Source in the connector                                                                 | Notes                                                                                            |
| ------------ | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| temperatures | status `nozzleTemp`, `nozzleTemp2`, `bedTemp`, `bedTemp2`                               | Set with `nozzleTempControl` (0-300) and `bedTempControl` (0-120). Heater power is not reported. |
| fans         | status `modelFanPct`, `auxiliaryFanPct`, `caseFanPct`                                   | `part`, `aux`, `chamber`. The set commands are on/off only.                                      |
| leds         | status `lightSw`, `lightSw` set                                                         | One chamber light, on/off.                                                                       |
| motion       | `autohome` set                                                                          | Home only. The toolhead position is not reported, so no position panel and no jog.               |
| printStatus  | status `state`, `printFileName`, `printProgress`, `printJobTime`, `layer`, `TotalLayer` | Elapsed time is reported; remaining time is not shown.                                           |
| webcams      | local MJPEG camera already configured for the agent                                     | Video uses the existing WebRTC media session. Shown only when a camera is configured.            |
| console      | `gcodeCmd` under the E18.1 rules                                                        | Off by default. See Safety.                                                                      |

`pause`, `resume`, `cancel` and `start_print` keep their existing rows in creality-commands.md.

## Unsupported areas

These stay `unsupported` in the catalog and are not advertised by the detail stream.

| Area          | Reason                                                                                                                                                                                                                                                                                                  |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| fileManager   | The listing request `reqGcodeFile` and its reply name `retGcodeFileInfo2` are documented, but the sources pinned here do not record the reply layout, so it is not decoded. No source documents a delete verb: Erinell's `deleteGcodeFile` sends `{"stop":1}`, which is a cancel, so delete is refused. |
| extrusion     | No extrusion command. The CFS `feedInOrOut` frame is filament loading for a CFS box and is unvalidated, so it is not an extrude control.                                                                                                                                                                |
| macros        | No named-macro verb in any source.                                                                                                                                                                                                                                                                      |
| excludeObject | No exclude-object request.                                                                                                                                                                                                                                                                              |
| jobQueue      | No queue; a print starts from one `opGcodeFile` request.                                                                                                                                                                                                                                                |
| bedMesh       | No mesh report.                                                                                                                                                                                                                                                                                         |
| config        | No configuration file access on the stock LAN protocol.                                                                                                                                                                                                                                                 |
| services      | No service or restart request (see `firmware_restart` in creality-commands.md).                                                                                                                                                                                                                         |
| history       | No job history reachable over the LAN protocol.                                                                                                                                                                                                                                                         |
| timelapse     | No timelapse request or listing.                                                                                                                                                                                                                                                                        |
| power         | No power device.                                                                                                                                                                                                                                                                                        |
| updates       | Only the firmware version is reported; no update status.                                                                                                                                                                                                                                                |

## Klipper-rooted K-series

Printers configured with a Moonraker origin keep the Moonraker detail stream and its panels. The Creality stream is used only for stock-firmware assignments without one.

## Safety

Commands are never sent from the detail module. It only builds frames, and the signed control path delivers them. The console builder (`buildCrealityConsoleLine`) is the highest-risk write: it refuses unless enabled, accepts only one printable ASCII line of at most 256 bytes, accepts any such line when idle, only a tuning allow-list (`M105`, `M114`, `M115`, `M220 S10-500`, `M221 S5-150`) while printing or paused, and refuses in any other state. An uncertain command is never retried and nothing is routed over HTTP or TURN.
