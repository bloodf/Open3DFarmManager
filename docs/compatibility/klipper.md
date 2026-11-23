# Klipper/Moonraker compatibility family

Catalog entries for the Klipper/Moonraker family. Source of truth:
`apps/farm/app/utils/compatibility/klipper.ts`. Shown on `/compatibilidade`.
Labels never grant authority; they do not enable commands.

| Entry                                 | Telemetry | Files   | Camera    | Materials | Pause/Resume/Cancel |
| ------------------------------------- | --------- | ------- | --------- | --------- | ------------------- |
| Generic Klipper + Moonraker           | hardware  | unknown | hardware  | unknown   | simulated           |
| Snapmaker U1 (paxx12 profile)         | simulated | unknown | simulated | simulated | simulated           |
| Creality K1 series (rooted Moonraker) | simulated | unknown | simulated | unknown   | simulated           |
| Voron 2.4 (self-built kit)            | simulated | unknown | simulated | unknown   | simulated           |
| Sovol SV08                            | simulated | unknown | simulated | unknown   | simulated           |

`simulated` means exercised against the loopback Klipper/Moonraker simulators in
`infra/sim` and the unit tests. The generic entry's `hardware` grades come
from read-only reports documenting telemetry on a Sovol SV06 and a Snapmaker
U1, plus one JPEG snapshot validated by the Connector on the U1. The snapshot
uses a separately configured camera source. [Hardware reports](../hardware-reports/README.md).

## Snapmaker U1 signed control

The Connector's local printer configuration declares the U1 model. The
existing signed Moonraker path supports pause, resume, cancel, home, jog,
setting each nozzle and bed target (including zero), the owner-authorized
G-code console, and starting a file already uploaded to the printer.

For positive heater targets, the Connector uses the lower of the live heater
`max_temp` and the U1 ceiling of 300 °C per nozzle or 100 °C for the bed. A zero
target turns off a known heater. Jogs require homed axes and stay within the
live position and velocity limits, including `max_z_velocity` when configured.
The U1 homes X and Y together. The Connector rejects a request to home X or Y
alone. A request to home only Z requires X and Y to be homed already.

Tool selection accepts a bare `T0`, `T1`, `T2`, or `T3` through the signed
console when the printer is idle and all axes are homed. The Connector appends
the vendor flag `A0` so the number selects the physical tool, then verifies the
active tool. The console retains its existing command safety policy.

The U1 lifecycle browser journey and Connector fixture tests exercise these
controls. Their grades remain `simulated` until the individual controls are
observed on hardware. The read-only U1 telemetry and JPEG snapshot evidence
belong to the generic Klipper + Moonraker entry. Starting an existing file is
covered as a print control. U1 file management remains `unknown`.

## Active nozzle on multi-extruder printers

Active-nozzle temperature coverage is `simulated` and remains unqualified on
hardware. When Moonraker discovery lists both `toolhead` and an
`extruderN` object other than `extruder`, the Connector queries the
discovered nozzle temperatures with `toolhead.extruder` and the farm shows
the active extruder's temperature as the nozzle value. This applies to any
Klipper printer meeting those discovery conditions; it is not limited to a
printer model.

If `toolhead.extruder` does not name a discovered Klipper `extruderN`
object, the active nozzle value is unavailable (`Indisponivel`); the
Connector does not substitute the default `extruder` reading. The simulator
journey exercises tool changes with the Snapmaker U1 setup, but hardware
qualification is not a gate for this generic behavior.
[Moonraker object queries](https://moonraker.readthedocs.io/en/latest/external_api/printer/#query-printer-object-status).

## Sources

- Klipper: https://www.klipper3d.org/
- Moonraker docs: https://moonraker.readthedocs.io/en/latest/
  (printer API: `/external_api/printer/`, webcams: `/external_api/webcams/`)
- Creality K1 series Klipper source: https://github.com/CrealityOfficial/K1_Series_Klipper
- Community root/helper-script wiki (Moonraker on K1): https://github.com/Guilouz/Creality-Helper-Script-Wiki
- Voron 2.4: https://vorondesign.com/voron2.4 and https://github.com/VoronDesign/Voron-2
- Sovol SV08: https://www.sovol3d.com/products/sovol-sv08-3d-printer and https://github.com/Sovol3d/SV08

Release dates are `null` where no dated public source was checked.
Rooting a K1 may affect warranty and stability; this project does not automate it.

Voron Trident is also listed with simulated control and unknown files and
materials. Its Klipper configuration depends on the builder; see the
[Voron Trident repository](https://github.com/VoronDesign/Voron-Trident).
Firmware notes in the catalog link to their respective upstream sources.
