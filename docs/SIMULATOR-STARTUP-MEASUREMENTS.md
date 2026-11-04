# Simulator startup measurements

A bounded native ARM64 experiment on 2026-11-04 compared an upstream-default instance, the project SV06/U1 pair, then another upstream-default instance. It used the [verified ARM64 image](SIMULATOR-IMAGE-PROVENANCE.md), one CPU and 1 GiB per container, 256 PIDs, noexec temporary mounts, fresh volumes, no external networking and no published ports. No privileges, firmware timing or readiness requirements changed. Local application checks finished before the first container started.

The probe sampled process presence, pseudo-terminal availability, Klippy log milestones, CPU throttling and read-only Moonraker status approximately every two seconds. Times below are **first observed** elapsed seconds after the case's containers were created, not exact event timestamps. Pair samples are sequential and have limited resolution.

| Case           | Pseudo-terminal observed | Serial connect logged | MCU identified | First connected/ready | Outcome                         |
| -------------- | ------------------------ | --------------------- | -------------- | --------------------- | ------------------------------- |
| Default before | 15.8 s                   | 19.2 s                | 28.0 s         | 28.0 s                | Three consecutive ready samples |
| Pair: SV06     | 13.7 s                   | 7.3 s                 | Not observed   | Not observed          | Shutdown observed at 23.6 s     |
| Pair: U1       | 13.7 s                   | 7.3 s                 | Not observed   | Not observed          | Shutdown observed at 41.4 s     |
| Default after  | 16.4 s                   | 19.7 s                | 49.6 s         | 52.5 s                | Three consecutive ready samples |

Each case retained the 90-second readiness budget. The pair's final sample was at 88.6 seconds, with 14 identification timeouts per instance and no joint readiness. The successful controls also experienced timeouts (one and five respectively), so an initial timeout alone does not predict failure. Compiler, emulator and Klippy process presence were recorded; both emulators and pseudo-terminals existed in the failing pair.

## Interpretation and limits

In both successful controls the pseudo-terminal was observed before serial connection began. In the failed pair the connection log preceded pseudo-terminal availability. This is a measured startup-order correlation, **not a confirmed root cause**. The experiment also changes configuration and concurrency; it cannot distinguish those effects or eliminate scheduler/resource timing. It does establish that absent emulator startup is not a sufficient explanation and that the same native image can pass controls around a failed pair.

A next controlled intervention should change only host startup ordering, keeping emulator code, fixtures, limits and readiness deadline fixed, and repeat both control and intervention. A wait for pseudo-terminal presence alone would not prove that firmware identification is usable. No startup-order fix has yet been implemented, and neither production deployment nor E0 completion is justified.

## Evidence and cleanup

Local evidence retains the exact script, all samples, logs and owned resource IDs under project label `o3dfm-startup-20261104`. Four containers and four fresh volumes across the three cases were removed, as was the newly pulled image reference. Label checks found no owned containers, volumes or networks remaining. Baseline resources were preserved. One additional image appeared concurrently and was not treated as task-owned or removed. No broad prune was used.

Separately, the simulator response reader now rejects malformed UTF-8 before JSON parsing. Three previously accepted malformed byte sequences are regression-tested, as is valid multibyte text split across chunks. Full local verification passed: lint, typecheck, 158 Bun tests, 84 Node tests and builds. This response-decoding fix does not resolve MCU identification; CI workflows and simulator configuration remain unchanged.
