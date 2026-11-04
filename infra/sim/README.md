# Isolated development simulators

The Compose project owns its network and three independent data volumes. Published ports bind to loopback only. It mounts no hardware devices, host sockets or production files. Image digests pin the reviewed amd64 builds; ARM hosts require emulation.

Execution of containers is an explicit approval gate. The commands below are prepared for use after that approval; configuration validation itself does not start services.

```sh
docker compose -f infra/sim/docker-compose.yml --profile klipper --profile spoolman --profile cams config --quiet
```

After approval, on a machine with a running Docker daemon:

```sh
docker compose -f infra/sim/docker-compose.yml --profile klipper --profile spoolman --profile cams up -d --build
bun run sim:verify
docker compose -f infra/sim/docker-compose.yml --profile klipper --profile spoolman --profile cams down
```

| Service                  | Loopback port | Purpose                                       |
| ------------------------ | ------------- | --------------------------------------------- |
| sv06                     | 7125          | Single-tool Klipper/Moonraker                 |
| u1                       | 7126          | Synthetic four-tool Klipper/Moonraker         |
| Spoolman                 | 7912          | 2 vendors, 4 filaments, 6 spools              |
| Built-in webcam patterns | 8110, 8111    | Moonraker webcam entries                      |
| JPEG/MJPEG test source   | 8112          | Original synthetic fixture, two frames/second |

`sim:verify` requires both Klippy instances connected and ready, all four extruder objects and T0–T3 macros, webcam entries, a valid bounded JPEG and repeatable Spoolman seeding. It does not send printer commands. `sim:seed` can be run separately; it creates missing marked fixtures and never updates or deletes unrelated rows. Run one seeder at a time. Do not point these scripts at a real farm; the scripts enforce loopback HTTP origins and reject redirects.

The U1 fixture exercises generic four-tool API behavior only. It shares emulator pins and must never be installed on a physical printer. Actual firmware object names and independent heater behavior remain hardware acceptance items. Each simulator has its own volume. Upstream startup populates configuration inside that volume on first boot; changes to the mounted defaults require a fresh test volume. Preserve any volume you want to retain.

The Klipper simulator is an external GPL-3.0 service. Its defaults remain in its image and data volumes; this MIT repository contains only our added configuration and clients. See [upstream](https://github.com/mainsail-crew/virtual-klipper-printer). Spoolman is an external MIT service. It runs directly as UID/GID 1000 with all capabilities dropped; its root-to-user entrypoint cannot switch identity under that capability policy.

The [container validation checkpoint](../../docs/CONTAINER-VALIDATION-CHECKPOINT.md) records actual image, camera and Spoolman results and the failed Klipper readiness gate. Remaining E0 gates: successful Klipper container acceptance, RTSP/MediaMTX test stream, NAT/loss/latency/UDP fault rig and CI execution. Passing unit tests or Compose parsing does not complete those gates.
