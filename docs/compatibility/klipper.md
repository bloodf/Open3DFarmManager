# Klipper/Moonraker compatibility family

Catalog entries for the Klipper/Moonraker family. Source of truth:
`apps/farm/app/utils/compatibility/klipper.ts`. Shown on `/compatibilidade`.
Labels never grant authority; they do not enable commands.

| Entry                                 | Telemetry | Files   | Camera    | Materials | Pause/Resume/Cancel |
| ------------------------------------- | --------- | ------- | --------- | --------- | ------------------- |
| Generic Klipper + Moonraker           | hardware  | unknown | simulated | unknown   | simulated           |
| Creality K1 series (rooted Moonraker) | simulated | unknown | simulated | unknown   | simulated           |
| Voron 2.4 (self-built kit)            | simulated | unknown | simulated | unknown   | simulated           |
| Sovol SV08                            | simulated | unknown | simulated | unknown   | simulated           |

`simulated` means exercised against the loopback Klipper/Moonraker simulators in
`infra/sim` and the unit tests, never against physical hardware. Camera follows
the existing read-only Moonraker webcam listing and the simulated camera
servers. Files and materials stay `unknown`: main does not prove them.
Nothing is `documented`. `hardware` means a recorded read-only qualification
report in [docs/hardware-reports](../hardware-reports/README.md) proves it: so
far only telemetry on the generic entry, from a Sovol SV06 and a Snapmaker U1.

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
