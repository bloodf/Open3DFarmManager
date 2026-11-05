# Simulator image provenance and architecture

Read-only upstream review on 2026-11-04 followed the [readiness diagnosis](SIMULATOR-READINESS-DIAGNOSIS.md). Registry manifests and configuration blobs were fetched from GHCR with anonymous pull access and checked against their SHA-256 digests. Source labels identify provenance but are not a signed build attestation.

| Artifact                                   | SHA-256 digest                                                     |
| ------------------------------------------ | ------------------------------------------------------------------ |
| Version `v0.13.0-816` multi-platform index | `759f09e063d906832198b7090b7ecce1099a8a1d9ef065bab59a48a4208459cf` |
| Existing linux/amd64 manifest              | `c2ab1d20a3f6d9dda182bf69a078c5f37a066a44f1f34ffea48d49ddf7bbce47` |
| Existing amd64 configuration blob          | `383eded3daea2a61619d1af946ea0c6caa1cde93186e14962bd5c4b0f954cd93` |
| Same-version linux/arm64 manifest          | `4fa52c3d57722ef38cfd05a31fd0237347e0e6285fc1371b133a6789798602b7` |

Both variants declare upstream revision `e272bcd1060dad6cee1598d6debdaa5d5afae3c7`, version `v0.13.0-816`, GPL-3.0, user `printer` and an October 26 build. That revision was identical to upstream `master` at review time. The local Compose explicitly selects the amd64 manifest and platform, so an ARM host necessarily uses emulation even though an ARM64 sibling exists. Architecture compatibility alone does not establish readiness or four-tool acceptance.

## Startup and reproducibility

The [pinned entrypoint](https://github.com/mainsail-crew/virtual-klipper-printer/blob/e272bcd1060dad6cee1598d6debdaa5d5afae3c7/scripts/start.sh) initializes directories, copies example configuration only into an empty configuration directory, links the timelapse component and starts Supervisor. Fresh volumes are essential when testing changed defaults. Its ownership and service operations occur inside the isolated container; no host directories or Docker socket are mounted.

The [pinned Supervisor configuration](https://github.com/mainsail-crew/virtual-klipper-printer/blob/e272bcd1060dad6cee1598d6debdaa5d5afae3c7/config/supervisord.conf) starts Klipper and Moonraker while delaying the AVR emulator ten seconds. The emulator uses ATmega644p, 20 MHz and 250000 baud, consistent with the [upstream firmware configuration](https://github.com/mainsail-crew/virtual-klipper-printer/blob/e272bcd1060dad6cee1598d6debdaa5d5afae3c7/config/simulavr.config).

The [build definition](https://github.com/mainsail-crew/virtual-klipper-printer/blob/e272bcd1060dad6cee1598d6debdaa5d5afae3c7/Dockerfile) clones moving upstream dependencies. Therefore rebuilding that Dockerfile later is not a reproducible replacement for the pinned image. The runtime `.config` file is also not authoritative evidence of how the retained firmware was compiled: the build copies firmware artifacts aside, removes `.config`, cleans and later restores the artifacts. Do not infer a firmware mismatch solely from that regenerated file.

## Known upstream issue and rejected shortcut

[Issue 43](https://github.com/mainsail-crew/virtual-klipper-printer/issues/43) discusses timing failures and mixed results from restarts. Its later comments point to PRs [70](https://github.com/mainsail-crew/virtual-klipper-printer/pull/70), [71](https://github.com/mainsail-crew/virtual-klipper-printer/pull/71), [72](https://github.com/mainsail-crew/virtual-klipper-printer/pull/72) and [73](https://github.com/mainsail-crew/virtual-klipper-printer/pull/73). The first three were merged into `feat/python-mcu-server`, not `master`; they address a Linux MCU and hardware bridge, not this AVR-emulation image. PR 73 remained open and increases timing tolerances. It was not applied. These reports do not establish the cause of our initial MCU identification timeout.

No experimental code, extra scheduling capability, unlimited memory locking or changed host security was adopted. The readiness condition and CI workflows remain unchanged. Upstream implementation remains external and separately licensed.

## Native ARM64 measurement

The same-version ARM64 image reached connected/ready at 24.3 seconds on the local ARM host, using stock defaults, one CPU, 1 GiB, no external networking and the unchanged 90-second limit. The running Klipper commit was `ee2c6fb6b00b2b5d097ef70d0868df7d74943b51`, matching the previous logs' short revision. This proves that the tested ARM64 configuration can become ready; it does not establish why identification failed on native x86_64 or prove that every emulated run fails.

The test container and its volume were removed, and the image reference was verified absent afterward. All baseline resources were preserved. Inventory counts also detected one additional container, image and network created concurrently; those were not attributed to this diagnostic and were left untouched. Cleanup must follow recorded ownership, not a global difference or prune.

## Project-fixture follow-up

A second fresh ARM64 run started both project fixtures with the same one-CPU/1-GiB limits and loopback-only ports. At the final 89.1-second sample, SV06 was disconnected and U1 remained in startup. Logs again recorded MCU identification timeouts and shutdown. Both printers never jointly satisfied readiness, so the subsequent four-tool/webcam/stability assertions were not executed. No success is claimed for those assertions.

The architecture change is therefore **not adopted**: a single stock success did not reproduce with the required pair. The Compose digest and platform remain unchanged. The initial timeout's cause is still unresolved; current evidence supports an upstream-image/runtime startup blocker, not a specific proven root cause or an application fix.

The second run removed both labeled containers, both named volumes, the dedicated network and the newly pulled image. A post-cleanup label query confirmed no project resources remained. Every baseline resource was preserved; two unrelated containers appeared concurrently and were left untouched. Original failure evidence, both ARM64 reports and the exact diagnostic scripts remain local. No broad prune or host security change was used.

A focused next experiment can measure emulator availability versus host identification startup, based on the upstream startup discussion and observed callback timeout. It must preserve the 90-second readiness gate, use synthetic instances only and avoid modifying firmware timing tolerances. No such startup-order fix has been implemented or validated by this checkpoint.
