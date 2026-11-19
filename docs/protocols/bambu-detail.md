# Bambu detail page: sources and unsupported areas (E22.1)

Status: simulator only. Nothing below was run on a physical printer. Every statement is either a documented vendor fact (cited), a bound set by the OpenFarm control rules (E18.1), or a behaviour exercised against the in-process Bambu simulator of the E16 harness.

## Vendor source

- Bambu Lab, "Third-party integration" wiki page: <https://wiki.bambulab.com/en/software/third-party-integration>. It documents the LAN-mode MQTT report and request topics (`device/<serial>/report` and `device/<serial>/request`, TLS port 8883, user `bblp` with the access code) and FTPS on port 990 with the same credentials for the SD card.
- Bambu Lab announcement of the authorization control system, which restricts third-party commands on newer firmware: <https://blog.bambulab.com/firmware-update-introducing-new-authorization-control-system-2/>.

The `gcode_line` request, `ledctrl`, `print_speed` and the report field names (`nozzle_temper`, `bed_temper`, `chamber_temper`, `cooling_fan_speed`, `big_fan1_speed`, `big_fan2_speed`, `lights_report`, `layer_num`, `total_layer_num`, `spd_lvl`, `ams`) are the names the connector already decodes (`packages/connector/src/bambu/report.ts`, `commands.ts`). Speed levels map to the vendor percentages 50, 100, 124 and 166.

## Supported panels

| Area         | Source in the connector                                         | Notes                                                                      |
| ------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| temperatures | report `nozzle_temper`, `bed_temper`, `chamber_temper`          | Heater power is not reported; the stream sends 0.                          |
| fans         | report fan speeds, scale 0-15 to percent                        | `part`, `aux`, `chamber`.                                                  |
| leds         | report `lights_report`, `ledctrl` request                       | Chamber light only.                                                        |
| motion       | `gcode_line`: `G28` and relative `G1` under E18.1 bounds        | Toolhead position is not reported, so the panel shows it as unavailable.   |
| extrusion    | `gcode_line`: `M83`, `G1 E`, `M82` under E18.1 bounds           | Refused when the nozzle is below 170 °C, above 300 °C or unknown.          |
| console      | `gcode_line` with one printable ASCII line, 256 bytes           | Idle or finished: any line. Printing or paused: tuning allow-list only.    |
| printStatus  | report `gcode_state`, `layer_num`, `total_layer_num`, AMS trays | The report carries remaining time, not elapsed time; elapsed is sent as 0. |
| fileManager  | FTPS on the SD card: `MLSD`, `RETR`, `DELE`                     | Plain names, `.3mf` and `.gcode`, root folder only.                        |
| timelapse    | FTPS `MLSD /timelapse`, `RETR`, `DELE`                          | `.mp4`, `.avi` and `.jpg` in the timelapse folder.                         |
| webcams      | existing camera transport                                       | Only for the models the camera selector accepts.                           |

## Unsupported areas

The LAN protocol above documents no command or report for these. They stay `unsupported` in the catalog and are not advertised by the detail stream.

| Area          | Reason                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| config        | No configuration file access; the printer exposes no config files.     |
| bedMesh       | No mesh report.                                                        |
| services      | No service or restart request.                                         |
| power         | No power device.                                                       |
| jobQueue      | No queue; a print starts from one `project_file` request.              |
| updates       | Only firmware versions are reported (`get_version`); no update status. |
| macros        | The printer has no macro concept.                                      |
| excludeObject | No exclude-object request.                                             |
| history       | The printer keeps no job history reachable over the LAN protocol.      |

## Safety

Commands are never sent from this module. Jog, extrude and the console only build `gcode_line` payloads; the signed control path delivers them, the Connector refuses unsafe ones with a reason, and an uncertain command is never retried.
