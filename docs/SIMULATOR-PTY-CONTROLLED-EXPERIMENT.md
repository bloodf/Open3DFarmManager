# Controlled PTY startup experiment

This 2026-11-04 experiment follows the [startup measurements](SIMULATOR-STARTUP-MEASUREMENTS.md). It tested the verified native ARM64 image with the project's SV06/U1 fixtures, using fresh volumes for every case. Each container retained one CPU, 1 GiB, 256 PIDs, noexec temporary mounts, no external network and no published ports. Every case retained the 90-second readiness budget. No physical commands were sent.

## Intervention

Only the guarded cases changed Klippy's launch command in a temporary Supervisor configuration extracted from the pinned image. An original shell wrapper waited until `/tmp/pseudoserial` resolved to an existing target, then executed the original Klippy command. It added no fixed sleep after availability, firmware patch, privilege, retry of a printer command or extended acceptance deadline. The configuration was mounted read-only and removed after the experiment; no upstream implementation was added to this MIT repository.

The emulator startup remained unchanged. PTY existence is not a firmware-identification handshake. The test therefore asks whether deferring host launch helps this observed startup pattern; it does not define production readiness.

## Repeated results

Cases ran in the order below. Success required both connected and ready; pair cases required both printers. Three consecutive samples checked short-term stability. Times are first observed readiness after case creation, with sampling/command latency, not exact event timestamps.

| Case                      | Intervention | First readiness     | Result                          | Final identification timeouts |
| ------------------------- | ------------ | ------------------- | ------------------------------- | ----------------------------- |
| SV06 isolated 1           | None         | Not reached         | Failed                          | 9                             |
| Concurrent pair control 1 | None         | 41.6 s              | Passed                          | 4 per printer                 |
| Concurrent pair guard 1   | Wait for PTY | 32.0 s              | Passed                          | 0 per printer                 |
| Concurrent pair control 2 | None         | Not jointly reached | Failed; SV06 shutdown, U1 ready | 5 per printer                 |
| Concurrent pair guard 2   | Wait for PTY | 29.1 s              | Passed                          | 0 per printer                 |
| SV06 isolated 2           | None         | 20.6 s              | Passed                          | 0                             |

In guard 1 the PTY was first observed at 15.8 s and serial connection at 24.4/28.4 s. In guard 2 those observations were 13.3 s and 22.0 s. The intervention enforced the intended ordering in both repetitions and both pairs identified their MCUs without logged timeouts.

## Causal conclusion and limitations

Concurrency is not necessary for failure: an isolated SV06 failed. Concurrent startup is not sufficient for failure: an unmodified pair passed. The unchanged configuration is intermittent. The guard removed early host connection in the tested repetitions and both guarded pairs passed, supporting it as a candidate mitigation.

Two guarded repetitions do **not** establish a reliable universal fix or prove that PTY ordering is the only root cause. Case order was not randomized, host caches and scheduling could vary, and the host was not exclusively reserved; unrelated Docker activity occurred during the experiment. This is a controlled configuration intervention with repeated observations, not proof that every other timing variable was controlled. A cold-start repetition series and the native amd64 environment remain unvalidated. Full four-tool/webcam/Spoolman acceptance was not executed in this experiment.

The guard remains test-only. Compose, image selection, CI workflows and production requirements are unchanged. Next validation should repeat guarded/control starts across architectures and verify the complete simulator acceptance, without broadening privileges or firmware timing tolerances.

## Isolation and cleanup

Project label: `o3dfm-pty-controlled-20261104`. Ten simulator containers and volumes plus one temporary read-only configuration-inspection container were created. All owned containers and volumes were removed; no dedicated networks were created. The pulled image reference was verified absent. The temporary Supervisor file/directory was removed. Exact resource IDs, samples, logs, configuration hashes and the original diagnostic script remain in local evidence.

Every baseline resource remained. Two unrelated containers, two images and one network appeared concurrently and were left untouched. Label queries found zero owned containers, volumes or networks. No broad prune was used.
